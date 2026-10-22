import { MemoryBindingSchema, type MemoryBinding } from './memory-provider';
import type { AgentConfigId, AgentRoleId, AgentRoleInstanceId, MachineId } from './ids';
import { isSensitiveAcpConfigOptionId } from './acp-config-option-sensitivity';

/**
 * Agent Role — a named, mentionable preset for *creating* a Session.
 *
 * A Role says how to USE an Agent Config (model, reasoning, run options, prompt
 * prefix); it is never a provider and never a running agent. That boundary is
 * the reason for most of the rules below:
 *
 * - No secrets. A workspace Flock row is replicated to every member's client,
 *   so `private` limits trusted UI discovery and editing; it is not transport
 *   or storage confidentiality, and MCP creation may resolve an explicit id.
 *   V1 therefore refuses to persist anything secret-shaped in the first place
 *   (`isSensitiveAgentRoleConfigOptionKey`), rather than pretending a private
 *   row is a safe place to put one.
 * - No silent fallback. `machineId + agentConfigId` bind the execution site
 *   exactly; when either is gone the Role stays in Settings marked unavailable
 *   with the precise reason, and never becomes a submittable mention.
 * - `id` is the stable identity. The mention token is DERIVED from the name and
 *   changes when the name does, so a mention range carries the id.
 */

export const AGENT_ROLE_VERSION = 1;
/**
 * The stored shape of a Role with more than one machine target. Older clients
 * accept only `v: 1`, so they skip these rows instead of rewriting them without
 * the targets they cannot see. Single-target Roles keep the v1 shape.
 */
export const AGENT_ROLE_MULTI_TARGET_VERSION = 2;

export type AgentRoleVisibility = 'private' | 'workspace';

/**
 * The non-sensitive half of a Session config: what the agent capability itself
 * advertises. Deliberately not `AcpConfigOptionValue`-typed against the ACP
 * module — a Role stores only the primitive shapes an option selector produces.
 */
export type AgentRoleRunConfig = {
  memory?: MemoryBinding;
  modeId?: string;
  modelId?: string;
  configOptionValues?: Record<string, string | boolean>;
};

export type AgentRole = {
  /** Stable target identity; old instance references keep resolving. */
  targetId?: AgentRoleInstanceId;
  v: typeof AGENT_ROLE_VERSION;
  id: AgentRoleId;
  ownerUserId: string;
  visibility: AgentRoleVisibility;

  name: string;
  /** Short guidance for other agents deciding when to invoke this Role. */
  description?: string;
  /** Optional single glyph shown before the name wherever the Role is listed. */
  emoji?: string;

  /**
   * The first machine target. With `additionalTargets` absent this is the whole
   * Role, exactly the v1 row. A Role resolved for one machine
   * (`bindAgentRoleTarget`) carries that machine here, so execution paths read
   * these three fields without knowing about targets.
   */
  machineId: MachineId;
  agentConfigId: AgentConfigId;
  runConfig: AgentRoleRunConfig;
  /** Optional label of the first target, retained when other targets are removed. */
  alias?: string;
  /**
   * Additional targets, including distinct targets on the same machine.
   * Authoring order never grants a dispatch preference.
   */
  additionalTargets?: readonly AgentRoleTarget[];
  promptPrefix?: string;

  /** Bumped on every effective edit; frozen when a create Operation accepts this Role. */
  revision: number;
  createdAt: number;
  updatedAt: number;
};

