import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CodeNavDiffOutlineFile, CodeNavSymbol } from '@lody/shared';
import type { DiffLineAnnotation, DiffTokenEventBaseProps, FileDiffMetadata } from '@pierre/diffs';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { DiffViewer, type DiffViewerFileDiffInstance } from '@/ui/diff-viewer/diff-viewer';
import { Skeleton } from '@lody/ui/skeleton';
import { cn } from '@/lib/utils';
import type { FileDiffData } from '../sessions/session-conversation-diff-types';
import {
  buildFoldedLinesUnsafeCSS,
  collectDiffChangedNewLines,
  findFoldableBlocksInRange,
  formatFoldBlockLabel,
  splitSourceLines,
  type FoldableCodeBlock,
} from './worktree-review-code-folding';
import { extractFileDiffHunkMarks, type MinimapDiffHunkMark } from './worktree-review-minimap';
import {
  computeEnclosingExpandPlan,
  matchOutlineHunk,
  type EnclosingExpandPlan,
} from './worktree-review-nav-model';
import { formatCodeNavSymbolDisplayName } from './worktree-review-tree-model';

const EMPTY_ANNOTATIONS: DiffLineAnnotation<unknown>[] = [];

export const REVIEW_INTERACTIVE_TOKEN_UNSAFE_CSS = `
[data-line]:not([data-line-type="change-deletion"]) span[data-char] {
  cursor: pointer;
  border-radius: 2px;
}
[data-line]:not([data-line-type="change-deletion"]) span[data-char]:hover {
  background: color-mix(in oklab, hsl(var(--primary)) 16%, transparent);
  text-decoration: underline;
  text-decoration-style: dotted;
  text-underline-offset: 2px;
}
`;

/**
 * Reserves a dedicated 20px left utility lane inside `@pierre/diffs`'s
 * `[data-column-number]` cell (between the 4px change bar and right-aligned
 * line number text) and raises `[data-gutter-utility-slot]` above
 * `[data-line-number-content]` (`z-index: 1`) so line-level `↗ IDE` buttons
 * never overlap line numbers and always win pointer hit-testing.
 */
export const REVIEW_GUTTER_IDE_UNSAFE_CSS = `
[data-column-number] {
  padding-left: 28px !important;
}
[data-gutter-utility-slot] {
  left: 6px !important;
  right: auto !important;
  width: 20px !important;
  z-index: 5 !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  pointer-events: auto !important;
}
[data-gutter-utility-slot] ::slotted(*) {
  position: static !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  pointer-events: auto !important;
}
[data-column-number][data-line-type="change-deletion"] [data-gutter-utility-slot] {
  display: none !important;
}
`;

export interface WorktreeReviewDiffTokenClick {
  readonly filePath: string;
  readonly token: DiffTokenEventBaseProps;
  readonly event: MouseEvent;
}

export interface WorktreeReviewResolvedFileStats {
  readonly additions: number;
  readonly deletions: number;
  readonly firstLine: number;
  readonly hunkMarks?: readonly MinimapDiffHunkMark[];
}

interface HunkAnnotationMeta {
  readonly hunkIndex: number;
  readonly enclosing: CodeNavSymbol;
  readonly lineNumber: number;
}

type ReviewDiffAnnotationItem =
  | {
      readonly kind: 'hunk';
      readonly meta: HunkAnnotationMeta;
    }
  | {
      readonly kind: 'fold';
      readonly block: FoldableCodeBlock;
      readonly collapsed: boolean;
    };

interface ReviewDiffLineAnnotationMeta {
  readonly items: readonly ReviewDiffAnnotationItem[];
}

interface ExpandedFunctionEntry {
  readonly plan: EnclosingExpandPlan;
  readonly enclosing: CodeNavSymbol;
  readonly foldableBlocks: readonly FoldableCodeBlock[];
}

function splitPathParts(filePath: string): { dir: string; name: string } {
  const normalized = filePath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  if (idx === -1) return { dir: '', name: normalized };
  return { dir: normalized.slice(0, idx + 1), name: normalized.slice(idx + 1) };
}

function computeFileDiffStats(data: FileDiffData | undefined): {
  additions: number;
  deletions: number;
  firstLine: number;
} {
  if (!data) return { additions: 0, deletions: 0, firstLine: 1 };
  if (data.status === 'ready-parsed') {
    let additions = 0;
    let deletions = 0;
    for (const hunk of data.fileDiff.hunks) {
      additions += hunk.additionLines;
      deletions += hunk.deletionLines;
    }
    const firstLine = data.fileDiff.hunks[0]?.additionStart ?? 1;
    return { additions, deletions, firstLine: Math.max(1, firstLine) };
  }
  return { additions: 0, deletions: 0, firstLine: 1 };
}

