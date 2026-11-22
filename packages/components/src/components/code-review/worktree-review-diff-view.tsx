import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CodeNavDiffOutlineFile, CodeNavSymbol } from '@lody/shared';
import type { DiffLineAnnotation, DiffTokenEventBaseProps, FileDiffMetadata } from '@pierre/diffs';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { DiffViewer, type DiffViewerFileDiffInstance } from '@/ui/diff-viewer/diff-viewer';
import { Skeleton } from '@lody/ui/skeleton';
import { cn } from '@/lib/utils';
import type { FileDiffData } from '../sessions/session-conversation-diff-types';
import {
  computeEnclosingExpandPlan,
  matchOutlineHunk,
  type EnclosingExpandPlan,
} from './worktree-review-nav-model';
import { formatCodeNavSymbolDisplayName } from './worktree-review-tree-model';

export const REVIEW_INTERACTIVE_TOKEN_UNSAFE_CSS = `
[data-line] span[data-char] {
  cursor: pointer;
  border-radius: 2px;
}
[data-line] span[data-char]:hover {
  background: color-mix(in oklab, hsl(var(--primary)) 16%, transparent);
  text-decoration: underline;
  text-decoration-style: dotted;
  text-underline-offset: 2px;
}
`;

export interface WorktreeReviewDiffTokenClick {
  readonly filePath: string;
  readonly token: DiffTokenEventBaseProps;
  readonly event: MouseEvent;
}

interface HunkAnnotationMeta {
  readonly hunkIndex: number;
  readonly enclosing: CodeNavSymbol;
  readonly lineNumber: number;
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
  readonly onOpenChange: (filePath: string, nextOpen: boolean) => void;
  readonly codeNavSupported: boolean;
  readonly canOpenInIde: boolean;
  readonly onTokenClick: (payload: WorktreeReviewDiffTokenClick) => void;
  readonly onOpenInIde: (filePath: string, line?: number) => void;
  readonly onCardRef: (filePath: string, node: HTMLElement | null) => void;
  readonly onStatsResolved?: (
    filePath: string,
    stats: { additions: number; deletions: number; firstLine: number }
  ) => void;
}

