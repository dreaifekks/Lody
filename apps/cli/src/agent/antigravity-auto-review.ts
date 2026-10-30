import type * as acp from '@agentclientprotocol/sdk';
import type { AnyMessage } from '@agentclientprotocol/sdk';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { ANTIGRAVITY_AGENT_TYPE, ANTIGRAVITY_AUTO_REVIEW_MODE_ID } from '@lody/shared';
import { formatErrorMessage } from '@/utils/format-error';
import type { Logger } from '@/utils/logger';
import {
  classifyAntigravityPermission,
  readAntigravityCommand,
  type AutoReviewToolCall,
} from './antigravity-auto-review-rules';
import {
  createAntigravityReviewer,
  untilAborted,
  type AutoReviewer,
  type AutoReviewLaunch,
} from './antigravity-auto-review-reviewer';

/**
 * LAN fork: Antigravity Auto Review, a permission mode Lody adds to the
 * `antigravity-acp` registry agent. `agy_acp_server` (1.4.x) offers only
 * `default` (every step asks), `auto_edit` (also approves edits outside the
 * workspace, unasked) and `yolo`; its terminal CLI's reviewer-backed Auto mode
 * is not exposed over ACP.
 *
 * This module sits on the ACP stream between `AgentClient` and the agent
 * process, so the rest of Lody sees an ordinary mode:
 * - `auto_review` is added to the agent's modes and `mode` option. Selecting it
 *   (set_mode, set_config_option, `_meta.lody.sessionConfig` at session start)
 *   sends `default` to the agent; answers report `auto_review` back while the
 *   agent is in `default`.
 * - In that mode each `session/request_permission` is decided here before it
 *   can reach the user: rule-based ask (destructive, credentials, system
 *   configuration) → rule-based allow (reads, edits inside the workspace,
 *   read-only commands) → the reviewer model (see the reviewer module). A
 *   reviewer `ask`, an error or a timeout hands the request to the user
 *   unchanged; nothing is ever denied here. After several reviewer refusals in
 *   one turn, the rest of the turn asks the user directly.
 * - Every reviewer decision is written to the conversation as a `think` tool
 *   call titled "Auto Review", the way Codex shows its Guardian Review.
 *
 * Applied in `session.ts` (sessions) and `acp-runner.ts` (capability probes and
 * other local starts), the two places an ACP stream is built for an agent.
 */

export type AntigravityAutoReviewOptions = {
  agentType: string;
  logger: Logger;
  label: string;
  /** How the session's agent was started; the reviewer is started the same way. */
  launch?: AutoReviewLaunch;
  /** Tests inject a reviewer, a clock and the repository check. */
  createReviewer?: () => AutoReviewer;
  isGitRepository?: (directory: string) => Promise<boolean>;
  reviewTimeoutMs?: number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
};

const UNDERLYING_MODE_ID = 'default';
export const AUTO_REVIEW_TIMEOUT_MS = 15_000;
/** Consecutive reviewer refusals (ask, error, timeout) in a turn before it stops reviewing. */
export const AUTO_REVIEW_CIRCUIT_BREAKER_LIMIT = 3;
/** A user message this short is read together with the agent's question before it. */
const SHORT_USER_MESSAGE_CHARS = 40;
const AGENT_TEXT_LIMIT = 4000;

export const ANTIGRAVITY_AUTO_REVIEW_MODE = {
  id: ANTIGRAVITY_AUTO_REVIEW_MODE_ID,
  name: 'Auto Review',
  description:
    "Reviewed by Lody: reads, edits inside the workspace and read-only commands run; Lody's Gemini Flash reviewer approves other actions; destructive or uncertain ones ask you.",
};

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type SessionState = {
  roots: string[];
  active: boolean;
  userMessage: string;
  previousAgentMessage: string;
  agentText: string;
  refusals: number;
  /**
   * Actions the reviewer approved in this turn, by their exact input. A repeat
   * (the agent's build/test loop) runs without another review; the user's next
   * message clears it, since an approval answers that message only.
   */
  approved: Map<string, string>;
  breakerNoticed: boolean;
  inFlight: Map<string | number, AbortController>;
  auditSeq: number;
};

