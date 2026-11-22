import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import {
  codeNavError,
  type CodeNavCallersOk,
  type CodeNavDefinitionOk,
  type CodeNavDiffOutlineOk,
  type CodeNavEnclosingOk,
  type CodeNavQueryError,
  type CodeNavQueryResponse,
} from '@lody/shared';
import { startProcessLegacy, type ProcessHandleLegacy } from '@lody/shared/node/process';
import { getCliNodeExecutable } from '@/lib/managed-daemon-release';
import { toShared } from '@/platform/process-options';
import { AstGrepCodeNavProvider } from './ast-grep-provider';
import {
  isCodeNavWorkerChildMessage,
  type CodeNavWorkerParentMessage,
} from './code-nav-worker-protocol';
import type {
  CodeNavCallersInput,
  CodeNavDefinitionInput,
  CodeNavDiffOutlineInput,
  CodeNavEnclosingInput,
  CodeNavProvider,
} from './types';

const DEFAULT_IDLE_SHUTDOWN_MS = 3 * 60 * 1000;
const GRACEFUL_SHUTDOWN_MS = 1_000;

const WORKER_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  // Packaged Electron runs the embedded CLI via Lody Helper as Node; preserving
  // this flag prevents spawning a second GUI app instance.
  'ELECTRON_RUN_AS_NODE',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'PATHEXT',
  'XDG_CONFIG_HOME',
] as const;

