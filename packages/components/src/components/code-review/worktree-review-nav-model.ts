import type {
  CodeNavCallersOk,
  CodeNavConfidence,
  CodeNavDefinitionOk,
  CodeNavDiffOutlineFile,
  CodeNavDiffOutlineHunk,
  CodeNavLocation,
  CodeNavSymbol,
} from '@lody/shared';
import type { FileDiffMetadata } from '@pierre/diffs';

export type WorktreeReviewNavFrame =
  | {
      readonly kind: 'diff';
      readonly label: string;
      readonly filePath: string | null;
      readonly line?: number;
    }
  | {
      readonly kind: 'file';
      readonly label: string;
      readonly filePath: string;
      readonly line: number;
      readonly endLine?: number;
      readonly callers?: CodeNavCallersOk | null;
      readonly callersSymbol?: string;
      readonly callersLoading?: boolean;
      readonly callersHopDepth?: 1 | 2;
    };

export type WorktreeReviewNavStack = readonly [
  Extract<WorktreeReviewNavFrame, { kind: 'diff' }>,
  ...Extract<WorktreeReviewNavFrame, { kind: 'file' }>[],
];

export function createInitialReviewNavStack(
  filePath: string | null = null,
  line?: number
): WorktreeReviewNavStack {
  return [
    {
      kind: 'diff',
      label: 'Diff',
      filePath,
      ...(line === undefined ? {} : { line }),
    },
  ];
}

export function updateDiffFrameTarget(
  stack: WorktreeReviewNavStack,
  filePath: string | null,
  line?: number
): WorktreeReviewNavStack {
  const root = stack[0];
  if (root.filePath === filePath && root.line === line) {
    return stack;
  }
  const nextRoot: Extract<WorktreeReviewNavFrame, { kind: 'diff' }> = {
    kind: 'diff',
    label: root.label,
    filePath,
    ...(line === undefined ? {} : { line }),
  };
  return [nextRoot, ...stack.slice(1)] as WorktreeReviewNavStack;
}

export function pushReviewFileFrame(
  stack: WorktreeReviewNavStack,
  frame: Extract<WorktreeReviewNavFrame, { kind: 'file' }>
): WorktreeReviewNavStack {
  const [root, ...tail] = stack;
  const top = stack[stack.length - 1]!;
  if (
    top.kind === 'file' &&
    top.filePath === frame.filePath &&
    top.line === frame.line &&
    top.label === frame.label
  ) {
    // Replace top in place when updating callers/metadata on the exact same spot.
    return [root, ...tail.slice(0, -1), { ...top, ...frame }];
  }
  return [root, ...tail, frame];
}

export function updateTopReviewFileFrame(
  stack: WorktreeReviewNavStack,
  updater: (
    frame: Extract<WorktreeReviewNavFrame, { kind: 'file' }>
  ) => Extract<WorktreeReviewNavFrame, { kind: 'file' }>
): WorktreeReviewNavStack {
  if (stack.length <= 1) return stack;
  const [root, ...tail] = stack;
  const top = tail[tail.length - 1];
  if (!top) return stack;
  const nextTop = updater(top);
  if (nextTop === top) return stack;
  return [root, ...tail.slice(0, -1), nextTop];
}

export function popReviewStackTo(
  stack: WorktreeReviewNavStack,
  index: number
): WorktreeReviewNavStack {
  const clamped = Math.max(0, Math.min(index, stack.length - 1));
  if (clamped === stack.length - 1) return stack;
  const [root, ...tail] = stack;
  return [root, ...tail.slice(0, clamped)];
}

export type DefinitionResolutionDecision =
  | {
      readonly kind: 'direct-jump';
      readonly target: CodeNavLocation;
    }
  | {
      readonly kind: 'candidates';
      readonly symbol: string;
      readonly items: readonly CodeNavLocation[];
      readonly confidence: CodeNavConfidence;
      readonly totalCandidates: number;
      readonly truncated: boolean;
    };

/**
 * Only jump directly without showing a picker when the backend guarantees a
 * single exact definition (`confidence === 'exact' && items.length === 1`).
 * Heuristic or multi-candidate matches always open the compact picker.
 */
