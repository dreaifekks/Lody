import type { ChildProcess } from 'node:child_process';
import type {
  ContentBlock,
  SessionConfigOption,
  SessionConfigSelectGroup,
} from '@agentclientprotocol/sdk';
import {
  formatBtwModelLabel,
  pickBtwFastConfigOptions,
  type AcpConfigOptionValue,
  type ACPSessionId,
  type AcpSessionNotification,
  type AgentConfigCliType,
  type AgentType,
  type BuiltinRuntimeOverrides,
  type CustomAcpLaunchSpec,
  type SessionBtwArticleContext,
  type SessionBtwProgress,
  type SessionBtwRequest,
  type SessionBtwResponse,
  type SessionId,
} from '@lody/shared';
import { normalizeConfigOptions } from '@/agent/acp-capabilities';
import { readLegacySessionModelState } from '@/agent/acp-capability-normalization';
import { shutdownLocalAcpAgent, startLocalAcpAgent } from '@/agent/acp-runner';
import type { AgentClient } from '@/agent/agent-client';
import type { CodexProfileExecution } from '@/agent/codex-profile-runtime';
import { extractTextFromAgentResponse } from '@/agent/response-utils';
import { formatErrorMessage } from '@/utils/format-error';
import type { Logger } from '@/utils/logger';
import { buildBtwFollowUpPrompt, buildBtwInitialPrompt } from './btw-context';
import { prepareBtwIsolation } from './btw-isolation';

export const DEFAULT_BTW_MAX_ACTIVE = 2;
export const DEFAULT_BTW_IDLE_TTL_MS = 4 * 60_000;
export const DEFAULT_BTW_SWEEP_INTERVAL_MS = 60_000;
export const DEFAULT_BTW_DELTA_THROTTLE_MS = 90;
export const DEFAULT_BTW_MAX_CONCURRENT_STARTS = 2;

export type BtwSessionLaunchTarget = {
  readonly cliType: AgentConfigCliType;
  readonly agentType: AgentType;
  readonly agentConfigId?: string;
  readonly customAcp?: CustomAcpLaunchSpec;
  readonly runtimeOverrides?: BuiltinRuntimeOverrides;
  readonly magpieGatewayUrl?: string;
  readonly codexProfile?: CodexProfileExecution;
  readonly env?: NodeJS.ProcessEnv;
  readonly userExplicitEnv?: Record<string, string>;
  readonly sessionWorkdir?: string | null;
};

export type BtwServiceDeps = {
  readonly logger: Logger;
  readonly resolveSessionTarget: (
    sessionId: SessionId,
    options: { readonly includeWorkdir: boolean }
  ) => Promise<BtwSessionLaunchTarget>;
  readonly readMainHistoryTail: (sessionId: SessionId) => Promise<string>;
  readonly maxActive?: number;
  readonly idleTtlMs?: number;
  readonly sweepIntervalMs?: number;
  readonly deltaThrottleMs?: number;
  readonly maxConcurrentStarts?: number;
  readonly now?: () => number;
  /** Test seams. */
  readonly prepareIsolation?: typeof prepareBtwIsolation;
  readonly startAgent?: typeof startLocalAcpAgent;
  readonly shutdownAgent?: typeof shutdownLocalAcpAgent;
};

export type HandleSessionBtwOptions = {
  readonly onProgress?: (progress: SessionBtwProgress) => void;
};

class AbortableSemaphore {
  private available: number;
  private readonly waiters: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];

  constructor(max: number) {
    this.available = Math.max(1, Math.floor(max));
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiters.indexOf(entry);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
      };
      const entry = {
        resolve: () => {
          cleanup();
          resolve();
        },
        reject: (error: unknown) => {
          cleanup();
          reject(error);
        },
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(entry);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next.resolve();
      return;
    }
    this.available += 1;
  }
}

type ActiveTurnState = {
  readonly abortController: AbortController;
  cancelled: boolean;
  readonly done: Promise<void>;
};

