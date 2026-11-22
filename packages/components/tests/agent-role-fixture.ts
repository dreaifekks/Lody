import {
  normalizeAgentRole,
  getAgentRoleTargets,
  type AcpCapabilityCacheEntry,
  type AgentConfigMeta,
  type AgentRole,
  type AgentRoleAvailability,
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
  row: AgentRole & { instances?: import('@lody/shared').AgentRoleTarget[] }
): AgentRole => normalizeAgentRole(row)!;

/**
 * A Role's composer entries, built as the composer builds them on the Role's
 * first machine; its agents are taken as Codex unless `agentConfigs` says.
 */
export const composerItemsOf = (
  role: AgentRole,
  options: {
    availability?: AgentRoleAvailability;
    machineId?: MachineId;
    agentConfigs?: AgentConfigMeta[];
  } = {}
): ComposerAgentRoleItem[] =>
  buildComposerAgentRoleItems({
    roles: [role],
    machineId: options.machineId ?? getAgentRoleTargets(role)[0]!.machineId,
    agentConfigs:
      options.agentConfigs ??
      getAgentRoleTargets(role).map(
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

/**
 * A registry Antigravity (`antigravity-acp`) capability row in the shape a
 * machine reports: mode and model live in `configOptions`, with YOLO injected
 * into both `modes` and the `mode` config option.
 */
export const reportedAntigravityCapabilities = {
  cacheVersion: 11,
  cliType: 'registry',
  agentType: 'antigravity-acp',
  provenance: 'runtime',
  fetchedAt: 1,
  modes: [
    { id: 'default', name: 'Default' },
    { id: 'accept-edits', name: 'Accept edits' },
    { id: 'auto', name: 'Auto' },
    { id: 'plan', name: 'Plan' },
    { id: 'yolo', name: 'YOLO' },
  ],
  models: [
    { modelId: 'gemini-4-neon', name: 'Gemini 4 Neon' },
    { modelId: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
    { modelId: 'gemini-4-argon', name: 'Gemini 4 Argon' },
  ],
  configOptions: [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'gemini-4-argon',
      options: [
        { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
        { value: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
        { value: 'gemini-4-argon', name: 'Gemini 4 Argon' },
      ],
    },
    {
      id: 'thought_level',
      name: 'Thinking Level',
      category: 'thought_level',
      type: 'select',
      currentValue: 'high',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
        { value: 'xhigh', name: 'Extra' },
      ],
    },
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'accept-edits', name: 'Accept edits' },
        { value: 'auto', name: 'Auto' },
        { value: 'plan', name: 'Plan' },
        { value: 'yolo', name: 'YOLO' },
      ],
    },
  ],
} as unknown as AcpCapabilityCacheEntry;
