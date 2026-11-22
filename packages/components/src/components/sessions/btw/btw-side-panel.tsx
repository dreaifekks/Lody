import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type Ref,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { SessionId } from '@lody/shared';
import { atom, useAtom, useAtomValue } from 'jotai';
import { ArrowUp, MessageCircleDashed, Trash2, X } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Tooltip } from '@lody/ui/tooltip';
import type { ConversationFontSize } from '@/atoms/settings';
import { ChatComposer } from '@/components/chat/chat-composer';
import { isImeComposingKeyboardEvent } from '@/lib/ime';
import { cn } from '@/lib/utils';
import { getComposerText, type ComposerInputElement } from '@/ui/mention/composer-input';
import {
  btwDraftAtomFamily,
  btwSidePanelWidthPxAtom,
  type BtwSelectionAttachment,
  type BtwTurn,
} from './btw-atoms';
import { BtwComposerFooter, BtwPendingSelectionChip } from './btw-composer-chrome';
import { BTW_ACCENT_TEXT_CLASS, BTW_SURFACE_BG_CLASS } from './btw-info-bar-toggle';
import {
  BTW_SIDE_PANEL_DEFAULT_WIDTH_PX,
  clampBtwSidePanelWidth,
  getBtwSidePanelWidthBounds,
} from './btw-layout';
import { parseBtwSlashCommand } from './btw-slash-command';
import { BtwStreamView } from './btw-stream-view';

const RESIZE_KEYBOARD_STEP_PX = 24;

const HEADER_ICON_BUTTON_CLASS =
  'inline-flex h-6 w-6 shrink-0 select-none items-center justify-center rounded-md text-muted-foreground/80 transition-colors hover:bg-muted-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

/**
 * Isolated clear button leaf: also reveals when an unsent `/btw` draft exists
 * without causing the header or stream to re-render on each keystroke.
 */
const BtwSidePanelClearButton = memo(function BtwSidePanelClearButton({
  sessionId,
  canClear,
  onClear,
}: {
  readonly sessionId: SessionId;
  readonly canClear: boolean;
  readonly onClear: () => void;
}) {
  const hasDraftAtom = useMemo(
    () => atom((get) => get(btwDraftAtomFamily(sessionId)).trim().length > 0),
    [sessionId]
  );
  const hasDraft = useAtomValue(hasDraftAtom);
  if (!canClear && !hasDraft) return null;

  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <button
            type="button"
            data-btw-clear=""
            aria-label="清空 /btw"
            onClick={onClear}
            className={HEADER_ICON_BUTTON_CLASS}
          >
            <Trash2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          </button>
        }
      />
      <Tooltip.Content side="bottom">清空 /btw</Tooltip.Content>
    </Tooltip.Root>
  );
});

type BtwSidePanelComposerProps = {
  readonly sessionId: SessionId;
  readonly isDark: boolean;
  readonly isVisible: boolean;
  readonly isArchived: boolean;
  readonly isMachineRemoved: boolean;
  readonly isStreaming: boolean;
  readonly modelLabel: string;
  readonly articleFileName?: string | null;
  readonly pendingSelection: BtwSelectionAttachment | null;
  readonly composerRef?: Ref<ComposerInputElement>;
  readonly onComposerFocusChange?: (focused: boolean) => void;
  readonly onClearPendingSelection: () => void;
  readonly onSend: (question: string) => void | Promise<void>;
  readonly onCancel: () => void;
};

/**
 * Isolated composer host inside `BtwSidePanel` so typing only re-renders this leaf
 * instead of `BtwStreamView` or `SessionChatInterface`.
 */
