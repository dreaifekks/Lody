import { MemoryBindingSchema, type MemoryBinding } from './memory-provider';
import type { AgentConfigId, AgentRoleId, AgentRoleInstanceId, MachineId } from './ids';
import { isSensitiveAcpConfigOptionId } from './session-preparation';

/**
 * Agent Role — a named, mentionable template for *creating* a Session.
 *
 * A Role says WHAT to do (name, description, prompt prefix); it never runs by
 * itself. Its instances say HOW: each instance is one Agent Config on one
 * machine with its own run config and memory binding, and is the unit that is
 * picked, dispatched and recorded. That boundary is the reason for most of the
 * rules below:
 *
 * - No secrets. A workspace Flock row is replicated to every member's client,
 *   so `private` limits trusted UI discovery and editing; it is not transport
 *   or storage confidentiality, and MCP creation may resolve an explicit id.
 *   V1 therefore refuses to persist anything secret-shaped in the first place
 *   (`isSensitiveAgentRoleConfigOptionKey`), rather than pretending a private
 *   row is a safe place to put one.
 * - Instances are ordered. A machine may hold several; the first one on a
 *   machine is that machine's default. Dispatch picks one by explicit, ordered
 *   rules (`selectAgentRoleInstance`) and reports which; it never swaps the
 *   agent or config inside an instance.
 * - `id` is the stable identity of a Role and of an instance. Mention tokens
 *   are DERIVED from the names and change when they do, so a mention range
 *   carries the ids.
 */

export const AGENT_ROLE_VERSION = 1;

export type AgentRoleVisibility = 'private' | 'workspace';

/**
 * The non-sensitive half of a Session config: what the agent capability itself
 * advertises. Deliberately not `AcpConfigOptionValue`-typed against the ACP
 * module — a Role stores only the primitive shapes an option selector produces.
 * `memory` is the instance's memory identity on its machine.
 */
export type AgentRoleRunConfig = {
  memory?: MemoryBinding;
  modeId?: string;
  modelId?: string;
  configOptionValues?: Record<string, string | boolean>;
};

/** One way a Role runs: an Agent Config on one machine and that agent's run config. */
export type AgentRoleInstance = {
  id: AgentRoleInstanceId;
  /** Short, unique within the Role: `uiStyle · Claude`. */
  label: string;
  machineId: MachineId;
  agentConfigId: AgentConfigId;
  runConfig: AgentRoleRunConfig;
};

export type AgentRole = {
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
   * Ordered and never empty. The order is the order dispatch tries machines
   * in, and the first instance on a machine is that machine's default.
   */
  instances: AgentRoleInstance[];
  /**
   * The first instance, also persisted so a client that predates instances
   * still reads the Role as a single-machine one. Never read for anything
   * else: every surface works with an instance.
   */
  machineId: MachineId;
  agentConfigId: AgentConfigId;
  runConfig: AgentRoleRunConfig;
  promptPrefix?: string;

  /** Bumped on every effective edit; frozen when a create Operation accepts this Role. */
  revision: number;
  createdAt: number;
  updatedAt: number;
};

declare const catalogAgentRoleBrand: unique symbol;

/**
 * A Role as the catalog holds it, with every instance. Only reading a stored
 * row (`normalizeAgentRole`) or building one from a complete instance list
 * (`withAgentRoleInstances`) produces one, so only a whole row reaches the
 * editor and the catalog writers.
 */
export type CatalogAgentRole = AgentRole & { readonly [catalogAgentRoleBrand]: true };

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
 * exactly what session preparation already refuses to retain — one rule, not two
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

const serializeInstances = (instances: readonly AgentRoleInstance[]): string =>
  JSON.stringify(
    instances.map((instance) => [
      instance.id,
      instance.label,
      instance.machineId,
      instance.agentConfigId,
      serializeRunConfig(instance.runConfig),
    ])
  );

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

export const AGENT_ROLE_INSTANCE_LABEL_MAX_LENGTH = 40;

export const normalizeAgentRoleInstanceLabel = (value: string): string =>
  Array.from(
    value
      .replace(/\p{Cc}/gu, '')
      .replace(/\s+/gu, ' ')
      .trim()
  )
    .slice(0, AGENT_ROLE_INSTANCE_LABEL_MAX_LENGTH)
    .join('');

/**
 * The id an instance read from an older row gets. Every member reads the row
 * on its own, so the id is derived, never random: the same row yields the same
 * id everywhere. Older rows hold at most one entry per machine.
 */
