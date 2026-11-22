// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDiffFromFile, type DiffLineAnnotation, type FileDiffMetadata } from '@pierre/diffs';
import type { CodeNavDiffOutlineFile } from '@lody/shared';
import { PopupContainerProvider } from '@lody/ui/popup-container';

let lastCapturedUnsafeCSS: string | undefined;
let lastCapturedAnnotations: DiffLineAnnotation<unknown>[] | undefined;
const expandHunkSpy = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock('@pierre/diffs/react', async () => {
  const React = await import('react');
  const WorkerPoolContext = React.createContext<unknown>(undefined);
  return {
    FileDiff: ({
      fileDiff,
      options,
      lineAnnotations,
      renderAnnotation,
    }: {
      fileDiff: FileDiffMetadata;
      options?: {
        unsafeCSS?: string;
        onPostRender?: (node: HTMLElement, instance: unknown, phase: string) => void;
      };
      lineAnnotations?: DiffLineAnnotation<unknown>[];
      renderAnnotation?: (
        annotation: DiffLineAnnotation<unknown>,
        fileDiff: FileDiffMetadata
      ) => React.ReactNode;
    }) => {
      const hostRef = React.useRef<HTMLDivElement | null>(null);
      const instanceRef = React.useRef({
        fileDiff,
        expandHunk: expandHunkSpy,
        prepareForEditing: vi.fn(async () => undefined),
      });
      instanceRef.current.fileDiff = fileDiff;
      lastCapturedUnsafeCSS = options?.unsafeCSS;
      lastCapturedAnnotations = lineAnnotations;

      React.useEffect(() => {
        if (hostRef.current) {
          options?.onPostRender?.(hostRef.current, instanceRef.current, 'mount');
        }
      }, [fileDiff, options]);

      return React.createElement(
        'div',
        { ref: hostRef, 'data-testid': `mock-file-diff:${fileDiff.name}` },
        lineAnnotations?.map((annotation, idx) =>
          React.createElement(
            'div',
            {
              key: `${annotation.side}-${annotation.lineNumber}-${idx}`,
              'data-mock-annotation-line': annotation.lineNumber,
            },
            renderAnnotation?.(annotation, fileDiff)
          )
        )
      );
    },
    File: ({ file }: { file: { name: string; contents: string } }) =>
      React.createElement(
        'div',
        { 'data-testid': `mock-readonly-file:${file.name}` },
        file.contents
      ),
    WorkerPoolContext,
  };
});

vi.mock('../src/ui/diff-viewer/diff-render-worker', () => ({
  createDiffRenderWorkerPool: () => undefined,
  configureDiffRenderWorkerPool: () => Promise.resolve(),
}));

vi.mock('../src/theme-provider', () => ({
  useActiveVSCodeDiffThemeName: () => undefined,
  useResolvedTheme: () => 'light',
}));