type BtwHandle = {
  readonly btwId: string;
  readonly sessionId: SessionId;
  readonly readOnlyTools: boolean;
  readonly cliType: AgentConfigCliType;
  readonly agentType: AgentType;
  readonly agentProcess: ChildProcess;
  readonly client: AgentClient;
  readonly acpSessionId: ACPSessionId;
  readonly modelId?: string;
  readonly modelLabel?: string;
  readonly cleanupIsolation: () => void;
  readonly onChunkRef: { current: ((text: string) => void) | null };
  lastUsedAt: number;
  lastArticleContext?: SessionBtwArticleContext;
  turnCount: number;
  activeTurn: ActiveTurnState | null;
  disposed: boolean;
  destroyPromise?: Promise<void>;
};

type StartingHandleState = {
  readonly abortController: AbortController;
  readonly done: Promise<void>;
};

type SessionConfigSelectEntry = Extract<SessionConfigOption, { type: 'select' }>['options'][number];

const isSelectGroup = (entry: SessionConfigSelectEntry): entry is SessionConfigSelectGroup =>
  'group' in entry;

const selectOptionValues = (option: SessionConfigOption): string[] => {
  if (option.type !== 'select') return [];
  return option.options.flatMap((entry) =>
    isSelectGroup(entry) ? entry.options.map((child) => child.value) : [entry.value]
  );
};

const canApplyOptionValue = (option: SessionConfigOption, value: AcpConfigOptionValue): boolean => {
  if (option.type === 'boolean') {
    return typeof value === 'boolean';
  }
  return typeof value === 'string' && selectOptionValues(option).includes(value);
};

const extractAgentTextChunk = (notification: AcpSessionNotification): string | null => {
  const update = notification.update;
  if (update.sessionUpdate !== 'agent_message_chunk') {
    return null;
  }
  const content = update.content;
  if (!content || content.type !== 'text' || !content.text) {
    return null;
  }
  return content.text;
};

