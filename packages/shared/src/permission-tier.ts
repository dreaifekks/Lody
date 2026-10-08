import type { AgentConfigCliType, AgentType } from './ai';

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
/**
 * `unknown`: a selection this table does not classify; only a person may choose
 * it. `exempt`: an Agent the user chose to leave outside the cap (Pi), which
 * any Agent may write; as a ceiling it is `full`, since nothing there asks.
 */
export type ResolvedPermissionTier = PermissionTier | 'unknown' | 'exempt';
export const RESOLVED_PERMISSION_TIERS = [...PERMISSION_TIERS, 'unknown', 'exempt'] as const;

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
 * Builtins the user exempted from the cap. Pi has no permission control (every
 * tool call runs without asking) and needs no synthetic mode.
 */
const EXEMPT_AGENT_TYPES: ReadonlySet<string> = new Set(['pi']);

export type PermissionTierRunConfig = {
  modeId?: string;
  configOptionValues?: Record<string, string | boolean>;
};

/** The options of an Agent's capability: which are its mode and permission controls. */
export type PermissionTierCapability = {
  configOptions: readonly { id: string; category?: string | null }[];
};

const isPermissionOption = (option: { id: string; category?: string | null }) =>
  option.category === 'mode' || option.category === '_permission' || option.id === '_permission';
/** A permission control beside the mode (Grok `permission_mode`); a session keeps its last value. */
const isIndependentPermissionOption = (option: { id: string; category?: string | null }) =>
  option.category === '_permission' || option.id === '_permission';

/**
 * The tier a run configuration runs at on the given Agent, as dispatched:
 * callers apply Lody's builtin default mode the way dispatch does first.
 *
 * Without the Agent's capability nothing is known about its controls, so the
 * tier is `unknown`. So is a configuration that leaves a permission option
 * beside the mode unset, since a reused session keeps whatever it had, and one
 * with no selection at all on an Agent that has permission controls: the
 * provider's own default is not something Lody can rank.
 */
export function resolvePermissionTier(args: {
  runConfig: PermissionTierRunConfig;
  agent: { cliType?: AgentConfigCliType | null; agentType?: AgentType | null };
  capability: PermissionTierCapability | undefined;
}): ResolvedPermissionTier {
  const { runConfig, agent, capability } = args;
  if (agent.cliType === 'builtin' && agent.agentType && EXEMPT_AGENT_TYPES.has(agent.agentType))
    return 'exempt';
  if (!capability) return 'unknown';
  const values = runConfig.configOptionValues ?? {};
  if (
    capability.configOptions.some(
      (option) => isIndependentPermissionOption(option) && values[option.id] === undefined
    )
  )
    return 'unknown';
  const permissionOptionIds = new Set([
    ...PERMISSION_OPTION_IDS,
    ...capability.configOptions.filter(isPermissionOption).map((option) => option.id),
  ]);
  const selections: unknown[] = [
    ...(runConfig.modeId !== undefined ? [runConfig.modeId] : []),
    ...Object.keys(values)
      .filter((optionId) => permissionOptionIds.has(optionId))
      .map((optionId) => values[optionId]),
  ];
  if (selections.length === 0) return 'unknown';
  let rank = 0;
  for (const selection of selections) {
    const tier = typeof selection === 'string' ? MODE_TIERS.get(selection) : undefined;
    if (!tier) return 'unknown';
    rank = Math.max(rank, PERMISSION_TIERS.indexOf(tier));
  }
  return PERMISSION_TIERS[rank]!;
}

const rankAsCeiling = (tier: PermissionTier | 'exempt') =>
  PERMISSION_TIERS.indexOf(tier === 'exempt' ? 'full' : tier);

/** The lower of two ceilings; an unknown ceiling is the lowest, an exempt one `full`. */
export function lowerPermissionTier(
  left: ResolvedPermissionTier,
  right: ResolvedPermissionTier
): ResolvedPermissionTier {
  if (left === 'unknown' || right === 'unknown') return 'unknown';
  return PERMISSION_TIERS[Math.min(rankAsCeiling(left), rankAsCeiling(right))]!;
}

/** The higher of two targets; an unknown target is above every tier, an exempt one adds none. */
export function higherPermissionTier(
  left: ResolvedPermissionTier,
  right: ResolvedPermissionTier
): ResolvedPermissionTier {
  if (left === 'unknown' || right === 'unknown') return 'unknown';
  if (left === 'exempt') return right;
  if (right === 'exempt') return left;
  return PERMISSION_TIERS[
    Math.max(PERMISSION_TIERS.indexOf(left), PERMISSION_TIERS.indexOf(right))
  ]!;
}

/**
 * Whether `target` stays within `ceiling`. An exempt target always is, an
 * unknown one never; an unknown ceiling counts as the lowest tier.
 */
export function isPermissionTierWithin(
  target: ResolvedPermissionTier,
  ceiling: ResolvedPermissionTier
): boolean {
  if (target === 'exempt') return true;
  if (target === 'unknown') return false;
  const ceilingRank = ceiling === 'unknown' ? 0 : rankAsCeiling(ceiling);
  return PERMISSION_TIERS.indexOf(target) <= ceilingRank;
}