/** How one machine runs a Role. Name, prompt and sharing stay on the Role. */
export type AgentRoleTarget = {
  id: AgentRoleInstanceId;
  machineId: MachineId;
  agentConfigId: AgentConfigId;
  runConfig: AgentRoleRunConfig;
  alias?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export const isAgentRoleVisibility = (value: unknown): value is AgentRoleVisibility =>
  value === 'private' || value === 'workspace';

// ---------------------------------------------------------------------------
// Name, emoji, and the mention token derived from them
// ---------------------------------------------------------------------------

/** Long enough to stay readable inline, short enough not to dominate a prompt. */
export const AGENT_ROLE_MENTION_SLUG_MAX_LENGTH = 40;
export const AGENT_ROLE_NAME_MAX_LENGTH = 60;
export const AGENT_ROLE_ALIAS_MAX_LENGTH = AGENT_ROLE_NAME_MAX_LENGTH;
export const AGENT_ROLE_DESCRIPTION_MAX_LENGTH = 140;

export const normalizeAgentRoleDescription = (value: string | undefined): string =>
  Array.from(value ?? '')
    .slice(0, AGENT_ROLE_DESCRIPTION_MAX_LENGTH)
    .join('');
/**
 * A few code points: one emoji, including a ZWJ sequence or a skin-tone
 * modifier, without becoming a second name field.
 */
export const AGENT_ROLE_EMOJI_MAX_LENGTH = 8;

/**
 * The mention token for a Role, derived from its name.
 *
 * A Role has ONE authored label. An `@` token ends at the next whitespace, so
 * the token cannot simply be the name — but a second authored field ("name" and
 * "mention name") is two things to keep in sync for one concept, and the id is
 * what the range actually carries. So the token is computed, and renaming a
 * Role renames its mention.
 */
export const getAgentRoleMentionSlug = (role: Pick<AgentRole, 'name'>): string =>
  normalizeAgentRoleMentionSlug(role.name);

/**
 * Normalize a name into a token the composer can carry.
 *
 * Whitespace is the only thing that MUST go: an `@` token ends at the next
 * space, so a token containing one could never be recovered from a reloaded
 * draft. Everything else — including CJK — is kept so a Chinese Role name stays
 * readable. A leading `@` is dropped so pasting `@reviewer` works.
 */
export const normalizeAgentRoleMentionSlug = (value: string): string => {
  const collapsed = value
    .trim()
    .replace(/^@+/u, '')
    // Control characters would be invisible in the composer but still part of
    // the token, so a slug carrying one could never be typed back.
    .replace(/\p{Cc}/gu, '')
    .replace(/\s+/gu, '-')
    .replace(/-{2,}/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return Array.from(collapsed).slice(0, AGENT_ROLE_MENTION_SLUG_MAX_LENGTH).join('');
};

/**
 * The glyph a Role shows when its owner has not picked one.
 *
 * A real default rather than a blank slot: every Role then reads the same way in
 * the list and the mention menu, and the picker is a change rather than a
 * decision the user has to make before the Role looks finished.
 */
export const DEFAULT_AGENT_ROLE_EMOJI = '🪼';

export const getAgentRoleEmoji = (role: Pick<AgentRole, 'emoji'>): string =>
  role.emoji || DEFAULT_AGENT_ROLE_EMOJI;

/**
 * Keep an emoji to one short, whitespace-free glyph.
 *
 * Capped and stripped rather than validated against an emoji table: the field
 * is decoration, so the only real requirements are that it cannot smuggle a
 * second line of text into a row and cannot carry invisible characters.
 */
export const normalizeAgentRoleEmoji = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const stripped = value.replace(/\p{Cc}/gu, '').replace(/\s+/gu, '');
  const capped = Array.from(stripped).slice(0, AGENT_ROLE_EMOJI_MAX_LENGTH).join('');
  return capped || undefined;
};

// ---------------------------------------------------------------------------
// Run config
// ---------------------------------------------------------------------------

/**
 * Option keys a Role may never persist.
 *
 * The shared `isSensitiveAcpConfigOptionId` rule is the base so a Role refuses
 * exactly what other retained selections refuse to keep — one rule, not two
 * that drift. The extra names are Role-specific: a Role is a durable, possibly
 * workspace-shared row, so anything that looks like a stored identity belongs
 * in the Agent Config, not here.
 *
 * Applied on read as well as on write: an agent may publish a config option
 * with any id it likes, and a row written by an older client must not reach a
 * Session config just because it is already in the document.
 */
const EXTRA_SENSITIVE_ROLE_OPTION_KEY_PATTERN = /(?:\bkey\b|cookie|session[_-]?id|private)/i;

export const isSensitiveAgentRoleConfigOptionKey = (key: string): boolean =>
  isSensitiveAcpConfigOptionId(key) || EXTRA_SENSITIVE_ROLE_OPTION_KEY_PATTERN.test(key);

/**
 * Keep only the option values a Role is allowed to carry: primitive, non-empty
 * keys that are not secret-shaped. Returns `undefined` for an empty result so
 * callers can omit the field instead of persisting `{}`.
 */
export const normalizeAgentRoleConfigOptionValues = (
  value: unknown
): Record<string, string | boolean> | undefined => {
  if (!isRecord(value)) return undefined;
  const normalized: Record<string, string | boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    const trimmedKey = key.trim();
    if (!trimmedKey || isSensitiveAgentRoleConfigOptionKey(trimmedKey)) continue;
    if (typeof entry === 'boolean') {
      normalized[trimmedKey] = entry;
      continue;
    }
    if (typeof entry === 'string') {
      normalized[trimmedKey] = entry;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
};

export const normalizeAgentRoleRunConfig = (value: unknown): AgentRoleRunConfig => {
  if (!isRecord(value)) return {};
  const modeId = typeof value.modeId === 'string' ? value.modeId.trim() : '';
  const modelId = typeof value.modelId === 'string' ? value.modelId.trim() : '';
  const configOptionValues = normalizeAgentRoleConfigOptionValues(value.configOptionValues);
  return {
    ...(value.memory === undefined ? {} : { memory: MemoryBindingSchema.parse(value.memory) }),
    ...(modeId ? { modeId } : {}),
    ...(modelId ? { modelId } : {}),
    ...(configOptionValues ? { configOptionValues } : {}),
  };
};

/**
 * Stable serialization of a run config, so two configs that differ only in the
 * order their option keys were authored in do not read as an edit — which would
 * bump `revision` even though the effective Role configuration is unchanged.
 */
const serializeRunConfig = (value: AgentRoleRunConfig): string => {
  const normalized = normalizeAgentRoleRunConfig(value);
  const options = Object.entries(normalized.configOptionValues ?? {}).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  return JSON.stringify([
    normalized.modeId ?? '',
    normalized.modelId ?? '',
    options,
    normalized.memory ?? null,
  ]);
};

const runConfigsEqual = (left: AgentRoleRunConfig, right: AgentRoleRunConfig): boolean =>
  serializeRunConfig(left) === serializeRunConfig(right);

// ---------------------------------------------------------------------------
// Role validation
// ---------------------------------------------------------------------------

const isStoredRunConfig = (value: unknown): boolean =>
  value === undefined ||
  (isRecord(value) &&
    (value.memory === undefined || MemoryBindingSchema.safeParse(value.memory).success));

const isStoredTarget = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) &&
  isNonEmptyString(value.machineId) &&
  isNonEmptyString(value.agentConfigId) &&
  isStoredRunConfig(value.runConfig) &&
  (value.alias === undefined || typeof value.alias === 'string');

export const normalizeAgentRoleAlias = (value: string | undefined): string =>
  Array.from((value ?? '').trim())
    .slice(0, AGENT_ROLE_ALIAS_MAX_LENGTH)
    .join('')
    .trim();

const normalizeTarget = (value: Record<string, unknown>, roleId: string): AgentRoleTarget => {
  const alias = normalizeAgentRoleAlias(value.alias as string | undefined);
  return {
    id: (typeof value.id === 'string'
      ? value.id
      : legacyAgentRoleInstanceId(roleId, value.machineId as string)) as AgentRoleInstanceId,
    machineId: (value.machineId as string).trim() as MachineId,
    agentConfigId: (value.agentConfigId as string).trim() as AgentConfigId,
    runConfig: normalizeAgentRoleRunConfig(value.runConfig),
    // An alias that has no mention token could never be typed after `@`.
    ...(alias && normalizeAgentRoleMentionSlug(alias) ? { alias } : {}),
  };
};

/**
 * The targets a stored or in-memory row carries, in order: a v1 row (or an
 * in-memory Role) has its first target inline plus `additionalTargets`; a v2
 * row has a `targets` list. Undefined when any target is malformed.
 */
const readTargets = (value: Record<string, unknown>): Record<string, unknown>[] | undefined => {
  if (value.v === AGENT_ROLE_MULTI_TARGET_VERSION) {
    if (!Array.isArray(value.targets) || value.targets.length === 0) return undefined;
    return value.targets.every(isStoredTarget) ? value.targets : undefined;
  }
  if (value.v !== AGENT_ROLE_VERSION || !isStoredTarget(value)) return undefined;
  if (Array.isArray(value.instances) || Array.isArray(value.placements)) {
    return readAgentRoleTargets(value as Record<string, unknown> & AgentRoleLegacyFields);
  }
  const additional = value.additionalTargets ?? [];
  if (!Array.isArray(additional) || !additional.every(isStoredTarget)) return undefined;
  return [
    {
      ...value,
      id:
        value.targetId ?? legacyAgentRoleInstanceId(value.id as string, value.machineId as string),
    },
    ...additional,
  ];
};

/**
 * Whether an untrusted value is a Role row.
 *
 * Flock rows arrive from whatever wrote them — an older client, a newer one, or
 * a hand-edited document — so nothing reads a Role without passing through
 * here first.
 */
export const isAgentRole = (value: unknown): value is AgentRole =>
  normalizeAgentRole(value) !== undefined;

/**
 * Read a persisted Role into the shape the product uses.
 *
 * Normalizing on read rather than trusting the row is what keeps a secret-named
 * option written by an older or buggy client from reaching a Session config.
 * Every legacy instance keeps its stable id, run config and memory binding.
 */
export const normalizeAgentRole = (value: unknown): AgentRole | undefined => {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.ownerUserId) ||
    !isAgentRoleVisibility(value.visibility) ||
    !isNonEmptyString(value.name) ||
    !isFiniteNumber(value.revision) ||
    !isFiniteNumber(value.createdAt) ||
    !isFiniteNumber(value.updatedAt)
  ) {
    return undefined;
  }
  if (value.emoji !== undefined && typeof value.emoji !== 'string') return undefined;
  if (value.description !== undefined && typeof value.description !== 'string') return undefined;
  if (value.promptPrefix !== undefined && typeof value.promptPrefix !== 'string') return undefined;
  // A name that normalizes to nothing (only punctuation the token strips) has no
  // mention token, so it could never be used for what a Role is for.
  if (!getAgentRoleMentionSlug({ name: value.name.trim() })) return undefined;
  const storedTargets = readTargets(value);
  if (!storedTargets) return undefined;

  const targets = storedTargets.map((stored) => normalizeTarget(stored, value.id as string));
  const [first, ...additional] = targets as [AgentRoleTarget, ...AgentRoleTarget[]];
  const multi = additional.length > 0;
  const emoji = normalizeAgentRoleEmoji(value.emoji);
  const description = normalizeAgentRoleDescription(value.description);
  const promptPrefix = value.promptPrefix?.trim();
  return {
    v: AGENT_ROLE_VERSION,
    id: value.id.trim() as AgentRoleId,
    ownerUserId: value.ownerUserId.trim(),
    visibility: value.visibility,
    name: value.name.trim(),
    ...(description ? { description } : {}),
    ...(emoji ? { emoji } : {}),
    targetId: first.id,
    machineId: first.machineId,
    agentConfigId: first.agentConfigId,
    runConfig: first.runConfig,
    // An alias labels one target among several; a single-target Role is its name.
    ...(first.alias ? { alias: first.alias } : {}),
    ...(multi ? { additionalTargets: additional } : {}),
    ...(promptPrefix ? { promptPrefix } : {}),
    revision: Math.max(1, Math.trunc(value.revision)),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
};