async function applyBtwFastConfigOptions(options: {
  readonly cliType: AgentConfigCliType;
  readonly agentType: AgentType;
  readonly client: AgentClient;
  readonly acpSessionId: ACPSessionId;
  readonly sessionResponse: unknown;
  readonly signal: AbortSignal;
  readonly logger: Logger;
}): Promise<{ readonly modelId?: string; readonly modelLabel?: string }> {
  const responseRecord = options.sessionResponse as {
    configOptions?: SessionConfigOption[] | null;
  };
  let rawConfigOptions = responseRecord.configOptions ?? [];
  let normalizedOptions = normalizeConfigOptions(rawConfigOptions) ?? [];
  const legacyModels = readLegacySessionModelState(options.sessionResponse);

  const initialPick = pickBtwFastConfigOptions({
    cliType: options.cliType,
    agentType: options.agentType,
    configOptions: normalizedOptions,
    legacyModels,
  });

  const modelOption = rawConfigOptions.find(
    (opt) => opt.type === 'select' && (opt.category === 'model' || opt.id === 'model')
  );
  const modelKey = modelOption?.id ?? (legacyModels ? 'model' : undefined);
  let activeModelId =
    (typeof modelOption?.currentValue === 'string' ? modelOption.currentValue : undefined) ??
    legacyModels?.currentModelId ??
    undefined;

  // Step 1: Apply model switch first so model-specific thought/effort ladders refresh.
  if (modelKey && initialPick.configOptionValues[modelKey] !== undefined) {
    options.signal.throwIfAborted();
    const targetModel = initialPick.configOptionValues[modelKey];
    if (modelOption && canApplyOptionValue(modelOption, targetModel)) {
      try {
        const updated = await options.client.setSessionConfigOption(
          options.acpSessionId,
          modelKey,
          targetModel
        );
        if (updated) {
          rawConfigOptions = updated;
          normalizedOptions = normalizeConfigOptions(updated) ?? normalizedOptions;
        }
        if (typeof targetModel === 'string') {
          activeModelId = targetModel;
        }
      } catch (error) {
        options.logger.debug(
          `[btw] Failed to apply fast model ${modelKey}=${String(targetModel)}: ${formatErrorMessage(error)}`
        );
      }
    } else if (
      !modelOption &&
      typeof targetModel === 'string' &&
      legacyModels?.availableModels.some((entry) => entry.modelId === targetModel)
    ) {
      try {
        await options.client.unstable_setSessionModel(options.acpSessionId, targetModel);
        activeModelId = targetModel;
      } catch (error) {
        options.logger.debug(
          `[btw] Failed to apply legacy fast model ${targetModel}: ${formatErrorMessage(error)}`
        );
      }
    }
  }

  // Step 2: Re-evaluate non-model options (thought_level / effort / reasoning_effort / mode)
  // against the updated configOptions returned for the active model.
  const refreshedPick = pickBtwFastConfigOptions({
    cliType: options.cliType,
    agentType: options.agentType,
    configOptions: normalizedOptions,
    legacyModels: legacyModels
      ? {
          currentModelId: activeModelId ?? legacyModels.currentModelId,
          availableModels: legacyModels.availableModels,
        }
      : undefined,
  });

  let appliedEffortValue: string | undefined;
  for (const [key, value] of Object.entries(refreshedPick.configOptionValues)) {
    if (key === modelKey) continue;
    options.signal.throwIfAborted();
    const currentOpt = rawConfigOptions.find((opt) => opt.id === key);
    if (!currentOpt || !canApplyOptionValue(currentOpt, value)) {
      continue;
    }
    try {
      const updated = await options.client.setSessionConfigOption(options.acpSessionId, key, value);
      if (updated) {
        rawConfigOptions = updated;
        normalizedOptions = normalizeConfigOptions(updated) ?? normalizedOptions;
      }
      if (
        typeof value === 'string' &&
        (currentOpt.category === 'thought_level' ||
          key === 'thought_level' ||
          key === 'reasoning_effort' ||
          key === 'effort')
      ) {
        appliedEffortValue = value;
      }
    } catch (error) {
      options.logger.debug(
        `[btw] Failed to apply config option ${key}=${String(value)}: ${formatErrorMessage(error)}`
      );
    }
  }

  options.signal.throwIfAborted();

  const finalModelOpt = normalizedOptions.find(
    (opt) => opt.type === 'select' && (opt.category === 'model' || opt.id === 'model')
  );
  const resolvedModelId =
    activeModelId ??
    (typeof finalModelOpt?.currentValue === 'string' ? finalModelOpt.currentValue : undefined);
  const resolvedModelName =
    finalModelOpt?.options.find((opt) => opt.value === resolvedModelId)?.name ??
    legacyModels?.availableModels.find((entry) => entry.modelId === resolvedModelId)?.name ??
    undefined;

  const finalEffortOpt = normalizedOptions.find(
    (opt) =>
      opt.type === 'select' &&
      (opt.category === 'thought_level' ||
        opt.id === 'thought_level' ||
        opt.id === 'reasoning_effort' ||
        opt.id === 'effort')
  );
  const resolvedEffortValue =
    appliedEffortValue ??
    (typeof finalEffortOpt?.currentValue === 'string' ? finalEffortOpt.currentValue : undefined);
  const resolvedEffortOption = finalEffortOpt?.options.find(
    (opt) => opt.value === resolvedEffortValue
  );
  const modelLabel = formatBtwModelLabel(resolvedModelId, resolvedModelName, resolvedEffortOption);

  return {
    ...(resolvedModelId ? { modelId: resolvedModelId } : {}),
    ...(modelLabel ? { modelLabel } : {}),
  };
}

/**
 * In-memory, ephemeral `/btw` side-question service.
 *
 * Completely independent of `SessionManager` and `LoroDocumentManager`:
 * creates no Loro documents, writes no `SessionMeta`, broadcasts no presence,
 * and triggers no push notifications or turn diffs.
 */
