import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parsePatch } from "../src/parser.ts";
import { applyEdits } from "../src/apply.ts";
import { computeFileHash, formatHashlineHeader, formatNumberedLines, formatNumberedLine } from "../src/format.ts";
import { normalizeToLF, detectLineEnding, stripBom } from "../src/normalize.ts";

let completedCases = 0;
process.on("exit", () => {
  if (completedCases < 1) console.warn(`⚠  ${completedCases} smoke tests completed.`);
});

// ── Test 1: Parser + Apply: SWAP single line ──
test("hashline smoke: SWAP single line (patch)", async () => {
  const original = "function greet() {\n  console.log(\"Hello, \" + oldName);\n}\n";
  const hash = await computeFileHash(original);

  const diff = `[greet.ts#${hash}]\nSWAP 2.=2:\n+  console.log("Hello, " + userName);`;
  const { edits, warnings } = parsePatch(diff);
  assert.equal(edits.length, 2); // 1 insert + 1 delete
  const result = applyEdits(original, edits);
  const expected = "function greet() {\n  console.log(\"Hello, \" + userName);\n}\n";
  assert.equal(result.text, expected);
  completedCases++;
});

// ── Test 2: Parser + Apply: SWAP multi-line replace ──
test("hashline smoke: SWAP multi-line replace", async () => {
  const original = "function add(a, b) {\n  // TODO\n}\n";
  const hash = await computeFileHash(original);

  const diff = `[math.ts#${hash}]\nSWAP 2.=2:\n+  const result = a + b;\n+  return result;`;
  const { edits } = parsePatch(diff);
  const result = applyEdits(original, edits);
  assert.match(result.text, /const result = a \+ b;/);
  assert.match(result.text, /return result;/);
  assert.doesNotMatch(result.text, /TODO/);
  completedCases++;
});

// ── Test 3: Parser + Apply: DEL single line ──
test("hashline smoke: DEL single line", async () => {
  const original = "keep\nremove\nkeep\n";
  const hash = await computeFileHash(original);

  const diff = `[file.txt#${hash}]\nDEL 2`;
  const { edits } = parsePatch(diff);
  const result = applyEdits(original, edits);
  assert.equal(result.text, "keep\nkeep\n");
  completedCases++;
});

// ── Test 4: Parser + Apply: INS.PRE before a line ──
test("hashline smoke: INS.PRE insert before", async () => {
  const original = "second\nthird\n";
  const hash = await computeFileHash(original);

  const diff = `[file.txt#${hash}]\nINS.PRE 1:\n+first`;
  const { edits } = parsePatch(diff);
  const result = applyEdits(original, edits);
  assert.equal(result.text, "first\nsecond\nthird\n");
  completedCases++;
});

// ── Test 5: Parser + Apply: INS.POST after a line ──
test("hashline smoke: INS.POST insert after", async () => {
  const original = "first\nsecond\n";
  const hash = await computeFileHash(original);

  const diff = `[file.txt#${hash}]\nINS.POST 1:\n+mid`;
  const { edits } = parsePatch(diff);
  const result = applyEdits(original, edits);
  assert.equal(result.text, "first\nmid\nsecond\n");
  completedCases++;
});

// ── Test 6: Parser + Apply: INS.HEAD and INS.TAIL ──
test("hashline smoke: INS.HEAD and INS.TAIL", async () => {
  const original = "middle\n";
  const hash = await computeFileHash(original);

  const diff = `[file.txt#${hash}]\nINS.HEAD:\n+header\nINS.TAIL:\n+footer`;
  const { edits } = parsePatch(diff);
  const result = applyEdits(original, edits);
  assert.equal(result.text, "header\nmiddle\nfooter\n");
  completedCases++;
});

// ── Test 7: File hash round-trip ──
test("hashline smoke: computeFileHash round-trip", async () => {
  const text = "hello\nworld\n";
  const hash1 = await computeFileHash(text);
  const hash2 = await computeFileHash(text);
  assert.equal(hash1, hash2);
  assert.match(hash1, /^[0-9A-F]{4}$/);

  const different = "hello\nworld! \n";
  const hash3 = await computeFileHash(different);
  assert.notEqual(hash1, hash3);
  completedCases++;
});

// ── Test 8: normalize utils ──
test("hashline smoke: normalize helpers", () => {
  assert.equal(normalizeToLF("a\r\nb\r\nc\n"), "a\nb\nc\n");
  assert.equal(detectLineEnding("a\r\nb\n"), "\r\n");
  assert.equal(stripBom("\uFEFFabc").text, "abc");
  assert.equal(stripBom("\uFEFFabc").bom, "\uFEFF");
  completedCases++;
});

// ── Test 9: format helpers ──
test("hashline smoke: format helpers", () => {
  const hash = "1A2B";
  const formatted = formatHashlineHeader("test.ts", hash);
  assert.equal(formatted, "[test.ts#1A2B]");
  assert.equal(formatNumberedLine(5, "hello"), "5:hello");
  assert.match(formatNumberedLines("a\nb", 1), /^1:a\n2:b$/);
  completedCases++;
});

// ── Test 10: End-to-end file read/write via tools ──
test("hashline smoke: read + edit cycle on real file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hashline-smoke-"));
  try {
    const filePath = join(dir, "test.ts");
    await writeFile(filePath, "const x = 1;\nconsole.log(x);\n", "utf8");

    // Read via fs to get hash
    const content = await readFile(filePath, "utf8");
    const hash = await computeFileHash(content);
    assert.match(hash, /^[0-9A-F]{4}$/);

    // Construct hashline diff manually
    const diff = `[test.ts#${hash}]\nSWAP 2.=2:\n+console.log(x + 1);`;

    // Parse and apply
    const { edits, warnings } = parsePatch(diff);
    const normalized = normalizeToLF(content);
    const result = applyEdits(normalized, edits);

    // Write back
    await writeFile(filePath, result.text, "utf8");
    const final = await readFile(filePath, "utf8");
    assert.equal(final, "const x = 1;\nconsole.log(x + 1);\n");

    // New hash should be different
    const newHash = await computeFileHash(final);
    assert.notEqual(newHash, hash);
    completedCases++;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