/**
 * Single-target Roles retain a v1 instance mirror for older fork members.
 * Only a Role with several targets is written as v2, which old clients skip.
 */
export const serializeAgentRoleRow = (role: AgentRole): Record<string, unknown> => {
  const {
    additionalTargets,
    alias,
    targetId,
    machineId,
    agentConfigId,
    runConfig,
    v: _v,
    ...shared
  } = role;
  if (!additionalTargets?.length) {
    return {
      v: AGENT_ROLE_VERSION,
      ...shared,
      targetId: targetId ?? legacyAgentRoleInstanceId(role.id, machineId),
      // Older fork clients read and write only this mirror. Keep their stable
      // target identity and alias when members upgrade at different times.
      instances: getAgentRoleTargets(role),
      machineId,
      agentConfigId,
      runConfig,
      ...(alias ? { alias } : {}),
    };
  }
  return {
    v: AGENT_ROLE_MULTI_TARGET_VERSION,
    ...shared,
    targets: getAgentRoleTargets(role),
  };
};

/** Every machine target of a Role, first target first. */
export const getAgentRoleTargets = (role: AgentRole): AgentRoleTarget[] => [
  {
    id: role.targetId ?? legacyAgentRoleInstanceId(role.id, role.machineId),
    machineId: role.machineId,
    agentConfigId: role.agentConfigId,
    runConfig: role.runConfig,
    ...(role.alias ? { alias: role.alias } : {}),
  },
  ...(role.additionalTargets ?? []).map((target) => ({
    ...target,
    id: target.id ?? legacyAgentRoleInstanceId(role.id, target.machineId),
  })),
];

