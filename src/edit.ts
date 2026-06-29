import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@mariozechner/pi-tui";
import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { Type } from "typebox";
import { loadPromptGuidelines } from "./prompts.ts";
import { resolvePath } from "./shared.ts";
import { parsePatch } from "./parser.ts";
import { resolveBlockEdits, hasBlockEdit } from "./block.ts";
import { applyEdits, buildCompactDiffPreview } from "./apply.ts";
import { computeFileHash, formatHashlineHeader, formatNumberedLine } from "./format.ts";
import { snapshotStore } from "./read.ts";
import { detectLineEnding, normalizeToLF, restoreLineEndings, stripBom } from "./normalize.ts";
import { MismatchError } from "./mismatch.ts";
import { recover } from "./recovery.ts";
import type { BlockResolver } from "./types.ts";

/** Accept Pi's native format: `{ edits: [{diff?}], path? }` or `{ diff, path? }` */
const editSchema = Type.Object({
  diff: Type.Optional(
    Type.String({
      description:
        "Hashline-format diff text. Must start with `[PATH#TAG]` file header, followed by hunk headers and `+TEXT` body rows.",
    }),
  ),
  edits: Type.Optional(
    Type.Array(Type.Any(), {
      description: "Pi's native edits array. First element's `diff` field or string is used as hashline text.",
    }),
  ),
  path: Type.Optional(
    Type.String({
      description: "Optional path override when the diff lacks a `[PATH#TAG]` header.",
    }),
  ),
});

const blockResolver: BlockResolver | undefined = undefined;

