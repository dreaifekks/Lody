import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePopupContainer } from '@lody/ui/popup-container';
import { cn } from '@/lib/utils';
import {
  flattenWorktreeReviewTree,
  type WorktreeReviewFileTreeModel,
  type WorktreeReviewTreeSymbol,
} from './worktree-review-tree-model';

export const TREE_TOOLTIP_DELAY_MS = 150;

const TOOLTIP_MARGIN = 8;
const TOOLTIP_GAP = 8;
const FALLBACK_TOOLTIP_WIDTH = 280;
const FALLBACK_TOOLTIP_HEIGHT = 28;

export interface TreeTooltipBounds {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface TreeTooltipAnchorRect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export interface TreeTooltipCoords {
  readonly left: number;
  readonly top: number;
  readonly placement: 'right' | 'top' | 'bottom';
}

/**
 * Positions the file-tree Portal tooltip to the right of the hovered row by
 * default, falling back above or below when horizontal space is insufficient
 * and clamping strictly within `bounds`.
 */
export function computeTreeTooltipCoords(params: {
  readonly anchorRect: TreeTooltipAnchorRect;
  readonly bounds: TreeTooltipBounds;
  readonly tooltipWidth: number;
  readonly tooltipHeight: number;
}): TreeTooltipCoords {
  const { anchorRect, bounds, tooltipWidth, tooltipHeight } = params;
  const relLeft = anchorRect.left - bounds.left;
  const relRight = anchorRect.right - bounds.left;
  const relTop = anchorRect.top - bounds.top;
  const relBottom = anchorRect.bottom - bounds.top;

  const rightLeft = relRight + TOOLTIP_GAP;
  if (rightLeft + tooltipWidth + TOOLTIP_MARGIN <= bounds.width) {
    const centeredTop = relTop + (anchorRect.height - tooltipHeight) / 2;
    const maxTop = Math.max(TOOLTIP_MARGIN, bounds.height - tooltipHeight - TOOLTIP_MARGIN);
    return {
      left: Math.max(TOOLTIP_MARGIN, rightLeft),
      top: Math.max(TOOLTIP_MARGIN, Math.min(centeredTop, maxTop)),
      placement: 'right',
    };
  }

  const maxLeft = Math.max(TOOLTIP_MARGIN, bounds.width - tooltipWidth - TOOLTIP_MARGIN);
  const clampedLeft = Math.max(TOOLTIP_MARGIN, Math.min(relLeft, maxLeft));

  const aboveTop = relTop - tooltipHeight - TOOLTIP_GAP;
  if (aboveTop >= TOOLTIP_MARGIN) {
    return {
      left: clampedLeft,
      top: aboveTop,
      placement: 'top',
    };
  }

  const belowTop = relBottom + TOOLTIP_GAP;
  const maxTop = Math.max(TOOLTIP_MARGIN, bounds.height - tooltipHeight - TOOLTIP_MARGIN);
  return {
    left: clampedLeft,
    top: Math.max(TOOLTIP_MARGIN, Math.min(belowTop, maxTop)),
    placement: 'bottom',
  };
}

interface ActiveTreeTooltip {
  readonly rowKey: string;
  readonly text: string;
  readonly anchorRect: TreeTooltipAnchorRect;
}

export interface WorktreeReviewFileTreeProps {
  readonly tree: WorktreeReviewFileTreeModel;
  readonly activeFilePath: string | null;
  readonly activeSymbolId: string | null;
  /** Whether `codeNav` is available so the `ƒ 符号` toggle is meaningful. */
  readonly symbolsAvailable: boolean;
  readonly showSymbols: boolean;
  readonly onToggleShowSymbols: () => void;
  readonly onSelectFile: (filePath: string) => void;
  readonly onSelectSymbol: (filePath: string, symbol: WorktreeReviewTreeSymbol) => void;
  /** Optional Storybook/test preset to open a row tooltip on mount (dismisses on real interaction). */
  readonly initialTooltipRowKey?: string | null;
  readonly className?: string;
}

function measureBounds(portalTarget: HTMLElement, isContained: boolean): TreeTooltipBounds {
  if (isContained) {
    const rect = portalTarget.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width > 0 ? rect.width : typeof window !== 'undefined' ? window.innerWidth : 1280,
      height:
        rect.height > 0 ? rect.height : typeof window !== 'undefined' ? window.innerHeight : 800,
    };
  }
  return {
    left: 0,
    top: 0,
    width: typeof window !== 'undefined' ? window.innerWidth : 1280,
    height: typeof window !== 'undefined' ? window.innerHeight : 800,
  };
}

