import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FileDiffMetadata } from '@pierre/diffs';
import { cn } from '@/lib/utils';

const DEFAULT_MIN_THUMB_HEIGHT = 20;

export interface MinimapThumbGeometry {
  readonly top: number;
  readonly height: number;
  readonly scrollable: boolean;
}

export interface MinimapDiffHunkMark {
  /** Normalized start ratio `[0, 1]` within the file diff's rendered rows. */
  readonly startRatio: number;
  /** Normalized height ratio `[0, 1]` within the file diff's rendered rows. */
  readonly heightRatio: number;
  readonly hasAdditions: boolean;
  readonly hasDeletions: boolean;
}

export interface MinimapDiffFileStats {
  readonly additions: number;
  readonly deletions: number;
  readonly firstLine: number;
  readonly hunkMarks?: readonly MinimapDiffHunkMark[];
}

export type WorktreeReviewMinimapProps =
  | {
      readonly mode: 'diff';
      readonly scrollContainer: HTMLElement | null;
      readonly filePaths: readonly string[];
      readonly getCardElement: (filePath: string) => HTMLElement | null;
      readonly statsByPath: ReadonlyMap<string, MinimapDiffFileStats>;
      readonly openByPath: Readonly<Record<string, boolean>>;
      /** Monotonic layout hint incremented when cards expand/collapse/fold. */
      readonly layoutVersion?: number;
      readonly className?: string;
    }
  | {
      readonly mode: 'file';
      readonly scrollContainer: HTMLElement | null;
      readonly filePath: string;
      readonly totalLines: number;
      readonly selectedLines: { readonly start: number; readonly end: number };
      readonly getCodeElement?: () => HTMLElement | null;
      readonly className?: string;
    };

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function getBasename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

/**
 * Computes the vertical position and height (in pixels) of the minimap
 * viewport thumb inside a rail of height `trackHeight`.
 */
export function computeViewportThumb(params: {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly trackHeight: number;
  readonly minThumbHeight?: number;
}): MinimapThumbGeometry {
  const {
    scrollTop,
    scrollHeight,
    clientHeight,
    trackHeight,
    minThumbHeight = DEFAULT_MIN_THUMB_HEIGHT,
  } = params;

  if (scrollHeight <= 0 || clientHeight <= 0 || trackHeight <= 0) {
    return { top: 0, height: Math.max(0, trackHeight), scrollable: false };
  }

  const maxScroll = Math.max(0, scrollHeight - clientHeight);
  if (maxScroll <= 1) {
    return { top: 0, height: trackHeight, scrollable: false };
  }

  const rawHeight = (clientHeight / scrollHeight) * trackHeight;
  const height = Math.max(Math.min(minThumbHeight, trackHeight), Math.min(trackHeight, rawHeight));
  const availableTravel = Math.max(0, trackHeight - height);
  const progress = clamp01(scrollTop / maxScroll);
  return {
    top: progress * availableTravel,
    height,
    scrollable: true,
  };
}

/**
 * Maps a pointer Y coordinate on the minimap rail to a target `scrollTop`.
 * When `grabOffsetPx` is omitted (track click), the thumb centers around `pointerY`;
 * when provided (thumb drag), the grabbed point stays locked under the pointer
 * to prevent jump/jitter.
 */
export function computeScrollTopFromPointer(params: {
  readonly pointerY: number;
  readonly trackTop: number;
  readonly trackHeight: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly grabOffsetPx?: number;
  readonly minThumbHeight?: number;
}): number {
  const {
    pointerY,
    trackTop,
    trackHeight,
    scrollHeight,
    clientHeight,
    grabOffsetPx,
    minThumbHeight = DEFAULT_MIN_THUMB_HEIGHT,
  } = params;

  const maxScroll = Math.max(0, scrollHeight - clientHeight);
  if (maxScroll <= 0 || trackHeight <= 0 || clientHeight <= 0) {
    return 0;
  }

  const thumb = computeViewportThumb({
    scrollTop: 0,
    scrollHeight,
    clientHeight,
    trackHeight,
    minThumbHeight,
  });
  const availableTravel = trackHeight - thumb.height;
  if (availableTravel <= 0) {
    return 0;
  }

  const relY = pointerY - trackTop;
  const effectiveGrab = grabOffsetPx ?? thumb.height / 2;
  const desiredThumbTop = Math.max(0, Math.min(availableTravel, relY - effectiveGrab));
  return Math.round((desiredThumbTop / availableTravel) * maxScroll);
}