export class BtwService {
  private readonly handles = new Map<string, BtwHandle>();
  private readonly starting = new Map<string, StartingHandleState>();
  private readonly startGate: AbortableSemaphore;
  private readonly maxActive: number;
  private readonly idleTtlMs: number;
  private readonly sweepIntervalMs: number;
  private readonly deltaThrottleMs: number;
  private readonly now: () => number;
  private readonly prepareIsolationImpl: typeof prepareBtwIsolation;
  private readonly startAgentImpl: typeof startLocalAcpAgent;
  private readonly shutdownAgentImpl: typeof shutdownLocalAcpAgent;
  private readonly shutdownController = new AbortController();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(private readonly deps: BtwServiceDeps) {
    this.maxActive = Math.max(1, Math.floor(deps.maxActive ?? DEFAULT_BTW_MAX_ACTIVE));
    this.idleTtlMs = Math.max(1_000, Math.floor(deps.idleTtlMs ?? DEFAULT_BTW_IDLE_TTL_MS));
    this.sweepIntervalMs = Math.max(
      1_000,
      Math.floor(deps.sweepIntervalMs ?? DEFAULT_BTW_SWEEP_INTERVAL_MS)
    );
    this.deltaThrottleMs = Math.max(
      0,
      Math.floor(deps.deltaThrottleMs ?? DEFAULT_BTW_DELTA_THROTTLE_MS)
    );
    this.now = deps.now ?? Date.now;
    this.startGate = new AbortableSemaphore(
      deps.maxConcurrentStarts ?? DEFAULT_BTW_MAX_CONCURRENT_STARTS
    );
    this.prepareIsolationImpl = deps.prepareIsolation ?? prepareBtwIsolation;
    this.startAgentImpl = deps.startAgent ?? startLocalAcpAgent;
    this.shutdownAgentImpl = deps.shutdownAgent ?? shutdownLocalAcpAgent;
  }

  /** Number of warm handles currently pooled (diagnostic / test helper). */
  get activeHandleCount(): number {
    return this.handles.size;
  }

  async handleRequest(
    request: SessionBtwRequest,
    options?: HandleSessionBtwOptions
  ): Promise<SessionBtwResponse> {
    if (this.disposed) {
      return {
        btwId: request.btwId,
        text: '',
        ...(request.action === 'ask' ? { error: 'BtwService has been disposed.' } : {}),
      };
    }

    try {
      switch (request.action) {
        case 'ask':
          return await this.ask(request, options?.onProgress);
        case 'cancel':
          return await this.cancel(request.btwId);
        case 'close':
          return await this.close(request.btwId);
        default:
          return {
            btwId: request.btwId,
            text: '',
            error: 'Unsupported /btw action.',
          };
      }
    } catch (error) {
      return {
        btwId: request.btwId,
        text: '',
        error: formatErrorMessage(error),
      };
    }
  }

