import { getBuiltinDefaultModeId, type AgentConfigCliType, type AgentType } from './ai';

/**
 * Coarse permission tiers, lowest first, for comparing run configurations of
 * different providers: every step asks (or only reads) < file edits run without
 * asking < a reviewing model approves the rest < nothing asks.
 *
 * An Agent may write a Role or Schedule only up to its own Session's tier; a
 * higher one, or a mode this table does not know, is the user's to set.
 */
export const PERMISSION_TIERS = ['ask', 'edit', 'auto', 'full'] as const;
export type PermissionTier = (typeof PERMISSION_TIERS)[number];
/** A selection this table does not classify. Only a person may choose it. */
export type ResolvedPermissionTier = PermissionTier | 'unknown';

/**
 * Every mode and permission-option value the built-in and registry providers
 * advertise. One id never means two tiers: `auto` is a reviewing classifier
 * (Claude) or auto-approval of safe operations (Kimi), `default` is the asking
 * mode everywhere.
 */
const MODE_TIERS: ReadonlyMap<string, PermissionTier> = new Map([
  // Claude Code. `dontAsk` denies whatever is not pre-approved instead of asking.
  ['default', 'ask'],
  ['plan', 'ask'],
  ['dontAsk', 'ask'],
  ['acceptEdits', 'edit'],
  ['auto', 'auto'],
  ['bypassPermissions', 'full'],
  // Codex. `agent` writes inside the workspace sandbox and asks beyond it.
  ['read-only', 'ask'],
  ['agent', 'edit'],
  ['agent-auto-review', 'auto'],
  ['agent-full-access', 'full'],
  ['danger-full-access', 'full'],
  // DeepSeek Harness (`read-only` and `danger-full-access` above).
  ['workspace-write', 'edit'],
  // Google Antigravity / Gemini, Kimi (`default`, `plan`, `auto` above).
  ['auto_edit', 'edit'],
  ['yolo', 'full'],
  // Grok `permission_mode`.
  ['ask', 'ask'],
  ['always-approve', 'full'],
]);

/** Option ids that carry a permission selection for the providers above. */
const PERMISSION_OPTION_IDS = ['mode', 'permission_mode', '_permission'];

/**
 * Builtins without any permission control: every tool call runs without
 * asking, so their only tier is `full`. They need no synthetic mode.
 */
const UNGATED_AGENT_TYPES: ReadonlySet<string> = new Set(['pi']);

export type PermissionTierRunConfig = {
  modeId?: string;
  configOptionValues?: Record<string, string | boolean>;
};

/**
 * The tier a run configuration runs at on the given Agent.
 *
 * `permissionOptionIds` are the ids of the options the Agent's capability
 * declares as its mode or permission control. Without a capability
 * (`undefined`) any option outside the known permission ids could be one, so
 * such a configuration is `unknown`. With no selection at all the Agent runs at
 * Lody's builtin default mode, as dispatch applies it; a provider default Lody
 * does not set is `unknown`.
 */
export function resolvePermissionTier(args: {
  runConfig: PermissionTierRunConfig;
  agent: { cliType?: AgentConfigCliType | null; agentType?: AgentType | null };
  permissionOptionIds: readonly string[] | undefined;
}): ResolvedPermissionTier {
  const { runConfig, agent } = args;
  const optionIds = Object.keys(runConfig.configOptionValues ?? {});
  if (
    !args.permissionOptionIds &&
    optionIds.some((optionId) => !PERMISSION_OPTION_IDS.includes(optionId))
  )
    return 'unknown';
  const permissionOptionIds = new Set([
    ...PERMISSION_OPTION_IDS,
    ...(args.permissionOptionIds ?? []),
  ]);
  const selections: unknown[] = [
    ...(runConfig.modeId !== undefined ? [runConfig.modeId] : []),
    ...optionIds
      .filter((optionId) => permissionOptionIds.has(optionId))
      .map((optionId) => runConfig.configOptionValues?.[optionId]),
  ];
  if (selections.length === 0) {
    if (agent.cliType === 'builtin' && agent.agentType && UNGATED_AGENT_TYPES.has(agent.agentType))
      return 'full';
    const builtinDefault = getBuiltinDefaultModeId(agent.cliType, agent.agentType);
    if (!builtinDefault) return 'unknown';
    selections.push(builtinDefault);
  }
  let rank = 0;
  for (const selection of selections) {
    const tier = typeof selection === 'string' ? MODE_TIERS.get(selection) : undefined;
    if (!tier) return 'unknown';
    rank = Math.max(rank, PERMISSION_TIERS.indexOf(tier));
  }
  return PERMISSION_TIERS[rank]!;
}

/**
 * Whether `target` stays within `ceiling`. An unknown target is never within;
 * an unknown ceiling counts as the lowest tier.
 */
export function isPermissionTierWithin(
  target: ResolvedPermissionTier,
  ceiling: ResolvedPermissionTier
): boolean {
  if (target === 'unknown') return false;
  const ceilingRank = ceiling === 'unknown' ? 0 : PERMISSION_TIERS.indexOf(ceiling);
  return PERMISSION_TIERS.indexOf(target) <= ceilingRank;
}

/** The ids of the options a capability declares as mode or permission control. */
export function permissionOptionIdsOf(
  configOptions: readonly { id: string; category?: string | null }[]
): string[] {
  return configOptions
    .filter((option) => option.category === 'mode' || option.category === '_permission')
    .map((option) => option.id);
}