const BtwSidePanelComposer = memo(function BtwSidePanelComposer({
  sessionId,
  isDark,
  isVisible,
  isArchived,
  isMachineRemoved,
  isStreaming,
  modelLabel,
  articleFileName,
  pendingSelection,
  composerRef,
  onComposerFocusChange,
  onClearPendingSelection,
  onSend,
  onCancel,
}: BtwSidePanelComposerProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useAtom(btwDraftAtomFamily(sessionId));
  const localComposerRef = useRef<ComposerInputElement | null>(null);

  const setPromptRef = useCallback(
    (node: ComposerInputElement | null) => {
      localComposerRef.current = node;
      if (typeof composerRef === 'function') {
        composerRef(node);
      } else if (composerRef && 'current' in composerRef) {
        (composerRef as { current: ComposerInputElement | null }).current = node;
      }
    },
    [composerRef]
  );

  const handleSend = useCallback(() => {
    if (!isVisible || isArchived || isMachineRemoved || isStreaming) return;
    const rawValue = localComposerRef.current ? getComposerText(localComposerRef.current) : draft;
    const trimmed = rawValue.trim();
    if (!trimmed) return;
    const parsed = parseBtwSlashCommand(trimmed);
    const question = parsed.matched ? parsed.question : trimmed;
    setDraft('');
    if (question) {
      void onSend(question);
    }
  }, [draft, isArchived, isMachineRemoved, isStreaming, isVisible, onSend, setDraft]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<ComposerInputElement>) => {
      if (event.key !== 'Enter' || isImeComposingKeyboardEvent(event) || event.shiftKey) {
        return;
      }
      event.preventDefault();
      handleSend();
    },
    [handleSend]
  );

  const primaryAction = isStreaming ? (
    <Button
      type="button"
      data-btw-cancel=""
      onClick={onCancel}
      variant="ghost"
      size="small"
      shape="pill"
      icon
      aria-label="停止 /btw"
      className="bg-primary text-primary-foreground shadow-xs transition-all hover:bg-primary/90 hover:text-primary-foreground active:translate-y-[1px]"
    >
      <span className="h-2.5 w-2.5 rounded-[2px] bg-current" aria-hidden="true" />
    </Button>
  ) : (
    <Button
      type="button"
      data-btw-send=""
      icon
      variant="ghost"
      size="small"
      shape="pill"
      onClick={handleSend}
      disabled={draft.trim().length === 0 || !isVisible || isMachineRemoved || isArchived}
      aria-label={t('sessions.send', 'Send')}
      className="bg-primary text-primary-foreground shadow-xs transition-all hover:bg-primary/90 hover:text-primary-foreground active:translate-y-[1px]"
    >
      <ArrowUp className="h-4 w-4" aria-hidden="true" />
    </Button>
  );

  return (
    <div
      data-btw-side-panel-composer=""
      className="shrink-0 px-3 pb-2 pt-1.5"
      onFocusCapture={() => onComposerFocusChange?.(true)}
      onBlurCapture={(event) => {
        if (
          event.currentTarget.isConnected &&
          !event.currentTarget.contains(event.relatedTarget as Node | null)
        ) {
          onComposerFocusChange?.(false);
        }
      }}
    >
      <ChatComposer
        tone={isDark ? 'dark' : 'light'}
        variant="session"
        currentSessionId={sessionId}
        draftKey={`${sessionId}:btw-side-panel`}
        promptRef={setPromptRef}
        promptValue={draft}
        onPromptChange={(nextValue) => {
          if (!isArchived) setDraft(nextValue);
        }}
        onPromptKeyDown={handleKeyDown}
        promptPlaceholder="顺便问一句…"
        promptDisabled={isArchived}
        promptRows={2}
        imageDropDisabled
        hideFocusHint
        boxClassName="border-primary/40 dark:border-primary/40"
        boxHeader={
          pendingSelection ? (
            <BtwPendingSelectionChip
              selection={pendingSelection}
              onRemove={onClearPendingSelection}
            />
          ) : undefined
        }
        footerSelector={
          <BtwComposerFooter modelLabel={modelLabel} articleFileName={articleFileName} />
        }
        primaryAction={primaryAction}
        autoResize
        maxRows={6}
        focusOnContainerClick
      />
    </div>
  );
});

export type BtwSidePanelProps = {
  readonly sessionId: SessionId;
  readonly containerWidth: number | null;
  readonly isDark: boolean;
  readonly isVisible: boolean;
  readonly isArchived?: boolean;
  readonly isMachineRemoved?: boolean;
  readonly turns: readonly BtwTurn[];
  readonly streamingText: string;
  readonly isStreaming: boolean;
  readonly readOnlyTools: boolean;
  readonly error: string | null;
  readonly modelLabel: string;
  readonly articleFileName?: string | null;
  readonly pendingSelection: BtwSelectionAttachment | null;
  readonly canClear: boolean;
  readonly conversationFontSize?: ConversationFontSize;
  readonly composerRef?: Ref<ComposerInputElement>;
  readonly onComposerFocusChange?: (focused: boolean) => void;
  readonly onToggleReadOnlyTools: () => void;
  readonly onClearPendingSelection: () => void;
  readonly onSend: (question: string) => void | Promise<void>;
  readonly onCancel: () => void;
  readonly onClear: () => void;
  readonly onClose: () => void;
  readonly className?: string;
};