  private async ask(
    request: SessionBtwRequest,
    onProgress?: (progress: SessionBtwProgress) => void
  ): Promise<SessionBtwResponse> {
    const question = request.question?.trim() ?? '';
    if (!question) {
      return { btwId: request.btwId, text: '', error: 'Question cannot be empty.' };
    }

    const sessionId = request.sessionId as SessionId;
    const readOnlyTools = request.readOnlyTools === true;
    const btwId = request.btwId;

    let handle = this.handles.get(btwId);
    let isFreshHandle = false;

    // If an existing handle has a different readOnlyTools mode or sessionId, tear it down
    // and rebuild a cleanly isolated process (re-injecting priorTurns below).
    if (handle && (handle.readOnlyTools !== readOnlyTools || handle.sessionId !== sessionId)) {
      await this.destroyHandle(handle);
      handle = undefined;
    }

    // If a previous turn on the same handle was just cancelled, let it settle cleanly
    // before prompting again. If it is still actively running, reject overlapping asks.
    if (handle?.activeTurn) {
      if (handle.activeTurn.cancelled) {
        await handle.activeTurn.done.catch(() => {});
      } else {
        return {
          btwId,
          text: '',
          readOnlyTools: handle.readOnlyTools,
          error: 'A /btw request is already in progress for this drawer.',
        };
      }
      if (handle.disposed || this.handles.get(btwId) !== handle) {
        handle = undefined;
      }
    }

    if (!handle) {
      if (this.starting.has(btwId)) {
        return {
          btwId,
          text: '',
          error: 'A /btw session is already starting for this drawer.',
        };
      }
      onProgress?.({ btwId, kind: 'status', status: 'starting' });
      const created = await this.createWarmHandle({
        btwId,
        sessionId,
        readOnlyTools,
      });
      if (created.cancelled) {
        return {
          btwId,
          text: '',
          cancelled: true,
          readOnlyTools,
        };
      }
      handle = created.handle;
      isFreshHandle = true;
    }

    handle.lastUsedAt = this.now();

    const turnAbort = new AbortController();
    const onShutdown = () => turnAbort.abort(new DOMException('BtwService disposed', 'AbortError'));
    this.shutdownController.signal.addEventListener('abort', onShutdown, { once: true });

    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const turnState: ActiveTurnState = {
      abortController: turnAbort,
      cancelled: false,
      done,
    };
    handle.activeTurn = turnState;

    let fullText = '';
    let pendingDelta = '';
    let emittedFirstDelta = false;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flushPendingDelta = (): void => {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (!pendingDelta) return;
      const delta = pendingDelta;
      pendingDelta = '';
      onProgress?.({
        btwId,
        kind: 'delta',
        delta,
        ...(handle.modelId ? { modelId: handle.modelId } : {}),
        ...(handle.modelLabel ? { modelLabel: handle.modelLabel } : {}),
      });
    };

    try {
      let promptText: string;
      if (isFreshHandle || handle.turnCount === 0) {
        const mainHistoryText = await this.deps.readMainHistoryTail(sessionId).catch((error) => {
          this.deps.logger.debug(
            `[btw:${btwId}] Failed to read main history tail for ${sessionId}: ${formatErrorMessage(error)}`
          );
          return '';
        });
        if (turnState.cancelled || handle.disposed || this.disposed) {
          return {
            btwId,
            text: '',
            cancelled: true,
            ...(handle.modelId ? { modelId: handle.modelId } : {}),
            ...(handle.modelLabel ? { modelLabel: handle.modelLabel } : {}),
            readOnlyTools: handle.readOnlyTools,
          };
        }
        promptText = buildBtwInitialPrompt({
          question,
          mainHistoryText,
          articleContext: request.articleContext,
          readOnlyTools,
          priorTurns: request.priorTurns,
        });
      } else {
        promptText = buildBtwFollowUpPrompt({
          question,
          articleContext: request.articleContext,
          previousArticleContext: handle.lastArticleContext,
        });
      }

      onProgress?.({
        btwId,
        kind: 'status',
        status: 'streaming',
        ...(handle.modelId ? { modelId: handle.modelId } : {}),
        ...(handle.modelLabel ? { modelLabel: handle.modelLabel } : {}),
      });

      handle.onChunkRef.current = (chunk: string) => {
        if (!chunk || turnState.cancelled || handle.disposed) return;
        fullText += chunk;
        pendingDelta += chunk;
        if (!emittedFirstDelta) {
          emittedFirstDelta = true;
          flushPendingDelta();
          return;
        }
        if (this.deltaThrottleMs === 0) {
          flushPendingDelta();
          return;
        }
        if (flushTimer === null) {
          flushTimer = setTimeout(() => {
            flushTimer = null;
            flushPendingDelta();
          }, this.deltaThrottleMs);
          flushTimer.unref?.();
        }
      };

      const promptBlocks: ContentBlock[] = [{ type: 'text', text: promptText }];
      const response = await handle.client.prompt(handle.acpSessionId, promptBlocks, {
        signal: turnAbort.signal,
      });

      if (!fullText && !turnState.cancelled) {
        const fallbackText = extractTextFromAgentResponse(response);
        if (fallbackText) {
          fullText = fallbackText;
          pendingDelta += fallbackText;
        }
      }

      flushPendingDelta();
      handle.turnCount += 1;
      if (request.articleContext) {
        handle.lastArticleContext = request.articleContext;
      }

      return {
        btwId,
        text: fullText,
        ...(turnState.cancelled ? { cancelled: true } : {}),
        ...(handle.modelId ? { modelId: handle.modelId } : {}),
        ...(handle.modelLabel ? { modelLabel: handle.modelLabel } : {}),
        readOnlyTools: handle.readOnlyTools,
      };
    } catch (error) {
      flushPendingDelta();
      if (turnState.cancelled || handle.disposed || this.disposed) {
        return {
          btwId,
          text: fullText,
          cancelled: true,
          ...(handle.modelId ? { modelId: handle.modelId } : {}),
          ...(handle.modelLabel ? { modelLabel: handle.modelLabel } : {}),
          readOnlyTools: handle.readOnlyTools,
        };
      }
      // Do not retain a broken handle after a transport/agent error; next ask will start fresh.
      void this.destroyHandle(handle).catch((destroyErr) => {
        this.deps.logger.debug(
          `[btw:${btwId}] Cleanup after prompt error failed: ${formatErrorMessage(destroyErr)}`
        );
      });
      throw error;
    } finally {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      handle.onChunkRef.current = null;
      if (handle.activeTurn === turnState) {
        handle.activeTurn = null;
      }
      handle.lastUsedAt = this.now();
      this.shutdownController.signal.removeEventListener('abort', onShutdown);
      resolveDone();
    }
  }

