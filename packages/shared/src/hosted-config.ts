import { z } from 'zod';

/**
 * Importing the configuration of a hosted installation on the same machine
 * into a workspace of the local platform. The source is read from the files
 * the hosted installation left on disk; nothing is requested from its service.
 */
export const HOSTED_CONFIG_CATEGORIES = [
  'agentConfigs',
  'mcpServers',
  'agentRoles',
  'localProjects',
  'worktreeScripts',
] as const;
export type HostedConfigCategory = (typeof HOSTED_CONFIG_CATEGORIES)[number];

export const HostedConfigCategorySchema = z.enum(HOSTED_CONFIG_CATEGORIES);

/**
 * What an import does with one item:
 * - `create`: the workspace has nothing like it.
 * - `update`: the workspace has its counterpart, which takes the hosted values.
 * - `unchanged`: the workspace already holds the same values.
 * - `skip`: the item cannot be used here; `reason` says why.
 */
export const HOSTED_CONFIG_ACTIONS = ['create', 'update', 'unchanged', 'skip'] as const;
export type HostedConfigAction = (typeof HOSTED_CONFIG_ACTIONS)[number];

export const HOSTED_CONFIG_SKIP_REASONS = [
  'other_machine',
  'missing_directory',
  'missing_project',
  'missing_agent',
  'invalid',
] as const;
export type HostedConfigSkipReason = (typeof HOSTED_CONFIG_SKIP_REASONS)[number];

export const HostedConfigItemSchema = z
  .object({
    category: HostedConfigCategorySchema,
    id: z.string().min(1),
    name: z.string(),
    /** A path, an agent type or a transport: what tells two items of one name apart. */
    detail: z.string().optional(),
    action: z.enum(HOSTED_CONFIG_ACTIONS),
    reason: z.enum(HOSTED_CONFIG_SKIP_REASONS).optional(),
    /** The hosted sign-in of this agent stays behind; it has to sign in again. */
    needsSignIn: z.boolean().optional(),
  })
  .strict();
export type HostedConfigItem = z.infer<typeof HostedConfigItemSchema>;

export const HostedConfigSourceSchema = z
  .object({
    workspaceId: z.string().min(1),
    name: z.string(),
    items: z.array(HostedConfigItemSchema),
  })
  .strict();
export type HostedConfigSource = z.infer<typeof HostedConfigSourceSchema>;

export const HostedConfigPreviewSchema = z
  .object({
    /** False when this machine holds no hosted installation to import from. */
    found: z.boolean(),
    sources: z.array(HostedConfigSourceSchema),
  })
  .strict();
export type HostedConfigPreview = z.infer<typeof HostedConfigPreviewSchema>;

export const HostedConfigImportResultSchema = z
  .object({
    workspaceId: z.string().min(1),
    items: z.array(HostedConfigItemSchema),
  })
  .strict();
export type HostedConfigImportResult = z.infer<typeof HostedConfigImportResultSchema>;

export function countHostedConfigItems(
  items: readonly HostedConfigItem[],
  actions: readonly HostedConfigAction[]
): number {
  return items.filter((item) => actions.includes(item.action)).length;
}
