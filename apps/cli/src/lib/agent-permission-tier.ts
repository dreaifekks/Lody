import {
  permissionOptionIdsOf,
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
 * The tier a run configuration runs at on one Agent config. The config's
 * capability names its permission options; a config missing from that
 * machine is `unknown`, which only a person may write.
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
  const { readAgentAcpCapability } = await import('@/commands/session');
  const capability = await readAgentAcpCapability({
    manager: args.manager,
    workspaceId: args.workspaceId,
    machineId: args.machineId,
    agentConfigId: args.agentConfigId,
    localOnly: args.localOnly,
  });
  return resolvePermissionTier({
    runConfig: args.runConfig,
    agent: config,
    permissionOptionIds: capability
      ? permissionOptionIdsOf(capability.configOptions ?? [])
      : undefined,
  });
}

export type InvokingRunConfig = {
  modeId?: string;
  modelId?: string;
  configOptionValues?: Record<string, AcpConfigOptionValue>;
};

/**
 * What the Session driving an Agent tool call runs with right now: the
 * driving Turn's dispatch config, overlaid by what the Agent runtime reported
 * for that same Turn (a mode left or entered mid-Turn, such as leaving Plan).
 * A report for another Turn says nothing about this one.
 */
export async function readInvokingRunConfig(
  manager: LoroDocumentManager,
  sessionId: SessionId,
  turn: { id: string; inputConfig: SessionTurnInputConfig }
): Promise<InvokingRunConfig> {
  const state = await (await manager.getOrCreateSessionDoc(sessionId)).getDocState();
  const reported =
    state?.acpRuntimeConfig?.basedOnUserTurnId === turn.id ? state.acpRuntimeConfig : undefined;
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