  private async createWarmHandle(input: {
    readonly btwId: string;
    readonly sessionId: SessionId;
    readonly readOnlyTools: boolean;
  }): Promise<{ cancelled: true } | { cancelled: false; handle: BtwHandle }> {
    const startController = new AbortController();
    const onShutdown = () =>
      startController.abort(new DOMException('BtwService disposed', 'AbortError'));
    this.shutdownController.signal.addEventListener('abort', onShutdown, { once: true });

    let resolveStartDone!: () => void;
    const startDone = new Promise<void>((resolve) => {
      resolveStartDone = resolve;
    });
    const startingState: StartingHandleState = {
      abortController: startController,
      done: startDone,
    };
    this.starting.set(input.btwId, startingState);

    let isolationCleanup: (() => void) | undefined;
    let startedAgent:
      | {
          agentProcess: ChildProcess;
          client: AgentClient;
          acpSessionId: ACPSessionId;
        }
      | undefined;

    try {
      await this.startGate.acquire(startController.signal);
      try {
        startController.signal.throwIfAborted();
        await this.ensurePoolCapacity(input.btwId);
        startController.signal.throwIfAborted();

        const target = await this.deps.resolveSessionTarget(input.sessionId, {
          includeWorkdir: input.readOnlyTools,
        });
        startController.signal.throwIfAborted();

        const isolation = await this.prepareIsolationImpl({
          cliType: target.cliType,
          agentType: target.agentType,
          readOnlyTools: input.readOnlyTools,
          sessionWorkdir: target.sessionWorkdir,
          baseEnv: target.env ?? process.env,
          codexProfile: target.codexProfile,
          logger: this.deps.logger,
        });
        isolationCleanup = isolation.cleanup;
        startController.signal.throwIfAborted();

        const onChunkRef: { current: ((text: string) => void) | null } = { current: null };
        const started = await this.startAgentImpl({
          cliType: target.cliType,
          agentType: target.agentType,
          agentConfigId: target.agentConfigId,
          customAcp: target.customAcp,
          runtimeOverrides: target.runtimeOverrides,
          magpieGatewayUrl: target.magpieGatewayUrl,
          codexProfile: target.codexProfile,
          workdir: isolation.workdir,
          env: isolation.env,
          userExplicitEnv: target.userExplicitEnv,
          envTransform: isolation.envTransform,
          launchArgFilter: isolation.launchArgFilter,
          logger: this.deps.logger,
          terminalManager: isolation.terminalManager,
          terminalEnabled: false,
          readOnlyFs: true,
          disableBuiltinMcp: true,
          skipStartGate: true,
          signal: startController.signal,
          onUpdateMessage: (notification) => {
            const chunk = extractAgentTextChunk(notification);
            if (chunk) {
              onChunkRef.current?.(chunk);
            }
          },
          onRequestPermission: isolation.onRequestPermission,
        });

        startedAgent = {
          agentProcess: started.agentProcess,
          client: started.client,
          acpSessionId: started.acpSessionId,
        };

        const appliedConfig = await applyBtwFastConfigOptions({
          cliType: target.cliType,
          agentType: target.agentType,
          client: started.client,
          acpSessionId: started.acpSessionId,
          sessionResponse: started.sessionResponse,
          signal: startController.signal,
          logger: this.deps.logger,
        });

        if (this.disposed || startController.signal.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }

        // Re-check pool cap in case another concurrent cold start landed while we initialized.
        await this.ensurePoolCapacity(input.btwId);
        if (this.disposed || startController.signal.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }

        const handle: BtwHandle = {
          btwId: input.btwId,
          sessionId: input.sessionId,
          readOnlyTools: input.readOnlyTools,
          cliType: target.cliType,
          agentType: target.agentType,
          agentProcess: started.agentProcess,
          client: started.client,
          acpSessionId: started.acpSessionId,
          modelId: appliedConfig.modelId,
          modelLabel: appliedConfig.modelLabel,
          cleanupIsolation: isolation.cleanup,
          onChunkRef,
          lastUsedAt: this.now(),
          turnCount: 0,
          activeTurn: null,
          disposed: false,
        };

        started.agentProcess.once('exit', () => {
          if (handle.disposed) return;
          handle.disposed = true;
          if (this.handles.get(handle.btwId) === handle) {
            this.handles.delete(handle.btwId);
            this.stopSweepIfEmpty();
          }
          handle.cleanupIsolation();
        });

        this.handles.set(input.btwId, handle);
        this.ensureSweepTimer();
        // Ownership transferred to the handle.
        startedAgent = undefined;
        isolationCleanup = undefined;

        return { cancelled: false, handle };
      } finally {
        this.startGate.release();
      }
    } catch (error) {
      if (startedAgent) {
        await this.shutdownAgentImpl({
          agentProcess: startedAgent.agentProcess,
          client: startedAgent.client,
          acpSessionId: startedAgent.acpSessionId,
          logger: this.deps.logger,
          sessionLabel: `btw:${input.btwId}`,
        }).catch((shutdownError) => {
          this.deps.logger.debug(
            `[btw:${input.btwId}] Cleanup after aborted start failed: ${formatErrorMessage(shutdownError)}`
          );
        });
      }
      isolationCleanup?.();

      if (startController.signal.aborted && !this.disposed) {
        return { cancelled: true };
      }
      throw error;
    } finally {
      this.shutdownController.signal.removeEventListener('abort', onShutdown);
      if (this.starting.get(input.btwId) === startingState) {
        this.starting.delete(input.btwId);
      }
      resolveStartDone();
    }
  }

