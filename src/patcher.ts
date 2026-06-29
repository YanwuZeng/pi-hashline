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
    const results: PatchSectionResult[] = [];

    for (const section of patch.sections) {
      const prepared = await this.prepare(section);
      if (!prepared.isNoop) {
        const commitResult = await this.commit(prepared);
        results.push(commitResult);
      } else {
        results.push(this.noopResult(prepared));
      }
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

    // Validate snapshot tag
    if (section.fileHash) {
      const liveHash = await computeFileHash(normalized);
      const snapshot = this.snapshots.byHash(canonicalPath, section.fileHash);

      if (liveHash !== section.fileHash) {
        if (snapshot) {
          // Try recovery
          try {
            const edits = this.parseSectionEdits(section);
            const recovered = await this.tryRecover(canonicalPath, normalized, section.fileHash, edits);
            if (recovered) {
              return new PreparedSection(
                section, canonicalPath, exists, rawContent, bom, lineEnding,
                normalized,
                { text: recovered.text, firstChangedLine: recovered.firstChangedLine, warnings: recovered.warnings },
                [],
              );
            }
          } catch {
            // Recovery failed, fall through to error
          }
        }

        const anchorEdits = this.parseSectionEdits(section);
        const anchorLines = extractAnchorLines(anchorEdits);

        throw new MismatchError({
          path: canonicalPath,
          expectedFileHash: section.fileHash,
          actualFileHash: liveHash,
          fileLines: normalized.split("\n"),
          anchorLines,
          hashRecognized: snapshot !== null,
        });
      }

      // Check unseen lines
      if (snapshot?.seenLines && hasAnchorScopedEdit(this.parseSectionEdits(section))) {
        this.checkUnseenLines(section, canonicalPath, snapshot.seenLines);
      }
    } else {
      // Missing tag - warn but allow head/tail inserts
      const edits = this.parseSectionEdits(section);
      const hasHeadTailOnly = edits.length > 0 && edits.every(
        e => (e.kind === "insert" && (e.cursor.kind === "bof" || e.cursor.kind === "eof")) || e.kind === "block",
      );
      if (!hasHeadTailOnly) {
        throw new Error(missingSnapshotTagMessage(section.rawPath));
      }
    }

    // Parse and resolve edits
    let edits = this.parseSectionEdits(section);
    edits = resolveBlockEdits(edits, normalized, canonicalPath, this.blockResolver, {
      onWarning: (msg) => { /* warnings collected later */ },
    });

    // Apply
    const applyResult = applyEdits(normalized, edits);

    return new PreparedSection(
      section, canonicalPath, exists, rawContent, bom, lineEnding,
      normalized, applyResult, [],
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
      warnings: [...(applyResult.warnings ?? [])],
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

  private parseSectionEdits(section: PatchSection): Edit[] {
    const result = parsePatch(section.text);
    const result = parsePatch(section.text);
    return result.edits;
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
  ): void {
    const edits = this.parseSectionEdits(section);
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