export const getAgentRoleTarget = (
  role: AgentRole,
  machineId: MachineId,
  targetId?: string
): AgentRoleTarget | undefined => {
  const matches = getAgentRoleTargets(role).filter(
    (target) => target.machineId === machineId && (!targetId || target.id === targetId)
  );
  return matches.length === 1 ? matches[0] : undefined;
};

export const isMultiTargetAgentRole = (role: AgentRole): boolean =>
  Boolean(role.additionalTargets?.length);

/**
 * Rebuild a Role from its shared fields and a target list. Callers pass at
 * least one target; stable ids and aliases survive reduction to one target.
 */
export const withAgentRoleTargets = (
  role: Omit<AgentRole, 'machineId' | 'agentConfigId' | 'runConfig'>,
  targets: readonly AgentRoleTarget[]
): AgentRole => {
  const [first, ...additional] = targets;
  if (!first) throw new Error('A Role needs at least one target.');
  const {
    additionalTargets: _additional,
    alias: _alias,
    instances: _instances,
    placements: _placements,
    ...shared
  } = role as typeof role & { instances?: unknown; placements?: unknown };
  const multi = additional.length > 0;
  return {
    ...shared,
    targetId: first.id,
    machineId: first.machineId,
    agentConfigId: first.agentConfigId,
    runConfig: first.runConfig,
    ...(first.alias ? { alias: first.alias } : {}),
    ...(multi ? { additionalTargets: additional } : {}),
  };
};