const ReviewDiffFileCard = memo(function ReviewDiffFileCard({
  filePath,
  data,
  outlineFile,
  additionsOverride,
  deletionsOverride,
  renderContent,
  open,
  onOpenChange,
  codeNavSupported,
  canOpenInIde,
  onTokenClick,
  onOpenInIde,
  onCardRef,
  onStatsResolved,
}: ReviewDiffFileCardProps) {
  const instanceRef = useRef<DiffViewerFileDiffInstance | null>(null);
  const [renderedMeta, setRenderedMeta] = useState<FileDiffMetadata | null>(
    data?.status === 'ready-parsed' ? data.fileDiff : null
  );
  // Maps hunkIndex -> exact expand deltas applied so collapsing restores cleanly.
  const [expandedHunks, setExpandedHunks] = useState<ReadonlyMap<number, EnclosingExpandPlan>>(
    () => new Map()
  );

  useEffect(() => {
    setExpandedHunks(new Map());
    if (data?.status === 'ready-parsed') {
      setRenderedMeta(data.fileDiff);
    } else {
      setRenderedMeta(null);
    }
  }, [data]);

  const handleDiffInstanceReady = useCallback(
    (instance: DiffViewerFileDiffInstance | null) => {
      instanceRef.current = instance;
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

      const applied = expandedHunks.get(hunkIndex);
      if (applied) {
        if (applied.beforeLines > 0) {
          instance.expandHunk(applied.beforeGapIndex, 'down', -applied.beforeLines);
        }
        if (applied.afterLines > 0) {
          instance.expandHunk(applied.afterGapIndex, 'up', -applied.afterLines);
        }
        setExpandedHunks((prev) => {
          const next = new Map(prev);
          next.delete(hunkIndex);
          return next;
        });
        return;
      }

      // Hydrate partial diffs first so expandHunk reveals full function lines cleanly.
      if (meta.isPartial && diffOptions?.loadDiffFiles) {
        try {
          await instance.prepareForEditing();
        } catch {
          // Fall through; expandHunk still triggers hydration if available.
        }
      }

      const activeMeta = instance.fileDiff ?? meta;
      const plan = computeEnclosingExpandPlan(activeMeta, hunkIndex, enclosing);
      if (!plan) return;
      if (plan.beforeLines > 0) {
        instance.expandHunk(plan.beforeGapIndex, 'down', plan.beforeLines);
      }
      if (plan.afterLines > 0) {
        instance.expandHunk(plan.afterGapIndex, 'up', plan.afterLines);
      }
      setExpandedHunks((prev) => {
        const next = new Map(prev);
        next.set(hunkIndex, plan);
        return next;
      });
    },
    [diffOptions?.loadDiffFiles, expandedHunks, renderedMeta]
  );

  // Hunk 0 enclosing bar renders right beneath the file header (matching visual design);
  // hunks 1..N render via DiffViewer lineAnnotations inside the diff.
  const primaryOutlineHunk = useMemo(() => {
    if (!outlineFile) return undefined;
    if (renderedMeta) {
      return matchOutlineHunk(renderedMeta, 0, outlineFile);
    }
    return outlineFile.hunks[0];
  }, [outlineFile, renderedMeta]);

  const secondaryAnnotations = useMemo<DiffLineAnnotation<unknown>[] | undefined>(() => {
    if (!renderedMeta || !outlineFile || renderedMeta.hunks.length <= 1) return undefined;
    const list: DiffLineAnnotation<HunkAnnotationMeta>[] = [];
    for (let hunkIndex = 1; hunkIndex < renderedMeta.hunks.length; hunkIndex += 1) {
      const hunk = renderedMeta.hunks[hunkIndex]!;
      const outlineHunk = matchOutlineHunk(renderedMeta, hunkIndex, outlineFile);
      if (!outlineHunk?.enclosing) continue;
      if (hunk.additionCount <= 0) continue;
      list.push({
        side: 'additions',
        lineNumber: hunk.additionStart,
        metadata: {
          hunkIndex,
          enclosing: outlineHunk.enclosing,
          lineNumber: Math.max(1, outlineHunk.startLine || hunk.additionStart),
        },
      });
    }
    return list.length > 0 ? (list as DiffLineAnnotation<unknown>[]) : undefined;
  }, [outlineFile, renderedMeta]);

  const renderSecondaryAnnotation = useCallback(
    (annotation: DiffLineAnnotation<unknown>) => {
      const meta = annotation.metadata as HunkAnnotationMeta | undefined;
      if (!meta) return null;
      const isExpanded = expandedHunks.has(meta.hunkIndex);
      const canExpand =
        renderedMeta !== null &&
        (isExpanded ||
          computeEnclosingExpandPlan(renderedMeta, meta.hunkIndex, meta.enclosing) !== null);
      return (
        <div className="flex items-center justify-between gap-2 border-y border-foreground/[0.07] bg-[color-mix(in_oklab,hsl(var(--foreground))_4%,hsl(var(--background)))] px-3 py-1 text-[11.5px]">
          <span className="inline-flex min-w-0 items-center gap-1.5 font-mono font-medium text-[hsl(var(--primary))]">
            <span>ƒ</span>
            <span className="truncate">{formatCodeNavSymbolDisplayName(meta.enclosing)}</span>
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            {canExpand ? (
              <button
                type="button"
                onClick={() => void handleToggleExpandFunction(meta.hunkIndex, meta.enclosing)}
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
                onClick={() => onOpenInIde(filePath, meta.lineNumber)}
                className="rounded-[5px] border border-border bg-background px-1.5 py-0.5 text-[11px] text-foreground/80 transition-colors hover:bg-[hsl(var(--hover))] hover:text-foreground cursor-pointer"
              >
                ↗ IDE
              </button>
            ) : null}
          </div>
        </div>
      );
    },
    [canOpenInIde, expandedHunks, filePath, handleToggleExpandFunction, onOpenInIde, renderedMeta]
  );

  const renderLineIdeUtility = useCallback(
    (getHoveredLine: () => { lineNumber: number } | undefined) => {
      if (!canOpenInIde) return null;
      return (
        <button
          type="button"
          title="↗ IDE"
          aria-label="Open line in IDE"
          onClick={(event) => {
            event.stopPropagation();
            const hovered = getHoveredLine();
            if (hovered) onOpenInIde(filePath, hovered.lineNumber);
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

  const primaryEnclosing = primaryOutlineHunk?.enclosing;
  const primaryExpanded = expandedHunks.has(0);
  const canExpandPrimary =
    Boolean(primaryEnclosing) &&
    renderedMeta !== null &&
    (primaryExpanded || computeEnclosingExpandPlan(renderedMeta, 0, primaryEnclosing!) !== null);

  return (
    <section
      ref={(node) => onCardRef(filePath, node)}
      data-review-file-card={filePath}
      className="mb-3.5 overflow-hidden rounded-[10px] border border-foreground/[0.12] bg-background dark:border-border"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border bg-[color-mix(in_oklab,hsl(var(--foreground))_4%,hsl(var(--background)))] px-3 py-2">
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

      {open ? (
        <>
          {primaryEnclosing ? (
            <div
              data-review-hunk-bar={filePath}
              className="flex items-center justify-between gap-2 border-b border-foreground/[0.07] bg-[color-mix(in_oklab,hsl(var(--foreground))_3%,hsl(var(--background)))] px-3 py-[5px] text-[11.5px]"
            >
              <span className="inline-flex min-w-0 items-center gap-1.5 font-mono font-medium text-[hsl(var(--primary))]">
                <span>ƒ</span>
                <span className="truncate">{formatCodeNavSymbolDisplayName(primaryEnclosing)}</span>
              </span>
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
          ) : null}

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
              diffStyle="unified"
              options={diffOptions}
              cachePrerenderedHtml={false}
              onTokenClick={codeNavSupported ? handleTokenClick : undefined}
              onDiffInstanceReady={handleDiffInstanceReady}
              lineAnnotations={secondaryAnnotations}
              renderAnnotation={secondaryAnnotations ? renderSecondaryAnnotation : undefined}
              renderGutterUtility={canOpenInIde ? renderLineIdeUtility : undefined}
              unsafeCSS={codeNavSupported ? REVIEW_INTERACTIVE_TOKEN_UNSAFE_CSS : undefined}
            />
          )}
        </>
      ) : null}
    </section>
  );
});

export interface WorktreeReviewDiffViewProps {
  readonly filePaths: readonly string[];
  readonly resolvedByPath: Readonly<Record<string, FileDiffData>>;
  readonly visiblePaths: ReadonlySet<string>;
  readonly outlineByPath: ReadonlyMap<string, CodeNavDiffOutlineFile>;
  readonly statsByPath: ReadonlyMap<
    string,
    { readonly additions: number; readonly deletions: number; readonly firstLine: number }
  >;
  readonly openByPath: Readonly<Record<string, boolean>>;
  readonly onOpenChange: (filePath: string, nextOpen: boolean) => void;
  readonly loading: boolean;
  readonly emptyMessage: string | null;
  readonly codeNavSupported: boolean;
  readonly canOpenInIde: boolean;
  readonly onTokenClick: (payload: WorktreeReviewDiffTokenClick) => void;
  readonly onOpenInIde: (filePath: string, line?: number) => void;
  readonly onCardRef: (filePath: string, node: HTMLElement | null) => void;
  readonly onStatsResolved: (
    filePath: string,
    stats: { additions: number; deletions: number; firstLine: number }
  ) => void;
}

export function WorktreeReviewDiffView({
  filePaths,
  resolvedByPath,
  visiblePaths,
  outlineByPath,
  statsByPath,
  openByPath,
  onOpenChange,
  loading,
  emptyMessage,
  codeNavSupported,
  canOpenInIde,
  onTokenClick,
  onOpenInIde,
  onCardRef,
  onStatsResolved,
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
            onOpenChange={onOpenChange}
            codeNavSupported={codeNavSupported}
            canOpenInIde={canOpenInIde}
            onTokenClick={onTokenClick}
            onOpenInIde={onOpenInIde}
            onCardRef={onCardRef}
            onStatsResolved={onStatsResolved}
          />
        );
      })}
    </div>
  );
}
