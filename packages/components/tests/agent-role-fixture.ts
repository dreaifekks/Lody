import {
  legacyAgentRoleInstanceId,
  withAgentRoleInstances,
  type AgentRole,
  type CatalogAgentRole,
} from '@lody/shared';

/**
 * A Role fixture written the single-machine way: its one instance is its
 * legacy `machineId`/`agentConfigId`/`runConfig` (with the id a reader derives
 * for such a row), unless `instances` is given.
 */
export const singleMachineRole = (
  row: Omit<AgentRole, 'instances'> & Partial<Pick<AgentRole, 'instances'>>
): CatalogAgentRole =>
  withAgentRoleInstances(
    row,
    row.instances ?? [
      {
        id: legacyAgentRoleInstanceId(row.id, row.machineId),
        label: 'Default',
        machineId: row.machineId,
        agentConfigId: row.agentConfigId,
        runConfig: row.runConfig,
      },
    ]
  );
