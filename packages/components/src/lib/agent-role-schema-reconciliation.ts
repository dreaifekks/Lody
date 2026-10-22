import {
  canManageAgentRole,
  getAgentRoleTargets,
  getWorkspaceFlockDocId,
  isAgentRoleContentEqual,
  normalizeAgentRole,
  withAgentRoleTargets,
  serializeAgentRoleRow,
  workspaceFlockKeys,
  type AcpCapabilityCacheEntry,
  type AgentRole,
  type AgentRoleTarget,
  type AgentRoleInstanceId,
} from '@lody/shared';
import type { WorkspaceRuntime } from '@/atoms/runtime';
import { uploadWorkspaceCatalog } from './workspace-catalog-write';

/** Only a complete, freshly probed runtime schema may remove saved keys.
 * Values of existing fields, model and permission pins remain user decisions.
 * Each instance is its own agent on its own machine, so one probe reconciles
 * only the instance it was made for.
 */
export function reconcileAgentRoleSchema(
  role: AgentRole,
  instanceId: AgentRoleInstanceId,
  capability: AcpCapabilityCacheEntry
): AgentRole {
  if (capability.provenance !== 'runtime' || !capability.configOptions) return role;
  const instance = getAgentRoleTargets(role).find((entry) => entry.id === instanceId);
  if (!instance) return role;
  const next = reconcileInstance(instance, capability.configOptions);
  if (next === instance) return role;
  return withAgentRoleTargets(
    role,
    getAgentRoleTargets(role).map((entry) => (entry.id === instance.id ? next : entry))
  );
}

function reconcileInstance(
  instance: AgentRoleTarget,
  configOptions: NonNullable<AcpCapabilityCacheEntry['configOptions']>
): AgentRoleTarget {
  const { runConfig } = instance;
  const advertised = new Set(configOptions.map((option) => option.id));
  const values = { ...runConfig.configOptionValues };
  let changed = false;
  const hasPlan = configOptions.some(
    (option) => option.id === 'plan_mode' && option.type === 'boolean'
  );
  if (hasPlan && values.plan_mode === undefined) {
    const legacy = !advertised.has('collaboration_mode') ? values.collaboration_mode : undefined;
    if (legacy === 'plan' || legacy === 'default') values.plan_mode = legacy === 'plan';
    else if (!advertised.has('interaction_mode') && values.interaction_mode === 'plan') {
      values.plan_mode = true;
    }
  }
  const probedModel = configOptions.find((option) => option.category === 'model');
  const sameModel = !runConfig.modelId || probedModel?.currentValue === runConfig.modelId;
  for (const key of Object.keys(values)) {
    if (advertised.has(key)) continue;
    // Permission policy must never silently fall back to the runtime default.
    if (/(permission|approval|sandbox)/i.test(key) || key === 'mode') continue;
    // Some agents expose different option keys for different models. Independent
    // Plan's retired field identities are known; other omissions need a matching model.
    const retiredPlanField =
      hasPlan && (key === 'collaboration_mode' || key === 'interaction_mode');
    if (!sameModel && !retiredPlanField) continue;
    delete values[key];
    changed = true;
  }
  if (!changed) return instance;
  return { ...instance, runConfig: { ...runConfig, configOptionValues: values } };
}

/**
 * Fence a delayed probe against editing, deletion, ownership and workspace changes.
 * `expected` is the Role bound to the probed machine; only that target changes,
 * and the row keeps its stored shape (v1 for a single-target Role).
 */
export async function persistReconciledAgentRole(
  runtime: WorkspaceRuntime,
  expected: AgentRole,
  instanceId: AgentRoleInstanceId,
  capability: AcpCapabilityCacheEntry,
  userId: string,
  now: number,
  isCurrent: () => boolean
): Promise<void> {
  const next = reconcileAgentRoleSchema(expected, instanceId, capability);
  if (next === expected) return;
  const changed = await runtime.writer.flockRowUpdate(
    getWorkspaceFlockDocId(runtime.workspaceId),
    workspaceFlockKeys.agentRole(expected.id),
    (current) => {
      const role = normalizeAgentRole(current);
      if (
        !isCurrent() ||
        !role ||
        !canManageAgentRole(role, userId) ||
        role.revision !== expected.revision ||
        !isAgentRoleContentEqual(role, expected)
      )
        return undefined;
      return serializeAgentRoleRow({
        ...next,
        revision: role.revision + 1,
        updatedAt: now,
      });
    }
  );
  if (changed) void uploadWorkspaceCatalog(runtime);
}