export const legacyAgentRoleInstanceId = (roleId: string, machineId: string): AgentRoleInstanceId =>
  `${roleId}:${machineId}` as AgentRoleInstanceId;

/** Give repeated labels a number, in list order, so labels stay unique in a Role. */
const uniqueLabels = (instances: AgentRoleInstance[]): AgentRoleInstance[] => {
  const seen = new Set<string>();
  return instances.map((instance) => {
    let label = instance.label;
    for (let n = 2; seen.has(label.toLowerCase()); n += 1) label = `${instance.label} ${n}`;
    seen.add(label.toLowerCase());
    return label === instance.label ? instance : { ...instance, label };
  });
};

const readMemoryOk = (runConfig: unknown): boolean =>
  !isRecord(runConfig) ||
  runConfig.memory === undefined ||
  MemoryBindingSchema.safeParse(runConfig.memory).success;

const readAgentRoleInstance = (value: unknown): AgentRoleInstance | undefined => {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.machineId) ||
    !isNonEmptyString(value.agentConfigId) ||
    typeof value.label !== 'string' ||
    !normalizeAgentRoleInstanceLabel(value.label) ||
    (value.runConfig !== undefined && !isRecord(value.runConfig)) ||
    !readMemoryOk(value.runConfig)
  )
    return undefined;
  return {
    id: value.id.trim() as AgentRoleInstanceId,
    label: normalizeAgentRoleInstanceLabel(value.label),
    machineId: value.machineId.trim() as MachineId,
    agentConfigId: value.agentConfigId.trim() as AgentConfigId,
    runConfig: normalizeAgentRoleRunConfig(value.runConfig),
  };
};

