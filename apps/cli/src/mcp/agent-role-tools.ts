import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  AGENT_ROLE_DESCRIPTION_MAX_LENGTH,
  AGENT_ROLE_INSTANCE_ALIAS_MAX_LENGTH,
  AGENT_ROLE_NAME_MAX_LENGTH,
  buildAgentRoleFormValue,
  buildAgentRoleFromForm,
  canManageAgentRole,
  EMPTY_AGENT_ROLE_FORM_VALUE,
  getAgentRoleAgentFamily,
  isPermissionTierWithin,
  isSensitiveAgentRoleConfigOptionKey,
  listAccessibleAgentRoles,
  validateAgentRoleForm,
  type AgentRoleAgentConfig,
  type AgentRoleAgentFamily,
  type AgentRoleFormError,
  type AgentRoleFormInstance,
  type AgentRoleFormValue,
  type AgentRoleInstance,
  type AgentRoleInstanceId,
  type CatalogAgentRole,
  type AgentRoleId,
  type AgentConfigId,
  type MachineId,
  type ResolvedPermissionTier,
} from '@lody/shared';
import type { createSessionToolRegistrar } from './session-tool-router';

/** Agent-authored Roles share the MCP catalog's bound on one workspace document. */
export const MAX_AGENT_ROLES = 100;
const MAX_PROMPT_PREFIX_LENGTH = 32_768;

const RunConfigSchema = z
  .object({
    modeId: z.string().trim().min(1).max(200).optional(),
    modelId: z.string().trim().min(1).max(200).optional(),
    configOptionValues: z
      .record(
        z
          .string()
          .trim()
          .min(1)
          .max(100)
          .refine((key) => !isSensitiveAgentRoleConfigOptionKey(key), {
            message:
              'A Role cannot store credentials or identities; they belong in the Agent configuration.',
          }),
        z.union([z.string().max(1024), z.boolean()])
      )
      .refine((values) => Object.keys(values).length <= 50, {
        message: 'At most 50 options are allowed.',
      })
      .optional(),
  })
  .strict()
  .describe(
    'Mode, model and option values from the Agent config runConfig (lody_agent_config_get). Omitted fields run with the Agent defaults.'
  );

const InstanceSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'Id of an existing instance to keep (it keeps its memory binding); omit for a new instance.'
      ),
    alias: z
      .string()
      .trim()
      .min(1)
      .max(AGENT_ROLE_INSTANCE_ALIAS_MAX_LENGTH)
      .optional()
      .describe(
        'Optional name. Instances with one alias are one group across machines; without one, an instance groups with its agent (Claude Code, Codex…). Needed for a second instance of the same agent on one machine. Omitted means none.'
      ),
    agentConfigId: z
      .string()
      .trim()
      .min(1)
      .describe('Agent config id; it fixes the machine this instance runs on.'),
    runConfig: RunConfigSchema.optional(),
  })
  .strict();

const InstancesSchema = z
  .array(InstanceSchema)
  .min(1)
  .max(20)
  .describe(
    'How the Role runs: each instance is one Agent config with its run config on its machine. Instances group by alias, else by agent; a group stands in for itself across machines and a machine holds one instance per group. A bare Role runs the first group, in list order, that can run, preferring the caller machine inside it.'
  );

const editableFields = {
  name: z
    .string()
    .trim()
    .min(1)
    .max(AGENT_ROLE_NAME_MAX_LENGTH)
    .describe('Unique name; it is also the @mention token.'),
  description: z
    .string()
    .trim()
    .max(AGENT_ROLE_DESCRIPTION_MAX_LENGTH)
    .describe('When other agents should pick this Role.'),
  emoji: z.string().trim().max(16),
  promptPrefix: z
    .string()
    .max(MAX_PROMPT_PREFIX_LENGTH)
    .describe('Instructions placed before every prompt sent to this Role.'),
  shareWithWorkspace: z.boolean().describe('Visible to every workspace member; off by default.'),
};

export const AgentRoleCreateToolInputSchema = z
  .object({
    name: editableFields.name,
    description: editableFields.description.optional(),
    emoji: editableFields.emoji.optional(),
    instances: InstancesSchema,
    promptPrefix: editableFields.promptPrefix.optional(),
    shareWithWorkspace: editableFields.shareWithWorkspace.optional(),
  })
  .strict();
