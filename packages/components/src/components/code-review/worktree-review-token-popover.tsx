import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CodeNavConfidence, CodeNavLocation } from '@lody/shared';
import { usePopupContainer } from '@lody/ui/popup-container';
import { cn } from '@/lib/utils';
import { formatCodeNavSymbolDisplayName } from './worktree-review-tree-model';

export interface WorktreeReviewTokenPopoverAnchor {
  readonly left: number;
  readonly top: number;
  readonly bottom: number;
}

export type WorktreeReviewTokenPopoverState =
  | {
      readonly mode: 'actions';
      readonly symbol: string;
      readonly filePath: string;
      readonly line: number;
      readonly character: number;
      readonly anchor: WorktreeReviewTokenPopoverAnchor;
      readonly definitionPreview?: {
        readonly targetLabel: string;
        readonly location: CodeNavLocation;
      } | null;
      readonly definitionCount?: number;
      readonly callersCount?: number;
      readonly loadingAction?: 'definition' | 'callers' | null;
      readonly emptyNotice?: 'definition' | 'callers' | null;
    }
  | {
      readonly mode: 'candidates';
      readonly symbol: string;
      readonly filePath: string;
      readonly line: number;
      readonly character: number;
      readonly anchor: WorktreeReviewTokenPopoverAnchor;
      readonly items: readonly CodeNavLocation[];
      readonly confidence: CodeNavConfidence;
      readonly totalCandidates: number;
    };

export interface WorktreeReviewTokenPopoverProps {
  readonly state: WorktreeReviewTokenPopoverState | null;
  readonly canOpenInIde: boolean;
  readonly onClose: () => void;
  readonly onGoToDefinition: () => void;
  readonly onFindCallers: () => void;
  readonly onSelectCandidate: (location: CodeNavLocation) => void;
  readonly onOpenInIde: (filePath: string, line: number, column?: number) => void;
}

const POPOVER_WIDTH = 304;
const POPOVER_MARGIN = 12;

function getBasename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

