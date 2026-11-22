import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAtomValue } from 'jotai';
import {
  isCodeNavError,
  machineSupportsCodeNav,
  type CodeNavCallersOk,
  type CodeNavDefinitionOk,
  type CodeNavDiffOutlineOk,
  type CodeNavEnclosingOk,
  type CodeNavQueryRequest,
  type CodeNavQueryResponse,
  type MachineId,
  type SessionId,
} from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useResolvedMachineMeta } from '@/hooks/use-resolved-machine-meta';

const MAX_CACHE_ENTRIES = 128;

export type CodeNavQueryFn = (request: CodeNavQueryRequest) => Promise<CodeNavQueryResponse>;

export interface UseCodeNavOptions {
  readonly sessionId: SessionId;
  readonly machineId: MachineId | null | undefined;
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

export function useCodeNav({
  sessionId,
  machineId,
  enabled = true,
  queryOverride,
}: UseCodeNavOptions): UseCodeNavResult {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const { machine } = useResolvedMachineMeta(queryOverride ? undefined : machineId);
  const supported = Boolean(
    enabled &&
    (queryOverride !== undefined ||
      (machineId && runtime?.queryCodeNav && machineSupportsCodeNav(machine)))
  );

  const cacheRef = useRef(new Map<string, CodeNavQueryResponse>());
  const inFlightRef = useRef(new Map<string, Promise<CodeNavQueryResponse | null>>());

  const invalidateCache = useCallback(() => {
    cacheRef.current.clear();
    inFlightRef.current.clear();
  }, []);

  useEffect(() => {
    invalidateCache();
  }, [invalidateCache, machineId, sessionId]);

  const execute = useCallback(
    async (request: CodeNavQueryRequest): Promise<CodeNavQueryResponse | null> => {
      if (!supported) return null;
      const cacheKey = JSON.stringify(request);
      const cached = cacheRef.current.get(cacheKey);
      if (cached !== undefined) {
        // LRU touch
        cacheRef.current.delete(cacheKey);
        cacheRef.current.set(cacheKey, cached);
        return cached;
      }
      const existing = inFlightRef.current.get(cacheKey);
      if (existing) return existing;

      const promise = (async (): Promise<CodeNavQueryResponse | null> => {
        try {
          const response = queryOverride
            ? await queryOverride(request)
            : machineId && runtime?.queryCodeNav
              ? await runtime.queryCodeNav(machineId, request, { ownerSessionId: sessionId })
              : null;
          if (!response) return null;
          // Cache successful replies and non-retryable capability/language rejections;
          // transient I/O or timeouts remain retryable on the next interaction.
          if (!isCodeNavError(response) || response.retryable === false) {
            writeBoundedCache(cacheRef.current, cacheKey, response);
          }
          return response;
        } catch {
          return null;
        } finally {
          inFlightRef.current.delete(cacheKey);
        }
      })();
      inFlightRef.current.set(cacheKey, promise);
      return promise;
    },
    [machineId, queryOverride, runtime, sessionId, supported]
  );

  const queryDiffOutline = useCallback(
    async (
      scope: 'branch' | 'uncommitted',
      baseRef?: string
    ): Promise<CodeNavDiffOutlineOk | null> => {
      const response = await execute({
        action: 'diff-outline',
        sessionId,
        scope,
        ...(baseRef ? { baseRef } : {}),
      });
      return response && !isCodeNavError(response) && response.action === 'diff-outline'
        ? response
        : null;
    },
    [execute, sessionId]
  );

  const queryEnclosing = useCallback(
    async (
      path: string,
      startLine: number,
      endLine: number
    ): Promise<CodeNavEnclosingOk | null> => {
      const response = await execute({
        action: 'enclosing',
        sessionId,
        path,
        startLine,
        endLine,
      });
      return response && !isCodeNavError(response) && response.action === 'enclosing'
        ? response
        : null;
    },
    [execute, sessionId]
  );

  const queryDefinition = useCallback(
    async (params: {
      readonly path: string;
      readonly line: number;
      readonly character: number;
      readonly symbolHint?: string;
      readonly limit?: number;
    }): Promise<CodeNavDefinitionOk | null> => {
      const response = await execute({
        action: 'definition',
        sessionId,
        path: params.path,
        line: params.line,
        character: params.character,
        ...(params.symbolHint ? { symbolHint: params.symbolHint } : {}),
        ...(params.limit === undefined ? {} : { limit: params.limit }),
      });
      return response && !isCodeNavError(response) && response.action === 'definition'
        ? response
        : null;
    },
    [execute, sessionId]
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
      const response = await execute({
        action: 'callers',
        sessionId,
        path: params.path,
        line: params.line,
        character: params.character,
        ...(params.symbolHint ? { symbolHint: params.symbolHint } : {}),
        ...(params.maxDepth === undefined ? {} : { maxDepth: params.maxDepth }),
        ...(params.limit === undefined ? {} : { limit: params.limit }),
      });
      return response && !isCodeNavError(response) && response.action === 'callers'
        ? response
        : null;
    },
    [execute, sessionId]
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
