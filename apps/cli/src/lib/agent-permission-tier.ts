import {
  lowerPermissionTier,
  resolvePermissionTier,
  type AcpConfigOptionValue,
  type AcpCapabilityCacheEntry,
  type AgentConfigId,
  type AgentConfigMeta,
  type MachineId,
  type PermissionTierRunConfig,
  type ResolvedPermissionTier,
  type SessionId,
  type SessionTurnInputConfig,
  type WorkspaceId,
} from '@lody/shared';
import { readMergedAgentConfigById } from './agent-config-machine-flock';
import type { LoroDocumentManager } from './loro/doc';

type AgentTierTarget = {
  manager: LoroDocumentManager;
  workspaceId: WorkspaceId;
  machineId: MachineId;
  agentConfigId: AgentConfigId;
  runConfig: PermissionTierRunConfig;
  localOnly: boolean;
};

/**
 * Ranks a run configuration on one Agent config, its capability saying which
 * options are permission controls. A config missing from that machine, or
 * without a capability, is `unknown`, which only a person may write.
 * `toDispatched` turns the configuration into what would actually run.
 */
async function rankOnAgent(
  args: AgentTierTarget,
  toDispatched?: (
    runConfig: PermissionTierRunConfig,
    config: AgentConfigMeta,
    capability: AcpCapabilityCacheEntry | undefined
  ) => PermissionTierRunConfig
): Promise<ResolvedPermissionTier> {
  const { config } = await readMergedAgentConfigById(
    args.manager.repo,
    args.workspaceId,
    args.machineId,
    args.agentConfigId
  );
  if (!config || config.machineId !== args.machineId) return 'unknown';
  const { readAgentAcpCapability } = await import('@/commands/session');
  const capability = await readAgentAcpCapability({
    manager: args.manager,
    workspaceId: args.workspaceId,
    machineId: args.machineId,
    agentConfigId: args.agentConfigId,
    localOnly: args.localOnly,
  });
  return resolvePermissionTier({
    runConfig: toDispatched ? toDispatched(args.runConfig, config, capability) : args.runConfig,
    agent: config,
    capability: capability ? { configOptions: capability.configOptions ?? [] } : undefined,
  });
}

/**
 * The tier a configuration still to be dispatched runs at (a Role, a Schedule,
 * a Turn's dispatch config): Lody's builtin default mode is applied exactly as
 * dispatch applies it.
 */
export async function readAgentRunConfigTier(
  args: AgentTierTarget
): Promise<ResolvedPermissionTier> {
  const { withBuiltinDefaultTurnMode } = await import('@/commands/session');
  return rankOnAgent(args, (runConfig, config, capability) =>
    withBuiltinDefaultTurnMode(
      {
        ...(runConfig.modeId ? { modeId: runConfig.modeId } : {}),
        ...(runConfig.configOptionValues
          ? { configOptionValues: runConfig.configOptionValues }
          : {}),
      },
      config,
      capability
    )
  );
}

/** The tier of a state an Agent reported as current: ranked as it is, nothing filled in. */
export function readAgentStateTier(args: AgentTierTarget): Promise<ResolvedPermissionTier> {
  return rankOnAgent(args);
}

export type InvokingRunConfig = {
  modeId?: string;
  modelId?: string;
  configOptionValues?: Record<string, AcpConfigOptionValue>;
};

/** What the live Agent of a Session reports as its current option values. */
export type RuntimeConfigOption = {
  id: string;
  category?: string | null;
  currentValue: unknown;
};

/**
 * The persisted runtime report for one Turn. It is only a composer baseline:
 * the document stops taking reports for a Turn once a newer user Turn exists.
 */
const readTurnRuntimeReport = async (
  manager: LoroDocumentManager,
  sessionId: SessionId,
  turnId: string
) => {
  const state = await (await manager.getOrCreateSessionDoc(sessionId)).getDocState();
  return state?.acpRuntimeConfig?.basedOnUserTurnId === turnId ? state.acpRuntimeConfig : undefined;
};

/**
 * The run config the Session driving an Agent tool call works with, used as
 * the default for what it writes: the driving Turn's dispatch config overlaid
 * by what the runtime reported for that same Turn.
 */
export async function readInvokingRunConfig(
  manager: LoroDocumentManager,
  sessionId: SessionId,
  turn: { id: string; inputConfig: SessionTurnInputConfig }
): Promise<InvokingRunConfig> {
  const reported = await readTurnRuntimeReport(manager, sessionId, turn.id);
  const modeId = reported?.modeId ?? turn.inputConfig.modeId;
  const modelId = reported?.modelId ?? turn.inputConfig.modelId;
  const configOptionValues = {
    ...(turn.inputConfig.configOptionValues ?? {}),
    ...(reported?.configOptionValues ?? {}),
  };
  return {
    ...(modeId ? { modeId } : {}),
    ...(modelId ? { modelId } : {}),
    ...(Object.keys(configOptionValues).length > 0 ? { configOptionValues } : {}),
  };
}

/**
 * The tier the invoking Session runs at now: the lowest of every source there
 * is. The live Agent's options can lag a mode switch made through the legacy
 * mode call, and the persisted report stops following a Turn once a newer one
 * is queued, so no single one is trusted to raise the ceiling. Reported states
 * are ranked as they are; the dispatch config as dispatch completed it.
 */
export async function readInvokingPermissionTier(args: {
  manager: LoroDocumentManager;
  workspaceId: WorkspaceId;
  session: { id: string; machineId: string; agentConfigId?: string };
  turn: { id: string; inputConfig: SessionTurnInputConfig };
  runtimeConfigOptions: readonly RuntimeConfigOption[] | undefined;
}): Promise<ResolvedPermissionTier> {
  const { manager, workspaceId, session, turn } = args;
  if (!session.agentConfigId) return 'unknown';
  const target = (runConfig: PermissionTierRunConfig): AgentTierTarget => ({
    manager,
    workspaceId,
    machineId: session.machineId as MachineId,
    agentConfigId: session.agentConfigId as AgentConfigId,
    runConfig,
    localOnly: false,
  });
  let tier = await readAgentRunConfigTier(
    target({
      ...(turn.inputConfig.modeId ? { modeId: turn.inputConfig.modeId } : {}),
      ...(turn.inputConfig.configOptionValues
        ? { configOptionValues: turn.inputConfig.configOptionValues }
        : {}),
    })
  );
  const live = (args.runtimeConfigOptions ?? []).flatMap((option) =>
    (option.category === 'mode' || option.category === '_permission') &&
    (typeof option.currentValue === 'string' || typeof option.currentValue === 'boolean')
      ? [[option.id, option.currentValue] as const]
      : []
  );
  if (live.length > 0)
    tier = lowerPermissionTier(
      tier,
      await readAgentStateTier(target({ configOptionValues: Object.fromEntries(live) }))
    );
  const reported = await readTurnRuntimeReport(manager, session.id as SessionId, turn.id);
  if (reported)
    tier = lowerPermissionTier(
      tier,
      await readAgentStateTier(
        target({
          ...(reported.modeId ? { modeId: reported.modeId } : {}),
          configOptionValues: { ...(reported.configOptionValues ?? {}) },
        })
      )
    );
  return tier;
}