vi.mock('../src/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}));

import {
  buildFoldedLinesUnsafeCSS,
  collectDiffChangedNewLines,
  findFoldableBlocksInRange,
  formatFoldBlockLabel,
  scanBracketBlocks,
  splitSourceLines,
} from '../src/components/code-review/worktree-review-code-folding';
import { WorktreeReviewDiffView } from '../src/components/code-review/worktree-review-diff-view';
import {
  computeTreeTooltipCoords,
  TREE_TOOLTIP_DELAY_MS,
  WorktreeReviewFileTree,
} from '../src/components/code-review/worktree-review-file-tree';
import {
  collectRenderedDiffChangeMarks,
  computeCardSummaryMarkBounds,
  computeFileLineRangeMarker,
  computeScrollTopFromPointer,
  computeViewportThumb,
  extractFileDiffHunkMarks,
  WorktreeReviewMinimap,
} from '../src/components/code-review/worktree-review-minimap';
import { buildWorktreeReviewFileTree } from '../src/components/code-review/worktree-review-tree-model';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('worktree-review-code-folding', () => {
  it('ignores brackets inside strings, template literals, regexes, and comments while matching real {} and [] blocks', () => {
    const source = [
      'export function processPayload(input: string) {', // 1 (outer fn body)
      '  const single = "{ not a block } [ nope ]";', // 2
      "  const escaped = '\\' { still string }';", // 3
      '  const regex = /\\{[a-z]+\\}[/}]/g;', // 4
      '  // line comment with { and [', // 5
      '  /* block comment {', // 6
      '     spanning lines [', // 7
      '  */', // 8
      '  const tpl = `prefix {', // 9
      '    ${format({', // 10 (inner object inside template expr - 6 lines 10..15)
      '      a: 1,', // 11
      '      b: 2,', // 12
      '      c: 3,', // 13
      '      d: 4,', // 14
      '    })}', // 15
      '  }`;', // 16
      '  const items = [', // 17 (bracket block 17..23)
      '    "one",', // 18
      '    "two",', // 19
      '    "three",', // 20
      '    "four",', // 21
      '    "five",', // 22
      '  ];', // 23
      '  return { single, escaped, regex, tpl, items };', // 24
      '}', // 25
    ];

    const scanned = scanBracketBlocks(source);
    // Outermost fn body (1..25), object inside template expr (10..15), and array (17..23)
    expect(scanned.map((b) => `${b.kind}:${b.openLine}-${b.closeLine}`)).toEqual([
      'brace:10-15',
      'bracket:17-23',
      'brace:1-25',
    ]);

    const foldable = findFoldableBlocksInRange(source, {
      startLine: 1,
      endLine: 25,
      changedLines: new Set(),
    });
    // Outer function body 1..25 is excluded; inner 10..15 and 17..23 remain.
    expect(foldable.map((b) => `${b.kind}:${b.openLine}-${b.closeLine}`)).toEqual([
      'brace:10-15',
      'bracket:17-23',
    ]);
    expect(formatFoldBlockLabel(foldable[0]!)).toBe('… { 5 行 }');
    expect(formatFoldBlockLabel(foldable[1]!)).toBe('… [ 6 行 ]');
  });

  it('deduplicates nested inner blocks under an accepted outer block, keeps inner unchanged blocks inside a modified outer block, and protects diff lines ±1', () => {
    const source = [
      'export function runWorkflow() {', // 1 (fn body 1..38)
      '  const outerUnchanged = {', // 2 (2..15 -> accepted; inner 4..10 deduped!)
      '    label: "a",', // 3
      '    nested: {', // 4
      '      k1: 1,', // 5
      '      k2: 2,', // 6
      '      k3: 3,', // 7
      '      k4: 4,', // 8
      '      k5: 5,', // 9
      '    },', // 10
      '    extra1: true,', // 11
      '    extra2: true,', // 12
      '    extra3: true,', // 13
      '    extra4: true,', // 14
      '  };', // 15
      '', // 16
      '  if (shouldRun()) {', // 17 (17..35 -> contains diff at line 33 so NOT folded)
      '    const innerUnchanged = [', // 18 (18..24 -> unchanged & far from line 33 -> folded!)
      '      "s1",', // 19
      '      "s2",', // 20
      '      "s3",', // 21
      '      "s4",', // 22
      '      "s5",', // 23
      '    ];', // 24
      '    const nearDiff = {', // 25 (25..31 -> line 32 is diff - 1 -> closeLine 31 touches margin 32 -> EXCLUDED!)
      '      a: 1,', // 26
      '      b: 2,', // 27
      '      c: 3,', // 28
      '      d: 4,', // 29
      '      e: 5,', // 30
      '    };', // 31
      '    const touched = true;', // 32 (DIFF CHANGED LINE!)
      '    consume(innerUnchanged, nearDiff, touched);', // 33
      '  }', // 34
      '  return outerUnchanged;', // 35
      '}', // 36
    ];

    const foldable = findFoldableBlocksInRange(source, {
      startLine: 1,
      endLine: 36,
      changedLines: new Set([32]),
    });

    expect(foldable.map((b) => `${b.kind}:${b.openLine}-${b.closeLine}`)).toEqual([
      'brace:2-15',
      'bracket:18-24',
    ]);
  });

  it('excludes multi-line signature function body and preserves continuation closing lines like "} else {"', () => {
    const source = [
      'export function handleEvent(', // 1
      '  payload: Record<string, unknown>,', // 2
      '  mode: string', // 3
      ') {', // 4 (fn body 4..24)
      '  if (mode === "a") {', // 5 (5..11 -> line 11 continues into "} else {", so hideEndLine = 10)
      '    step1();', // 6
      '    step2();', // 7
      '    step3();', // 8
      '    step4();', // 9
      '    step5();', // 10
      '  } else {', // 11 (11..17 -> normal closing "}", so hideEndLine = 17)
      '    alt1();', // 12
      '    alt2();', // 13
      '    alt3();', // 14
      '    alt4();', // 15
      '    alt5();', // 16
      '  }', // 17
      '  const edited = payload;', // 18
      '  return edited;', // 19
      '}', // 20
    ];

    const foldable = findFoldableBlocksInRange(source, {
      startLine: 1,
      endLine: 20,
      changedLines: new Set([19]),
    });

    expect(foldable).toHaveLength(2);
    expect(foldable[0]).toMatchObject({
      openLine: 5,
      closeLine: 11,
      hideStartLine: 6,
      hideEndLine: 10,
      hiddenLineCount: 5,
    });
    expect(foldable[1]).toMatchObject({
      openLine: 11,
      closeLine: 17,
      hideStartLine: 12,
      hideEndLine: 17,
      hiddenLineCount: 6,
    });
  });

  it('collects diff addition lines & pure-deletion boundaries and generates strict context-only unsafeCSS for unified mode only', () => {
    const oldLines = Array.from({ length: 30 }, (_, i) => `const v${i + 1} = ${i + 1};`);
    const newLines = oldLines
      .filter((_, idx) => idx !== 9 && idx !== 10) // delete old lines 10..11 (between new line 9 and 10)
      .map((line, idx) => (idx === 22 ? 'const modified = true;' : line));
    const parsed = parseDiffFromFile(
      { name: 'src/sample.ts', contents: `${oldLines.join('\n')}\n` },
      { name: 'src/sample.ts', contents: `${newLines.join('\n')}\n` }
    );
    const changed = collectDiffChangedNewLines(parsed);
    // Pure deletion between new line 9 and 10 marks both 9 and 10.
    expect(changed.has(9)).toBe(true);
    expect(changed.has(10)).toBe(true);
    // Modified line 23 is marked.
    expect(changed.has(23)).toBe(true);

    const blocks = [
      {
        id: '2:7:brace',
        kind: 'brace' as const,
        openLine: 2,
        closeLine: 7,
        hideStartLine: 3,
        hideEndLine: 7,
        hiddenLineCount: 5,
        spanLines: 6,
        indentColumns: 2,
      },
    ];

    const unifiedCSS = buildFoldedLinesUnsafeCSS(blocks, 'unified');
    expect(unifiedCSS).toContain('[data-line="3"][data-line-type^="context"]');
    expect(unifiedCSS).toContain('[data-column-number="3"][data-line-type^="context"]');
    expect(unifiedCSS).toContain('[data-line="7"][data-line-type^="context"]');
    expect(unifiedCSS).toContain('[data-column-number="7"][data-line-type^="context"]');
    expect(unifiedCSS).not.toContain('[data-line="2"]');
    expect(unifiedCSS).toContain('display: none !important;');

    // Split mode safely suspends folding to prevent left/right row misalignment.
    expect(buildFoldedLinesUnsafeCSS(blocks, 'split')).toBe('');
  });
});

describe('WorktreeReviewDiffView folding + sticky header integration', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    lastCapturedUnsafeCSS = undefined;
    lastCapturedAnnotations = undefined;
    expandHunkSpy.mockClear();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('auto-folds large unchanged blocks on expand, toggles single & all blocks, merges secondary hunk annotations without collision, and keeps sticky header unclipped', async () => {
    const makeFile = (edited: boolean) =>
      [
        'export function longCoordinator() {', // 1
        '  const defaults = {', // 2 (2..8 -> foldable brace)
        '    a: 1,', // 3
        '    b: 2,', // 4
        '    c: 3,', // 5
        '    d: 4,', // 6
        '    e: 5,', // 7
        '  };', // 8
        '', // 9
        '  const stages = [', // 10 (10..16 -> foldable bracket)
        '    "s1",', // 11
        '    "s2",', // 12
        '    "s3",', // 13
        '    "s4",', // 14
        '    "s5",', // 15
        '  ];', // 16
        '', // 17
        edited ? '  const mode = "session/resume";' : '  const mode = "session/load";', // 18 (hunk 0)
        '  const keep1 = 1;', // 19
        '  const keep2 = 2;', // 20
        '  const keep3 = 3;', // 21
        '  const keep4 = 4;', // 22
        '  const keep5 = 5;', // 23
        '  const keep6 = 6;', // 24
        '  const keep7 = 7;', // 25
        '  const keep8 = 8;', // 26
        '  const keep9 = 9;', // 27
        '  const keep10 = 10;', // 28
        edited
          ? '  return { defaults, stages, mode, ok: true };'
          : '  return { defaults, stages, mode };', // 29 (hunk 1)
        '}', // 30
      ].join('\n') + '\n';

    const oldText = makeFile(false);
    const newText = makeFile(true);
    const parsedDiff = parseDiffFromFile(
      { name: 'src/long-coordinator.ts', contents: oldText },
      { name: 'src/long-coordinator.ts', contents: newText }
    );
    expect(parsedDiff.hunks).toHaveLength(2);
    expect(splitSourceLines(newText)).toHaveLength(30);

    const outlineByPath = new Map<string, CodeNavDiffOutlineFile>([
      [
        'src/long-coordinator.ts',
        {
          path: 'src/long-coordinator.ts',
          symbols: [
            {
              name: 'longCoordinator',
              kind: 'function',
              startLine: 1,
              endLine: 30,
              hunkCount: 2,
            },
          ],
          hunks: [
            {
              startLine: 18,
              endLine: 18,
              enclosing: { name: 'longCoordinator', kind: 'function', startLine: 1, endLine: 30 },
            },
            {
              startLine: 29,
              endLine: 29,
              enclosing: { name: 'longCoordinator', kind: 'function', startLine: 1, endLine: 30 },
            },
          ],
        },
      ],
    ]);

    await act(async () => {
      root.render(
        createElement(WorktreeReviewDiffView, {
          filePaths: ['src/long-coordinator.ts'],
          resolvedByPath: {
            'src/long-coordinator.ts': {
              status: 'ready-parsed',
              fileDiff: parsedDiff,
              oldTextLength: oldText.length,
              newTextLength: newText.length,
            },
          },
          visiblePaths: new Set(['src/long-coordinator.ts']),
          outlineByPath,
          statsByPath: new Map(),
          openByPath: {},
          onOpenChange: vi.fn(),
          loading: false,
          emptyMessage: null,
          codeNavSupported: true,
          canOpenInIde: true,
          onTokenClick: vi.fn(),
          onOpenInIde: vi.fn(),
          onCardRef: vi.fn(),
          onStatsResolved: vi.fn(),
        })
      );
    });

    // Outer <section> must NOT have overflow-hidden (which would break CSS position: sticky),
    // and combined file + function header must be sticky top-0 z-20.
    const section = container.querySelector<HTMLElement>(
      'section[data-diff-path="src/long-coordinator.ts"]'
    )!;
    expect(section.className).not.toContain('overflow-hidden');
    const stickyHeader = section.querySelector<HTMLElement>('[data-review-sticky-header]')!;
    expect(stickyHeader.className).toContain('sticky');
    expect(stickyHeader.className).toContain('top-0');
    expect(stickyHeader.className).toContain('z-20');
    expect(stickyHeader.querySelector('[data-review-hunk-bar]')).not.toBeNull();

    // Before expanding, secondary hunk annotation exists and no fold bars are present.
    expect(container.querySelectorAll('[data-review-fold-bar]')).toHaveLength(0);
    expect(lastCapturedAnnotations).toHaveLength(1);

    // Click "展开整函数" -> auto-folds lines 2..8 and 10..16 while keeping hunk 1 annotation intact.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-expand-function]')!.click();
    });

    expect(expandHunkSpy).toHaveBeenCalled();
    const foldBars = container.querySelectorAll<HTMLButtonElement>('[data-review-fold-bar]');
    expect(foldBars).toHaveLength(2);
    expect(foldBars[0]!.textContent).toContain('… { 6 行 }');
    expect(foldBars[1]!.textContent).toContain('… [ 6 行 ]');
    // Secondary hunk annotation AND both fold annotations coexist (3 unique line numbers).
    expect(lastCapturedAnnotations?.map((a) => a.lineNumber)).toEqual([
      2,
      10,
      parsedDiff.hunks[1]!.additionStart,
    ]);
    // Unsafe CSS hides context lines 3..8 and 11..16.
    expect(lastCapturedUnsafeCSS).toContain('[data-line="3"][data-line-type^="context"]');
    expect(lastCapturedUnsafeCSS).toContain('[data-column-number="16"][data-line-type^="context"]');

    // Sticky header shows "展开块 (2)".
    const toggleAllBtn = stickyHeader.querySelector<HTMLButtonElement>(
      '[data-review-toggle-folds]'
    )!;
    expect(toggleAllBtn.textContent).toBe('展开块 (2)');

    // Click individual fold bar #1 -> expands block 2..8 only, updates count to "展开块 (1)".
    await act(async () => {
      foldBars[0]!.click();
    });
    expect(lastCapturedUnsafeCSS).not.toContain('[data-line="3"][data-line-type^="context"]');
    expect(lastCapturedUnsafeCSS).toContain('[data-line="11"][data-line-type^="context"]');
    expect(
      stickyHeader.querySelector<HTMLButtonElement>('[data-review-toggle-folds]')!.textContent
    ).toBe('展开块 (1)');

    // Click header "展开块 (1)" -> expands remaining block, flips label to "折叠块".
    await act(async () => {
      stickyHeader.querySelector<HTMLButtonElement>('[data-review-toggle-folds]')!.click();
    });
    expect(lastCapturedUnsafeCSS).not.toContain('[data-line="11"][data-line-type^="context"]');
    expect(
      stickyHeader.querySelector<HTMLButtonElement>('[data-review-toggle-folds]')!.textContent
    ).toBe('折叠块');

    // Click header "折叠块" -> re-folds both blocks.
    await act(async () => {
      stickyHeader.querySelector<HTMLButtonElement>('[data-review-toggle-folds]')!.click();
    });
    expect(lastCapturedUnsafeCSS).toContain('[data-line="3"][data-line-type^="context"]');
    expect(lastCapturedUnsafeCSS).toContain('[data-line="11"][data-line-type^="context"]');

    // Click "收起函数" -> clears fold bars & fold CSS while preserving secondary hunk bar.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-expand-function]')!.click();
    });
    expect(container.querySelectorAll('[data-review-fold-bar]')).toHaveLength(0);
    expect(lastCapturedUnsafeCSS).not.toContain('[data-line="3"][data-line-type^="context"]');
    expect(lastCapturedAnnotations).toHaveLength(1);

    // Re-expand function, then collapse the file card (`open: false`) and reopen (`open: true`):
    // expanded function + fold state must reset cleanly so header controls match the fresh DiffViewer.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-expand-function]')!.click();
    });
    expect(container.querySelector<HTMLButtonElement>('[data-expand-function]')!.textContent).toBe(
      '收起函数'
    );
    expect(container.querySelectorAll('[data-review-fold-bar]')).toHaveLength(2);

    const renderWithOpen = (open: boolean, visible = true) =>
      createElement(WorktreeReviewDiffView, {
        filePaths: ['src/long-coordinator.ts'],
        resolvedByPath: {
          'src/long-coordinator.ts': {
            status: 'ready-parsed',
            fileDiff: parsedDiff,
            oldTextLength: oldText.length,
            newTextLength: newText.length,
          },
        },
        visiblePaths: visible ? new Set(['src/long-coordinator.ts']) : new Set<string>(),
        outlineByPath,
        statsByPath: new Map(),
        openByPath: { 'src/long-coordinator.ts': open },
        onOpenChange: vi.fn(),
        loading: false,
        emptyMessage: null,
        codeNavSupported: true,
        canOpenInIde: true,
        onTokenClick: vi.fn(),
        onOpenInIde: vi.fn(),
        onCardRef: vi.fn(),
        onStatsResolved: vi.fn(),
      });

    await act(async () => {
      root.render(renderWithOpen(false));
    });
    await act(async () => {
      root.render(renderWithOpen(true));
    });
    expect(container.querySelector<HTMLButtonElement>('[data-expand-function]')!.textContent).toBe(
      '展开整函数'
    );
    expect(container.querySelector('[data-review-toggle-folds]')).toBeNull();
    expect(container.querySelectorAll('[data-review-fold-bar]')).toHaveLength(0);
    expect(lastCapturedUnsafeCSS).not.toContain('[data-line="3"][data-line-type^="context"]');

    // Re-expand function, then scroll the open card out of the viewport overscan
    // (`visible: false`, keeping `open: true`) and scroll back in: DiffViewer tears
    // down its Pierre instance on scroll-out, so expanded/fold state must also reset.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-expand-function]')!.click();
    });
    expect(container.querySelector<HTMLButtonElement>('[data-expand-function]')!.textContent).toBe(
      '收起函数'
    );
    expect(container.querySelectorAll('[data-review-fold-bar]')).toHaveLength(2);

    await act(async () => {
      root.render(renderWithOpen(true, false));
    });
    await act(async () => {
      root.render(renderWithOpen(true, true));
    });
    expect(container.querySelector<HTMLButtonElement>('[data-expand-function]')!.textContent).toBe(
      '展开整函数'
    );
    expect(container.querySelector('[data-review-toggle-folds]')).toBeNull();
    expect(container.querySelectorAll('[data-review-fold-bar]')).toHaveLength(0);
    expect(lastCapturedUnsafeCSS).not.toContain('[data-line="3"][data-line-type^="context"]');
    expect(lastCapturedAnnotations).toHaveLength(1);
  });
});

