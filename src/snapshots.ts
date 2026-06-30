import { LRUCache } from "lru-cache/raw";
import { computeFileHash } from "./format";

export interface Snapshot {
  readonly path: string;
  readonly text: string;
  readonly hash: string;
  recordedAt: number;
  seenLines?: Set<number>;
}

export abstract class SnapshotStore {
  abstract head(path: string): Snapshot | null;
  abstract byHash(path: string, hash: string): Snapshot | null;
  /** All recorded snapshots for `path` in record order (oldest first). */
  abstract versions(path: string): readonly Snapshot[];
  abstract record(path: string, fullText: string, seenLines?: Iterable<number>): Promise<string>;
  abstract recordSeenLines(path: string, hash: string, lines: Iterable<number>): void;
  abstract invalidate(path: string): void;
  abstract clear(): void;
}

export class InMemorySnapshotStore extends SnapshotStore {
  private cache: LRUCache<string, Snapshot[], { max: number }>;

  constructor(maxPaths = 100, maxVersionsPerPath = 10) {
    super();
    this.cache = new LRUCache<string, Snapshot[]>({
      max: maxPaths,
      dispose: () => {},
    });
    this.maxVersionsPerPath = maxVersionsPerPath;
  }

  private maxVersionsPerPath: number;

  head(path: string): Snapshot | null {
    const versions = this.cache.get(path);
    if (!versions || versions.length === 0) return null;
    return versions[versions.length - 1];
  }

  byHash(path: string, hash: string): Snapshot | null {
    const versions = this.cache.get(path);
    if (!versions) return null;
    return versions.find(v => v.hash === hash) ?? null;
  }
  versions(path: string): readonly Snapshot[] {
    const versions = this.cache.get(path);
    return versions ? [...versions] : [];
  }

  async record(path: string, fullText: string, seenLines?: Iterable<number>): Promise<string> {
    const hash = await computeFileHash(fullText);
    const existing = this.byHash(path, hash);
    if (existing) {
      if (seenLines) {
        existing.seenLines ??= new Set();
        for (const line of seenLines) existing.seenLines.add(line);
      }
      return hash;
    }
    const snapshot: Snapshot = {
      path,
      text: fullText,
      hash,
      recordedAt: Date.now(),
      seenLines: seenLines ? new Set(seenLines) : undefined,
    };
    let versions = this.cache.get(path);
    if (!versions) {
      versions = [];
      this.cache.set(path, versions);
    }
    versions.push(snapshot);
    if (versions.length > this.maxVersionsPerPath) versions.shift();
    return hash;
  }

  recordSeenLines(path: string, hash: string, lines: Iterable<number>): void {
    const snap = this.byHash(path, hash);
    if (!snap) return;
    snap.seenLines ??= new Set();
    for (const line of lines) snap.seenLines.add(line);
  }

  invalidate(path: string): void {
    this.cache.delete(path);
  }

  clear(): void {
    this.cache.clear();
  }
}
