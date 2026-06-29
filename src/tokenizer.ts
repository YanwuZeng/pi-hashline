import {
  describeAnchorExamples,
  HL_DELETE_BLOCK_KEYWORD,
  HL_DELETE_KEYWORD,
  HL_FILE_HASH_LENGTH,
  HL_FILE_HASH_SEP,
  HL_FILE_PREFIX,
  HL_FILE_SUFFIX,
  HL_HEADER_COLON,
  HL_INSERT_AFTER,
  HL_INSERT_AFTER_BLOCK_KEYWORD,
  HL_INSERT_BEFORE,
  HL_INSERT_HEAD,
  HL_INSERT_KEYWORD,
  HL_INSERT_TAIL,
  HL_PAYLOAD_REPLACE,
  HL_REPLACE_BLOCK_KEYWORD,
  HL_RANGE_SEP,
  HL_REPLACE_KEYWORD,
} from "./format";
import { ABORT_MARKER, BEGIN_PATCH_MARKER, END_PATCH_MARKER } from "./messages";
import type { Anchor, Cursor, ParsedRange } from "./types";

const CHAR_LINE_FEED = 10;
const CHAR_CARRIAGE_RETURN = 13;
const CHAR_ZERO = 48;
const CHAR_NINE = 57;
const CHAR_HASH = 35;
const CHAR_TAB = 9;
const CHAR_SPACE = 32;
const CHAR_HYPHEN = 45;
const CHAR_ELLIPSIS = 0x2026;
const CHAR_EQUALS = 61;
const CHAR_UPPER_A = 65;
const CHAR_UPPER_F = 70;
const CHAR_LOWER_A = 97;
const CHAR_LOWER_F = 102;
const CHAR_PAYLOAD_REPLACE = HL_PAYLOAD_REPLACE.charCodeAt(0);
const CHAR_COLON = HL_HEADER_COLON.charCodeAt(0);
const FILE_PREFIX_LENGTH = HL_FILE_PREFIX.length;
const FILE_SUFFIX_LENGTH = HL_FILE_SUFFIX.length;

function isDigitCode(code: number): boolean {
  return code >= CHAR_ZERO && code <= CHAR_NINE;
}

function isNonZeroDigitCode(code: number): boolean {
  return code > CHAR_ZERO && code <= CHAR_NINE;
}

function isHexDigitCode(code: number): boolean {
  return (
    isDigitCode(code) ||
    (code >= CHAR_UPPER_A && code <= CHAR_UPPER_F) ||
    (code >= CHAR_LOWER_A && code <= CHAR_LOWER_F)
  );
}

function isWhitespaceCode(code: number): boolean {
  return code === CHAR_SPACE || (code >= CHAR_TAB && code <= CHAR_CARRIAGE_RETURN);
}

function skipWhitespace(line: string, index: number, end = line.length): number {
  while (index < end && isWhitespaceCode(line.charCodeAt(index))) index++;
  return index;
}

function trimEndIndex(line: string): number {
  let end = line.length;
  while (end > 0 && isWhitespaceCode(line.charCodeAt(end - 1))) end--;
  return end;
}

function isEmptyLine(line: string): boolean {
  return line.length === 0;
}

function markerLineEquals(line: string, marker: string): boolean {
  const end = trimEndIndex(line);
  return end === marker.length && line.startsWith(marker);
}

// ── Token types ────────────────────────────────────────────────────────────

export interface BaseToken {
  lineNum: number;
  text: string;
}

export interface EnvelopeBegin extends BaseToken { kind: "envelope-begin"; }
export interface EnvelopeEnd extends BaseToken { kind: "envelope-end"; }
export interface Abort extends BaseToken { kind: "abort"; }
export interface Header extends BaseToken { kind: "header"; path: string; fileHash: string | undefined; }
export interface OpBlock extends BaseToken {
  kind: "op-block";
  target: BlockTarget;
}
export interface PayloadLiteral extends BaseToken { kind: "payload-literal"; }
export interface Blank extends BaseToken { kind: "blank"; }
export interface Raw extends BaseToken { kind: "raw"; }

export type Token = EnvelopeBegin | EnvelopeEnd | Abort | Header | OpBlock | PayloadLiteral | Blank | Raw;

// ── Block target types ────────────────────────────────────────────────────

export type BlockTarget =
  | { kind: "replace"; range: ParsedRange }
  | { kind: "delete"; range: ParsedRange }
  | { kind: "insert_before"; anchor: Anchor }
  | { kind: "insert_after"; anchor: Anchor }
  | { kind: "bof" }
  | { kind: "eof" }
  | { kind: "block"; anchor: Anchor }
  | { kind: "delete_block"; anchor: Anchor; range: ParsedRange }
  | { kind: "insert_after_block"; anchor: Anchor };

