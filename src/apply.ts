import type { Anchor, ApplyResult, Cursor, Edit } from "./types";

type InsertEdit = Extract<Edit, { kind: "insert" }>;
type DeleteEdit = Extract<Edit, { kind: "delete" }>;

// ── Atomic operation types ─────────────────────────────────────────────────

/** An atomic edit operation with its target line for bottom-up sorting. */
interface AtomicOp {
  kind: "replace" | "insert_before" | "insert_after" | "bof" | "eof" | "delete";
  /** 1-indexed anchor line used for bottom-up sorting. 0 for bof, Infinity for eof. */
  anchorLine: number;
  /** Payload lines to insert. */
  payload: string[];
  /** Number of lines to delete (for replace and delete ops). */
  deleteCount: number;
  /** Stable sort tiebreaker (original index in the edit list). */
  index: number;
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

function computeInsertAfterLanding(
  anchorLine: number,
  firstPayloadLine: string,
  fileLines: readonly string[],
): { landingLine: number; crossed: number } {
  const anchorDepth = indentDepth(fileLines[anchorLine - 1] ?? "");
  const bodyDepth = indentDepth(firstPayloadLine);
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

function trailingPhantomLine(fileLines: readonly string[]): number {
  return fileLines.length > 1 && fileLines[fileLines.length - 1] === "" ? fileLines.length : 0;
}

// ── Group edits into atomic operations ─────────────────────────────────────

/**
 * Group a flat list of edits into atomic operations, preserving replacement
 * groups (inserts + deletes) as single operations.
 */
function groupAtomicOps(edits: readonly Edit[]): AtomicOp[] {
  const ops: AtomicOp[] = [];
  let i = 0;

  while (i < edits.length) {
    const edit = edits[i];

    // Block edits must be resolved before reaching the applier
    if (edit.kind === "block") {
      throw new Error("Unresolved block edit reached applier; run resolveBlockEdits first.");
    }

    // ── Replacement group: consecutive "replacement" inserts + consecutive deletes ──
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
        insertEnd < edits.length &&
        edits[insertEnd].kind === "insert" &&
        edits[insertEnd].mode === "replacement" &&
        edits[insertEnd].cursor.kind === "before_anchor" &&
        edits[insertEnd].cursor.anchor.line === anchorLine &&
        edits[insertEnd].lineNum === sourceLineNum
      ) {
        payload.push((edits[insertEnd] as InsertEdit).text);
        insertEnd++;
      }

      // Collect consecutive deletes starting at anchorLine
      const deleteEdits: DeleteEdit[] = [];
      let expectedLine = anchorLine;
      let deleteEnd = insertEnd;
      while (
        deleteEnd < edits.length &&
        edits[deleteEnd].kind === "delete" &&
        edits[deleteEnd].anchor.line === expectedLine &&
        edits[deleteEnd].lineNum === sourceLineNum
      ) {
        deleteEdits.push(edits[deleteEnd] as DeleteEdit);
        expectedLine++;
        deleteEnd++;
      }

      ops.push({
        kind: "replace",
        anchorLine,
        payload,
        deleteCount: deleteEdits.length,
        index: edit.index,
      });
      i = deleteEnd;
      continue;
    }

    // ── Individual insert ──
    if (edit.kind === "insert") {
      const cursor = edit.cursor;
      if (cursor.kind === "bof") {
        ops.push({ kind: "bof", anchorLine: 0, payload: [edit.text], deleteCount: 0, index: edit.index });
      } else if (cursor.kind === "eof") {
        ops.push({ kind: "eof", anchorLine: Infinity, payload: [edit.text], deleteCount: 0, index: edit.index });
      } else if (cursor.kind === "before_anchor") {
        ops.push({ kind: "insert_before", anchorLine: cursor.anchor.line, payload: [edit.text], deleteCount: 0, index: edit.index });
      } else if (cursor.kind === "after_anchor") {
        ops.push({ kind: "insert_after", anchorLine: cursor.anchor.line, payload: [edit.text], deleteCount: 0, index: edit.index });
      }
      i++;
      continue;
    }

    // ── Standalone delete ──
    if (edit.kind === "delete") {
      ops.push({ kind: "delete", anchorLine: edit.anchor.line, payload: [], deleteCount: 1, index: edit.index });
      i++;
      continue;
    }

    i++;
  }

  return ops;
}