export type AgentRoleCreateToolInput = z.infer<typeof AgentRoleCreateToolInputSchema>;

export const AgentRoleUpdateToolInputSchema = z
  .object({
    agentRoleId: z.string().trim().min(1),
    name: editableFields.name.optional(),
    description: editableFields.description.optional(),
    emoji: editableFields.emoji.optional(),
    instances: InstancesSchema.optional().describe(
      'Replaces the whole list; give every instance its full runConfig. An instance passed with its id keeps its memory binding.'
    ),
    promptPrefix: editableFields.promptPrefix.optional(),
    shareWithWorkspace: editableFields.shareWithWorkspace.optional(),
  })
  .strict();
export type AgentRoleUpdateToolInput = z.infer<typeof AgentRoleUpdateToolInputSchema>;

export type AgentRoleWrite =
  | { action: 'create'; input: AgentRoleCreateToolInput }
  | { action: 'update'; input: AgentRoleUpdateToolInput };

export type AgentRoleWriteDeps = {
  userId: string;
  /** Tier of the Session driving this call. */
  callerTier: ResolvedPermissionTier;
  roles: () => Promise<CatalogAgentRole[]>;
  /** An Agent config this user can read; throws otherwise. */
  agentConfig: (
    agentConfigId: AgentConfigId
  ) => Promise<AgentRoleAgentConfig & { machineId: MachineId }>;
  tierOf: (
    instance: Pick<AgentRoleInstance, 'machineId' | 'agentConfigId' | 'runConfig'>
  ) => Promise<ResolvedPermissionTier>;
  now: () => number;
  createId: () => AgentRoleId;
  createInstanceId: () => AgentRoleInstanceId;
};

const FORM_ERRORS: Record<AgentRoleFormError, string> = {
  name_required: 'Give the Role a name with at least one letter or digit.',
  name_taken: 'Another Role already has this name (or the same @mention token).',
  instance_required: 'Give the Role at least one instance.',
  machine_required: 'Choose an Agent config for every instance.',
  agent_config_required: 'Choose an Agent config for every instance.',
  group_taken:
    'Two instances on one machine would be one group (the same agent, or the same alias): give one of them an alias.',
};

/** The first instance that runs higher than the caller, if any. */
const findInstanceAboveCaller = async (
  instances: readonly AgentRoleInstance[],
  deps: AgentRoleWriteDeps
): Promise<{ instance: AgentRoleInstance; tier: ResolvedPermissionTier } | undefined> => {
  for (const instance of instances) {
    const tier = await deps.tierOf(instance);
    if (!isPermissionTierWithin(tier, deps.callerTier)) return { instance, tier };
  }
  return undefined;
};

const describeInstance = ({ instance }: { instance: AgentRoleInstance }) =>
  `instance ${instance.alias ?? instance.id} on machine ${instance.machineId}`;

const SETTINGS = 'Settings → Agent Roles';
const UNKNOWN_HINT =
  'Unknown means a mode Lody does not rank, an Agent without reported capabilities, or a permission option beside the mode (such as permission_mode) left unset: set each one explicitly.';

/**
 * The Role an Agent asked for, checked the way Settings checks it and kept
 * within the calling Session's permission tier on every instance: a Role whose
 * instance runs higher, or already does, is the user's to set in Settings.
 */