// ── Scanning helpers ───────────────────────────────────────────────────────

interface NumberScan {
  line: number;
  nextIndex: number;
}

function scanLineNumber(line: string, index: number, end: number): NumberScan | null {
  if (index >= end || !isNonZeroDigitCode(line.charCodeAt(index))) return null;
  let lineNumber = 0;
  let nextIndex = index;
  while (nextIndex < end) {
    const code = line.charCodeAt(nextIndex);
    if (!isDigitCode(code)) break;
    lineNumber = lineNumber * 10 + (code - CHAR_ZERO);
    nextIndex++;
  }
  return { line: lineNumber, nextIndex };
}

export function parseLid(raw: string, lineNum: number): Anchor {
  const end = trimEndIndex(raw);
  const numberStart = skipWhitespace(raw, 0, end);
  const number = scanLineNumber(raw, numberStart, end);
  if (number === null || skipWhitespace(raw, number.nextIndex, end) !== end) {
    throw new Error(
      `line ${lineNum}: expected a line number such as ${describeAnchorExamples("119")}; ` +
      `got ${JSON.stringify(raw)}. Use ${HL_FILE_PREFIX}PATH${HL_FILE_HASH_SEP}hash${HL_FILE_SUFFIX} from your latest read for file-version binding.`,
    );
  }
  return { line: number.line };
}

export function cloneCursor(cursor: Cursor): Cursor {
  if (cursor.kind === "before_anchor") return { kind: "before_anchor", anchor: { ...cursor.anchor } };
  if (cursor.kind === "after_anchor") return { kind: "after_anchor", anchor: { ...cursor.anchor } };
  return cursor;
}

// ── Line splitter (CRLF-aware) ─────────────────────────────────────────────

export function splitHashlineLines(text: string): string[] {
  if (text.length === 0) return [""];
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) !== CHAR_LINE_FEED) continue;
    let end = index;
    if (end > start && text.charCodeAt(end - 1) === CHAR_CARRIAGE_RETURN) end--;
    lines.push(text.slice(start, end));
    start = index + 1;
  }
  if (start < text.length) {
    let end = text.length;
    if (end > start && text.charCodeAt(end - 1) === CHAR_CARRIAGE_RETURN) end--;
    lines.push(text.slice(start, end));
  }
  return lines;
}

// ── Tokenizer ──────────────────────────────────────────────────────────────

export class Tokenizer {
  private lineNum = 0;

  *tokenize(text: string): Generator<Token, void, unknown> {
    this.lineNum = 0;
    const lines = splitHashlineLines(text);

    for (const line of lines) {
      this.lineNum++;
      if (line.length === 0) {
        yield { kind: "blank", lineNum: this.lineNum, text: "" } satisfies Blank;
        continue;
      }

      const firstChar = line.charCodeAt(0);

      // Envelope markers
      if (markerLineEquals(line, BEGIN_PATCH_MARKER)) {
        yield { kind: "envelope-begin", lineNum: this.lineNum, text: line } satisfies EnvelopeBegin;
        continue;
      }
      if (markerLineEquals(line, END_PATCH_MARKER)) {
        yield { kind: "envelope-end", lineNum: this.lineNum, text: line } satisfies EnvelopeEnd;
        continue;
      }
      if (markerLineEquals(line, ABORT_MARKER)) {
        yield { kind: "abort", lineNum: this.lineNum, text: line } satisfies Abort;
        continue;
      }

      // Payload literal: +TEXT
      if (firstChar === CHAR_PAYLOAD_REPLACE) {
        yield { kind: "payload-literal", lineNum: this.lineNum, text: line } satisfies PayloadLiteral;
        continue;
      }

      // Header: [path#TAG]
      if (firstChar === 91 /* [ */) {
        const parsed = this.tryParseHeader(line);
        if (parsed) {
          yield { kind: "header", ...parsed, lineNum: this.lineNum, text: line } satisfies Header;
          continue;
        }
      }

      // Try to parse as op
      const op = this.tryParseOp(line);
      if (op) {
        yield { kind: "op-block", target: op, lineNum: this.lineNum, text: line } satisfies OpBlock;
        continue;
      }

      // Fallback: raw line
      yield { kind: "raw", lineNum: this.lineNum, text: line } satisfies Raw;
    }
  }

