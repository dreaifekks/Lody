import {
  legacyAgentRoleInstanceId,
  withAgentRoleInstances,
  type AcpCapabilityCacheEntry,
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

/**
 * A built-in Claude config's capabilities in the shape a machine reports them,
 * values copied from a real row and its option lists trimmed: the probed
 * `configOptions` describe the model current at probe time (`opus`, which has
 * Fast), and the adapter's own declaration says per model what exists —
 * `claude-fable-5-1` takes effort and has no Fast toggle.
 */
export const reportedClaudeCapabilities = {
  cacheVersion: 9,
  cliType: 'builtin',
  agentType: 'claude',
  provenance: 'runtime',
  fetchedAt: 1,
  sourceVersion: 'builtin-claude-acp:0.79.0+agent-sdk:0.3.284+claude-code:2.1.284',
  modes: [
    { id: 'default', name: 'Manual' },
    { id: 'auto', name: 'Auto' },
  ],
  models: [
    { modelId: 'opus', name: 'Opus 5.5' },
    { modelId: 'claude-fable-5-1', name: 'Fable 5.1' },
  ],
  configOptions: [
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Manual' },
        { value: 'auto', name: 'Auto' },
      ],
    },
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'opus',
      options: [
        { value: 'opus', name: 'Opus 5.5' },
        { value: 'claude-fable-5-1', name: 'Fable 5.1' },
      ],
    },
    {
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: 'high',
      options: ['default', 'low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({
        value,
        name: value,
      })),
    },
    {
      id: 'fast',
      name: 'Fast mode',
      category: 'model_config',
      type: 'boolean',
      currentValue: false,
      options: [],
    },
  ],
  declaredModelControls: {
    opus: { effortValues: ['low', 'medium', 'high', 'xhigh', 'max'], fastMode: true },
    'claude-fable-5-1': {
      effortValues: ['low', 'medium', 'high', 'xhigh', 'max'],
      fastMode: false,
    },
  },
} as unknown as AcpCapabilityCacheEntry;
