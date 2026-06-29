import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerEditTool } from "./src/edit.ts";
import { registerReadTool } from "./src/read.ts";

export default function hashAnchoredEdit(pi: ExtensionAPI) {
  registerReadTool(pi);
  registerEditTool(pi);

  pi.registerCommand("hash-edit-status", {
    description: "Show hashline edit status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        "Hashline-compatible read/edit active. Output format: `[path#TAG]` + `N:content`. Edit ops: `SWAP`, `DEL`, `INS.PRE|POST|HEAD|TAIL`.",
        "info",
      );
    },
  });
}
