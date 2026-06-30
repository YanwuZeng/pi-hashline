/**
 * robustness.test.ts — covers the P0-P6 hardening of pi-hashline.
 *
 *   P0  edit.ts live path via Patcher (single, multi-file, SWAP.BLK, mismatch)
 *   P2  brace block resolver (function, nested, inside-block, regex, template)
 *   P3  Patcher all-or-nothing (a failing section aborts the whole batch)
 *   P4  noop-loop guard (reset on mutation, hard-fail at limit)
 *   P5  recovery version-chain walk (replay onto a middle snapshot)
 *   P6  self-healing apply (drop duplicated trailing closer)
 *   —   HEAD/TAIL drift: stale tag + head/tail insert applies with a warning
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { applyEdits } from "../src/apply.ts";
import { findBraceBlock, createBraceBlockResolver } from "../src/block-resolver.ts";
import { NoopLoopGuard, payloadKeyHash, NoopLoopError } from "../src/noop-loop-guard.ts";
import { Patch } from "../src/input.ts";
import { Patcher } from "../src/patcher.ts";
import { NodeFilesystem, InMemoryFilesystem } from "../src/fs.ts";
import { InMemorySnapshotStore } from "../src/snapshots.ts";
import { recover } from "../src/recovery.ts";
import { parsePatch } from "../src/parser.ts";
import { computeFileHash } from "../src/format.ts";
import { registerEditTool } from "../src/edit.ts";
import { snapshotStore } from "../src/read.ts";

// ── P2: brace block resolver ───────────────────────────────────────────────

test("P2: brace resolver finds a function block", () => {
  const text = "function foo() {\n  return 1;\n}\n";
  assert.deepEqual(findBraceBlock(text, 1), { start: 1, end: 3 });
});

test("P2: brace resolver returns null when anchor is inside a block", () => {
  const text = "function foo() {\n  return 1;\n}\n";
  assert.equal(findBraceBlock(text, 2), null);
});

test("P2: brace resolver reports a single-line block as start==end", () => {
  const text = "const f = () => { return 1; };\n";
  assert.deepEqual(findBraceBlock(text, 1), { start: 1, end: 1 });
});

test("P2: brace resolver skips braces inside a regex literal", () => {
  const text = "function f() {\n  return /a{2}/;\n}\n";
  assert.deepEqual(findBraceBlock(text, 1), { start: 1, end: 3 });
});

test("P2: brace resolver skips braces inside a template literal", () => {
  const text = "function f() {\n  const s = `${x}`;\n}\n";
  assert.deepEqual(findBraceBlock(text, 1), { start: 1, end: 3 });
});

test("P2: brace resolver treats / after an identifier as division, not regex", () => {
  // `a / b` — the `/` is division; no extra brace is introduced.
  const text = "function f() {\n  return a / b;\n}\n";
  assert.deepEqual(findBraceBlock(text, 1), { start: 1, end: 3 });
});

test("P2: brace resolver handles a nested function (matches the outer opener)", () => {
  const text = "function outer() {\n  function inner() {\n    return 1;\n  }\n}\n";
  assert.deepEqual(findBraceBlock(text, 1), { start: 1, end: 5 });
});

test("P2: brace resolver handles a Java-style class/method", () => {
  const text = "public class Foo {\n  public void bar() {\n    System.out.println(1);\n  }\n}\n";
  assert.deepEqual(findBraceBlock(text, 1), { start: 1, end: 5 });
});

test("P2: brace resolver skips braces in a block comment", () => {
  const text = "function f() {\n  /* { } */\n  return 1;\n}\n";
  assert.deepEqual(findBraceBlock(text, 1), { start: 1, end: 4 });
});

test("P2: createBraceBlockResolver wires through BlockResolver shape", () => {
  const resolver = createBraceBlockResolver();
  const text = "function f() {\n  return 1;\n}\n";
  assert.deepEqual(resolver({ path: "f.ts", text, line: 1 }), { start: 1, end: 3 });
  assert.equal(resolver({ path: "f.ts", text, line: 9 }), null);
});

// ── P2: SWAP.BLK end-to-end through Patcher ─────────────────────────────────