describe('WorktreeReviewMinimap', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('computes thumb geometry, click/drag scrollTop mapping, file selectedLines markers, and diff hunk marks', () => {
    const thumb = computeViewportThumb({
      scrollTop: 500,
      scrollHeight: 2000,
      clientHeight: 500,
      trackHeight: 400,
    });
    // 500 / 2000 * 400 = 100px tall; scrollTop 500 / maxScroll 1500 = 1/3 of 300px travel = 100px
    expect(thumb).toEqual({ top: 100, height: 100, scrollable: true });

    // Clicking track center (y=200 on 0..400 track) centers 100px thumb at top=150 -> scrollTop = 750
    expect(
      computeScrollTopFromPointer({
        pointerY: 200,
        trackTop: 0,
        trackHeight: 400,
        scrollHeight: 2000,
        clientHeight: 500,
      })
    ).toBe(750);

    // Dragging with grabOffsetPx=25 at y=125 keeps thumb top at 100 -> scrollTop = 500 (zero jump)
    expect(
      computeScrollTopFromPointer({
        pointerY: 125,
        trackTop: 0,
        trackHeight: 400,
        scrollHeight: 2000,
        clientHeight: 500,
        grabOffsetPx: 25,
      })
    ).toBe(500);

    // File selectedLines marker inside a 200-line file (lines 51..60 -> 25%..30%)
    const fileMarker = computeFileLineRangeMarker({
      startLine: 51,
      endLine: 60,
      totalLines: 200,
    });
    expect(fileMarker.topFraction).toBeCloseTo(0.25, 4);
    expect(fileMarker.heightFraction).toBeCloseTo(0.05, 4);

    // File selectedLines marker scoped within a code band occupying top half of scrollHeight
    const scopedMarker = computeFileLineRangeMarker({
      startLine: 101,
      endLine: 110,
      totalLines: 200,
      codeOffsetTop: 40,
      codeHeight: 400,
      scrollHeight: 800,
    });
    expect(scopedMarker.topFraction).toBeCloseTo((40 + 0.5 * 400) / 800, 4);
    expect(scopedMarker.heightFraction).toBeCloseTo((0.05 * 400) / 800, 4);

    // Diff hunk marks extract addition/deletion proportions from FileDiffMetadata
    const parsed = parseDiffFromFile(
      { name: 'a.ts', contents: 'a\nb\nc\nd\ne\n' },
      { name: 'a.ts', contents: 'a\nb_mod\nc\nd\ne\nf_add\n' }
    );
    const hunkMarks = extractFileDiffHunkMarks(parsed);
    expect(hunkMarks.length).toBeGreaterThanOrEqual(2);
    expect(hunkMarks[0]).toMatchObject({ hasAdditions: true, hasDeletions: true });
    expect(hunkMarks[1]).toMatchObject({ hasAdditions: true, hasDeletions: false });
  });

  it('jumps scrollTop on track click, tracks pointermove with setPointerCapture, and renders file selectedLines tick', async () => {
    const scroller = document.createElement('div');
    let scrollTopValue = 0;
    Object.defineProperties(scroller, {
      scrollHeight: { value: 2000, configurable: true },
      clientHeight: { value: 500, configurable: true },
      scrollTop: {
        get: () => scrollTopValue,
        set: (v: number) => {
          scrollTopValue = v;
        },
        configurable: true,
      },
    });
    scroller.getBoundingClientRect = () =>
      ({ top: 0, bottom: 500, left: 0, right: 600, width: 600, height: 500 }) as DOMRect;

    const cardA = document.createElement('section');
    cardA.getBoundingClientRect = () =>
      ({ top: 0, bottom: 1000, left: 0, right: 600, width: 600, height: 1000 }) as DOMRect;
    const cardB = document.createElement('section');
    cardB.getBoundingClientRect = () =>
      ({ top: 1000, bottom: 2000, left: 0, right: 600, width: 600, height: 1000 }) as DOMRect;

    const cards = new Map<string, HTMLElement>([
      ['apps/cli/src/a.ts', cardA],
      ['apps/cli/src/b.ts', cardB],
    ]);

    await act(async () => {
      root.render(
        createElement(WorktreeReviewMinimap, {
          mode: 'diff',
          scrollContainer: scroller,
          filePaths: ['apps/cli/src/a.ts', 'apps/cli/src/b.ts'],
          getCardElement: (p) => cards.get(p) ?? null,
          statsByPath: new Map([
            ['apps/cli/src/a.ts', { additions: 4, deletions: 1, firstLine: 10 }],
            ['apps/cli/src/b.ts', { additions: 0, deletions: 3, firstLine: 20 }],
          ]),
          openByPath: {},
        })
      );
    });

    const rail = container.querySelector<HTMLDivElement>('[data-worktree-review-minimap="diff"]')!;
    expect(rail).not.toBeNull();
    rail.getBoundingClientRect = () =>
      ({ top: 0, bottom: 400, left: 580, right: 600, width: 20, height: 400 }) as DOMRect;
    const captureSpy = vi.fn();
    const releaseSpy = vi.fn();
    rail.setPointerCapture = captureSpy;
    rail.hasPointerCapture = () => true;
    rail.releasePointerCapture = releaseSpy;

    // Trigger pointerdown on track at y=300 (bottom half -> jumps scrollTop and captures pointer).
    await act(async () => {
      rail.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 590, clientY: 300 })
      );
    });
    expect(captureSpy).toHaveBeenCalledTimes(1);
    expect(scrollTopValue).toBe(1250);

    // Drag continuously upward to y=100 -> scrollTop follows smoothly.
    await act(async () => {
      rail.dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, clientX: 590, clientY: 100 })
      );
    });
    expect(scrollTopValue).toBe(250);

    // Hover label shows the file name corresponding to the hovered band.
    expect(container.querySelector('[data-minimap-hover-label]')?.textContent).toBe('a.ts');

    // Releasing pointer releases capture.
    await act(async () => {
      rail.dispatchEvent(
        new MouseEvent('pointerup', { bubbles: true, clientX: 590, clientY: 100 })
      );
    });
    expect(releaseSpy).toHaveBeenCalledTimes(1);

    // Switch to file mode and verify selectedLines marker & line hover label.
    await act(async () => {
      root.render(
        createElement(WorktreeReviewMinimap, {
          mode: 'file',
          scrollContainer: scroller,
          filePath: 'packages/shared/src/workspace-mcp.ts',
          totalLines: 100,
          selectedLines: { start: 41, end: 50 },
        })
      );
    });
    const fileRail = container.querySelector<HTMLDivElement>(
      '[data-worktree-review-minimap="file"]'
    )!;
    fileRail.getBoundingClientRect = () =>
      ({ top: 0, bottom: 400, left: 580, right: 600, width: 20, height: 400 }) as DOMRect;

    const selectedMark = fileRail.querySelector<HTMLElement>('[data-minimap-mark="selected"]')!;
    expect(selectedMark).not.toBeNull();
    expect(selectedMark.style.top).toBe('40%');
    expect(selectedMark.style.height).toBe('10%');

    await act(async () => {
      fileRail.dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, clientX: 590, clientY: 200 })
      );
    });
    expect(fileRail.querySelector('[data-minimap-hover-label]')?.textContent).toBe('L51');
  });

  it('ends active drag cleanly when filePaths empties mid-drag so restoring the list never sticks in dragging mode', async () => {
    const scroller = document.createElement('div');
    let scrollTopValue = 150;
    Object.defineProperties(scroller, {
      scrollHeight: { value: 2000, configurable: true },
      clientHeight: { value: 500, configurable: true },
      scrollTop: {
        get: () => scrollTopValue,
        set: (v: number) => {
          scrollTopValue = v;
        },
        configurable: true,
      },
    });
    scroller.getBoundingClientRect = () =>
      ({ top: 0, bottom: 500, left: 0, right: 600, width: 600, height: 500 }) as DOMRect;

    const card = document.createElement('section');
    card.getBoundingClientRect = () =>
      ({ top: 0, bottom: 2000, left: 0, right: 600, width: 600, height: 2000 }) as DOMRect;

    const renderDiffMinimap = (paths: readonly string[]) =>
      createElement(WorktreeReviewMinimap, {
        mode: 'diff',
        scrollContainer: scroller,
        filePaths: paths,
        getCardElement: (p) => (p === 'a.ts' ? card : null),
        statsByPath: new Map([['a.ts', { additions: 5, deletions: 2, firstLine: 1 }]]),
        openByPath: {},
      });

    await act(async () => {
      root.render(renderDiffMinimap(['a.ts']));
    });
    const rail = container.querySelector<HTMLDivElement>('[data-worktree-review-minimap="diff"]')!;
    rail.getBoundingClientRect = () =>
      ({ top: 0, bottom: 400, left: 580, right: 600, width: 20, height: 400 }) as DOMRect;

    // Begin drag on track.
    await act(async () => {
      rail.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 590, clientY: 100 })
      );
    });
    expect(rail.className).toContain('cursor-grabbing');
    const scrollAfterDragStart = scrollTopValue;

    // List clears mid-drag (track DOM detaches without firing pointerup on it).
    await act(async () => {
      root.render(renderDiffMinimap([]));
    });
    expect(container.querySelector('[data-worktree-review-minimap]')).toBeNull();

    // Restore list: moving mouse WITHOUT pressing down must NOT drag scrollTop or stay cursor-grabbing.
    await act(async () => {
      root.render(renderDiffMinimap(['a.ts']));
    });
    const restoredRail = container.querySelector<HTMLDivElement>(
      '[data-worktree-review-minimap="diff"]'
    )!;
    restoredRail.getBoundingClientRect = () =>
      ({ top: 0, bottom: 400, left: 580, right: 600, width: 20, height: 400 }) as DOMRect;
    expect(restoredRail.className).not.toContain('cursor-grabbing');

    await act(async () => {
      restoredRail.dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, clientX: 590, clientY: 360 })
      );
    });
    expect(scrollTopValue).toBe(scrollAfterDragStart);
  });

  it('keeps collapsed file summary marks strictly within the card band and aligns open card marks to real Shadow DOM change rows', async () => {
    // 1. Collapsed card occupying 2.1% of document height must stay <= 2.1% (never 40%).
    const collapsedBounds = computeCardSummaryMarkBounds(0.1, 0.021, false);
    expect(collapsedBounds.heightPct).toBeCloseTo(1.05, 4);
    expect(collapsedBounds.heightPct).toBeLessThanOrEqual(2.1);
    expect(collapsedBounds.topPct).toBeGreaterThanOrEqual(10);
    expect(collapsedBounds.topPct + collapsedBounds.heightPct).toBeLessThanOrEqual(12.1);
    expect(collapsedBounds.maxHeightPct).toBeCloseTo(2.1, 4);

    // Ultra-tiny collapsed card (0.2% of document height) clamps strictly to 0.2%.
    const tinyCollapsed = computeCardSummaryMarkBounds(0.5, 0.002, false);
    expect(tinyCollapsed.heightPct).toBeCloseTo(0.2, 4);
    expect(tinyCollapsed.maxHeightPct).toBeCloseTo(0.2, 4);

    // 2. Mounted <diffs-container> with open Shadow DOM change rows measures exact rendered positions.
    const scroller = document.createElement('div');
    Object.defineProperties(scroller, {
      scrollHeight: { value: 2000, configurable: true },
      clientHeight: { value: 500, configurable: true },
      scrollTop: { value: 0, configurable: true },
    });
    scroller.getBoundingClientRect = () =>
      ({ top: 0, bottom: 500, left: 0, right: 600, width: 600, height: 500 }) as DOMRect;

    const openCard = document.createElement('section');
    openCard.getBoundingClientRect = () =>
      ({ top: 0, bottom: 1600, left: 0, right: 600, width: 600, height: 1600 }) as DOMRect;
    const shadowHost = document.createElement('div');
    const shadow = shadowHost.attachShadow({ mode: 'open' });
    const delLine = document.createElement('div');
    delLine.setAttribute('data-line', '50');
    delLine.setAttribute('data-line-type', 'change-deletion');
    delLine.getBoundingClientRect = () =>
      ({ top: 346, bottom: 366, left: 0, right: 600, width: 600, height: 20 }) as DOMRect;
    const addLine1 = document.createElement('div');
    addLine1.setAttribute('data-line', '50');
    addLine1.setAttribute('data-line-type', 'change-addition');
    addLine1.getBoundingClientRect = () =>
      ({ top: 366, bottom: 386, left: 0, right: 600, width: 600, height: 20 }) as DOMRect;
    const addLine2 = document.createElement('div');
    addLine2.setAttribute('data-line', '51');
    addLine2.setAttribute('data-line-type', 'change-addition');
    addLine2.getBoundingClientRect = () =>
      ({ top: 386, bottom: 406, left: 0, right: 600, width: 600, height: 20 }) as DOMRect;
    shadow.append(delLine, addLine1, addLine2);
    openCard.appendChild(shadowHost);
    const origQuerySelector = openCard.querySelector.bind(openCard);
    openCard.querySelector = ((selector: string) =>
      selector === 'diffs-container'
        ? shadowHost
        : origQuerySelector(selector)) as typeof openCard.querySelector;

    const measured = collectRenderedDiffChangeMarks({
      card: openCard,
      scrollContainer: scroller,
      scrollHeight: 2000,
      cardTop: 0,
      cardHeight: 1600,
    });
    expect(measured).toHaveLength(2);
    expect(measured[0]!.kind).toBe('deletion');
    expect(measured[0]!.topPct).toBeCloseTo(17.3, 4);
    expect(measured[0]!.heightPct).toBeCloseTo(1, 4);
    expect(measured[1]!.kind).toBe('addition');
    expect(measured[1]!.topPct).toBeCloseTo(18.3, 4);
    expect(measured[1]!.heightPct).toBeCloseTo(2, 4);

    // Collapsed second card (40px / 2000px = 2%) renders summary mark capped at <= 2%.
    const collapsedCard = document.createElement('section');
    collapsedCard.getBoundingClientRect = () =>
      ({ top: 1600, bottom: 1640, left: 0, right: 600, width: 600, height: 40 }) as DOMRect;

    await act(async () => {
      root.render(
        createElement(WorktreeReviewMinimap, {
          mode: 'diff',
          scrollContainer: scroller,
          filePaths: ['src/open.ts', 'src/collapsed.ts'],
          getCardElement: (p) => (p === 'src/open.ts' ? openCard : collapsedCard),
          statsByPath: new Map([
            [
              'src/open.ts',
              {
                additions: 2,
                deletions: 1,
                firstLine: 50,
                // Deliberately drifted hunkMarks to prove real Shadow DOM positions take precedence.
                hunkMarks: [
                  { startRatio: 0.05, heightRatio: 0.05, hasAdditions: true, hasDeletions: true },
                ],
              },
            ],
            ['src/collapsed.ts', { additions: 10, deletions: 0, firstLine: 1 }],
          ]),
          openByPath: { 'src/open.ts': true, 'src/collapsed.ts': false },
        })
      );
    });

    const delMark = container.querySelector<HTMLElement>('[data-minimap-mark="deletion"]')!;
    const addMarks = container.querySelectorAll<HTMLElement>('[data-minimap-mark="addition"]');
    expect(Number.parseFloat(delMark.style.top)).toBeCloseTo(17.3, 4);
    expect(Number.parseFloat(addMarks[0]!.style.top)).toBeCloseTo(18.3, 4);
    // Collapsed card mark must stay inside [80%, 82%] (never 40%).
    expect(Number.parseFloat(addMarks[1]!.style.height)).toBeLessThanOrEqual(2);
    expect(addMarks[1]!.style.maxHeight).toBe('2%');
  });
});

