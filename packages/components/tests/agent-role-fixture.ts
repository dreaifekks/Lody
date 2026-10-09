import { withAgentRolePlacements, type AgentRole } from '@lody/shared';

/**
 * A Role fixture written the single-machine way: its one placement is its
 * legacy `machineId`/`agentConfigId`/`runConfig`, unless `placements` is given.
 */
export const singleMachineRole = (
  row: Omit<AgentRole, 'placements'> & Partial<Pick<AgentRole, 'placements'>>
): AgentRole =>
  withAgentRolePlacements(
    row,
    row.placements ?? [
      {
        machineId: row.machineId,
        agentConfigId: row.agentConfigId,
        enabled: true,
        runConfig: row.runConfig,
      },
    ]
  );