test("P2: SWAP.BLK replaces a whole function via Patcher", async () => {
  const fs = new InMemoryFilesystem();
  const snapshots = new InMemorySnapshotStore();
  const patcher = new Patcher({ fs, snapshots, blockResolver: createBraceBlockResolver() });
  const file = "/p/a.ts";
  const original = "function foo() {\n  return 1;\n}\nconst x = 2;\n";
  fs.setFile(file, original);
  const hash = await computeFileHash(original);
  const diff = `[a.ts#${hash}]\nSWAP.BLK 1:\n+REPLACED`;
  const result = await patcher.apply(new Patch(diff, "/p"));
  assert.equal(result.sections.length, 1);
  assert.equal(result.sections[0].op, "update");
  const after = fs.getFile(file);
  assert.equal(after, "REPLACED\nconst x = 2;\n");
});

// ── P4: noop-loop guard ─────────────────────────────────────────────────────

test("P4: noop guard resets on a real mutation", () => {
  const guard = new NoopLoopGuard(3);
  const key = "p::k";
  guard.observe(key, true); // count 1
  guard.observe(key, true); // count 2
  guard.observe(key, false); // mutation -> reset
  guard.observe(key, true); // count 1 again
  // no throw expected
  assert.ok(true);
});

test("P4: noop guard throws NoopLoopError at the limit", () => {
  const guard = new NoopLoopGuard(3);
  const key = "p::k";
  guard.observe(key, true);
  guard.observe(key, true);
  assert.throws(() => guard.observe(key, true), (e: unknown) => e instanceof NoopLoopError);
});

test("P4: noop guard keys are independent per payload", () => {
  const guard = new NoopLoopGuard(3);
  guard.observe("p::a", true);
  guard.observe("p::a", true);
  // Different payload resets nothing for a, but b is independent
  guard.observe("p::b", true);
  assert.equal(payloadKeyHash("x") === payloadKeyHash("x"), true);
  assert.equal(payloadKeyHash("x") === payloadKeyHash("y"), false);
});

// ── P5: recovery version-chain walk ─────────────────────────────────────────

test("P5: recovery walks historical versions and replays onto a middle snapshot", async () => {
  const store = new InMemorySnapshotStore();
  const path = "/p/f.txt";
  // Six lines so the structuredPatch context window (3) around the edited line
  // does not include the line that differs between versions.
  const v0 = "X\np\nq\nr\ns\nt\n"; // line 1 = X (tagged base)
  const v1 = "Y\np\nq\nr\ns\nt\n"; // line 1 = Y (middle snapshot)
  const v2 = "Y\np\nq\nr\ns\nT\n"; // live: line 1 = Y, line 6 = T
  await store.record(path, v0);
  await store.record(path, v1);
  const h0 = await computeFileHash(v0);

  const { edits } = parsePatch(`[f.txt#${h0}]\nSWAP 1.=1:\n+Z`);
  const result = recover(store, { path, currentText: v2, fileHash: h0, edits });
  assert.ok(result, "expected recovery to succeed via the v1 snapshot");
  assert.equal(result!.text, "Z\np\nq\nr\ns\nT\n");
});

test("P5: recovery returns null when no historical version merges cleanly", async () => {
  const store = new InMemorySnapshotStore();
  const path = "/p/f.txt";
  const v0 = "X\np\nq\n";
  await store.record(path, v0);
  const h0 = await computeFileHash(v0);
  const { edits } = parsePatch(`[f.txt#${h0}]\nSWAP 1.=1:\n+Z`);
  // Live line 1 is neither X nor anything the edit context can match.
  const result = recover(store, { path, currentText: "W\nr\ns\n", fileHash: h0, edits });
  assert.equal(result, null);
});

// ── P3: Patcher all-or-nothing ──────────────────────────────────────────────

test("P3: a failing section aborts the whole batch (no file is written)", async () => {
  // Use real paths so the snapshot store key (raw path) matches the path the
  // Patcher looks up (path.resolve(cwd, name)).
  const fs = new InMemoryFilesystem();
  const snapshots = new InMemorySnapshotStore();
  const patcher = new Patcher({ fs, snapshots });

  const cwd = "/proj";
  const aAbs = resolve(cwd, "a.txt");
  const bAbs = resolve(cwd, "b.txt");
  const aContent = "a1\na2\n";
  const bContent = "b1\nb2\n";
  fs.setFile(aAbs, aContent);
  fs.setFile(bAbs, bContent);

  // Record a with only line 1 seen (line 2 unseen), b fully seen.
  const hA = await snapshots.record(aAbs, aContent, [1]);
  const hB = await snapshots.record(bAbs, bContent, [1, 2]);

  // Section a targets unseen line 2 -> prepare throws. Section b is valid.
  const diff = `[a.txt#${hA}]\nSWAP 2.=2:\n+A2\n[b.txt#${hB}]\nSWAP 1.=1:\n+B1`;
  await assert.rejects(() => patcher.apply(new Patch(diff, cwd)));

  // All-or-nothing: neither file changed.
  assert.equal(fs.getFile(aAbs), aContent);
  assert.equal(fs.getFile(bAbs), bContent);
});

