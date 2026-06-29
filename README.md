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
| `DEL N.=M` | `DEL 4` | Delete lines N through M (no body) |
| `INS.PRE N:` | `INS.PRE 1:` | Insert body rows before line N |
| `INS.POST N:` | `INS.POST 3:` | Insert body rows after line N |
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
- `src/parser.ts` — hashline text DSL parser (tokenizer + state machine).
- `src/apply.ts` — edit execution engine.
- `src/format.ts` — hashline format constants and helpers.
- `prompts/` — tool prompt guidelines for the LLM.
- `test/` — Node test cases and manual-test scenarios.

## Acknowledgments

This project is based on [Fadouse/pi-hash-anchored-edit](https://github.com/Fadouse/pi-hash-anchored-edit) and adopts the hashline syntax from [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) (packages/hashline).



## Changelog

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
