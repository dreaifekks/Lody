import { memo, useMemo, type ReactNode } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import type { MessageContent, SessionHistoryParsed } from '@lody/shared';
import { lowStimulusModeEnabledAtom, type ConversationFontSize } from '@/atoms/settings';
import { useIsMobile } from '@/hooks/use-mobile';
import { useStableNow } from '@/hooks/use-stable-now';
import { formatDurationCompact, getDurationUnitLabels } from '@/lib/format-duration';
import { resolveLiveSessionHistoryDurationMs } from '@/lib/session-history-duration';
import { getThoughtSearchBlockId } from '@/lib/session-chat-search';
import { cn } from '@/lib/utils';
import type { AssistantActivityRenderItem } from './assistant-turn-render-blocks';
import {
  extractLatestCompactThoughtParagraph,
  findActiveNonBackgroundTool,
  summarizeCompactTools,
  type CompactDirectoryEntry,
  type CompactToolCategory,
  type CompactToolCounts,
} from './compact-native-directory';
import { conversation } from './conversation.tokens.stylex';
import { MarkdownRenderer } from './markdown-renderer';
import {
  STREAMING_THOUGHT_PREVIEW_LOW_STIMULUS_HOLD_MS,
  STREAMING_THOUGHT_PREVIEW_MIN_HOLD_MS,
} from './streaming-thought-preview';
import { useThrottledStreamingThoughtPreview } from './streaming-thought-preview-row';

type ToolCallMessage = Extract<MessageContent, { type: 'tool_call' }>;
type LiveDurationMessage = Pick<SessionHistoryParsed, 'timestamp' | 'permissionWaitMs'>;

const LIVE_DURATION_SAMPLE_MS = 300;