// ── HEAD/TAIL drift ──────────────────────────────────────────────────────────

test("HEAD/TAIL drift: stale tag + INS.HEAD applies with a warning", async () => {
  const fs = new InMemoryFilesystem();
  const snapshots = new InMemorySnapshotStore();
  const patcher = new Patcher({ fs, snapshots });
  const file = "/p/d.txt";
  const original = "a\nb\n";
  fs.setFile(file, original);
  const h = await snapshots.record(file, original, [1, 2]);

  // Drift the file so the live hash no longer matches the tag.
  fs.setFile(file, "a\nb\nc\n");

  const diff = `[d.txt#${h}]\nINS.HEAD:\n+TOP`;
  const result = await patcher.apply(new Patch(diff, "/p"));
  assert.equal(result.sections[0].op, "update");
  assert.equal(fs.getFile(file), "TOP\na\nb\nc\n");
  assert.ok(
    result.sections[0].warnings.some((w) => w.includes("stale snapshot tag")),
    `expected HEADTAIL drift warning, got: ${JSON.stringify(result.sections[0].warnings)}`,
  );
});

// ── P6: self-healing apply ──────────────────────────────────────────────────

test("P6: duplicated trailing closer is dropped with a warning", () => {
  // Range is line 2 (`  return 1;`). The line AFTER the range is line 3 (`}`,
  // the function's own closer). The body restates it as its last row.
  const before = "function f() {\n  return 1;\n}\n";
  const { edits } = parsePatch("[f.ts#AAAA]\nSWAP 2.=2:\n+  return 2;\n+}");
  const result = applyEdits(before, edits);
  assert.equal(result.text, "function f() {\n  return 2;\n}\n");
  assert.ok(result.warnings?.some((w) => w.includes("dropped a trailing body row")));
});

test("P6: differently-indented closer is NOT dropped", () => {
  // Body's `  }` (2-space) != after-line `}` (0-space) -> no repair.
  const before = "function f() {\n  return 1;\n  }\nconst x = 2;\n";
  const { edits } = parsePatch("[f.ts#AAAA]\nSWAP 2.=3:\n+  return 2;\n+  }");
  const result = applyEdits(before, edits);
  assert.equal(result.text, "function f() {\n  return 2;\n  }\nconst x = 2;\n");
  assert.ok(!result.warnings || result.warnings.length === 0);
});

test("P6: non-closer duplicate is NOT dropped", () => {
  // after-line is `const x = 2;` (not a structural closer) -> no repair.
  const before = "a\nb\nc\nd\n";
  const { edits } = parsePatch("[f.txt#AAAA]\nSWAP 2.=3:\n+B\n+C");
  const result = applyEdits(before, edits);
  assert.equal(result.text, "a\nB\nC\nd\n");
  assert.ok(!result.warnings || result.warnings.length === 0);
});

// ── P0: live edit tool end-to-end ───────────────────────────────────────────

