import { applyEdits } from "./apply";
import { hasBlockEdit, resolveBlockEdits } from "./block";
import { computeFileHash, formatHashlineHeader } from "./format";
import type { Filesystem, WriteResult } from "./fs";
import { parsePatch } from "./parser";
import { isNotFound } from "./fs";
import type { Patch, PatchSection } from "./input";
import { HEADTAIL_DRIFT_WARNING, missingSnapshotTagMessage, unseenLinesMessage } from "./messages";
import { MismatchError } from "./mismatch";
import { detectLineEnding, type LineEnding, normalizeToLF, restoreLineEndings, stripBom } from "./normalize";
import type { RecoveryResult } from "./recovery";
import type { SnapshotStore } from "./snapshots";
import type { ApplyResult, BlockResolution, BlockResolver, Edit } from "./types";

export interface PatcherOptions {
  fs: Filesystem;
  snapshots: SnapshotStore;
  blockResolver?: BlockResolver;
}

export interface PatchSectionResult {
  path: string;
  canonicalPath: string;
  op: "create" | "update" | "noop";
  before: string;
  after: string;
  persisted: string;
  written: string;
  fileHash: string;
  header: string;
  firstChangedLine?: number;
  warnings: string[];
  blockResolutions?: BlockResolution[];
}

export interface PatcherApplyResult {
  sections: PatchSectionResult[];
}

export class PreparedSection {
  constructor(
    readonly section: PatchSection,
    readonly canonicalPath: string,
    readonly exists: boolean,
    readonly rawContent: string,
    readonly bom: string,
    readonly lineEnding: LineEnding,
    readonly normalized: string,
    readonly applyResult: ApplyResult,
    readonly parseWarnings: readonly string[],
    readonly blockWarnings: readonly string[] = [],
  ) {}

  get isNoop(): boolean {
    return this.applyResult.text === this.normalized;
  }
}

function hasAnchorScopedEdit(edits: readonly Edit[]): boolean {
  return edits.some(edit => {
    if (edit.kind === "delete") return true;
    if (edit.kind === "block") return true;
    return edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor";
  });
}

export class Patcher {
  private fs: Filesystem;
  private snapshots: SnapshotStore;
  private blockResolver: BlockResolver | undefined;

  constructor(options: PatcherOptions) {
    this.fs = options.fs;
    this.snapshots = options.snapshots;
    this.blockResolver = options.blockResolver;
  }

  async apply(patch: Patch): Promise<PatcherApplyResult> {
    // All-or-nothing: prepare every section in memory first. If any section
    // fails to prepare (hash mismatch, unseen lines, parse error, unresolved
    // block, ...), no disk write happens for any section.
    const prepared: PreparedSection[] = [];
    for (const section of patch.sections) {
      prepared.push(await this.prepare(section));
    }

    const results: PatchSectionResult[] = [];
    for (const preparedSection of prepared) {
      results.push(
        preparedSection.isNoop ? this.noopResult(preparedSection) : await this.commit(preparedSection),
      );
    }

    return { sections: results };
  }

  async prepare(section: PatchSection): Promise<PreparedSection> {
    const canonicalPath = section.resolvedPath;
    let rawContent: string;
    let exists: boolean;

    try {
      rawContent = await this.fs.readText(canonicalPath);
      exists = true;
    } catch (err) {
      if (isNotFound(err)) {
        rawContent = "";
        exists = false;
      } else {
        throw err;
      }
    }

    const { bom, text: bomStripped } = stripBom(rawContent);
    const lineEnding = detectLineEnding(bomStripped);
    const normalized = normalizeToLF(bomStripped);

    // Parse once and reuse the edits for tag validation, recovery, and apply.
    const { edits: parsedEdits, warnings: parseWarnings } = parsePatch(section.text);

    // Resolve block edits up front so both recovery and apply see concrete edits.
    const blockWarnings: string[] = [];
    const edits = resolveBlockEdits(parsedEdits, normalized, canonicalPath, this.blockResolver, {
      onWarning: (msg: string) => { blockWarnings.push(msg); },
    });

    // Validate snapshot tag.
    if (section.fileHash) {
      const liveHash = await computeFileHash(normalized);
      const snapshot = this.snapshots.byHash(canonicalPath, section.fileHash);

      if (liveHash !== section.fileHash) {
        // Head/tail-only inserts are position-stable: a stale tag is non-fatal.
        if (!hasAnchorScopedEdit(edits)) {
          const applyResult = applyEdits(normalized, edits);
          return new PreparedSection(
            section, canonicalPath, exists, rawContent, bom, lineEnding,
            normalized,
            {
              text: applyResult.text,
              firstChangedLine: applyResult.firstChangedLine,
              warnings: [HEADTAIL_DRIFT_WARNING, ...(applyResult.warnings ?? [])],
            },
            parseWarnings,
            blockWarnings,
          );
        }

        // File drifted: try to replay against the tagged snapshot, then 3-way-merge.
        if (snapshot) {
          try {
            const recovered = await this.tryRecover(canonicalPath, normalized, section.fileHash, edits);
            if (recovered) {
              return new PreparedSection(
                section, canonicalPath, exists, rawContent, bom, lineEnding,
                normalized,
                {
                  text: recovered.text,
                  firstChangedLine: recovered.firstChangedLine,
                  warnings: recovered.warnings,
                },
                parseWarnings,
                blockWarnings,
              );
            }
          } catch {
            // Recovery failed, fall through to the mismatch error.
          }
        }

        const anchorLines = extractAnchorLines(edits);
        throw new MismatchError({
          path: canonicalPath,
          expectedFileHash: section.fileHash,
          actualFileHash: liveHash,
          fileLines: normalized.split("\n"),
          anchorLines,
          hashRecognized: snapshot !== null,
        });
      }

      // Tag matches. Reject edits anchored on lines the model never displayed.
      if (snapshot?.seenLines && hasAnchorScopedEdit(edits)) {
        this.checkUnseenLines(section, canonicalPath, snapshot.seenLines, edits);
      }
    } else {
      // No tag: allow only position-stable head/tail inserts.
      const hasHeadTailOnly = edits.length > 0 && edits.every(
        (e: Edit) =>
          (e.kind === "insert" && (e.cursor.kind === "bof" || e.cursor.kind === "eof")) ||
          e.kind === "block",
      );
      if (!hasHeadTailOnly) {
        throw new Error(missingSnapshotTagMessage(section.rawPath));
      }
    }

    const applyResult = applyEdits(normalized, edits);

    return new PreparedSection(
      section, canonicalPath, exists, rawContent, bom, lineEnding,
      normalized, applyResult, parseWarnings, blockWarnings,
    );
  }

