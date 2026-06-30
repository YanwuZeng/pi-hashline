import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { loadPromptGuidelines } from "./prompts.ts";
import { buildCompactDiffPreview } from "./apply.ts";
import { Patch } from "./input.ts";
import { Patcher } from "./patcher.ts";
import { NodeFilesystem } from "./fs.ts";
import { snapshotStore } from "./read.ts";
import { computeFileHash, formatHashlineHeader } from "./format.ts";
import { NoopLoopGuard, payloadKeyHash } from "./noop-loop-guard.ts";
import { createBraceBlockResolver } from "./block-resolver.ts";

/**
 * Accept Pi's native format: `{ edits: [{diff?}], path? }` or `{ diff, path? }`.
 * The `diff` string IS the hashline DSL text (`[path#TAG]` header + ops + `+TEXT`
 * body rows). `edits` is accepted for compatibility with Pi's native edit
 * dispatch and is reduced to its first element's `diff`/`text` string.
 */
const editSchema = Type.Object({
  diff: Type.Optional(
    Type.String({
      description:
        "Hashline-format diff text. Must start with a `[PATH#TAG]` file header, followed by hunk headers and `+TEXT` body rows.",
    }),
  ),
  edits: Type.Optional(
    Type.Array(Type.Any(), {
      description: "Pi's native edits array. First element's `diff` field or string is used as hashline text.",
    }),
  ),
  path: Type.Optional(
    Type.String({
      description: "Optional path override when the diff lacks a `[PATH#TAG]` header.",
    }),
  ),
});

/** Module-level guard persists across tool calls to break fixation loops. */
const noopGuard = new NoopLoopGuard();

export function registerEditTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "edit",
    label: "edit#",
    description:
      "Edit a text file using hashline-format diff text. Format: `[path#TAG]` header + `SWAP`/`DEL`/`INS` ops with `+TEXT` body rows. Multi-file diffs are applied all-or-nothing.",
    promptSnippet: "Make hashline-format edits using anchors from read",
    promptGuidelines: loadPromptGuidelines("edit.md"),
    parameters: editSchema,
    prepareArguments(raw: any): any {
      // Normalize Pi's native edit format { edits: [{diff?}], path? }
      // and the hashline direct format { diff, path? } into { diff, path? }.
      if (!raw || typeof raw !== "object") return raw;

      // Case 1: Pi dispatches as { edits: [{diff:"...", path:"..."}], path:"..." }
      if (Array.isArray(raw.edits)) {
        for (const item of raw.edits) {
          if (typeof item === "string") return { diff: item, path: raw.path };
          if (item && typeof item.diff === "string") return { diff: item.diff, path: raw.path ?? item.path };
          if (item && typeof item.text === "string") return { diff: item.text, path: raw.path ?? item.path };
        }
      }

      // Case 2: direct hashline text is passed as `edits` (string)
      if (typeof raw.edits === "string") {
        return { diff: raw.edits, path: raw.path };
      }

      // Case 3: already in the right format
      return raw;
    },
    renderShell: "self",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Operation aborted");

      const diffText = params.diff as string;
      if (!diffText) {
        throw new Error("No hashline diff text provided. Pass a `diff` string in hashline format.");
      }

      const cwd = ctx?.cwd ?? process.cwd();
      let patch = new Patch(diffText, cwd);

      // Support an explicit `path` override when the diff lacks a header.
      if (patch.sections.length === 0) {
        const pathOverride = typeof params.path === "string" ? params.path : undefined;
        if (pathOverride) {
          patch = new Patch(`[${pathOverride}]\n${diffText}`, cwd);
        } else {
          throw new Error(
            "No `[path#TAG]` header found in the diff text. Include a file header from your latest read, or pass a `path` parameter.",
          );
        }
      }

      // Single pipeline: Patcher handles BOM/EOL, tag validation, seen-lines,
      // HEAD/TAIL drift, stale-tag recovery, block resolution, all-or-nothing
      // apply, and fresh-tag minting. edit.ts only formats the result.
      const patcher = new Patcher({
        fs: new NodeFilesystem(),
        snapshots: snapshotStore,
        blockResolver: createBraceBlockResolver(),
      });

      const result = await patcher.apply(patch);

      const contentParts: string[] = [];
      const allWarnings: string[] = [];
      let firstDisplayDiff: string | undefined;
      let firstFileHash: string | undefined;
      let firstPath: string | undefined;

      for (let idx = 0; idx < result.sections.length; idx++) {
        const s = result.sections[idx];
        const section = patch.sections[idx];
        const isNoop = s.op === "noop";

        // Noop-loop guard: keyed on (canonicalPath, payload) so a genuine new
        // edit resets the counter while a repeated no-op eventually hard-fails.
        noopGuard.observe(`${s.canonicalPath}::${payloadKeyHash(section.text)}`, isNoop);

        if (s.warnings.length > 0) allWarnings.push(...s.warnings);

        if (isNoop) {
          const noopHeader = s.header || formatHashlineHeader(s.path, await computeFileHash(s.before));
          contentParts.push(
            `${noopHeader}\n\nNo changes — the anchors already match the current file content.`,
          );
          continue;
        }

        const preview = buildCompactDiffPreview(s.before, s.after, { contextLines: 3, maxLines: 60 });
        if (firstDisplayDiff === undefined) firstDisplayDiff = preview.preview;
        if (firstFileHash === undefined) firstFileHash = s.fileHash;
        if (firstPath === undefined) firstPath = s.path;

        const warns = s.warnings.length > 0 ? `\nWarnings:\n${s.warnings.join("\n")}` : "";
        contentParts.push([s.header, warns, `\n${preview.preview}`].filter(Boolean).join(""));
      }

      return {
        content: [{ type: "text", text: contentParts.join("\n\n") }],
        details: {
          path: firstPath ?? params.path,
          sections: result.sections.length,
          fileHash: firstFileHash,
          displayDiff: firstDisplayDiff,
          warnings: allWarnings,
        },
      };
    },
    renderCall(args, theme, context) {
      const component = (context.lastComponent as any) ?? new Box(1, 1, (text: string) => text);
      context.state.callComponent = component;
      const path = typeof args?.path === "string" ? args.path :
        typeof args?.diff === "string" ? args.diff.split("\n")[0] :
        Array.isArray(args?.edits) && args.edits[0]?.diff ? args.edits[0].diff.split("\n")[0] : "...";
      component.clear();
      component.addChild(new Text(`${theme.fg("toolTitle", theme.bold("edit#"))} ${theme.fg("accent", path)}`, 0, 0));
      return component;
    },
    renderResult(result, _options, theme, context) {
      if (context.isError) {
        context.state.errorText = result.content?.filter((c: any) => c.type === "text").map((c: any) => c.text ?? "").join("\n") || "Edit failed.";
      }
      if (typeof result.details?.displayDiff === "string") context.state.displayDiff = result.details.displayDiff;
      const component = context.state.callComponent as any;
      if (component) {
        component.clear();
        const path = context.args?.path || (context.args?.diff ? String(context.args.diff).split("\n")[0] : "...");
        component.addChild(new Text(`${theme.fg("toolTitle", theme.bold("edit#"))} ${theme.fg("accent", path)}`, 0, 0));
        if (context.state.errorText) { component.addChild(new Spacer(1)); component.addChild(new Text(theme.fg("error", context.state.errorText), 0, 0)); }
        if (context.state.displayDiff) { component.addChild(new Spacer(1)); component.addChild(new Text(theme.fg("toolOutput", context.state.displayDiff), 0, 0)); }
      }
      return new Container();
    },
  });
}
