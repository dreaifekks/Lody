import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useAtomValue } from 'jotai';
import type { AgentConfigId, MachineId } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { isVoiceCallActive, subscribeVoiceActivity } from '@/lib/voice-activity';
import {
  playVoicePreview,
  VoicePreviewError,
  type VoicePreview,
  type VoicePreviewFailure,
} from '@/lib/voice-preview';

export type VoiceList = { voices: string[]; defaultVoice: string };

export type VoiceListState =
  | { status: 'loading' }
  | { status: 'ready'; list: VoiceList }
  | { status: 'error'; error: string };

/**
 * One request per agent for the page's lifetime: the list is built into the
 * agent's Codex. A failure is forgotten so the next look asks again.
 */
const voiceLists = new Map<string, Promise<VoiceList>>();

/** The voices the agent's Codex offers for calls, from the agent's machine. */
export function useVoiceList(
  agent: { machineId: MachineId; configId: AgentConfigId } | null
): VoiceListState | null {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const machineId = agent?.machineId;
  const configId = agent?.configId;
  const key = machineId && configId ? `${machineId}:${configId}` : null;
  const [state, setState] = useState<{ key: string; value: VoiceListState } | null>(null);

  useEffect(() => {
    if (!machineId || !configId || !key || !runtime) return () => {};
    let current = true;
    let pending = voiceLists.get(key);
    if (!pending) {
      pending = runtime
        .requestMachineVoice(machineId, { action: 'voices', configId })
        .then((response) => {
          if (!response.success) throw new Error(response.error);
          if (response.action !== 'voices') throw new Error('The machine returned no voices');
          return { voices: response.voices, defaultVoice: response.defaultVoice };
        });
      voiceLists.set(key, pending);
      const stored = pending;
      stored.catch(() => {
        if (voiceLists.get(key) === stored) voiceLists.delete(key);
      });
    }
    setState({ key, value: { status: 'loading' } });
    pending.then(
      (list) => {
        if (current) setState({ key, value: { status: 'ready', list } });
      },
      (error: unknown) => {
        if (current) {
          setState({
            key,
            value: {
              status: 'error',
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }
    );
    return () => {
      current = false;
    };
  }, [configId, key, machineId, runtime]);

  if (!key) return null;
  return state?.key === key ? state.value : { status: 'loading' };
}

export type VoicePreviewState =
  | { status: 'idle' }
  | { status: 'connecting' | 'playing'; voice: string };

/**
 * Plays one voice at a time on the given agent. Starting another voice, a
 * voice call starting, or the caller unmounting ends the current preview.
 */
export function useVoicePreview(options: {
  agent: { machineId: MachineId; configId: AgentConfigId } | null;
  sentence: string;
  onError: (failure: VoicePreviewFailure, message: string) => void;
}) {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const [state, setState] = useState<VoicePreviewState>({ status: 'idle' });
  const previewRef = useRef<VoicePreview | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const callActive = useSyncExternalStore(
    subscribeVoiceActivity,
    isVoiceCallActive,
    isVoiceCallActive
  );

  const stop = useCallback(() => {
    previewRef.current?.stop();
  }, []);

  const play = useCallback(
    (voice: string) => {
      const { agent, sentence } = optionsRef.current;
      if (!agent || !runtime) return;
      previewRef.current?.stop();
      const preview = playVoicePreview({
        machineId: agent.machineId,
        configId: agent.configId,
        voice,
        sentence,
        request: (machineId, body) => runtime.requestMachineVoice(machineId, body),
        onPlaying: () => {
          if (previewRef.current === preview) setState({ status: 'playing', voice });
        },
      });
      previewRef.current = preview;
      setState({ status: 'connecting', voice });
      preview.finished.then(
        () => {
          if (previewRef.current !== preview) return;
          previewRef.current = null;
          setState({ status: 'idle' });
        },
        (error: unknown) => {
          if (previewRef.current === preview) {
            previewRef.current = null;
            setState({ status: 'idle' });
          }
          const failure = error instanceof VoicePreviewError ? error.failure : 'machine';
          const message = error instanceof Error ? error.message : String(error);
          optionsRef.current.onError(failure, message);
        }
      );
    },
    [runtime]
  );

  useEffect(() => () => previewRef.current?.stop(), []);

  return { state, play, stop, callActive };
}
