import { useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { text } from '@lody/ui/tokens/scales.stylex';
import { lowStimulusModeEnabledAtom } from '@/atoms/settings';
import { cn } from '@/lib/utils';
import type { AssistantActivityRenderItem } from './assistant-turn-render-blocks';
import { conversation } from './conversation.tokens.stylex';
import {
  extractLatestStreamingThoughtPreview,
  STREAMING_THOUGHT_PREVIEW_LOW_STIMULUS_HOLD_MS,
  STREAMING_THOUGHT_PREVIEW_MIN_HOLD_MS,
} from './streaming-thought-preview';

const previewStyles = stylex.create({
  root: {
    paddingInline: conversation.railInset,
    paddingTop: '1px',
    paddingBottom: conversation.activityPadding,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 400,
    color: colors.secondaryLabel,
    userSelect: 'none',
    overflowWrap: 'anywhere',
  },
});

/**
 * Holds each preview sentence for at least `minHoldMs` before switching to the
 * latest candidate, deduplicates identical text, retains the last valid preview
 * when an unfinished chunk parses to `null`, and resets immediately on group change.
 */
export function useThrottledStreamingThoughtPreview(
  candidate: string | null,
  resetKey: string,
  minHoldMs: number
): string | null {
  const [displayed, setDisplayed] = useState<{ key: string; text: string | null }>(() => ({
    key: resetKey,
    text: candidate,
  }));

  const activeKeyRef = useRef(resetKey);
  const displayedTextRef = useRef<string | null>(candidate);
  const lastCommittedAtRef = useRef<number>(candidate !== null ? Date.now() : 0);
  const pendingTextRef = useRef<string | null>(null);
  const scheduledMinHoldMsRef = useRef<number>(minHoldMs);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => () => clearTimer(), []);

  useEffect(() => {
    if (activeKeyRef.current !== resetKey) {
      clearTimer();
      activeKeyRef.current = resetKey;
      pendingTextRef.current = null;
      displayedTextRef.current = candidate;
      lastCommittedAtRef.current = candidate !== null ? Date.now() : 0;
      setDisplayed({ key: resetKey, text: candidate });
      return;
    }

    const effectiveCandidate = candidate ?? pendingTextRef.current;
    if (effectiveCandidate === null) {
      return;
    }

    if (effectiveCandidate === displayedTextRef.current) {
      clearTimer();
      pendingTextRef.current = null;
      return;
    }

    if (displayedTextRef.current === null) {
      clearTimer();
      pendingTextRef.current = null;
      displayedTextRef.current = effectiveCandidate;
      lastCommittedAtRef.current = Date.now();
      setDisplayed({ key: resetKey, text: effectiveCandidate });
      return;
    }

    const now = Date.now();
    const remaining = lastCommittedAtRef.current + minHoldMs - now;
    if (remaining <= 0) {
      clearTimer();
      pendingTextRef.current = null;
      displayedTextRef.current = effectiveCandidate;
      lastCommittedAtRef.current = now;
      setDisplayed({ key: resetKey, text: effectiveCandidate });
      return;
    }

    pendingTextRef.current = effectiveCandidate;
    if (timerRef.current === null || scheduledMinHoldMsRef.current !== minHoldMs) {
      clearTimer();
      scheduledMinHoldMsRef.current = minHoldMs;
      const targetKey = resetKey;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (activeKeyRef.current !== targetKey) {
          return;
        }
        const nextText = pendingTextRef.current;
        pendingTextRef.current = null;
        if (nextText === null || nextText === displayedTextRef.current) {
          return;
        }
        displayedTextRef.current = nextText;
        lastCommittedAtRef.current = Date.now();
        setDisplayed({ key: targetKey, text: nextText });
      }, remaining);
    }
  }, [candidate, minHoldMs, resetKey]);

  return displayed.key === resetKey ? displayed.text : candidate;
}

export function StreamingThoughtPreview({
  groupKey,
  entries,
}: {
  groupKey: string;
  entries: readonly AssistantActivityRenderItem[];
}) {
  const lowStimulusMode = useAtomValue(lowStimulusModeEnabledAtom);
  const candidate = useMemo(() => extractLatestStreamingThoughtPreview(entries), [entries]);
  const minHoldMs = lowStimulusMode
    ? STREAMING_THOUGHT_PREVIEW_LOW_STIMULUS_HOLD_MS
    : STREAMING_THOUGHT_PREVIEW_MIN_HOLD_MS;
  const preview = useThrottledStreamingThoughtPreview(candidate, groupKey, minHoldMs);

  if (!preview) {
    return null;
  }

  return (
    <div
      data-streaming-thought-preview=""
      className={cn(stylex.props(previewStyles.root).className, 'line-clamp-2 select-none')}
    >
      {preview}
    </div>
  );
}
