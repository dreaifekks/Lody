import { useAtomValue } from 'jotai';
import type { AgentConfigId, MachineId } from '@lody/shared';
import { voiceAgentScopeAtom, voiceAgentSelectionAtom } from '@/atoms/settings';
import { useWorkspaceCatalog } from '@/hooks/use-workspace-catalog';

export type VoiceAgentSelection = { configId: AgentConfigId; machineId: MachineId };

export function parseVoiceAgentSelection(value: string | null): VoiceAgentSelection | null {
  if (!value) return null;
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) return null;
  return {
    configId: value.slice(0, separator) as AgentConfigId,
    machineId: value.slice(separator + 1) as MachineId,
  };
}

/** The Codex agent that hosts voice on this device: the workspace's, or this device's own. */
export function useVoiceAgentSelection(): VoiceAgentSelection | null {
  const scope = useAtomValue(voiceAgentScopeAtom);
  const deviceSelection = useAtomValue(voiceAgentSelectionAtom);
  const { voice } = useWorkspaceCatalog();
  if (scope === 'device') return parseVoiceAgentSelection(deviceSelection);
  return voice ? { configId: voice.configId, machineId: voice.machineId } : null;
}
