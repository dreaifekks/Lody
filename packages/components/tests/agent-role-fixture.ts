import {
  legacyAgentRoleInstanceId,
  withAgentRoleInstances,
  type AgentConfigMeta,
  type AgentRole,
  type AgentRoleAvailability,
  type CatalogAgentRole,
  type MachineId,
} from '@lody/shared';
import {
  buildComposerAgentRoleItems,
  type ComposerAgentRoleItem,
} from '../src/lib/composer-agent-roles';

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

/**
 * A Role's composer entries, built as the composer builds them on the Role's
 * first machine; its agents are taken as Codex unless `agentConfigs` says.
 */
export const composerItemsOf = (
  role: CatalogAgentRole,
  options: {
    availability?: AgentRoleAvailability;
    machineId?: MachineId;
    agentConfigs?: AgentConfigMeta[];
  } = {}
): ComposerAgentRoleItem[] =>
  buildComposerAgentRoleItems({
    roles: [role],
    machineId: options.machineId ?? role.instances[0]!.machineId,
    agentConfigs:
      options.agentConfigs ??
      role.instances.map(
        (instance) =>
          ({
            id: instance.agentConfigId,
            machineId: instance.machineId,
            name: 'Codex',
            cliType: 'builtin',
            agentType: 'codex',
            env: {},
          }) as AgentConfigMeta
      ),
    resolveAvailability: () => options.availability ?? { kind: 'available' },
    names: { machine: (id) => id, unknownAgent: 'Unknown agent' },
  });
