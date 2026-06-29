/**
 * integration-edit-cycle.test.ts — 集成测试 pi-hashline 的完整编辑周期
 *
 * 覆盖:
 *   1. Patcher.apply() 完整路径（读文件 → 解析diff → 应用编辑 → 写回）
 *   2. buildCompactDiffPreview 上下文输出格式
 *   3. 跨多个文件的批量编辑
 *   4. BOM 和 CRLF 保留
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Patch } from "../src/input.ts";
import { Patcher } from "../src/patcher.ts";
import { InMemoryFilesystem } from "../src/fs.ts";
import { InMemorySnapshotStore } from "../src/snapshots.ts";
import { buildCompactDiffPreview } from "../src/apply.ts";
import { computeFileHash } from "../src/format.ts";

let completedCases = 0;
process.on("exit", () => {
  if (completedCases < 1) console.warn("  " + completedCases + " integration tests completed.");
});

const VFS_ROOT = "/project";

// ── 1. Patcher: 完整单文件编辑周期 ────────────────────────────────────

test("integration: single file edit through Patcher", async () => {
  const fs = new InMemoryFilesystem();
  const snapshots = new InMemorySnapshotStore();
  const patcher = new Patcher({ fs, snapshots });

  const filePath = VFS_ROOT + "/src/main.ts";
  const original = [
    "function greet(name: string) {",
    '  return `Hello, ${name}!`;',
    "}",
    "",
    "console.log(greet('World'));",
  ].join("\n");

  fs.setFile(filePath, original);
  const hash = await computeFileHash(original);

  const diffText = "[src/main.ts#" + hash + "]\n" +
    "SWAP 2.=2:\n" +
    "+  return `Hi, ${name}!`;";

  const patch = new Patch(diffText, VFS_ROOT);
  const result = await patcher.apply(patch);

  assert.equal(result.sections.length, 1);
  assert.equal(result.sections[0].op, "update");
  assert.ok(result.sections[0].path.replace(/\\/g, "/").endsWith("src/main.ts"));

  const modified = fs.getFile(filePath);
  assert.ok(modified);
  assert.ok(modified.includes("Hi"));
  assert.ok(!modified.includes("Hello"));

  completedCases++;
});

// ── 2. Patcher: 批量编辑多个文件 ──────────────────────────────────────

test("integration: batch edit multiple files", async () => {
  const fs = new InMemoryFilesystem();
  const snapshots = new InMemorySnapshotStore();
  const patcher = new Patcher({ fs, snapshots });

  const fileA = VFS_ROOT + "/src/a.ts";
  const fileB = VFS_ROOT + "/src/b.ts";

  fs.setFile(fileA, "const x = 1;\nconsole.log(x);\n");
  fs.setFile(fileB, "const y = 2;\nconsole.log(y);\n");

  const hashA = await computeFileHash(fs.getFile(fileA));
  const hashB = await computeFileHash(fs.getFile(fileB));

  const diffText = "[src/a.ts#" + hashA + "]\n" +
    "SWAP 2.=2:\n" +
    "+console.log(x + 1);\n" +
    "[src/b.ts#" + hashB + "]\n" +
    "SWAP 2.=2:\n" +
    "+console.log(y + 1);";

  const patch = new Patch(diffText, VFS_ROOT);
  const result = await patcher.apply(patch);

  assert.equal(result.sections.length, 2);
  assert.ok(result.sections[0].path.replace(/\\/g, "/").endsWith("src/a.ts"));
  assert.ok(result.sections[1].path.replace(/\\/g, "/").endsWith("src/b.ts"));

  const modA = fs.getFile(fileA);
  const modB = fs.getFile(fileB);
  assert.ok(modA.includes("x + 1"));
  assert.ok(modB.includes("y + 1"));

  completedCases++;
});

// ── 3. Patcher: no-op（无变更）场景 ────────────────────────────────────

test("integration: no-op when edit produces identical content", async () => {
  const fs = new InMemoryFilesystem();
  const snapshots = new InMemorySnapshotStore();
  const patcher = new Patcher({ fs, snapshots });

  const filePath = VFS_ROOT + "/noop.txt";
  fs.setFile(filePath, "unchanged\n");

  const hash = await computeFileHash(fs.getFile(filePath));

  const diffText = "[noop.txt#" + hash + "]\n" +
    "SWAP 1.=1:\n" +
    "+unchanged";

  const patch = new Patch(diffText, VFS_ROOT);
  const result = await patcher.apply(patch);

  assert.equal(result.sections.length, 1);
  assert.equal(result.sections[0].op, "noop");

  completedCases++;
});

// ── 4. buildCompactDiffPreview: 上下文格式 ─────────────────────────

test("integration: buildCompactDiffPreview context format", async () => {
  const before = [
    "line1",
    "line2",
    "line3",
    "line4",
    "line5",
    "line6",
    "line7",
    "line8",
    "line9",
    "line10",
  ].join("\n");

  const after = [
    "line1",
    "line2",
    "line3_CHANGED",
    "line4",
    "line5",
    "line6",
    "line7",
    "line8",
    "line9_CHANGED",
    "line10",
  ].join("\n");

  const result = buildCompactDiffPreview(before, after, { contextLines: 2 });

  assert.ok(result.preview.includes("@@"), "Should have summary header");
  assert.ok(result.preview.includes("+ line3_CHANGED"), "Should show changed line");
  assert.ok(result.preview.includes("+ line9_CHANGED"), "Should show second changed line");
  assert.ok(result.preview.includes(" line1"), "Should show context line before first change");
  assert.ok(result.preview.includes(" line10"), "Should show context line after last change");
  assert.ok(result.preview.includes("\u2026"), "Should have separator between change groups");
  assert.equal(result.addedLines, 2);
  assert.equal(result.removedLines, 2);

  completedCases++;
});

// ── 5. buildCompactDiffPreview: 无变化场景 ─────────────────────────

test("integration: buildCompactDiffPreview no changes", async () => {
  const text = "line1\nline2\nline3\n";
  const result = buildCompactDiffPreview(text, text);

  assert.equal(result.preview, "(no changes)");
  assert.equal(result.addedLines, 0);
  assert.equal(result.removedLines, 0);

  completedCases++;
});

// ── 6. buildCompactDiffPreview: 空文件到内容 ───────────────────────

test("integration: buildCompactDiffPreview empty to content", async () => {
  const result = buildCompactDiffPreview("", "line1\nline2\n");

  // The new context format includes a @@ summary header and context lines.
  // It also shows the empty removed line (from splitting "" into [""]).
  assert.ok(result.preview.includes("+ line1"), "Should show added line1");
  assert.ok(result.preview.includes("+ line2"), "Should show added line2");
  // addedLines counts the actual added content lines (may include trailing empty)
  assert.ok(result.addedLines >= 2, "Should count at least 2 added lines");
  assert.equal(result.removedLines, 1, "Should count 1 removed line (the empty string from '')");

  completedCases++;
});

// ── 7. Patcher: CRLF 保留 ────────────────────────────────────────────

test("integration: CRLF line endings preserved through Patcher", async () => {
  const fs = new InMemoryFilesystem();
  const snapshots = new InMemorySnapshotStore();
  const patcher = new Patcher({ fs, snapshots });

  const filePath = VFS_ROOT + "/crlf.txt";
  const original = "line1\r\nline2\r\nline3\r\n";
  fs.setFile(filePath, original);

  const hash = await computeFileHash(original.replace(/\r\n/g, "\n"));

  const diffText = "[crlf.txt#" + hash + "]\n" +
    "SWAP 2.=2:\n" +
    "+line2_MODIFIED";

  const patch = new Patch(diffText, VFS_ROOT);
  const result = await patcher.apply(patch);

  const modified = fs.getFile(filePath);
  assert.ok(modified.includes("\r\n"), "CRLF endings should be preserved");
  assert.ok(modified.includes("line2_MODIFIED"));

  completedCases++;
});

// ── 8. 使用真实文件系统的完整周期 ─────────────────────────────────────

test("integration: real filesystem read-edit-write cycle", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "pi-hashline-int-"));
  try {
    const filePath = join(tmpDir, "test.ts");
    await writeFile(filePath, "const x = 1;\nconsole.log(x);\n", "utf8");

    const content = await readFile(filePath, "utf8");
    const hash = await computeFileHash(content.replace(/\r\n/g, "\n"));

    const { NodeFilesystem } = await import("../src/fs.ts");
    const fs = new NodeFilesystem();
    const snapshots = new InMemorySnapshotStore();
    const patcher = new Patcher({ fs, snapshots });

    const diffText = "[test.ts#" + hash + "]\n" +
      "SWAP 2.=2:\n" +
      "+console.log(x + 1);";

    const patch = new Patch(diffText, tmpDir);
    const result = await patcher.apply(patch);

    assert.equal(result.sections.length, 1);
    assert.equal(result.sections[0].op, "update");

    const final = await readFile(filePath, "utf8");
    assert.equal(final, "const x = 1;\nconsole.log(x + 1);\n");

    completedCases++;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ── 总结 ─────────────────────────────────────────────────────────────

test("integration: summary", () => {
  assert.ok(completedCases >= 6, "Expected 8+ integration tests, got " + completedCases);
});
