import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { AudioLines, Mic } from 'lucide-react';
import type { SessionHistory } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { Spinner } from '@lody/ui/spinner';
import { Tooltip } from '@lody/ui/tooltip';
import { voiceFeatureEnabledAtom } from '@/atoms/settings';
import { useVoiceCall } from '@/hooks/use-voice-call';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  appendVoiceTranscript,
  buildVoiceRelay,
  buildVoiceSessionContext,
  buildVoiceTurnMessage,
  resolveVoiceLatestReply,
  VOICE_CONVERSATION_INSTRUCTIONS,
  voiceMergeWindowMs,
  type VoiceTranscriptLine,
} from '@/lib/voice-conversation';

/**
 * The user's own words are transcribed separately and may land just after the
 * hand-off; a voice turn with none of them waits this much longer, once.
 */
const USER_TRANSCRIPT_GRACE_MS = 1_500;

type SessionVoiceControlsProps = {
  disabled: boolean;
  /** Which buttons to show; the new-chat composer has no session to talk with. */
  modes?: readonly ('dictation' | 'conversation')[];
  isAgentBusy?: boolean;
  /** The session's hydrated tail: the voice starts from it and relays its new replies. */
  turns?: readonly SessionHistory[];
  buttonClassName: string;
  iconClassName: string;
  /** Dictation started; the composer remembers its current draft. */
  onDictationStart: () => void;
  /** Everything said since dictation started. */
  onDictationText: (text: string) => void;
  /** Send a spoken request as an ordinary message of this session. */
  onVoiceRequest?: (text: string) => Promise<boolean>;
};

const NO_TURNS: readonly SessionHistory[] = [];

/**
 * Experimental voice for the session composer: dictation into the draft, and a
 * spoken conversation whose requests run as ordinary messages of this session.
 */
export function SessionVoiceControls(props: SessionVoiceControlsProps) {
  const enabled = useAtomValue(voiceFeatureEnabledAtom);
  if (!enabled) return null;
  return <SessionVoiceControlsInner {...props} />;
}