  private tryParseHeader(line: string): { path: string; fileHash: string | undefined } | null {
    if (!line.endsWith(HL_FILE_SUFFIX)) return null;
    const inner = line.slice(FILE_PREFIX_LENGTH, line.length - FILE_SUFFIX_LENGTH).trim();
    if (inner.length === 0) return null;
    const hashIdx = inner.lastIndexOf(HL_FILE_HASH_SEP);
    if (hashIdx === -1) return { path: inner, fileHash: undefined };
    const fileHash = inner.slice(hashIdx + 1);
    if (
      fileHash.length !== HL_FILE_HASH_LENGTH ||
      ![...fileHash].every(c => isHexDigitCode(c.charCodeAt(0)))
    ) {
      return { path: inner, fileHash: undefined };
    }
    return { path: inner.slice(0, hashIdx), fileHash: fileHash.toUpperCase() };
  }

  private tryParseOp(line: string): BlockTarget | null {
    const end = trimEndIndex(line);
    const trimmed = line.slice(0, end);

    // Try block replacements: SWAP.BLK N:
    const blkReplaceMatch = trimmed.match(
      new RegExp(`^${escapeRe(HL_REPLACE_BLOCK_KEYWORD)}\\s+(${HL_LINE_NUM_RE})\\s*:\\s*$`),
    );
    if (blkReplaceMatch) {
      const lineNum = Number(blkReplaceMatch[1]);
      return { kind: "block", anchor: { line: lineNum } };
    }

    // Try block delete: DEL.BLK N
    const blkDeleteMatch = trimmed.match(
      new RegExp(`^${escapeRe(HL_DELETE_BLOCK_KEYWORD)}\\s+(${HL_LINE_NUM_RE})\\s*$`),
    );
    if (blkDeleteMatch) {
      const lineNum = Number(blkDeleteMatch[1]);
      return { kind: "delete_block", anchor: { line: lineNum }, range: { start: { line: lineNum }, end: { line: lineNum } } };
    }

    // Try insert after block: INS.BLK.POST N:
    const blkInsertMatch = trimmed.match(
      new RegExp(`^${escapeRe(HL_INSERT_AFTER_BLOCK_KEYWORD)}\\s+(${HL_LINE_NUM_RE})\\s*:\\s*$`),
    );
    if (blkInsertMatch) {
      const lineNum = Number(blkInsertMatch[1]);
      return { kind: "insert_after_block", anchor: { line: lineNum } };
    }

    // Try INS.PRE N:
    const insPreMatch = trimmed.match(
      new RegExp(`^${escapeRe(HL_INSERT_KEYWORD)}\\.${escapeRe(HL_INSERT_BEFORE)}\\s+(${HL_LINE_NUM_RE})\\s*:\\s*$`),
    );
    if (insPreMatch) {
      return { kind: "insert_before", anchor: { line: Number(insPreMatch[1]) } };
    }

    // Try INS.POST N:
    const insPostMatch = trimmed.match(
      new RegExp(`^${escapeRe(HL_INSERT_KEYWORD)}\\.${escapeRe(HL_INSERT_AFTER)}\\s+(${HL_LINE_NUM_RE})\\s*:\\s*$`),
    );
    if (insPostMatch) {
      return { kind: "insert_after", anchor: { line: Number(insPostMatch[1]) } };
    }

    // Try INS.HEAD:
    if (trimmed === `${HL_INSERT_KEYWORD}.${HL_INSERT_HEAD}${HL_HEADER_COLON}`) {
      return { kind: "bof" };
    }

    // Try INS.TAIL:
    if (trimmed === `${HL_INSERT_KEYWORD}.${HL_INSERT_TAIL}${HL_HEADER_COLON}`) {
      return { kind: "eof" };
    }

    // Try SWAP N.=M:
    const swapMatch = trimmed.match(
      new RegExp(`^${escapeRe(HL_REPLACE_KEYWORD)}\\s+(${HL_LINE_NUM_RE})\\s*${escapeRe(HL_RANGE_SEP)}\\s*(${HL_LINE_NUM_RE})\\s*:\\s*$`),
    );
    if (swapMatch) {
      const start = Number(swapMatch[1]);
      const end = Number(swapMatch[2]);
      return {
        kind: "replace",
        range: { start: { line: start }, end: { line: end } },
      };
    }

    // Try DEL N (single or range)
    const delMatch = trimmed.match(
      new RegExp(`^${escapeRe(HL_DELETE_KEYWORD)}\\s+(${HL_LINE_NUM_RE})(?:\\s*${escapeRe(HL_RANGE_SEP)}\\s*(${HL_LINE_NUM_RE}))?\\s*$`),
    );
    if (delMatch) {
      const start = Number(delMatch[1]);
      const end = delMatch[2] ? Number(delMatch[2]) : start;
      return {
        kind: "delete",
        range: { start: { line: start }, end: { line: end } },
      };
    }

    return null;
  }
}

// Helpers
const HL_LINE_NUM_RE = "[1-9]\\d*";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
