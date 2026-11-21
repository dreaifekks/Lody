import type * as acp from '@agentclientprotocol/sdk';
import type { AnyMessage } from '@agentclientprotocol/sdk';
import {
  type AcpConfigOptionSummary,
  ANTIGRAVITY_AGENT_TYPE,
  ANTIGRAVITY_YOLO_MODE_ID,
  migrateLegacyAntigravityModeId,
} from '@lody/shared';

/**
 * LAN fork: what Lody changes on the ACP stream between `AgentClient` and the
 * agy CLI's `antigravity acp` (builtin `antigravity` and the persisted
 * `antigravity-acp` registry entry). agy's own modes pass through untouched.
 *
 * - YOLO: the agy CLI skips permission requests only for a whole process
 *   (`--dangerously-skip-permissions`), and Lody starts one agy process per
 *   session. A session whose turn selects `yolo` is started with that flag
 *   ({@link antigravityLaunchArgs}); here `yolo` is added to the agent's modes and
 *   sent to it as `default`. The flag cannot change in a running process: a turn
 *   that selects the other side restarts the session's agent first
 *   ({@link antigravityYoloChanged}), and a switch inside a running turn is refused.
 * - Streamable HTTP MCP: agy connects to such servers but does not advertise it.
 * - Context compaction: agy compacts synchronously on `/compact <instructions>`
 *   and refreshes `usage_update` before `session/prompt` returns, but does not
 *   advertise `_meta.lody.compaction` in `initialize`; the wrapper adds
 *   `_meta.lody.compaction: { version: 1 }` unless agy already reports one.
 * - A selection saved as Lody's former Auto Review is sent as agy's own `auto`.
 *
 * Applied in `session.ts` (sessions) and `acp-runner.ts` (capability probes and
 * other local starts), the two places an ACP stream is built for an agent.
 */

/** agy's process flag: it approves its own tool permission requests. */
export const ANTIGRAVITY_SKIP_PERMISSIONS_ARG = '--dangerously-skip-permissions';

type ModeSelection = {
  agentType: string;
  modeId?: string;
  configOptionValues?: Readonly<Record<string, unknown>>;
};

const isAntigravity = (agentType: string): boolean =>
  agentType === ANTIGRAVITY_AGENT_TYPE || agentType === 'antigravity';

const selectedMode = (selection: ModeSelection): string | undefined => {
  const mode = selection.modeId ?? selection.configOptionValues?.mode;
  return typeof mode === 'string' ? mode : undefined;
};

const selectsYolo = (selection: ModeSelection): boolean =>
  isAntigravity(selection.agentType) && selectedMode(selection) === ANTIGRAVITY_YOLO_MODE_ID;

/** Extra `antigravity acp` arguments for a session started for `selection`. */
export const antigravityLaunchArgs = (selection: ModeSelection): string[] =>
  selectsYolo(selection) ? [ANTIGRAVITY_SKIP_PERMISSIONS_ARG] : [];

/**
 * Whether a turn selects YOLO on or off against how the session's agy process
 * was started (`started`, the session's own selection). A turn that names no
 * mode keeps the process.
 */
export const antigravityYoloChanged = (started: ModeSelection, turn: ModeSelection): boolean =>
  isAntigravity(turn.agentType) &&
  selectedMode(turn) !== undefined &&
  selectsYolo(started) !== selectsYolo(turn);

export type AntigravityAcpStreamOptions = {
  cliType: string;
  agentType: string;
  /** The agent's launch arguments: with agy's skip flag every session is YOLO. */
  args: readonly string[];
};

const UNDERLYING_MODE_ID = 'default';

const isAntigravityProvider = (
  cliType: string | undefined,
  agentType: string | undefined
): boolean =>
  (cliType === 'builtin' && agentType === 'antigravity') ||
  (cliType === 'registry' && agentType === ANTIGRAVITY_AGENT_TYPE);

/**
 * Whether a provider is the managed or legacy registry Antigravity CLI, which
 * compacts synchronously on `/compact <instructions>` even when no live process
 * runs and Machine Flock has no cached `compact` command.
 */
export const antigravitySupportsContextCompaction = (
  cliType: string | undefined,
  agentType: string | undefined
): boolean => isAntigravityProvider(cliType, agentType);

/** Undo only this wrapper's session presentation before publishing Provider defaults. */
export function antigravityProviderConfigOptions(
  cliType: string,
  agentType: string,
  options: AcpConfigOptionSummary[] | undefined
): AcpConfigOptionSummary[] | undefined {
  if (!isAntigravityProvider(cliType, agentType)) return options;
  // YOLO is presented only when agy reports `default`. Keep the choices and the
  // Session snapshot, changing only the published value.
  return options?.map((option) =>
    option.category === 'mode' && option.currentValue === ANTIGRAVITY_YOLO_MODE_ID
      ? { ...option, currentValue: UNDERLYING_MODE_ID }
      : option
  );
}