export function resolveDefinitionDecision(
  response: CodeNavDefinitionOk
): DefinitionResolutionDecision {
  if (response.confidence === 'exact' && response.items.length === 1) {
    return {
      kind: 'direct-jump',
      target: response.items[0]!,
    };
  }
  return {
    kind: 'candidates',
    symbol: response.symbol,
    items: response.items,
    confidence: response.confidence,
    totalCandidates: response.totalCandidates ?? response.items.length,
    truncated: response.truncated,
  };
}

const IGNORED_KEYWORDS = new Set([
  'as',
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'declare',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'from',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'keyof',
  'let',
  'namespace',
  'new',
  'null',
  'of',
  'private',
  'protected',
  'public',
  'readonly',
  'return',
  'satisfies',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'type',
  'typeof',
  'undefined',
  'var',
  'void',
  'while',
  'yield',
]);

export interface ExtractedTokenIdentifier {
  readonly symbol: string;
  /** Adjusted 0-based UTF-16 column offset pointing inside the identifier. */
  readonly character: number;
}

/**
 * Extracts a navigable identifier from a `@pierre/diffs` token click and
 * adjusts `lineCharStart` by the identifier's offset within `tokenText`
 * (e.g. `.close` -> `close` at `lineCharStart + 1`).
 */
export function extractTokenIdentifier(
  tokenText: string,
  lineCharStart: number
): ExtractedTokenIdentifier | null {
  if (!tokenText) return null;
  const matches = Array.from(tokenText.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/gu));
  if (matches.length === 0) return null;
  // Prefer the rightmost identifier in compound tokens (e.g. `broker.close` -> `close`).
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const match = matches[i]!;
    const symbol = match[0];
    if (!symbol || IGNORED_KEYWORDS.has(symbol)) continue;
    const offset = match.index ?? 0;
    return {
      symbol,
      character: Math.max(0, lineCharStart + offset),
    };
  }
  return null;
}

export interface EnclosingExpandStep {
  /** `@pierre/diffs` gap index (`0..hunks.length - 1` before each hunk, `hunks.length` after last hunk). */
  readonly gapIndex: number;
  /** `'down'` increases `fromEnd` (reveals upward from hunk top); `'up'` increases `fromStart` (reveals downward). */
  readonly direction: 'up' | 'down';
  /** Positive line delta applied on expand and negated (`-lines`) on collapse. */
  readonly lines: number;
}

export interface EnclosingExpandPlan {
  /** Ordered gap deltas covering every collapsed gap intersecting `[enclosing.startLine, enclosing.endLine]`. */
  readonly steps: readonly EnclosingExpandStep[];
}

function getHunkAdditionBounds(hunk: FileDiffMetadata['hunks'][number]): {
  readonly start: number;
  readonly endExclusive: number;
} {
  // Matches `@pierre/diffs` `getHunkAdditionLineRange` (`getHunkSideStartBoundary + 1`).
  const start = hunk.additionCount === 0 ? hunk.additionStart + 1 : hunk.additionStart;
  return { start, endExclusive: start + hunk.additionCount };
}

/**
 * Computes exact `@pierre/diffs` `FileDiff.expandHunk` deltas across ALL gaps
 * (before first hunk, between hunks, and trailing after last hunk) that intersect
 * an enclosing function `[enclosing.startLine, enclosing.endLine]`.
 */
