import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionConfigSelectGroup,
} from '@agentclientprotocol/sdk';
import {
  buildReplayPromptFromHistory,
  sessionRolloverStepId,
  type ACPSessionId,
  type AcpConfigOptionSummary,
  type AcpConfigOptionValue,
  type MachineId,
  type ReplayPromptResult,
  type SessionHistoryInput,
  type SessionId,
  type SessionMeta,
  type SessionRolloverNoticeMeta,
  type SessionRolloverTrigger,
  type WorkspaceId,
} from '@lody/shared';
import { runCommandTextLegacy } from '@lody/shared/node/process';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { shutdownLocalAcpAgent, startLocalAcpAgent } from '@/agent/acp-runner';
import { parseLodyMessagePhase } from '@/agent/lody-acp-extension';
import { extractTextFromAgentResponse } from '@/agent/response-utils';
import { extractTitleChunkFromNotification } from '@/agent/title-generator';
import { prepareBtwIsolation } from '@/btw/btw-isolation';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import type { Logger } from '@/utils/logger';
import type { AcpSessionRunConfig } from './acp-session-config-applier';
import { resolveSessionLaunchConfig } from './session-launch-config-resolver';
import {
  buildColdSealPrompt,
  buildColdTextStreamForSeal,
  buildFallbackRolloverCard,
  buildLinearRolloverOpening,
  buildWarmSealPrompt,
  extractRecentSegmentFiles,
  formatRolloverNodeId,
  formatRolloverTimeWindow,
  parseRolloverSealJson,
  resolveOriginTurn,
  sliceRolloverSegmentEntries,
  type SessionRolloverWorkspaceAnchor,
} from './session-rollover-opening';
import {
  SESSION_ROLLOVER_MAX_SPINE_ENTRIES,
  createInitialSessionRolloverState,
  type SessionRolloverPendingSwitch,
  type SessionRolloverReason,
  type SessionRolloverSpineItem,
  type SessionRolloverState,
  type SessionRolloverStore,
} from './session-rollover-store';

/** Default warm-cache TTL (8 minutes) before `:seal` switches to cold Loro text summarization. */
export const SESSION_ROLLOVER_WARM_CACHE_TTL_MS = 8 * 60 * 1000;
const WORKSPACE_GIT_PROBE_TIMEOUT_MS = 2_000;

export type SessionRolloverSealMode = 'warm' | 'cold';

export function rolloverReasonToTrigger(reason: SessionRolloverReason): SessionRolloverTrigger {
  switch (reason) {
    case 'manual_command':
      return 'manual';
    case 'proactive_threshold':
      return 'auto';
    case 'post_compact_recovery':
      return 'recovery';
  }
}

/**
 * Pure decision between warm `:seal` (hits hot KV cache on the live ACP session)
 * and cold `:seal` (reads plain-text Q&A from Loro without waking a cold/GC'd/degraded
 * 350k ACP session).
 */
export function chooseSessionRolloverSealMode(input: {
  readonly hasLiveSession: boolean;
  readonly hasLiveProcess: boolean;
  readonly degradedByNativeCompact?: boolean;
  readonly lastActivityMs?: number;
  readonly nowMs: number;
  readonly warmCacheTtlMs?: number;
}): SessionRolloverSealMode {
  if (!input.hasLiveSession || !input.hasLiveProcess) return 'cold';
  if (input.degradedByNativeCompact) return 'cold';
  const ttlMs = input.warmCacheTtlMs ?? SESSION_ROLLOVER_WARM_CACHE_TTL_MS;
  if (
    input.lastActivityMs !== undefined &&
    Number.isFinite(input.lastActivityMs) &&
    input.nowMs - input.lastActivityMs > ttlMs
  ) {
    return 'cold';
  }
  return 'warm';
}

type AnyConfigOption = AcpConfigOptionSummary | SessionConfigOption;

function isThoughtLevelConfigOption(option: { id: string; category?: string | null }): boolean {
  const id = option.id.trim().toLowerCase();
  return (
    option.category === 'thought_level' ||
    id === 'thought_level' ||
    id === 'reasoning_effort' ||
    id === 'effort'
  );
}

function isSelectGroup(
  entry: Extract<SessionConfigOption, { type: 'select' }>['options'][number]
): entry is SessionConfigSelectGroup {
  return 'group' in entry && Array.isArray(entry.options);
}

function extractSelectOptionValues(option: AnyConfigOption): string[] {
  if (option.type !== 'select') return [];
  const rawOptions = option.options as ReadonlyArray<{ value: string } | SessionConfigSelectGroup>;
  const values: string[] = [];
  for (const item of rawOptions) {
    if (
      isSelectGroup(item as Extract<SessionConfigOption, { type: 'select' }>['options'][number])
    ) {
      for (const child of (item as SessionConfigSelectGroup).options) {
        values.push(child.value);
      }
    } else if ('value' in item && typeof item.value === 'string') {
      values.push(item.value);
    }
  }
  return values;
}

/**
 * Temporarily lower `thought_level` / `reasoning_effort` / `effort` to `'low'`
 * for the silent `:renew` opening turn (eliminating 10-15s `xhigh` latency).
 *
 * Always captures the exact `restoreValue` (preferring explicit user config,
 * falling back to the runtime's advertised `currentValue`) so the caller can
 * explicitly restore the original setting before the user's real message M.
 * If the original value cannot be confirmed (or is already `'low'`), skips the
 * temporary override rather than leaking `'low'` into M.
 */
export function buildLowEffortRunConfigForRenew(
  userConfig: AcpSessionRunConfig,
  availableConfigOptions?: readonly AnyConfigOption[]
): {
  readonly config: AcpSessionRunConfig;
  readonly appliedLow: boolean;
  readonly overriddenKey?: string;
  readonly restoreValue?: AcpConfigOptionValue;
} {
  if (availableConfigOptions && availableConfigOptions.length > 0) {
    const thoughtOpt = availableConfigOptions.find(
      (opt) => opt.type === 'select' && isThoughtLevelConfigOption(opt)
    );
    if (!thoughtOpt) {
      return { config: userConfig, appliedLow: false };
    }
    const lowValue = extractSelectOptionValues(thoughtOpt).find(
      (value) => value.trim().toLowerCase() === 'low'
    );
    if (!lowValue) {
      return { config: userConfig, appliedLow: false };
    }
    const explicitUserValue = userConfig.configOptionValues?.[thoughtOpt.id];
    const runtimeCurrentValue =
      typeof thoughtOpt.currentValue === 'string' && thoughtOpt.currentValue.trim().length > 0
        ? thoughtOpt.currentValue
        : undefined;
    const restoreValue = explicitUserValue ?? runtimeCurrentValue;
    if (restoreValue === undefined) {
      return { config: userConfig, appliedLow: false };
    }
    if (typeof restoreValue === 'string' && restoreValue.trim().toLowerCase() === 'low') {
      return { config: userConfig, appliedLow: false };
    }
    return {
      config: {
        ...userConfig,
        configOptionValues: {
          ...userConfig.configOptionValues,
          [thoughtOpt.id]: lowValue,
        },
      },
      appliedLow: true,
      overriddenKey: thoughtOpt.id,
      restoreValue,
    };
  }

  const existingValues = userConfig.configOptionValues;
  if (!existingValues) {
    return { config: userConfig, appliedLow: false };
  }
  const thoughtKey = Object.keys(existingValues).find((key) =>
    isThoughtLevelConfigOption({ id: key })
  );
  if (!thoughtKey) {
    return { config: userConfig, appliedLow: false };
  }
  const current = existingValues[thoughtKey];
  if (current === undefined) {
    return { config: userConfig, appliedLow: false };
  }
  if (typeof current === 'string' && current.trim().toLowerCase() === 'low') {
    return { config: userConfig, appliedLow: false };
  }
  return {
    config: {
      ...userConfig,
      configOptionValues: {
        ...existingValues,
        [thoughtKey]: 'low' as AcpConfigOptionValue,
      },
    },
    appliedLow: true,
    overriddenKey: thoughtKey,
    restoreValue: current,
  };
}

