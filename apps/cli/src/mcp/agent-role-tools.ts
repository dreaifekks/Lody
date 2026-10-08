import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  AGENT_ROLE_DESCRIPTION_MAX_LENGTH,
  AGENT_ROLE_NAME_MAX_LENGTH,
  buildAgentRoleFormValue,
  buildAgentRoleFromForm,
  canManageAgentRole,
  EMPTY_AGENT_ROLE_FORM_VALUE,
  isPermissionTierWithin,
  isSensitiveAgentRoleConfigOptionKey,
  listAccessibleAgentRoles,
  validateAgentRoleForm,
  type AgentRole,
  type AgentRoleFormError,
  type AgentRoleFormValue,
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
    agentConfigId: z.string().trim().min(1).describe('Agent config id; it fixes the machine.'),
    runConfig: RunConfigSchema.optional(),
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
    agentConfigId: z.string().trim().min(1).optional(),
    runConfig: RunConfigSchema.optional().describe(
      'Replaces the whole run config. Required when agentConfigId changes.'
    ),
    promptPrefix: editableFields.promptPrefix.optional(),
    shareWithWorkspace: editableFields.shareWithWorkspace.optional(),
  })
  .strict()
  .refine((input) => input.agentConfigId === undefined || input.runConfig !== undefined, {
    message: 'Changing agentConfigId needs runConfig: the old selections belong to the old Agent.',
  });
export type AgentRoleUpdateToolInput = z.infer<typeof AgentRoleUpdateToolInputSchema>;

export type AgentRoleWrite =
  | { action: 'create'; input: AgentRoleCreateToolInput }
  | { action: 'update'; input: AgentRoleUpdateToolInput };

export type AgentRoleWriteDeps = {
  userId: string;
  /** Tier of the Session driving this call. */
  callerTier: ResolvedPermissionTier;
  roles: () => Promise<AgentRole[]>;
  /** The machine of an Agent config this user can read; throws otherwise. */
  agentMachineId: (agentConfigId: AgentConfigId) => Promise<MachineId>;
  tierOf: (
    role: Pick<AgentRole, 'machineId' | 'agentConfigId' | 'runConfig'>
  ) => Promise<ResolvedPermissionTier>;
  now: () => number;
  createId: () => AgentRoleId;
};

const FORM_ERRORS: Record<AgentRoleFormError, string> = {
  name_required: 'Give the Role a name with at least one letter or digit.',
  name_taken: 'Another Role already has this name (or the same @mention token).',
  machine_required: 'Choose an Agent config.',
  agent_config_required: 'Choose an Agent config.',
};

const SETTINGS = 'Settings → Agent Roles';

/**
 * The Role an Agent asked for, checked the way Settings checks it and kept
 * within the calling Session's permission tier: a Role that runs higher, or
 * one already above that tier, is the user's to set in Settings.
 */
export async function buildAgentRoleFromAgent(
  request: AgentRoleWrite,
  deps: AgentRoleWriteDeps
): Promise<AgentRole> {
  const roles = await deps.roles();
  const existing =
    request.action === 'update'
      ? roles.find((role) => role.id === request.input.agentRoleId)
      : undefined;
  if (request.action === 'update') {
    if (!existing || !canManageAgentRole(existing, deps.userId))
      throw new Error('No Agent Role with that id that you own.');
    const current = await deps.tierOf(existing);
    if (!isPermissionTierWithin(current, deps.callerTier))
      throw new Error(
        `This Role runs with more permissions than this conversation (Role: ${current}, conversation: ${deps.callerTier}). Only the user can change it, in ${SETTINGS}.`
      );
  } else if (roles.length >= MAX_AGENT_ROLES) {
    throw new Error(`The workspace already has ${MAX_AGENT_ROLES} Agent Roles.`);
  }

  const { input } = request;
  const base: AgentRoleFormValue = existing
    ? buildAgentRoleFormValue(existing)
    : EMPTY_AGENT_ROLE_FORM_VALUE;
  const agentConfigId = (input.agentConfigId ?? existing?.agentConfigId) as AgentConfigId;
  const runConfig = input.runConfig;
  const value: AgentRoleFormValue = {
    ...base,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.emoji !== undefined ? { emoji: input.emoji } : {}),
    ...(input.promptPrefix !== undefined ? { promptPrefix: input.promptPrefix } : {}),
    ...(input.shareWithWorkspace !== undefined
      ? { shareWithWorkspace: input.shareWithWorkspace }
      : {}),
    agentConfigId,
    machineId: await deps.agentMachineId(agentConfigId),
    ...(runConfig
      ? {
          modeId: runConfig.modeId ?? null,
          modelId: runConfig.modelId ?? null,
          configOptionValues: runConfig.configOptionValues ?? {},
        }
      : {}),
  };
  const errors = validateAgentRoleForm(value, {
    accessibleRoles: listAccessibleAgentRoles(roles, deps.userId),
    editingRoleId: existing?.id ?? null,
  });
  if (errors.length > 0) throw new Error(FORM_ERRORS[errors[0]!]);
  const role = buildAgentRoleFromForm(value, {
    existing,
    ownerUserId: deps.userId,
    now: deps.now(),
    createId: deps.createId,
  });
  const tier = await deps.tierOf(role);
  if (!isPermissionTierWithin(tier, deps.callerTier))
    throw new Error(
      `The Role would run with more permissions than this conversation (Role: ${tier}, conversation: ${deps.callerTier}). Only the user can set that, in ${SETTINGS}.`
    );
  return role;
}

const ROLE_CEILING =
  'The Role may run with at most the permissions this conversation runs with now (its permission mode); a higher or unrecognized mode is refused and only the user can set it in Settings → Agent Roles.';

export function registerAgentRoleWriteTools(
  registerSessionTool: ReturnType<typeof createSessionToolRegistrar>,
  write: (request: AgentRoleWrite) => Promise<CallToolResult>
): void {
  registerSessionTool(
    'lody_agent_role_create',
    {
      title: 'Create an Agent Role',
      description: [
        'Create an Agent Role (a named preset of Agent config, model, mode, options and prompt',
        'prefix) when the user asks for one. Read ids and runConfig choices with',
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
        'Change an Agent Role the user owns. Omitted fields stay; runConfig replaces the whole',
        'run config. A Role that already runs with more permissions than this conversation can',
        'only be changed by the user. Roles cannot be deleted here.',
        ROLE_CEILING,
      ].join(' '),
      inputSchema: AgentRoleUpdateToolInputSchema,
    },
    (input) => write({ action: 'update', input })
  );
}
