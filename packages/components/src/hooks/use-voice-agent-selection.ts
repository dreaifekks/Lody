import { useAtomValue } from 'jotai';
import type { AgentConfigId, MachineId } from '@lody/shared';
import { voiceAgentScopeAtom, voiceAgentSelectionAtom, voiceNameAtom } from '@/atoms/settings';
import { useWorkspaceCatalog } from '@/hooks/use-workspace-catalog';

/**
 * Who hosts voice: a Codex agent config, or Gemini Live with the machine that
 * signs its tokens. A choice stored before Gemini existed is a Codex one.
 */
export type VoiceAgentSelection =
  | { provider: 'codex'; configId: AgentConfigId; machineId: MachineId }
  | { provider: 'gemini'; machineId: MachineId };

/** The host plus the voice its calls use; `voice` null follows the provider's default. */
export type VoiceCallSelection = VoiceAgentSelection & { voice: string | null };

const GEMINI_PREFIX = 'gemini:';

/** This device's stored choice: `${configId}:${machineId}`, or `gemini:${machineId}`. */
export function formatVoiceAgentSelection(selection: VoiceAgentSelection): string {
  return selection.provider === 'gemini'
    ? `${GEMINI_PREFIX}${selection.machineId}`
    : `${selection.configId}:${selection.machineId}`;
}

export function parseVoiceAgentSelection(value: string | null): VoiceAgentSelection | null {
  if (!value) return null;
  if (value.startsWith(GEMINI_PREFIX)) {
    const machineId = value.slice(GEMINI_PREFIX.length);
    return machineId ? { provider: 'gemini', machineId: machineId as MachineId } : null;
  }
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) return null;
  return {
    provider: 'codex',
    configId: value.slice(0, separator) as AgentConfigId,
    machineId: value.slice(separator + 1) as MachineId,
  };
}

/**
 * The voice host of this device and the voice it speaks in: both the
 * workspace's, or both this device's own.
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
  if (!shared) return null;
  const voice = shared.voice ?? null;
  return shared.provider === 'gemini'
    ? { provider: 'gemini', machineId: shared.machineId, voice }
    : { provider: 'codex', configId: shared.configId, machineId: shared.machineId, voice };
}