export async function buildAgentRoleFromAgent(
  request: AgentRoleWrite,
  deps: AgentRoleWriteDeps
): Promise<CatalogAgentRole> {
  const roles = await deps.roles();
  const existing =
    request.action === 'update'
      ? roles.find((role) => role.id === request.input.agentRoleId)
      : undefined;
  if (request.action === 'update') {
    if (!existing || !canManageAgentRole(existing, deps.userId))
      throw new Error('No Agent Role with that id that you own.');
    const above = await findInstanceAboveCaller(existing.instances, deps);
    if (above)
      throw new Error(
        `This Role runs with more permissions than this conversation in ${describeInstance(above)} (Role: ${above.tier}, conversation: ${deps.callerTier}). Only the user can change it, in ${SETTINGS}.`
      );
  } else if (roles.length >= MAX_AGENT_ROLES) {
    throw new Error(`The workspace already has ${MAX_AGENT_ROLES} Agent Roles.`);
  }

  const { input } = request;
  const base: AgentRoleFormValue = existing
    ? buildAgentRoleFormValue(existing)
    : EMPTY_AGENT_ROLE_FORM_VALUE;
  const instances: AgentRoleFormInstance[] = [];
  const families = new Map<AgentConfigId, AgentRoleAgentFamily>();
  for (const entry of input.instances ?? []) {
    const agentConfigId = entry.agentConfigId as AgentConfigId;
    const config = await deps.agentConfig(agentConfigId);
    families.set(agentConfigId, getAgentRoleAgentFamily(config));
    // Memory is the user's to bind; a kept instance keeps its own.
    const kept = entry.id ? base.instances.find((instance) => instance.id === entry.id) : undefined;
    if (entry.id && !kept) throw new Error(`The Role has no instance ${entry.id}.`);
    instances.push({
      id: kept?.id ?? deps.createInstanceId(),
      alias: entry.alias ?? '',
      machineId: config.machineId,
      agentConfigId,
      modeId: entry.runConfig?.modeId ?? null,
      modelId: entry.runConfig?.modelId ?? null,
      configOptionValues: entry.runConfig?.configOptionValues ?? {},
      ...(kept?.memory && kept.machineId === config.machineId ? { memory: kept.memory } : {}),
    });
  }
  const value: AgentRoleFormValue = {
    ...base,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.emoji !== undefined ? { emoji: input.emoji } : {}),
    ...(input.promptPrefix !== undefined ? { promptPrefix: input.promptPrefix } : {}),
    ...(input.shareWithWorkspace !== undefined
      ? { shareWithWorkspace: input.shareWithWorkspace }
      : {}),
    ...(input.instances ? { instances } : {}),
  };
  const errors = validateAgentRoleForm(value, {
    accessibleRoles: listAccessibleAgentRoles(roles, deps.userId),
    editingRoleId: existing?.id ?? null,
    agentFamilyOf: (id) => families.get(id),
  });
  if (errors.length > 0) throw new Error(FORM_ERRORS[errors[0]!]);
  const role = buildAgentRoleFromForm(value, {
    existing,
    ownerUserId: deps.userId,
    now: deps.now(),
    createId: deps.createId,
  });
  const above = await findInstanceAboveCaller(role.instances, deps);
  if (above)
    throw new Error(
      `The Role would run with more permissions than this conversation in ${describeInstance(above)} (Role: ${above.tier}, conversation: ${deps.callerTier}). Only the user can set that, in ${SETTINGS}.${above.tier === 'unknown' ? ` ${UNKNOWN_HINT}` : ''}`
    );
  return role;
}

const ROLE_CEILING =
  'In every instance the Role may run with at most the permissions this conversation runs with now (its permission mode); a higher or unrecognized mode is refused and only the user can set it in Settings → Agent Roles. Set every permission option the Agent has beside its mode (such as permission_mode) explicitly. Pi Roles are exempt.';

export function registerAgentRoleWriteTools(
  registerSessionTool: ReturnType<typeof createSessionToolRegistrar>,
  write: (request: AgentRoleWrite) => Promise<CallToolResult>
): void {
  registerSessionTool(
    'lody_agent_role_create',
    {
      title: 'Create an Agent Role',
      description: [
        'Create an Agent Role (a named task template: prompt prefix plus instances, each an Agent',
        'config on its machine with the model, mode and options it runs with) when the user asks for one. Read ids and runConfig choices with',
        'lody_agent_config_list / lody_agent_config_get. New Roles are private unless',
        'shareWithWorkspace is set. Credentials, identities and memory cannot be set here.',
        ROLE_CEILING,
      ].join(' '),
      inputSchema: AgentRoleCreateToolInputSchema,
    },
    (input) => write({ action: 'create', input })
  );
  registerSessionTool(
    'lody_agent_role_update',
    {
      title: 'Change an Agent Role',
      description: [
        'Change an Agent Role the user owns. Omitted fields stay; instances replaces the whole',
        'list (pass an existing instance id to keep it). A Role with an instance that already runs with more permissions than this conversation can',
        'only be changed by the user. Roles cannot be deleted here.',
        ROLE_CEILING,
      ].join(' '),
      inputSchema: AgentRoleUpdateToolInputSchema,
    },
    (input) => write({ action: 'update', input })
  );
}
