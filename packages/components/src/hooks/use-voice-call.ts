import { useCallback, useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import type {
  MachineId,
  MachineVoiceMode,
  MachineVoiceRequest,
  MachineVoiceResponse,
} from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useVoiceAgentSelection } from '@/hooks/use-voice-agent-selection';
import { beginVoiceCall } from '@/lib/voice-activity';
import { waitForIceGathering } from '@/lib/voice-preview';

/** How long the machine holds one poll open while nothing happens. */
const POLL_WAIT_MS = 12_000;

export type VoiceCallState = 'idle' | 'connecting' | 'active';

/** A call the user speaks in; previews belong to `lib/voice-preview.ts`. */
export type VoiceCallMode = Exclude<MachineVoiceMode, 'preview'>;

export type VoiceCallHandlers = {
  /** Words the user has said so far in this call, as they arrive. */
  onUserTranscript?: (text: string) => void;
  /** A finished utterance of either side, transcribed by the voice (conversation only). */
  onTranscript?: (line: { role: 'user' | 'assistant'; text: string }) => void;
  /** A spoken request the voice handed off (conversation only). */
  onRequest?: (text: string) => void;
  onError?: (message: string) => void;
};

type ActiveCall = {
  machineId: MachineId;
  voiceSessionId: string | null;
  peer: RTCPeerConnection;
  microphone: MediaStream;
  audio: HTMLAudioElement | null;
  stopped: boolean;
};

/**
 * One realtime voice call hosted by the Codex agent chosen in Settings. The
 * microphone and the WebRTC peer live here; the machine only negotiates the
 * call and reports spoken requests, which this hook polls for. Dictation reads
 * the user's words straight from the call's event channel.
 */
