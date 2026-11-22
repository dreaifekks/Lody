import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAtomValue } from 'jotai';
import {
  encodeSessionFilePath,
  isCodeNavError,
  machineSupportsCodeNav,
  type CodeNavCallersOk,
  type CodeNavDefinitionOk,
  type CodeNavDiffOutlineFile,
  type CodeNavDiffOutlineOk,
  type CodeNavEnclosingOk,
  type CodeNavQueryRequest,
  type CodeNavQueryResponse,
  type MachineId,
  type SessionId,
  type SessionProjectRun,
} from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useResolvedMachineMeta } from '@/hooks/use-resolved-machine-meta';
import {
  buildSessionFileRootMounts,
  getSessionFileRootMountsKey,
  toSessionFileDisplayPath,
  toSessionFileRequestPath,
  type SessionFileRootMounts,
} from '@/lib/session-file-root-mounts';

const MAX_CACHE_ENTRIES = 128;

export type CodeNavQueryFn = (request: CodeNavQueryRequest) => Promise<CodeNavQueryResponse>;

export interface UseCodeNavOptions {
  /** Business session ID sent inside `request.sessionId` (child session ID when applicable). */
  readonly sessionId: SessionId;
  /** Workspace-owning session ID sent as RPC `ownerSessionId` (parent session ID for child sessions). */
  readonly ownerSessionId?: SessionId;
  /** Owner session's project-group run metadata for multi-root path <-> `rootId` mapping. */
  readonly projectRun?: SessionProjectRun | null;
  readonly machineId: MachineId | null | undefined;
  /**
   * Diff revision fingerprint (e.g. batch revision / baseSha / content keys).
   * Changing `revision` clears cached queries and discards stale in-flight replies.
   */
  readonly revision?: string | number;
  readonly enabled?: boolean;
  /** Optional injected query function for Storybook and unit tests. */
  readonly queryOverride?: CodeNavQueryFn;
}

export interface UseCodeNavResult {
  /** True only when the target machine advertises `codeNav >= 1` (or `queryOverride` is provided). */
  readonly supported: boolean;
  readonly queryDiffOutline: (
    scope: 'branch' | 'uncommitted',
    baseRef?: string
  ) => Promise<CodeNavDiffOutlineOk | null>;
  readonly queryEnclosing: (
    path: string,
    startLine: number,
    endLine: number
  ) => Promise<CodeNavEnclosingOk | null>;
  readonly queryDefinition: (params: {
    readonly path: string;
    readonly line: number;
    readonly character: number;
    readonly symbolHint?: string;
    readonly limit?: number;
  }) => Promise<CodeNavDefinitionOk | null>;
  readonly queryCallers: (params: {
    readonly path: string;
    readonly line: number;
    readonly character: number;
    readonly symbolHint?: string;
    readonly maxDepth?: 1 | 2;
    readonly limit?: number;
  }) => Promise<CodeNavCallersOk | null>;
  readonly invalidateCache: () => void;
}

function writeBoundedCache<T>(cache: Map<string, T>, key: string, value: T): void {
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, value);
  if (cache.size <= MAX_CACHE_ENTRIES) return;
  const oldest = cache.keys().next().value;
  if (oldest !== undefined) {
    cache.delete(oldest);
  }
}

function toDisplayPathForRoot(
  relativePath: string,
  rootId: string | undefined,
  mounts: SessionFileRootMounts
): string {
  if (!rootId) return relativePath;
  return toSessionFileDisplayPath(encodeSessionFilePath({ rootId, relativePath }), mounts);
}

