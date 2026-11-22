import { useEffect, useRef } from 'react';
import { MessageCircleDashed } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import type { ConversationFontSize } from '@/atoms/settings';
import { MarkdownRenderer } from '@/components/ai-gui/markdown-renderer';
import { ConversationColumn } from '@/components/shared/conversation-column';
import { cn } from '@/lib/utils';
import { formatBtwFileName, type BtwSelectionAttachment, type BtwTurn } from './btw-atoms';
import { BTW_ACCENT_TEXT_CLASS, BTW_SURFACE_BG_CLASS } from './btw-info-bar-toggle';

export type BtwStreamViewProps = {
  readonly turns: readonly BtwTurn[];
  readonly streamingText: string;
  readonly isStreaming: boolean;
  readonly readOnlyTools: boolean;
  readonly error: string | null;
  readonly conversationFontSize?: ConversationFontSize;
  readonly onToggleReadOnlyTools: () => void;
  readonly variant?: 'overlay' | 'side-panel';
  readonly className?: string;
};

function formatQuoteExcerpt(selection: BtwSelectionAttachment): string {
  const fileName = formatBtwFileName(selection.path) ?? selection.path;
  const singleLine = selection.text.replace(/\s+/g, ' ').trim();
  const clipped = singleLine.length > 48 ? `${singleLine.slice(0, 48)}…` : singleLine;
  return `${fileName} · "${clipped}"`;
}

export function BtwStreamView({
  turns,
  streamingText,
  isStreaming,
  readOnlyTools,
  error,
  conversationFontSize,
  onToggleReadOnlyTools,
  variant = 'overlay',
  className,
}: BtwStreamViewProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(true);

  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedToBottomRef.current = distanceToBottom < 48;
  };

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el || !pinnedToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [turns.length, streamingText, isStreaming, error]);

  const isEmpty = turns.length === 0 && !isStreaming && !error;
  const isSidePanel = variant === 'side-panel';

  const bodyContent = (
    <>
      {isEmpty ? (
        <div className="flex flex-1 flex-col items-center justify-center py-10 text-muted-foreground/45">
          <MessageCircleDashed className="h-6 w-6" aria-hidden="true" />
        </div>
      ) : (
        turns.map((turn) =>
          turn.role === 'user' ? (
            <div key={turn.id} className="flex flex-col items-end gap-1.5">
              {turn.selection ? (
                <div
                  data-btw-quote-chip=""
                  className={cn(
                    'max-w-[90%] truncate rounded-md bg-primary/12 px-2 py-0.5 text-[11px]',
                    BTW_ACCENT_TEXT_CLASS
                  )}
                  title={turn.selection.text}
                >
                  {formatQuoteExcerpt(turn.selection)}
                </div>
              ) : null}
              <div className="max-w-[86%] whitespace-pre-wrap break-words rounded-xl rounded-br-sm bg-foreground/[0.06] px-3 py-2 text-[13px] leading-relaxed text-foreground dark:bg-white/[0.07]">
                {turn.text}
              </div>
            </div>
          ) : (
            <div key={turn.id} className="min-w-0 text-[13px] leading-relaxed text-foreground">
              {turn.text ? (
                <MarkdownRenderer text={turn.text} size={conversationFontSize} />
              ) : turn.cancelled ? (
                <span className="text-xs text-muted-foreground">已停止</span>
              ) : null}
            </div>
          )
        )
      )}

      {isStreaming ? (
        <div className="min-w-0 text-[13px] leading-relaxed text-foreground">
          {streamingText ? (
            <MarkdownRenderer text={streamingText} size={conversationFontSize} isStreaming />
          ) : (
            <div className="flex items-center gap-2 py-1 text-muted-foreground">
              <Spinner className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
            </div>
          )}
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </div>
      ) : null}

      <div className="flex items-center gap-2 pt-0.5">
        <button
          type="button"
          data-btw-readonly-toggle=""
          aria-pressed={readOnlyTools}
          onClick={onToggleReadOnlyTools}
          className={cn(
            'inline-flex items-center rounded-[7px] border px-2.5 py-1 text-[11.5px] transition-colors',
            readOnlyTools
              ? cn('border-primary/40 bg-primary/12', BTW_ACCENT_TEXT_CLASS)
              : 'border-border bg-background/80 text-foreground/75 hover:border-primary/35 hover:bg-primary/10 dark:text-muted-foreground dark:hover:text-primary'
          )}
        >
          {readOnlyTools ? '只读工具已开启' : '开启只读查代码'}
        </button>
      </div>
    </>
  );

  return (
    <div
      data-btw-stream-view=""
      data-btw-stream-variant={variant}
      role={isSidePanel ? undefined : 'region'}
      aria-label={isSidePanel ? undefined : '/btw'}
      className={cn(
        isSidePanel
          ? 'relative flex min-h-0 flex-1 flex-col overflow-hidden'
          : 'absolute inset-0 z-20 flex min-h-0 flex-col overflow-hidden',
        !isSidePanel && BTW_SURFACE_BG_CLASS,
        className
      )}
    >
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className={cn(
          'input-scrollbar flex-1 min-h-0 overflow-y-auto',
          isSidePanel ? 'py-3.5' : 'py-4'
        )}
      >
        {isSidePanel ? (
          <div className="flex min-h-full flex-col gap-3.5 px-3.5">{bodyContent}</div>
        ) : (
          <ConversationColumn className="flex min-h-full flex-col gap-3.5">
            {bodyContent}
          </ConversationColumn>
        )}
      </div>
    </div>
  );
}