  private async ensurePoolCapacity(incomingBtwId: string): Promise<void> {
    while (this.handles.size >= this.maxActive) {
      let oldestIdle: BtwHandle | undefined;
      for (const candidate of this.handles.values()) {
        if (candidate.btwId === incomingBtwId) continue;
        if (candidate.activeTurn !== null) continue;
        if (!oldestIdle || candidate.lastUsedAt < oldestIdle.lastUsedAt) {
          oldestIdle = candidate;
        }
      }
      if (!oldestIdle) {
        throw new Error('Too many concurrent /btw requests active; try again once one finishes.');
      }
      this.deps.logger.debug(
        `[btw] Evicting LRU idle handle ${oldestIdle.btwId} (pool limit=${this.maxActive})`
      );
      await this.destroyHandle(oldestIdle);
    }
  }

  private async cancel(btwId: string): Promise<SessionBtwResponse> {
    const startingState = this.starting.get(btwId);
    if (startingState) {
      startingState.abortController.abort(new DOMException('Cancelled by user', 'AbortError'));
      return { btwId, text: '', cancelled: true };
    }

    const handle = this.handles.get(btwId);
    if (!handle) {
      return { btwId, text: '', cancelled: true };
    }

    const activeTurn = handle.activeTurn;
    if (activeTurn) {
      activeTurn.cancelled = true;
      activeTurn.abortController.abort(new DOMException('Cancelled by user', 'AbortError'));
      // Best-effort direct ACP cancel in case the prompt had not attached its abort listener yet.
      await handle.client.cancel(handle.acpSessionId).catch((error) => {
        this.deps.logger.debug(
          `[btw:${btwId}] ACP cancel notification failed: ${formatErrorMessage(error)}`
        );
      });
    }

    handle.lastUsedAt = this.now();
    return {
      btwId,
      text: '',
      cancelled: true,
      ...(handle.modelId ? { modelId: handle.modelId } : {}),
      ...(handle.modelLabel ? { modelLabel: handle.modelLabel } : {}),
      readOnlyTools: handle.readOnlyTools,
    };
  }

