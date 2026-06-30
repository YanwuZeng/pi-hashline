/**
 * A conservative, dependency-free `BlockResolver` for brace-delimited
 * languages (TS/JS/Java/C/C++/Go/Rust/C#/etc.).
 *
 * Given an anchor line N, it finds the syntactic block that BEGINS on N:
 * the first `{` at depth 0 scanning forward from N, matched to its closing
 * `}`. The span is `{ start: N, end: closerLine }` so `SWAP.BLK N` replaces
 * the whole construct including its header.
 *
 * Safety: it returns `null` (→ the caller raises a clear "use a concrete
 * range" error) whenever it cannot confidently resolve a block — e.g. when
 * a `}` at depth 0 appears before any opener (N sits inside a block, not on
 * an opener), when braces are unbalanced, or when N is out of range. It
 * skips braces inside strings, template literals, line/block comments, and
 * regex literals so they cannot corrupt the depth count.
 *
 * Limitations: indent-based blocks (Python) have no braces and resolve to
 * `null`. Regex-vs-division detection uses a keyword/preceding-char heuristic
 * that handles typical code; pathological regex literals with balanced braces
 * (e.g. `/}{/`) can in rare cases mis-resolve. `SWAP.BLK` is not advertised in
 * the prompts, so this is a convenience for hand-authored patches — when in
 * doubt it bails to `null`.
 */
import type { BlockResolver, BlockSpan } from "./types";

const REGEX_PRECEDING_CHARS = new Set([
  "",
  "(",
  ",",
  "=",
  ":",
  ";",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  "[",
  "+",
  "-",
  "*",
  "/",
  "%",
  "~",
  "^",
  "<",
  ">",
]);

const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "else",
  "case",
  "do",
  "yield",
  "await",
  "if",
  "while",
  "for",
  "switch",
]);

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

export function findBraceBlock(text: string, anchorLine: number): BlockSpan | null {
  const lines = text.split("\n");
  if (anchorLine < 1 || anchorLine > lines.length) return null;

  // Char offset of the start of `anchorLine` (1-indexed).
  let startOffset = 0;
  for (let i = 0; i < anchorLine - 1; i++) startOffset += lines[i].length + 1;

  return scanBlock(text, startOffset, anchorLine);
}

type ScanState =
  | "code"
  | "line_comment"
  | "block_comment"
  | "str_double"
  | "str_single"
  | "str_template"
  | "regex"
  | "regex_class";

function scanBlock(text: string, startOffset: number, startLine: number): BlockSpan | null {
  const n = text.length;
  let i = startOffset;
  let curLine = startLine;
  let depth = 0;
  let openerLine = -1;
  let state: ScanState = "code";
  let lastCodeChar = "";
  let lastWord = "";

  while (i < n) {
    const ch = text[i];
    const next = i + 1 < n ? text[i + 1] : "";

    if (ch === "\n") {
      curLine++;
      if (state === "line_comment") state = "code";
      i++;
      continue;
    }

    switch (state) {
      case "line_comment":
        i++;
        continue;
      case "block_comment":
        if (ch === "*" && next === "/") { state = "code"; i += 2; continue; }
        i++;
        continue;
      case "str_double":
        if (ch === "\\") { i += 2; continue; }
        if (ch === '"') state = "code";
        i++;
        continue;
      case "str_single":
        if (ch === "\\") { i += 2; continue; }
        if (ch === "'") state = "code";
        i++;
        continue;
      case "str_template":
        if (ch === "\\") { i += 2; continue; }
        if (ch === "`") state = "code";
        i++;
        continue;
      case "regex_class":
        if (ch === "\\") { i += 2; continue; }
        if (ch === "]") state = "regex";
        i++;
        continue;
      case "regex":
        if (ch === "\\") { i += 2; continue; }
        if (ch === "[") { state = "regex_class"; i++; continue; }
        if (ch === "/") {
          state = "code";
          i++;
          // consume flags
          while (i < n && /[A-Za-z]/.test(text[i])) i++;
          lastCodeChar = "/"; // regex ended; a following `/` would be division
          lastWord = "";
          continue;
        }
        i++;
        continue;
      case "code": {
        if (ch === "/" && next === "/") { state = "line_comment"; i += 2; continue; }
        if (ch === "/" && next === "*") { state = "block_comment"; i += 2; continue; }
        if (ch === '"') { state = "str_double"; i++; continue; }
        if (ch === "'") { state = "str_single"; i++; continue; }
        if (ch === "`") { state = "str_template"; i++; continue; }
        if (ch === "/") {
          // Regex vs division: regex if preceding context allows it.
          const precedesRegex =
            (lastCodeChar === "" ) ||
            REGEX_PRECEDING_CHARS.has(lastCodeChar) ||
            (isWordChar(lastCodeChar) && REGEX_PRECEDING_KEYWORDS.has(lastWord));
          if (precedesRegex) { state = "regex"; i++; continue; }
          // division operator — not a brace
          i++;
          lastCodeChar = "/";
          lastWord = "";
          continue;
        }
        if (ch === "{") {
          if (depth === 0) {
            if (openerLine === -1) openerLine = curLine;
          }
          depth++;
          i++;
          lastCodeChar = "{";
          lastWord = "";
          continue;
        }
        if (ch === "}") {
          depth--;
          i++;
          lastCodeChar = "}";
          lastWord = "";
          if (depth === 0) {
            if (openerLine === -1) {
              // A closer at depth 0 before any opener: anchor is inside a
              // block, not on an opener. Bail.
              return null;
            }
            // Matched the opener.
            if (openerLine === curLine) {
              // Single-line block like `{ ... }` on the anchor line. Let the
              // caller decide (block.ts raises a "use plain SWAP" message).
              return { start: openerLine, end: curLine };
            }
            return { start: openerLine, end: curLine };
          }
          if (depth < 0) return null; // unbalanced
          continue;
        }
        // Track word/last-char for the regex heuristic. Whitespace does not
        // change the last meaningful code char, so `return /re/` still sees
        // "return" as the preceding token.
        if (isWordChar(ch)) {
          lastWord += ch;
          lastCodeChar = ch;
        } else if (ch === " " || ch === "\t" || ch === "\r") {
          // whitespace: keep lastWord and lastCodeChar as-is
        } else {
          lastWord = "";
          lastCodeChar = ch;
        }
        i++;
        continue;
      }
    }
  }

  // EOF: if we never found/matched a block, bail.
  return null;
}

export function createBraceBlockResolver(): BlockResolver {
  return ({ text, line }: { text: string; line: number }) => findBraceBlock(text, line);
}