/**
 * The Role as one machine runs it: that target's machine, Agent Config, run
 * config and alias in the inline fields. Execution and provenance read only
 * those, so a bound Role flows through every single-machine path unchanged.
 */
export const bindAgentRoleTarget = (
  role: AgentRole,
  machineId: MachineId,
  targetId?: string
): AgentRole | undefined => {
  const target = getAgentRoleTarget(role, machineId, targetId);
  if (!target) return undefined;
  // A bound Role represents exactly this target, never a new candidate list.
  return withAgentRoleTargets(role, [target]);
};

/**
 * The label one target of a Role goes by: its alias, else the Role name. Used
 * for the `@` token, so it is what mention uniqueness checks.
 */
export const getAgentRoleTargetLabel = (
  role: Pick<AgentRole, 'name'>,
  target: Pick<AgentRoleTarget, 'alias'>
): string => target.alias || role.name;

/**
 * The value an `@` range carries for one target of a Role: the Role id, plus
 * the machine when the Role has several targets — the id alone would not say
 * which machine was meant. Role ids never contain `@`.
 */
export const formatAgentRoleMentionValue = (
  roleId: AgentRoleId,
  machineId?: MachineId,
  targetId?: string
): string =>
  targetId
    ? `${roleId}@${machineId ?? ''}@${targetId}`
    : machineId
      ? `${roleId}@${machineId}`
      : roleId;

export const parseAgentRoleMentionValue = (
  value: string
): { roleId: AgentRoleId; machineId?: MachineId; targetId?: AgentRoleInstanceId } => {
  const [roleId, machineId, targetId] = value.split('@');
  return {
    roleId: roleId as AgentRoleId,
    ...(machineId ? { machineId: machineId as MachineId } : {}),
    ...(targetId ? { targetId: targetId as AgentRoleInstanceId } : {}),
  };
};

export const resolveAgentRoleMentionValue = (
  roles: readonly AgentRole[],
  value: string
): AgentRole | undefined => {
  const { roleId, machineId, targetId } = parseAgentRoleMentionValue(value);
  const role = roles.find((entry) => entry.id === roleId);
  if (!role) return undefined;
  const target = targetId
    ? getAgentRoleTargets(role).find((entry) => entry.id === targetId)
    : undefined;
  if (targetId && (!target || (machineId && target.machineId !== machineId))) return undefined;
  if (target) return bindAgentRoleTarget(role, target.machineId, target.id);
  if (machineId) return bindAgentRoleTarget(role, machineId);
  return isMultiTargetAgentRole(role) ? undefined : role;
};