const styles = stylex.create({
  trigger: {
    display: 'block',
    width: '100%',
    maxWidth: '100%',
    paddingBlock: conversation.activityPadding,
    paddingInline: conversation.railInset,
    borderRadius: radius.mini,
    textAlign: 'start',
    color: colors.secondaryLabel,
    userSelect: 'none',
  },
  primaryLine: {
    display: 'flex',
    width: '100%',
    minWidth: 0,
    minHeight: conversation.activityPitch,
    alignItems: 'center',
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    color: colors.secondaryLabel,
  },
  primaryShimmerWrap: {
    flex: '0 1 auto',
    minWidth: 0,
    maxWidth: '100%',
    overflow: 'hidden',
  },
  primaryText: {
    display: 'flex',
    width: '100%',
    minWidth: 0,
    alignItems: 'baseline',
    columnGap: '5px',
    whiteSpace: 'nowrap',
  },
  verbStrong: {
    flexShrink: 0,
    fontWeight: 500,
    color: colors.label,
  },
  separatorDot: {
    flexShrink: 0,
  },
  activeTargetEllipsis: {
    minWidth: 0,
    flex: '0 10000 auto',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  activeTargetMinFloor: {
    minWidth: '64px',
  },
  toolCountsEllipsis: {
    minWidth: 0,
    flex: '0 1 auto',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  settledLabelEllipsis: {
    minWidth: 0,
    flex: '0 1 auto',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  duration: {
    flexShrink: 0,
    color: colors.secondaryLabel,
    fontVariantNumeric: 'tabular-nums',
  },
  secondaryLine: {
    marginTop: '3px',
    minWidth: 0,
    maxWidth: '100%',
    fontSize: text.footnoteSize,
    lineHeight: text.subheadlineLeading,
    fontWeight: 400,
    color: colors.secondaryLabel,
    whiteSpace: 'pre-line',
    overflowWrap: 'anywhere',
    userSelect: 'none',
  },
  toolbar: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingInline: conversation.railInset,
    paddingBottom: '2px',
  },
  toolbarAction: {
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    color: { default: colors.secondaryLabel, ':hover': colors.label },
    backgroundColor: { default: 'transparent', ':hover': conversation.activityHoverFill },
    paddingBlock: '1px',
    paddingInline: space[1.5],
    borderRadius: radius.mini,
    userSelect: 'none',
  },
  thoughtRow: {
    display: 'flex',
    width: '100%',
    alignItems: 'baseline',
    columnGap: space[1.5],
    paddingBlock: '3px',
    paddingInline: conversation.railInset,
    borderRadius: radius.mini,
    textAlign: 'start',
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    color: { default: colors.secondaryLabel, ':hover': colors.label },
    backgroundColor: { default: 'transparent', ':hover': conversation.activityHoverFill },
    userSelect: 'none',
  },
  thoughtLabel: {
    flexShrink: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.tertiaryLabel,
  },
  thoughtExcerpt: {
    minWidth: 0,
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  thoughtExcerptOpen: {
    color: colors.label,
  },
  thoughtBody: {
    paddingTop: space[1],
    paddingBottom: space[2],
    paddingInlineStart: '22px',
    paddingInlineEnd: conversation.railInset,
  },
  placeholderNote: {
    paddingBlock: '3px',
    paddingInlineStart: '22px',
    paddingInlineEnd: conversation.railInset,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.tertiaryLabel,
    fontStyle: 'italic',
    userSelect: 'none',
  },
  toolRow: {
    display: 'flex',
    width: '100%',
    alignItems: 'baseline',
    columnGap: '7px',
    paddingBlock: '2.5px',
    paddingInline: conversation.railInset,
    borderRadius: radius.mini,
    textAlign: 'start',
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    color: colors.secondaryLabel,
    userSelect: 'none',
  },
  toolRowClickable: {
    cursor: 'pointer',
    backgroundColor: { default: 'transparent', ':hover': conversation.activityHoverFill },
  },
  toolBullet: {
    width: '12px',
    flexShrink: 0,
    display: 'inline-flex',
    justifyContent: 'center',
    fontSize: '9px',
    color: colors.tertiaryLabel,
  },
  toolVerb: {
    flexShrink: 0,
    fontWeight: 500,
    color: colors.label,
  },
  toolTarget: {
    minWidth: 0,
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: colors.secondaryLabel,
  },
  toolTargetFileLink: {
    minWidth: 0,
    maxWidth: '100%',
    flex: '0 1 auto',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: 'start',
    color: colors.secondaryLabel,
    cursor: 'pointer',
  },
  toolTargetMono: {
    fontFamily: 'var(--font-mono)',
    fontSize: text.footnoteSize,
  },
  clusterList: {
    marginTop: '2px',
    marginBottom: space[1.5],
    marginInlineStart: '23px',
    paddingInlineStart: '10px',
    borderInlineStartWidth: '1.5px',
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: colors.separator,
    display: 'flex',
    flexDirection: 'column',
    rowGap: '2px',
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },
  clusterFileButton: {
    display: 'inline-flex',
    width: 'fit-content',
    maxWidth: '100%',
    fontFamily: 'var(--font-mono)',
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    color: 'hsl(var(--primary))',
    textAlign: 'start',
    overflowWrap: 'anywhere',
  },
  clusterFileStatic: {
    fontFamily: 'var(--font-mono)',
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    color: colors.secondaryLabel,
    overflowWrap: 'anywhere',
  },
  toolDetailWrap: {
    marginTop: space[1],
    marginBottom: space[1.5],
    paddingInline: conversation.railInset,
  },
});

const CompactLiveDuration = ({ message }: { message: LiveDurationMessage }) => {
  const { t } = useTranslation();
  const now = useStableNow(LIVE_DURATION_SAMPLE_MS);
  const durationMs = resolveLiveSessionHistoryDurationMs(message, now.getTime());
  if (durationMs === null) return null;
  const duration = formatDurationCompact(durationMs, getDurationUnitLabels(t));
  if (!duration) return null;
  return (
    <span {...stylex.props(styles.duration)} data-compact-live-duration="">
      {t('sessions.compactProcess.durationWrap', {
        duration,
        defaultValue: '({{duration}})',
      })}
    </span>
  );
};

const formatCompactToolCounts = (
  counts: CompactToolCounts,
  t: ReturnType<typeof useTranslation>['t']
): string => {
  const parts: string[] = [];
  if (counts.readFileCount > 0) {
    parts.push(
      t('sessions.compactProcess.countRead', {
        count: counts.readFileCount,
        defaultValue: counts.readFileCount === 1 ? 'Read {{count}} file' : 'Read {{count}} files',
      })
    );
  }
  if (counts.editFileCount > 0) {
    parts.push(
      t('sessions.compactProcess.countEdit', {
        count: counts.editFileCount,
        defaultValue:
          counts.editFileCount === 1 ? 'Edited {{count}} file' : 'Edited {{count}} files',
      })
    );
  }
  if (counts.searchCount > 0) {
    parts.push(
      t('sessions.compactProcess.countSearch', {
        count: counts.searchCount,
        defaultValue:
          counts.searchCount === 1 ? 'Searched {{count}} time' : 'Searched {{count}} times',
      })
    );
  }
  if (counts.commandCount > 0) {
    parts.push(
      t('sessions.compactProcess.countCommand', {
        count: counts.commandCount,
        defaultValue:
          counts.commandCount === 1 ? 'Ran {{count}} command' : 'Ran {{count}} commands',
      })
    );
  }
  if (counts.fetchCount > 0) {
    parts.push(
      t('sessions.compactProcess.countFetch', {
        count: counts.fetchCount,
        defaultValue:
          counts.fetchCount === 1 ? 'Fetched {{count}} item' : 'Fetched {{count}} items',
      })
    );
  }
  if (counts.otherCount > 0) {
    parts.push(
      t('sessions.compactProcess.countOther', {
        count: counts.otherCount,
        defaultValue: counts.otherCount === 1 ? 'Called {{count}} tool' : 'Called {{count}} tools',
      })
    );
  }
  if (counts.backgroundCount > 0) {
    parts.push(
      t('sessions.compactProcess.countBackground', {
        count: counts.backgroundCount,
        defaultValue: '{{count}} in background',
      })
    );
  }
  return parts.join(' · ');
};

/**
 * Option C single-level work header:
 * - Streaming (`isLive`): fixed two-tier zero-card live summary whose rows never
 *   swap places:
 *   - Row 1 (single-line, never wraps): live status (`Thinking` or `Running <target>`)
 *     + persistent completed/background tool counts + elapsed duration.
 *   - Row 2 (collapsed only, natural multi-line wrap): full latest valid thought
 *     paragraph (retained while tools run or placeholder/unclosed chunks stream).
 * - Finished (`!isLive`): native "Worked for {{duration}}" / "Finished working"
 *   header with no extra token counts or chatter; one click opens the flat directory.
 */
export const CompactWorkHeaderRow = memo(function CompactWorkHeaderRow({
  id,
  message,
  entries,
  expanded,
  isLive,
  isTurnFinished = !isLive,
  showLiveDuration = true,
  durationMs,
  shimmer = false,
  onExpandedChange,
}: {
  id: string;
  message: LiveDurationMessage;
  entries: readonly AssistantActivityRenderItem[];
  expanded: boolean;
  /** True while this work segment is the trailing active phase (before final prose starts). */
  isLive: boolean;
  isTurnFinished?: boolean;
  /** False during background wakeup late streams where wall-clock includes idle wait time. */
  showLiveDuration?: boolean;
  durationMs: number | null;
  shimmer?: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const lowStimulusMode = useAtomValue(lowStimulusModeEnabledAtom);

  const candidateThought = useMemo(
    () => (isLive ? extractLatestCompactThoughtParagraph(entries) : null),
    [entries, isLive]
  );
  const minHoldMs = lowStimulusMode
    ? STREAMING_THOUGHT_PREVIEW_LOW_STIMULUS_HOLD_MS
    : STREAMING_THOUGHT_PREVIEW_MIN_HOLD_MS;
  const thoughtParagraph = useThrottledStreamingThoughtPreview(candidateThought, id, minHoldMs);
  const activeTool = useMemo(
    () => (isLive ? findActiveNonBackgroundTool(entries) : null),
    [entries, isLive]
  );
  const toolCounts = useMemo(
    () => (isLive ? summarizeCompactTools(entries) : null),
    [entries, isLive]
  );
  const toolSummaryLine = toolCounts ? formatCompactToolCounts(toolCounts, t) : '';

  const effectiveDurationMs = isMobile ? null : durationMs;
  const finishedDurationLabel =
    effectiveDurationMs === null
      ? ''
      : formatDurationCompact(effectiveDurationMs, getDurationUnitLabels(t));
  const settledLabel = !isTurnFinished
    ? t('sessions.working', 'Working')
    : finishedDurationLabel
      ? t('sessions.workedFor', {
          duration: finishedDurationLabel,
          defaultValue: 'Worked for {{duration}}',
        })
      : t('sessions.finishedWorking', 'Finished working');

  const showShimmer = isLive && shimmer && !lowStimulusMode;
  const latestThoughtBody = isLive && !expanded && thoughtParagraph ? thoughtParagraph : null;

  return (
    <button
      type="button"
      className={cn('group', stylex.props(styles.trigger).className)}
      aria-expanded={expanded}
      data-conversation-disclosure="group"
      data-compact-work-header={isLive ? 'live' : 'finished'}
      onClick={() => onExpandedChange(!expanded)}
    >
      <div {...stylex.props(styles.primaryLine)}>
        <span
          className={cn(
            stylex.props(styles.primaryShimmerWrap).className,
            showShimmer && 'agent-shimmer'
          )}
        >
          <span {...stylex.props(styles.primaryText)} data-compact-primary-line="">
            {isLive ? (
              activeTool ? (
                <>
                  <span {...stylex.props(styles.verbStrong)} data-compact-status-verb="">
                    {t('sessions.compactProcess.running', 'Running')}
                  </span>
                  <span
                    {...stylex.props(
                      styles.activeTargetEllipsis,
                      Boolean(toolSummaryLine) &&
                        activeTool.shortTarget.length >= 10 &&
                        styles.activeTargetMinFloor
                    )}
                    data-compact-active-target=""
                  >
                    {activeTool.shortTarget}
                  </span>
                  {toolSummaryLine ? (
                    <>
                      <span {...stylex.props(styles.separatorDot)} aria-hidden="true">
                        ·
                      </span>
                      <span
                        {...stylex.props(styles.toolCountsEllipsis)}
                        data-compact-tool-counts=""
                      >
                        {toolSummaryLine}
                      </span>
                    </>
                  ) : null}
                  {showLiveDuration ? <CompactLiveDuration message={message} /> : null}
                </>
              ) : (
                <>
                  <span {...stylex.props(styles.verbStrong)} data-compact-status-verb="">
                    {t('sessions.compactProcess.thinking', 'Thinking')}
                  </span>
                  {toolSummaryLine ? (
                    <>
                      <span {...stylex.props(styles.separatorDot)} aria-hidden="true">
                        ·
                      </span>
                      <span
                        {...stylex.props(styles.toolCountsEllipsis)}
                        data-compact-tool-counts=""
                      >
                        {toolSummaryLine}
                      </span>
                    </>
                  ) : null}
                  {showLiveDuration ? <CompactLiveDuration message={message} /> : null}
                </>
              )
            ) : (
              <span {...stylex.props(styles.settledLabelEllipsis)}>{settledLabel}</span>
            )}
          </span>
        </span>
        <span
          className={cn(
            'ml-1 inline-flex shrink-0 items-center text-muted-foreground',
            lowStimulusMode ? 'transition-none' : 'transition-[opacity,transform] duration-150',
            expanded
              ? 'opacity-100 rotate-90'
              : isMobile
                ? 'opacity-100'
                : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'
          )}
        >
          <ChevronRight className="h-[1em] w-[1em]" aria-hidden="true" />
        </span>
      </div>
      {latestThoughtBody ? (
        <div
          {...stylex.props(styles.secondaryLine)}
          data-compact-secondary-line=""
          data-streaming-thought-preview=""
        >
          {latestThoughtBody}
        </div>
      ) : null}
    </button>
  );
});

export const CompactDirectoryToolbarRow = memo(function CompactDirectoryToolbarRow({
  allThoughtsExpanded,
  onToggleAllThoughts,
}: {
  allThoughtsExpanded: boolean;
  onToggleAllThoughts: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(styles.toolbar)} data-compact-dir-toolbar="">
      <button
        type="button"
        {...stylex.props(styles.toolbarAction)}
        data-compact-toggle-all-thoughts=""
        onClick={onToggleAllThoughts}
      >
        {allThoughtsExpanded
          ? t('sessions.compactProcess.collapseAllThoughts', 'Collapse all thoughts')
          : t('sessions.compactProcess.expandAllThoughts', 'Expand all thoughts')}
      </button>
    </div>
  );
});

const getCompactToolVerb = (
  category: CompactToolCategory,
  flags: { isRunning: boolean },
  t: ReturnType<typeof useTranslation>['t']
): string => {
  switch (category) {
    case 'read':
      return t('sessions.compactProcess.verbRead', 'Read');
    case 'edit':
      return t('sessions.compactProcess.verbEdit', 'Edit');
    case 'search':
      return t('sessions.compactProcess.verbSearch', 'Search');
    case 'fetch':
      return t('sessions.compactProcess.verbFetch', 'Fetch');
    case 'command':
      if (flags.isRunning) return t('sessions.compactProcess.running', 'Running');
      return t('sessions.compactProcess.verbRun', 'Run');
    default:
      return t('sessions.compactProcess.verbCall', 'Call');
  }
};

export const CompactDirectoryEntryRow = memo(function CompactDirectoryEntryRow({
  messageId,
  entry,
  expanded,
  isStreaming,
  isLastEntry,
  fontSize,
  onToggleExpanded,
  onFilePathClick,
  renderToolDetail,
}: {
  messageId: string;
  entry: CompactDirectoryEntry;
  expanded: boolean;
  isStreaming: boolean;
  isLastEntry: boolean;
  fontSize: ConversationFontSize;
  onToggleExpanded: () => void;
  onFilePathClick?: (filePath: string) => void;
  renderToolDetail: (toolCall: ToolCallMessage) => ReactNode;
}) {
  const { t } = useTranslation();
  const lowStimulusMode = useAtomValue(lowStimulusModeEnabledAtom);

  if (entry.kind === 'thought') {
    if (entry.isPlaceholderOnly) {
      return (
        <div {...stylex.props(styles.placeholderNote)} data-compact-thought-placeholder="">
          {t('sessions.toolActivity.thinking', 'Thinking…')}
        </div>
      );
    }

    return (
      <div data-compact-thought-row={entry.itemIndex}>
        <button
          type="button"
          {...stylex.props(styles.thoughtRow)}
          aria-expanded={expanded}
          data-compact-thought-toggle=""
          onClick={onToggleExpanded}
        >
          <span
            aria-hidden="true"
            className={cn(
              'inline-block w-3 shrink-0 text-[11px] text-muted-foreground/75',
              lowStimulusMode ? 'transition-none' : 'transition-transform duration-150',
              expanded && 'rotate-90 text-muted-foreground'
            )}
          >
            ▸
          </span>
          <span {...stylex.props(styles.thoughtLabel)}>
            {t('sessions.compactProcess.thoughtLabel', 'Thought')}
          </span>
          <span {...stylex.props(styles.thoughtExcerpt, expanded && styles.thoughtExcerptOpen)}>
            {entry.excerpt}
          </span>
        </button>
        {expanded ? (
          <div {...stylex.props(styles.thoughtBody)} data-compact-thought-body="">
            <MarkdownRenderer
              text={entry.cleanedMarkdown}
              size={fontSize}
              compact
              isStreaming={isStreaming && isLastEntry}
              muted
              searchBlockId={getThoughtSearchBlockId(messageId, entry.itemIndex)}
              onAgentFileLinkClick={onFilePathClick}
            />
          </div>
        ) : null}
      </div>
    );
  }

  if (entry.kind === 'read_cluster') {
    const fileNames = entry.files.map((file) => file.fileName).join(', ');
    return (
      <div data-compact-read-cluster={entry.id}>
        <button
          type="button"
          {...stylex.props(styles.toolRow, styles.toolRowClickable)}
          aria-expanded={expanded}
          data-compact-read-cluster-toggle=""
          onClick={onToggleExpanded}
        >
          <span {...stylex.props(styles.toolBullet)} aria-hidden="true">
            ●
          </span>
          <span {...stylex.props(styles.toolVerb)}>
            {t('sessions.compactProcess.readFilesCluster', {
              count: entry.items.length,
              defaultValue: 'Read {{count}} files',
            })}
          </span>
          <span {...stylex.props(styles.toolTarget)}>{fileNames}</span>
        </button>
        {expanded ? (
          <div {...stylex.props(styles.clusterList)} data-compact-read-cluster-list="">
            {entry.files.map((file, index) =>
              file.path && onFilePathClick ? (
                <button
                  key={`${file.displayPath}:${index}`}
                  type="button"
                  className={cn(
                    stylex.props(styles.clusterFileButton).className,
                    'hover:underline'
                  )}
                  onClick={() => onFilePathClick(file.path!)}
                >
                  {file.displayPath}
                </button>
              ) : (
                <span
                  key={`${file.displayPath}:${index}`}
                  {...stylex.props(styles.clusterFileStatic)}
                >
                  {file.displayPath}
                </span>
              )
            )}
          </div>
        ) : null}
      </div>
    );
  }

  // Standalone tool row
  const toolCall = entry.entry.content;
  const isRunning = toolCall.status === 'in_progress' && !entry.isBackgrounded;
  const isFailed = toolCall.status === 'failed';
  const bullet = isRunning ? '◌' : '●';
  const verb = getCompactToolVerb(entry.category, { isRunning }, t);
  const canOpenFile =
    (entry.category === 'read' || entry.category === 'edit') &&
    Boolean(entry.filePath && onFilePathClick);
  const hasSeparateFileLink = entry.hasDetail && canOpenFile;

  const bulletAndVerb = (
    <>
      <span
        className={cn(
          stylex.props(styles.toolBullet).className,
          isRunning && 'text-primary',
          isFailed && 'text-status-danger'
        )}
        aria-hidden="true"
      >
        {bullet}
      </span>
      <span
        className={cn(
          stylex.props(styles.toolVerb).className,
          isRunning && !lowStimulusMode && 'agent-shimmer',
          isFailed && 'text-status-danger'
        )}
      >
        {verb}
      </span>
    </>
  );

  // Historical indicator that this command was detached to background; neutral and
  // purely derived from persisted `tool_call.backgroundTaskId` (never live presence).
  const historicalBgBadge = entry.isBackgrounded ? (
    <span
      data-compact-bg-badge=""
      className="shrink-0 rounded px-1.5 font-mono text-[10.5px] leading-4 bg-muted text-muted-foreground"
    >
      {t('sessions.compactProcess.bgBadge', 'BG')}
    </span>
  ) : null;

  const staticRowContent = (
    <>
      {bulletAndVerb}
      <span
        {...stylex.props(styles.toolTarget, entry.category === 'command' && styles.toolTargetMono)}
      >
        {entry.shortTarget}
      </span>
      {historicalBgBadge}
    </>
  );

  return (
    <div data-compact-tool-row={toolCall.toolCallId}>
      {hasSeparateFileLink ? (
        <div
          role="button"
          tabIndex={0}
          {...stylex.props(styles.toolRow, styles.toolRowClickable)}
          aria-expanded={expanded}
          data-compact-tool-toggle=""
          onClick={onToggleExpanded}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onToggleExpanded();
            }
          }}
        >
          {bulletAndVerb}
          <button
            type="button"
            data-compact-tool-file-link=""
            className={cn(
              stylex.props(styles.toolTargetFileLink).className,
              'hover:text-foreground hover:underline focus-visible:outline-none focus-visible:underline'
            )}
            onClick={(event) => {
              event.stopPropagation();
              onFilePathClick!(entry.filePath!);
            }}
          >
            {entry.shortTarget}
          </button>
          {historicalBgBadge}
        </div>
      ) : entry.hasDetail ? (
        <button
          type="button"
          {...stylex.props(styles.toolRow, styles.toolRowClickable)}
          aria-expanded={expanded}
          data-compact-tool-toggle=""
          onClick={onToggleExpanded}
        >
          {staticRowContent}
        </button>
      ) : canOpenFile ? (
        <button
          type="button"
          {...stylex.props(styles.toolRow, styles.toolRowClickable)}
          data-compact-tool-toggle=""
          data-compact-tool-file-link=""
          onClick={() => onFilePathClick!(entry.filePath!)}
        >
          {staticRowContent}
        </button>
      ) : (
        <div {...stylex.props(styles.toolRow)}>{staticRowContent}</div>
      )}
      {entry.hasDetail && expanded ? (
        <div {...stylex.props(styles.toolDetailWrap)} data-compact-tool-detail="">
          {renderToolDetail(toolCall)}
        </div>
      ) : null}
    </div>
  );
});