function captureEditTool(): any {
  let captured: any = null;
  const pi: any = {
    registerTool(tool: any) { captured = tool; },
    registerCommand() {},
  };
  registerEditTool(pi);
  if (!captured) throw new Error("edit tool was not registered");
  return captured;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-hashline-live-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("P0: live edit tool applies a single-file SWAP", async () => {
  await withTempDir(async (dir) => {
    snapshotStore.clear();
    const file = join(dir, "a.ts");
    const content = "const x = 1;\nconsole.log(x);\n";
    await writeFile(file, content, "utf8");
    const hash = await computeFileHash(content);
    const tool = captureEditTool();
    const args = tool.prepareArguments({ diff: `[a.ts#${hash}]\nSWAP 2.=2:\n+console.log(x + 1);` });
    const result = await tool.execute("id", args, undefined, undefined, { cwd: dir });
    assert.equal(result.details.sections, 1);
    assert.equal(result.details.fileHash, await computeFileHash("const x = 1;\nconsole.log(x + 1);\n"));
    assert.equal(await readFile(file, "utf8"), "const x = 1;\nconsole.log(x + 1);\n");
    assert.ok(typeof result.details.displayDiff === "string");
  });
});

test("P0: live edit tool applies a multi-file diff (B2 regression)", async () => {
  await withTempDir(async (dir) => {
    snapshotStore.clear();
    const fileA = join(dir, "a.ts");
    const fileB = join(dir, "b.ts");
    await writeFile(fileA, "const x = 1;\nconsole.log(x);\n", "utf8");
    await writeFile(fileB, "const y = 2;\nconsole.log(y);\n", "utf8");
    const hA = await computeFileHash("const x = 1;\nconsole.log(x);\n");
    const hB = await computeFileHash("const y = 2;\nconsole.log(y);\n");
    const tool = captureEditTool();
    const diff = `[a.ts#${hA}]\nSWAP 2.=2:\n+console.log(x + 1);\n[b.ts#${hB}]\nSWAP 2.=2:\n+console.log(y + 1);`;
    const args = tool.prepareArguments({ diff });
    const result = await tool.execute("id", args, undefined, undefined, { cwd: dir });
    assert.equal(result.details.sections, 2);
    assert.equal(await readFile(fileA, "utf8"), "const x = 1;\nconsole.log(x + 1);\n");
    assert.equal(await readFile(fileB, "utf8"), "const y = 2;\nconsole.log(y + 1);\n");
  });
});

test("P0: live edit tool SWAP.BLK replaces a whole function", async () => {
  await withTempDir(async (dir) => {
    snapshotStore.clear();
    const file = join(dir, "fn.ts");
    const content = "function foo() {\n  return 1;\n}\nconst x = 2;\n";
    await writeFile(file, content, "utf8");
    const hash = await computeFileHash(content);
    const tool = captureEditTool();
    const args = tool.prepareArguments({ diff: `[fn.ts#${hash}]\nSWAP.BLK 1:\n+REPLACED` });
    await tool.execute("id", args, undefined, undefined, { cwd: dir });
    assert.equal(await readFile(file, "utf8"), "REPLACED\nconst x = 2;\n");
  });
});

test("P0: live edit tool reports a no-op without changing the file", async () => {
  await withTempDir(async (dir) => {
    snapshotStore.clear();
    const file = join(dir, "n.txt");
    const content = "unchanged\n";
    await writeFile(file, content, "utf8");
    const hash = await computeFileHash(content);
    const tool = captureEditTool();
    const args = tool.prepareArguments({ diff: `[n.txt#${hash}]\nSWAP 1.=1:\n+unchanged` });
    const result = await tool.execute("id", args, undefined, undefined, { cwd: dir });
    assert.match(result.content[0].text, /No changes/);
    assert.equal(await readFile(file, "utf8"), content);
  });
});

test("P0: live edit tool rejects a stale tag with a mismatch error", async () => {
  await withTempDir(async (dir) => {
    snapshotStore.clear();
    const file = join(dir, "s.txt");
    await writeFile(file, "a\nb\n", "utf8");
    const staleHash = "0000"; // never matches live content
    const tool = captureEditTool();
    const args = tool.prepareArguments({ diff: `[s.txt#${staleHash}]\nSWAP 1.=1:\n+A` });
    await assert.rejects(
      () => tool.execute("id", args, undefined, undefined, { cwd: dir }),
      (e: unknown) => e instanceof Error && /Hash mismatch/.test(e.message),
    );
    // File untouched.
    assert.equal(await readFile(file, "utf8"), "a\nb\n");
  });
});

test("P0: live edit tool supports a `path` override when the diff has no header", async () => {
  await withTempDir(async (dir) => {
    snapshotStore.clear();
    const file = join(dir, "h.txt");
    const content = "a\nb\n";
    await writeFile(file, content, "utf8");
    const hash = await computeFileHash(content);
    const tool = captureEditTool();
    // No header in diff, but path is supplied. Synthesize [path#hash] would need
    // a tag; without one only head/tail inserts are allowed. Use INS.HEAD.
    const args = tool.prepareArguments({ path: "h.txt", diff: `INS.HEAD:\n+TOP` });
    const result = await tool.execute("id", args, undefined, undefined, { cwd: dir });
    assert.equal(await readFile(file, "utf8"), "TOP\na\nb\n");
    assert.equal(result.details.sections, 1);
  });
});

// ── NodeFilesystem sanity (used by the live tool) ───────────────────────────

test("NodeFilesystem round-trips a temp file", async () => {
  await withTempDir(async (dir) => {
    const fs = new NodeFilesystem();
    const file = join(dir, "rw.txt");
    await fs.writeText(file, "hello\n");
    assert.equal(await fs.readText(file), "hello\n");
  });
});