const targetsEqual = (left: AgentRoleTarget, right: AgentRoleTarget): boolean =>
  left.id === right.id &&
  left.machineId === right.machineId &&
  left.agentConfigId === right.agentConfigId &&
  (left.alias ?? '') === (right.alias ?? '') &&
  runConfigsEqual(left.runConfig, right.runConfig);

/**
 * Whether two Roles differ in anything worth a new revision.
 *
 * `revision` is recorded as Session provenance and in accepted Operations, so a
 * write that changes nothing must not create a new revision.
 */
export const isAgentRoleContentEqual = (left: AgentRole, right: AgentRole): boolean => {
  const leftTargets = getAgentRoleTargets(left);
  const rightTargets = getAgentRoleTargets(right);
  return (
    left.name === right.name &&
    (left.description ?? '') === (right.description ?? '') &&
    (left.emoji ?? '') === (right.emoji ?? '') &&
    left.visibility === right.visibility &&
    (left.promptPrefix ?? '') === (right.promptPrefix ?? '') &&
    leftTargets.length === rightTargets.length &&
    leftTargets.every((target, index) => {
      const other = rightTargets[index];
      return other !== undefined && targetsEqual(target, other);
    })
  );
};

// ---------------------------------------------------------------------------
// Visibility and ownership
// ---------------------------------------------------------------------------

/**
 * The authoritative trusted-UI discovery rule for Settings and the mention menu.
 */
export const canReadAgentRole = (role: AgentRole, userId: string | null | undefined): boolean =>
  role.visibility === 'workspace' || (Boolean(userId) && role.ownerUserId === userId);

/** V1: only the owner edits, shares, unshares, or deletes. */
export const canManageAgentRole = (role: AgentRole, userId: string | null | undefined): boolean =>
  Boolean(userId) && role.ownerUserId === userId;

export const listAccessibleAgentRoles = (
  roles: readonly AgentRole[],
  userId: string | null | undefined
): AgentRole[] => roles.filter((role) => canReadAgentRole(role, userId));

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export type AgentRoleUnavailableReason =
  | 'memory_unsupported'
  | 'machine_unknown'
  | 'machine_offline'
  | 'agent_config_missing'
  | 'agent_config_machine_mismatch'
  | 'other_machine';

export type AgentRoleAvailability =
  | { kind: 'available' }
  /** The binding cannot be judged yet — that machine's configs are not loaded. */
  | { kind: 'unknown' }
  | { kind: 'unavailable'; reason: AgentRoleUnavailableReason };

export type AgentRoleAvailabilityContext = {
  /** Machines the current user may reach at all. */
  authorizedMachineIds: ReadonlySet<MachineId>;
  memoryProviderMachineIds?: ReadonlySet<MachineId>;
  onlineMachineIds: ReadonlySet<MachineId>;
  /** Agent config id -> the machine it belongs to. */
  agentConfigMachineIds: ReadonlyMap<AgentConfigId, MachineId>;
  /**
   * Machines whose agent configs have actually been read. A machine outside
   * this set yields `unknown`, never `agent_config_missing`: reporting a Role
   * broken because its config list has not loaded is the same silent lie as
   * falling back to another config.
   */
  loadedAgentConfigMachineIds: ReadonlySet<MachineId>;
};

export const resolveAgentRoleInstanceAvailability = (
  role: Pick<AgentRoleTarget, 'machineId' | 'agentConfigId' | 'runConfig'>,
  context: AgentRoleAvailabilityContext
): AgentRoleAvailability => {
  if (!context.authorizedMachineIds.has(role.machineId)) {
    return { kind: 'unavailable', reason: 'machine_unknown' };
  }
  if (!context.loadedAgentConfigMachineIds.has(role.machineId)) {
    return { kind: 'unknown' };
  }
  const configMachineId = context.agentConfigMachineIds.get(role.agentConfigId);
  if (configMachineId === undefined) {
    return { kind: 'unavailable', reason: 'agent_config_missing' };
  }
  if (configMachineId !== role.machineId) {
    return { kind: 'unavailable', reason: 'agent_config_machine_mismatch' };
  }
  if (!context.onlineMachineIds.has(role.machineId)) {
    return { kind: 'unavailable', reason: 'machine_offline' };
  }
  if (role.runConfig.memory && !context.memoryProviderMachineIds?.has(role.machineId))
    return { kind: 'unavailable', reason: 'memory_unsupported' };
  return { kind: 'available' };
};

