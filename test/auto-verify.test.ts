/**
 * auto-verify.test.ts — 使用 hashline DSL 自动验证所有手动测试场景
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import test from "node:test";
import { parsePatch } from "../src/parser.ts";
import { applyEdits, buildCompactDiffPreview } from "../src/apply.ts";
import { computeFileHash, formatHashlineHeader, formatNumberedLine } from "../src/format.ts";
import { normalizeToLF, detectLineEnding, stripBom } from "../src/normalize.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

const scenariosRoot = join(import.meta.dirname ?? __dirname, "manual-tests");

interface Scenario {
  name: string;
  sourceFile: string;  // relative to scenario dir
  expectedFile: string;
  /** Build hashline diff text given the file path and tag */
  buildDiff: (hash: string) => string;
}

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.filter(c => c.type === "text").map(c => c.text ?? "").join("\n");
}

function parseReadOutput(output: string): { header: string; path: string; hash: string; lines: Array<{ lineNo: number; text: string }> } {
  const lines = output.split("\n");
  const header = lines[0];
  const headerMatch = header.match(/^\[([^#]+)#([0-9A-F]{4})\]$/);
  if (!headerMatch) throw new Error(`Invalid read output header: ${header}`);
  
  const contentLines: Array<{ lineNo: number; text: string }> = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("[")) continue; // skip continuation hint
    const m = line.match(/^(\d+):(.*)/);
    if (m) contentLines.push({ lineNo: Number(m[1]), text: m[2] });
  }
  
  return { header, path: headerMatch[1], hash: headerMatch[2], lines: contentLines };
}

async function applyHashlineDiff(filePath: string, diffText: string): Promise<string> {
  // Parse
  const { edits, warnings } = parsePatch(diffText);
  
  // Read file
  const content = await readFile(filePath, "utf8");
  const { bom, text: bomStripped } = stripBom(content);
  const eol = detectLineEnding(bomStripped);
  const normalized = normalizeToLF(bomStripped);
  
  // Apply
  const result = applyEdits(normalized, edits);
  
  // Write back with original BOM and EOL
  const { restoreLineEndings } = await import("../src/normalize.ts");
  const persisted = bom + restoreLineEndings(result.text, eol);
  await writeFile(filePath, persisted, "utf8");
  
  return result.text;
}

let completedCases = 0;
process.on("exit", () => {
  if (completedCases < 1) console.warn(`⚠  ${completedCases} scenarios verified.`);
});

// ── Scenario definitions ───────────────────────────────────────────────────

const scenarios: Scenario[] = [
  {
    name: "01-rename-variable",
    sourceFile: "source.ts",
    expectedFile: "expected.ts",
    buildDiff: (hash) => `[01-rename-variable/source.ts#${hash}]
SWAP 2.=2:
+  console.log("Hello, " + userName);`,
  },
  {
    name: "02-change-config",
    sourceFile: "source.json",
    expectedFile: "expected.json",
    buildDiff: (hash) => `[02-change-config/source.json#${hash}]
SWAP 2.=2:
+  "debug": true,`,
  },
  {
    name: "03-add-field",
    sourceFile: "source.ts",
    expectedFile: "expected.ts",
    buildDiff: (hash) => `[03-add-field/source.ts#${hash}]
INS.POST 2:
+  email: 'user@example.com',`,
  },
  {
    name: "04-delete-method",
    sourceFile: "source.ts",
    expectedFile: "expected.ts",
    buildDiff: (hash) => `[04-delete-method/source.ts#${hash}]
DEL 4`,
  },
  {
    name: "05-multi-edit",
    sourceFile: "source.json",
    expectedFile: "expected.json",
    buildDiff: (hash) => `[05-multi-edit/source.json#${hash}]
SWAP 3.=3:
+  "version": "2.0.0",
SWAP 4.=4:
+  "author": "team"`,
  },
  {
    name: "06-crlf-typo",
    sourceFile: "source.ini",
    expectedFile: "expected.ini",
    buildDiff: (hash) => `[06-crlf-typo/source.ini#${hash}]
SWAP 3.=3:
+debug=false`,
  },
  {
    name: "07-insert-before",
    sourceFile: "source.ts",
    expectedFile: "expected.ts",
    buildDiff: (hash) => `[07-insert-before/source.ts#${hash}]
INS.PRE 1:
+import { something } from "./util";`,
  },
  {
    name: "08-multiline-replace",
    sourceFile: "source.ts",
    expectedFile: "expected.ts",
    buildDiff: (hash) => `[08-multiline-replace/source.ts#${hash}]
SWAP 2.=2:
+  const result = a + b;
+  return result;`,
  },
  {
    name: "09-hash-mismatch",
    sourceFile: "source.txt",
    expectedFile: "expected.txt",
    buildDiff: (hash) => `[09-hash-mismatch/source.txt#${hash}]
SWAP 1.=1:
+modified`,
  },
  {
    name: "10-partial-read",
    sourceFile: "source.txt",
    expectedFile: "expected.txt",
    buildDiff: (hash) => `[10-partial-read/source.txt#${hash}]
SWAP 7.=7:
+CHANGED`,
  },
  {
    name: "11-dry-run",
    sourceFile: "source.tsx",
    expectedFile: "expected.tsx",
    buildDiff: (hash) => `[11-dry-run/source.tsx#${hash}]
SWAP 2.=2:
+  return <button className="btn">{label}</button>;`,
  },
  {
    name: "12-reread-cycle",
    sourceFile: "source.txt",
    expectedFile: "expected.txt",
    buildDiff: (hash) => `[12-reread-cycle/source.txt#${hash}]
SWAP 2.=2:
+MODIFIED`,
  },
  {
    name: "13-crlf-mixed",
    sourceFile: "source.txt",
    expectedFile: "expected.txt",
    buildDiff: (hash) => `[13-crlf-mixed/source.txt#${hash}]
SWAP 2.=2:
+B`,
  },
];

// ── Test runner ────────────────────────────────────────────────────────────

for (const scenario of scenarios) {
  test(`manual: ${scenario.name}`, async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), `verify-${scenario.name}-`));
    try {
      const scenarioDir = join(scenariosRoot, scenario.name);
      await cp(scenarioDir, tmpDir, { recursive: true, force: true });
      
      const sourcePath = join(tmpDir, scenario.sourceFile);
      const expectedPath = join(scenarioDir, scenario.expectedFile);
      
      // Compute file hash
      const content = await readFile(sourcePath, "utf8");
      const normalized = normalizeToLF(content);
      const hash = await computeFileHash(normalized);
      
      // Build and apply hashline diff
      const diffText = scenario.buildDiff(hash);
      await applyHashlineDiff(sourcePath, diffText);
      
      // Compare with expected
      const actual = await readFile(sourcePath, "utf8");
      const expected = await readFile(expectedPath, "utf8");
      assert.equal(actual, expected, `Scenario "${scenario.name}" mismatch`);
      
      completedCases++;
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
}