describe('WorktreeReviewFileTree Portal tooltip', () => {
  let container: HTMLDivElement;
  let portalHost: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    portalHost = document.createElement('div');
    portalHost.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 }) as DOMRect;
    document.body.appendChild(container);
    document.body.appendChild(portalHost);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    portalHost.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('positions tooltip to the right when room permits and falls back above/below when tight', () => {
    const wideBounds = { left: 0, top: 0, width: 1200, height: 800 };
    const rightPlaced = computeTreeTooltipCoords({
      anchorRect: { left: 10, right: 240, top: 120, bottom: 146, width: 230, height: 26 },
      bounds: wideBounds,
      tooltipWidth: 320,
      tooltipHeight: 28,
    });
    expect(rightPlaced.placement).toBe('right');
    expect(rightPlaced.left).toBe(248);

    const narrowBounds = { left: 0, top: 0, width: 320, height: 600 };
    const topPlaced = computeTreeTooltipCoords({
      anchorRect: { left: 8, right: 240, top: 120, bottom: 146, width: 232, height: 26 },
      bounds: narrowBounds,
      tooltipWidth: 260,
      tooltipHeight: 28,
    });
    expect(topPlaced.placement).toBe('top');
    expect(topPlaced.top).toBe(120 - 28 - 8);
  });

  it('shows full path and overflowing long symbol name in Portal tooltip after 150ms hover and closes on leave/click', async () => {
    const longPath =
      'packages/components/src/components/code-review/worktree-review-very-long-module-name.tsx';
    const longSymbol = 'WorkspaceExecutionCoordinator.reconcileMultiClientSessionTranscripts';
    const shortSymbol = 'close';

    const tree = buildWorktreeReviewFileTree(
      [{ path: longPath, additions: 12, deletions: 2 }],
      new Map([
        [
          longPath,
          {
            path: longPath,
            symbols: [
              {
                name: 'reconcileMultiClientSessionTranscripts',
                containerName: 'WorkspaceExecutionCoordinator',
                kind: 'method',
                startLine: 10,
                endLine: 40,
                hunkCount: 1,
              },
              {
                name: 'close',
                kind: 'method',
                startLine: 50,
                endLine: 55,
                hunkCount: 1,
              },
            ],
            hunks: [],
          },
        ],
      ])
    );

    const onSelectFile = vi.fn();
    const onSelectSymbol = vi.fn();

    await act(async () => {
      root.render(
        createElement(
          PopupContainerProvider,
          { container: portalHost },
          createElement(WorktreeReviewFileTree, {
            tree,
            activeFilePath: null,
            activeSymbolId: null,
            symbolsAvailable: true,
            showSymbols: true,
            onToggleShowSymbols: vi.fn(),
            onSelectFile,
            onSelectSymbol,
          })
        )
      );
    });

    const fileBtn = container.querySelector<HTMLButtonElement>(`[data-tree-file="${longPath}"]`)!;
    const longSymBtn = container.querySelector<HTMLButtonElement>(
      `[data-tree-symbol="${longSymbol}"]`
    )!;
    const shortSymBtn = container.querySelector<HTMLButtonElement>(
      `[data-tree-symbol="${shortSymbol}"]`
    )!;

    // Native title attributes remain intact.
    expect(fileBtn.querySelector('[data-tree-label]')?.getAttribute('title')).toBe(longPath);
    expect(longSymBtn.querySelector('[data-tree-label]')?.getAttribute('title')).toBe(longSymbol);

    // Stub overflow ONLY on the long symbol label (short symbol does not overflow).
    const longSymLabel = longSymBtn.querySelector<HTMLElement>('[data-tree-label]')!;
    Object.defineProperties(longSymLabel, {
      scrollWidth: { value: 420, configurable: true },
      clientWidth: { value: 180, configurable: true },
    });
    const shortSymLabel = shortSymBtn.querySelector<HTMLElement>('[data-tree-label]')!;
    Object.defineProperties(shortSymLabel, {
      scrollWidth: { value: 42, configurable: true },
      clientWidth: { value: 180, configurable: true },
    });

    fileBtn.getBoundingClientRect = () =>
      ({ left: 8, right: 240, top: 80, bottom: 106, width: 232, height: 26 }) as DOMRect;
    longSymBtn.getBoundingClientRect = () =>
      ({ left: 8, right: 240, top: 106, bottom: 129, width: 232, height: 23 }) as DOMRect;

    // 1. Hovering file row shows full path in portalHost after 150ms.
    await act(async () => {
      fileBtn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(portalHost.querySelector('[data-worktree-review-tree-tooltip]')).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(TREE_TOOLTIP_DELAY_MS);
    });
    const fileTooltip = portalHost.querySelector<HTMLElement>(
      '[data-worktree-review-tree-tooltip]'
    );
    expect(fileTooltip?.textContent).toBe(longPath);

    // Mouse leave immediately closes tooltip.
    await act(async () => {
      fileBtn.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    expect(portalHost.querySelector('[data-worktree-review-tree-tooltip]')).toBeNull();

    // 2. Hovering non-overflowing short symbol does NOT open tooltip.
    await act(async () => {
      shortSymBtn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      vi.advanceTimersByTime(TREE_TOOLTIP_DELAY_MS + 50);
    });
    expect(portalHost.querySelector('[data-worktree-review-tree-tooltip]')).toBeNull();

    // 3. Hovering overflowing long symbol opens complete symbol name and closes immediately on click.
    await act(async () => {
      longSymBtn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      vi.advanceTimersByTime(TREE_TOOLTIP_DELAY_MS);
    });
    expect(portalHost.querySelector('[data-worktree-review-tree-tooltip]')?.textContent).toBe(
      longSymbol
    );

    await act(async () => {
      longSymBtn.click();
    });
    expect(portalHost.querySelector('[data-worktree-review-tree-tooltip]')).toBeNull();
    expect(onSelectSymbol).toHaveBeenCalledTimes(1);

    // 4. Keyboard focus opens tooltip immediately without delay and blur closes it.
    await act(async () => {
      longSymBtn.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    expect(portalHost.querySelector('[data-worktree-review-tree-tooltip]')?.textContent).toBe(
      longSymbol
    );
    await act(async () => {
      longSymBtn.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(portalHost.querySelector('[data-worktree-review-tree-tooltip]')).toBeNull();
  });

  it('dismisses an active hover or focus tooltip immediately when the hovered row is removed by a tree refresh', async () => {
    const treeWithBoth = buildWorktreeReviewFileTree([
      { path: 'src/a.ts', additions: 3, deletions: 1 },
      { path: 'src/b.ts', additions: 2, deletions: 0 },
    ]);
    const treeWithoutA = buildWorktreeReviewFileTree([
      { path: 'src/b.ts', additions: 2, deletions: 0 },
    ]);

    const renderTree = (tree: ReturnType<typeof buildWorktreeReviewFileTree>) =>
      createElement(
        PopupContainerProvider,
        { container: portalHost },
        createElement(WorktreeReviewFileTree, {
          tree,
          activeFilePath: null,
          activeSymbolId: null,
          symbolsAvailable: false,
          showSymbols: false,
          onToggleShowSymbols: vi.fn(),
          onSelectFile: vi.fn(),
          onSelectSymbol: vi.fn(),
        })
      );

    await act(async () => {
      root.render(renderTree(treeWithBoth));
    });

    const btnA = container.querySelector<HTMLButtonElement>('[data-tree-file="src/a.ts"]')!;
    btnA.getBoundingClientRect = () =>
      ({ left: 8, right: 240, top: 60, bottom: 86, width: 232, height: 26 }) as DOMRect;

    // Hover path: open tooltip on src/a.ts, then refresh tree removing src/a.ts.
    await act(async () => {
      btnA.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      vi.advanceTimersByTime(TREE_TOOLTIP_DELAY_MS);
    });
    expect(portalHost.querySelector('[data-worktree-review-tree-tooltip]')?.textContent).toBe(
      'src/a.ts'
    );

    await act(async () => {
      root.render(renderTree(treeWithoutA));
    });
    expect(portalHost.querySelector('[data-worktree-review-tree-tooltip]')).toBeNull();

    // Keyboard focus path: open tooltip on src/b.ts, then refresh to empty tree.
    const btnB = container.querySelector<HTMLButtonElement>('[data-tree-file="src/b.ts"]')!;
    btnB.getBoundingClientRect = () =>
      ({ left: 8, right: 240, top: 60, bottom: 86, width: 232, height: 26 }) as DOMRect;
    await act(async () => {
      btnB.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    expect(portalHost.querySelector('[data-worktree-review-tree-tooltip]')?.textContent).toBe(
      'src/b.ts'
    );

    await act(async () => {
      root.render(renderTree(buildWorktreeReviewFileTree([])));
    });
    expect(portalHost.querySelector('[data-worktree-review-tree-tooltip]')).toBeNull();
  });
});