export const AGENT_ROLE_INSTANCE_ALIAS_MAX_LENGTH = AGENT_ROLE_ALIAS_MAX_LENGTH;

export const normalizeAgentRoleTargetAlias = (value: string): string =>
  Array.from(
    value
      .replace(/\p{Cc}/gu, '')
      .replace(/\s+/gu, ' ')
      .trim()
  )
    .slice(0, AGENT_ROLE_INSTANCE_ALIAS_MAX_LENGTH)
    .join('');

/**
 * The id an instance read from an older row gets. Every member reads the row
 * on its own, so the id is derived, never random: the same row yields the same
 * id everywhere. Older rows hold at most one entry per machine.
 */
export const legacyAgentRoleInstanceId = (roleId: string, machineId: string): AgentRoleInstanceId =>
  `${roleId}:${machineId}` as AgentRoleInstanceId;

const readMemoryOk = (runConfig: unknown): boolean =>
  !isRecord(runConfig) ||
  runConfig.memory === undefined ||
  MemoryBindingSchema.safeParse(runConfig.memory).success;

const readAgentRoleTarget = (value: unknown): AgentRoleTarget | undefined => {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.machineId) ||
    !isNonEmptyString(value.agentConfigId) ||
    (value.runConfig !== undefined && !isRecord(value.runConfig)) ||
    !readMemoryOk(value.runConfig)
  )
    return undefined;
  const alias = typeof value.alias === 'string' ? normalizeAgentRoleTargetAlias(value.alias) : '';
  return {
    id: value.id.trim() as AgentRoleInstanceId,
    ...(alias ? { alias } : {}),
    machineId: value.machineId.trim() as MachineId,
    agentConfigId: value.agentConfigId.trim() as AgentConfigId,
    runConfig: normalizeAgentRoleRunConfig(value.runConfig),
  };
};

/** An instance converted from an older row; it has no alias, so it groups by its agent. */
const legacyInstance = (
  roleId: string,
  machineId: string,
  agentConfigId: string,
  runConfig: unknown
): AgentRoleTarget => {
  const normalized = normalizeAgentRoleRunConfig(runConfig);
  return {
    id: legacyAgentRoleInstanceId(roleId, machineId),
    machineId: machineId.trim() as MachineId,
    agentConfigId: agentConfigId.trim() as AgentConfigId,
    runConfig: normalized,
  };
};

/**
 * The instances of a stored row, whichever client wrote it:
 * - `instances` as written now (valid entries, first of each id kept);
 * - `placements` as written by lan.4: enabled entries become instances, a
 *   switched-off one is dropped;
 * - otherwise the single machine the legacy fields name.
 */
const readAgentRoleTargets = (row: Record<string, unknown> & AgentRoleLegacyFields) => {
  const roleId = row.id.trim();
  if (Array.isArray(row.instances)) {
    const ids = new Set<string>();
    const instances: AgentRoleTarget[] = [];
    for (const entry of row.instances) {
      const instance = readAgentRoleTarget(entry);
      if (!instance || ids.has(instance.id)) continue;
      ids.add(instance.id);
      instances.push(instance);
    }
    if (instances.length > 0) return instances;
  }
  if (Array.isArray(row.placements)) {
    const machines = new Set<string>();
    const instances: AgentRoleTarget[] = [];
    for (const entry of row.placements) {
      if (
        !isRecord(entry) ||
        entry.enabled === false ||
        !isNonEmptyString(entry.machineId) ||
        !isNonEmptyString(entry.agentConfigId) ||
        (entry.runConfig !== undefined && !isRecord(entry.runConfig)) ||
        !readMemoryOk(entry.runConfig) ||
        machines.has(entry.machineId.trim())
      )
        continue;
      machines.add(entry.machineId.trim());
      instances.push(legacyInstance(roleId, entry.machineId, entry.agentConfigId, entry.runConfig));
    }
    if (instances.length > 0) return instances;
  }
  return [legacyInstance(roleId, row.machineId, row.agentConfigId, row.runConfig)];
};

