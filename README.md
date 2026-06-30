# pi-hashline

Hashline-compatible `read`/`edit` replacement tools for [Pi](https://pi.dev/) coding agent. Imports the hashline text DSL: a compact, line-anchored patch language for safe file editing.

## Why this exists

Agentic coding often fails because context goes stale: line numbers drift, exact text snippets are duplicated, or another edit changes the file between `read` and `edit`. This package adds a lightweight optimistic-concurrency check to file edits:

1. `read` returns `[path#TAG]` + `N:content` lines (hashline format).
2. The model sends back hashline-format diff text to `edit`.
3. `edit` re-reads the file and verifies the snapshot tag still matches.
4. Any mismatch forces a fresh read, preventing silent corruption.

## Install

```bash
pi install npm:pi-hashline
```

Or install from GitHub:

```bash
pi install git:github.com/YanwuZeng/pi-hashline
```

## Read output

`read` returns every editable text line in hashline format:

```text
[src/file.ts#A1B2]
1:const value = 1;
2:function greet() {
3:  return "hello";
4:}
```

- `[src/file.ts#A1B2]` — file-section header with a 4-hex content-hash tag (`xxHash32` of the whole file).
- `1:const value = 1;` — 1-based line number + colon + content.
- Every `edit` must include the header tag for version binding.

## Edit format (hashline DSL)

Edits use a compact text DSL instead of JSON:

```text
[src/file.ts#A1B2]
SWAP 2.=2:
+  console.log("Hello, " + userName);
```

### Operations

| Op | Example | Description |
|----|---------|-------------|
| `SWAP N.=M:` | `SWAP 2.=2:` | Replace lines N through M with body rows |
| `SWAP.BLK N:` | `SWAP.BLK 1:` | Replace the whole brace-delimited block beginning on line N (TS/JS/Java/C/C++/Go/Rust/C#) |
| `DEL N.=M` | `DEL 4` | Delete lines N through M (no body) |
| `DEL.BLK N` | `DEL.BLK 1` | Delete the whole brace-delimited block beginning on line N |
| `INS.PRE N:` | `INS.PRE 1:` | Insert body rows before line N |
| `INS.POST N:` | `INS.POST 3:` | Insert body rows after line N |
| `INS.BLK.POST N:` | `INS.BLK.POST 1:` | Insert body rows after the end of the block beginning on line N |
| `INS.HEAD:` | `INS.HEAD:` | Insert body rows at file start |
| `INS.TAIL:` | `INS.TAIL:` | Insert body rows at file end |

Body rows are prefixed with `+`:

```text
[file.ts#A1B2]
SWAP 2.=3:
+  const result = a + b;
+  return result;
```

### Examples

**Single-line replace (patch):**
```text
[greet.ts#A1B2]
SWAP 2.=2:
+  console.log("Hello, " + userName);
```

**Delete a line:**
```text
[service.ts#C3D4]
DEL 4
```

**Insert before a line:**
```text
[app.ts#E5F6]
INS.PRE 1:
+import { something } from "./util";
```

**Insert after a line:**
```text
[schema.ts#G7H8]
INS.POST 2:
+  email: 'user@example.com',
```

**Multiple operations in one edit:**
```text
[package.json#I9J0]
SWAP 3.=3:
+  "version": "2.0.0",
SWAP 4.=4:
+  "author": "team"
```

## Safety rules

- Every edit must include a `[path#TAG]` header from the latest `read`.
- Numbers refer to the ORIGINAL file; never shift as hunks apply.
- Every applied edit mints a fresh `#TAG` — anchor the next edit on the response or a fresh `read`.
- Touch only lines your latest `read` literally displayed.
- On stale-tag rejection: STOP and re-read before further edits.
- One hunk per range; body = final content, never an old/new pair.
- Ranges cover ONLY lines whose content changes. Never widen over unchanged lines.
- Body rows must be `+TEXT` — never write `-old` or bare context lines.

> The `.BLK` ops resolve the syntactic block with a built-in brace-matching
> scanner (strings, template literals, comments, and regex literals are
> skipped so their braces don't corrupt the match). If a block can't be
> resolved confidently — e.g. the anchor sits inside a block rather than on
> an opener, or the language is indent-based (Python) — the edit fails with a
> clear "use a concrete line range" error instead of guessing.


## Robustness

The `edit` tool runs every patch through a single hardened pipeline:

- **All-or-nothing batches.** Multi-file diffs are prefetched in memory; if any section fails to prepare (hash mismatch, unseen lines, parse error, unresolved block), no file is written.
- **Seen-lines check.** An edit anchored on a line the model never displayed (a partial read, a folded summary, or memory) is rejected — re-read first.
- **Stale-tag recovery.** If the file drifted between `read` and `edit`, the edit is replayed against the cached snapshot and 3-way-merged onto the live file with `fuzzFactor: 0` (never slides onto a duplicate closer). Recovery failure forces a re-read.
- **HEAD/TAIL drift exemption.** `INS.HEAD:`/`INS.TAIL:` are position-stable, so a stale tag is non-fatal — they apply with a warning.
- **Self-healing apply.** A `SWAP` whose body restates the unchanged structural closer just past the range has the duplicate dropped automatically.
- **Noop-loop guard.** Repeated byte-identical no-ops on the same file/payload hard-fail after 3 attempts, breaking model fixation loops.
- **Fresh tag per edit.** Every successful edit returns a new `[path#TAG]` so the next edit re-grounds on current line numbers.

## TUI behavior

- `read` shows a 10-line preview by default; Ctrl+O expands the full result.
- Raw `read` output is capped at 400 lines or 32 KiB by default; use `offset`/`limit` to continue.
- Successful `edit` shows a colored diff in a green edit block.
- Failed `edit` shows the error message inside a red edit block.

## Command

```text
/hash-edit-status
```

Shows whether the extension is loaded and which hash length is active.

## Development

```bash
npm install
npm test
```

Project layout:

- `index.ts` registers the extension.
- `src/read.ts` — hashline-format `read` tool.
- `src/edit.ts` — hashline-DSL `edit` tool.
- `src/patcher.ts` — the hardened edit engine (prepare/commit, all-or-nothing).
- `src/input.ts` — multi-file `[path#TAG]` section splitting.
- `src/apply.ts` — line-anchored apply + self-healing boundary repair.
- `src/block-resolver.ts` — brace-matching `BlockResolver` for `.BLK` ops.
- `src/recovery.ts` — stale-tag 3-way merge recovery.
- `src/snapshots.ts` — in-memory `SnapshotStore` (content hash + seen lines).
- `src/noop-loop-guard.ts` — fixation-loop breaker.
- `src/parser.ts` — hashline text DSL parser (tokenizer + state machine).
- `src/format.ts` — hashline format constants and helpers.
- `prompts/` — tool prompt guidelines for the LLM.
- `test/` — Node test cases and manual-test scenarios.

## Acknowledgments

This project is based on [Fadouse/pi-hash-anchored-edit](https://github.com/Fadouse/pi-hash-anchored-edit) and adopts the hashline syntax from [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) (packages/hashline).



## Changelog

### 0.2.0 (2026-06-30)

**Single hardened pipeline (replaces the dual inline/library code paths).**

The live `edit` tool no longer re-implements parsing, hash validation, recovery, block resolution, apply, and snapshotting inline. It now routes every patch through the tested `Patcher` engine (`src/patcher.ts`), so the runtime path and the integration-tested path are the same code.

1. **P0 — Single pipeline via `Patcher`.** `src/edit.ts` shrank from ~200 lines of inline logic to a thin wrapper: `Patch.parse → Patcher.apply → format result`. Fixes the multi-file bug where a second `[path#TAG]` section's edits were silently applied to the first file.
2. **P1 — `read` double-record fix.** `snapshotStore.record` was called twice per read and `details.fileHash` carried a `Snapshot` object instead of the hash string. Both fixed.
3. **P2 — Working block ops.** A built-in brace-matching `BlockResolver` (`src/block-resolver.ts`, strings/template-literals/comments/regex-aware) is now wired in, so `SWAP.BLK`/`DEL.BLK`/`INS.BLK.POST` actually resolve blocks instead of always throwing. Unresolvable anchors bail to a clear "use a concrete line range" error.
4. **P3 — All-or-nothing batches.** `Patcher.apply` now prepares every section in memory before any disk write; if any section fails to prepare, no file is touched.
5. **P4 — Noop-loop guard.** `src/noop-loop-guard.ts` hard-fails after 3 consecutive byte-identical no-ops on the same file/payload, breaking model fixation loops.
6. **P5 — Recovery version-chain walk.** `recovery.recover` now iterates all historical snapshots (via `SnapshotStore.versions`) instead of fetching the same version and stopping. `fuzzFactor: 0` is preserved so a stale tag never slides a hunk onto a duplicate closer.
7. **P6 — Self-healing apply.** `applyEdits` drops a trailing body row that exactly duplicates the unchanged structural closer just past a `SWAP` range (conservative: exact match + closer only).
8. **P0 (HEAD/TAIL drift).** `INS.HEAD:`/`INS.TAIL:` now apply with a warning when the tag is stale, since head/tail positions are content-independent.
9. **P7 — Doc cleanup.** Removed the stale `test/test-scenarios.md` and `test/prompt-workflow-scenarios.md` (described the defunct `op=`/`LINE#HASH`/`dryRun` API) and rewrote `test/manual-tests/README.md` to match the current DSL and the real `auto-verify.test.ts` runner.

**New tests:** `test/robustness.test.ts` adds 28 cases covering the block resolver, noop guard, recovery walk, all-or-nothing, HEAD/TAIL drift, self-healing, and the live `edit` tool end-to-end (single-file, multi-file, `SWAP.BLK`, no-op, stale-tag mismatch, `path` override). All 71 tests pass (43 existing + 28 new).

### 0.1.5 (2026-06-29)

**Bug fixes & robustness improvements:**

1. **Fix: #TAG stripped from file path** — edit no longer treats the 4-hex snapshot
   tag as part of the filename. The tag is properly extracted from [path#TAG] for hash validation,
   while the real file path is used for filesystem access.

2. **Fix: Line-number drift with multiple hunks** — applyEdits now groups edits
   into atomic operations and processes them bottom-up (descending line number). This prevents
   earlier edits from shifting the line positions that later edits depend on.

3. **Fix: INS.POST content duplication** — Multiple payload lines inserted after the
   same anchor are now batched into a single splice call.

4. **Improved diff output** — buildCompactDiffPreview compares line-by-line and only shows
   lines that actually changed (- old / + new). Unchanged lines are omitted.

**New regression tests (11 cases):**
   - Multi-hunk SWAP line-drift verification
   - INS.POST with multiple payload lines (no duplication check)
   - SWAP range shrinking/expanding
   - Mixed SWAP + INS.POST + DEL operations
   - INS.POST landing-shift with structural closers
   - SWAP ranges containing closing braces
   - buildCompactDiffPreview correctness
   - Multiple interleaved operations on nearby lines

All 34 tests pass (23 original + 11 regression).


## License

MIT
