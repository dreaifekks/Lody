import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { runCommandTextLegacy } from '@lody/shared/node/process';
import type { FileSymbolIndex } from './types';

export const CODE_NAV_CACHE_LIMITS = {
  /** L1 AST cache: max parsed SgRoot entries retained in native memory. */
  l1MaxFiles: 32,
  /** L1 AST cache: max combined source UTF-8 bytes (~60-80 MiB Rust RSS cap). */
  l1MaxSourceBytes: 2 * 1024 * 1024,
  /** L1 idle TTL before releasing all native SgRoot references. */
  l1IdleClearMs: 3 * 60 * 1000,
  /** L2 pure-JSON symbol/import index global ceiling across all snapshots. */
  l2MaxBytes: 32 * 1024 * 1024,
  /** Skip parsing single files larger than 1 MiB to protect native heap. */
  maxSingleFileBytes: 1024 * 1024,
} as const;

export type WorkspaceSnapshotKey = string;

export type AstLruEntry<TRoot> = {
  readonly root: TRoot;
  readonly source: string;
  readonly sourceBytes: number;
};

/**
 * Bounded L1 LRU cache for parsed `@ast-grep/napi` `SgRoot` trees.
 * Enforces BOTH max file count (<= 32) and total source byte budget (<= 2 MiB)
 * to keep Rust native heap RSS strictly bounded.
 */
export class BoundedAstLruCache<TRoot> {
  private readonly entries = new Map<string, AstLruEntry<TRoot>>();
  private totalSourceBytes = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly limits: {
      readonly maxFiles: number;
      readonly maxSourceBytes: number;
      readonly idleClearMs?: number;
    } = {
      maxFiles: CODE_NAV_CACHE_LIMITS.l1MaxFiles,
      maxSourceBytes: CODE_NAV_CACHE_LIMITS.l1MaxSourceBytes,
      idleClearMs: CODE_NAV_CACHE_LIMITS.l1IdleClearMs,
    }
  ) {}

  get(key: string): AstLruEntry<TRoot> | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    // Refresh LRU recency.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.bumpIdleTimer();
    return entry;
  }

  set(key: string, entry: AstLruEntry<TRoot>): void {
    // Never retain a single entry larger than the entire byte cap.
    if (entry.sourceBytes > this.limits.maxSourceBytes || this.limits.maxFiles <= 0) {
      return;
    }
    const existing = this.entries.get(key);
    if (existing) {
      this.totalSourceBytes -= existing.sourceBytes;
      this.entries.delete(key);
    }
    this.entries.set(key, entry);
    this.totalSourceBytes += entry.sourceBytes;
    this.evictIfNeeded();
    this.bumpIdleTimer();
  }

  delete(key: string): void {
    const existing = this.entries.get(key);
    if (!existing) return;
    this.totalSourceBytes -= existing.sourceBytes;
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.totalSourceBytes = 0;
    this.cancelIdleTimer();
  }

  stats(): { readonly count: number; readonly totalSourceBytes: number } {
    return {
      count: this.entries.size,
      totalSourceBytes: this.totalSourceBytes,
    };
  }

  private evictIfNeeded(): void {
    while (
      this.entries.size > this.limits.maxFiles ||
      this.totalSourceBytes > this.limits.maxSourceBytes
    ) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.delete(oldestKey);
    }
  }

  private bumpIdleTimer(): void {
    this.cancelIdleTimer();
    const idleMs = this.limits.idleClearMs ?? 0;
    if (idleMs <= 0 || this.entries.size === 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.clear();
    }, idleMs);
    this.idleTimer.unref?.();
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

/**
 * Bounded L2 pure-JSON symbol & import index keyed by `(snapshotKey, relPath)`.
 * Stores zero native `SgRoot` handles so whole-repo metadata stays lightweight
 * and globally bounded to `<= 32 MiB`.
 */
export class BoundedSymbolIndexCache {
  private readonly entries = new Map<string, FileSymbolIndex>();
  private totalBytes = 0;

  constructor(private readonly maxBytes: number = CODE_NAV_CACHE_LIMITS.l2MaxBytes) {}

  private makeKey(snapshotKey: WorkspaceSnapshotKey, relPath: string): string {
    return `${snapshotKey}\0${relPath}`;
  }

