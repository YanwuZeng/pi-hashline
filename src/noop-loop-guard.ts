/**
 * Noop-loop guard — breaks model fixation loops.
 *
 * When a model repeatedly emits edits that produce byte-identical content
 * against the same file + payload, it is stuck. After `limit` consecutive
 * no-ops for the same (path, payload) key, `observe` throws a hard tool error
 * so the agent is forced to stop and re-read instead of churning.
 *
 * The key is (canonicalPath, payload-hash): a genuine new edit (different
 * payload) or an edit to a different file resets the counter for that key,
 * and any real mutation clears the counter for that path+payload.
 */
export class NoopLoopGuard {
  private readonly counts = new Map<string, number>();
  private readonly limit: number;

  constructor(limit = 3) {
    this.limit = limit;
  }

  /**
   * Record one observation for `key`.
   * - A non-noop (`isNoop === false`) clears the counter.
   * - A noop increments it; on reaching `limit` a hard Error is thrown.
   */
  observe(key: string, isNoop: boolean): void {
    if (!isNoop) {
      this.counts.delete(key);
      return;
    }
    const next = (this.counts.get(key) ?? 0) + 1;
    if (next >= this.limit) {
      this.counts.delete(key);
      throw new NoopLoopError(
        `STOP. An edit produced byte-identical no-op content ${next} time${next === 1 ? "" : "s"} in a row ` +
          `for this file/payload. The anchors already match the current file content — the change is either ` +
          `already applied or the payload restates the existing lines. Re-read the file, confirm what still ` +
          `needs changing, and issue a different edit (or stop if the work is done).`,
      );
    }
    this.counts.set(key, next);
  }

  /** Forget all counters (e.g. on session reset). */
  clear(): void {
    this.counts.clear();
  }
}

export class NoopLoopError extends Error {
  readonly name = "NoopLoopError";
}

/** A small, fast, stable string hash (djb2) for payload keys. Not cryptographic. */
export function payloadKeyHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}
