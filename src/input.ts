import * as path from "node:path";
import { applyEdits } from "./apply";
import { resolveBlockEdits } from "./block";
import {
  HL_FILE_HASH_EXAMPLES,
  HL_FILE_HASH_LENGTH,
  HL_FILE_HASH_SEP,
  HL_FILE_PREFIX,
  HL_FILE_SUFFIX,
} from "./format";
import { parsePatch, parsePatchStreaming } from "./parser";
import { Tokenizer } from "./tokenizer";
import type { ApplyResult, BlockResolver, Edit, SplitOptions } from "./types";

const TOKENIZER = new Tokenizer();

function unquoteHashlinePath(pathText: string): string {
  if (pathText.length < 2) return pathText;
  const first = pathText[0];
  const last = pathText[pathText.length - 1];
  if ((first === '"' || first === "'") && first === last) return pathText.slice(1, -1);
  return pathText;
}

const APPLY_PATCH_PATH_NOISE_RE =
  /^\*{0,3}\s*(?:(?:update|add|delete|move)[^A-Za-z0-9]*(?:file|to)?[^A-Za-z0-9]*:)?\s*\*{0,3}\s*/i;

function stripApplyPatchPathNoise(pathText: string): string {
  return pathText.replace(APPLY_PATCH_PATH_NOISE_RE, "");
}

function tryParseRecoveryHeader(line: string, cwd?: string): RawSection | null {
  if (!line.startsWith(HL_FILE_PREFIX) || !line.endsWith(HL_FILE_SUFFIX)) return null;
  const body = stripApplyPatchPathNoise(line.slice(HL_FILE_PREFIX.length, line.length - HL_FILE_SUFFIX.length).trim());
  if (body.length === 0) return null;

  const trailing = new RegExp(`#([0-9A-Fa-f]{${HL_FILE_HASH_LENGTH}})\\s*$`).exec(body);
  let pathText: string;
  let fileHash: string | undefined;
  if (trailing !== null) {
    pathText = body.slice(0, trailing.index);
    fileHash = trailing[1].toUpperCase();
  } else {
    pathText = body.replace(/\s+$/, "");
  }

  if (pathText.includes("#")) return null;
  pathText = unquoteHashlinePath(pathText);

  const cleanPath = cwd ? path.resolve(cwd, pathText) : pathText;
  return { path: cleanPath, fileHash };
}

export interface RawSection {
  path: string;
  fileHash?: string;
}

export interface PatchSection {
  rawPath: string;
  resolvedPath: string;
  fileHash: string | undefined;
  text: string;
  lineNum: number;
}

export function splitPatchInput(input: string, options?: SplitOptions): { sections: PatchSection[]; rest: string } {
  const lines = input.split("\n");
  const sections: PatchSection[] = [];
  let currentSection: { header: RawSection; textLines: string[]; lineNum: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Try to parse as header
    const rawHeader = tryParseRecoveryHeader(line, options?.cwd);
    if (rawHeader) {
      if (currentSection) {
        sections.push({
          rawPath: currentSection.header.path,
          resolvedPath: currentSection.header.path,
          fileHash: currentSection.header.fileHash,
          text: currentSection.textLines.join("\n"),
          lineNum: currentSection.lineNum,
        });
      }
      currentSection = {
        header: rawHeader,
        textLines: [],
        lineNum: i + 1,
      };
      continue;
    }

    if (currentSection) {
      currentSection.textLines.push(line);
    }
  }

  // Flush last section
  if (currentSection) {
    sections.push({
      rawPath: currentSection.header.path,
      resolvedPath: currentSection.header.path,
      fileHash: currentSection.header.fileHash,
      text: currentSection.textLines.join("\n"),
      lineNum: currentSection.lineNum,
    });
  }

  return {
    sections,
    rest: currentSection ? "" : lines.join("\n"),
  };
}

export class Patch {
  readonly sections: PatchSection[];

  constructor(input: string, cwd?: string) {
    const { sections } = splitPatchInput(input, { cwd });
    this.sections = sections;
  }

  parseEdits(sectionIndex: number): { edits: Edit[]; warnings: string[] } {
    const section = this.sections[sectionIndex];
    if (!section) throw new Error(`Section ${sectionIndex} not found`);
    return parsePatch(section.text);
  }
}