  async commit(prepared: PreparedSection): Promise<PatchSectionResult> {
    const { section, canonicalPath, bom, lineEnding, normalized, applyResult } = prepared;
    const resultText = restoreLineEndings(applyResult.text, lineEnding);
    const persisted = bom + resultText;

    let written: WriteResult;
    if (!prepared.exists) {
      written = await this.fs.writeText(canonicalPath, persisted);
    } else if (!prepared.isNoop) {
      written = await this.fs.writeText(canonicalPath, persisted);
    } else {
      written = { text: persisted };
    }

    const fileHash = await computeFileHash(applyResult.text);
    await this.snapshots.record(canonicalPath, applyResult.text);

    const header = formatHashlineHeader(section.rawPath, fileHash);

    return {
      path: section.rawPath,
      canonicalPath,
      op: prepared.exists ? (prepared.isNoop ? "noop" : "update") : "create",
      before: normalized,
      after: applyResult.text,
      persisted,
      written: written.text,
      fileHash,
      header,
      firstChangedLine: applyResult.firstChangedLine,
      warnings: [...(applyResult.warnings ?? []), ...prepared.blockWarnings],
      blockResolutions: applyResult.blockResolutions,
    };
  }

  noopResult(prepared: PreparedSection): PatchSectionResult {
    return {
      path: prepared.section.rawPath,
      canonicalPath: prepared.canonicalPath,
      op: "noop",
      before: prepared.normalized,
      after: prepared.normalized,
      persisted: prepared.rawContent,
      written: prepared.rawContent,
      fileHash: "",
      header: "",
      warnings: [],
    };
  }

  private async tryRecover(
    path: string,
    currentText: string,
    fileHash: string,
    edits: readonly Edit[],
  ): Promise<RecoveryResult | null> {
    const { recover } = await import("./recovery");
    return recover(this.snapshots, { path, currentText, fileHash, edits });
  }

  private checkUnseenLines(
    section: PatchSection,
    canonicalPath: string,
    seenLines: Set<number>,
    edits: readonly Edit[],
  ): void {
    const unseen: number[] = [];

    for (const edit of edits) {
      if (edit.kind === "delete" && !seenLines.has(edit.anchor.line)) {
        unseen.push(edit.anchor.line);
      }
      if (edit.kind === "insert" && edit.cursor.kind === "before_anchor" && !seenLines.has(edit.cursor.anchor.line)) {
        unseen.push(edit.cursor.anchor.line);
      }
      if (edit.kind === "insert" && edit.cursor.kind === "after_anchor" && !seenLines.has(edit.cursor.anchor.line)) {
        unseen.push(edit.cursor.anchor.line);
      }
    }

    if (unseen.length > 0 && section.fileHash) {
      throw new Error(unseenLinesMessage(section.rawPath, unseen, section.fileHash));
    }
  }
}

function extractAnchorLines(edits: readonly Edit[]): number[] {
  const lines: number[] = [];
  for (const edit of edits) {
    if (edit.kind === "delete") lines.push(edit.anchor.line);
    if (edit.kind === "insert" && (edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor")) {
      lines.push(edit.cursor.anchor.line);
    }
    if (edit.kind === "block") lines.push(edit.anchor.line);
  }
  return lines;
}