/** An instance converted from an older row, labelled by its model when it pins one. */
const legacyInstance = (
  roleId: string,
  machineId: string,
  agentConfigId: string,
  runConfig: unknown
): AgentRoleInstance => {
  const normalized = normalizeAgentRoleRunConfig(runConfig);
  return {
    id: legacyAgentRoleInstanceId(roleId, machineId),
    label: normalizeAgentRoleInstanceLabel(normalized.modelId ?? '') || 'Default',
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
const readAgentRoleInstances = (row: Record<string, unknown> & AgentRoleLegacyFields) => {
  const roleId = row.id.trim();
  if (Array.isArray(row.instances)) {
    const ids = new Set<string>();
    const instances: AgentRoleInstance[] = [];
    for (const entry of row.instances) {
      const instance = readAgentRoleInstance(entry);
      if (!instance || ids.has(instance.id)) continue;
      ids.add(instance.id);
      instances.push(instance);
    }
    if (instances.length > 0) return instances;
  }
  if (Array.isArray(row.placements)) {
    const machines = new Set<string>();
    const instances: AgentRoleInstance[] = [];
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
    if (instances.length > 0) return uniqueLabels(instances);
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

/**
 * Make a catalog row from a Role and its COMPLETE instance list, with the
 * legacy mirror that goes with it. Every writer builds rows through here, so
 * the mirror is always the first instance. The caller guarantees the list is
 * not empty.
 */
export const withAgentRoleInstances = (
  role: Omit<AgentRole, 'instances' | 'machineId' | 'agentConfigId' | 'runConfig'>,
  instances: AgentRoleInstance[]
): CatalogAgentRole => {
  const primary = instances[0]!;
  return {
    ...role,
    instances,
    machineId: primary.machineId,
    agentConfigId: primary.agentConfigId,
    runConfig: primary.runConfig,
  } as CatalogAgentRole;
};

export const listAgentRoleInstancesOnMachine = (
  role: Pick<AgentRole, 'instances'>,
  machineId: MachineId
): AgentRoleInstance[] => role.instances.filter((instance) => instance.machineId === machineId);

export const findAgentRoleInstance = (
  role: Pick<AgentRole, 'instances'>,
  instanceId: string
): AgentRoleInstance | undefined => role.instances.find((instance) => instance.id === instanceId);

/**
 * Which instance a Role-based create runs. The rules, in order:
 *
 * 0. A named instance runs as named, or the create fails; a machine named
 *    beside it, or bound by the work, must be that instance's machine.
 * 1. An explicitly requested machine must hold a usable instance; otherwise the
 *    create fails — it is never silently moved.
 * 2. A machine bound by the work (a local project, or a parent Session the new
 *    one joins) is the only one that makes sense; it fails the same way.
 * 3. Otherwise the caller's own machine, when it holds a usable instance.
 * 4. Otherwise the first machine, in list order, that holds a usable instance.
 *
 * On a chosen machine the first usable instance runs. The rule is returned so
 * callers can say which instance was picked and why.
 */
export type AgentRoleInstanceRule =
  | 'instance'
  | 'explicit'
  | 'work_context'
  | 'caller'
  | 'first_available';

export type AgentRoleInstanceChoice =
  | { kind: 'selected'; instance: AgentRoleInstance; rule: AgentRoleInstanceRule }
  | {
      kind: 'rejected';
      reason:
        | 'instance_not_found'
        | 'instance_machine_mismatch'
        | 'instance_unavailable'
        | 'machine_has_no_instance'
        | 'machine_unavailable'
        | 'no_instance_available';
      instanceId?: string;
      machineId?: MachineId;
      rule?: 'instance' | 'explicit' | 'work_context';
      /** Instances that could run the Role right now, in list order. */
      usableInstances: AgentRoleInstance[];
    };

export const selectAgentRoleInstance = (
  role: Pick<AgentRole, 'instances'>,
  request: {
    instanceId?: string;
    machineId?: MachineId;
    workContextMachineId?: MachineId;
    callerMachineId?: MachineId;
  },
  isUsable: (instance: AgentRoleInstance) => boolean
): AgentRoleInstanceChoice => {
  const usableInstances = role.instances.filter(isUsable);
  const reject = (
    reason: Extract<AgentRoleInstanceChoice, { kind: 'rejected' }>['reason'],
    rule: 'instance' | 'explicit' | 'work_context',
    detail: { instanceId?: string; machineId?: MachineId }
  ): AgentRoleInstanceChoice => ({ kind: 'rejected', reason, rule, ...detail, usableInstances });

  if (request.instanceId) {
    const instance = findAgentRoleInstance(role, request.instanceId);
    if (!instance)
      return reject('instance_not_found', 'instance', { instanceId: request.instanceId });
    for (const machineId of [request.machineId, request.workContextMachineId])
      if (machineId && machineId !== instance.machineId)
        return reject('instance_machine_mismatch', 'instance', {
          instanceId: instance.id,
          machineId,
        });
    if (!usableInstances.includes(instance))
      return reject('instance_unavailable', 'instance', { instanceId: instance.id });
    return { kind: 'selected', instance, rule: 'instance' };
  }
  const pinned: Array<['explicit' | 'work_context', MachineId | undefined]> = [
    ['explicit', request.machineId],
    ['work_context', request.workContextMachineId],
  ];
  for (const [rule, machineId] of pinned) {
    if (!machineId) continue;
    if (!role.instances.some((instance) => instance.machineId === machineId))
      return reject('machine_has_no_instance', rule, { machineId });
    const instance = usableInstances.find((entry) => entry.machineId === machineId);
    if (!instance) return reject('machine_unavailable', rule, { machineId });
    return { kind: 'selected', instance, rule };
  }
  const caller = usableInstances.find((entry) => entry.machineId === request.callerMachineId);
  if (caller) return { kind: 'selected', instance: caller, rule: 'caller' };
  const first = usableInstances[0];
  return first
    ? { kind: 'selected', instance: first, rule: 'first_available' }
    : { kind: 'rejected', reason: 'no_instance_available', usableInstances };
};

// ---------------------------------------------------------------------------
// Role validation
// ---------------------------------------------------------------------------

/**
 * Whether an untrusted value is a Role row.
 *
 * Flock rows arrive from whatever wrote them — an older client, a newer one, or
 * a hand-edited document — so nothing reads a Role without passing through
 * here first. The legacy single-machine fields are always present: every
 * writer keeps them as the mirror of the first instance.
 */
export const isAgentRole = (value: unknown): value is AgentRole => {
  if (
    !isRecord(value) ||
    value.v !== AGENT_ROLE_VERSION ||
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.ownerUserId) ||
    !isAgentRoleVisibility(value.visibility) ||
    !isNonEmptyString(value.name) ||
    !isNonEmptyString(value.machineId) ||
    !isNonEmptyString(value.agentConfigId) ||
    !isFiniteNumber(value.revision) ||
    !isFiniteNumber(value.createdAt) ||
    !isFiniteNumber(value.updatedAt)
  ) {
    return false;
  }
  if (value.emoji !== undefined && typeof value.emoji !== 'string') return false;
  if (value.description !== undefined && typeof value.description !== 'string') return false;
  if (value.promptPrefix !== undefined && typeof value.promptPrefix !== 'string') return false;
  if (value.runConfig !== undefined && !isRecord(value.runConfig)) return false;
  if (!readMemoryOk(value.runConfig)) return false;
  // A name that normalizes to nothing (only punctuation the token strips) has no
  // mention token, so it could never be used for what a Role is for.
  return getAgentRoleMentionSlug({ name: value.name.trim() }).length > 0;
};

/**
 * Read a persisted Role into the shape the product uses.
 *
 * Normalizing on read rather than trusting the row is what keeps a secret-named
 * option written by an older or buggy client from reaching a Session config,
 * and is where rows from older clients become instances
 * (`readAgentRoleInstances`).
 */
export const normalizeAgentRole = (value: unknown): CatalogAgentRole | undefined => {
  if (!isAgentRole(value)) return undefined;
  const emoji = normalizeAgentRoleEmoji(value.emoji);
  const description = normalizeAgentRoleDescription(value.description);
  const promptPrefix = value.promptPrefix?.trim();
  return withAgentRoleInstances(
    {
      v: AGENT_ROLE_VERSION,
      id: value.id.trim() as AgentRoleId,
      ownerUserId: value.ownerUserId.trim(),
      visibility: value.visibility,
      name: value.name.trim(),
      ...(description ? { description } : {}),
      ...(emoji ? { emoji } : {}),
      ...(promptPrefix ? { promptPrefix } : {}),
      revision: Math.max(1, Math.trunc(value.revision)),
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    },
    readAgentRoleInstances(value as unknown as Record<string, unknown> & AgentRoleLegacyFields)
  );
};

/**
 * Whether two Roles differ in anything worth a new revision.
 *
 * `revision` is recorded as Session provenance and in accepted Operations, so a
 * write that changes nothing must not create a new revision.
 */
export const isAgentRoleContentEqual = (left: AgentRole, right: AgentRole): boolean =>
  left.name === right.name &&
  (left.description ?? '') === (right.description ?? '') &&
  (left.emoji ?? '') === (right.emoji ?? '') &&
  left.visibility === right.visibility &&
  (left.promptPrefix ?? '') === (right.promptPrefix ?? '') &&
  serializeInstances(left.instances) === serializeInstances(right.instances);

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

export const listAccessibleAgentRoles = <T extends AgentRole>(
  roles: readonly T[],
  userId: string | null | undefined
): T[] => roles.filter((role) => canReadAgentRole(role, userId));

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export type AgentRoleUnavailableReason =
  | 'memory_unsupported'
  | 'machine_unknown'
  | 'machine_offline'
  | 'agent_config_missing'
  | 'agent_config_machine_mismatch';

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
  instance: AgentRoleInstance,
  context: AgentRoleAvailabilityContext
): AgentRoleAvailability => {
  const { machineId } = instance;
  if (!context.authorizedMachineIds.has(machineId)) {
    return { kind: 'unavailable', reason: 'machine_unknown' };
  }
  if (!context.loadedAgentConfigMachineIds.has(machineId)) {
    return { kind: 'unknown' };
  }
  const configMachineId = context.agentConfigMachineIds.get(instance.agentConfigId);
  if (configMachineId === undefined) {
    return { kind: 'unavailable', reason: 'agent_config_missing' };
  }
  if (configMachineId !== machineId) {
    return { kind: 'unavailable', reason: 'agent_config_machine_mismatch' };
  }
  if (!context.onlineMachineIds.has(machineId)) {
    return { kind: 'unavailable', reason: 'machine_offline' };
  }
  if (instance.runConfig.memory && !context.memoryProviderMachineIds?.has(machineId))
    return { kind: 'unavailable', reason: 'memory_unsupported' };
  return { kind: 'available' };
};

/**
 * A Role is available when any instance is; otherwise `unknown` while some
 * instance cannot be judged yet, else the first instance's reason.
 */
export const resolveAgentRoleAvailability = (
  role: Pick<AgentRole, 'instances'>,
  context: AgentRoleAvailabilityContext
): AgentRoleAvailability => {
  const results = role.instances.map((instance) =>
    resolveAgentRoleInstanceAvailability(instance, context)
  );
  return (
    results.find((result) => result.kind === 'available') ??
    results.find((result) => result.kind === 'unknown') ??
    results[0] ?? { kind: 'unknown' }
  );
};