function toAnchorRect(el: HTMLElement): TreeTooltipAnchorRect {
  const rect = el.getBoundingClientRect();
  return {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

export function WorktreeReviewFileTree({
  tree,
  activeFilePath,
  activeSymbolId,
  symbolsAvailable,
  showSymbols,
  onToggleShowSymbols,
  onSelectFile,
  onSelectSymbol,
  initialTooltipRowKey = null,
  className,
}: WorktreeReviewFileTreeProps) {
  const popupContainer = usePopupContainer();
  const [collapsedDirs, setCollapsedDirs] = useState<ReadonlySet<string>>(() => new Set());
  const [tooltip, setTooltip] = useState<ActiveTreeTooltip | null>(null);
  const [tooltipCoords, setTooltipCoords] = useState<TreeTooltipCoords | null>(null);

  const listRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingHoverRowKeyRef = useRef<string | null>(null);
  const suppressFocusTooltipRef = useRef(false);
  const appliedInitialTooltipRef = useRef<string | null>(null);

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    pendingHoverRowKeyRef.current = null;
  }, []);

  const hideTooltip = useCallback(() => {
    clearHoverTimer();
    setTooltip(null);
  }, [clearHoverTimer]);

  useEffect(() => {
    return () => {
      clearHoverTimer();
    };
  }, [clearHoverTimer]);

  useEffect(() => {
    if (!tooltip) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        hideTooltip();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [hideTooltip, tooltip]);

  const toggleDir = (dirPath: string) => {
    handleRowClickCleanup();
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  };

  const rows = useMemo(
    () =>
      flattenWorktreeReviewTree(tree, {
        collapsedDirs,
        showSymbols: symbolsAvailable && showSymbols,
      }),
    [collapsedDirs, showSymbols, symbolsAvailable, tree]
  );

  // Clear active or pending tooltip immediately when its row disappears after a tree refresh.
  useEffect(() => {
    const activeRowKey = tooltip?.rowKey ?? null;
    const pendingRowKey = pendingHoverRowKeyRef.current;
    if (activeRowKey === null && pendingRowKey === null) return;
    const rowKeys = new Set(rows.map((row) => row.key));
    if (activeRowKey !== null && !rowKeys.has(activeRowKey)) {
      hideTooltip();
      return;
    }
    if (pendingRowKey !== null && !rowKeys.has(pendingRowKey)) {
      clearHoverTimer();
    }
  }, [clearHoverTimer, hideTooltip, rows, tooltip]);

  // Support deterministic initial tooltip display for visual stories when requested.
  useLayoutEffect(() => {
    if (!initialTooltipRowKey || appliedInitialTooltipRef.current === initialTooltipRowKey) {
      return;
    }
    const listEl = listRef.current;
    if (!listEl) return;
    const row = rows.find((item) => item.key === initialTooltipRowKey);
    if (!row) return;
    const buttonEl = Array.from(listEl.querySelectorAll<HTMLElement>('[data-tree-row-key]')).find(
      (node) => node.getAttribute('data-tree-row-key') === initialTooltipRowKey
    );
    if (!buttonEl) return;
    appliedInitialTooltipRef.current = initialTooltipRowKey;
    const text =
      row.kind === 'dir' ? row.path : row.kind === 'file' ? row.file.path : row.symbol.displayName;
    setTooltip({
      rowKey: row.key,
      text,
      anchorRect: toAnchorRect(buttonEl),
    });
  }, [initialTooltipRowKey, rows]);

  const shouldOpenTooltipForRow = useCallback(
    (rowKind: 'dir' | 'file' | 'symbol', buttonEl: HTMLElement): boolean => {
      if (rowKind === 'dir' || rowKind === 'file') return true;
      const labelEl = buttonEl.querySelector<HTMLElement>('[data-tree-label]');
      if (!labelEl) return false;
      return labelEl.scrollWidth > labelEl.clientWidth;
    },
    []
  );

  const handleRowMouseEnter = useCallback(
    (
      rowKey: string,
      rowKind: 'dir' | 'file' | 'symbol',
      fullText: string,
      buttonEl: HTMLElement
    ) => {
      clearHoverTimer();
      if (!shouldOpenTooltipForRow(rowKind, buttonEl)) {
        setTooltip(null);
        return;
      }
      pendingHoverRowKeyRef.current = rowKey;
      hoverTimerRef.current = setTimeout(() => {
        hoverTimerRef.current = null;
        pendingHoverRowKeyRef.current = null;
        if (!buttonEl.isConnected) return;
        setTooltip({
          rowKey,
          text: fullText,
          anchorRect: toAnchorRect(buttonEl),
        });
      }, TREE_TOOLTIP_DELAY_MS);
    },
    [clearHoverTimer, shouldOpenTooltipForRow]
  );

  const handleRowFocus = useCallback(
    (
      rowKey: string,
      rowKind: 'dir' | 'file' | 'symbol',
      fullText: string,
      buttonEl: HTMLElement
    ) => {
      if (suppressFocusTooltipRef.current) {
        suppressFocusTooltipRef.current = false;
        return;
      }
      clearHoverTimer();
      if (!shouldOpenTooltipForRow(rowKind, buttonEl)) {
        setTooltip(null);
        return;
      }
      setTooltip({
        rowKey,
        text: fullText,
        anchorRect: toAnchorRect(buttonEl),
      });
    },
    [clearHoverTimer, shouldOpenTooltipForRow]
  );

  const handleRowPointerDown = useCallback(() => {
    suppressFocusTooltipRef.current = true;
    hideTooltip();
  }, [hideTooltip]);

  const handleRowClickCleanup = useCallback(() => {
    suppressFocusTooltipRef.current = false;
    hideTooltip();
  }, [hideTooltip]);

  const portalTarget =
    typeof document === 'undefined'
      ? null
      : popupContainer instanceof HTMLElement
        ? popupContainer
        : document.body;
  const isContained =
    portalTarget !== null &&
    typeof document !== 'undefined' &&
    portalTarget !== document.body &&
    portalTarget !== document.documentElement;

  useLayoutEffect(() => {
    if (!tooltip || !portalTarget) {
      setTooltipCoords(null);
      return undefined;
    }

    const recalculate = () => {
      const bounds = measureBounds(portalTarget, isContained);
      const tooltipWidth = tooltipRef.current?.offsetWidth || FALLBACK_TOOLTIP_WIDTH;
      const tooltipHeight = tooltipRef.current?.offsetHeight || FALLBACK_TOOLTIP_HEIGHT;
      setTooltipCoords(
        computeTreeTooltipCoords({
          anchorRect: tooltip.anchorRect,
          bounds,
          tooltipWidth,
          tooltipHeight,
        })
      );
    };

    recalculate();
    if (typeof window === 'undefined') return undefined;
    window.addEventListener('resize', recalculate);
    return () => {
      window.removeEventListener('resize', recalculate);
    };
  }, [isContained, portalTarget, tooltip]);

  const resolvedTooltipCoords = useMemo(() => {
    if (tooltipCoords) return tooltipCoords;
    if (!tooltip || !portalTarget) return null;
    return computeTreeTooltipCoords({
      anchorRect: tooltip.anchorRect,
      bounds: measureBounds(portalTarget, isContained),
      tooltipWidth: FALLBACK_TOOLTIP_WIDTH,
      tooltipHeight: FALLBACK_TOOLTIP_HEIGHT,
    });
  }, [isContained, portalTarget, tooltip, tooltipCoords]);

  const tooltipPortal =
    tooltip && portalTarget && resolvedTooltipCoords
      ? createPortal(
          <div
            ref={tooltipRef}
            role="tooltip"
            data-worktree-review-tree-tooltip=""
            data-tooltip-placement={resolvedTooltipCoords.placement}
            style={{
              left: `${resolvedTooltipCoords.left}px`,
              top: `${resolvedTooltipCoords.top}px`,
            }}
            className={cn(
              isContained ? 'absolute' : 'fixed',
              'pointer-events-none z-[80] w-max max-w-[min(540px,calc(100%-24px))] whitespace-pre-wrap break-all rounded-[7px] border border-border bg-[hsl(var(--popover))] px-2 py-1 font-mono text-[11.5px] leading-snug text-popover-foreground',
              'shadow-[0_8px_20px_-6px_rgba(0,0,0,0.20),0_0_0_1px_rgba(0,0,0,0.05)] dark:shadow-[0_10px_24px_-6px_rgba(0,0,0,0.55),0_0_0_1px_rgba(255,255,255,0.08)]'
            )}
          >
            {tooltip.text}
          </div>,
          portalTarget
        )
      : null;

  return (
    <aside
      data-worktree-review-tree=""
      className={cn(
        'flex min-h-0 flex-col border-r border-border bg-[hsl(var(--sidebar-background))] select-none',
        className
      )}
    >
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-foreground/[0.07] px-2.5 text-[11.5px] text-muted-foreground">
        <div className="flex min-w-0 items-center gap-1.5 tabular-nums">
          <span>
            {tree.fileCount} {tree.fileCount === 1 ? 'file' : 'files'}
          </span>
          {(tree.totalAdditions > 0 || tree.totalDeletions > 0) && (
            <span className="inline-flex items-center gap-1 font-mono text-[11px]">
              <span className="text-[hsl(var(--github-addition))]">+{tree.totalAdditions}</span>
              <span className="text-[hsl(var(--github-deletion))]">-{tree.totalDeletions}</span>
            </span>
          )}
        </div>
        {symbolsAvailable ? (
          <button
            type="button"
            data-worktree-review-symbol-toggle=""
            aria-pressed={showSymbols}
            onClick={() => {
              hideTooltip();
              onToggleShowSymbols();
            }}
            className={cn(
              'rounded-[5px] px-1.5 py-0.5 text-[11px] transition-colors cursor-pointer',
              showSymbols
                ? 'bg-background font-medium text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
                : 'text-muted-foreground hover:bg-[hsl(var(--sidebar-hover))] hover:text-foreground'
            )}
          >
            ƒ 符号
          </button>
        ) : null}
      </div>

      <div
        ref={listRef}
        onScroll={hideTooltip}
        className="scrollbar-pro min-h-0 flex-1 overflow-y-auto p-1.5"
      >
        {rows.length === 0 ? (
          <div className="px-2 py-4 text-center text-xs text-muted-foreground">—</div>
        ) : (
          rows.map((row) => {
            if (row.kind === 'dir') {
              return (
                <button
                  key={row.key}
                  type="button"
                  data-tree-row-key={row.key}
                  data-tree-dir={row.path}
                  aria-expanded={!row.collapsed}
                  onPointerDown={handleRowPointerDown}
                  onClick={() => toggleDir(row.path)}
                  onMouseEnter={(event) =>
                    handleRowMouseEnter(row.key, 'dir', row.path, event.currentTarget)
                  }
                  onMouseLeave={hideTooltip}
                  onFocus={(event) => handleRowFocus(row.key, 'dir', row.path, event.currentTarget)}
                  onBlur={hideTooltip}
                  style={{ paddingLeft: `${7 + row.depth * 11}px` }}
                  className="flex h-[26px] w-full items-center gap-1.5 rounded-[6px] pr-2 text-left text-[11.8px] text-muted-foreground transition-colors hover:bg-[hsl(var(--sidebar-hover))] hover:text-foreground cursor-pointer"
                >
                  <span
                    className="w-3 shrink-0 text-center text-[10px] opacity-70"
                    aria-hidden="true"
                  >
                    {row.collapsed ? '▸' : '▾'}
                  </span>
                  <span data-tree-label="" className="min-w-0 truncate font-mono" title={row.path}>
                    {row.name}
                  </span>
                </button>
              );
            }

            if (row.kind === 'file') {
              const isActive = activeFilePath === row.file.path && activeSymbolId === null;
              return (
                <button
                  key={row.key}
                  type="button"
                  data-tree-row-key={row.key}
                  data-tree-file={row.file.path}
                  data-active={isActive ? '' : undefined}
                  onPointerDown={handleRowPointerDown}
                  onClick={() => {
                    handleRowClickCleanup();
                    onSelectFile(row.file.path);
                  }}
                  onMouseEnter={(event) =>
                    handleRowMouseEnter(row.key, 'file', row.file.path, event.currentTarget)
                  }
                  onMouseLeave={hideTooltip}
                  onFocus={(event) =>
                    handleRowFocus(row.key, 'file', row.file.path, event.currentTarget)
                  }
                  onBlur={hideTooltip}
                  style={{ paddingLeft: `${7 + row.depth * 11}px` }}
                  className={cn(
                    'flex h-[26px] w-full items-center justify-between gap-1.5 rounded-[6px] pr-2 text-left text-[12px] transition-colors cursor-pointer',
                    isActive
                      ? 'bg-[hsl(var(--sidebar-selection))] font-medium text-foreground'
                      : 'text-foreground/80 hover:bg-[hsl(var(--sidebar-hover))] hover:text-foreground'
                  )}
                >
                  <span
                    data-tree-label=""
                    className="min-w-0 truncate font-mono"
                    title={row.file.path}
                  >
                    {row.file.name}
                  </span>
                  {(row.file.additions > 0 || row.file.deletions > 0) && (
                    <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[10.8px] tabular-nums">
                      {row.file.additions > 0 && (
                        <span className="text-[hsl(var(--github-addition))]">
                          +{row.file.additions}
                        </span>
                      )}
                      {row.file.deletions > 0 && (
                        <span className="text-[hsl(var(--github-deletion))]">
                          -{row.file.deletions}
                        </span>
                      )}
                    </span>
                  )}
                </button>
              );
            }

            const isSymActive = activeSymbolId === row.symbol.id;
            return (
              <button
                key={row.key}
                type="button"
                data-tree-row-key={row.key}
                data-tree-symbol={row.symbol.displayName}
                data-active={isSymActive ? '' : undefined}
                onPointerDown={handleRowPointerDown}
                onClick={() => {
                  handleRowClickCleanup();
                  onSelectSymbol(row.filePath, row.symbol);
                }}
                onMouseEnter={(event) =>
                  handleRowMouseEnter(
                    row.key,
                    'symbol',
                    row.symbol.displayName,
                    event.currentTarget
                  )
                }
                onMouseLeave={hideTooltip}
                onFocus={(event) =>
                  handleRowFocus(row.key, 'symbol', row.symbol.displayName, event.currentTarget)
                }
                onBlur={hideTooltip}
                style={{ paddingLeft: `${10 + row.depth * 11}px` }}
                className={cn(
                  'flex h-[23px] w-full items-center gap-1.5 rounded-[6px] pr-2 text-left text-[11.5px] transition-colors cursor-pointer',
                  isSymActive
                    ? 'bg-[color-mix(in_oklab,hsl(var(--primary))_13%,transparent)] font-medium text-[hsl(var(--primary))]'
                    : 'text-muted-foreground hover:bg-[hsl(var(--sidebar-hover))] hover:text-foreground'
                )}
              >
                <span
                  className="w-3 shrink-0 text-center text-[11px] text-[hsl(var(--primary))] opacity-85"
                  aria-hidden="true"
                >
                  ƒ
                </span>
                <span
                  data-tree-label=""
                  className="min-w-0 truncate font-mono"
                  title={row.symbol.displayName}
                >
                  {row.symbol.displayName}
                </span>
              </button>
            );
          })
        )}
      </div>

      {tooltipPortal}
    </aside>
  );
}