export function buildCodeNavWorkerEnvironment(
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of WORKER_ENV_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith('GIT_') && value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

type WorkerChildLike = Pick<ChildProcess, 'connected' | 'exitCode' | 'pid' | 'send' | 'on'>;

export type CodeNavWorkerProcess = {
  readonly child: WorkerChildLike;
  readonly terminate: ProcessHandleLegacy['terminate'];
};

export type CodeNavWorkerClientOptions = {
  readonly workerEntryPath?: string;
  readonly idleShutdownMs?: number;
  readonly childLauncher?: (entryPath: string) => CodeNavWorkerProcess;
  /** Fallback provider used when the built worker bundle is absent (e.g. vitest source runs). */
  readonly fallbackProvider?: CodeNavProvider;
};

type PendingRequest = {
  readonly resolve: (response: CodeNavQueryResponse) => void;
  readonly cleanup: () => void;
};

type ManagedWorker = {
  readonly process: CodeNavWorkerProcess;
  readonly pending: Map<number, PendingRequest>;
};

/**
 * Manages a single lazy, idle-recyclable `code-nav-worker` child process.
 * Falls back cleanly to in-process `AstGrepCodeNavProvider` when running
 * directly from unbuilt TypeScript sources (e.g. unit tests).
 */
export class CodeNavWorkerClient implements CodeNavProvider {
  readonly id = 'ast-grep' as const;
  private worker: ManagedWorker | null = null;
  private readonly activeWorkers = new Set<ManagedWorker>();
  private nextRequestId = 1;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private fallbackProvider: CodeNavProvider | null;
  private readonly workerEntryPath: string;
  private readonly idleShutdownMs: number;
  private readonly childLauncher: (entryPath: string) => CodeNavWorkerProcess;

  constructor(options: CodeNavWorkerClientOptions = {}) {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    this.workerEntryPath = options.workerEntryPath ?? path.join(moduleDir, 'code-nav-worker.js');
    this.idleShutdownMs = options.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;
    this.childLauncher = options.childLauncher ?? launchCodeNavWorkerChild;
    this.fallbackProvider = options.fallbackProvider ?? null;
  }

  async diffOutline(
    input: CodeNavDiffOutlineInput,
    signal?: AbortSignal
  ): Promise<CodeNavDiffOutlineOk | CodeNavQueryError> {
    return (await this.dispatch({ action: 'diff-outline', input }, signal)) as
      | CodeNavDiffOutlineOk
      | CodeNavQueryError;
  }

  async enclosing(
    input: CodeNavEnclosingInput,
    signal?: AbortSignal
  ): Promise<CodeNavEnclosingOk | CodeNavQueryError> {
    return (await this.dispatch({ action: 'enclosing', input }, signal)) as
      | CodeNavEnclosingOk
      | CodeNavQueryError;
  }

  async definitions(
    input: CodeNavDefinitionInput,
    signal?: AbortSignal
  ): Promise<CodeNavDefinitionOk | CodeNavQueryError> {
    return (await this.dispatch({ action: 'definition', input }, signal)) as
      | CodeNavDefinitionOk
      | CodeNavQueryError;
  }

  async callers(
    input: CodeNavCallersInput,
    signal?: AbortSignal
  ): Promise<CodeNavCallersOk | CodeNavQueryError> {
    return (await this.dispatch({ action: 'callers', input }, signal)) as
      | CodeNavCallersOk
      | CodeNavQueryError;
  }

  isWorkerAlive(): boolean {
    return (
      this.worker !== null &&
      this.worker.process.child.connected &&
      this.worker.process.child.exitCode === null
    );
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancelIdleTimer();
    this.rejectAllPending(
      codeNavError('unavailable', { message: 'Code navigation service disposed.' })
    );
    await this.stopWorker();
    if (this.fallbackProvider instanceof AstGrepCodeNavProvider) {
      this.fallbackProvider.clearCaches();
    }
  }

  private async dispatch(
    payload:
      | { readonly action: 'diff-outline'; readonly input: CodeNavDiffOutlineInput }
      | { readonly action: 'enclosing'; readonly input: CodeNavEnclosingInput }
      | { readonly action: 'definition'; readonly input: CodeNavDefinitionInput }
      | { readonly action: 'callers'; readonly input: CodeNavCallersInput },
    signal?: AbortSignal
  ): Promise<CodeNavQueryResponse> {
    if (this.disposed) {
      return codeNavError('unavailable', { message: 'Code navigation service is stopped.' });
    }
    if (signal?.aborted) {
      return codeNavError('timeout', {
        message: 'Code navigation query was cancelled.',
        retryable: true,
      });
    }

    if (!existsSync(this.workerEntryPath)) {
      const fallback = this.getFallbackProvider();
      switch (payload.action) {
        case 'diff-outline':
          return await fallback.diffOutline(payload.input, signal);
        case 'enclosing':
          return await fallback.enclosing(payload.input, signal);
        case 'definition':
          return await fallback.definitions(payload.input, signal);
        case 'callers':
          return await fallback.callers(payload.input, signal);
      }
    }

    const managed = this.ensureWorker();
    if (!managed || !managed.process.child.connected) {
      return codeNavError('unavailable', {
        message: 'Code navigation worker could not be started.',
        retryable: true,
      });
    }

    this.cancelIdleTimer();
    const id = this.nextRequestId++;

    return await new Promise<CodeNavQueryResponse>((resolve) => {
      let settled = false;
      const finish = (response: CodeNavQueryResponse) => {
        if (settled) return;
        settled = true;
        const entry = managed.pending.get(id);
        managed.pending.delete(id);
        entry?.cleanup();
        this.scheduleIdleShutdownIfQuiet();
        resolve(response);
      };

      const onAbort = () => {
        if (managed.process.child.connected) {
          managed.process.child.send?.({
            type: 'code-nav/cancel',
            id,
          } satisfies CodeNavWorkerParentMessage);
        }
        finish(
          codeNavError('timeout', {
            message: 'Code navigation query timed out.',
            retryable: true,
          })
        );
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      managed.pending.set(id, {
        resolve: finish,
        cleanup: () => {
          signal?.removeEventListener('abort', onAbort);
        },
      });

      const message: CodeNavWorkerParentMessage = {
        type: 'code-nav/query',
        id,
        ...payload,
      } as CodeNavWorkerParentMessage;

      try {
        managed.process.child.send(message, (err) => {
          if (err) {
            finish(
              codeNavError('transient_io', {
                message: err.message,
                retryable: true,
              })
            );
          }
        });
      } catch (error) {
        finish(
          codeNavError('transient_io', {
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
          })
        );
      }
    });
  }

  private getFallbackProvider(): CodeNavProvider {
    if (!this.fallbackProvider) {
      this.fallbackProvider = new AstGrepCodeNavProvider();
    }
    return this.fallbackProvider;
  }

  private ensureWorker(): ManagedWorker | null {
    if (
      this.worker &&
      this.worker.process.child.connected &&
      this.worker.process.child.exitCode === null
    ) {
      return this.worker;
    }
    const launched = this.childLauncher(this.workerEntryPath);
    const managed: ManagedWorker = {
      process: launched,
      pending: new Map(),
    };
    this.worker = managed;
    this.activeWorkers.add(managed);

    launched.child.on('message', (raw: unknown) => {
      if (!isCodeNavWorkerChildMessage(raw)) return;
      const pending = managed.pending.get(raw.id);
      if (pending) {
        pending.resolve(raw.response);
      }
    });

    const handleExit = () => {
      this.activeWorkers.delete(managed);
      const isCurrentWorker = this.worker === managed;
      if (isCurrentWorker) {
        this.worker = null;
        this.cancelIdleTimer();
      }
      this.rejectWorkerPending(
        managed,
        codeNavError('transient_io', {
          message: 'Code navigation worker exited unexpectedly.',
          retryable: true,
        })
      );
    };

    launched.child.on('exit', handleExit);
    launched.child.on('error', handleExit);
    return managed;
  }

  private rejectWorkerPending(managed: ManagedWorker, error: CodeNavQueryError): void {
    const entries = [...managed.pending.values()];
    managed.pending.clear();
    for (const entry of entries) {
      entry.resolve(error);
    }
  }

  private rejectAllPending(error: CodeNavQueryError): void {
    for (const managed of [...this.activeWorkers]) {
      this.rejectWorkerPending(managed, error);
    }
  }

  private scheduleIdleShutdownIfQuiet(): void {
    const current = this.worker;
    if (this.disposed || !current || current.pending.size > 0 || this.idleShutdownMs <= 0) {
      return;
    }
    this.cancelIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.worker === current && current.pending.size === 0) {
        void this.stopWorker(current);
      }
    }, this.idleShutdownMs);
    this.idleTimer.unref?.();
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async stopWorker(target: ManagedWorker | null = this.worker): Promise<void> {
    if (!target) return;
    if (this.worker === target) {
      this.worker = null;
    }
    const { child } = target.process;
    if (child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
    if (child.connected) {
      try {
        child.send({ type: 'code-nav/shutdown' } satisfies CodeNavWorkerParentMessage);
      } catch {
        // Ignore broken pipe during shutdown.
      }
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const closedCleanly = await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), GRACEFUL_SHUTDOWN_MS);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!closedCleanly) {
      await target.process.terminate({ graceMs: 1_500, killWaitMs: 3_000 }).catch(() => undefined);
    }
  }
}

function launchCodeNavWorkerChild(entryPath: string): CodeNavWorkerProcess {
  return startProcessLegacy(
    {
      command: getCliNodeExecutable(),
      args: [entryPath],
      options: {
        env: buildCodeNavWorkerEnvironment(),
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        windowsHide: true,
      },
      processGroup: false,
    },
    toShared()
  );
}
