import { STRUCTURAL_CLOSER_RE } from "./apply";
import {
  BLOCK_RESOLVER_UNAVAILABLE,
  blockSingleLineMessage,
  blockUnresolvedMessage,
  insertAfterBlockCloserLoweredWarning,
  insertAfterBlockUnresolvedLoweredWarning,
} from "./messages";
import type { BlockResolution, BlockResolver, Cursor, Edit } from "./types";

export interface ResolveBlockEditsOptions {
  onUnresolved?: "throw" | "drop";
  onResolved?: (resolution: BlockResolution) => void;
  onWarning?: (message: string) => void;
}

export function hasBlockEdit(edits: readonly Edit[]): boolean {
  return edits.some(edit => edit.kind === "block");
}

export function resolveBlockEdits(
  edits: readonly Edit[],
  text: string,
  path: string,
  resolver: BlockResolver | undefined,
  options: ResolveBlockEditsOptions = {},
): readonly Edit[] {
  if (!hasBlockEdit(edits)) return edits;
  const onUnresolved = options.onUnresolved ?? "throw";
  const resolved: Edit[] = [];
  let synthIndex = 0;

  for (const edit of edits) {
    if (edit.kind !== "block") {
      resolved.push(edit);
      continue;
    }

    const op = edit.mode === "insert_after" ? "insert_after" : edit.payloads.length === 0 ? "delete" : "replace";
    const span = resolver ? resolver({ path, text, line: edit.anchor.line }) : null;

    if (span === null) {
      if (op === "insert_after") {
        const anchorText = text.split("\n")[edit.anchor.line - 1];
        const isCloser = anchorText !== undefined && STRUCTURAL_CLOSER_RE.test(anchorText);
        options.onWarning?.(
          isCloser
            ? insertAfterBlockCloserLoweredWarning(edit.anchor.line)
            : insertAfterBlockUnresolvedLoweredWarning(edit.anchor.line),
        );
        // Lower to plain insert after N:
        for (const payload of edit.payloads) {
          resolved.push({
            kind: "insert",
            cursor: { kind: "after_anchor", anchor: { line: edit.anchor.line } },
            text: payload,
            lineNum: edit.lineNum,
            index: synthIndex++,
          });
        }
        continue;
      }

      if (onUnresolved === "drop") continue;

      const fileLines = text.split("\n");
      throw new Error(blockUnresolvedMessage(edit.anchor.line, op === "delete" ? "delete" : "replace", fileLines));
    }

    if (span.start === span.end) {
      throw new Error(blockSingleLineMessage(edit.anchor.line, op));
    }

    options.onResolved?.({ anchorLine: edit.anchor.line, start: span.start, end: span.end, op });

    if (op === "delete") {
      for (let l = span.start; l <= span.end; l++) {
        resolved.push({ kind: "delete", anchor: { line: l }, lineNum: edit.lineNum, index: synthIndex++ });
      }
    } else if (op === "replace") {
      const cursor: Cursor = { kind: "before_anchor", anchor: { line: span.start } };
      for (const payload of edit.payloads) {
        resolved.push({ kind: "insert", cursor: cloneCursor(cursor), text: payload, lineNum: edit.lineNum, index: synthIndex++, mode: "replacement" });
      }
      for (let l = span.start; l <= span.end; l++) {
        resolved.push({ kind: "delete", anchor: { line: l }, lineNum: edit.lineNum, index: synthIndex++ });
      }
    } else if (op === "insert_after") {
      for (const payload of edit.payloads) {
        resolved.push({
          kind: "insert",
          cursor: { kind: "after_anchor", anchor: { line: span.end } },
          text: payload,
          lineNum: edit.lineNum,
          index: synthIndex++,
          blockStart: span.start,
        });
      }
    }
  }

  return resolved;
}

function cloneCursor(c: Cursor): Cursor {
  if (c.kind === "before_anchor" || c.kind === "after_anchor") {
    return { kind: c.kind, anchor: { ...c.anchor } };
  }
  return c;
}
