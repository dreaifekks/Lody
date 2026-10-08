import {
  lowerPermissionTier,
  resolvePermissionTier,
  type AcpConfigOptionValue,
  type AgentConfigId,
  type MachineId,
  type PermissionTierRunConfig,
  type ResolvedPermissionTier,
  type SessionId,
  type SessionTurnInputConfig,
  type WorkspaceId,
} from '@lody/shared';
import { readMergedAgentConfigById } from './agent-config-machine-flock';
import type { LoroDocumentManager } from './loro/doc';

/**
 * The tier a run configuration runs at on one Agent config once dispatched:
 * Lody's builtin default mode is applied exactly as dispatch applies it, and
 * the config's capability says which options are permission controls. A
 * config missing from that machine, or without a capability, is `unknown`,
 * which only a person may write.
 */
export async function readAgentRunConfigTier(args: {
  manager: LoroDocumentManager;
  workspaceId: WorkspaceId;
  machineId: MachineId;
  agentConfigId: AgentConfigId;
  runConfig: PermissionTierRunConfig;
  localOnly: boolean;
}): Promise<ResolvedPermissionTier> {
  const { config } = await readMergedAgentConfigById(
    args.manager.repo,
    args.workspaceId,
    args.machineId,
    args.agentConfigId
  );
  if (!config || config.machineId !== args.machineId) return 'unknown';
  const { readAgentAcpCapability, withBuiltinDefaultTurnMode } = await import('@/commands/session');
  const capability = await readAgentAcpCapability({
    manager: args.manager,
    workspaceId: args.workspaceId,
    machineId: args.machineId,
    agentConfigId: args.agentConfigId,
    localOnly: args.localOnly,
  });
  return resolvePermissionTier({
    runConfig: withBuiltinDefaultTurnMode(
      {
        ...(args.runConfig.modeId ? { modeId: args.runConfig.modeId } : {}),
        ...(args.runConfig.configOptionValues
          ? { configOptionValues: args.runConfig.configOptionValues }
          : {}),
      },
      config,
      capability
    ),
    agent: config,
    capability: capability ? { configOptions: capability.configOptions ?? [] } : undefined,
  });
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
 * The tier the invoking Session runs at now. The live Agent's own report of
 * its mode and permission options is authoritative. Without one (no live
 * Agent here, or an Agent that reports no such option) the lower of the
 * driving Turn's dispatch config and the persisted report for that Turn is
 * used, since that report may have stopped following the Agent.
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
  const tierOf = (runConfig: PermissionTierRunConfig) =>
    readAgentRunConfigTier({
      manager,
      workspaceId,
      machineId: session.machineId as MachineId,
      agentConfigId: session.agentConfigId as AgentConfigId,
      runConfig,
      localOnly: false,
    });
  const live = (args.runtimeConfigOptions ?? []).flatMap((option) =>
    (option.category === 'mode' || option.category === '_permission') &&
    (typeof option.currentValue === 'string' || typeof option.currentValue === 'boolean')
      ? [[option.id, option.currentValue] as const]
      : []
  );
  if (live.length > 0) return tierOf({ configOptionValues: Object.fromEntries(live) });
  const dispatched: PermissionTierRunConfig = {
    ...(turn.inputConfig.modeId ? { modeId: turn.inputConfig.modeId } : {}),
    ...(turn.inputConfig.configOptionValues
      ? { configOptionValues: turn.inputConfig.configOptionValues }
      : {}),
  };
  const dispatchedTier = await tierOf(dispatched);
  const reported = await readTurnRuntimeReport(manager, session.id as SessionId, turn.id);
  if (!reported) return dispatchedTier;
  return lowerPermissionTier(
    dispatchedTier,
    await tierOf({
      modeId: reported.modeId ?? dispatched.modeId,
      configOptionValues: {
        ...(dispatched.configOptionValues ?? {}),
        ...(reported.configOptionValues ?? {}),
      },
    })
  );
}
