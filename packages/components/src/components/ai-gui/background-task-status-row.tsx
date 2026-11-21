import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import type { SessionStatus } from '@lody/shared';
import {
  DEFAULT_CONVERSATION_FONT_SIZE,
  lowStimulusModeEnabledAtom,
  type ConversationFontSize,
} from '@/atoms/settings';
import { cn } from '@/lib/utils';
import { ConversationColumn } from '@/components/shared/conversation-column';
import { conversationTextFontSizeStyle } from './conversation-font-size-classes';
import { conversation } from './conversation.tokens.stylex';

export type SessionBackgroundTaskStatus = {
  mode: 'waiting' | 'wakeup';
  taskCount?: number;
};

export const isSessionBackground = (liveStatus: SessionStatus | null | undefined): boolean =>
  liveStatus?.type === 'running' && liveStatus.backgroundTaskState === 'background';

/**
 * Resolves the native background task status shown below a finished assistant turn.
 *
 * Returns `null` whenever a foreground turn, pending user dispatch, or user question
 * owns the bottom status line. Otherwise:
 * - `running` + `backgroundTaskState: 'background'` → silent background waiting (`mode: 'waiting'`)
 * - `running` + no `phase` + (`backgroundTaskState: 'running'` or `backgroundTaskCount >= 1`)
 *   → wakeup pulse (`mode: 'wakeup'`)
 */
export const resolveBackgroundTaskStatus = ({
  liveStatus,
  hasUnfinishedAssistantTurn,
  hasPendingDispatch,
  isAwaitingQuestion,
}: {
  liveStatus: SessionStatus | null | undefined;
  hasUnfinishedAssistantTurn: boolean;
  hasPendingDispatch: boolean;
  isAwaitingQuestion: boolean;
}): SessionBackgroundTaskStatus | null => {
  if (hasUnfinishedAssistantTurn || hasPendingDispatch || isAwaitingQuestion) {
    return null;
  }
  if (liveStatus?.type !== 'running') {
    return null;
  }
  if (liveStatus.backgroundTaskState === 'background') {
    return {
      mode: 'waiting',
      taskCount: liveStatus.backgroundTaskCount,
    };
  }
  if (
    liveStatus.phase === undefined &&
    (liveStatus.backgroundTaskState === 'running' ||
      (typeof liveStatus.backgroundTaskCount === 'number' && liveStatus.backgroundTaskCount >= 1))
  ) {
    return {
      mode: 'wakeup',
      taskCount: liveStatus.backgroundTaskCount,
    };
  }
  return null;
};

const styles = stylex.create({
  row: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: space[3],
    paddingBlock: space[1],
    paddingInline: conversation.railInset,
    borderRadius: radius.mini,
    textAlign: 'start',
    color: colors.secondaryLabel,
    userSelect: 'none',
  },
  left: {
    display: 'inline-flex',
    minWidth: 0,
    flex: 1,
    alignItems: 'center',
    columnGap: space[2],
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
  },
  text: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});

/**
 * Pure-typography single-line native background task status row rendered below
 * a finished turn's final answer (replacing the un-timed orphan "Thinking" row).
 *
 * Displays only the authoritative aggregate presence signal (waiting count or
 * wakeup pulse) without guessing which historical command is still running.
 */
export function BackgroundTaskStatusRow({
  status,
  conversationFontSize = DEFAULT_CONVERSATION_FONT_SIZE,
}: {
  status: SessionBackgroundTaskStatus;
  conversationFontSize?: ConversationFontSize;
}) {
  const { t } = useTranslation();
  const lowStimulusMode = useAtomValue(lowStimulusModeEnabledAtom);

  const isWakeup = status.mode === 'wakeup';

  const waitingBaseLabel =
    typeof status.taskCount === 'number' && status.taskCount >= 1
      ? t('sessions.backgroundTasks.runningCount', {
          count: status.taskCount,
          defaultValue:
            status.taskCount === 1
              ? '{{count}} background task running'
              : '{{count}} background tasks running',
        })
      : t('sessions.backgroundTasks.running', 'Background task running');

  const dot = (
    <span
      aria-hidden="true"
      data-background-task-dot={isWakeup ? 'wakeup' : 'waiting'}
      className={cn(
        'h-[7px] w-[7px] shrink-0 rounded-full border-[1.5px]',
        isWakeup ? 'border-primary bg-primary' : 'border-status-warning bg-transparent',
        !lowStimulusMode && (isWakeup ? 'animate-bg-wake-pulse' : 'animate-bg-calm-breath')
      )}
    />
  );

  return (
    <ConversationColumn className="pb-2 sm:pb-3" data-background-task-status-row={status.mode}>
      <div className="max-w-[800px]" style={conversationTextFontSizeStyle(conversationFontSize)}>
        <div
          role="status"
          aria-live="polite"
          {...stylex.props(styles.row)}
          data-background-task-static=""
        >
          <span {...stylex.props(styles.left)}>
            {dot}
            <span {...stylex.props(styles.text)}>
              {isWakeup ? (
                <span className={cn(!lowStimulusMode && 'agent-shimmer')}>
                  {t('sessions.backgroundTasks.handling', 'Handling background task')}
                </span>
              ) : (
                <span>{waitingBaseLabel}</span>
              )}
            </span>
          </span>
        </div>
      </div>
    </ConversationColumn>
  );
}