/**
 * Merge consecutive atomic operations that share the same anchor and kind,
 * batching their payloads together. This ensures multiple INS.POST payload
 * lines at the same anchor are inserted in one splice call, preventing
 * the duplication bug seen when inserting each line individually.
 */
function mergeConsecutiveOps(ops: AtomicOp[]): AtomicOp[] {
  if (ops.length === 0) return ops;
  const merged: AtomicOp[] = [];
  let current = ops[0];

  for (let i = 1; i < ops.length; i++) {
    const next = ops[i];
    const sameKind = current.kind === next.kind;
    const sameAnchor =
      current.anchorLine === next.anchorLine &&
      (current.kind === "insert_after" || current.kind === "insert_before" || current.kind === "bof" || current.kind === "eof");
    if (sameKind && sameAnchor) {
      // Merge payloads; keep the lower index for stability
      current = { ...current, payload: [...current.payload, ...next.payload], index: Math.min(current.index, next.index) };
    } else {
      merged.push(current);
      current = next;
    }
  }
  merged.push(current);
  return merged;
}

// ── Main apply function ────────────────────────────────────────────────────

export function applyEdits(oldText: string, edits: readonly Edit[]): ApplyResult {
  // Step 1: Group edits into atomic operations
  let ops = groupAtomicOps(edits);

  // Step 2: Merge consecutive same-anchor insert ops (batch payloads)
  ops = mergeConsecutiveOps(ops);

  // Step 3: Sort operations bottom-up (descending anchorLine) with stable tiebreaker.
  // Bottom-up processing prevents line-number drift: edits at higher line numbers
  // are applied first, so they don't shift the positions of lower-line edits.
  ops.sort((a, b) => {
    if (b.anchorLine !== a.anchorLine) return b.anchorLine - a.anchorLine;
    return a.index - b.index;
  });

  // Step 4: Apply each operation against the file
  const warnings: string[] = [];
  let fileLines = oldText.split("\n");

  for (const op of ops) {
    switch (op.kind) {
      case "replace": {
        const deleteStart = op.anchorLine - 1;
        if (op.deleteCount > 0) {
          fileLines.splice(deleteStart, op.deleteCount, ...op.payload);
        } else {
          // No deletes — treat as insert before
          fileLines.splice(deleteStart, 0, ...op.payload);
        }
        break;
      }

      case "insert_before": {
        const idx = op.anchorLine - 1;
        fileLines.splice(idx, 0, ...op.payload);
        break;
      }

      case "insert_after": {
        const { landingLine, crossed } = computeInsertAfterLanding(
          op.anchorLine,
          op.payload[0] ?? "",
          fileLines,
        );
        if (crossed > 0) {
          warnings.push(
            `INS.POST ${op.anchorLine}: landing shifted from line ${op.anchorLine} to ${landingLine} (${crossed} closer${crossed === 1 ? "" : "s"} skipped)`,
          );
        }
        fileLines.splice(landingLine, 0, ...op.payload);
        break;
      }

      case "bof": {
        if (fileLines.length === 1 && fileLines[0] === "") {
          fileLines = [...op.payload];
        } else {
          fileLines.splice(0, 0, ...op.payload);
        }
        break;
      }

      case "eof": {
        const hasTrailingNewline = fileLines.length > 0 && fileLines[fileLines.length - 1] === "";
        const idx = hasTrailingNewline ? fileLines.length - 1 : fileLines.length;
        fileLines.splice(idx, 0, ...op.payload);
        break;
      }

      case "delete": {
        const idx = op.anchorLine - 1;
        const phantomLine = trailingPhantomLine(fileLines);
        if (idx !== phantomLine && idx >= 0 && idx < fileLines.length) {
          fileLines.splice(idx, op.deleteCount);
        }
        break;
      }
    }
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
  const out: string[] = [];
  const maxLen = Math.max(beforeLines.length, afterLines.length);

  for (let i = 0; i < maxLen; i++) {
    if (i >= beforeLines.length) {
      out.push(`+ ${afterLines[i]}`);
      added++;
    } else if (i >= afterLines.length) {
      out.push(`- ${beforeLines[i]}`);
      removed++;
    } else if (beforeLines[i] !== afterLines[i]) {
      out.push(`- ${beforeLines[i]}`);
      out.push(`+ ${afterLines[i]}`);
      added++;
      removed++;
    }
  }

  return {
    preview: out.join("\n"),
    addedLines: added,
    removedLines: removed,
  };
}