  private async close(btwId: string): Promise<SessionBtwResponse> {
    const startingState = this.starting.get(btwId);
    if (startingState) {
      startingState.abortController.abort(new DOMException('Closed by user', 'AbortError'));
      await startingState.done.catch(() => {});
    }

    const handle = this.handles.get(btwId);
    if (handle) {
      await this.destroyHandle(handle);
    }

    return { btwId, text: '' };
  }

  private destroyHandle(handle: BtwHandle): Promise<void> {
    if (handle.destroyPromise) {
      return handle.destroyPromise;
    }
    handle.disposed = true;
    if (this.handles.get(handle.btwId) === handle) {
      this.handles.delete(handle.btwId);
      this.stopSweepIfEmpty();
    }

    const activeTurn = handle.activeTurn;
    if (activeTurn) {
      activeTurn.cancelled = true;
      activeTurn.abortController.abort(new DOMException('Handle closed', 'AbortError'));
    }

    const teardown = (async () => {
      try {
        await this.shutdownAgentImpl({
          agentProcess: handle.agentProcess,
          client: handle.client,
          acpSessionId: handle.acpSessionId,
          logger: this.deps.logger,
          sessionLabel: `btw:${handle.cliType}/${handle.agentType}:${handle.btwId}`,
        });
      } catch (error) {
        this.deps.logger.debug(
          `[btw:${handle.btwId}] Shutdown failed during handle teardown: ${formatErrorMessage(error)}`
        );
      } finally {
        handle.cleanupIsolation();
      }
    })();

    handle.destroyPromise = teardown;
    return teardown;
  }

  private ensureSweepTimer(): void {
    if (this.sweepTimer !== null || this.disposed) return;
    this.sweepTimer = setInterval(() => {
      void this.sweepIdleHandles().catch((error) => {
        this.deps.logger.debug(`[btw] Idle sweep failed: ${formatErrorMessage(error)}`);
      });
    }, this.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  private stopSweepIfEmpty(): void {
    if (this.handles.size > 0 || this.sweepTimer === null) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** Reclaims handles idle for at least `idleTtlMs`. Exposed for deterministic testing. */
  async sweepIdleHandles(): Promise<number> {
    const cutoff = this.now() - this.idleTtlMs;
    const expired: BtwHandle[] = [];
    for (const handle of this.handles.values()) {
      if (handle.activeTurn !== null) continue;
      if (handle.lastUsedAt <= cutoff) {
        expired.push(handle);
      }
    }
    if (expired.length === 0) return 0;
    await Promise.allSettled(expired.map((handle) => this.destroyHandle(handle)));
    return expired.length;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.shutdownController.abort(new DOMException('BtwService disposed', 'AbortError'));

    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }

    const inFlightStarts = [...this.starting.values()].map((entry) => {
      entry.abortController.abort(new DOMException('BtwService disposed', 'AbortError'));
      return entry.done;
    });
    const activeHandles = [...this.handles.values()];
    this.handles.clear();

    await Promise.allSettled([
      ...inFlightStarts,
      ...activeHandles.map((handle) => this.destroyHandle(handle)),
    ]);
  }
}
