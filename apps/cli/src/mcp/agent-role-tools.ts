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
  type AgentRoleFormError,
  type AgentRoleFormPlacement,
  type AgentRoleFormValue,
  type AgentRolePlacement,
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

const PlacementSchema = z
  .object({
    agentConfigId: z
      .string()
      .trim()
      .min(1)
      .describe('Agent config id; it fixes the machine this entry runs on.'),
    enabled: z
      .boolean()
      .optional()
      .describe('Off keeps the entry without running there; on by default.'),
    runConfig: RunConfigSchema.optional(),
  })
  .strict();

const PlacementsSchema = z
  .array(PlacementSchema)
  .min(1)
  .max(20)
  .describe(
    'Where the Role may run: one entry per machine, in the order dispatch falls back through when neither the caller nor the work picks the machine. At least one entry must be enabled.'
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
    placements: PlacementsSchema,
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
    placements: PlacementsSchema.optional().describe(
      'Replaces the whole list; give every entry its full runConfig. A machine that stays keeps its memory binding.'
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
  /** The machine of an Agent config this user can read; throws otherwise. */
  agentMachineId: (agentConfigId: AgentConfigId) => Promise<MachineId>;
  tierOf: (
    placement: Pick<AgentRolePlacement, 'machineId' | 'agentConfigId' | 'runConfig'>
  ) => Promise<ResolvedPermissionTier>;
  now: () => number;
  createId: () => AgentRoleId;
};

const FORM_ERRORS: Record<AgentRoleFormError, string> = {
  name_required: 'Give the Role a name with at least one letter or digit.',
  name_taken: 'Another Role already has this name (or the same @mention token).',
  machine_required: 'Enable at least one placement.',
  agent_config_required: 'Choose an Agent config.',
};

/** The highest-running placement that exceeds the caller, if any. */
const findPlacementAboveCaller = async (
  placements: readonly AgentRolePlacement[],
  deps: AgentRoleWriteDeps
): Promise<{ machineId: MachineId; tier: ResolvedPermissionTier } | undefined> => {
  for (const placement of placements) {
    const tier = await deps.tierOf(placement);
    if (!isPermissionTierWithin(tier, deps.callerTier))
      return { machineId: placement.machineId, tier };
  }
  return undefined;
};

const SETTINGS = 'Settings → Agent Roles';
const UNKNOWN_HINT =
  'Unknown means a mode Lody does not rank, an Agent without reported capabilities, or a permission option beside the mode (such as permission_mode) left unset: set each one explicitly.';

/**
 * The Role an Agent asked for, checked the way Settings checks it and kept
 * within the calling Session's permission tier on every placement: a Role that
 * runs higher on any machine, or already does, is the user's to set in Settings.
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
    const above = await findPlacementAboveCaller(existing.placements, deps);
    if (above)
      throw new Error(
        `This Role runs with more permissions than this conversation on machine ${above.machineId} (Role: ${above.tier}, conversation: ${deps.callerTier}). Only the user can change it, in ${SETTINGS}.`
      );
  } else if (roles.length >= MAX_AGENT_ROLES) {
    throw new Error(`The workspace already has ${MAX_AGENT_ROLES} Agent Roles.`);
  }

  const { input } = request;
  const base: AgentRoleFormValue = existing
    ? buildAgentRoleFormValue(existing)
    : EMPTY_AGENT_ROLE_FORM_VALUE;
  const placements: AgentRoleFormPlacement[] = [];
  for (const entry of input.placements ?? []) {
    const agentConfigId = entry.agentConfigId as AgentConfigId;
    const machineId = await deps.agentMachineId(agentConfigId);
    if (placements.some((placement) => placement.machineId === machineId))
      throw new Error(`Two placements run on machine ${machineId}; give each machine one entry.`);
    const memory = base.placements.find((placement) => placement.machineId === machineId)?.memory;
    placements.push({
      machineId,
      enabled: entry.enabled ?? true,
      agentConfigId,
      modeId: entry.runConfig?.modeId ?? null,
      modelId: entry.runConfig?.modelId ?? null,
      configOptionValues: entry.runConfig?.configOptionValues ?? {},
      ...(memory ? { memory } : {}),
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
    ...(input.placements ? { placements } : {}),
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
  const above = await findPlacementAboveCaller(role.placements, deps);
  if (above)
    throw new Error(
      `The Role would run with more permissions than this conversation on machine ${above.machineId} (Role: ${above.tier}, conversation: ${deps.callerTier}). Only the user can set that, in ${SETTINGS}.${above.tier === 'unknown' ? ` ${UNKNOWN_HINT}` : ''}`
    );
  return role;
}

const ROLE_CEILING =
  'On every placement the Role may run with at most the permissions this conversation runs with now (its permission mode); a higher or unrecognized mode is refused and only the user can set it in Settings → Agent Roles. Set every permission option the Agent has beside its mode (such as permission_mode) explicitly. Pi Roles are exempt.';

export function registerAgentRoleWriteTools(
  registerSessionTool: ReturnType<typeof createSessionToolRegistrar>,
  write: (request: AgentRoleWrite) => Promise<CallToolResult>
): void {
  registerSessionTool(
    'lody_agent_role_create',
    {
      title: 'Create an Agent Role',
      description: [
        'Create an Agent Role (a named task preset: prompt prefix plus, per machine, the Agent',
        'config, model, mode and options it runs with) when the user asks for one. Read ids and runConfig choices with',
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
        'Change an Agent Role the user owns. Omitted fields stay; placements replaces the whole',
        'list. A Role that already runs with more permissions than this conversation on any machine can',
        'only be changed by the user. Roles cannot be deleted here.',
        ROLE_CEILING,
      ].join(' '),
      inputSchema: AgentRoleUpdateToolInputSchema,
    },
    (input) => write({ action: 'update', input })
  );
}