interface ReviewDiffFileCardProps {
  readonly filePath: string;
  readonly data: FileDiffData | undefined;
  readonly outlineFile: CodeNavDiffOutlineFile | undefined;
  readonly additionsOverride?: number;
  readonly deletionsOverride?: number;
  readonly renderContent: boolean;
  readonly open: boolean;
  readonly diffStyle: 'unified' | 'split';
  readonly initialExpandPrimary?: boolean;
  readonly onOpenChange: (filePath: string, nextOpen: boolean) => void;
  readonly codeNavSupported: boolean;
  readonly canOpenInIde: boolean;
  readonly onTokenClick: (payload: WorktreeReviewDiffTokenClick) => void;
  readonly onOpenInIde: (filePath: string, line?: number) => void;
  readonly onCardRef: (filePath: string, node: HTMLElement | null) => void;
  readonly onStatsResolved?: (filePath: string, stats: WorktreeReviewResolvedFileStats) => void;
  readonly onLayoutChange?: () => void;
}

function getEnclosingFunctionKey(
  enclosing: Pick<CodeNavSymbol, 'name' | 'startLine' | 'endLine'>
): string {
  return `${enclosing.startLine}:${enclosing.endLine}:${enclosing.name}`;
}

const ReviewDiffFileCard = memo(function ReviewDiffFileCard({
  filePath,
  data,
  outlineFile,
  additionsOverride,
  deletionsOverride,
  renderContent,
  open,
  diffStyle,
  initialExpandPrimary = false,
  onOpenChange,
  codeNavSupported,
  canOpenInIde,
  onTokenClick,
  onOpenInIde,
  onCardRef,
  onStatsResolved,
  onLayoutChange,
}: ReviewDiffFileCardProps) {
  const instanceRef = useRef<DiffViewerFileDiffInstance | null>(null);
  const [hasInstance, setHasInstance] = useState(false);
  const autoExpandedRef = useRef(false);
  const expandingFnsRef = useRef(new Set<string>());
  const [renderedMeta, setRenderedMeta] = useState<FileDiffMetadata | null>(
    data?.status === 'ready-parsed' ? data.fileDiff : null
  );
  // Maps enclosing function key -> applied expand plan + detected foldable blocks
  // so multi-hunk functions stay synchronized and collapse restores every gap cleanly.
  const [expandedFunctions, setExpandedFunctions] = useState<
    ReadonlyMap<string, ExpandedFunctionEntry>
  >(() => new Map());
  // Folded block IDs explicitly unfolded by the user; freshly expanded functions
  // default to having all qualifying unchanged `{ ... }` / `[ ... ]` blocks folded.
  const [unfoldedBlockIds, setUnfoldedBlockIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    autoExpandedRef.current = false;
    expandingFnsRef.current.clear();
    setExpandedFunctions(new Map());
    setUnfoldedBlockIds(new Set());
    if (data?.status === 'ready-parsed') {
      setRenderedMeta(data.fileDiff);
    } else {
      setRenderedMeta(null);
    }
  }, [data]);

  const handleDiffInstanceReady = useCallback(
    (instance: DiffViewerFileDiffInstance | null) => {
      instanceRef.current = instance;
      setHasInstance(instance !== null);
      const meta = instance?.fileDiff ?? null;
      if (meta) {
        setRenderedMeta((prev) => (prev === meta ? prev : meta));
        let additions = 0;
        let deletions = 0;
        for (const hunk of meta.hunks) {
          additions += hunk.additionLines;
          deletions += hunk.deletionLines;
        }
        onStatsResolved?.(filePath, {
          additions,
          deletions,
          firstLine: Math.max(1, meta.hunks[0]?.additionStart ?? 1),
          hunkMarks: extractFileDiffHunkMarks(meta),
        });
      }
    },
    [filePath, onStatsResolved]
  );

  const inlineLoadDiffFiles = useMemo(() => {
    if (data?.status !== 'ready') return undefined;
    const oldText = data.oldSnapshot.kind === 'text' ? data.oldSnapshot.text : '';
    const newText = data.newSnapshot.kind === 'text' ? data.newSnapshot.text : '';
    return async () => ({
      oldFile: { name: filePath, contents: oldText },
      newFile: { name: filePath, contents: newText },
    });
  }, [data, filePath]);

  const diffOptions = useMemo(() => {
    if (data?.status === 'ready-parsed' && data.loadDiffFiles) {
      return { loadDiffFiles: data.loadDiffFiles };
    }
    if (inlineLoadDiffFiles) {
      return { loadDiffFiles: inlineLoadDiffFiles };
    }
    return undefined;
  }, [data, inlineLoadDiffFiles]);

  const handleToggleExpandFunction = useCallback(
    async (hunkIndex: number, enclosing: CodeNavSymbol) => {
      const instance = instanceRef.current;
      const meta = instance?.fileDiff ?? renderedMeta;
      if (!instance || !meta) return;

      const fnKey = getEnclosingFunctionKey(enclosing);
      const applied = expandedFunctions.get(fnKey);
      if (applied) {
        for (const step of applied.plan.steps) {
          if (step.lines > 0) {
            instance.expandHunk(step.gapIndex, step.direction, -step.lines);
          }
        }
        setExpandedFunctions((prev) => {
          const next = new Map(prev);
          next.delete(fnKey);
          return next;
        });
        if (applied.foldableBlocks.length > 0) {
          setUnfoldedBlockIds((prev) => {
            if (prev.size === 0) return prev;
            const next = new Set(prev);
            for (const block of applied.foldableBlocks) {
              next.delete(block.id);
            }
            return next;
          });
        }
        onLayoutChange?.();
        return;
      }

      if (expandingFnsRef.current.has(fnKey)) return;
      expandingFnsRef.current.add(fnKey);
      try {
        // Hydrate partial diffs first so expandHunk reveals full function lines cleanly.
        if (meta.isPartial && diffOptions?.loadDiffFiles) {
          try {
            await instance.prepareForEditing();
          } catch {
            // Fall through; expandHunk still triggers hydration if available.
          }
        }
        if (instanceRef.current !== instance) return;

        const activeMeta = instance.fileDiff ?? meta;
        const plan = computeEnclosingExpandPlan(activeMeta, hunkIndex, enclosing);
        if (!plan) return;

        const sourceLines =
          !activeMeta.isPartial && activeMeta.additionLines.length > 0
            ? activeMeta.additionLines
            : data?.status === 'ready' && data.newSnapshot.kind === 'text'
              ? splitSourceLines(data.newSnapshot.text)
              : null;
        const changedLines = collectDiffChangedNewLines(activeMeta);
        const foldableBlocks = sourceLines
          ? findFoldableBlocksInRange(sourceLines, {
              startLine: enclosing.startLine,
              endLine: enclosing.endLine,
              changedLines,
            })
          : [];

        for (const step of plan.steps) {
          if (step.lines > 0) {
            instance.expandHunk(step.gapIndex, step.direction, step.lines);
          }
        }
        setExpandedFunctions((prev) => {
          const next = new Map(prev);
          next.set(fnKey, { plan, enclosing, foldableBlocks });
          return next;
        });
        if (foldableBlocks.length > 0) {
          setUnfoldedBlockIds((prev) => {
            if (prev.size === 0) return prev;
            const next = new Set(prev);
            for (const block of foldableBlocks) {
              next.delete(block.id);
            }
            return next;
          });
        }
        onLayoutChange?.();
      } finally {
        expandingFnsRef.current.delete(fnKey);
      }
    },
    [data, diffOptions?.loadDiffFiles, expandedFunctions, onLayoutChange, renderedMeta]
  );

  const handleToggleFoldBlock = useCallback(
    (blockId: string) => {
      setUnfoldedBlockIds((prev) => {
        const next = new Set(prev);
        if (next.has(blockId)) next.delete(blockId);
        else next.add(blockId);
        return next;
      });
      onLayoutChange?.();
    },
    [onLayoutChange]
  );

  const handleToggleAllFoldsForFunction = useCallback(
    (fnKey: string) => {
      const entry = expandedFunctions.get(fnKey);
      if (!entry || entry.foldableBlocks.length === 0) return;
      setUnfoldedBlockIds((prev) => {
        const anyCollapsed = entry.foldableBlocks.some((block) => !prev.has(block.id));
        const next = new Set(prev);
        for (const block of entry.foldableBlocks) {
          if (anyCollapsed) next.add(block.id);
          else next.delete(block.id);
        }
        return next;
      });
      onLayoutChange?.();
    },
    [expandedFunctions, onLayoutChange]
  );

  // Hunk 0 enclosing bar renders inside the sticky card header;
  // hunks 1..N render via DiffViewer lineAnnotations inside the diff.
  const primaryOutlineHunk = useMemo(() => {
    if (!outlineFile) return undefined;
    if (renderedMeta) {
      return matchOutlineHunk(renderedMeta, 0, outlineFile);
    }
    return outlineFile.hunks[0];
  }, [outlineFile, renderedMeta]);

  const primaryEnclosing = primaryOutlineHunk?.enclosing;

  useEffect(() => {
    if (!initialExpandPrimary || autoExpandedRef.current) return;
    if (!open || !renderedMeta || !primaryEnclosing || !hasInstance || !instanceRef.current) return;
    autoExpandedRef.current = true;
    void handleToggleExpandFunction(0, primaryEnclosing);
  }, [
    handleToggleExpandFunction,
    hasInstance,
    initialExpandPrimary,
    open,
    primaryEnclosing,
    renderedMeta,
  ]);

  const activeFoldBlocks = useMemo<readonly FoldableCodeBlock[]>(() => {
    if (diffStyle !== 'unified' || expandedFunctions.size === 0) return [];
    const seenIds = new Set<string>();
    const seenOpenLines = new Set<number>();
    const result: FoldableCodeBlock[] = [];
    for (const entry of expandedFunctions.values()) {
      for (const block of entry.foldableBlocks) {
        if (seenIds.has(block.id) || seenOpenLines.has(block.openLine)) continue;
        seenIds.add(block.id);
        seenOpenLines.add(block.openLine);
        result.push(block);
      }
    }
    result.sort((a, b) => a.openLine - b.openLine);
    return result;
  }, [diffStyle, expandedFunctions]);

  const collapsedFoldBlocks = useMemo(
    () => activeFoldBlocks.filter((block) => !unfoldedBlockIds.has(block.id)),
    [activeFoldBlocks, unfoldedBlockIds]
  );

  // Merge secondary hunk enclosing bars AND code-folding bars by lineNumber using a
  // discriminated union so `@pierre/diffs` never receives colliding annotation slots.
  const mergedAnnotations = useMemo<DiffLineAnnotation<unknown>[]>(() => {
    const byLine = new Map<number, ReviewDiffAnnotationItem[]>();
    const pushItem = (lineNumber: number, item: ReviewDiffAnnotationItem) => {
      const list = byLine.get(lineNumber) ?? [];
      list.push(item);
      byLine.set(lineNumber, list);
    };

    if (renderedMeta && outlineFile && renderedMeta.hunks.length > 1) {
      for (let hunkIndex = 1; hunkIndex < renderedMeta.hunks.length; hunkIndex += 1) {
        const hunk = renderedMeta.hunks[hunkIndex]!;
        const outlineHunk = matchOutlineHunk(renderedMeta, hunkIndex, outlineFile);
        if (!outlineHunk?.enclosing) continue;
        if (hunk.additionCount <= 0) continue;
        pushItem(hunk.additionStart, {
          kind: 'hunk',
          meta: {
            hunkIndex,
            enclosing: outlineHunk.enclosing,
            lineNumber: Math.max(1, outlineHunk.startLine || hunk.additionStart),
          },
        });
      }
    }

    if (diffStyle === 'unified') {
      for (const block of activeFoldBlocks) {
        pushItem(block.openLine, {
          kind: 'fold',
          block,
          collapsed: !unfoldedBlockIds.has(block.id),
        });
      }
    }

    if (byLine.size === 0) return EMPTY_ANNOTATIONS;

    const sortedLines = Array.from(byLine.keys()).sort((a, b) => a - b);
    const list: DiffLineAnnotation<ReviewDiffLineAnnotationMeta>[] = sortedLines.map(
      (lineNumber) => ({
        side: 'additions',
        lineNumber,
        metadata: {
          items: byLine.get(lineNumber)!,
        },
      })
    );
    return list as DiffLineAnnotation<unknown>[];
  }, [activeFoldBlocks, diffStyle, outlineFile, renderedMeta, unfoldedBlockIds]);

  const renderMergedAnnotation = useCallback(
    (annotation: DiffLineAnnotation<unknown>) => {
      const meta = annotation.metadata as ReviewDiffLineAnnotationMeta | undefined;
      if (!meta || meta.items.length === 0) return null;

      return (
        <div>
          {meta.items.map((item) => {
            if (item.kind === 'hunk') {
              const hunkMeta = item.meta;
              const fnKey = getEnclosingFunctionKey(hunkMeta.enclosing);
              const expandedEntry = expandedFunctions.get(fnKey);
              const isExpanded = expandedEntry !== undefined;
              const foldableCount =
                diffStyle === 'unified' ? (expandedEntry?.foldableBlocks.length ?? 0) : 0;
              const collapsedCount =
                diffStyle === 'unified' && expandedEntry
                  ? expandedEntry.foldableBlocks.filter((b) => !unfoldedBlockIds.has(b.id)).length
                  : 0;
              const canHydratePartial =
                !renderedMeta?.isPartial || Boolean(diffOptions?.loadDiffFiles);
              const canExpand =
                renderedMeta !== null &&
                canHydratePartial &&
                (isExpanded ||
                  computeEnclosingExpandPlan(
                    renderedMeta,
                    hunkMeta.hunkIndex,
                    hunkMeta.enclosing
                  ) !== null);
              const displayName = formatCodeNavSymbolDisplayName(hunkMeta.enclosing);
              return (
                <div
                  key={`hunk:${hunkMeta.hunkIndex}:${fnKey}`}
                  className="flex items-center justify-between gap-2 border-y border-foreground/[0.07] bg-[color-mix(in_oklab,hsl(var(--foreground))_4%,hsl(var(--background)))] px-3 py-1 text-[11.5px]"
                >
                  <span
                    className="inline-flex min-w-0 items-center gap-1.5 font-mono font-medium text-[hsl(var(--primary))]"
                    title={displayName}
                  >
                    <span>ƒ</span>
                    <span className="truncate">{displayName}</span>
                  </span>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {isExpanded && foldableCount > 0 ? (
                      <button
                        type="button"
                        data-review-toggle-folds={`${filePath}:${fnKey}`}
                        onClick={() => handleToggleAllFoldsForFunction(fnKey)}
                        className="rounded-[5px] border border-border bg-background px-2 py-0.5 text-[11px] text-foreground/80 transition-colors hover:bg-[hsl(var(--hover))] hover:text-foreground cursor-pointer"
                      >
                        {collapsedCount > 0 ? `展开块 (${collapsedCount})` : '折叠块'}
                      </button>
                    ) : null}
                    {canExpand ? (
                      <button
                        type="button"
                        onClick={() =>
                          void handleToggleExpandFunction(hunkMeta.hunkIndex, hunkMeta.enclosing)
                        }
                        className={cn(
                          'rounded-[5px] border px-2 py-0.5 text-[11px] transition-colors cursor-pointer',
                          isExpanded
                            ? 'border-[hsl(var(--primary))] bg-[color-mix(in_oklab,hsl(var(--primary))_13%,transparent)] text-[hsl(var(--primary))]'
                            : 'border-border bg-background text-foreground/80 hover:bg-[hsl(var(--hover))] hover:text-foreground'
                        )}
                      >
                        {isExpanded ? '收起函数' : '展开整函数'}
                      </button>
                    ) : null}
                    {canOpenInIde ? (
                      <button
                        type="button"
                        onClick={() => onOpenInIde(filePath, hunkMeta.lineNumber)}
                        className="rounded-[5px] border border-border bg-background px-1.5 py-0.5 text-[11px] text-foreground/80 transition-colors hover:bg-[hsl(var(--hover))] hover:text-foreground cursor-pointer"
                      >
                        ↗ IDE
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            }

            const { block, collapsed } = item;
            if (collapsed) {
              const indentRem = Math.min(18, Math.max(0, block.indentColumns)) * 0.45 + 0.65;
              return (
                <div
                  key={`fold:${block.id}`}
                  className="flex items-center border-y border-foreground/[0.06] bg-[color-mix(in_oklab,hsl(var(--foreground))_2.5%,hsl(var(--background)))] py-[2px] pr-3"
                >
                  <button
                    type="button"
                    data-review-fold-bar={block.id}
                    data-fold-state="collapsed"
                    onClick={() => handleToggleFoldBlock(block.id)}
                    style={{ marginLeft: `${indentRem}rem` }}
                    className="inline-flex items-center gap-1 rounded-[5px] border border-foreground/[0.11] bg-background px-2 py-[1px] font-mono text-[11px] leading-[1.35] text-muted-foreground transition-colors hover:border-[hsl(var(--primary))]/45 hover:bg-[hsl(var(--hover))] hover:text-foreground cursor-pointer"
                  >
                    <ChevronRight className="h-3 w-3 shrink-0 opacity-75" aria-hidden="true" />
                    <span>{formatFoldBlockLabel(block)}</span>
                  </button>
                </div>
              );
            }

            return (
              <div key={`fold:${block.id}`} className="flex items-center justify-end pr-3 py-[1px]">
                <button
                  type="button"
                  data-review-fold-bar={block.id}
                  data-fold-state="expanded"
                  onClick={() => handleToggleFoldBlock(block.id)}
                  className="inline-flex items-center gap-1 rounded-[4px] px-1.5 py-[0.5px] font-mono text-[10.5px] leading-[1.3] text-muted-foreground/75 transition-colors hover:bg-[hsl(var(--hover))] hover:text-foreground cursor-pointer"
                >
                  <ChevronDown className="h-2.5 w-2.5 shrink-0 opacity-75" aria-hidden="true" />
                  <span>
                    收起{' '}
                    {block.kind === 'bracket'
                      ? `[ ${block.hiddenLineCount} 行 ]`
                      : `{ ${block.hiddenLineCount} 行 }`}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      );
    },
    [
      canOpenInIde,
      diffOptions?.loadDiffFiles,
      diffStyle,
      expandedFunctions,
      filePath,
      handleToggleAllFoldsForFunction,
      handleToggleExpandFunction,
      handleToggleFoldBlock,
      onOpenInIde,
      renderedMeta,
      unfoldedBlockIds,
    ]
  );

  const renderLineIdeUtility = useCallback(
    (getHoveredLine: () => { lineNumber: number; side?: string } | undefined) => {
      if (!canOpenInIde) return null;
      return (
        <button
          type="button"
          title="↗ IDE"
          aria-label="Open line in IDE"
          onClick={(event) => {
            event.stopPropagation();
            const hovered = getHoveredLine();
            if (!hovered || hovered.side === 'deletions') return;
            onOpenInIde(filePath, hovered.lineNumber);
          }}
          className="flex h-5 w-5 items-center justify-center rounded text-[11px] text-muted-foreground transition-colors hover:bg-[hsl(var(--hover))] hover:text-[hsl(var(--primary))] cursor-pointer"
        >
          ↗
        </button>
      );
    },
    [canOpenInIde, filePath, onOpenInIde]
  );

  const handleTokenClick = useCallback(
    (token: DiffTokenEventBaseProps, event: MouseEvent) => {
      onTokenClick({ filePath, token, event });
    },
    [filePath, onTokenClick]
  );

  const fallbackStats = useMemo(() => computeFileDiffStats(data), [data]);
  const resolvedStats = useMemo(() => {
    if (renderedMeta) {
      let additions = 0;
      let deletions = 0;
      for (const hunk of renderedMeta.hunks) {
        additions += hunk.additionLines;
        deletions += hunk.deletionLines;
      }
      return {
        additions,
        deletions,
        firstLine: Math.max(1, renderedMeta.hunks[0]?.additionStart ?? 1),
      };
    }
    return fallbackStats;
  }, [fallbackStats, renderedMeta]);

  const additions = additionsOverride ?? resolvedStats.additions;
  const deletions = deletionsOverride ?? resolvedStats.deletions;
  const primaryLine =
    primaryOutlineHunk?.startLine && primaryOutlineHunk.startLine > 0
      ? primaryOutlineHunk.startLine
      : resolvedStats.firstLine;
  const { dir, name } = splitPathParts(filePath);

  const primaryFnKey = primaryEnclosing ? getEnclosingFunctionKey(primaryEnclosing) : null;
  const primaryExpandedEntry = primaryFnKey ? expandedFunctions.get(primaryFnKey) : undefined;
  const primaryExpanded = primaryExpandedEntry !== undefined;
  const primaryFoldableCount =
    diffStyle === 'unified' ? (primaryExpandedEntry?.foldableBlocks.length ?? 0) : 0;
  const primaryCollapsedCount =
    diffStyle === 'unified' && primaryExpandedEntry
      ? primaryExpandedEntry.foldableBlocks.filter((b) => !unfoldedBlockIds.has(b.id)).length
      : 0;
  const canHydratePrimaryPartial = !renderedMeta?.isPartial || Boolean(diffOptions?.loadDiffFiles);
  const canExpandPrimary =
    Boolean(primaryEnclosing) &&
    renderedMeta !== null &&
    canHydratePrimaryPartial &&
    (primaryExpanded || computeEnclosingExpandPlan(renderedMeta, 0, primaryEnclosing!) !== null);

  const foldUnsafeCSS = useMemo(
    () => buildFoldedLinesUnsafeCSS(collapsedFoldBlocks, diffStyle),
    [collapsedFoldBlocks, diffStyle]
  );

  const combinedUnsafeCSS = useMemo(() => {
    const parts: string[] = [];
    if (codeNavSupported) parts.push(REVIEW_INTERACTIVE_TOKEN_UNSAFE_CSS);
    if (canOpenInIde) parts.push(REVIEW_GUTTER_IDE_UNSAFE_CSS);
    if (foldUnsafeCSS) parts.push(foldUnsafeCSS);
    return parts.length > 0 ? parts.join('\n') : undefined;
  }, [canOpenInIde, codeNavSupported, foldUnsafeCSS]);

  const primaryDisplayName = primaryEnclosing
    ? formatCodeNavSymbolDisplayName(primaryEnclosing)
    : null;

  return (
    <section
      ref={(node) => onCardRef(filePath, node)}
      data-diff-path={filePath}
      data-review-file-card={filePath}
      className="mb-3.5 rounded-[10px] border border-foreground/[0.12] bg-background dark:border-border"
    >
      <div
        data-review-sticky-header={filePath}
        className={cn(
          'sticky top-0 z-20 bg-background',
          open
            ? 'rounded-t-[9px] shadow-[0_2px_8px_-4px_rgba(0,0,0,0.14)] dark:shadow-[0_2px_10px_-4px_rgba(0,0,0,0.5)]'
            : 'rounded-[9px]'
        )}
      >
        <div
          className={cn(
            'flex items-center justify-between gap-2 bg-[color-mix(in_oklab,hsl(var(--foreground))_4%,hsl(var(--background)))] px-3 py-2',
            open ? 'rounded-t-[9px] border-b border-border' : 'rounded-[9px]'
          )}
        >
          <button
            type="button"
            onClick={() => onOpenChange(filePath, !open)}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left cursor-pointer"
          >
            {open ? (
              <ChevronDown
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            ) : (
              <ChevronRight
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            )}
            <span
              className="min-w-0 truncate font-mono text-[12px] font-medium text-foreground"
              title={filePath}
            >
              {dir ? <span className="font-normal text-muted-foreground">{dir}</span> : null}
              {name}
            </span>
          </button>

          <div className="flex shrink-0 items-center gap-2 text-[11.5px]">
            {(additions > 0 || deletions > 0) && (
              <span className="inline-flex items-center gap-1 font-mono tabular-nums">
                {additions > 0 && (
                  <span className="text-[hsl(var(--github-addition))]">+{additions}</span>
                )}
                {deletions > 0 && (
                  <span className="text-[hsl(var(--github-deletion))]">-{deletions}</span>
                )}
              </span>
            )}
            {canOpenInIde ? (
              <button
                type="button"
                data-card-open-ide={filePath}
                onClick={() => onOpenInIde(filePath, primaryLine)}
                className="inline-flex items-center gap-1 rounded-[5px] border border-border bg-background px-2 py-0.5 text-[11px] text-foreground/80 transition-colors hover:bg-[hsl(var(--hover))] hover:text-foreground cursor-pointer"
              >
                ↗ IDE
              </button>
            ) : null}
          </div>
        </div>

        {open && primaryEnclosing && primaryDisplayName ? (
          <div
            data-review-hunk-bar={filePath}
            className="flex items-center justify-between gap-2 border-b border-foreground/[0.07] bg-[color-mix(in_oklab,hsl(var(--foreground))_3%,hsl(var(--background)))] px-3 py-[5px] text-[11.5px]"
          >
            <span
              className="inline-flex min-w-0 items-center gap-1.5 font-mono font-medium text-[hsl(var(--primary))]"
              title={primaryDisplayName}
            >
              <span>ƒ</span>
              <span className="truncate">{primaryDisplayName}</span>
            </span>
            <div className="flex shrink-0 items-center gap-1.5">
              {primaryExpanded && primaryFoldableCount > 0 && primaryFnKey ? (
                <button
                  type="button"
                  data-review-toggle-folds={filePath}
                  onClick={() => handleToggleAllFoldsForFunction(primaryFnKey)}
                  className="shrink-0 rounded-[5px] border border-border bg-background px-2 py-0.5 text-[11px] text-foreground/80 transition-colors hover:bg-[hsl(var(--hover))] hover:text-foreground cursor-pointer"
                >
                  {primaryCollapsedCount > 0 ? `展开块 (${primaryCollapsedCount})` : '折叠块'}
                </button>
              ) : null}
              {canExpandPrimary ? (
                <button
                  type="button"
                  data-expand-function={filePath}
                  onClick={() => void handleToggleExpandFunction(0, primaryEnclosing)}
                  className={cn(
                    'shrink-0 rounded-[5px] border px-2 py-0.5 text-[11px] transition-colors cursor-pointer',
                    primaryExpanded
                      ? 'border-[hsl(var(--primary))] bg-[color-mix(in_oklab,hsl(var(--primary))_13%,transparent)] text-[hsl(var(--primary))]'
                      : 'border-border bg-background text-foreground/80 hover:bg-[hsl(var(--hover))] hover:text-foreground'
                  )}
                >
                  {primaryExpanded ? '收起函数' : '展开整函数'}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {open ? (
        <div className="overflow-x-auto rounded-b-[9px]">
          {!data ? (
            <div className="flex flex-col gap-1.5 px-4 py-3">
              <Skeleton width="90%" height={12} />
              <Skeleton width="76%" height={12} />
              <Skeleton width="84%" height={12} />
            </div>
          ) : data.status === 'error' ? (
            <div className="px-3 py-2.5 text-xs text-muted-foreground">{data.message}</div>
          ) : data.status === 'ready' &&
            (data.oldSnapshot.kind === 'binary' ||
              data.newSnapshot.kind === 'binary' ||
              data.oldSnapshot.kind === 'large' ||
              data.newSnapshot.kind === 'large' ||
              data.oldSnapshot.kind === 'filtered' ||
              data.newSnapshot.kind === 'filtered') ? (
            <div className="px-3 py-2.5 text-xs text-muted-foreground">
              {data.oldSnapshot.kind === 'binary' || data.newSnapshot.kind === 'binary'
                ? 'Binary file'
                : data.oldSnapshot.kind === 'large' || data.newSnapshot.kind === 'large'
                  ? 'File too large to diff'
                  : 'Diff filtered'}
            </div>
          ) : (
            <DiffViewer
              showHeader={false}
              renderContent={renderContent}
              path={filePath}
              oldText={
                data.status === 'ready' && data.oldSnapshot.kind === 'text'
                  ? data.oldSnapshot.text
                  : ''
              }
              newText={
                data.status === 'ready' && data.newSnapshot.kind === 'text'
                  ? data.newSnapshot.text
                  : ''
              }
              preparsedDiff={data.status === 'ready-parsed' ? data.fileDiff : undefined}
              preparsedOldTextLength={
                data.status === 'ready-parsed' ? data.oldTextLength : undefined
              }
              preparsedNewTextLength={
                data.status === 'ready-parsed' ? data.newTextLength : undefined
              }
              lazyTextDiffSource={data.status === 'ready-text-source' ? data.source : undefined}
              diffStyle={diffStyle}
              options={diffOptions}
              cachePrerenderedHtml={false}
              onTokenClick={codeNavSupported ? handleTokenClick : undefined}
              onDiffInstanceReady={handleDiffInstanceReady}
              lineAnnotations={mergedAnnotations}
              renderAnnotation={renderMergedAnnotation}
              renderGutterUtility={canOpenInIde ? renderLineIdeUtility : undefined}
              unsafeCSS={combinedUnsafeCSS}
            />
          )}
        </div>
      ) : null}
    </section>
  );
});

export interface WorktreeReviewDiffViewProps {
  readonly filePaths: readonly string[];
  readonly resolvedByPath: Readonly<Record<string, FileDiffData>>;
  readonly visiblePaths: ReadonlySet<string>;
  readonly outlineByPath: ReadonlyMap<string, CodeNavDiffOutlineFile>;
  readonly statsByPath: ReadonlyMap<string, WorktreeReviewResolvedFileStats>;
  readonly openByPath: Readonly<Record<string, boolean>>;
  readonly diffStyle?: 'unified' | 'split';
  /** Optional Storybook/test hint to auto-expand the primary enclosing function of matching paths. */
  readonly initialExpandedPaths?: ReadonlySet<string>;
  readonly onOpenChange: (filePath: string, nextOpen: boolean) => void;
  readonly loading: boolean;
  readonly emptyMessage: string | null;
  readonly codeNavSupported: boolean;
  readonly canOpenInIde: boolean;
  readonly onTokenClick: (payload: WorktreeReviewDiffTokenClick) => void;
  readonly onOpenInIde: (filePath: string, line?: number) => void;
  readonly onCardRef: (filePath: string, node: HTMLElement | null) => void;
  readonly onStatsResolved: (filePath: string, stats: WorktreeReviewResolvedFileStats) => void;
  readonly onLayoutChange?: () => void;
}

export function WorktreeReviewDiffView({
  filePaths,
  resolvedByPath,
  visiblePaths,
  outlineByPath,
  statsByPath,
  openByPath,
  diffStyle = 'unified',
  initialExpandedPaths,
  onOpenChange,
  loading,
  emptyMessage,
  codeNavSupported,
  canOpenInIde,
  onTokenClick,
  onOpenInIde,
  onCardRef,
  onStatsResolved,
  onLayoutChange,
}: WorktreeReviewDiffViewProps) {
  if (emptyMessage !== null) {
    return (
      <div className="flex h-full items-center justify-center px-6 py-10 text-sm text-muted-foreground">
        {emptyMessage}
      </div>
    );
  }

  if (loading && filePaths.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <div className="rounded-[10px] border border-border bg-background p-4">
          <Skeleton width="42%" height={14} />
          <div className="mt-3 flex flex-col gap-2">
            <Skeleton width="95%" height={12} />
            <Skeleton width="82%" height={12} />
            <Skeleton width="88%" height={12} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div data-worktree-review-diff-view="">
      {filePaths.map((filePath) => {
        const stats = statsByPath.get(filePath);
        return (
          <ReviewDiffFileCard
            key={filePath}
            filePath={filePath}
            data={resolvedByPath[filePath]}
            outlineFile={outlineByPath.get(filePath)}
            additionsOverride={stats?.additions}
            deletionsOverride={stats?.deletions}
            renderContent={visiblePaths.size === 0 || visiblePaths.has(filePath)}
            open={openByPath[filePath] !== false}
            diffStyle={diffStyle}
            initialExpandPrimary={initialExpandedPaths?.has(filePath) ?? false}
            onOpenChange={onOpenChange}
            codeNavSupported={codeNavSupported}
            canOpenInIde={canOpenInIde}
            onTokenClick={onTokenClick}
            onOpenInIde={onOpenInIde}
            onCardRef={onCardRef}
            onStatsResolved={onStatsResolved}
            onLayoutChange={onLayoutChange}
          />
        );
      })}
    </div>
  );
}
