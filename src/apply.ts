import type { Anchor, ApplyResult, Cursor, Edit } from "./types";

type InsertEdit = Extract<Edit, { kind: "insert" }>;
type DeleteEdit = Extract<Edit, { kind: "delete" }>;
type AppliedEdit = InsertEdit | DeleteEdit;

function trailingPhantomLine(fileLines: readonly string[]): number {
  return fileLines.length > 1 && fileLines[fileLines.length - 1] === "" ? fileLines.length : 0;
}

// ── Landing-shift logic ────────────────────────────────────────────────────

/** Regex matching structural closers (common across many languages). */
export const STRUCTURAL_CLOSER_RE = /^\s*(?:end|}\)?|\]\)?|\}>|end\b|\/\*\*?|\*\/|```)\s*$/;

function indentDepth(line: string): number {
  let count = 0;
  for (const ch of line) {
    if (ch === " ") count++;
    else if (ch === "\t") count += 2;
    else break;
  }
  return count;
}

function adjustInsertAfterLanding(
  edit: InsertEdit,
  fileLines: readonly string[],
): { landingLine: number; crossed: number } {
  const anchorLine = edit.cursor.anchor.line;
  const anchorDepth = indentDepth(fileLines[anchorLine - 1] ?? "");
  const bodyDepth = indentDepth(edit.text);
  if (bodyDepth >= anchorDepth) return { landingLine: anchorLine, crossed: 0 };
  let landingLine = anchorLine;
  let crossed = 0;
  while (landingLine < fileLines.length) {
    const nextLine = fileLines[landingLine];
    if (!nextLine) break;
    if (indentDepth(nextLine) <= bodyDepth) break;
    if (STRUCTURAL_CLOSER_RE.test(nextLine.trim())) {
      landingLine++;
      crossed++;
    } else {
      break;
    }
  }
  return { landingLine, crossed };
}

// ── Main apply function ────────────────────────────────────────────────────

export function applyEdits(oldText: string, edits: readonly Edit[]): ApplyResult {
  const warnings: string[] = [];
  let fileLines = oldText.split("\n");

  // Separate block edits (must be resolved before calling this function)
  const resolved: AppliedEdit[] = [];
  for (const edit of edits) {
    if (edit.kind === "block") {
      throw new Error("Unresolved block edit reached applier; run resolveBlockEdits first.");
    }
    resolved.push(edit as AppliedEdit);
  }

  // Process in order: group replacement inserts + deletes atomically
  let i = 0;
  while (i < resolved.length) {
    const edit = resolved[i];

    // Check if this is the start of a replacement group
    if (
      edit.kind === "insert" &&
      edit.mode === "replacement" &&
      edit.cursor.kind === "before_anchor"
    ) {
      const anchorLine = edit.cursor.anchor.line;
      const sourceLineNum = edit.lineNum;
      const payload: string[] = [];
      let insertEnd = i;
      while (
        insertEnd < resolved.length &&
        resolved[insertEnd].kind === "insert" &&
        resolved[insertEnd].mode === "replacement" &&
        resolved[insertEnd].cursor.kind === "before_anchor" &&
        resolved[insertEnd].cursor.anchor.line === anchorLine &&
        resolved[insertEnd].lineNum === sourceLineNum
      ) {
        payload.push(resolved[insertEnd].text);
        insertEnd++;
      }

      // Collect consecutive deletes starting at anchorLine
      const deleteEdits: DeleteEdit[] = [];
      let expectedLine = anchorLine;
      let deleteEnd = insertEnd;
      while (
        deleteEnd < resolved.length &&
        resolved[deleteEnd].kind === "delete" &&
        resolved[deleteEnd].anchor.line === expectedLine &&
        resolved[deleteEnd].lineNum === sourceLineNum
      ) {
        deleteEdits.push(resolved[deleteEnd]);
        expectedLine++;
        deleteEnd++;
      }

      if (deleteEdits.length > 0) {
        // Replace: delete original range, then insert payload
        const deleteStart = anchorLine - 1;
        const deleteCount = deleteEdits.length;
        fileLines.splice(deleteStart, deleteCount, ...payload);
      } else {
        // Only inserts without matching deletes — treat as regular insert
        const idx = anchorLine - 1;
        fileLines.splice(idx, 0, ...payload);
      }

      i = deleteEnd;
      continue;
    }

    // Handle non-replacement inserts
    if (edit.kind === "insert") {
      const text = edit.text;
      const cursor = edit.cursor;

      if (cursor.kind === "bof") {
        if (fileLines.length === 1 && fileLines[0] === "") {
          fileLines = [text];
        } else {
          fileLines.splice(0, 0, text);
        }
      } else if (cursor.kind === "eof") {
        const hasTrailingNewline = fileLines.length > 0 && fileLines[fileLines.length - 1] === "";
        const idx = hasTrailingNewline ? fileLines.length - 1 : fileLines.length;
        fileLines.splice(idx, 0, text);
      } else if (cursor.kind === "before_anchor") {
        const idx = cursor.anchor.line - 1;
        fileLines.splice(idx, 0, text);
      } else if (cursor.kind === "after_anchor") {
        const { landingLine, crossed } = adjustInsertAfterLanding(edit, fileLines);
        if (crossed > 0) {
          warnings.push(
            `INS.POST ${cursor.anchor.line}: landing shifted from line ${cursor.anchor.line} to ${landingLine} (${crossed} closer${crossed === 1 ? "" : "s"} skipped)`,
          );
        }
        fileLines.splice(landingLine, 0, text);
      }
      i++;
      continue;
    }

    // Handle deletes (standalone)
    if (edit.kind === "delete") {
      const idx = edit.anchor.line - 1;
      const phantomLine = trailingPhantomLine(fileLines);
      if (idx !== phantomLine && idx >= 0 && idx < fileLines.length) {
        fileLines.splice(idx, 1);
      }
      i++;
      continue;
    }

    i++;
  }

  const result = fileLines.join("\n");
  const firstChangedLine = findFirstChangedLine(oldText, result);

  return {
    text: result,
    firstChangedLine,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

function findFirstChangedLine(before: string, after: string): number | undefined {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const maxLen = Math.max(beforeLines.length, afterLines.length);
  for (let i = 0; i < maxLen; i++) {
    if (beforeLines[i] !== afterLines[i]) return i + 1;
  }
  return undefined;
}

// ── Public convenience API ──────────────────────────────────────────────────

export function buildCompactDiffPreview(before: string, after: string): { preview: string; addedLines: number; removedLines: number } {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  let added = 0;
  let removed = 0;
  const lines: string[] = [];
  const maxLen = Math.max(beforeLines.length, afterLines.length);

  for (let i = 0; i < maxLen; i++) {
    if (i >= beforeLines.length) {
      lines.push(`+ ${afterLines[i]}`);
      added++;
    } else if (i >= afterLines.length) {
      lines.push(`- ${beforeLines[i]}`);
      removed++;
    } else if (beforeLines[i] !== afterLines[i]) {
      lines.push(`- ${beforeLines[i]}`);
      lines.push(`+ ${afterLines[i]}`);
      added++;
      removed++;
    }
  }

  return {
    preview: lines.join("\n"),
    addedLines: added,
    removedLines: removed,
  };
}