export function WorktreeReviewTokenPopover({
  state,
  canOpenInIde,
  onClose,
  onGoToDefinition,
  onFindCallers,
  onSelectCandidate,
  onOpenInIde,
}: WorktreeReviewTokenPopoverProps) {
  const popupContainer = usePopupContainer();
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!state || typeof window === 'undefined') {
      setCoords(null);
      return;
    }
    const height = popoverRef.current?.offsetHeight ?? 210;
    const maxLeft = Math.max(POPOVER_MARGIN, window.innerWidth - POPOVER_WIDTH - POPOVER_MARGIN);
    const left = Math.max(POPOVER_MARGIN, Math.min(state.anchor.left, maxLeft));
    const preferredTop = state.anchor.bottom + 6;
    const top =
      preferredTop + height + POPOVER_MARGIN > window.innerHeight
        ? Math.max(POPOVER_MARGIN, state.anchor.top - height - 6)
        : preferredTop;
    setCoords({ left, top });
  }, [state]);

  useEffect(() => {
    if (!state) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const el = popoverRef.current;
      if (el && event.target instanceof Node && !el.contains(event.target)) {
        onClose();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [onClose, state]);

  if (!state || typeof document === 'undefined') return null;

  const portalTarget = popupContainer instanceof HTMLElement ? popupContainer : document.body;

  const positionStyle = coords
    ? { left: `${coords.left}px`, top: `${coords.top}px` }
    : {
        left: `${Math.max(POPOVER_MARGIN, state.anchor.left)}px`,
        top: `${state.anchor.bottom + 6}px`,
      };

  const content = (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={state.symbol}
      data-worktree-review-popover={state.mode}
      style={{ ...positionStyle, width: `${POPOVER_WIDTH}px` }}
      className={cn(
        'fixed z-[70] overflow-hidden rounded-[10px] border border-border bg-[hsl(var(--popover))] text-popover-foreground',
        'shadow-[0_12px_28px_-8px_rgba(0,0,0,0.22),0_0_0_1px_rgba(0,0,0,0.06)] dark:shadow-[0_14px_32px_-8px_rgba(0,0,0,0.60),0_0_0_1px_rgba(255,255,255,0.08)]'
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-foreground/[0.07] px-2.5 py-[7px]">
        <span className="min-w-0 truncate font-mono text-[12.2px] font-semibold text-foreground">
          {state.symbol}
        </span>
        {state.mode === 'candidates' ? (
          <span
            data-worktree-review-candidate-badge=""
            className="shrink-0 rounded-full bg-[color-mix(in_oklab,hsl(var(--status-warning))_14%,transparent)] px-1.5 py-0.5 text-[10.5px] font-medium tabular-nums text-[hsl(var(--status-warning))]"
          >
            候选 · {state.totalCandidates}
          </span>
        ) : null}
      </div>

      <div className="flex max-h-[260px] flex-col gap-0.5 overflow-y-auto p-1.5">
        {state.mode === 'actions' ? (
          <>
            <button
              type="button"
              data-popover-action="definition"
              disabled={state.loadingAction === 'definition'}
              onClick={onGoToDefinition}
              className="flex w-full items-center justify-between gap-2 rounded-[7px] px-2 py-1.5 text-left text-[12px] text-foreground transition-colors hover:bg-[hsl(var(--hover))] disabled:opacity-60 cursor-pointer"
            >
              <span>跳定义</span>
              <span className="max-w-[175px] truncate font-mono text-[11px] text-muted-foreground">
                {state.loadingAction === 'definition'
                  ? '…'
                  : state.emptyNotice === 'definition'
                    ? '未找到'
                    : state.definitionPreview
                      ? state.definitionPreview.targetLabel
                      : state.definitionCount !== undefined && state.definitionCount > 1
                        ? `${state.definitionCount}`
                        : ''}
              </span>
            </button>
            <button
              type="button"
              data-popover-action="callers"
              disabled={state.loadingAction === 'callers'}
              onClick={onFindCallers}
              className="flex w-full items-center justify-between gap-2 rounded-[7px] px-2 py-1.5 text-left text-[12px] text-foreground transition-colors hover:bg-[hsl(var(--hover))] disabled:opacity-60 cursor-pointer"
            >
              <span>调用方</span>
              <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                {state.loadingAction === 'callers'
                  ? '…'
                  : state.emptyNotice === 'callers'
                    ? '0'
                    : state.callersCount !== undefined
                      ? `${state.callersCount}`
                      : ''}
              </span>
            </button>
          </>
        ) : state.items.length === 0 ? (
          <div className="px-2 py-1.5 text-[12px] text-muted-foreground">未找到定义</div>
        ) : (
          state.items.slice(0, 12).map((item, idx) => {
            const symLabel = formatCodeNavSymbolDisplayName(item);
            const fileLabel = getBasename(item.path);
            const primaryLabel = item.containerName ? symLabel : fileLabel;
            return (
              <button
                key={`${item.path}:${item.line}:${item.character}:${idx}`}
                type="button"
                data-popover-candidate={`${item.path}:${item.line}`}
                title={`${item.path}:${item.line}`}
                onClick={() => onSelectCandidate(item)}
                className="flex w-full items-center justify-between gap-2 rounded-[7px] px-2 py-1.5 text-left text-[12px] text-foreground transition-colors hover:bg-[hsl(var(--hover))] cursor-pointer"
              >
                <span className="min-w-0 truncate font-mono">{primaryLabel}</span>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
                  :{item.line}
                </span>
              </button>
            );
          })
        )}

        {canOpenInIde ? (
          <>
            <div className="my-1 h-px bg-foreground/[0.07]" />
            <button
              type="button"
              data-popover-action="open-in-ide"
              onClick={() => {
                onClose();
                onOpenInIde(state.filePath, state.line, state.character + 1);
              }}
              className="flex w-full items-center justify-between gap-2 rounded-[7px] px-2 py-1.5 text-left text-[12px] text-foreground transition-colors hover:bg-[hsl(var(--hover))] cursor-pointer"
            >
              <span>↗ IDE 打开此行</span>
              <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                :{state.line}
              </span>
            </button>
          </>
        ) : null}
      </div>
    </div>
  );

  return createPortal(content, portalTarget);
}
