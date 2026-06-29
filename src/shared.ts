import { getKeybindings } from "@mariozechner/pi-tui";
import { isAbsolute, resolve } from "node:path";

export const DEFAULT_MAX_LINES = 400;
export const DEFAULT_MAX_BYTES = 32 * 1024;

/** Resolve a model-provided path against Pi's current working directory. */
export function resolvePath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/** Split text into lines (LF-normalized). */
export function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const parts = normalized.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** Format line range for UI display. */
export function formatLineRange(args: any, theme: any): string {
  if (args?.offset === undefined && args?.limit === undefined) return "";
  const startLine = args.offset ?? 1;
  const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
  return theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
}

/** Compact preview for UI (truncates long output). */
export function compactPreview(
  text: string,
  expanded: boolean,
  theme: any,
): string {
  const lines = trimTrailingEmptyLines(text.replace(/\r/g, "").split("\n"));
  const totalLines = lines.length;
  const maxLines = expanded ? lines.length : 10;
  const shown = lines.slice(0, maxLines).map(replaceTabs).join("\n");
  const remaining = lines.length - maxLines;
  const suffix =
    remaining > 0
      ? `${theme.fg("muted", `\n... (${remaining} more lines, ${totalLines} total,`)} ${keyHint(theme, "app.tools.expand", "to expand")})`
      : "";
  return shown + suffix;
}

/** Strip hashline line-number prefixes from display text. */
export function stripHashlinePrefixesForDisplay(text: string): string {
  return text
    .split("\n")
    .filter(line => !line.startsWith("[") && !line.startsWith("***"))
    .map(line => line.replace(/^\d+:/, ""))
    .join("\n");
}

function replaceTabs(text: string): string {
  return text.replace(/\t/g, "   ");
}

function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end--;
  return lines.slice(0, end);
}

function keyHint(theme: any, keybinding: string, description: string): string {
  const keys = getKeybindings().getKeys(keybinding);
  const keyText = Array.isArray(keys) ? keys.join("/") : String(keys ?? "");
  const displayKey = keyText || "ctrl+o";
  return theme.fg("dim", displayKey) + theme.fg("muted", ` ${description}`);
}
