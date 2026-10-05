import { useCallback, useEffect, useRef } from 'react';
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

/** The most recent finished assistant reply, keyed so a newer one is recognizable. */
export type VoiceLatestReply = { key: string; text: string };

/**
 * The voice hands off at a pause, so one sentence said with a breath in it can
 * arrive as two requests. Fragments this close together become one message.
 */
const REQUEST_MERGE_WINDOW_MS = 2_000;

/** Longest reply handed to the voice; it summarizes rather than reads it out. */
const MAX_REPLY_CHARS = 6_000;

const CONVERSATION_INSTRUCTIONS =
  'Reply in the language the user speaks. You are the voice of a coding session: hand every request that needs work to the background agent, then tell the user its outcome briefly. Never read code, paths or long lists aloud; summarize them.';

/** The text of the last finished assistant turn in the hydrated tail, if any. */
export function resolveVoiceLatestReply(turns: readonly SessionHistory[]): VoiceLatestReply | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (!turn || turn.role !== 'assistant' || turn.finished !== true) continue;
    const texts: string[] = [];
    const items = (turn.items ?? []) as ReadonlyArray<{ type?: unknown; text?: unknown }>;
    // The final message is the text after the last tool call or other step.
    for (let j = items.length - 1; j >= 0; j -= 1) {
      const item = items[j];
      if (item?.type === 'text' && typeof item.text === 'string') texts.unshift(item.text);
      else if (item?.type !== 'thought') break;
    }
    const text = texts.join('').trim();
    return { key: turn.id, text };
  }
  return null;
}

type SessionVoiceControlsProps = {
  disabled: boolean;
  /** Which buttons to show; the new-chat composer has no session to talk with. */
  modes?: readonly ('dictation' | 'conversation')[];
  isAgentBusy?: boolean;
  latestReply?: VoiceLatestReply | null;
  buttonClassName: string;
  iconClassName: string;
  /** Dictation started; the composer remembers its current draft. */
  onDictationStart: () => void;
  /** Everything said since dictation started. */
  onDictationText: (text: string) => void;
  /** Send a spoken request as an ordinary message of this session. */
  onVoiceRequest?: (text: string) => Promise<boolean>;
};

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
  latestReply = null,
  buttonClassName,
  iconClassName,
  onDictationStart,
  onDictationText,
  onVoiceRequest,
}: SessionVoiceControlsProps) {
  const { t } = useTranslation();
  const latestReplyRef = useRef(latestReply);
  latestReplyRef.current = latestReply;
  const pendingRef = useRef<{ baselineKey: string | null; request: string } | null>(null);
  const modeRef = useRef<'conversation' | 'dictation' | null>(null);
  const requestBufferRef = useRef<{ texts: string[]; timer: ReturnType<typeof setTimeout> } | null>(
    null
  );
  const appendRef = useRef<(text: string) => Promise<void>>(async () => {});

  const sendRequest = (text: string) => {
    pendingRef.current = { baselineKey: latestReplyRef.current?.key ?? null, request: text };
    if (!onVoiceRequest) return;
    void onVoiceRequest(text).then((accepted) => {
      if (accepted) return;
      pendingRef.current = null;
      void appendRef.current(
        `The request "${text}" could not be sent to the session. Tell the user.`
      );
    });
  };
  const sendRequestRef = useRef(sendRequest);
  sendRequestRef.current = sendRequest;

  const voice = useVoiceCall({
    onUserTranscript: (text) => {
      if (modeRef.current === 'dictation') onDictationText(text);
    },
    onRequest: (text) => {
      const buffer = requestBufferRef.current;
      if (buffer) clearTimeout(buffer.timer);
      const texts = [...(buffer?.texts ?? []), text];
      requestBufferRef.current = {
        texts,
        timer: setTimeout(() => {
          requestBufferRef.current = null;
          sendRequestRef.current(texts.join(' '));
        }, REQUEST_MERGE_WINDOW_MS),
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
    sendRequestRef.current(buffer.texts.join(' '));
  }, [voice.state]);

  // Hand the session's answer back to the voice once a newer reply has finished.
  const { append } = voice;
  useEffect(() => {
    const pending = pendingRef.current;
    if (!pending || isAgentBusy || !latestReply || latestReply.key === pending.baselineKey) return;
    pendingRef.current = null;
    const reply = latestReply.text.slice(0, MAX_REPLY_CHARS);
    void append(
      reply
        ? `The background agent finished the request "${pending.request}". Its reply:\n${reply}`
        : `The background agent finished the request "${pending.request}" without a written reply.`
    );
  }, [append, isAgentBusy, latestReply]);

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
      if (mode === 'dictation') onDictationStart();
      pendingRef.current = null;
      void voice.start(mode, mode === 'conversation' ? CONVERSATION_INSTRUCTIONS : undefined);
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
