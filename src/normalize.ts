/**
 * Minimal text-shape normalization: line-ending detection / round-trip and
 * BOM stripping.
 */

export type LineEnding = "\r\n" | "\n";

/** Detect the first line ending style in `content`. Defaults to LF when neither is present. */
export function detectLineEnding(content: string): LineEnding {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

/** Normalize every line ending to LF. */
export function normalizeToLF(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** Re-encode LF text with the requested line ending. */
export function restoreLineEndings(text: string, ending: LineEnding): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export interface BomResult {
  bom: string;
  text: string;
}

/** Strip a UTF-8 BOM if present and return both the BOM and the trailing text. */
export function stripBom(content: string): BomResult {
  return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}