export function useCodeNav({
  sessionId,
  ownerSessionId,
  projectRun,
  machineId,
  revision,
  enabled = true,
  queryOverride,
}: UseCodeNavOptions): UseCodeNavResult {
  const effectiveOwnerSessionId = ownerSessionId ?? sessionId;
  const mounts = useMemo(() => buildSessionFileRootMounts(projectRun), [projectRun]);
  const mountsKey = useMemo(() => getSessionFileRootMountsKey(mounts), [mounts]);

  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const { machine } = useResolvedMachineMeta(queryOverride ? undefined : machineId);
  const supported = Boolean(
    enabled &&
    (queryOverride !== undefined ||
      (machineId && runtime?.queryCodeNav && machineSupportsCodeNav(machine)))
  );

  const scopeKey = `${sessionId}\0${effectiveOwnerSessionId}\0${machineId ?? ''}\0${mountsKey}\0${revision ?? ''}`;
  const activeScopeKeyRef = useRef(scopeKey);
  const revisionEpochRef = useRef(0);
  const cacheRef = useRef(new Map<string, CodeNavQueryResponse>());
  const inFlightRef = useRef(new Map<string, Promise<CodeNavQueryResponse | null>>());

  // Synchronously drop stale caches & bump the epoch before any sibling effect
  // in the same commit fires queries for the new revision/session/root scope.
  if (activeScopeKeyRef.current !== scopeKey) {
    activeScopeKeyRef.current = scopeKey;
    revisionEpochRef.current += 1;
    cacheRef.current.clear();
    inFlightRef.current.clear();
  }

  const invalidateCache = useCallback(() => {
    revisionEpochRef.current += 1;
    cacheRef.current.clear();
    inFlightRef.current.clear();
  }, []);

  useEffect(() => {
    return () => {
      // Invalidate any in-flight responses on unmount.
      revisionEpochRef.current += 1;
    };
  }, []);

  const execute = useCallback(
    async (request: CodeNavQueryRequest): Promise<CodeNavQueryResponse | null> => {
      if (!supported) return null;
      const requestEpoch = revisionEpochRef.current;
      const cacheKey = `${scopeKey}\0${JSON.stringify(request)}`;
      const cached = cacheRef.current.get(cacheKey);
      if (cached !== undefined) {
        // LRU touch
        cacheRef.current.delete(cacheKey);
        cacheRef.current.set(cacheKey, cached);
        return cached;
      }
      const existing = inFlightRef.current.get(cacheKey);
      if (existing) return existing;

      let promise: Promise<CodeNavQueryResponse | null> | null = null;
      promise = (async (): Promise<CodeNavQueryResponse | null> => {
        try {
          const response = queryOverride
            ? await queryOverride(request)
            : machineId && runtime?.queryCodeNav
              ? await runtime.queryCodeNav(machineId, request, {
                  ownerSessionId: effectiveOwnerSessionId,
                })
              : null;
          if (!response || revisionEpochRef.current !== requestEpoch) return null;
          // Cache successful replies and non-retryable capability/language rejections;
          // transient I/O or timeouts remain retryable on the next interaction.
          if (!isCodeNavError(response) || response.retryable === false) {
            writeBoundedCache(cacheRef.current, cacheKey, response);
          }
          return response;
        } catch {
          return null;
        } finally {
          if (promise && inFlightRef.current.get(cacheKey) === promise) {
            inFlightRef.current.delete(cacheKey);
          }
        }
      })();
      inFlightRef.current.set(cacheKey, promise);
      return promise;
    },
    [effectiveOwnerSessionId, machineId, queryOverride, runtime, scopeKey, supported]
  );

  const queryDiffOutline = useCallback(
    async (
      scope: 'branch' | 'uncommitted',
      baseRef?: string
    ): Promise<CodeNavDiffOutlineOk | null> => {
      if (mounts.length === 0) {
        const response = await execute({
          action: 'diff-outline',
          sessionId,
          scope,
          ...(baseRef ? { baseRef } : {}),
        });
        return response && !isCodeNavError(response) && response.action === 'diff-outline'
          ? response
          : null;
      }

      // Project Group with additional/link member directories: query main and
      // each member root with its own `rootId` (omitting main's `baseRef` on
      // separate member repos) and map returned paths back into display paths.
      const roots: readonly (string | undefined)[] = [
        undefined,
        ...mounts.map((mount) => mount.rootId),
      ];
      const results = await Promise.all(
        roots.map(async (rootId) => {
          const response = await execute({
            action: 'diff-outline',
            sessionId,
            scope,
            ...(rootId === undefined && baseRef ? { baseRef } : {}),
            ...(rootId ? { rootId } : {}),
          });
          if (!response || isCodeNavError(response) || response.action !== 'diff-outline') {
            return null;
          }
          return { rootId, response };
        })
      );

      const okResults = results.filter(
        (entry): entry is { rootId: string | undefined; response: CodeNavDiffOutlineOk } =>
          entry !== null
      );
      if (okResults.length === 0) return null;

      const mergedFiles: CodeNavDiffOutlineFile[] = [];
      let truncated = false;
      let headSha: string | undefined;
      let provider = okResults[0]!.response.provider;
      for (const { rootId, response } of okResults) {
        if (response.truncated) truncated = true;
        if (!headSha && response.headSha) headSha = response.headSha;
        provider = response.provider;
        for (const file of response.files) {
          mergedFiles.push({
            ...file,
            path: toDisplayPathForRoot(file.path, rootId, mounts),
          });
        }
      }
      return {
        type: 'code-nav/query',
        status: 'ok',
        action: 'diff-outline',
        ...(headSha ? { headSha } : {}),
        files: mergedFiles,
        truncated,
        provider,
      };
    },
    [execute, mounts, sessionId]
  );

  const queryEnclosing = useCallback(
    async (
      path: string,
      startLine: number,
      endLine: number
    ): Promise<CodeNavEnclosingOk | null> => {
      const target = toSessionFileRequestPath(path, mounts);
      const response = await execute({
        action: 'enclosing',
        sessionId,
        path: target.path,
        startLine,
        endLine,
        ...(target.rootId ? { rootId: target.rootId } : {}),
      });
      if (!response || isCodeNavError(response) || response.action !== 'enclosing') {
        return null;
      }
      return target.rootId
        ? { ...response, path: toDisplayPathForRoot(response.path, target.rootId, mounts) }
        : response;
    },
    [execute, mounts, sessionId]
  );

  const queryDefinition = useCallback(
    async (params: {
      readonly path: string;
      readonly line: number;
      readonly character: number;
      readonly symbolHint?: string;
      readonly limit?: number;
    }): Promise<CodeNavDefinitionOk | null> => {
      const target = toSessionFileRequestPath(params.path, mounts);
      const response = await execute({
        action: 'definition',
        sessionId,
        path: target.path,
        line: params.line,
        character: params.character,
        ...(params.symbolHint ? { symbolHint: params.symbolHint } : {}),
        ...(params.limit === undefined ? {} : { limit: params.limit }),
        ...(target.rootId ? { rootId: target.rootId } : {}),
      });
      if (!response || isCodeNavError(response) || response.action !== 'definition') {
        return null;
      }
      return target.rootId
        ? {
            ...response,
            items: response.items.map((item) => ({
              ...item,
              path: toDisplayPathForRoot(item.path, target.rootId, mounts),
            })),
          }
        : response;
    },
    [execute, mounts, sessionId]
  );

  const queryCallers = useCallback(
    async (params: {
      readonly path: string;
      readonly line: number;
      readonly character: number;
      readonly symbolHint?: string;
      readonly maxDepth?: 1 | 2;
      readonly limit?: number;
    }): Promise<CodeNavCallersOk | null> => {
      const target = toSessionFileRequestPath(params.path, mounts);
      const response = await execute({
        action: 'callers',
        sessionId,
        path: target.path,
        line: params.line,
        character: params.character,
        ...(params.symbolHint ? { symbolHint: params.symbolHint } : {}),
        ...(params.maxDepth === undefined ? {} : { maxDepth: params.maxDepth }),
        ...(params.limit === undefined ? {} : { limit: params.limit }),
        ...(target.rootId ? { rootId: target.rootId } : {}),
      });
      if (!response || isCodeNavError(response) || response.action !== 'callers') {
        return null;
      }
      return target.rootId
        ? {
            ...response,
            items: response.items.map((item) => ({
              ...item,
              path: toDisplayPathForRoot(item.path, target.rootId, mounts),
            })),
          }
        : response;
    },
    [execute, mounts, sessionId]
  );

  return useMemo(
    () => ({
      supported,
      queryDiffOutline,
      queryEnclosing,
      queryDefinition,
      queryCallers,
      invalidateCache,
    }),
    [invalidateCache, queryCallers, queryDefinition, queryDiffOutline, queryEnclosing, supported]
  );
}