type PendingRequest =
  | { kind: 'session'; roots: string[]; requestedMode: string | undefined; sessionId?: string }
  | { kind: 'mode'; sessionId: string; target: string };

const textOf = (blocks: unknown): string =>
  Array.isArray(blocks)
    ? blocks
        .map((block) =>
          isRecord(block) && block.type === 'text' && typeof block.text === 'string'
            ? block.text
            : ''
        )
        .join('')
    : '';

/** Adds Auto Review after `auto_edit` in an agent-reported mode list or option list. */
const withAutoReviewMode = <T>(entries: T[], make: () => T, idOf: (entry: T) => unknown): T[] => {
  if (!entries.some((entry) => idOf(entry) === UNDERLYING_MODE_ID)) return entries;
  if (entries.some((entry) => idOf(entry) === ANTIGRAVITY_AUTO_REVIEW_MODE_ID)) return entries;
  const anchor = entries.findIndex((entry) => idOf(entry) === 'auto_edit');
  const at = anchor >= 0 ? anchor + 1 : entries.length;
  return [...entries.slice(0, at), make(), ...entries.slice(at)];
};

async function findGitRepository(start: string): Promise<boolean> {
  let current = path.resolve(start);
  for (;;) {
    if (
      await stat(path.join(current, '.git')).then(
        () => true,
        () => false
      )
    )
      return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export function withAntigravityAutoReview(
  stream: acp.Stream,
  options: AntigravityAutoReviewOptions
): acp.Stream {
  if (options.agentType !== ANTIGRAVITY_AGENT_TYPE) return stream;
  const { logger, label } = options;
  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? clearTimeout;
  const reviewTimeoutMs = options.reviewTimeoutMs ?? AUTO_REVIEW_TIMEOUT_MS;
  const sessions = new Map<string, SessionState>();
  const pending = new Map<string | number, PendingRequest>();
  let reviewer: AutoReviewer | null = null;
  let toAgent: TransformStreamDefaultController<AnyMessage> | null = null;
  let toClient: TransformStreamDefaultController<AnyMessage> | null = null;

  const getReviewer = (): AutoReviewer | null => {
    if (reviewer) return reviewer;
    if (options.createReviewer) reviewer = options.createReviewer();
    else if (options.launch)
      reviewer = createAntigravityReviewer({ launch: options.launch, logger, label });
    return reviewer;
  };

  const send = (
    controller: TransformStreamDefaultController<AnyMessage> | null,
    message: AnyMessage
  ) => {
    try {
      controller?.enqueue(message);
    } catch (error) {
      logger.debug(
        `[${label}] Auto Review could not deliver a message: ${formatErrorMessage(error)}`
      );
    }
  };

  const stateFor = (sessionId: string, roots: string[] = []): SessionState => {
    let state = sessions.get(sessionId);
    if (!state) {
      state = {
        roots,
        active: false,
        userMessage: '',
        previousAgentMessage: '',
        agentText: '',
        refusals: 0,
        approved: new Map(),
        breakerNoticed: false,
        inFlight: new Map(),
        auditSeq: 0,
      };
      sessions.set(sessionId, state);
    } else if (roots.length > 0) {
      state.roots = roots;
    }
    return state;
  };

  const setActive = (state: SessionState, active: boolean) => {
    if (active && !state.active) getReviewer()?.prewarm();
    // Leaving Auto Review voids the reviews under way: their requests go to the user.
    if (!active && state.active)
      for (const controller of state.inFlight.values()) controller.abort(new Error('mode changed'));
    state.active = active;
  };

  /** Agent-reported mode state, with Auto Review added and reported as current while active. */
  const presentModes = (modes: unknown, state: SessionState | undefined): unknown => {
    if (!isRecord(modes) || !Array.isArray(modes.availableModes)) return modes;
    const availableModes = withAutoReviewMode(
      modes.availableModes as unknown[],
      () => ({ ...ANTIGRAVITY_AUTO_REVIEW_MODE }),
      (mode) => (isRecord(mode) ? mode.id : undefined)
    );
    const current = state?.active && modes.currentModeId === UNDERLYING_MODE_ID;
    return {
      ...modes,
      availableModes,
      ...(current ? { currentModeId: ANTIGRAVITY_AUTO_REVIEW_MODE_ID } : {}),
    };
  };

  const presentConfigOptions = (
    configOptions: unknown,
    state: SessionState | undefined
  ): unknown => {
    if (!Array.isArray(configOptions)) return configOptions;
    return configOptions.map((option) => {
      if (!isRecord(option) || option.category !== 'mode' || !Array.isArray(option.options))
        return option;
      if (state && option.currentValue !== UNDERLYING_MODE_ID) setActive(state, false);
      const choices = withAutoReviewMode(
        option.options as unknown[],
        () => ({
          value: ANTIGRAVITY_AUTO_REVIEW_MODE.id,
          name: ANTIGRAVITY_AUTO_REVIEW_MODE.name,
          description: ANTIGRAVITY_AUTO_REVIEW_MODE.description,
        }),
        (entry) => (isRecord(entry) ? entry.value : undefined)
      );
      const current = state?.active && option.currentValue === UNDERLYING_MODE_ID;
      return {
        ...option,
        options: choices,
        ...(current ? { currentValue: ANTIGRAVITY_AUTO_REVIEW_MODE_ID } : {}),
      };
    });
  };

  const presentResult = (result: Json, state: SessionState | undefined): Json => ({
    ...result,
    ...('modes' in result ? { modes: presentModes(result.modes, state) } : {}),
    ...('configOptions' in result
      ? { configOptions: presentConfigOptions(result.configOptions, state) }
      : {}),
  });

  // ---- client → agent ----

  const rewriteStartMeta = (params: Json): { params: Json; requestedMode: string | undefined } => {
    const meta = isRecord(params._meta) ? params._meta : undefined;
    const lody = isRecord(meta?.lody) ? meta.lody : undefined;
    const sessionConfig = isRecord(lody?.sessionConfig) ? lody.sessionConfig : undefined;
    const values = isRecord(sessionConfig?.configOptionValues)
      ? sessionConfig.configOptionValues
      : undefined;
    const requestedMode = typeof values?.mode === 'string' ? values.mode : undefined;
    if (
      requestedMode !== ANTIGRAVITY_AUTO_REVIEW_MODE_ID ||
      !meta ||
      !lody ||
      !sessionConfig ||
      !values
    ) {
      return { params, requestedMode };
    }
    return {
      requestedMode,
      params: {
        ...params,
        _meta: {
          ...meta,
          lody: {
            ...lody,
            sessionConfig: {
              ...sessionConfig,
              configOptionValues: { ...values, mode: UNDERLYING_MODE_ID },
            },
          },
        },
      },
    };
  };

  const fromClient = (message: AnyMessage): AnyMessage => {
    if (!('method' in message) || !isRecord(message.params)) return message;
    const params = message.params;
    const id = 'id' in message ? message.id : undefined;
    switch (message.method) {
      case 'session/new':
      case 'session/load':
      case 'session/resume':
      case 'session/fork':
      case 'unstable/session/fork': {
        const cwd = typeof params.cwd === 'string' ? params.cwd : undefined;
        const extra = Array.isArray(params.additionalDirectories)
          ? params.additionalDirectories.filter((dir): dir is string => typeof dir === 'string')
          : [];
        const rewritten = rewriteStartMeta(params);
        if (id !== undefined && id !== null) {
          pending.set(id, {
            kind: 'session',
            roots: cwd ? [cwd, ...extra] : extra,
            requestedMode: rewritten.requestedMode,
            ...(message.method === 'session/new' || typeof params.sessionId !== 'string'
              ? {}
              : { sessionId: params.sessionId }),
          });
        }
        return { ...message, params: rewritten.params };
      }
      case 'session/set_mode':
      case 'session/set_config_option': {
        const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined;
        const isMode = message.method === 'session/set_mode' || params.configId === 'mode';
        const target = message.method === 'session/set_mode' ? params.modeId : params.value;
        if (!sessionId || !isMode || typeof target !== 'string') return message;
        if (id !== undefined && id !== null) pending.set(id, { kind: 'mode', sessionId, target });
        if (target !== ANTIGRAVITY_AUTO_REVIEW_MODE_ID) return message;
        return message.method === 'session/set_mode'
          ? { ...message, params: { ...params, modeId: UNDERLYING_MODE_ID } }
          : { ...message, params: { ...params, value: UNDERLYING_MODE_ID } };
      }
      case 'session/prompt': {
        if (typeof params.sessionId !== 'string') return message;
        const state = stateFor(params.sessionId);
        state.previousAgentMessage = state.agentText;
        state.agentText = '';
        state.userMessage = textOf(params.prompt);
        state.refusals = 0;
        state.breakerNoticed = false;
        state.approved.clear();
        return message;
      }
      case 'session/cancel': {
        const state =
          typeof params.sessionId === 'string' ? sessions.get(params.sessionId) : undefined;
        for (const controller of state?.inFlight.values() ?? [])
          controller.abort(new Error('cancelled'));
        return message;
      }
      default:
        return message;
    }
  };

  // ---- agent → client ----

  const answerAgent = (id: string | number, outcome: acp.RequestPermissionOutcome) =>
    send(toAgent, { jsonrpc: '2.0', id, result: { outcome } } as AnyMessage);

  const emitUpdate = (sessionId: string, update: Json) =>
    send(toClient, {
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId, update },
    } as AnyMessage);

  const auditLines = (status: string, action: string, decidedBy: string, reason: string) => [
    {
      type: 'content',
      content: {
        type: 'text',
        text: [
          `Status: ${status}`,
          `Action: ${action}`,
          `Decided by: ${decidedBy}`,
          `Rationale: ${reason}`,
        ].join('\n'),
      },
    },
  ];

  const actionSummary = (toolCall: AutoReviewToolCall): string => {
    const { command } = readAntigravityCommand(toolCall);
    const firstPath = toolCall.locations?.[0]?.path;
    return (
      command ??
      (firstPath
        ? `${toolCall.title ?? toolCall.kind ?? 'tool'}: ${firstPath}`
        : String(toolCall.title ?? toolCall.kind ?? 'tool'))
    );
  };

  const decide = async (
    request: AnyMessage & { id: string | number; params: acp.RequestPermissionRequest }
  ) => {
    const params = request.params;
    const state = stateFor(params.sessionId);
    const toolCall = params.toolCall as AutoReviewToolCall;
    const allowOnce = params.options.find((option) => option.kind === 'allow_once');
    const toUser = () => send(toClient, request);
    if (!allowOnce) return toUser();

    const action = actionSummary(toolCall);
    const roots = state.roots.length > 0 ? state.roots : [process.cwd()];
    const verdict = classifyAntigravityPermission(toolCall, { roots });
    const auditId = () => `lody-auto-review:${params.toolCall.toolCallId}:${(state.auditSeq += 1)}`;

    if (verdict.kind === 'allow') {
      logger.debug(`[${label}] Auto Review allowed by rule (${verdict.rule}): ${action}`);
      return answerAgent(request.id, { outcome: 'selected', optionId: allowOnce.optionId });
    }
    if (verdict.kind === 'ask') {
      logger.debug(`[${label}] Auto Review asks the user by rule (${verdict.reason}): ${action}`);
      emitUpdate(params.sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: auditId(),
        kind: 'think',
        title: 'Auto Review',
        status: 'failed',
        content: auditLines('Needs your approval', action, 'Lody rule', `This ${verdict.reason}.`),
      });
      return toUser();
    }
    const actionKey = JSON.stringify([
      toolCall.kind ?? null,
      toolCall.rawInput ?? null,
      (toolCall.locations ?? []).map((location) => location.path),
    ]);
    const approvedReason = state.approved.get(actionKey);
    if (approvedReason !== undefined) {
      logger.debug(`[${label}] Auto Review reused this turn's approval: ${action}`);
      emitUpdate(params.sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: auditId(),
        kind: 'think',
        title: 'Auto Review',
        status: 'completed',
        content: auditLines(
          'Approved earlier this turn',
          action,
          'Gemini Flash reviewer',
          approvedReason
        ),
      });
      return answerAgent(request.id, { outcome: 'selected', optionId: allowOnce.optionId });
    }
    const activeReviewer = getReviewer();
    if (!activeReviewer) return toUser();
    if (state.refusals >= AUTO_REVIEW_CIRCUIT_BREAKER_LIMIT) {
      if (!state.breakerNoticed) {
        state.breakerNoticed = true;
        emitUpdate(params.sessionId, {
          sessionUpdate: 'tool_call',
          toolCallId: auditId(),
          kind: 'think',
          title: 'Auto Review',
          status: 'failed',
          content: auditLines(
            'Paused for this turn',
            action,
            'Lody',
            `The reviewer turned down ${state.refusals} requests in a row; the rest of this turn asks you directly.`
          ),
        });
      }
      return toUser();
    }

    // Registered before the first wait, so a Stop or a mode change from here on reaches it.
    const controller = new AbortController();
    state.inFlight.set(request.id, controller);
    const toolCallId = auditId();
    emitUpdate(params.sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId,
      kind: 'think',
      title: 'Auto Review',
      status: 'in_progress',
      content: auditLines(
        'Reviewing',
        action,
        'Gemini Flash reviewer',
        'Waiting for the reviewer.'
      ),
    });
    // Started when the review leaves the reviewer's queue: an earlier review of
    // this session must not use up this one's time.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startTimer = () => {
      timer = setTimer(() => controller.abort(new Error('timed out')), reviewTimeoutMs);
    };
    const { cwd: actionCwd } = readAntigravityCommand(toolCall);
    const diff = (toolCall.content ?? [])
      .map((block) =>
        isRecord(block) && block.type === 'diff'
          ? `${String(block.path)}\n--- old\n${String(block.oldText ?? '')}\n+++ new\n${String(block.newText ?? '')}`
          : ''
      )
      .filter(Boolean)
      .join('\n');
    const finish = (status: 'completed' | 'failed', heading: string, reason: string) =>
      emitUpdate(params.sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status,
        content: auditLines(heading, action, 'Gemini Flash reviewer', reason),
      });
    try {
      const isGitRepository = await untilAborted(
        (options.isGitRepository ?? findGitRepository)(roots[0]!),
        controller.signal
      );
      const review = activeReviewer.review(
        {
          toolTitle: String(toolCall.title ?? ''),
          toolKind: String(toolCall.kind ?? 'other'),
          command: verdict.command,
          subcommands: verdict.subcommands,
          paths: (toolCall.locations ?? []).map((location) => location.path),
          rawInput: toolCall.rawInput,
          ...(diff ? { diff } : {}),
          actionCwd: actionCwd ?? roots[0]!,
          workspaceRoots: roots,
          isGitRepository,
          userMessage: state.userMessage,
          ...(state.userMessage.trim().length <= SHORT_USER_MESSAGE_CHARS &&
          state.previousAgentMessage
            ? { previousAgentMessage: state.previousAgentMessage }
            : {}),
        },
        controller.signal,
        startTimer
      );
      // The deadline holds even if a reviewer ignores the abort.
      const result = await untilAborted(review, controller.signal);
      if (!state.active) throw new Error('mode changed');
      if (result.decision === 'allow') {
        state.refusals = 0;
        state.approved.set(actionKey, result.reason);
        finish('completed', 'Approved', result.reason);
        return answerAgent(request.id, { outcome: 'selected', optionId: allowOnce.optionId });
      }
      state.refusals += 1;
      finish('failed', 'Needs your approval', result.reason);
      return toUser();
    } catch (error) {
      const reason = controller.signal.aborted ? controller.signal.reason : error;
      if (reason instanceof Error && reason.message === 'cancelled') {
        finish('failed', 'Cancelled', 'The turn was stopped.');
        return answerAgent(request.id, { outcome: 'cancelled' });
      }
      if (reason instanceof Error && reason.message === 'mode changed') {
        finish('failed', 'Mode changed', 'Auto Review was turned off; asking you instead.');
        return toUser();
      }
      state.refusals += 1;
      const timedOut = reason instanceof Error && reason.message === 'timed out';
      logger.debug(`[${label}] Auto Review reviewer failed: ${formatErrorMessage(reason)}`);
      finish(
        'failed',
        timedOut ? 'Timed out' : 'Reviewer unavailable',
        timedOut
          ? `No verdict within ${Math.round(reviewTimeoutMs / 1000)} seconds; asking you instead.`
          : `The reviewer failed (${formatErrorMessage(reason)}); asking you instead.`
      );
      return toUser();
    } finally {
      if (timer !== undefined) clearTimer(timer);
      state.inFlight.delete(request.id);
    }
  };

  const fromAgent = (message: AnyMessage) => {
    if ('method' in message) {
      if (
        message.method === 'session/request_permission' &&
        'id' in message &&
        message.id !== null &&
        isRecord(message.params)
      ) {
        const params = message.params as unknown as acp.RequestPermissionRequest;
        if (sessions.get(params.sessionId)?.active) {
          void decide(
            message as AnyMessage & { id: string | number; params: acp.RequestPermissionRequest }
          ).catch((error: unknown) => {
            logger.warn(
              `[${label}] Auto Review failed; asking the user: ${formatErrorMessage(error)}`
            );
            send(toClient, message);
          });
          return;
        }
      }
      if (message.method === 'session/update' && isRecord(message.params)) {
        const params = message.params;
        const update = isRecord(params.update) ? params.update : undefined;
        const state =
          typeof params.sessionId === 'string' ? sessions.get(params.sessionId) : undefined;
        if (update?.sessionUpdate === 'config_option_update') {
          send(toClient, {
            ...message,
            params: {
              ...params,
              update: {
                ...update,
                configOptions: presentConfigOptions(update.configOptions, state),
              },
            },
          });
          return;
        }
        if (update?.sessionUpdate === 'current_mode_update' && state) {
          if (update.currentModeId !== UNDERLYING_MODE_ID) setActive(state, false);
          else if (state.active) {
            send(toClient, {
              ...message,
              params: {
                ...params,
                update: { ...update, currentModeId: ANTIGRAVITY_AUTO_REVIEW_MODE_ID },
              },
            });
            return;
          }
        }
        if (update?.sessionUpdate === 'agent_message_chunk' && state && isRecord(update.content)) {
          const text =
            update.content.type === 'text' && typeof update.content.text === 'string'
              ? update.content.text
              : '';
          state.agentText = (state.agentText + text).slice(-AGENT_TEXT_LIMIT);
        }
      }
      send(toClient, message);
      return;
    }
    const id = message.id;
    const tracked = id !== null ? pending.get(id) : undefined;
    if (id !== null) pending.delete(id);
    if (!tracked || !('result' in message) || !isRecord(message.result)) {
      send(toClient, message);
      return;
    }
    const result = message.result;
    if (tracked.kind === 'session') {
      const sessionId = typeof result.sessionId === 'string' ? result.sessionId : tracked.sessionId;
      const state = sessionId ? stateFor(sessionId, tracked.roots) : undefined;
      if (state && tracked.requestedMode !== undefined) {
        setActive(state, tracked.requestedMode === ANTIGRAVITY_AUTO_REVIEW_MODE_ID);
      }
      send(toClient, { ...message, result: presentResult(result, state) });
      return;
    }
    const state = stateFor(tracked.sessionId);
    setActive(state, tracked.target === ANTIGRAVITY_AUTO_REVIEW_MODE_ID);
    send(toClient, { ...message, result: presentResult(result, state) });
  };

  const outgoing = new TransformStream<AnyMessage, AnyMessage>({
    start: (controller) => {
      toAgent = controller;
    },
    transform: (message, controller) => controller.enqueue(fromClient(message)),
  });
  const incoming = new TransformStream<AnyMessage, AnyMessage>({
    start: (controller) => {
      toClient = controller;
    },
    transform: (message) => fromAgent(message),
    flush: () => {
      reviewer?.close();
    },
  });
  void outgoing.readable.pipeTo(stream.writable).catch(() => {});
  void stream.readable
    .pipeTo(incoming.writable)
    .catch(() => {})
    .finally(() => {
      for (const state of sessions.values())
        for (const controller of state.inFlight.values()) controller.abort(new Error('cancelled'));
      reviewer?.close();
    });
  return { writable: outgoing.writable, readable: incoming.readable };
}