function SessionVoiceControlsInner({
  disabled,
  modes = ['dictation', 'conversation'],
  isAgentBusy = false,
  turns = NO_TURNS,
  buttonClassName,
  iconClassName,
  onDictationStart,
  onDictationText,
  onVoiceRequest,
}: SessionVoiceControlsProps) {
  const { t } = useTranslation();
  const latestReply = useMemo(() => resolveVoiceLatestReply(turns), [turns]);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const latestReplyRef = useRef(latestReply);
  latestReplyRef.current = latestReply;
  /** The newest reply the voice already knows: present at call start, or relayed since. */
  const relayedKeyRef = useRef<string | null>(null);
  /** Paraphrases of the voice turns sent and not yet answered by a relayed reply. */
  const awaitingRef = useRef<string[]>([]);
  /** Everything said in the call since the last voice turn was sent. */
  const spokenRef = useRef<VoiceTranscriptLine[]>([]);
  const modeRef = useRef<'conversation' | 'dictation' | null>(null);
  const requestBufferRef = useRef<{
    understanding: string[];
    timer: ReturnType<typeof setTimeout>;
    graceUsed: boolean;
  } | null>(null);
  const appendRef = useRef<(text: string) => Promise<void>>(async () => {});

  const sendVoiceTurn = (understanding: string[]) => {
    const spoken = spokenRef.current;
    spokenRef.current = [];
    const message = buildVoiceTurnMessage({ spoken, understanding });
    awaitingRef.current = [...awaitingRef.current, ...understanding];
    if (!onVoiceRequest) return;
    void onVoiceRequest(message).then((accepted) => {
      if (accepted) return;
      awaitingRef.current = awaitingRef.current.filter((text) => !understanding.includes(text));
      void appendRef.current(
        `The request "${understanding.join(' ')}" could not be sent to the background agent. Tell the user.`
      );
    });
  };
  const sendVoiceTurnRef = useRef(sendVoiceTurn);
  sendVoiceTurnRef.current = sendVoiceTurn;

  const flushRequestsRef = useRef<() => void>(() => {});
  flushRequestsRef.current = () => {
    const buffer = requestBufferRef.current;
    if (!buffer) return;
    const heardUser = spokenRef.current.some((line) => line.role === 'user');
    if (!heardUser && !buffer.graceUsed) {
      buffer.graceUsed = true;
      buffer.timer = setTimeout(() => flushRequestsRef.current(), USER_TRANSCRIPT_GRACE_MS);
      return;
    }
    requestBufferRef.current = null;
    sendVoiceTurnRef.current(buffer.understanding);
  };

  const voice = useVoiceCall({
    onUserTranscript: (text) => {
      if (modeRef.current === 'dictation') onDictationText(text);
    },
    onTranscript: (line) => {
      if (modeRef.current !== 'conversation') return;
      spokenRef.current = appendVoiceTranscript(spokenRef.current, line);
      // The user is still talking: keep merging, judged by how these words end.
      // The transcript grace, once started, keeps its own deadline.
      const buffer = requestBufferRef.current;
      if (buffer && !buffer.graceUsed && line.role === 'user') {
        clearTimeout(buffer.timer);
        buffer.timer = setTimeout(
          () => flushRequestsRef.current(),
          voiceMergeWindowMs(spokenRef.current)
        );
      }
    },
    onRequest: (text) => {
      // The voice hands off at a pause, so one sentence said with a breath in it
      // can arrive as two requests; fragments close together become one message,
      // and words that trail off mid-sentence hold the window open longer.
      const buffer = requestBufferRef.current;
      if (buffer) clearTimeout(buffer.timer);
      requestBufferRef.current = {
        understanding: [...(buffer?.understanding ?? []), text],
        timer: setTimeout(() => flushRequestsRef.current(), voiceMergeWindowMs(spokenRef.current)),
        graceUsed: buffer?.graceUsed ?? false,
      };
    },
    onError: (message) => {
      toast.error(t('sessions.voice.error', 'Voice stopped'), { description: message });
    },
  });
  modeRef.current = voice.mode;
  appendRef.current = voice.append;

  // Hanging up right after speaking still sends what was said.
  useEffect(() => {
    if (voice.state !== 'idle') return;
    const buffer = requestBufferRef.current;
    if (!buffer) return;
    clearTimeout(buffer.timer);
    requestBufferRef.current = null;
    sendVoiceTurnRef.current(buffer.understanding);
  }, [voice.state]);

  // Every reply that finishes during the call goes back to the voice, answered
  // requests first; one already present at call start is in its context.
  const { append } = voice;
  const callLive = voice.mode === 'conversation' && voice.state === 'active';
  useEffect(() => {
    if (!callLive || isAgentBusy || !latestReply) return;
    if (latestReply.key === relayedKeyRef.current) return;
    relayedKeyRef.current = latestReply.key;
    // A typed turn that finishes first leaves the spoken requests waiting for their own reply.
    const requests = latestReply.answersVoiceTurn ? awaitingRef.current : [];
    if (latestReply.answersVoiceTurn) awaitingRef.current = [];
    void append(buildVoiceRelay(latestReply, requests));
  }, [append, callLive, isAgentBusy, latestReply]);

  const toggle = useCallback(
    (mode: 'conversation' | 'dictation') => {
      if (voice.state !== 'idle') {
        void voice.stop();
        return;
      }
      if (!voice.available) {
        toast.error(t('sessions.voice.noAgent', 'Choose a Codex agent for voice in Settings'));
        return;
      }
      if (mode === 'dictation') {
        onDictationStart();
        void voice.start(mode);
        return;
      }
      relayedKeyRef.current = latestReplyRef.current?.key ?? null;
      awaitingRef.current = [];
      spokenRef.current = [];
      void voice.start(mode, {
        instructions: VOICE_CONVERSATION_INSTRUCTIONS,
        context: buildVoiceSessionContext(turnsRef.current) ?? undefined,
      });
    },
    [onDictationStart, t, voice]
  );

  const renderButton = (mode: 'conversation' | 'dictation') => {
    const active = voice.mode === mode;
    const busy = active && voice.state === 'connecting';
    const label = active
      ? mode === 'dictation'
        ? t('sessions.voice.stopDictation', 'Stop dictation')
        : t('sessions.voice.stopConversation', 'End voice conversation')
      : mode === 'dictation'
        ? t('sessions.voice.dictate', 'Dictate')
        : t('sessions.voice.converse', 'Talk with this session');
    const Icon = mode === 'dictation' ? Mic : AudioLines;
    return (
      <Tooltip.Root>
        <Tooltip.Trigger
          render={
            <Button
              type="button"
              icon
              variant="ghost"
              aria-label={label}
              aria-pressed={active}
              disabled={(disabled && !active) || (voice.mode !== null && !active)}
              onClick={() => toggle(mode)}
              className={cn(
                buttonClassName,
                'rounded-full',
                active &&
                  'bg-foreground text-background hover:bg-foreground/90 hover:text-background'
              )}
            >
              {busy ? (
                <Spinner className={iconClassName} />
              ) : (
                <Icon className={cn(iconClassName, active && 'animate-pulse')} aria-hidden="true" />
              )}
            </Button>
          }
        />
        <Tooltip.Content side="top">{label}</Tooltip.Content>
      </Tooltip.Root>
    );
  };

  return (
    <>
      {modes.includes('dictation') ? renderButton('dictation') : null}
      {modes.includes('conversation') && onVoiceRequest ? renderButton('conversation') : null}
    </>
  );
}