/**
 * Computes the normalized `[topFraction, heightFraction]` of `selectedLines`
 * in read-only file mode, optionally scoped to the code element's vertical band
 * inside a scroll container that also holds a Callers section below.
 */
export function computeFileLineRangeMarker(params: {
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly codeOffsetTop?: number;
  readonly codeHeight?: number;
  readonly scrollHeight?: number;
}): { readonly topFraction: number; readonly heightFraction: number } {
  const total = Math.max(1, params.totalLines);
  const clampedStart = Math.max(1, Math.min(total, params.startLine));
  const clampedEnd = Math.max(clampedStart, Math.min(total, params.endLine));

  const lineTop = (clampedStart - 1) / total;
  const lineHeight = (clampedEnd - clampedStart + 1) / total;

  if (
    params.scrollHeight !== undefined &&
    params.scrollHeight > 0 &&
    params.codeOffsetTop !== undefined &&
    params.codeHeight !== undefined &&
    params.codeHeight > 0
  ) {
    const topFraction = clamp01(
      (params.codeOffsetTop + lineTop * params.codeHeight) / params.scrollHeight
    );
    const heightFraction = clamp01((lineHeight * params.codeHeight) / params.scrollHeight);
    return { topFraction, heightFraction };
  }

  return {
    topFraction: clamp01(lineTop),
    heightFraction: clamp01(lineHeight),
  };
}

/**
 * Extracts lightweight normalized change-block positions from a parsed
 * `@pierre/diffs` `FileDiffMetadata` so the diff minimap draws green/red ticks
 * aligned with actual hunks.
 */
export function extractFileDiffHunkMarks(
  fileDiff: Pick<FileDiffMetadata, 'hunks'> | null | undefined
): readonly MinimapDiffHunkMark[] {
  if (!fileDiff || fileDiff.hunks.length === 0) return [];

  let totalRows = 0;
  for (let i = 0; i < fileDiff.hunks.length; i += 1) {
    const hunk = fileDiff.hunks[i]!;
    if (i > 0) totalRows += 1; // separator row between hunks
    for (const part of hunk.hunkContent) {
      totalRows += part.type === 'context' ? part.lines : part.additions + part.deletions;
    }
  }
  if (totalRows <= 0) return [];

  const marks: MinimapDiffHunkMark[] = [];
  let rowCursor = 0;

  for (let i = 0; i < fileDiff.hunks.length; i += 1) {
    const hunk = fileDiff.hunks[i]!;
    if (i > 0) rowCursor += 1;
    for (const part of hunk.hunkContent) {
      if (part.type === 'context') {
        rowCursor += part.lines;
        continue;
      }
      const rows = part.additions + part.deletions;
      if (rows > 0) {
        marks.push({
          startRatio: clamp01(rowCursor / totalRows),
          heightRatio: clamp01(rows / totalRows),
          hasAdditions: part.additions > 0,
          hasDeletions: part.deletions > 0,
        });
        rowCursor += rows;
      }
    }
  }

  return marks;
}

interface MeasuredDiffSection {
  readonly filePath: string;
  readonly topFraction: number;
  readonly heightFraction: number;
  readonly bodyTopFraction: number;
  readonly bodyHeightFraction: number;
  readonly open: boolean;
}

interface ScrollMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly trackHeight: number;
}

interface RenderedMark {
  readonly key: string;
  readonly topPct: number;
  readonly heightPct: number;
  readonly kind: 'addition' | 'deletion' | 'mixed' | 'selected';
}

function measureElementOffsetInScroll(
  element: HTMLElement,
  scrollContainer: HTMLElement
): { readonly top: number; readonly height: number } {
  const containerRect = scrollContainer.getBoundingClientRect();
  const elRect = element.getBoundingClientRect();
  if (elRect.height > 0 || containerRect.height > 0) {
    return {
      top: Math.max(0, elRect.top - containerRect.top + scrollContainer.scrollTop),
      height: elRect.height,
    };
  }
  return {
    top: Math.max(0, element.offsetTop),
    height: element.offsetHeight,
  };
}

