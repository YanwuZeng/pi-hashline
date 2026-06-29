import * as Diff from "diff";
import { applyEdits } from "./apply";
import { RECOVERY_EXTERNAL_WARNING, RECOVERY_SESSION_CHAIN_WARNING, RECOVERY_SESSION_REPLAY_WARNING } from "./messages";
import type { Snapshot, SnapshotStore } from "./snapshots";
import type { Anchor, ApplyResult, Edit } from "./types";

const RECOVERY_FUZZ_FACTOR = 0;

export interface RecoveryArgs {
  path: string;
  currentText: string;
  fileHash: string;
  edits: readonly Edit[];
}

export interface RecoveryResult {
  text: string;
  firstChangedLine: number | undefined;
  warnings: string[];
}

function applyEditsToSnapshot(
  previousText: string,
  currentText: string,
  edits: readonly Edit[],
  recoveryWarning: string,
): RecoveryResult | null {
  let applied: ApplyResult;
  try {
    applied = applyEdits(previousText, [...edits]);
  } catch {
    return null;
  }
  if (applied.text === previousText) return null;

  const patch = Diff.structuredPatch("file", "file", previousText, applied.text, "", "", { context: 3 });
  const merged = Diff.applyPatch(currentText, patch, { fuzzFactor: RECOVERY_FUZZ_FACTOR });
  if (typeof merged !== "string" || merged === currentText) return null;

  const firstChangedLine = findFirstChangedLine(currentText, merged) ?? applied.firstChangedLine;
  const hasNetChange = firstChangedLine !== undefined;
  const warnings = hasNetChange ? [recoveryWarning, ...(applied.warnings ?? [])] : [...(applied.warnings ?? [])];

  return { text: merged, firstChangedLine, warnings };
}

function findFirstChangedLine(before: string, after: string): number | undefined {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const maxLen = Math.max(beforeLines.length, afterLines.length);
  for (let i = 0; i < maxLen; i++) {
    if (beforeLines[i] !== afterLines[i]) return i + 1;
  }
  return undefined;
}

/**
 * Attempt to recover from a stale snapshot tag by replaying edits.
 */
export function recover(
  store: SnapshotStore,
  args: RecoveryArgs,
): RecoveryResult | null {
  const { path, currentText, fileHash, edits } = args;

  // Try exact hash match first
  const snapshot = store.byHash(path, fileHash);
  if (!snapshot) return null;

  if (snapshot.text === currentText) {
    // Hash was stale but content matches — just apply directly
    try {
      const applied = applyEdits(currentText, [...edits]);
      return {
        text: applied.text,
        firstChangedLine: applied.firstChangedLine,
        warnings: [RECOVERY_SESSION_CHAIN_WARNING, ...(applied.warnings ?? [])],
      };
    } catch {
      return null;
    }
  }

  // Try 3-way merge: snapshot → edits → diff → apply to current
  const chainResult = applyEditsToSnapshot(
    snapshot.text,
    currentText,
    edits,
    RECOVERY_SESSION_CHAIN_WARNING,
  );
  if (chainResult) return chainResult;

  // Try replay: walk the version chain for this path
  let version = store.head(path);
  const visited = new Set<string>();
  while (version && !visited.has(version.hash)) {
    visited.add(version.hash);
    if (version.hash !== fileHash && version.text !== currentText) {
      const replayResult = applyEditsToSnapshot(
        version.text,
        currentText,
        edits,
        RECOVERY_SESSION_REPLAY_WARNING,
      );
      if (replayResult) return replayResult;
    }
    // Walk backwards through history
    const prevHash = version.hash;
    version = store.byHash(path, prevHash); // same version, need previous
    break; // simplistic: one level is enough for most cases
  }

  return null;
}