export function computeEnclosingExpandPlan(
  fileDiff: Pick<FileDiffMetadata, 'hunks'> &
    Partial<Pick<FileDiffMetadata, 'additionLines' | 'isPartial'>>,
  hunkIndex: number,
  enclosing: Pick<CodeNavSymbol, 'startLine' | 'endLine'>
): EnclosingExpandPlan | null {
  if (!fileDiff.hunks[hunkIndex]) return null;
  const targetStart = Math.max(1, enclosing.startLine);
  const targetEnd = Math.max(targetStart, enclosing.endLine);

  const steps: EnclosingExpandStep[] = [];
  let prevHunkEndExclusive = 1;

  for (let gapIndex = 0; gapIndex < fileDiff.hunks.length; gapIndex += 1) {
    const hunk = fileDiff.hunks[gapIndex]!;
    const { start: hunkStart, endExclusive: hunkEndExclusive } = getHunkAdditionBounds(hunk);
    const gapEnd = hunkStart - 1;
    const gapStart =
      gapIndex === 0
        ? Math.max(
            1,
            typeof hunk.collapsedBefore === 'number' ? hunkStart - hunk.collapsedBefore : 1
          )
        : prevHunkEndExclusive;
    const gapSize = gapEnd - gapStart + 1;

    if (gapSize > 0) {
      const overlapStart = Math.max(targetStart, gapStart);
      const overlapEnd = Math.min(targetEnd, gapEnd);
      if (overlapStart <= overlapEnd) {
        if (overlapEnd === gapEnd && (gapIndex === 0 || overlapStart > gapStart)) {
          // Reveal upward from `hunk[gapIndex]`'s top (`fromEnd`).
          steps.push({
            gapIndex,
            direction: 'down',
            lines: gapEnd - overlapStart + 1,
          });
        } else if (overlapStart === gapStart) {
          // Reveal downward from previous hunk's bottom (`fromStart`); covers full
          // inter-hunk gaps (`overlapEnd === gapEnd`) as well as function tails.
          steps.push({
            gapIndex,
            direction: 'up',
            lines: overlapEnd - gapStart + 1,
          });
        } else {
          // Interior range inside a gap: reveal from whichever boundary is closer.
          const fromStartLines = overlapEnd - gapStart + 1;
          const fromEndLines = gapEnd - overlapStart + 1;
          steps.push(
            fromStartLines <= fromEndLines
              ? { gapIndex, direction: 'up', lines: fromStartLines }
              : { gapIndex, direction: 'down', lines: fromEndLines }
          );
        }
      }
    }

    prevHunkEndExclusive = hunkEndExclusive;
  }

  // Trailing gap after the last hunk (`gapIndex === fileDiff.hunks.length`),
  // which `@pierre/diffs` expands exclusively via `direction: 'up'` (`fromStart`).
  // On remote partial patches (`isPartial === true`), `additionLines` only holds
  // patch lines rather than the full file, so do not clamp against its length.
  const trailingStart = prevHunkEndExclusive;
  const totalAdditionLines = fileDiff.isPartial ? 0 : (fileDiff.additionLines?.length ?? 0);
  const trailingEnd = totalAdditionLines > 0 ? totalAdditionLines : targetEnd;
  if (trailingStart <= trailingEnd && targetEnd >= trailingStart) {
    const clampedEnd = Math.min(targetEnd, trailingEnd);
    const trailingLines = clampedEnd - trailingStart + 1;
    if (trailingLines > 0) {
      steps.push({
        gapIndex: fileDiff.hunks.length,
        direction: 'up',
        lines: trailingLines,
      });
    }
  }

  return steps.length > 0 ? { steps } : null;
}

/**
 * Matches a `@pierre/diffs` hunk at `hunkIndex` to its corresponding
 * `diff-outline` hunk entry by overlapping new-file line range.
 */
export function matchOutlineHunk(
  fileDiff: Pick<FileDiffMetadata, 'hunks'>,
  hunkIndex: number,
  outlineFile: CodeNavDiffOutlineFile | undefined
): CodeNavDiffOutlineHunk | undefined {
  if (!outlineFile || outlineFile.hunks.length === 0) return undefined;
  const hunk = fileDiff.hunks[hunkIndex];
  if (!hunk) return undefined;
  const hunkStart = hunk.additionStart;
  const hunkEnd = hunk.additionStart + Math.max(hunk.additionCount, 1) - 1;
  const overlap = outlineFile.hunks.find(
    (entry) => entry.endLine >= hunkStart && entry.startLine <= hunkEnd
  );
  if (overlap) return overlap;
  if (outlineFile.hunks.length === fileDiff.hunks.length) {
    return outlineFile.hunks[hunkIndex];
  }
  return undefined;
}