  get(snapshotKey: WorkspaceSnapshotKey, relPath: string): FileSymbolIndex | undefined {
    const key = this.makeKey(snapshotKey, relPath);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(snapshotKey: WorkspaceSnapshotKey, relPath: string, index: FileSymbolIndex): void {
    if (index.estimatedBytes > this.maxBytes || this.maxBytes <= 0) {
      return;
    }
    const key = this.makeKey(snapshotKey, relPath);
    const existing = this.entries.get(key);
    if (existing) {
      this.totalBytes -= existing.estimatedBytes;
      this.entries.delete(key);
    }
    this.entries.set(key, index);
    this.totalBytes += index.estimatedBytes;
    while (this.totalBytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.entries.get(oldestKey);
      if (oldest) this.totalBytes -= oldest.estimatedBytes;
      this.entries.delete(oldestKey);
    }
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  stats(): { readonly count: number; readonly totalBytes: number } {
    return {
      count: this.entries.size,
      totalBytes: this.totalBytes,
    };
  }
}

export function estimateFileSymbolIndexBytes(
  index: Omit<FileSymbolIndex, 'estimatedBytes'>
): number {
  return Buffer.byteLength(JSON.stringify(index), 'utf8');
}

const MAX_STAT_DIRTY_ENTRIES = 256;

/**
 * Computes a static snapshot cache key `(workspaceRoot, headSha, dirtyHash)`.
 * For clean committed worktrees this stabilizes immediately (`dirtyHash = 'clean'`);
 * for dirty worktrees it hashes `git status --porcelain=v1 -z` plus `(size, mtimeMs)`
 * of dirty files so edits invalidate the cache without reading file contents.
 */
export async function computeWorkspaceSnapshotKey(
  canonicalRoot: string,
  signal?: AbortSignal
): Promise<{
  readonly snapshotKey: WorkspaceSnapshotKey;
  readonly headSha: string | null;
  readonly isGitRepo: boolean;
}> {
  const [headResult, statusResult] = await Promise.all([
    runCommandTextLegacy(
      {
        command: 'git',
        args: ['rev-parse', '--verify', 'HEAD^{commit}'],
        cwd: canonicalRoot,
        check: 'none',
      },
      { signal }
    ).catch(() => null),
    runCommandTextLegacy(
      {
        command: 'git',
        args: ['status', '--porcelain=v1', '-z', '-uall'],
        cwd: canonicalRoot,
        check: 'none',
      },
      { signal }
    ).catch(() => null),
  ]);

  if (!statusResult || statusResult.code !== 0) {
    // Non-git directory fallback: uncached ephemeral key per call.
    return {
      snapshotKey: `${canonicalRoot}\0non-git\0${Date.now()}`,
      headSha: null,
      isGitRepo: false,
    };
  }

  const headSha =
    headResult && headResult.code === 0 && headResult.stdout.trim()
      ? headResult.stdout.trim()
      : null;

  const statusStdout = statusResult.stdout;
  if (!statusStdout) {
    return {
      snapshotKey: `${canonicalRoot}\0${headSha ?? 'unborn'}\0clean`,
      headSha,
      isGitRepo: true,
    };
  }

  const hash = createHash('sha256');
  hash.update(statusStdout);

  const tokens = statusStdout.split('\0').filter(Boolean);
  let statCount = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const entry = tokens[i]!;
    if (entry.length < 4) continue;
    const statusCode = entry.slice(0, 2);
    const relPath = entry.slice(3);
    // Renamed entries emit two NUL-terminated paths; skip the second.
    if (statusCode.includes('R') || statusCode.includes('C')) {
      i += 1;
    }
    if (statCount >= MAX_STAT_DIRTY_ENTRIES) {
      hash.update(`overflow:${Date.now()}`);
      break;
    }
    statCount += 1;
    try {
      const info = await lstat(path.join(canonicalRoot, relPath), { bigint: true });
      hash.update(`\0${relPath}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`);
    } catch {
      hash.update(`\0${relPath}:missing`);
    }
  }

  const dirtyHash = hash.digest('hex').slice(0, 16);
  return {
    snapshotKey: `${canonicalRoot}\0${headSha ?? 'unborn'}\0${dirtyHash}`,
    headSha,
    isGitRepo: true,
  };
}
