import { useAtomValue } from 'jotai';
import type { AgentConfigId, MachineId } from '@lody/shared';
import { voiceAgentScopeAtom, voiceAgentSelectionAtom, voiceNameAtom } from '@/atoms/settings';
import { useWorkspaceCatalog } from '@/hooks/use-workspace-catalog';

export type VoiceAgentSelection = { configId: AgentConfigId; machineId: MachineId };

/** The agent plus the voice its calls use; `voice` null follows Codex's default. */
export type VoiceCallSelection = VoiceAgentSelection & { voice: string | null };

export function parseVoiceAgentSelection(value: string | null): VoiceAgentSelection | null {
  if (!value) return null;
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) return null;
  return {
    configId: value.slice(0, separator) as AgentConfigId,
    machineId: value.slice(separator + 1) as MachineId,
  };
}

/**
 * The Codex agent that hosts voice on this device and the voice it speaks in:
 * both the workspace's, or both this device's own.
 */
export function useVoiceAgentSelection(): VoiceCallSelection | null {
  const scope = useAtomValue(voiceAgentScopeAtom);
  const deviceSelection = useAtomValue(voiceAgentSelectionAtom);
  const deviceVoice = useAtomValue(voiceNameAtom);
  const { voice: shared } = useWorkspaceCatalog();
  if (scope === 'device') {
    const parsed = parseVoiceAgentSelection(deviceSelection);
    return parsed ? { ...parsed, voice: deviceVoice } : null;
  }
  return shared
    ? { configId: shared.configId, machineId: shared.machineId, voice: shared.voice ?? null }
    : null;
}