export function registerEditTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "edit",
    label: "edit#",
    description:
      "Edit a text file using hashline-format diff text. Format: `[path#TAG]` header + `SWAP`/`DEL`/`INS` ops with `+TEXT` body rows.",
    promptSnippet: "Make hashline-format edits using anchors from read",
    promptGuidelines: loadPromptGuidelines("edit.md"),
    parameters: editSchema,
    prepareArguments(raw: any): any {
      // Normalize Pi's native edit format { edits: [{diff?}], path? }
      // and the hashline direct format { diff, path? } into { diff, path? }.
      if (!raw || typeof raw !== "object") return raw;

      // Case 1: Pi dispatches as { edits: [{diff:"...", path:"..."}], path:"..." }
      if (Array.isArray(raw.edits)) {
        for (const item of raw.edits) {
          if (typeof item === "string") return { diff: item, path: raw.path };
          if (item && typeof item.diff === "string") return { diff: item.diff, path: raw.path ?? item.path };
          if (item && typeof item.text === "string") return { diff: item.text, path: raw.path ?? item.path };
        }
      }

      // Case 2: direct hashline text is passed as `edits` (string)
      if (typeof raw.edits === "string") {
        return { diff: raw.edits, path: raw.path };
      }

      // Case 3: already in the right format
      return raw;
    },
    renderShell: "self",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Operation aborted");

      let diffText = params.diff as string;
      if (!diffText) throw new Error("No hashline diff text provided. Pass a `diff` string in hashline format.");

      let pathOverride = params.path as string | undefined;

      // Extract path from [path#TAG] header if present
      const headerMatch = diffText.match(/^\[([^\]]+)\]/m);
      const filePath = pathOverride || (headerMatch ? headerMatch[1] : null);
      if (!filePath) {
        throw new Error(
          "No file path specified. Include `[path#TAG]` header in the diff, or pass `path` parameter.",
        );
      }

      const absolute = resolvePath(filePath, ctx?.cwd ?? process.cwd());
      await access(absolute, constants.R_OK | constants.W_OK);
      const raw = await readFile(absolute, "utf8");

      const { bom, text: bomStripped } = stripBom(raw);
      const eol = detectLineEnding(bomStripped);
      const normalized = normalizeToLF(bomStripped);
      const liveHash = await computeFileHash(normalized);

      // Parse the hashline diff
      const { edits, warnings: parseWarnings } = parsePatch(diffText);
      if (edits.length === 0) {
        return {
          content: [{ type: "text", text: "No edits produced from the diff text." }],
          details: { path: filePath, edits: 0 },
        };
      }

      // Validate file hash if present in the diff header
      if (headerMatch) {
        const headerHashMatch = headerMatch[1].match(/#([0-9A-F]{4})$/);
        if (headerHashMatch) {
          const expectedHash = headerHashMatch[1];
          if (liveHash !== expectedHash) {
            const recoveryResult = await recover(snapshotStore, {
              path: absolute, currentText: normalized, fileHash: expectedHash, edits,
            });
            if (recoveryResult) {
              const resultText = restoreLineEndings(recoveryResult.text, eol);
              const persisted = bom + resultText;
              await writeFile(absolute, persisted, "utf8");
              const newHash = await computeFileHash(recoveryResult.text);
              await snapshotStore.record(absolute, recoveryResult.text);
              const header = formatHashlineHeader(filePath, newHash);
              const diffPreview = buildCompactDiffPreview(normalized, recoveryResult.text);
              return {
                content: [{ type: "text", text: `${header}\n\nRecovery applied.\n\n${diffPreview.preview}` }],
                details: { path: filePath, edits: edits.length, fileHash: newHash, warnings: [...(recoveryResult.warnings ?? []), ...parseWarnings], displayDiff: diffPreview.preview },
              };
            }
            const fileLines = normalized.split("\n");
            throw new MismatchError({
              path: filePath, expectedFileHash: expectedHash, actualFileHash: liveHash,
              fileLines, anchorLines: extractAnchorLines(edits),
              hashRecognized: snapshotStore.byHash(absolute, expectedHash) !== null,
            });
          }
        }
      }

      // Resolve block edits
      let resolvedEdits = edits;
      const blockWarnings: string[] = [];
      if (hasBlockEdit(edits)) {
        if (!blockResolver) {
          const lowered: typeof edits = [];
          for (const edit of edits) {
            if (edit.kind === "block" && edit.mode === "insert_after") {
              for (const payload of edit.payloads) {
                lowered.push({
                  kind: "insert",
                  cursor: { kind: "after_anchor", anchor: { line: edit.anchor.line } },
                  text: payload, lineNum: edit.lineNum, index: lowered.length,
                });
              }
              blockWarnings.push(
                `INS.BLK.POST ${edit.anchor.line}: no block resolver, applied as INS.POST ${edit.anchor.line}:`,
              );
            } else if (edit.kind === "block") {
              throw new Error(`SWAP.BLK/DEL.BLK not available. Use concrete line ranges.`);
            } else {
              lowered.push(edit);
            }
          }
          resolvedEdits = lowered;
        } else {
          resolvedEdits = resolveBlockEdits(edits, normalized, absolute, blockResolver, {
            onWarning: (msg) => { blockWarnings.push(msg); },
          });
        }
      }

      // Apply edits
      const applyResult = applyEdits(normalized, resolvedEdits);
      const resultText = restoreLineEndings(applyResult.text, eol);
      const persisted = bom + resultText;
      await writeFile(absolute, persisted, "utf8");

      const newHash = await computeFileHash(applyResult.text);
      await snapshotStore.record(absolute, applyResult.text);
      const header = formatHashlineHeader(filePath, newHash);
      const diffPreview = buildCompactDiffPreview(normalized, applyResult.text);
      const anchorOutput = buildChangedAnchorOutput(applyResult.text, applyResult.firstChangedLine);
      const allWarnings: string[] = [...blockWarnings, ...(applyResult.warnings ?? []), ...parseWarnings];

      return {
        content: [{
          type: "text",
          text: [header, anchorOutput ? `\n${anchorOutput}` : "", allWarnings.length > 0 ? `\nWarnings:\n${allWarnings.join("\n")}` : "", `\n${diffPreview.preview}`].filter(Boolean).join(""),
        }],
        details: {
          path: filePath, edits: edits.length, fileHash: newHash,
          anchorRange: applyResult.firstChangedLine ? { start: applyResult.firstChangedLine, end: findChangedEnd(applyResult.text, normalized) } : undefined,
          displayDiff: diffPreview.preview, warnings: allWarnings,
        },
      };
    },
    renderCall(args, theme, context) {
      const component = (context.lastComponent as any) ?? new Box(1, 1, (text: string) => text);
      context.state.callComponent = component;
      const path = typeof args?.path === "string" ? args.path :
        typeof args?.diff === "string" ? args.diff.split("\n")[0] :
        Array.isArray(args?.edits) && args.edits[0]?.diff ? args.edits[0].diff.split("\n")[0] : "...";
      component.clear();
      component.addChild(new Text(`${theme.fg("toolTitle", theme.bold("edit#"))} ${theme.fg("accent", path)}`, 0, 0));
      return component;
    },
    renderResult(result, _options, theme, context) {
      if (context.isError) {
        context.state.errorText = result.content?.filter((c: any) => c.type === "text").map((c: any) => c.text ?? "").join("\n") || "Edit failed.";
      }
      if (typeof result.details?.displayDiff === "string") context.state.displayDiff = result.details.displayDiff;
      const component = context.state.callComponent as any;
      if (component) {
        component.clear();
        const path = context.args?.path || "...";
        component.addChild(new Text(`${theme.fg("toolTitle", theme.bold("edit#"))} ${theme.fg("accent", path)}`, 0, 0));
        if (context.state.errorText) { component.addChild(new Spacer(1)); component.addChild(new Text(theme.fg("error", context.state.errorText), 0, 0)); }
        if (context.state.displayDiff) { component.addChild(new Spacer(1)); component.addChild(new Text(theme.fg("toolOutput", context.state.displayDiff), 0, 0)); }
      }
      return new Container();
    },
  });
}

function extractAnchorLines(edits: any[]): number[] {
  const lines: number[] = [];
  for (const edit of edits) {
    if (edit.kind === "delete") lines.push(edit.anchor.line);
    if (edit.kind === "insert" && (edit.cursor?.kind === "before_anchor" || edit.cursor?.kind === "after_anchor")) lines.push(edit.cursor.anchor.line);
  }
  return lines;
}

function buildChangedAnchorOutput(text: string, firstChangedLine?: number): string {
  if (!firstChangedLine) return "";
  const lines = text.split("\n");
  const start = Math.max(0, firstChangedLine - 1);
  const end = Math.min(lines.length, start + 5);
  const selected: string[] = [];
  for (let i = start; i < end; i++) selected.push(formatNumberedLine(i + 1, lines[i]));
  if (selected.length === 0) return "";
  return `--- Changed lines ${start + 1}-${end} ---\n${selected.join("\n")}`;
}

function findChangedEnd(after: string, before: string): number {
  const afterLines = after.split("\n");
  const beforeLines = before.split("\n");
  for (let i = Math.max(afterLines.length, beforeLines.length) - 1; i >= 0; i--) {
    if (afterLines[i] !== beforeLines[i]) return i + 1;
  }
  return Math.max(afterLines.length, beforeLines.length);
}