export function WorktreeReviewMinimap(props: WorktreeReviewMinimapProps) {
  const { mode, scrollContainer, className } = props;
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [metrics, setMetrics] = useState<ScrollMetrics>({
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    trackHeight: 0,
  });
  const [sections, setSections] = useState<readonly MeasuredDiffSection[]>([]);
  const [codeBand, setCodeBand] = useState<{
    readonly top: number;
    readonly height: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hoverState, setHoverState] = useState<{
    readonly y: number;
    readonly label: string;
  } | null>(null);

  const dragStateRef = useRef<{
    pointerId: number;
    grabOffsetPx: number;
  } | null>(null);

  const propsRef = useRef(props);
  propsRef.current = props;

  const measureLayout = useCallback(() => {
    const current = propsRef.current;
    const scroller = current.scrollContainer;
    const track = trackRef.current;
    const trackHeight =
      track?.getBoundingClientRect().height || track?.clientHeight || scroller?.clientHeight || 0;

    if (!scroller) {
      setMetrics((prev) =>
        prev.scrollHeight === 0 && prev.trackHeight === trackHeight
          ? prev
          : { scrollTop: 0, scrollHeight: 0, clientHeight: 0, trackHeight }
      );
      if (current.mode === 'diff') setSections([]);
      else setCodeBand(null);
      return;
    }

    const scrollTop = scroller.scrollTop;
    const scrollHeight = scroller.scrollHeight;
    const clientHeight = scroller.clientHeight;

    setMetrics((prev) =>
      prev.scrollTop === scrollTop &&
      prev.scrollHeight === scrollHeight &&
      prev.clientHeight === clientHeight &&
      prev.trackHeight === trackHeight
        ? prev
        : { scrollTop, scrollHeight, clientHeight, trackHeight }
    );

    if (current.mode === 'diff') {
      const denom = Math.max(1, scrollHeight);
      const nextSections: MeasuredDiffSection[] = [];
      for (const filePath of current.filePaths) {
        const card = current.getCardElement(filePath);
        if (!card) continue;
        const { top, height } = measureElementOffsetInScroll(card, scroller);
        const headerEl = card.querySelector<HTMLElement>('[data-review-sticky-header]');
        const headerHeight = headerEl
          ? headerEl.getBoundingClientRect().height || headerEl.offsetHeight || 0
          : 0;
        const clampedHeader = Math.min(headerHeight, height);
        const bodyTop = top + clampedHeader;
        const bodyHeight = Math.max(0, height - clampedHeader);
        nextSections.push({
          filePath,
          topFraction: clamp01(top / denom),
          heightFraction: clamp01(height / denom),
          bodyTopFraction: clamp01(bodyTop / denom),
          bodyHeightFraction: clamp01(bodyHeight / denom),
          open: current.openByPath[filePath] !== false,
        });
      }
      setSections(nextSections);
    } else {
      const codeEl = current.getCodeElement?.() ?? null;
      if (codeEl) {
        setCodeBand(measureElementOffsetInScroll(codeEl, scroller));
      } else {
        setCodeBand(null);
      }
    }
  }, []);

  const syncScrollOnly = useCallback(() => {
    const scroller = propsRef.current.scrollContainer;
    if (!scroller) return;
    const nextScrollTop = scroller.scrollTop;
    const nextScrollHeight = scroller.scrollHeight;
    const nextClientHeight = scroller.clientHeight;
    setMetrics((prev) => {
      if (
        prev.scrollTop === nextScrollTop &&
        prev.scrollHeight === nextScrollHeight &&
        prev.clientHeight === nextClientHeight
      ) {
        return prev;
      }
      return {
        ...prev,
        scrollTop: nextScrollTop,
        scrollHeight: nextScrollHeight,
        clientHeight: nextClientHeight,
      };
    });
  }, []);

  const diffPathsKey = mode === 'diff' ? props.filePaths.join('\0') : props.filePath;
  const diffLayoutVersion = mode === 'diff' ? (props.layoutVersion ?? 0) : props.totalLines;
  const openByPathDep = mode === 'diff' ? props.openByPath : null;
  const statsByPathDep = mode === 'diff' ? props.statsByPath : null;

  useLayoutEffect(() => {
    measureLayout();
  }, [
    measureLayout,
    scrollContainer,
    diffPathsKey,
    diffLayoutVersion,
    openByPathDep,
    statsByPathDep,
  ]);

  useEffect(() => {
    if (!scrollContainer) return undefined;

    let rafId = 0;
    const scheduleScrollSync = () => {
      if (dragStateRef.current) return;
      if (typeof requestAnimationFrame !== 'function') {
        syncScrollOnly();
        return;
      }
      if (rafId !== 0) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        syncScrollOnly();
      });
    };

    let layoutRafId = 0;
    const scheduleLayoutMeasure = () => {
      if (typeof requestAnimationFrame !== 'function') {
        measureLayout();
        return;
      }
      if (layoutRafId !== 0) return;
      layoutRafId = requestAnimationFrame(() => {
        layoutRafId = 0;
        measureLayout();
      });
    };

    scrollContainer.addEventListener('scroll', scheduleScrollSync, { passive: true });

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(scheduleLayoutMeasure);
      resizeObserver.observe(scrollContainer);
      if (scrollContainer.firstElementChild) {
        resizeObserver.observe(scrollContainer.firstElementChild);
      }
      if (trackRef.current) {
        resizeObserver.observe(trackRef.current);
      }
    }

    return () => {
      scrollContainer.removeEventListener('scroll', scheduleScrollSync);
      resizeObserver?.disconnect();
      if (rafId !== 0 && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafId);
      }
      if (layoutRafId !== 0 && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(layoutRafId);
      }
    };
  }, [measureLayout, scrollContainer, syncScrollOnly, diffPathsKey]);

  const thumb = useMemo(
    () =>
      computeViewportThumb({
        scrollTop: metrics.scrollTop,
        scrollHeight: metrics.scrollHeight,
        clientHeight: metrics.clientHeight,
        trackHeight: metrics.trackHeight,
      }),
    [metrics.clientHeight, metrics.scrollHeight, metrics.scrollTop, metrics.trackHeight]
  );

  const renderedMarks = useMemo<readonly RenderedMark[]>(() => {
    if (props.mode === 'file') {
      if (props.totalLines <= 0) return [];
      const marker = computeFileLineRangeMarker({
        startLine: props.selectedLines.start,
        endLine: props.selectedLines.end,
        totalLines: props.totalLines,
        codeOffsetTop: codeBand?.top,
        codeHeight: codeBand?.height,
        scrollHeight: metrics.scrollHeight,
      });
      return [
        {
          key: `selected:${props.selectedLines.start}:${props.selectedLines.end}`,
          topPct: marker.topFraction * 100,
          heightPct: marker.heightFraction * 100,
          kind: 'selected',
        },
      ];
    }

    const marks: RenderedMark[] = [];
    for (const sec of sections) {
      const stat = props.statsByPath.get(sec.filePath);
      if (!stat) continue;

      if (sec.open && stat.hunkMarks && stat.hunkMarks.length > 0 && sec.bodyHeightFraction > 0) {
        for (let i = 0; i < stat.hunkMarks.length; i += 1) {
          const hm = stat.hunkMarks[i]!;
          const topFraction = sec.bodyTopFraction + hm.startRatio * sec.bodyHeightFraction;
          const heightFraction = hm.heightRatio * sec.bodyHeightFraction;
          const kind =
            hm.hasAdditions && hm.hasDeletions
              ? 'mixed'
              : hm.hasAdditions
                ? 'addition'
                : 'deletion';
          marks.push({
            key: `${sec.filePath}:h:${i}`,
            topPct: topFraction * 100,
            heightPct: heightFraction * 100,
            kind,
          });
        }
        continue;
      }

      if (stat.additions > 0 || stat.deletions > 0) {
        const bandTop =
          sec.open && sec.bodyHeightFraction > 0 ? sec.bodyTopFraction : sec.topFraction;
        const bandHeight =
          sec.open && sec.bodyHeightFraction > 0 ? sec.bodyHeightFraction : sec.heightFraction;
        const kind =
          stat.additions > 0 && stat.deletions > 0
            ? 'mixed'
            : stat.additions > 0
              ? 'addition'
              : 'deletion';
        marks.push({
          key: `${sec.filePath}:summary`,
          topPct: (bandTop + bandHeight * 0.2) * 100,
          heightPct: Math.max(0.4, bandHeight * 0.6) * 100,
          kind,
        });
      }
    }
    return marks;
  }, [codeBand, metrics.scrollHeight, props, sections]);

  const resolveHoverLabel = useCallback(
    (relY: number, trackHeight: number): string | null => {
      if (trackHeight <= 0) return null;
      const fraction = clamp01(relY / trackHeight);
      const current = propsRef.current;

      if (current.mode === 'diff') {
        if (sections.length === 0) return null;
        let matched: MeasuredDiffSection | null = null;
        for (const sec of sections) {
          if (fraction >= sec.topFraction && fraction <= sec.topFraction + sec.heightFraction) {
            matched = sec;
            break;
          }
          if (fraction >= sec.topFraction) {
            matched = sec;
          }
        }
        const chosen = matched ?? sections[0]!;
        return getBasename(chosen.filePath);
      }

      if (current.totalLines <= 0) return null;
      let lineFraction = fraction;
      if (codeBand && codeBand.height > 0 && metrics.scrollHeight > 0) {
        const docY = fraction * metrics.scrollHeight;
        lineFraction = clamp01((docY - codeBand.top) / codeBand.height);
      }
      const lineNum = Math.max(
        1,
        Math.min(
          current.totalLines,
          Math.round(lineFraction * Math.max(0, current.totalLines - 1)) + 1
        )
      );
      return `L${lineNum}`;
    },
    [codeBand, metrics.scrollHeight, sections]
  );

  const applyPointerScroll = useCallback((clientY: number, grabOffsetPx: number | undefined) => {
    const scroller = propsRef.current.scrollContainer;
    const track = trackRef.current;
    if (!scroller || !track) return;

    const rect = track.getBoundingClientRect();
    const trackHeight = rect.height || track.clientHeight;
    if (trackHeight <= 0) return;

    const nextScrollTop = computeScrollTopFromPointer({
      pointerY: clientY,
      trackTop: rect.top,
      trackHeight,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      grabOffsetPx,
    });

    scroller.scrollTop = nextScrollTop;
    setMetrics({
      scrollTop: nextScrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      trackHeight,
    });
  }, []);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const scroller = propsRef.current.scrollContainer;
      const track = trackRef.current;
      if (!scroller || !track) return;

      event.preventDefault();
      const rect = track.getBoundingClientRect();
      const trackHeight = rect.height || track.clientHeight;
      if (trackHeight <= 0) return;

      const currentThumb = computeViewportThumb({
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        trackHeight,
      });

      const relY = event.clientY - rect.top;
      const hitThumb =
        currentThumb.scrollable &&
        relY >= currentThumb.top &&
        relY <= currentThumb.top + currentThumb.height;
      const grabOffsetPx = hitThumb ? relY - currentThumb.top : currentThumb.height / 2;

      dragStateRef.current = {
        pointerId: event.pointerId,
        grabOffsetPx,
      };
      setDragging(true);
      event.currentTarget.setPointerCapture?.(event.pointerId);

      if (!hitThumb) {
        applyPointerScroll(event.clientY, undefined);
      }

      const label = resolveHoverLabel(relY, trackHeight);
      if (label) {
        setHoverState({ y: relY, label });
      }
    },
    [applyPointerScroll, resolveHoverLabel]
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      const trackHeight = rect.height || track.clientHeight;
      if (trackHeight <= 0) return;

      const relY = Math.max(0, Math.min(trackHeight, event.clientY - rect.top));
      const label = resolveHoverLabel(relY, trackHeight);
      if (label) {
        setHoverState({ y: relY, label });
      } else {
        setHoverState(null);
      }

      const activeDrag = dragStateRef.current;
      if (activeDrag && activeDrag.pointerId === event.pointerId) {
        applyPointerScroll(event.clientY, activeDrag.grabOffsetPx);
      }
    },
    [applyPointerScroll, resolveHoverLabel]
  );

  const finishDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const activeDrag = dragStateRef.current;
    if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;
    dragStateRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
    const track = trackRef.current;
    if (track) {
      const rect = track.getBoundingClientRect();
      const inside =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;
      if (!inside) {
        setHoverState(null);
      }
    }
  }, []);

  const handlePointerLeave = useCallback(() => {
    if (!dragStateRef.current) {
      setHoverState(null);
    }
  }, []);

  if (mode === 'diff' && props.filePaths.length === 0) {
    return null;
  }

  const maxScroll = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
  const valueNow = maxScroll > 0 ? Math.round((metrics.scrollTop / maxScroll) * 100) : 0;

  return (
    <div
      ref={trackRef}
      role="scrollbar"
      aria-label={mode === 'diff' ? 'Diff overview minimap' : 'File overview minimap'}
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={valueNow}
      data-worktree-review-minimap={mode}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onLostPointerCapture={finishDrag}
      onPointerLeave={handlePointerLeave}
      className={cn(
        'relative h-full w-[20px] shrink-0 select-none touch-none border-l border-foreground/[0.07] bg-[color-mix(in_oklab,hsl(var(--foreground))_2%,hsl(var(--background)))]',
        thumb.scrollable ? (dragging ? 'cursor-grabbing' : 'cursor-pointer') : 'cursor-default',
        className
      )}
    >
      {/* File boundary dividers (diff mode) */}
      {mode === 'diff'
        ? sections.map((sec, idx) =>
            idx > 0 ? (
              <div
                key={`div:${sec.filePath}`}
                aria-hidden="true"
                data-minimap-divider={sec.filePath}
                style={{ top: `${sec.topFraction * 100}%` }}
                className="pointer-events-none absolute inset-x-[3px] h-px bg-foreground/[0.14]"
              />
            ) : null
          )
        : null}

      {/* Hunk change ticks (diff mode) or selected line ticks (file mode) */}
      {renderedMarks.map((mark) => {
        if (mark.kind === 'mixed') {
          return (
            <div
              key={mark.key}
              aria-hidden="true"
              data-minimap-mark="mixed"
              style={{
                top: `${mark.topPct}%`,
                height: `${mark.heightPct}%`,
              }}
              className="pointer-events-none absolute inset-x-[3px] flex min-h-[2.5px] gap-[1px]"
            >
              <span className="h-full flex-1 rounded-[1px] bg-[hsl(var(--github-deletion))]/80" />
              <span className="h-full flex-1 rounded-[1px] bg-[hsl(var(--github-addition))]/80" />
            </div>
          );
        }

        return (
          <div
            key={mark.key}
            aria-hidden="true"
            data-minimap-mark={mark.kind}
            style={{
              top: `${mark.topPct}%`,
              height: `${mark.heightPct}%`,
            }}
            className={cn(
              'pointer-events-none absolute inset-x-[3px] rounded-[1.5px]',
              mark.kind === 'selected'
                ? 'min-h-[4px] bg-[hsl(var(--primary))]'
                : mark.kind === 'addition'
                  ? 'min-h-[2.5px] bg-[hsl(var(--github-addition))]/80'
                  : 'min-h-[2.5px] bg-[hsl(var(--github-deletion))]/80'
            )}
          />
        );
      })}

      {/* Viewport thumb */}
      {thumb.scrollable ? (
        <div
          aria-hidden="true"
          data-minimap-thumb=""
          style={{
            transform: `translateY(${thumb.top}px)`,
            height: `${thumb.height}px`,
          }}
          className={cn(
            'pointer-events-none absolute inset-x-[2px] top-0 rounded-[3px] border transition-colors',
            dragging
              ? 'border-foreground/[0.20] bg-foreground/[0.24]'
              : 'border-foreground/[0.11] bg-foreground/[0.13]'
          )}
        />
      ) : null}

      {/* Hover / drag preview label */}
      {hoverState ? (
        <div
          aria-hidden="true"
          data-minimap-hover-label=""
          style={{
            top: `${Math.max(4, Math.min(Math.max(4, metrics.trackHeight - 24), hoverState.y - 11))}px`,
          }}
          className="pointer-events-none absolute right-[calc(100%+6px)] z-30 max-w-[260px] truncate rounded-[6px] border border-border bg-[hsl(var(--popover))] px-1.5 py-0.5 font-mono text-[11px] leading-tight text-popover-foreground shadow-[0_6px_16px_-4px_rgba(0,0,0,0.18)] dark:shadow-[0_8px_18px_-4px_rgba(0,0,0,0.55)]"
        >
          {hoverState.label}
        </div>
      ) : null}
    </div>
  );
}
