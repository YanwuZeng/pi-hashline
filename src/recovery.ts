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

  // Try replay: walk every historical version for this path, replaying the
  // edits onto that older content and 3-way-merging onto the live file. Skip
  // the chain base (fileHash, already tried above) and any version whose text
  // matches the live content (nothing to merge).
  for (const version of store.versions(path)) {
    if (version.hash === fileHash) continue;
    if (version.text === currentText) continue;
    const replayResult = applyEditsToSnapshot(
      version.text,
      currentText,
      edits,
      RECOVERY_SESSION_REPLAY_WARNING,
    );
    if (replayResult) return replayResult;
  }

  return null;
}