const RENEW_MAX_CONFIRMATION_CHARS = 300;
const RENEW_REFUSAL_OR_ERROR_RE =
  /\b(?:i (?:cannot|can't|am unable to)|cannot comply|refuse(?:d)?|request failed|error:|api error|rate limit|quota exceeded|context length exceeded|authentication required)\b|无法(?:完成|处理|继续|执行)|拒绝|出错|鉴权失败|超出上下文/i;

/**
 * Validate a lazy `:renew` handoff response before committing the new node.
 * Requires `stopReason === 'end_turn'` and a concise, non-refusal visible
 * confirmation so truncated (`max_tokens`), refused, empty, or runaway
 * responses keep `pendingSwitch` intact for safe retry.
 */
export function isValidRolloverRenewConfirmation(
  stopReason: unknown,
  visibleText: string
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (stopReason !== 'end_turn') {
    if (stopReason === 'refusal') return { ok: false, reason: 'renew-refused' };
    if (stopReason === 'max_tokens') return { ok: false, reason: 'renew-truncated' };
    return {
      ok: false,
      reason: `renew-unexpected-stop:${typeof stopReason === 'string' ? stopReason : 'missing'}`,
    };
  }
  const trimmed = visibleText.trim();
  if (!trimmed) {
    return { ok: false, reason: 'renew-empty-output' };
  }
  if (trimmed.length > RENEW_MAX_CONFIRMATION_CHARS) {
    return { ok: false, reason: 'renew-unexpected-long-output' };
  }
  if (RENEW_REFUSAL_OR_ERROR_RE.test(trimmed)) {
    return { ok: false, reason: 'renew-refusal-or-error-output' };
  }
  return { ok: true };
}

export type SessionRolloverColdSummarizer = (args: {
  readonly sessionId: SessionId;
  readonly meta?: SessionMeta;
  readonly prompt: string;
  readonly signal?: AbortSignal;
}) => Promise<string | null>;

const COLD_ROLLOVER_SUMMARY_TIMEOUT_MS = 45_000;

/**
 * Production tool-free isolated cold summarizer for linear session rollover.
 *
 * Spawns a short-lived, completely isolated text-only ACP session via
 * `prepareBtwIsolation(..., readOnlyTools: false)`:
 * - empty temp workdir (`0o700`), provider-specific isolated config/args (no
 *   Antigravity `--dangerously-skip-permissions`, no Codex hooks/plugins/MCP,
 *   Claude safe mode, fail-closed `NMEM_*`)
 * - ACP `fs.readTextFile: false`, `fs.writeTextFile: false`, `terminal: false`,
 *   `disableBuiltinMcp: true`, and all permission requests unconditionally cancelled
 * - single bounded deadline + `AbortSignal` covering the ENTIRE lifecycle from
 *   launch config resolution and agent startup through `setSessionConfigOption`
 *   and `prompt()`, tearing down any spawned process and temp dirs in `finally`
 *   and returning `null` so `sealNode` degrades cleanly to `buildFallbackRolloverCard`.
 */
export function createIsolatedColdRolloverSummarizer(deps: {
  readonly workspaceDocument: LoroDocumentManager;
  readonly workspaceId: WorkspaceId;
  readonly machineId: MachineId;
  readonly logger: Logger;
  readonly timeoutMs?: number;
  readonly resolveLaunchConfig?: typeof resolveSessionLaunchConfig;
  readonly prepareIsolation?: typeof prepareBtwIsolation;
  readonly startAgent?: typeof startLocalAcpAgent;
  readonly shutdownAgent?: typeof shutdownLocalAcpAgent;
}): SessionRolloverColdSummarizer {
  const resolveLaunch = deps.resolveLaunchConfig ?? resolveSessionLaunchConfig;
  const prepareIsolation = deps.prepareIsolation ?? prepareBtwIsolation;
  const startAgent = deps.startAgent ?? startLocalAcpAgent;
  const shutdownAgent = deps.shutdownAgent ?? shutdownLocalAcpAgent;
  const timeoutMs = deps.timeoutMs ?? COLD_ROLLOVER_SUMMARY_TIMEOUT_MS;

  return async ({ sessionId, meta, prompt, signal }) => {
    if (signal?.aborted || !meta?.cliType || !meta.agentType) {
      return null;
    }

    const sessionLabel = `rollover-cold-seal:${meta.cliType}/${meta.agentType}`;
    const localAbort = new AbortController();
    let started: Awaited<ReturnType<typeof startLocalAcpAgent>> | undefined;
    let isolation: Awaited<ReturnType<typeof prepareBtwIsolation>> | undefined;
    let exitedLifecycle = false;

    let rejectAbort!: (reason: unknown) => void;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    // Prevent unhandled rejections if abort fires while no race awaits `abortPromise`.
    void abortPromise.catch(() => undefined);

    const triggerAbort = (reason: unknown): void => {
      if (!localAbort.signal.aborted) {
        localAbort.abort(reason);
      }
      if (started?.client) {
        void started.client.cancel(started.acpSessionId).catch(() => undefined);
      }
      rejectAbort(reason);
    };

    const onParentAbort = () =>
      triggerAbort(
        signal?.reason ?? new DOMException('Cold rollover summary aborted', 'AbortError')
      );
    signal?.addEventListener('abort', onParentAbort, { once: true });

    const timeoutHandle = setTimeout(() => {
      triggerAbort(new Error(`Cold rollover summary exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    timeoutHandle.unref?.();

    const raceAbort = async <T>(work: Promise<T>): Promise<T> => {
      if (localAbort.signal.aborted) {
        throw localAbort.signal.reason ?? new DOMException('Aborted', 'AbortError');
      }
      return await Promise.race([work, abortPromise]);
    };

    let collectedFinalText = '';
    let collectedUnphasedText = '';

    try {
      let launchConfig: Awaited<ReturnType<typeof resolveSessionLaunchConfig>>['config'];
      try {
        const resolved = await raceAbort(
          resolveLaunch({
            workspaceDocument: deps.workspaceDocument,
            workspaceId: deps.workspaceId,
            machineId: deps.machineId,
            sessionId,
            sessionMeta: meta,
            logger: deps.logger,
          })
        );
        launchConfig = resolved.config;
      } catch (error) {
        if (!localAbort.signal.aborted) {
          deps.logger.debug(
            `[${sessionId}] Cold rollover summarizer could not resolve launch config: ${formatError(error)}`
          );
        }
        return null;
      }

      const isolationPromise = prepareIsolation({
        cliType: meta.cliType,
        agentType: meta.agentType,
        readOnlyTools: false,
        sessionWorkdir: null,
        baseEnv: { ...process.env, ...launchConfig?.env },
        logger: deps.logger,
      });
      void isolationPromise.then(
        (lateIsolation) => {
          if (exitedLifecycle && isolation !== lateIsolation) {
            lateIsolation.cleanup();
          }
        },
        () => undefined
      );
      isolation = await raceAbort(isolationPromise);

      const startPromise = startAgent({
        cliType: meta.cliType,
        agentType: meta.agentType,
        customAcp: launchConfig?.customAcp,
        runtimeOverrides: launchConfig?.runtimeOverrides,
        agentConfigId: meta.agentConfigId,
        magpieGatewayUrl: launchConfig?.magpieGatewayUrl,
        workdir: isolation.workdir,
        env: { ...isolation.env, LODY_ROLLOVER_COLD_SEAL: '1' },
        envTransform: (childEnv) => ({
          ...isolation!.envTransform(childEnv),
          LODY_ROLLOVER_COLD_SEAL: '1',
        }),
        launchArgFilter: isolation.launchArgFilter,
        logger: deps.logger,
        terminalManager: isolation.terminalManager,
        terminalEnabled: false,
        readOnlyFs: true,
        disableReadTextFile: true,
        disableBuiltinMcp: true,
        signal: localAbort.signal,
        onUpdateMessage: (msg) => {
          const chunk = extractTitleChunkFromNotification(msg);
          if (!chunk) return;
          if (parseLodyMessagePhase(msg.update._meta) === 'final_answer') {
            collectedFinalText += chunk;
          } else {
            collectedUnphasedText += chunk;
          }
        },
        onRequestPermission: async (
          _requestId: string,
          _request: RequestPermissionRequest
        ): Promise<RequestPermissionResponse> => ({ outcome: { outcome: 'cancelled' } }),
        extraArgs: [],
      });
      void startPromise.then(
        (lateStarted) => {
          if (exitedLifecycle && started !== lateStarted) {
            void shutdownAgent({
              agentProcess: lateStarted.agentProcess,
              client: lateStarted.client,
              acpSessionId: lateStarted.acpSessionId,
              logger: deps.logger,
              sessionLabel,
            }).catch(() => undefined);
          }
        },
        () => undefined
      );
      started = await raceAbort(startPromise);

      // Lower thought_level to `low` when advertised so cold seal stays fast.
      const sessionOptions = (
        started.sessionResponse as { configOptions?: SessionConfigOption[] | null } | undefined
      )?.configOptions;
      if (sessionOptions && sessionOptions.length > 0 && started.client) {
        const thoughtOpt = sessionOptions.find(
          (opt) => opt.type === 'select' && isThoughtLevelConfigOption(opt)
        );
        const lowValue = thoughtOpt
          ? extractSelectOptionValues(thoughtOpt).find((v) => v.trim().toLowerCase() === 'low')
          : undefined;
        if (thoughtOpt && lowValue) {
          await raceAbort(
            started.client
              .setSessionConfigOption(started.acpSessionId, thoughtOpt.id, lowValue)
              .catch(() => undefined)
          );
        }
      }

      collectedFinalText = '';
      collectedUnphasedText = '';

      if (!started.client) return null;
      const response = await raceAbort(
        started.client.prompt(started.acpSessionId, [{ type: 'text', text: prompt }], {
          signal: localAbort.signal,
        })
      );
      if (localAbort.signal.aborted) return null;
      const stopReason = (response as { stopReason?: unknown } | undefined)?.stopReason;
      if (stopReason === 'cancelled' || stopReason === 'refusal') return null;
      const streamed = (collectedFinalText.trim() || collectedUnphasedText.trim()).trim();
      if (streamed) return streamed;
      const inline = extractTextFromAgentResponse(response)?.trim();
      return inline || null;
    } catch (error) {
      if (!signal?.aborted) {
        deps.logger.warn(
          `[${sessionId}] Isolated cold rollover summary failed; degrading to fallback: ${formatError(error)}`
        );
      }
      return null;
    } finally {
      exitedLifecycle = true;
      clearTimeout(timeoutHandle);
      signal?.removeEventListener('abort', onParentAbort);
      if (started) {
        await shutdownAgent({
          agentProcess: started.agentProcess,
          client: started.client,
          acpSessionId: started.acpSessionId,
          logger: deps.logger,
          sessionLabel,
        }).catch(() => undefined);
      }
      isolation?.cleanup();
    }
  };
}

export type SessionRolloverWorkspaceProber = (args: {
  readonly workdir?: string;
  readonly segmentEntries: readonly SessionHistoryInput[];
}) => Promise<SessionRolloverWorkspaceAnchor>;

export type SessionRolloverServiceOptions = {
  readonly store: SessionRolloverStore;
  readonly logger: Logger;
  readonly now?: () => number;
  readonly createRunId?: () => string;
  readonly warmCacheTtlMs?: number;
  readonly coldSummarizer?: SessionRolloverColdSummarizer;
  readonly probeWorkspace?: SessionRolloverWorkspaceProber;
};

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function defaultProbeWorkspace(args: {
  readonly workdir?: string;
  readonly segmentEntries: readonly SessionHistoryInput[];
}): Promise<SessionRolloverWorkspaceAnchor> {
  const recentFiles = extractRecentSegmentFiles(args.segmentEntries);
  const workdir = args.workdir?.trim();
  if (!workdir) {
    return { recentFiles };
  }

  let invariantsDocPath: string | undefined;
  for (const candidate of ['invariants.md', path.join('docs', 'invariants.md')]) {
    const fullPath = path.join(workdir, candidate);
    if (await fileExists(fullPath)) {
      invariantsDocPath = candidate;
      break;
    }
  }

  let gitBranch: string | undefined;
  let gitHead: string | undefined;
  try {
    const { stdout } = await runCommandTextLegacy({
      command: 'git',
      args: ['rev-parse', '--abbrev-ref', 'HEAD'],
      cwd: workdir,
      timeout: WORKSPACE_GIT_PROBE_TIMEOUT_MS,
      check: 'exit-0',
    });
    const branchOut = stdout.trim();
    if (branchOut) gitBranch = branchOut;
  } catch {
    // Non-git workspace or git unavailable; fail open.
  }
  try {
    const { stdout } = await runCommandTextLegacy({
      command: 'git',
      args: ['rev-parse', '--short', 'HEAD'],
      cwd: workdir,
      timeout: WORKSPACE_GIT_PROBE_TIMEOUT_MS,
      check: 'exit-0',
    });
    const headOut = stdout.trim();
    if (headOut) gitHead = headOut;
  } catch {
    // Non-git workspace or git unavailable; fail open.
  }

  return {
    cwd: workdir,
    ...(gitBranch ? { gitBranch } : {}),
    ...(gitHead ? { gitHead } : {}),
    ...(invariantsDocPath ? { invariantsDocPath } : {}),
    recentFiles,
  };
}

export type SessionRolloverWarmSealResult =
  | { readonly status: 'completed'; readonly text: string }
  | { readonly status: 'cancelled' }
  | { readonly status: 'failed'; readonly reason?: string };

export type SessionRolloverSealOutcome =
  | {
      readonly outcome: 'sealed';
      readonly runId: string;
      readonly nodeId: string;
      readonly generation: number;
      readonly quality: 'warm_llm' | 'cold_llm' | 'fallback';
      readonly mode: SessionRolloverSealMode;
    }
  | { readonly outcome: 'interrupted'; readonly runId: string }
  | { readonly outcome: 'failed'; readonly runId: string; readonly reason: string };

export type SessionRolloverRenewTurnResult =
  | {
      readonly status: 'completed';
      readonly newAcpSessionId: ACPSessionId;
      readonly usedAfter?: number;
    }
  | { readonly status: 'cancelled' }
  | { readonly status: 'failed'; readonly reason?: string; readonly error?: unknown };

export type SessionRolloverPreparedLazyRenew =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'recovered';
      readonly runId: string;
      readonly generation: number;
      readonly nodeId: string;
      readonly acpSessionId: ACPSessionId;
      readonly usedAfter?: number;
    }
  | {
      readonly kind: 'ready';
      readonly pending: SessionRolloverPendingSwitch;
      readonly baseNotice: SessionRolloverNoticeMeta;
      readonly stepTurnId: string;
      readonly openingPrompt: string;
    };

export type SessionRolloverLazyRenewOutcome =
  | { readonly switched: false; readonly reason: 'no_pending' }
  | {
      readonly switched: true;
      readonly recoveredFromCrash: boolean;
      readonly runId: string;
      readonly generation: number;
      readonly nodeId: string;
      readonly acpSessionId: ACPSessionId;
      readonly usedAfter?: number;
    }
  | {
      readonly switched: false;
      readonly reason: 'cancelled' | 'failed';
      readonly runId: string;
      readonly error?: unknown;
    };

const formatError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class SessionRolloverService {
  private readonly now: () => number;
  private readonly createRunId: () => string;
  private readonly warmCacheTtlMs: number;
  private readonly probeWorkspace: SessionRolloverWorkspaceProber;

  constructor(private readonly options: SessionRolloverServiceOptions) {
    this.now = options.now ?? (() => Date.now());
    this.createRunId = options.createRunId ?? (() => randomUUID());
    this.warmCacheTtlMs = options.warmCacheTtlMs ?? SESSION_ROLLOVER_WARM_CACHE_TTL_MS;
    this.probeWorkspace = options.probeWorkspace ?? defaultProbeWorkspace;
  }

  get store(): SessionRolloverStore {
    return this.options.store;
  }

  async getState(sessionId: SessionId): Promise<SessionRolloverState | undefined> {
    return await this.options.store.get(sessionId);
  }

  async hasPendingSwitch(sessionId: SessionId): Promise<boolean> {
    try {
      return Boolean((await this.options.store.get(sessionId))?.pendingSwitch);
    } catch (error) {
      this.options.logger.warn(
        `[${sessionId}] Failed to inspect pending session rollover switch: ${formatError(error)}`
      );
      return false;
    }
  }

  /**
   * Stamp the fresh ACP session created for an in-flight `:renew` attempt before
   * sending the opening prompt, so retry/crash logic distinguishes our own
   * failed `:renew` attempt from an external Edit & Resend ACP replacement.
   */
  async recordAttemptingRenewAcpSession(
    sessionId: SessionId,
    runId: string,
    acpSessionId: ACPSessionId
  ): Promise<void> {
    const nowMs = this.now();
    try {
      await this.options.store.update(sessionId, (latest) => {
        if (!latest?.pendingSwitch || latest.pendingSwitch.runId !== runId) return latest;
        return {
          ...latest,
          pendingSwitch: {
            ...latest.pendingSwitch,
            attemptingAcpSessionId: acpSessionId,
          },
          updatedAt: nowMs,
        };
      });
    } catch (error) {
      this.options.logger.debug(
        `[${sessionId}] Failed to stamp attemptingAcpSessionId before :renew prompt: ${formatError(error)}`
      );
    }
  }

  /**
   * Mark the active node as degraded after a mid-turn native auto-compaction.
   * Subsequent rollovers will skip waking/querying the degraded ACP session for
   * `:seal` and instead reconstruct from Loro plain text.
   */
  async markDegradedByNativeCompact(sessionId: SessionId): Promise<void> {
    const nowMs = this.now();
    try {
      await this.options.store.update(sessionId, (current) => {
        const base = current ?? createInitialSessionRolloverState(sessionId, nowMs);
        if (base.degradedByNativeCompact === true) return base;
        return {
          ...base,
          degradedByNativeCompact: true,
          updatedAt: nowMs,
        };
      });
    } catch (error) {
      this.options.logger.warn(
        `[${sessionId}] Failed to record degradedByNativeCompact flag: ${formatError(error)}`
      );
    }
  }

  /**
   * Anchor `usedAfterLastRollover` on the first turn after a `:renew` whose
   * provider deferred its initial `usage_update` until the next prompt.
   */
  async recordPostRolloverUsageBaseline(sessionId: SessionId, used: number): Promise<void> {
    if (!Number.isFinite(used) || used < 0) return;
    const nowMs = this.now();
    try {
      await this.options.store.update(sessionId, (current) => {
        if (!current || current.generation <= 0 || current.usedAfterLastRollover !== undefined) {
          return current;
        }
        return {
          ...current,
          usedAfterLastRollover: Math.floor(used),
          updatedAt: nowMs,
        };
      });
    } catch (error) {
      this.options.logger.debug(
        `[${sessionId}] Failed to anchor post-rollover usage baseline: ${formatError(error)}`
      );
    }
  }

  /**
   * Seal the current node into `stateCard + spine + pendingSwitch` and update
   * the `session_context_rollover` divider to `sealed` (Form B: does NOT open
   * the fresh ACP session until the user's next normal message arrives).
   */
  async sealNode(args: {
    readonly sessionId: SessionId;
    readonly meta: SessionMeta;
    readonly reason: SessionRolloverReason;
    readonly history: readonly SessionHistoryInput[];
    readonly excludeTurnId?: string;
    readonly userHint?: string;
    readonly usedBefore?: number;
    readonly hasLiveSession: boolean;
    readonly hasLiveProcess: boolean;
    readonly lastActivityMs?: number;
    readonly workdir?: string;
    readonly writeDivider: (
      runId: string,
      meta: SessionRolloverNoticeMeta,
      timestamp: string
    ) => Promise<void>;
    readonly runWarmSeal: (step: {
      readonly runId: string;
      readonly stepTurnId: string;
      readonly prompt: string;
    }) => Promise<SessionRolloverWarmSealResult>;
    readonly isCancelled?: () => boolean;
    readonly abortSignal?: AbortSignal;
  }): Promise<SessionRolloverSealOutcome> {
    const { sessionId, meta, reason, history, excludeTurnId, userHint } = args;
    const trigger = rolloverReasonToTrigger(reason);
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const runId = this.createRunId();

    let existingState: SessionRolloverState | undefined;
    try {
      existingState = await this.options.store.get(sessionId);
    } catch (error) {
      this.options.logger.warn(
        `[${sessionId}] Aborting rollover :seal because persisted rollover state could not be read: ${formatError(error)}`
      );
      return { outcome: 'failed', runId, reason: 'state-store-read-error' };
    }
    const current = existingState ?? createInitialSessionRolloverState(sessionId, nowMs);

    const originEntry = resolveOriginTurn(history, current.originTurnId);
    const originTurnId = current.originTurnId ?? originEntry?.id;

    const segmentEntries = sliceRolloverSegmentEntries(history, {
      afterTurnId: current.lastSealedTurnId,
      excludeTurnId,
    });
    const sealedThroughTurnId =
      segmentEntries.at(-1)?.id ??
      sliceRolloverSegmentEntries(history, { excludeTurnId }).at(-1)?.id ??
      current.lastSealedTurnId;

    const targetGen = current.generation + 1;
    const nodeId = formatRolloverNodeId(targetGen);
    const usedBefore = args.usedBefore ?? meta.contextWindowUsage?.used;

    const baseNotice: SessionRolloverNoticeMeta = {
      kind: 'linear_rollover',
      trigger,
      status: 'sealing',
      generation: targetGen,
      nodeId,
      ...(usedBefore !== undefined ? { usedBefore } : {}),
    };

    if (!sealedThroughTurnId) {
      await args.writeDivider(
        runId,
        { ...baseNotice, status: 'failed', reason: 'no-turns-to-seal' },
        nowIso
      );
      return { outcome: 'failed', runId, reason: 'no-turns-to-seal' };
    }

    await args.writeDivider(runId, baseNotice, nowIso);

    const mode = chooseSessionRolloverSealMode({
      hasLiveSession: args.hasLiveSession,
      hasLiveProcess: args.hasLiveProcess,
      degradedByNativeCompact: current.degradedByNativeCompact,
      lastActivityMs: args.lastActivityMs,
      nowMs,
      warmCacheTtlMs: this.warmCacheTtlMs,
    });

    const recentFiles = extractRecentSegmentFiles(segmentEntries);
    let sealParsed: { stateCard: SessionRolloverState['stateCard']; oneLiner: string } | null =
      null;
    let quality: SessionRolloverSpineItem['quality'] = 'fallback';

    const tryColdSummary = async (): Promise<'ok' | 'cancelled' | 'fallback'> => {
      if (args.isCancelled?.() || args.abortSignal?.aborted) return 'cancelled';
      const coldStream = buildColdTextStreamForSeal(segmentEntries);
      if (coldStream && this.options.coldSummarizer) {
        try {
          const coldPrompt = buildColdSealPrompt({
            previousCard: current.stateCard,
            generation: targetGen,
            coldTextStream: coldStream,
            recentFiles,
            userHint,
          });
          const rawCold = await this.options.coldSummarizer({
            sessionId,
            meta,
            prompt: coldPrompt,
            signal: args.abortSignal,
          });
          if (args.isCancelled?.() || args.abortSignal?.aborted) return 'cancelled';
          if (rawCold) {
            const parsed = parseRolloverSealJson(rawCold, current.stateCard);
            if (parsed) {
              sealParsed = parsed;
              quality = 'cold_llm';
              return 'ok';
            }
          }
        } catch (error) {
          if (args.isCancelled?.() || args.abortSignal?.aborted) return 'cancelled';
          this.options.logger.warn(
            `[${sessionId}] Cold rollover summary failed; using mechanical fallback: ${formatError(error)}`
          );
        }
      }
      return 'fallback';
    };

    if (mode === 'warm') {
      const warmPrompt = buildWarmSealPrompt({
        previousCard: current.stateCard,
        generation: targetGen,
        userHint,
      });
      let warmResult: SessionRolloverWarmSealResult;
      try {
        warmResult = await args.runWarmSeal({
          runId,
          stepTurnId: sessionRolloverStepId(runId, 'seal'),
          prompt: warmPrompt,
        });
      } catch (error) {
        if (args.isCancelled?.() || args.abortSignal?.aborted) {
          warmResult = { status: 'cancelled' };
        } else {
          this.options.logger.warn(
            `[${sessionId}] Warm rollover :seal threw; degrading to cold/fallback: ${formatError(error)}`
          );
          warmResult = { status: 'failed', reason: formatError(error) };
        }
      }

      if (warmResult.status === 'cancelled' || args.isCancelled?.() || args.abortSignal?.aborted) {
        await args.writeDivider(
          runId,
          { ...baseNotice, status: 'interrupted', reason: 'cancelled' },
          new Date(this.now()).toISOString()
        );
        return { outcome: 'interrupted', runId };
      }

      if (warmResult.status === 'completed') {
        const parsed = parseRolloverSealJson(warmResult.text, current.stateCard);
        if (parsed) {
          sealParsed = parsed;
          quality = 'warm_llm';
        } else {
          this.options.logger.warn(
            `[${sessionId}] Warm rollover :seal output was not parseable JSON; trying cold/fallback`
          );
        }
      }

      if (!sealParsed) {
        const coldStatus = await tryColdSummary();
        if (coldStatus === 'cancelled') {
          await args.writeDivider(
            runId,
            { ...baseNotice, status: 'interrupted', reason: 'cancelled' },
            new Date(this.now()).toISOString()
          );
          return { outcome: 'interrupted', runId };
        }
      }
    } else {
      const coldStatus = await tryColdSummary();
      if (coldStatus === 'cancelled') {
        await args.writeDivider(
          runId,
          { ...baseNotice, status: 'interrupted', reason: 'cancelled' },
          new Date(this.now()).toISOString()
        );
        return { outcome: 'interrupted', runId };
      }
    }

    if (!sealParsed) {
      sealParsed = buildFallbackRolloverCard({
        previousCard: current.stateCard,
        segmentEntries,
        originEntry,
        recentFiles,
        userHint,
      });
      quality = 'fallback';
    }

    if (args.isCancelled?.() || args.abortSignal?.aborted) {
      await args.writeDivider(
        runId,
        { ...baseNotice, status: 'interrupted', reason: 'cancelled' },
        new Date(this.now()).toISOString()
      );
      return { outcome: 'interrupted', runId };
    }

    const finishedMs = this.now();
    const finishedIso = new Date(finishedMs).toISOString();
    const userTurnCount = segmentEntries.filter((entry) => entry.role === 'user').length;
    const spineItem: SessionRolloverSpineItem = {
      gen: targetGen,
      nodeId,
      window: formatRolloverTimeWindow(
        segmentEntries[0]?.timestamp,
        segmentEntries.at(-1)?.timestamp ?? finishedIso
      ),
      startTurnId: segmentEntries[0]?.id ?? sealedThroughTurnId,
      endTurnId: sealedThroughTurnId,
      turnCount: userTurnCount > 0 ? userTurnCount : segmentEntries.length,
      oneLiner: sealParsed.oneLiner,
      quality,
    };

    const pendingSwitch: SessionRolloverPendingSwitch = {
      runId,
      targetGen,
      nodeId,
      reason,
      ...(meta.acpSessionId ? { sourceAcpSessionId: meta.acpSessionId } : {}),
      sealedThroughTurnId,
      sealedAtMs: finishedMs,
      ...(usedBefore !== undefined ? { usedBefore } : {}),
      ...(userHint?.trim() ? { userHint: userHint.trim() } : {}),
      ...(originTurnId && !current.originTurnId ? { candidateOriginTurnId: originTurnId } : {}),
      candidateStateCard: sealParsed.stateCard,
      candidateSpineItem: spineItem,
    };

    try {
      await this.options.store.update(sessionId, (latest) => {
        const base = latest ?? createInitialSessionRolloverState(sessionId, finishedMs);
        // Stage candidate stateCard/spineItem strictly inside `pendingSwitch`
        // so committed state remains untouched until lazy `:renew` succeeds.
        return {
          ...base,
          pendingSwitch,
          updatedAt: finishedMs,
        };
      });
    } catch (error) {
      await args.writeDivider(
        runId,
        { ...baseNotice, status: 'failed', reason: 'state-store-error' },
        finishedIso
      );
      return { outcome: 'failed', runId, reason: formatError(error) };
    }

    // Re-check cancellation right after persistence: if Stop or a new user turn
    // preempted during the disk write, roll back the just-armed pendingSwitch
    // and emit a silent interrupted divider so the old session continues cleanly.
    if (args.isCancelled?.() || args.abortSignal?.aborted) {
      await this.options.store
        .update(sessionId, (latest) => {
          if (!latest?.pendingSwitch || latest.pendingSwitch.runId !== runId) return latest;
          const { pendingSwitch: _rolledBack, ...rest } = latest;
          return {
            ...rest,
            updatedAt: this.now(),
          };
        })
        .catch(() => undefined);
      await args.writeDivider(
        runId,
        { ...baseNotice, status: 'interrupted', reason: 'cancelled' },
        new Date(this.now()).toISOString()
      );
      return { outcome: 'interrupted', runId };
    }

    await args.writeDivider(runId, { ...baseNotice, status: 'sealed' }, finishedIso);
    return {
      outcome: 'sealed',
      runId,
      nodeId,
      generation: targetGen,
      quality,
      mode,
    };
  }

  /**
   * Discard an unactivated `pendingSwitch` (and its staged candidate stateCard /
   * spineItem) when the old ACP session continues handling ordinary turns or
   * history is rewritten, ensuring subsequent seals include the new turns and
   * never inherit invalidated candidate state.
   */
  async invalidatePendingSwitch(args: {
    readonly sessionId: SessionId;
    readonly reason: string;
    readonly writeDivider: (
      runId: string,
      meta: SessionRolloverNoticeMeta,
      timestamp: string
    ) => Promise<void>;
  }): Promise<boolean> {
    const { sessionId, reason } = args;
    let pending: SessionRolloverPendingSwitch | undefined;
    try {
      pending = (await this.options.store.get(sessionId))?.pendingSwitch;
    } catch (error) {
      this.options.logger.warn(
        `[${sessionId}] Could not read rollover state while invalidating pendingSwitch: ${formatError(error)}`
      );
      return false;
    }
    if (!pending) return false;
    const nowIso = new Date(this.now()).toISOString();
    await this.options.store
      .update(sessionId, (latest) => {
        if (!latest?.pendingSwitch || latest.pendingSwitch.runId !== pending!.runId) return latest;
        const { pendingSwitch: _cleared, ...rest } = latest;
        return {
          ...rest,
          ...(reason === 'superseded-by-live-turn' && pending!.reason === 'post_compact_recovery'
            ? { degradedByNativeCompact: true }
            : {}),
          updatedAt: this.now(),
        };
      })
      .catch((error) => {
        this.options.logger.warn(
          `[${sessionId}] Failed to clear invalidated rollover pendingSwitch: ${formatError(error)}`
        );
      });
    await args
      .writeDivider(
        pending.runId,
        {
          kind: 'linear_rollover',
          trigger: rolloverReasonToTrigger(pending.reason),
          status: 'interrupted',
          generation: pending.targetGen,
          nodeId: pending.nodeId,
          ...(pending.usedBefore !== undefined ? { usedBefore: pending.usedBefore } : {}),
          reason,
        },
        nowIso
      )
      .catch(() => undefined);
    return true;
  }

  /**
   * Prepare lazy `:renew` (checking crash-recovery convergence first and building
   * the bounded opening prompt). Used by both `executeLazyRenew` and Effect-native
   * orchestration inside `SessionExecutionService`.
   */
  async prepareLazyRenew(args: {
    readonly sessionId: SessionId;
    readonly meta: SessionMeta;
    readonly history: readonly SessionHistoryInput[];
    readonly workdir?: string;
    readonly writeDivider: (
      runId: string,
      meta: SessionRolloverNoticeMeta,
      timestamp: string
    ) => Promise<void>;
    readonly clearBoardCompactPending: () => Promise<void>;
  }): Promise<SessionRolloverPreparedLazyRenew> {
    const { sessionId, meta, history } = args;
    let state: SessionRolloverState | undefined;
    try {
      state = await this.options.store.get(sessionId);
    } catch (error) {
      this.options.logger.warn(
        `[${sessionId}] Skipping lazy rollover :renew because rollover state could not be read: ${formatError(error)}`
      );
      return { kind: 'none' };
    }
    const pending = state?.pendingSwitch;
    if (!state || !pending) {
      return { kind: 'none' };
    }

    const trigger = rolloverReasonToTrigger(pending.reason);
    const nowIso = new Date(this.now()).toISOString();
    const baseNotice: SessionRolloverNoticeMeta = {
      kind: 'linear_rollover',
      trigger,
      status: 'switching',
      generation: pending.targetGen,
      nodeId: pending.nodeId,
      ...(pending.usedBefore !== undefined ? { usedBefore: pending.usedBefore } : {}),
    };

    // Crash recovery convergence: `:renew` already succeeded on this ACP session
    // before the previous daemon exited, so finalize state & divider without re-opening.
    if (pending.preparedAcpSessionId && meta.acpSessionId === pending.preparedAcpSessionId) {
      const usedAfter = meta.contextWindowUsage?.used;
      await args.writeDivider(
        pending.runId,
        {
          ...baseNotice,
          status: 'done',
          ...(usedAfter !== undefined ? { usedAfter } : {}),
        },
        nowIso
      );
      await args.clearBoardCompactPending();
      await this.commitPendingSwitch(sessionId, pending, pending.preparedAcpSessionId, usedAfter);
      return {
        kind: 'recovered',
        runId: pending.runId,
        generation: pending.targetGen,
        nodeId: pending.nodeId,
        acpSessionId: pending.preparedAcpSessionId as ACPSessionId,
        ...(usedAfter !== undefined ? { usedAfter } : {}),
      };
    }

    // Hard validity check before retiring/switching: if Edit & Resend rewrote
    // history (removing `sealedThroughTurnId`) or already replaced `meta.acpSessionId`
    // with an unrelated ACP session, invalidate the stale `pendingSwitch` and let
    // the edited message run directly on its prepared ACP session.
    const sealedEndpointExists = history.some((entry) => entry.id === pending.sealedThroughTurnId);
    const acpReplacedExternally = Boolean(
      pending.sourceAcpSessionId &&
      meta.acpSessionId &&
      meta.acpSessionId !== pending.sourceAcpSessionId &&
      meta.acpSessionId !== pending.attemptingAcpSessionId
    );
    if (!sealedEndpointExists || acpReplacedExternally) {
      this.options.logger.info(
        `[${sessionId}] Invalidating stale rollover pendingSwitch (${pending.runId}): sealedEndpointExists=${sealedEndpointExists} acpReplacedExternally=${acpReplacedExternally}`
      );
      await this.options.store
        .update(sessionId, (latest) => {
          if (!latest?.pendingSwitch || latest.pendingSwitch.runId !== pending.runId) return latest;
          const { pendingSwitch: _stale, ...rest } = latest;
          return {
            ...rest,
            updatedAt: this.now(),
          };
        })
        .catch((error) => {
          this.options.logger.warn(
            `[${sessionId}] Failed to clear stale rollover pendingSwitch: ${formatError(error)}`
          );
        });
      await args.writeDivider(
        pending.runId,
        { ...baseNotice, status: 'interrupted', reason: 'history-rewritten' },
        nowIso
      );
      return { kind: 'none' };
    }

    await args.writeDivider(pending.runId, baseNotice, nowIso);

    const segmentEntries = sliceRolloverSegmentEntries(history, {
      afterTurnId: state.lastSealedTurnId,
      throughTurnId: pending.sealedThroughTurnId,
    });
    const workspaceAnchor = await this.probeWorkspace({
      workdir: args.workdir,
      segmentEntries,
    });
    const effectiveStateCard = pending.candidateStateCard ?? state.stateCard;
    const effectiveSpine = pending.candidateSpineItem
      ? [
          ...state.spine.filter((item) => item.gen !== pending.targetGen),
          pending.candidateSpineItem,
        ].slice(-SESSION_ROLLOVER_MAX_SPINE_ENTRIES)
      : state.spine;
    const effectiveOriginTurnId = state.originTurnId ?? pending.candidateOriginTurnId;
    const rolloverStateFilePath = this.options.store.getStateFilePath?.(sessionId);
    const openingPrompt = buildLinearRolloverOpening({
      sessionId,
      generation: pending.targetGen,
      nodeId: pending.nodeId,
      history,
      originTurnId: effectiveOriginTurnId,
      previousLastSealedTurnId: state.lastSealedTurnId,
      sealedThroughTurnId: pending.sealedThroughTurnId,
      stateCard: effectiveStateCard,
      spine: effectiveSpine,
      workspace: workspaceAnchor,
      ...(rolloverStateFilePath ? { rolloverStateFilePath } : {}),
      nowIso,
      usedBefore: pending.usedBefore,
      userHint: pending.userHint,
    });

    return {
      kind: 'ready',
      pending,
      baseNotice,
      stepTurnId: sessionRolloverStepId(pending.runId, 'renew'),
      openingPrompt,
    };
  }

  /**
   * Settle a prepared lazy `:renew` attempt. On failure or cancellation,
   * `pendingSwitch` is NEVER cleared so a subsequent retry can switch cleanly.
   */
  async finishLazyRenew(args: {
    readonly sessionId: SessionId;
    readonly prepared: Extract<SessionRolloverPreparedLazyRenew, { kind: 'ready' }>;
    readonly result: SessionRolloverRenewTurnResult;
    readonly writeDivider: (
      runId: string,
      meta: SessionRolloverNoticeMeta,
      timestamp: string
    ) => Promise<void>;
    readonly clearBoardCompactPending: () => Promise<void>;
  }): Promise<SessionRolloverLazyRenewOutcome> {
    const { sessionId, prepared, result } = args;
    const { pending, baseNotice } = prepared;

    if (result.status !== 'completed') {
      // CRITICAL: never clear `pendingSwitch` on failure or cancellation.
      const terminalStatus = result.status === 'cancelled' ? 'interrupted' : 'failed';
      await args.writeDivider(
        pending.runId,
        {
          ...baseNotice,
          status: terminalStatus,
          reason: result.status === 'cancelled' ? 'cancelled' : (result.reason ?? 'renew-failed'),
        },
        new Date(this.now()).toISOString()
      );
      return {
        switched: false,
        reason: result.status === 'cancelled' ? 'cancelled' : 'failed',
        runId: pending.runId,
        ...(result.status === 'failed' ? { error: result.error } : {}),
      };
    }

    // Phase 1 of commit: record `preparedAcpSessionId` before final divider/cleanup
    // so a crash between here and commit converges cleanly without duplicate `:renew`.
    const preparedAt = this.now();
    await this.options.store
      .update(sessionId, (latest) => {
        if (!latest?.pendingSwitch || latest.pendingSwitch.runId !== pending.runId) return latest;
        return {
          ...latest,
          pendingSwitch: {
            ...latest.pendingSwitch,
            preparedAcpSessionId: result.newAcpSessionId,
          },
          updatedAt: preparedAt,
        };
      })
      .catch((error) => {
        this.options.logger.warn(
          `[${sessionId}] Failed to stamp preparedAcpSessionId before commit: ${formatError(error)}`
        );
      });

    await args.writeDivider(
      pending.runId,
      {
        ...baseNotice,
        status: 'done',
        ...(result.usedAfter !== undefined ? { usedAfter: result.usedAfter } : {}),
      },
      new Date(this.now()).toISOString()
    );
    await args.clearBoardCompactPending();
    await this.commitPendingSwitch(sessionId, pending, result.newAcpSessionId, result.usedAfter);

    return {
      switched: true,
      recoveredFromCrash: false,
      runId: pending.runId,
      generation: pending.targetGen,
      nodeId: pending.nodeId,
      acpSessionId: result.newAcpSessionId,
      ...(result.usedAfter !== undefined ? { usedAfter: result.usedAfter } : {}),
    };
  }

  /**
   * Form B lazy `:renew` before the user's next ordinary message.
   *
   * Crash-recovery contract:
   * - If `pendingSwitch.preparedAcpSessionId === meta.acpSessionId`, `:renew`
   *   already completed before a crash -> commit immediately without duplicating
   *   the opening turn.
   * - If `:renew` fails or is cancelled before completing, `pendingSwitch` is
   *   NEVER cleared so the next retry switches cleanly.
   */
  async executeLazyRenew(args: {
    readonly sessionId: SessionId;
    readonly meta: SessionMeta;
    readonly history: readonly SessionHistoryInput[];
    readonly workdir?: string;
    readonly writeDivider: (
      runId: string,
      meta: SessionRolloverNoticeMeta,
      timestamp: string
    ) => Promise<void>;
    readonly retireOldSession: () => Promise<void>;
    readonly runFreshRenewTurn: (step: {
      readonly runId: string;
      readonly stepTurnId: string;
      readonly openingPrompt: string;
    }) => Promise<SessionRolloverRenewTurnResult>;
    readonly clearBoardCompactPending: () => Promise<void>;
  }): Promise<SessionRolloverLazyRenewOutcome> {
    const prepared = await this.prepareLazyRenew(args);
    if (prepared.kind === 'none') {
      return { switched: false, reason: 'no_pending' };
    }
    if (prepared.kind === 'recovered') {
      return {
        switched: true,
        recoveredFromCrash: true,
        runId: prepared.runId,
        generation: prepared.generation,
        nodeId: prepared.nodeId,
        acpSessionId: prepared.acpSessionId,
        ...(prepared.usedAfter !== undefined ? { usedAfter: prepared.usedAfter } : {}),
      };
    }

    await args.retireOldSession();

    let renewResult: SessionRolloverRenewTurnResult;
    try {
      renewResult = await args.runFreshRenewTurn({
        runId: prepared.pending.runId,
        stepTurnId: prepared.stepTurnId,
        openingPrompt: prepared.openingPrompt,
      });
    } catch (error) {
      renewResult = { status: 'failed', reason: formatError(error), error };
    }

    return await this.finishLazyRenew({
      sessionId: args.sessionId,
      prepared,
      result: renewResult,
      writeDivider: args.writeDivider,
      clearBoardCompactPending: args.clearBoardCompactPending,
    });
  }

  private async commitPendingSwitch(
    sessionId: SessionId,
    pending: SessionRolloverPendingSwitch,
    acpSessionId: string,
    usedAfter?: number
  ): Promise<void> {
    const committedAt = this.now();
    await this.options.store.update(sessionId, (latest) => {
      const base = latest ?? createInitialSessionRolloverState(sessionId, committedAt);
      const { pendingSwitch: _cleared, ...rest } = base;
      const committedOriginTurnId = base.originTurnId ?? pending.candidateOriginTurnId;
      const committedStateCard = pending.candidateStateCard ?? base.stateCard;
      const committedSpine = pending.candidateSpineItem
        ? [
            ...base.spine.filter((item) => item.gen !== pending.targetGen),
            pending.candidateSpineItem,
          ].slice(-SESSION_ROLLOVER_MAX_SPINE_ENTRIES)
        : base.spine;
      return {
        ...rest,
        ...(committedOriginTurnId ? { originTurnId: committedOriginTurnId } : {}),
        generation: pending.targetGen,
        activeAcpSessionId: acpSessionId,
        lastSealedTurnId: pending.sealedThroughTurnId,
        stateCard: committedStateCard,
        spine: committedSpine,
        ...(usedAfter !== undefined ? { usedAfterLastRollover: usedAfter } : {}),
        degradedByNativeCompact: false,
        updatedAt: committedAt,
      };
    });
  }

  /**
   * Hard Trap #2 defense: when native ACP `loadSession`/`resumeSession` fails on a
   * session that has already rolled over, replay ONLY the bounded current-node
   * opening plus ordinary turns strictly after `state.lastSealedTurnId` — never
   * dumping 100k of pre-rollover history back into the model.
   */
  async buildRolloverRecoveryReplay(args: {
    readonly sessionId: SessionId;
    readonly history: readonly SessionHistoryInput[];
    readonly excludeTurnId?: string;
    readonly workdir?: string;
  }): Promise<ReplayPromptResult | null> {
    const state = await this.options.store.get(args.sessionId);
    if (!state || state.generation <= 0 || !state.lastSealedTurnId) {
      return null;
    }

    const nowIso = new Date(this.now()).toISOString();
    const currentNodeId = state.spine.at(-1)?.nodeId ?? formatRolloverNodeId(state.generation);
    const previousLastSealedTurnId =
      state.spine.length >= 2 ? state.spine[state.spine.length - 2]?.endTurnId : undefined;
    const segmentEntries = sliceRolloverSegmentEntries(args.history, {
      afterTurnId: previousLastSealedTurnId,
      throughTurnId: state.lastSealedTurnId,
    });
    const workspaceAnchor = await this.probeWorkspace({
      workdir: args.workdir,
      segmentEntries,
    });
    const rolloverStateFilePath = this.options.store.getStateFilePath?.(args.sessionId);
    const opening = buildLinearRolloverOpening({
      sessionId: args.sessionId,
      generation: state.generation,
      nodeId: currentNodeId,
      history: args.history,
      originTurnId: state.originTurnId,
      previousLastSealedTurnId,
      sealedThroughTurnId: state.lastSealedTurnId,
      stateCard: state.stateCard,
      spine: state.spine,
      workspace: workspaceAnchor,
      ...(rolloverStateFilePath ? { rolloverStateFilePath } : {}),
      nowIso,
    });

    const postDelta = buildReplayPromptFromHistory({
      history: [...args.history],
      afterTurnId: state.lastSealedTurnId,
      excludeTurnId: args.excludeTurnId,
    });

    const promptText =
      postDelta.stats.messagesIncluded > 0 ? `${opening}\n\n${postDelta.promptText}` : opening;

    return {
      promptText,
      stats: {
        ...postDelta.stats,
        usedChars: promptText.length,
        messagesIncluded: Math.max(1, postDelta.stats.messagesIncluded),
      },
      noticeMeta: postDelta.noticeMeta,
    };
  }
}
