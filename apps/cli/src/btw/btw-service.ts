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
import { prepareBtwIsolation, supportsBtwNativeReadOnlyTools } from './btw-isolation';

export const DEFAULT_BTW_MAX_ACTIVE = 2;
export const DEFAULT_BTW_IDLE_TTL_MS = 4 * 60_000;
export const DEFAULT_BTW_SWEEP_INTERVAL_MS = 60_000;
export const DEFAULT_BTW_DELTA_THROTTLE_MS = 90;
export const DEFAULT_BTW_MAX_CONCURRENT_STARTS = 2;
export const DEFAULT_BTW_CONFIG_TIMEOUT_MS = 15_000;
const ABORTED_START_CLOSE_SESSION_TIMEOUT_MS = 500;

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
  readonly configTimeoutMs?: number;
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

type PendingAskState = {
  readonly abortController: AbortController;
  cancelled: boolean;
  readonly done: Promise<void>;
};

type ActiveTurnState = {
  readonly token: symbol;
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
  activeTurnToken: symbol | null;
  lastUsedAt: number;
  lastArticleContext?: SessionBtwArticleContext;
  turnCount: number;
  activeTurn: ActiveTurnState | null;
  dirty: boolean;
  disposed: boolean;
  destroyPromise?: Promise<void>;
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

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const abortError = () => signal.reason ?? new DOMException('Aborted', 'AbortError');
  if (signal.aborted) {
    // Prevent an unhandled rejection if the abandoned promise later fails.
    promise.catch(() => {});
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

const isNativeReadOnlyModeValue = (agentType: string, rawValue: string | undefined): boolean => {
  if (!rawValue) return false;
  const normalizedAgent = agentType.trim().toLowerCase();
  const normalizedValue = rawValue
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  if (normalizedAgent === 'antigravity' || normalizedAgent === 'antigravity-acp') {
    return normalizedValue === 'plan';
  }
  if (normalizedAgent === 'claude' || /^claude(?:[-_]|$)/.test(normalizedAgent)) {
    return (
      normalizedValue === 'plan' || normalizedValue === 'dontask' || normalizedValue === 'dont-ask'
    );
  }
  if (normalizedAgent === 'codex' || /^codex(?:[-_]|$)/.test(normalizedAgent)) {
    return normalizedValue === 'read-only' || normalizedValue === 'readonly';
  }
  return false;
};

type LegacySessionModeState = {
  readonly currentModeId?: string | null;
  readonly availableModes?: ReadonlyArray<{
    readonly id: string;
    readonly name?: string | null;
  }> | null;
};

const readLegacySessionModeState = (
  sessionResponse: unknown
): LegacySessionModeState | undefined => {
  if (!sessionResponse || typeof sessionResponse !== 'object') return undefined;
  const modes = (sessionResponse as { modes?: unknown }).modes;
  if (!modes || typeof modes !== 'object') return undefined;
  return modes as LegacySessionModeState;
};

const pickLegacyNativeReadOnlyModeId = (
  agentType: string,
  legacyModes: LegacySessionModeState | undefined
): string | undefined => {
  const available = legacyModes?.availableModes ?? [];
  if (available.length === 0) return undefined;
  const normalizedAgent = agentType.trim().toLowerCase();
  if (normalizedAgent === 'claude' || /^claude(?:[-_]|$)/.test(normalizedAgent)) {
    const plan = available.find((m) => m.id.trim().toLowerCase() === 'plan');
    if (plan) return plan.id;
    const dontAsk = available.find((m) => {
      const normalized = m.id
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, '-');
      return normalized === 'dontask' || normalized === 'dont-ask';
    });
    if (dontAsk) return dontAsk.id;
    return undefined;
  }
  return available.find((m) => isNativeReadOnlyModeValue(agentType, m.id))?.id;
};

async function applyBtwFastConfigOptions(options: {
  readonly cliType: AgentConfigCliType;
  readonly agentType: AgentType;
  readonly client: AgentClient;
  readonly acpSessionId: ACPSessionId;
  readonly sessionResponse: unknown;
  readonly signal: AbortSignal;
  readonly logger: Logger;
}): Promise<{
  readonly modelId?: string;
  readonly modelLabel?: string;
  readonly nativeReadOnlyConfirmed: boolean;
}> {
  const responseRecord = options.sessionResponse as {
    configOptions?: SessionConfigOption[] | null;
  };
  let rawConfigOptions = responseRecord.configOptions ?? [];
  let normalizedOptions = normalizeConfigOptions(rawConfigOptions) ?? [];
  const legacyModels = readLegacySessionModelState(options.sessionResponse);
  const legacyModes = readLegacySessionModeState(options.sessionResponse);

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
        const updated = await raceWithAbort(
          options.client.setSessionConfigOption(options.acpSessionId, modelKey, targetModel),
          options.signal
        );
        if (updated) {
          rawConfigOptions = updated;
          normalizedOptions = normalizeConfigOptions(updated) ?? normalizedOptions;
        }
        if (typeof targetModel === 'string') {
          activeModelId = targetModel;
        }
      } catch (error) {
        if (options.signal.aborted) throw error;
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
        await raceWithAbort(
          options.client.unstable_setSessionModel(options.acpSessionId, targetModel),
          options.signal
        );
        activeModelId = targetModel;
      } catch (error) {
        if (options.signal.aborted) throw error;
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
  let appliedModeValue: string | undefined;
  let appliedPlanModeBoolean = false;
  let sawConfigModeOption = false;

  for (const [key, value] of Object.entries(refreshedPick.configOptionValues)) {
    if (key === modelKey) continue;
    options.signal.throwIfAborted();
    const currentOpt = rawConfigOptions.find((opt) => opt.id === key);
    if (!currentOpt || !canApplyOptionValue(currentOpt, value)) {
      continue;
    }
    const isModeSelect =
      currentOpt.type === 'select' &&
      (currentOpt.category === 'mode' ||
        currentOpt.category === '_permission' ||
        key.trim().toLowerCase() === 'mode');
    if (isModeSelect || (currentOpt.type === 'boolean' && key === 'plan_mode')) {
      sawConfigModeOption = true;
    }
    const existingValue = 'currentValue' in currentOpt ? currentOpt.currentValue : undefined;
    if (existingValue === value) {
      if (
        typeof existingValue === 'string' &&
        (currentOpt.category === 'thought_level' ||
          key === 'thought_level' ||
          key === 'reasoning_effort' ||
          key === 'effort')
      ) {
        appliedEffortValue = existingValue;
      }
      if (isModeSelect && typeof existingValue === 'string') {
        appliedModeValue = existingValue;
      }
      if (currentOpt.type === 'boolean' && key === 'plan_mode' && existingValue === true) {
        appliedPlanModeBoolean = true;
      }
      continue;
    }
    try {
      const updated = await raceWithAbort(
        options.client.setSessionConfigOption(options.acpSessionId, key, value),
        options.signal
      );
      if (updated) {
        rawConfigOptions = updated;
        normalizedOptions = normalizeConfigOptions(updated) ?? normalizedOptions;
        const confirmedOpt = rawConfigOptions.find((option) => option.id === key);
        const confirmedValue =
          confirmedOpt && 'currentValue' in confirmedOpt ? confirmedOpt.currentValue : undefined;
        if (
          typeof confirmedValue === 'string' &&
          (currentOpt.category === 'thought_level' ||
            key === 'thought_level' ||
            key === 'reasoning_effort' ||
            key === 'effort')
        ) {
          appliedEffortValue = confirmedValue;
        }
        if (isModeSelect && typeof confirmedValue === 'string') {
          appliedModeValue = confirmedValue;
        }
        if (currentOpt.type === 'boolean' && key === 'plan_mode') {
          appliedPlanModeBoolean = confirmedValue === true;
        }
      }
    } catch (error) {
      if (options.signal.aborted) throw error;
      options.logger.debug(
        `[btw] Failed to apply config option ${key}=${String(value)}: ${formatErrorMessage(error)}`
      );
    }
  }

  // Step 3: Legacy `sessionResponse.modes` fallback when the provider advertises modes
  // outside `configOptions` (e.g. Antigravity legacy mode negotiation).
  let appliedLegacyModeId = legacyModes?.currentModeId ?? undefined;
  if (!sawConfigModeOption && legacyModes) {
    const targetLegacyMode = pickLegacyNativeReadOnlyModeId(options.agentType, legacyModes);
    if (targetLegacyMode) {
      if (
        appliedLegacyModeId !== targetLegacyMode &&
        typeof options.client.setSessionMode === 'function'
      ) {
        options.signal.throwIfAborted();
        try {
          await raceWithAbort(
            options.client.setSessionMode(options.acpSessionId, targetLegacyMode),
            options.signal
          );
          appliedLegacyModeId = targetLegacyMode;
        } catch (error) {
          if (options.signal.aborted) throw error;
          options.logger.debug(
            `[btw] Failed to apply legacy session mode ${targetLegacyMode}: ${formatErrorMessage(error)}`
          );
        }
      }
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

  const finalModeOpt = normalizedOptions.find(
    (opt) =>
      opt.type === 'select' &&
      (opt.category === 'mode' ||
        opt.category === '_permission' ||
        opt.id.trim().toLowerCase() === 'mode')
  );
  const finalPlanModeOpt = normalizedOptions.find(
    (opt) => opt.type === 'boolean' && opt.id === 'plan_mode'
  );
  const resolvedModeValue =
    appliedModeValue ??
    (typeof finalModeOpt?.currentValue === 'string' ? finalModeOpt.currentValue : undefined);
  const nativeReadOnlyConfirmed =
    appliedPlanModeBoolean ||
    finalPlanModeOpt?.currentValue === true ||
    isNativeReadOnlyModeValue(options.agentType, resolvedModeValue) ||
    isNativeReadOnlyModeValue(options.agentType, appliedLegacyModeId);

  return {
    ...(resolvedModelId ? { modelId: resolvedModelId } : {}),
    ...(modelLabel ? { modelLabel } : {}),
    nativeReadOnlyConfirmed,
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
  private readonly pendingAsks = new Map<string, PendingAskState>();
  private readonly reservedSlots = new Set<string>();
  private readonly pendingTeardowns = new Map<string, Set<Promise<void>>>();
  private readonly startGate: AbortableSemaphore;
  private readonly maxActive: number;
  private readonly idleTtlMs: number;
  private readonly sweepIntervalMs: number;
  private readonly deltaThrottleMs: number;
  private readonly configTimeoutMs: number;
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
    this.configTimeoutMs = Math.max(
      1,
      Math.floor(deps.configTimeoutMs ?? DEFAULT_BTW_CONFIG_TIMEOUT_MS)
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

  /** Number of pool slots currently reserved for in-flight cold starts (diagnostic / test helper). */
  get reservedSlotCount(): number {
    return this.reservedSlots.size;
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
    const requestedReadOnlyTools = request.readOnlyTools === true;
    const btwId = request.btwId;

    // Synchronously check for an overlapping non-cancelled ask BEFORE any await,
    // and register our ask cancellation state immediately so `cancel`/`close` during
    // old-handle teardown (e.g. toggling `readOnlyTools`) aborts this ask instead of
    // letting a brand-new process start after teardown finishes.
    const previousAsk = this.pendingAsks.get(btwId);
    if (previousAsk && !previousAsk.cancelled) {
      const existingHandle = this.handles.get(btwId);
      return {
        btwId,
        text: '',
        ...(existingHandle ? { readOnlyTools: existingHandle.readOnlyTools } : {}),
        error: 'A /btw request is already in progress for this drawer.',
      };
    }

    const askAbort = new AbortController();
    const onShutdown = () => askAbort.abort(new DOMException('BtwService disposed', 'AbortError'));
    this.shutdownController.signal.addEventListener('abort', onShutdown, { once: true });

    let resolveAskDone!: () => void;
    const askDone = new Promise<void>((resolve) => {
      resolveAskDone = resolve;
    });
    const askState: PendingAskState = {
      abortController: askAbort,
      cancelled: false,
      done: askDone,
    };
    this.pendingAsks.set(btwId, askState);

    const isAskAborted = () => askState.cancelled || askAbort.signal.aborted || this.disposed;

    try {
      // If a previous ask was just cancelled, wait for its finally block to settle first.
      if (previousAsk) {
        await previousAsk.done.catch(() => {});
        if (isAskAborted()) {
          return {
            btwId,
            text: '',
            cancelled: true,
            readOnlyTools: requestedReadOnlyTools,
          };
        }
      }

      let handle = this.handles.get(btwId);
      let isFreshHandle = false;

      // Wait for any cancelled turn on the pooled handle before deciding reuse vs rebuild.
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
        if (isAskAborted()) {
          return {
            btwId,
            text: '',
            cancelled: true,
            readOnlyTools: requestedReadOnlyTools,
          };
        }
        if (handle.disposed || this.handles.get(btwId) !== handle) {
          handle = undefined;
        }
      }

      // Tear down the pooled handle if mode/session changed, or if a prior cancelled
      // prompt left the underlying ACP turn unfinished (dirty handle).
      if (handle) {
        const expectedReadOnlyForHandle = supportsBtwNativeReadOnlyTools(handle.agentType)
          ? requestedReadOnlyTools
          : false;
        const hasPendingRawPrompt = handle.client.pendingPromptCompletion != null;
        if (
          handle.dirty ||
          hasPendingRawPrompt ||
          handle.readOnlyTools !== expectedReadOnlyForHandle ||
          handle.sessionId !== sessionId
        ) {
          await this.destroyHandle(handle);
          handle = undefined;
        }
        if (isAskAborted()) {
          return {
            btwId,
            text: '',
            cancelled: true,
            readOnlyTools: requestedReadOnlyTools,
          };
        }
      }

      if (!handle) {
        onProgress?.({ btwId, kind: 'status', status: 'starting' });
        const created = await this.createWarmHandle({
          btwId,
          sessionId,
          readOnlyTools: requestedReadOnlyTools,
          signal: askAbort.signal,
        });
        if (created.cancelled || isAskAborted()) {
          if (!created.cancelled) {
            await this.destroyHandle(created.handle);
          }
          return {
            btwId,
            text: '',
            cancelled: true,
            readOnlyTools: created.cancelled
              ? requestedReadOnlyTools
              : created.handle.readOnlyTools,
          };
        }
        handle = created.handle;
        isFreshHandle = true;
      }

      handle.lastUsedAt = this.now();

      const turnToken = Symbol('btw-turn');
      const turnAbort = new AbortController();
      const onAskAbortForTurn = () => {
        turnState.cancelled = true;
        turnAbort.abort(askAbort.signal.reason ?? new DOMException('Cancelled', 'AbortError'));
      };
      askAbort.signal.addEventListener('abort', onAskAbortForTurn, { once: true });

      let resolveTurnDone!: () => void;
      const turnDone = new Promise<void>((resolve) => {
        resolveTurnDone = resolve;
      });
      const turnState: ActiveTurnState = {
        token: turnToken,
        abortController: turnAbort,
        cancelled: isAskAborted(),
        done: turnDone,
      };
      handle.activeTurn = turnState;
      handle.activeTurnToken = turnToken;

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
            readOnlyTools: handle.readOnlyTools,
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
          if (
            !chunk ||
            handle.activeTurnToken !== turnToken ||
            turnState.cancelled ||
            handle.disposed
          ) {
            return;
          }
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
        if (handle.activeTurnToken === turnToken) {
          handle.activeTurnToken = null;
        }
        if (handle.activeTurn === turnState) {
          handle.activeTurn = null;
        }
        handle.lastUsedAt = this.now();
        askAbort.signal.removeEventListener('abort', onAskAbortForTurn);

        // If this turn was cancelled while the underlying ACP prompt has not yet settled,
        // late chunks from the cancelled turn could otherwise contaminate the next ask.
        // Mark the handle dirty and evict/destroy it immediately so any follow-up spawns
        // a clean process with `priorTurns`.
        if (
          turnState.cancelled &&
          !handle.disposed &&
          handle.client.pendingPromptCompletion != null
        ) {
          handle.dirty = true;
          void this.destroyHandle(handle).catch((destroyErr) => {
            this.deps.logger.debug(
              `[btw:${btwId}] Cleanup after cancelled dirty turn failed: ${formatErrorMessage(destroyErr)}`
            );
          });
        }
        resolveTurnDone();
      }
    } finally {
      this.shutdownController.signal.removeEventListener('abort', onShutdown);
      if (this.pendingAsks.get(btwId) === askState) {
        this.pendingAsks.delete(btwId);
      }
      resolveAskDone();
    }
  }

  private async createWarmHandle(input: {
    readonly btwId: string;
    readonly sessionId: SessionId;
    readonly readOnlyTools: boolean;
    readonly signal: AbortSignal;
  }): Promise<{ cancelled: true } | { cancelled: false; handle: BtwHandle }> {
    let isolationCleanup: (() => void) | undefined;
    let startedAgent:
      | {
          agentProcess: ChildProcess;
          client: AgentClient;
          acpSessionId: ACPSessionId;
        }
      | undefined;
    let startedAgentCleanupPromise: Promise<void> | null = null;
    let configTimer: ReturnType<typeof setTimeout> | null = null;
    let detachConfigAbortListeners: (() => void) | undefined;

    const cleanupStartedAgentOnce = (fastClose: boolean): Promise<void> => {
      if (!startedAgent) {
        if (isolationCleanup) {
          const cleanupIso = isolationCleanup;
          isolationCleanup = undefined;
          cleanupIso();
        }
        return Promise.resolve();
      }
      if (!startedAgentCleanupPromise) {
        const toShutdown = startedAgent;
        startedAgent = undefined;
        const cleanupIso = isolationCleanup;
        isolationCleanup = undefined;
        startedAgentCleanupPromise = this.shutdownAgentImpl({
          agentProcess: toShutdown.agentProcess,
          client: toShutdown.client,
          acpSessionId: toShutdown.acpSessionId,
          logger: this.deps.logger,
          sessionLabel: `btw:${input.btwId}`,
          ...(fastClose ? { closeSessionTimeoutMs: ABORTED_START_CLOSE_SESSION_TIMEOUT_MS } : {}),
        })
          .catch((shutdownError) => {
            this.deps.logger.debug(
              `[btw:${input.btwId}] Cleanup after aborted/timed-out start failed: ${formatErrorMessage(shutdownError)}`
            );
          })
          .finally(() => {
            cleanupIso?.();
          });
        this.trackPendingTeardown(input.btwId, startedAgentCleanupPromise);
      }
      return startedAgentCleanupPromise;
    };

    let hasSlotReservation = false;

    try {
      // Reserve pool capacity BEFORE waiting on the startup concurrency gate so
      // requests that exceed `maxActive` (with no idle handle to evict) fail fast
      // instead of blocking behind in-flight cold starts.
      input.signal.throwIfAborted();
      await this.reservePoolSlot(input.btwId, input.signal);
      hasSlotReservation = true;

      await this.startGate.acquire(input.signal);
      try {
        input.signal.throwIfAborted();

        const target = await this.deps.resolveSessionTarget(input.sessionId, {
          includeWorkdir: input.readOnlyTools,
        });
        input.signal.throwIfAborted();

        const effectiveReadOnlyTools =
          input.readOnlyTools && supportsBtwNativeReadOnlyTools(target.agentType);
        const isolation = await this.prepareIsolationImpl({
          cliType: target.cliType,
          agentType: target.agentType,
          readOnlyTools: effectiveReadOnlyTools,
          sessionWorkdir: effectiveReadOnlyTools ? target.sessionWorkdir : null,
          baseEnv: target.env ?? process.env,
          codexProfile: target.codexProfile,
          logger: this.deps.logger,
        });
        isolationCleanup = isolation.cleanup;
        const finalReadOnlyTools =
          effectiveReadOnlyTools && (isolation.effectiveReadOnlyTools ?? effectiveReadOnlyTools);
        const usedSessionWorkdir =
          finalReadOnlyTools && (isolation.usedSessionWorkdir ?? Boolean(target.sessionWorkdir));
        input.signal.throwIfAborted();

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
          disableReadTextFile: !finalReadOnlyTools,
          disableBuiltinMcp: true,
          skipStartGate: true,
          signal: input.signal,
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

        // Immediately bind cancel/close/dispose and a bounded config timeout to process
        // termination so a hung config RPC (`setSessionConfigOption` / `setSessionMode`)
        // can never wedge close(), dispose(), or startup slots.
        const configAbortController = new AbortController();
        const onOuterAbort = () => {
          configAbortController.abort(
            input.signal.reason ?? new DOMException('Aborted', 'AbortError')
          );
        };
        const onConfigAbort = () => {
          void cleanupStartedAgentOnce(true);
        };
        input.signal.addEventListener('abort', onOuterAbort, { once: true });
        configAbortController.signal.addEventListener('abort', onConfigAbort, { once: true });
        configTimer = setTimeout(() => {
          configTimer = null;
          configAbortController.abort(
            new Error(`Timed out configuring /btw session after ${this.configTimeoutMs}ms.`)
          );
        }, this.configTimeoutMs);
        configTimer.unref?.();

        detachConfigAbortListeners = () => {
          if (configTimer !== null) {
            clearTimeout(configTimer);
            configTimer = null;
          }
          input.signal.removeEventListener('abort', onOuterAbort);
          configAbortController.signal.removeEventListener('abort', onConfigAbort);
        };

        if (input.signal.aborted || this.disposed) {
          onOuterAbort();
          throw input.signal.reason ?? new DOMException('Aborted', 'AbortError');
        }

        const appliedConfig = await applyBtwFastConfigOptions({
          cliType: target.cliType,
          agentType: target.agentType,
          client: started.client,
          acpSessionId: started.acpSessionId,
          sessionResponse: started.sessionResponse,
          signal: configAbortController.signal,
          logger: this.deps.logger,
        });

        if (this.disposed || input.signal.aborted || configAbortController.signal.aborted) {
          throw configAbortController.signal.reason ?? new DOMException('Aborted', 'AbortError');
        }

        if (usedSessionWorkdir && !appliedConfig.nativeReadOnlyConfirmed) {
          throw new Error(
            `Read-only tool mode requires a provider-native read-only mode, which could not be confirmed for ${target.agentType}.`
          );
        }

        detachConfigAbortListeners();
        detachConfigAbortListeners = undefined;

        const handle: BtwHandle = {
          btwId: input.btwId,
          sessionId: input.sessionId,
          readOnlyTools: finalReadOnlyTools,
          cliType: target.cliType,
          agentType: target.agentType,
          agentProcess: started.agentProcess,
          client: started.client,
          acpSessionId: started.acpSessionId,
          modelId: appliedConfig.modelId,
          modelLabel: appliedConfig.modelLabel,
          cleanupIsolation: isolation.cleanup,
          onChunkRef,
          activeTurnToken: null,
          lastUsedAt: this.now(),
          turnCount: 0,
          activeTurn: null,
          dirty: false,
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

        // Atomically convert our pool reservation into the live pooled handle so
        // `this.handles.size + this.reservedSlots.size <= this.maxActive` holds at all times.
        this.reservedSlots.delete(input.btwId);
        hasSlotReservation = false;
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
      detachConfigAbortListeners?.();
      detachConfigAbortListeners = undefined;
      await cleanupStartedAgentOnce(true);

      if (input.signal.aborted && !this.disposed) {
        return { cancelled: true };
      }
      throw error;
    } finally {
      detachConfigAbortListeners?.();
      if (hasSlotReservation) {
        this.reservedSlots.delete(input.btwId);
      }
    }
  }

  /**
   * Synchronously reserves one pool slot so concurrent cold starts can never
   * push `this.handles.size + this.reservedSlots.size` above `this.maxActive`.
   */
  private async reservePoolSlot(incomingBtwId: string, signal: AbortSignal): Promise<void> {
    while (true) {
      signal.throwIfAborted();
      if (this.disposed) {
        throw new DOMException('BtwService disposed', 'AbortError');
      }
      if (this.reservedSlots.has(incomingBtwId)) {
        return;
      }
      if (this.handles.size + this.reservedSlots.size < this.maxActive) {
        this.reservedSlots.add(incomingBtwId);
        return;
      }

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
      // `destroyHandle` synchronously removes `oldestIdle` from `this.handles`, so
      // claiming `incomingBtwId` in `this.reservedSlots` right away keeps the total
      // committed slots `<= maxActive` across the async teardown boundary.
      const eviction = this.destroyHandle(oldestIdle);
      this.reservedSlots.add(incomingBtwId);
      try {
        await eviction;
        signal.throwIfAborted();
        if (this.disposed) {
          throw new DOMException('BtwService disposed', 'AbortError');
        }
        return;
      } catch (error) {
        this.reservedSlots.delete(incomingBtwId);
        throw error;
      }
    }
  }

  private async cancel(btwId: string): Promise<SessionBtwResponse> {
    const pendingAsk = this.pendingAsks.get(btwId);
    if (pendingAsk) {
      pendingAsk.cancelled = true;
      pendingAsk.abortController.abort(new DOMException('Cancelled by user', 'AbortError'));
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
    const pendingAsk = this.pendingAsks.get(btwId);
    if (pendingAsk) {
      pendingAsk.cancelled = true;
      pendingAsk.abortController.abort(new DOMException('Closed by user', 'AbortError'));
      await pendingAsk.done.catch(() => {});
    }

    const handle = this.handles.get(btwId);
    if (handle) {
      await this.destroyHandle(handle);
    }

    const teardowns = this.pendingTeardowns.get(btwId);
    if (teardowns && teardowns.size > 0) {
      await Promise.allSettled([...teardowns]);
    }

    return { btwId, text: '' };
  }

  private trackPendingTeardown(btwId: string, promise: Promise<void>): void {
    let set = this.pendingTeardowns.get(btwId);
    if (!set) {
      set = new Set();
      this.pendingTeardowns.set(btwId, set);
    }
    set.add(promise);
    const release = () => {
      const current = this.pendingTeardowns.get(btwId);
      if (!current) return;
      current.delete(promise);
      if (current.size === 0) {
        this.pendingTeardowns.delete(btwId);
      }
    };
    void promise.then(release, release);
  }

  private destroyHandle(handle: BtwHandle): Promise<void> {
    if (handle.destroyPromise) {
      return handle.destroyPromise;
    }
    handle.disposed = true;
    handle.activeTurnToken = null;
    handle.onChunkRef.current = null;
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
    this.trackPendingTeardown(handle.btwId, teardown);
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

    const inFlightAsks = [...this.pendingAsks.values()].map((entry) => {
      entry.cancelled = true;
      entry.abortController.abort(new DOMException('BtwService disposed', 'AbortError'));
      return entry.done;
    });
    const activeHandles = [...this.handles.values()];
    this.handles.clear();

    await Promise.allSettled([
      ...inFlightAsks,
      ...activeHandles.map((handle) => this.destroyHandle(handle)),
    ]);

    const remainingTeardowns = [...this.pendingTeardowns.values()].flatMap((set) => [...set]);
    if (remainingTeardowns.length > 0) {
      await Promise.allSettled(remainingTeardowns);
    }
  }
}