type AgentRoleLegacyFields = {
  id: string;
  machineId: string;
  agentConfigId: string;
  runConfig?: unknown;
  instances?: unknown;
  placements?: unknown;
};

/** Stable ids keep the existing persisted instance-id references valid. */
export const findAgentRoleInstance = (role: AgentRole, id: string): AgentRoleTarget | undefined =>
  getAgentRoleTargets(role).find((target) => target.id === id);
export const listAgentRoleInstancesOnMachine = (
  role: AgentRole,
  machineId: MachineId
): AgentRoleTarget[] =>
  getAgentRoleTargets(role).filter((target) => target.machineId === machineId);

export type AgentRoleInstanceRule = 'instance' | 'explicit' | 'work_context';
export type AgentRoleInstanceChoice =
  | { kind: 'selected'; instance: AgentRoleTarget; rule: AgentRoleInstanceRule }
  | {
      kind: 'rejected';
      reason:
        | 'instance_not_found'
        | 'instance_machine_mismatch'
        | 'instance_unavailable'
        | 'machine_has_no_instance'
        | 'machine_unavailable'
        | 'machine_required'
        | 'target_required';
      instanceId?: string;
      machineId?: MachineId;
      rule?: AgentRoleInstanceRule;
      usableInstances: AgentRoleTarget[];
    };

/** Resolve only explicit identity or an unambiguous target; availability never breaks ties. */
export const selectAgentRoleInstance = (
  role: AgentRole,
  request: {
    instanceId?: string;
    alias?: string;
    machineId?: MachineId;
    workContextMachineId?: MachineId;
    callerMachineId?: MachineId;
  },
  isUsable: (target: AgentRoleTarget) => boolean,
  _groupKeyOf?: (target: AgentRoleTarget) => string
): AgentRoleInstanceChoice => {
  const targets = getAgentRoleTargets(role);
  const usableInstances = targets.filter(isUsable);
  const reject = (
    reason: Extract<AgentRoleInstanceChoice, { kind: 'rejected' }>['reason']
  ): AgentRoleInstanceChoice => ({
    kind: 'rejected',
    reason,
    usableInstances,
    instanceId: request.instanceId,
    machineId: request.machineId ?? request.workContextMachineId,
    rule: request.instanceId ? 'instance' : request.machineId ? 'explicit' : 'work_context',
  });
  if (
    request.machineId &&
    request.workContextMachineId &&
    request.machineId !== request.workContextMachineId
  )
    return reject('instance_machine_mismatch');
  if (request.instanceId) {
    const instance = targets.find((entry) => entry.id === request.instanceId);
    if (!instance) return reject('instance_not_found');
    if (
      [request.machineId, request.workContextMachineId].some(
        (machineId) => machineId && machineId !== instance.machineId
      )
    )
      return reject('instance_machine_mismatch');
    return isUsable(instance)
      ? { kind: 'selected', instance, rule: 'instance' }
      : reject('instance_unavailable');
  }
  const machineId = request.machineId ?? request.workContextMachineId;
  if (!machineId && new Set(targets.map((target) => target.machineId)).size > 1)
    return reject('machine_required');
  const matches = targets.filter(
    (target) =>
      (!machineId || target.machineId === machineId) &&
      (!request.alias || target.alias === request.alias)
  );
  if (!matches.length) return reject('machine_has_no_instance');
  if (matches.length > 1) return reject('target_required');
  const instance = matches[0]!;
  return isUsable(instance)
    ? {
        kind: 'selected',
        instance,
        rule: request.workContextMachineId && !request.machineId ? 'work_context' : 'explicit',
      }
    : reject('machine_unavailable');
};

export const resolveAgentRoleAvailability = (
  role: AgentRole,
  context: AgentRoleAvailabilityContext
): AgentRoleAvailability => {
  const results = getAgentRoleTargets(role).map((target) =>
    resolveAgentRoleInstanceAvailability(target, context)
  );
  return (
    results.find((result) => result.kind === 'available') ??
    results.find((result) => result.kind === 'unknown') ??
    results[0] ?? { kind: 'unknown' }
  );
};
export const composeAgentRolePrompt = (prefix: string | undefined, prompt: string): string =>
  prefix?.trim() ? `${prefix.trim()}\n\n${prompt}` : prompt;