export function useVoiceCall(handlers: VoiceCallHandlers) {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const selection = useVoiceAgentSelection();
  const [state, setState] = useState<VoiceCallState>('idle');
  const [mode, setMode] = useState<VoiceCallMode | null>(null);
  const callRef = useRef<ActiveCall | null>(null);
  /**
   * Identifies the newest start. `getUserMedia` cannot be aborted, so a stop
   * or unmount while permission is pending invalidates the token instead, and
   * the late start then releases the microphone without touching the state.
   */
  const startTokenRef = useRef(0);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  /** Holds the speakers from start until the call is idle again; a preview yields. */
  const releaseActivityRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (state !== 'idle') return;
    releaseActivityRef.current?.();
    releaseActivityRef.current = null;
  }, [state]);
  useEffect(
    () => () => {
      releaseActivityRef.current?.();
      releaseActivityRef.current = null;
    },
    []
  );

  const request = useCallback(
    async (machineId: MachineId, body: MachineVoiceRequest): Promise<MachineVoiceResponse> => {
      if (!runtime) return { success: false, error: 'Workspace runtime is not ready.' };
      return await runtime.requestMachineVoice(machineId, body);
    },
    [runtime]
  );

  const teardown = useCallback((call: ActiveCall) => {
    if (call.stopped) return;
    call.stopped = true;
    call.microphone.getTracks().forEach((track) => track.stop());
    call.peer.close();
    if (call.audio) {
      call.audio.pause();
      call.audio.srcObject = null;
    }
    if (callRef.current === call) {
      callRef.current = null;
      setState('idle');
      setMode(null);
    }
  }, []);

  const stop = useCallback(async () => {
    // Also cancels a start still waiting for microphone permission, which has no call yet.
    startTokenRef.current += 1;
    const call = callRef.current;
    if (!call) {
      setState('idle');
      setMode(null);
      return;
    }
    teardown(call);
    if (call.voiceSessionId) {
      await request(call.machineId, { action: 'stop', voiceSessionId: call.voiceSessionId });
    }
  }, [request, teardown]);

  const fail = useCallback(
    (call: ActiveCall, message: string) => {
      if (call.stopped) return;
      teardown(call);
      if (call.voiceSessionId) {
        void request(call.machineId, { action: 'stop', voiceSessionId: call.voiceSessionId });
      }
      handlersRef.current.onError?.(message);
    },
    [request, teardown]
  );

  const pollEvents = useCallback(
    async (call: ActiveCall, voiceSessionId: string) => {
      let after = 0;
      while (!call.stopped) {
        const response = await request(call.machineId, {
          action: 'poll',
          voiceSessionId,
          after,
          waitMs: POLL_WAIT_MS,
        });
        if (call.stopped) return;
        if (!response.success) {
          fail(call, response.error);
          return;
        }
        if (response.action !== 'poll') return;
        for (const { seq, event } of response.events) {
          after = seq;
          if (event.type === 'transcript') {
            handlersRef.current.onTranscript?.({ role: event.role, text: event.text });
          }
          if (event.type === 'request') handlersRef.current.onRequest?.(event.text);
          if (event.type === 'error') handlersRef.current.onError?.(event.message);
        }
        if (response.closed) {
          teardown(call);
          return;
        }
      }
    },
    [fail, request, teardown]
  );

  const start = useCallback(
    async (
      nextMode: VoiceCallMode,
      options: {
        /** Standing instructions for the voice. */
        instructions?: string | undefined;
        /** What the voice should know before the user speaks, e.g. the session so far. */
        context?: string | undefined;
      } = {}
    ) => {
      const { instructions, context } = options;
      if (callRef.current) return;
      if (!selection) {
        handlersRef.current.onError?.('Choose a Codex agent for voice in Settings first.');
        return;
      }
      const token = ++startTokenRef.current;
      releaseActivityRef.current?.();
      releaseActivityRef.current = beginVoiceCall();
      setState('connecting');
      setMode(nextMode);
      let microphone: MediaStream;
      try {
        microphone = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (error) {
        if (token !== startTokenRef.current) return;
        setState('idle');
        setMode(null);
        handlersRef.current.onError?.(error instanceof Error ? error.message : String(error));
        return;
      }
      if (token !== startTokenRef.current) {
        microphone.getTracks().forEach((track) => track.stop());
        return;
      }
      const peer = new RTCPeerConnection();
      const call: ActiveCall = {
        machineId: selection.machineId,
        voiceSessionId: null,
        peer,
        microphone,
        audio: null,
        stopped: false,
      };
      callRef.current = call;
      try {
        microphone.getAudioTracks().forEach((track) => peer.addTrack(track, microphone));
        peer.ontrack = (event) => {
          // Dictation keeps the voice silent; never play whatever it might say.
          if (nextMode !== 'conversation' || call.stopped) return;
          const audio = new Audio();
          audio.autoplay = true;
          audio.srcObject = new MediaStream([event.track]);
          void audio.play().catch(() => {});
          call.audio = audio;
        };
        let transcript = '';
        const channel = peer.createDataChannel('oai-events');
        channel.onmessage = (message) => {
          let event: { type?: unknown; item?: { text?: unknown } };
          try {
            event = JSON.parse(String(message.data)) as typeof event;
          } catch {
            return;
          }
          if (event.type === 'input_transcript.added' && typeof event.item?.text === 'string') {
            transcript += event.item.text;
            handlersRef.current.onUserTranscript?.(transcript);
          }
        };
        peer.onconnectionstatechange = () => {
          if (peer.connectionState === 'failed') fail(call, 'The voice connection dropped.');
        };

        await peer.setLocalDescription(await peer.createOffer());
        await waitForIceGathering(peer);
        const offer = peer.localDescription?.sdp;
        if (!offer) throw new Error('Could not prepare the voice connection.');
        if (call.stopped) return;

        const response = await request(call.machineId, {
          action: 'start',
          configId: selection.configId,
          mode: nextMode,
          sdp: offer,
          ...(instructions ? { instructions } : {}),
          ...(context ? { context } : {}),
          // Dictation is never heard, so only a conversation asks for the chosen voice.
          ...(nextMode === 'conversation' && selection.voice ? { voice: selection.voice } : {}),
        });
        if (!response.success) throw new Error(response.error);
        if (response.action !== 'start') throw new Error('The machine answered no voice call.');
        call.voiceSessionId = response.voiceSessionId;
        if (call.stopped) {
          void request(call.machineId, { action: 'stop', voiceSessionId: response.voiceSessionId });
          return;
        }
        await peer.setRemoteDescription({ type: 'answer', sdp: response.sdp });
        setState('active');
        void pollEvents(call, response.voiceSessionId);
      } catch (error) {
        fail(call, error instanceof Error ? error.message : String(error));
      }
    },
    [fail, pollEvents, request, selection]
  );

  const append = useCallback(
    async (text: string) => {
      const call = callRef.current;
      if (!call?.voiceSessionId || call.stopped) return;
      const response = await request(call.machineId, {
        action: 'append',
        voiceSessionId: call.voiceSessionId,
        text,
      });
      if (!response.success) handlersRef.current.onError?.(response.error);
    },
    [request]
  );

  // A call never outlives the composer that started it.
  useEffect(
    () => () => {
      void stop();
    },
    [stop]
  );

  return { state, mode, available: selection !== null, start, stop, append };
}