export function BtwSidePanel({
  sessionId,
  containerWidth,
  isDark,
  isVisible,
  isArchived = false,
  isMachineRemoved = false,
  turns,
  streamingText,
  isStreaming,
  readOnlyTools,
  error,
  modelLabel,
  articleFileName,
  pendingSelection,
  canClear,
  conversationFontSize,
  composerRef,
  onComposerFocusChange,
  onToggleReadOnlyTools,
  onClearPendingSelection,
  onSend,
  onCancel,
  onClear,
  onClose,
  className,
}: BtwSidePanelProps) {
  const [preferredWidthPx, setPreferredWidthPx] = useAtom(btwSidePanelWidthPxAtom);
  const [isResizing, setIsResizing] = useState(false);
  const dragStateRef = useRef<{ readonly startX: number; readonly startWidth: number } | null>(
    null
  );

  const bounds = getBtwSidePanelWidthBounds(containerWidth);
  const resolvedWidth = clampBtwSidePanelWidth(preferredWidthPx, containerWidth);

  const handleResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragStateRef.current = { startX: event.clientX, startWidth: resolvedWidth };
      setIsResizing(true);
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic pointer events in tests may not have an active pointer id.
      }
    },
    [resolvedWidth]
  );

  const handleResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragStateRef.current;
      if (!drag) return;
      const delta = drag.startX - event.clientX;
      setPreferredWidthPx(clampBtwSidePanelWidth(drag.startWidth + delta, containerWidth));
    },
    [containerWidth, setPreferredWidthPx]
  );

  const finishResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragStateRef.current) return;
    dragStateRef.current = null;
    setIsResizing(false);
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Ignore synthetic events without pointer capture.
    }
  }, []);

  const handleResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        setPreferredWidthPx(
          clampBtwSidePanelWidth(resolvedWidth + RESIZE_KEYBOARD_STEP_PX, containerWidth)
        );
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        setPreferredWidthPx(
          clampBtwSidePanelWidth(resolvedWidth - RESIZE_KEYBOARD_STEP_PX, containerWidth)
        );
      } else if (event.key === 'Home') {
        event.preventDefault();
        setPreferredWidthPx(bounds.min);
      } else if (event.key === 'End') {
        event.preventDefault();
        setPreferredWidthPx(bounds.max);
      }
    },
    [bounds.max, bounds.min, containerWidth, resolvedWidth, setPreferredWidthPx]
  );

  const handleResizeDoubleClick = useCallback(() => {
    setPreferredWidthPx(clampBtwSidePanelWidth(BTW_SIDE_PANEL_DEFAULT_WIDTH_PX, containerWidth));
  }, [containerWidth, setPreferredWidthPx]);

  return (
    <aside
      data-btw-side-panel=""
      aria-label="/btw"
      style={{ width: `${resolvedWidth}px` }}
      className={cn(
        'relative flex min-h-0 shrink-0 flex-col border-l border-border',
        BTW_SURFACE_BG_CLASS,
        className
      )}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整 /btw 侧栏宽度"
        aria-valuemin={bounds.min}
        aria-valuemax={bounds.max}
        aria-valuenow={resolvedWidth}
        tabIndex={0}
        data-btw-resize-handle=""
        data-resize-handle-state={isResizing ? 'drag' : undefined}
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onDoubleClick={handleResizeDoubleClick}
        onKeyDown={handleResizeKeyDown}
        className="group/handle absolute inset-y-0 -left-1.5 z-10 flex w-3 cursor-col-resize touch-none select-none items-center justify-center focus-visible:outline-none"
      >
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none h-7 w-[3px] shrink-0 rounded-full bg-foreground opacity-0',
            'transition-[background-color,opacity,scale] duration-150',
            'group-hover/handle:bg-foreground/30 group-hover/handle:opacity-100',
            'group-focus-visible/handle:scale-y-125 group-focus-visible/handle:bg-foreground/50 group-focus-visible/handle:opacity-100',
            isResizing && 'scale-y-125 bg-foreground/70 opacity-100'
          )}
        />
      </div>

      <div
        data-btw-side-panel-header=""
        className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3"
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <MessageCircleDashed
            className={cn('h-3.5 w-3.5 shrink-0', BTW_ACCENT_TEXT_CLASS)}
            aria-hidden="true"
          />
          <span className="truncate font-mono text-xs font-medium tracking-tight text-foreground/85">
            /btw
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <BtwSidePanelClearButton sessionId={sessionId} canClear={canClear} onClear={onClear} />
          <Tooltip.Root>
            <Tooltip.Trigger
              render={
                <button
                  type="button"
                  data-btw-close=""
                  aria-label="收起 /btw"
                  onClick={onClose}
                  className={HEADER_ICON_BUTTON_CLASS}
                >
                  <X className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                </button>
              }
            />
            <Tooltip.Content side="bottom">收起 /btw (Esc)</Tooltip.Content>
          </Tooltip.Root>
        </div>
      </div>

      <BtwStreamView
        variant="side-panel"
        turns={turns}
        streamingText={streamingText}
        isStreaming={isStreaming}
        readOnlyTools={readOnlyTools}
        error={error}
        conversationFontSize={conversationFontSize}
        onToggleReadOnlyTools={onToggleReadOnlyTools}
      />

      <BtwSidePanelComposer
        sessionId={sessionId}
        isDark={isDark}
        isVisible={isVisible}
        isArchived={isArchived}
        isMachineRemoved={isMachineRemoved}
        isStreaming={isStreaming}
        modelLabel={modelLabel}
        articleFileName={articleFileName}
        pendingSelection={pendingSelection}
        composerRef={composerRef}
        onComposerFocusChange={onComposerFocusChange}
        onClearPendingSelection={onClearPendingSelection}
        onSend={onSend}
        onCancel={onCancel}
      />
    </aside>
  );
}
