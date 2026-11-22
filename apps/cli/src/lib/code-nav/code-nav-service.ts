import {
  CODE_NAV_LIMITS,
  CodeNavQueryRequestSchema,
  codeNavError,
  type CodeNavQueryRequest,
  type CodeNavQueryResponse,
  type SessionId,
} from '@lody/shared';
import { CodeNavWorkerClient } from './code-nav-worker-client';
import type { CodeNavProvider, CodeNavWorkspaceResolver } from './types';

const DEFAULT_MAX_CONCURRENCY = 4;

export type CodeNavServiceOptions = {
  readonly resolveWorkspace: CodeNavWorkspaceResolver;
  readonly provider?: CodeNavProvider;
  readonly maxConcurrency?: number;
  readonly timeoutMs?: number;
};

/**
 * Read-only AST code navigation service for `code-nav/query`.
 *
 * Completely decoupled from `CodeCollabV2Service`: never activates workspace
 * watchers, never reconciles file indices, and never publishes Flock streams.
 * Bounds concurrency (<= 4) and enforces a hard per-query AbortSignal timeout
 * (default 8s), always returning a structured `CodeNavQueryResponse`.
 */
export class CodeNavService {
  private readonly provider: CodeNavProvider;
  private readonly ownsProvider: boolean;
  private readonly maxConcurrency: number;
  private readonly timeoutMs: number;
  private activeCount = 0;
  private readonly waitQueue: Array<{
    readonly grant: () => void;
    readonly cancel: () => void;
  }> = [];

  constructor(private readonly deps: CodeNavServiceOptions) {
    if (deps.provider) {
      this.provider = deps.provider;
      this.ownsProvider = false;
    } else {
      this.provider = new CodeNavWorkerClient();
      this.ownsProvider = true;
    }
    this.maxConcurrency = Math.max(1, deps.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
    this.timeoutMs = Math.max(50, deps.timeoutMs ?? CODE_NAV_LIMITS.defaultTimeoutMs);
  }

  async query(
    rawRequest: CodeNavQueryRequest,
    externalSignal?: AbortSignal
  ): Promise<CodeNavQueryResponse> {
    const parsed = CodeNavQueryRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      return codeNavError('invalid_request', {
        message: 'Invalid code-nav query parameters.',
      });
    }
    const request = parsed.data;

    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (externalSignal?.aborted) {
      return codeNavError('timeout', {
        message: 'Code navigation query was cancelled.',
        retryable: true,
      });
    }
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();

    const acquired = await this.acquirePermit(controller.signal);
    if (!acquired) {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
      return codeNavError('timeout', {
        message: 'Code navigation query timed out waiting for execution slot.',
        retryable: true,
      });
    }

    try {
      const workspace = await this.deps.resolveWorkspace(
        request.sessionId as SessionId,
        request.rootId
      );
      if (!workspace.ok) {
        return codeNavError(workspace.code, { message: workspace.message });
      }
      if (controller.signal.aborted) {
        return codeNavError('timeout', {
          message: 'Code navigation query timed out.',
          retryable: true,
        });
      }

      switch (request.action) {
        case 'diff-outline':
          return await this.provider.diffOutline(
            {
              workspaceRoot: workspace.workspaceRoot,
              scope: request.scope,
              ...(request.baseRef ? { baseRef: request.baseRef } : {}),
              ...(workspace.preferredBaseBranch
                ? { preferredBaseBranch: workspace.preferredBaseBranch }
                : {}),
            },
            controller.signal
          );
        case 'enclosing':
          return await this.provider.enclosing(
            {
              workspaceRoot: workspace.workspaceRoot,
              path: request.path,
              startLine: request.startLine,
              endLine: request.endLine,
            },
            controller.signal
          );
        case 'definition':
          return await this.provider.definitions(
            {
              workspaceRoot: workspace.workspaceRoot,
              path: request.path,
              line: request.line,
              character: request.character,
              ...(request.symbolHint ? { symbolHint: request.symbolHint } : {}),
              ...(request.limit === undefined ? {} : { limit: request.limit }),
            },
            controller.signal
          );
        case 'callers':
          return await this.provider.callers(
            {
              workspaceRoot: workspace.workspaceRoot,
              path: request.path,
              line: request.line,
              character: request.character,
              ...(request.symbolHint ? { symbolHint: request.symbolHint } : {}),
              ...(request.maxDepth === undefined ? {} : { maxDepth: request.maxDepth }),
              ...(request.limit === undefined ? {} : { limit: request.limit }),
            },
            controller.signal
          );
      }
      return codeNavError('invalid_request', { message: 'Unsupported code-nav action.' });
    } catch (error) {
      if (controller.signal.aborted) {
        return codeNavError('timeout', {
          message: 'Code navigation query timed out.',
          retryable: true,
        });
      }
      return codeNavError('transient_io', {
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
      this.releasePermit();
    }
  }

  async dispose(): Promise<void> {
    while (this.waitQueue.length > 0) {
      this.waitQueue.shift()?.cancel();
    }
    if (this.ownsProvider && this.provider instanceof CodeNavWorkerClient) {
      await this.provider.dispose();
    }
  }

  private acquirePermit(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.activeCount < this.maxConcurrency) {
      this.activeCount += 1;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const waiter = {
        grant: () => {
          signal.removeEventListener('abort', onAbort);
          this.activeCount += 1;
          resolve(true);
        },
        cancel: () => {
          signal.removeEventListener('abort', onAbort);
          resolve(false);
        },
      };
      const onAbort = () => {
        const index = this.waitQueue.indexOf(waiter);
        if (index >= 0) this.waitQueue.splice(index, 1);
        resolve(false);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.waitQueue.push(waiter);
    });
  }

  private releasePermit(): void {
    this.activeCount = Math.max(0, this.activeCount - 1);
    const next = this.waitQueue.shift();
    if (next) {
      next.grant();
    }
  }
}