export const ANTIGRAVITY_YOLO_MODE = {
  id: ANTIGRAVITY_YOLO_MODE_ID,
  name: 'YOLO',
  description:
    "agy approves every permission request itself (--dangerously-skip-permissions); your deny rules and agy's command denylist still apply. Switching to or from it restarts the agent.",
};

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Adds YOLO at the end of an agent-reported mode list or option list that has none. */
const withYoloMode = <T>(entries: T[], make: () => T, idOf: (entry: T) => unknown): T[] =>
  entries.some((entry) => idOf(entry) === UNDERLYING_MODE_ID) &&
  !entries.some((entry) => idOf(entry) === ANTIGRAVITY_YOLO_MODE_ID)
    ? [...entries, make()]
    : entries;

/** The mode agy is sent for a selection. */
const agentModeId = (modeId: string): string =>
  modeId === ANTIGRAVITY_YOLO_MODE_ID ? UNDERLYING_MODE_ID : migrateLegacyAntigravityModeId(modeId);

export function withAntigravityAcpStream(
  stream: acp.Stream,
  options: AntigravityAcpStreamOptions
): acp.Stream {
  if (!isAntigravity(options.agentType)) return stream;
  const injectsCompaction = isAntigravityProvider(options.cliType, options.agentType);
  /** Started with agy's skip flag: every session of this process is YOLO. */
  const skipsPermissions = options.args.includes(ANTIGRAVITY_SKIP_PERMISSIONS_ARG);
  /** Requests whose answer is rewritten: `initialize`, or one that reports modes. */
  const pending = new Map<string | number, 'initialize' | 'modes'>();
  let toClient: TransformStreamDefaultController<AnyMessage> | null = null;

  /** The mode Lody reports instead of the agent's current one, if any. */
  const presentedCurrent = (current: unknown): string | undefined =>
    skipsPermissions && current === UNDERLYING_MODE_ID ? ANTIGRAVITY_YOLO_MODE_ID : undefined;

  const presentModes = (modes: unknown): unknown => {
    if (!isRecord(modes) || !Array.isArray(modes.availableModes)) return modes;
    const availableModes = withYoloMode(
      modes.availableModes as unknown[],
      () => ({ ...ANTIGRAVITY_YOLO_MODE }),
      (mode) => (isRecord(mode) ? mode.id : undefined)
    );
    const current = presentedCurrent(modes.currentModeId);
    return { ...modes, availableModes, ...(current ? { currentModeId: current } : {}) };
  };

  const presentConfigOptions = (configOptions: unknown): unknown => {
    if (!Array.isArray(configOptions)) return configOptions;
    return configOptions.map((option) => {
      if (!isRecord(option) || option.category !== 'mode' || !Array.isArray(option.options))
        return option;
      const choices = withYoloMode(
        option.options as unknown[],
        () => ({
          value: ANTIGRAVITY_YOLO_MODE.id,
          name: ANTIGRAVITY_YOLO_MODE.name,
          description: ANTIGRAVITY_YOLO_MODE.description,
        }),
        (entry) => (isRecord(entry) ? entry.value : undefined)
      );
      const current = presentedCurrent(option.currentValue);
      return { ...option, options: choices, ...(current ? { currentValue: current } : {}) };
    });
  };

  const presentResult = (result: Json): Json => ({
    ...result,
    ...('modes' in result ? { modes: presentModes(result.modes) } : {}),
    ...('configOptions' in result
      ? { configOptions: presentConfigOptions(result.configOptions) }
      : {}),
  });

  // ---- client → agent ----

  /** The mode a session starts in, from `_meta.lody.sessionConfig`. */
  const rewriteStartMeta = (params: Json): Json => {
    const meta = isRecord(params._meta) ? params._meta : undefined;
    const lody = isRecord(meta?.lody) ? meta.lody : undefined;
    const sessionConfig = isRecord(lody?.sessionConfig) ? lody.sessionConfig : undefined;
    const values = isRecord(sessionConfig?.configOptionValues)
      ? sessionConfig.configOptionValues
      : undefined;
    if (!meta || !lody || !sessionConfig || !values || typeof values.mode !== 'string')
      return params;
    const mode = agentModeId(values.mode);
    if (mode === values.mode) return params;
    return {
      ...params,
      _meta: {
        ...meta,
        lody: {
          ...lody,
          sessionConfig: { ...sessionConfig, configOptionValues: { ...values, mode } },
        },
      },
    };
  };

  /** The message to forward to the agent, or null when it is answered here. */
  const fromClient = (message: AnyMessage): AnyMessage | null => {
    if (!('method' in message) || !isRecord(message.params)) return message;
    const params = message.params;
    const id = 'id' in message ? message.id : undefined;
    const track = (kind: 'initialize' | 'modes') => {
      if (id !== undefined && id !== null) pending.set(id, kind);
    };
    switch (message.method) {
      case 'initialize':
        track('initialize');
        return message;
      case 'session/new':
      case 'session/load':
      case 'session/resume':
      case 'session/fork':
      case 'unstable/session/fork':
        track('modes');
        return { ...message, params: rewriteStartMeta(params) };
      case 'session/set_mode':
      case 'session/set_config_option': {
        const isMode = message.method === 'session/set_mode' || params.configId === 'mode';
        const target = message.method === 'session/set_mode' ? params.modeId : params.value;
        if (!isMode || typeof target !== 'string') {
          track('modes');
          return message;
        }
        const yolo = target === ANTIGRAVITY_YOLO_MODE_ID;
        if (yolo !== skipsPermissions) {
          // The flag is fixed for this process; the session's next turn restarts
          // its agent for the other side (antigravityYoloChanged).
          if (id !== undefined && id !== null)
            toClient?.enqueue({
              jsonrpc: '2.0',
              id,
              error: {
                code: -32602,
                message: yolo
                  ? 'YOLO starts a new agy process; it applies from your next message.'
                  : 'This agy process runs in YOLO; the new mode applies from your next message.',
              },
            } as AnyMessage);
          return null;
        }
        track('modes');
        const mode = agentModeId(target);
        if (mode === target) return message;
        return message.method === 'session/set_mode'
          ? { ...message, params: { ...params, modeId: mode } }
          : { ...message, params: { ...params, value: mode } };
      }
      default:
        return message;
    }
  };

  // ---- agent → client ----

  const fromAgent = (message: AnyMessage): AnyMessage => {
    if ('method' in message) {
      if (message.method !== 'session/update' || !isRecord(message.params)) return message;
      const params = message.params;
      const update = isRecord(params.update) ? params.update : undefined;
      if (update?.sessionUpdate === 'config_option_update')
        return {
          ...message,
          params: {
            ...params,
            update: { ...update, configOptions: presentConfigOptions(update.configOptions) },
          },
        };
      const current =
        update?.sessionUpdate === 'current_mode_update'
          ? presentedCurrent(update.currentModeId)
          : undefined;
      return current
        ? { ...message, params: { ...params, update: { ...update, currentModeId: current } } }
        : message;
    }
    const tracked = message.id !== null ? pending.get(message.id) : undefined;
    if (message.id !== null) pending.delete(message.id);
    if (!tracked || !('result' in message) || !isRecord(message.result)) return message;
    const result = message.result;
    if (tracked === 'modes') return { ...message, result: presentResult(result) };
    // agy connects to Streamable HTTP MCP servers and (for managed/legacy providers)
    // compacts synchronously on `/compact <instructions>`, advertising neither in `initialize`.
    const capabilities = isRecord(result.agentCapabilities) ? result.agentCapabilities : {};
    const mcp = isRecord(capabilities.mcpCapabilities) ? capabilities.mcpCapabilities : {};
    if (!injectsCompaction) {
      return {
        ...message,
        result: {
          ...result,
          agentCapabilities: { ...capabilities, mcpCapabilities: { ...mcp, http: true } },
        },
      };
    }
    const meta = isRecord(capabilities._meta) ? capabilities._meta : {};
    const lody = isRecord(meta.lody) ? meta.lody : {};
    return {
      ...message,
      result: {
        ...result,
        agentCapabilities: {
          ...capabilities,
          mcpCapabilities: { ...mcp, http: true },
          _meta: {
            ...meta,
            lody: { compaction: { version: 1 }, ...lody },
          },
        },
      },
    };
  };

  const outgoing = new TransformStream<AnyMessage, AnyMessage>({
    transform: (message, controller) => {
      const forwarded = fromClient(message);
      if (forwarded) controller.enqueue(forwarded);
    },
  });
  const incoming = new TransformStream<AnyMessage, AnyMessage>({
    start: (controller) => {
      toClient = controller;
    },
    transform: (message, controller) => controller.enqueue(fromAgent(message)),
  });
  void outgoing.readable.pipeTo(stream.writable).catch(() => {});
  void stream.readable.pipeTo(incoming.writable).catch(() => {});
  return { writable: outgoing.writable, readable: incoming.readable };
}
