import { describe, expect, it } from 'vitest';
import { parseDiffFromFile } from '@pierre/diffs';
import type { CodeNavDefinitionOk, CodeNavDiffOutlineFile, CodeNavLocation } from '@lody/shared';
import {
  buildWorktreeReviewFileTree,
  flattenWorktreeReviewTree,
} from '../src/components/code-review/worktree-review-tree-model';
import {
  computeEnclosingExpandPlan,
  createInitialReviewNavStack,
  extractTokenIdentifier,
  matchOutlineHunk,
  popReviewStackTo,
  pushReviewFileFrame,
  resolveDefinitionDecision,
  updateDiffFrameTarget,
  updateTopReviewFileFrame,
} from '../src/components/code-review/worktree-review-nav-model';
import { computePopoverCoords } from '../src/components/code-review/worktree-review-token-popover';

describe('WorktreeReview compressed file tree model', () => {
  const outlineByPath = new Map<string, CodeNavDiffOutlineFile>([
    [
      'apps/cli/src/agent/session-mcp-resolver.ts',
      {
        path: 'apps/cli/src/agent/session-mcp-resolver.ts',
        symbols: [
          {
            name: 'loadSessionMcpCatalog',
            kind: 'function',
            startLine: 88,
            endLine: 112,
            hunkCount: 1,
          },
          {
            name: 'normalizeServerSelection',
            kind: 'function',
            startLine: 24,
            endLine: 40,
            hunkCount: 1,
          },
        ],
        hunks: [
          {
            startLine: 92,
            endLine: 98,
            enclosing: {
              name: 'loadSessionMcpCatalog',
              kind: 'function',
              startLine: 88,
              endLine: 112,
            },
          },
        ],
      },
    ],
    [
      'apps/cli/src/agent/agent-client.ts',
      {
        path: 'apps/cli/src/agent/agent-client.ts',
        symbols: [
          {
            name: 'startSession',
            kind: 'method',
            containerName: 'AgentClient',
            startLine: 1948,
            endLine: 1982,
            hunkCount: 1,
          },
        ],
        hunks: [],
      },
    ],
  ]);

  it('compresses single-child directory chains and preserves split branches and root files', () => {
    const tree = buildWorktreeReviewFileTree(
      [
        { path: 'README.md', additions: 4, deletions: 1 },
        { path: 'apps/cli/src/agent/session-mcp-resolver.ts', additions: 14, deletions: 3 },
        { path: 'apps/cli/src/agent/agent-client.ts', additions: 18, deletions: 4 },
        { path: 'apps/cli/src/mcp/catalog-service.ts', additions: 6, deletions: 2 },
        {
          path: 'packages/components/src/components/ai-gui/streaming-thought-preview.ts',
          additions: 22,
          deletions: 5,
        },
      ],
      outlineByPath
    );

    expect(tree.fileCount).toBe(5);
    expect(tree.totalAdditions).toBe(64);
    expect(tree.totalDeletions).toBe(15);
    expect(tree.symbolCount).toBe(3);

    // Root file stays at root level without synthetic "." directory.
    expect(tree.files.map((file) => file.name)).toEqual(['README.md']);

    // `apps/cli/src` splits into `agent` and `mcp`, while `packages/.../ai-gui` compresses fully.
    expect(tree.dirs.map((dir) => dir.name)).toEqual([
      'apps/cli/src',
      'packages/components/src/components/ai-gui',
    ]);
    const appsSrc = tree.dirs[0]!;
    expect(appsSrc.dirs.map((dir) => dir.name)).toEqual(['agent', 'mcp']);

    // Nested symbols are ordered by startLine and include containerName formatting.
    const agentDir = appsSrc.dirs[0]!;
    const clientFile = agentDir.files.find((f) => f.name === 'agent-client.ts')!;
    expect(clientFile.symbols.map((s) => s.displayName)).toEqual(['AgentClient.startSession']);
    const resolverFile = agentDir.files.find((f) => f.name === 'session-mcp-resolver.ts')!;
    expect(resolverFile.symbols.map((s) => s.displayName)).toEqual([
      'normalizeServerSelection',
      'loadSessionMcpCatalog',
    ]);
  });

  it('flattens tree respecting collapsed directories and the showSymbols switch', () => {
    const tree = buildWorktreeReviewFileTree(
      [
        { path: 'apps/cli/src/agent/session-mcp-resolver.ts', additions: 14, deletions: 3 },
        { path: 'apps/cli/src/agent/agent-client.ts', additions: 18, deletions: 4 },
      ],
      outlineByPath
    );

    // Single chain compresses to one top-level directory `apps/cli/src/agent`.
    expect(tree.dirs).toHaveLength(1);
    expect(tree.dirs[0]!.name).toBe('apps/cli/src/agent');

    const withSymbols = flattenWorktreeReviewTree(tree, {
      collapsedDirs: new Set(),
      showSymbols: true,
    });
    expect(withSymbols.map((row) => `${row.kind}:${row.depth}`)).toEqual([
      'dir:0',
      'file:1',
      'symbol:2',
      'file:1',
      'symbol:2',
      'symbol:2',
    ]);

    const filesOnly = flattenWorktreeReviewTree(tree, {
      collapsedDirs: new Set(),
      showSymbols: false,
    });
    expect(filesOnly.map((row) => row.kind)).toEqual(['dir', 'file', 'file']);

    const collapsed = flattenWorktreeReviewTree(tree, {
      collapsedDirs: new Set(['apps/cli/src/agent']),
      showSymbols: true,
    });
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]).toMatchObject({ kind: 'dir', collapsed: true });
  });
});

describe('WorktreeReview navigation stack & resolution', () => {
  it('pushes, updates, deduplicates top frames, and pops breadcrumbs while keeping root Diff', () => {
    let stack = createInitialReviewNavStack('apps/cli/src/agent/session-mcp-resolver.ts', 94);
    expect(stack).toHaveLength(1);
    expect(stack[0]).toMatchObject({ kind: 'diff', label: 'Diff', line: 94 });

    stack = updateDiffFrameTarget(stack, 'apps/cli/src/agent/agent-client.ts', 1960);
    expect(stack[0]).toMatchObject({
      filePath: 'apps/cli/src/agent/agent-client.ts',
      line: 1960,
    });

    stack = pushReviewFileFrame(stack, {
      kind: 'file',
      label: 'resolveSessionMcpServers',
      filePath: 'packages/shared/src/workspace-mcp.ts',
      line: 229,
      callersLoading: true,
    });
    expect(stack).toHaveLength(2);

    // Pushing the exact same top location merges metadata instead of duplicating crumbs.
    stack = pushReviewFileFrame(stack, {
      kind: 'file',
      label: 'resolveSessionMcpServers',
      filePath: 'packages/shared/src/workspace-mcp.ts',
      line: 229,
      callersLoading: false,
    });
    expect(stack).toHaveLength(2);
    expect(stack[1]?.callersLoading).toBe(false);

    stack = updateTopReviewFileFrame(stack, (frame) => ({
      ...frame,
      callersSymbol: 'resolveSessionMcpServers',
    }));
    expect(stack[1]?.callersSymbol).toBe('resolveSessionMcpServers');

    stack = pushReviewFileFrame(stack, {
      kind: 'file',
      label: 'AgentClient.startSession',
      filePath: 'apps/cli/src/agent/agent-client.ts',
      line: 1960,
    });
    expect(stack.map((f) => f.label)).toEqual([
      'Diff',
      'resolveSessionMcpServers',
      'AgentClient.startSession',
    ]);

    // Popping to index 1 keeps Diff -> resolveSessionMcpServers.
    const mid = popReviewStackTo(stack, 1);
    expect(mid.map((f) => f.label)).toEqual(['Diff', 'resolveSessionMcpServers']);

    // Popping below 0 clamps safely to root Diff.
    const rootOnly = popReviewStackTo(stack, -3);
    expect(rootOnly).toHaveLength(1);
    expect(rootOnly[0].kind).toBe('diff');
  });

  it('only direct-jumps on single exact definitions; heuristic or multi-candidate opens picker', () => {
    const locA: CodeNavLocation = {
      path: 'packages/shared/src/workspace-mcp.ts',
      line: 229,
      character: 16,
      name: 'resolveSessionMcpServers',
      kind: 'function',
      previewLine: 'export function resolveSessionMcpServers(',
    };
    const locB: CodeNavLocation = {
      path: 'apps/cli/src/agent/codex-credential-broker.ts',
      line: 106,
      character: 2,
      name: 'close',
      kind: 'method',
      containerName: 'CodexCredentialBroker',
      previewLine: 'async close(): Promise<void> {',
    };

    const exactSingle: CodeNavDefinitionOk = {
      type: 'code-nav/query',
      status: 'ok',
      action: 'definition',
      symbol: 'resolveSessionMcpServers',
      items: [locA],
      confidence: 'exact',
      totalCandidates: 1,
      truncated: false,
      provider: 'ast-grep',
    };
    expect(resolveDefinitionDecision(exactSingle)).toEqual({
      kind: 'direct-jump',
      target: locA,
    });

    // Heuristic with even 1 item must NOT blind-jump.
    expect(resolveDefinitionDecision({ ...exactSingle, confidence: 'heuristic' })).toMatchObject({
      kind: 'candidates',
      confidence: 'heuristic',
      totalCandidates: 1,
    });

    // Exact with >1 items must open picker.
    expect(
      resolveDefinitionDecision({
        ...exactSingle,
        items: [locA, locB],
        totalCandidates: 2,
      })
    ).toMatchObject({ kind: 'candidates', totalCandidates: 2 });

    // Heuristic common method (`close`, 516 total) returns picker with totalCandidates preserved.
    expect(
      resolveDefinitionDecision({
        type: 'code-nav/query',
        status: 'ok',
        action: 'definition',
        symbol: 'close',
        items: [locB],
        confidence: 'heuristic',
        totalCandidates: 516,
        truncated: true,
        provider: 'ast-grep',
      })
    ).toMatchObject({
      kind: 'candidates',
      symbol: 'close',
      confidence: 'heuristic',
      totalCandidates: 516,
      truncated: true,
    });
  });

  it('extracts identifiers with adjusted column offsets and ignores keywords/punctuation', () => {
    expect(extractTokenIdentifier('resolveSessionMcpServers', 18)).toEqual({
      symbol: 'resolveSessionMcpServers',
      character: 18,
    });
    expect(extractTokenIdentifier('.close', 14)).toEqual({
      symbol: 'close',
      character: 15,
    });
    expect(extractTokenIdentifier('broker.close()', 10)).toEqual({
      symbol: 'close',
      character: 17,
    });
    expect(extractTokenIdentifier('return', 2)).toBeNull();
    expect(extractTokenIdentifier('   () => { ', 0)).toBeNull();
  });

  it('computes exact enclosing function expand steps across single and multi-hunk functions and matches outline hunks', () => {
    const fileDiff = {
      hunks: [
        { additionStart: 92, additionCount: 7 },
        { additionStart: 295, additionCount: 5 },
      ],
    } as Parameters<typeof computeEnclosingExpandPlan>[0];

    expect(computeEnclosingExpandPlan(fileDiff, 0, { startLine: 88, endLine: 102 })).toEqual({
      steps: [
        { gapIndex: 0, direction: 'down', lines: 4 }, // lines 88..91 before hunk 0
        { gapIndex: 1, direction: 'up', lines: 4 }, // lines 99..102 after hunk 0
      ],
    });

    // Already fully covered by the hunk -> null.
    expect(computeEnclosingExpandPlan(fileDiff, 0, { startLine: 92, endLine: 98 })).toBeNull();

    // Multi-hunk function: 100-line function edited at lines 20 and 70 -> produces 2 hunks with
    // 3 uncovered regions (before hunk 0, between hunk 0 & hunk 1, and trailing after hunk 1).
    const makeLines = (edits: Record<number, string>) => {
      const lines = ['export function longWorkflow(input: number) {'];
      for (let i = 2; i <= 99; i += 1) {
        lines.push(edits[i] ?? `  const step${i} = input + ${i};`);
      }
      lines.push('  return step99;');
      lines.push('}');
      return `${lines.join('\n')}\n`;
    };
    const oldContents = makeLines({});
    const newContents = makeLines({
      20: '  const step20 = input * 20; // edit 1',
      70: '  const step70 = input * 70; // edit 2',
    });
    const parsed = parseDiffFromFile(
      { name: 'src/long.ts', contents: oldContents },
      { name: 'src/long.ts', contents: newContents }
    );
    expect(parsed.hunks).toHaveLength(2);
    const plan = computeEnclosingExpandPlan(parsed, 0, { startLine: 1, endLine: 101 });
    expect(plan).not.toBeNull();
    // Covers gap 0 (top of function), gap 1 (middle between hunk 0 and hunk 1), and gap 2 (trailing).
    expect(plan!.steps.map((s) => s.gapIndex)).toEqual([0, 1, 2]);
    expect(plan!.steps[0]!.direction).toBe('down');
    expect(plan!.steps[1]!.direction).toBe('up');
    expect(plan!.steps[2]!.direction).toBe('up');
    // Verify total uncovered lines + hunk lines cover every line of [1..101].
    const h0 = parsed.hunks[0]!;
    const h1 = parsed.hunks[1]!;
    const h0Start = h0.additionStart;
    const h0End = h0.additionStart + h0.additionCount - 1;
    const h1Start = h1.additionStart;
    const h1End = h1.additionStart + h1.additionCount - 1;
    expect(plan!.steps[0]!.lines).toBe(h0Start - 1);
    expect(plan!.steps[1]!.lines).toBe(h1Start - h0End - 1);
    expect(plan!.steps[2]!.lines).toBe(101 - h1End);

    // Remote partial patch (`isPartial: true`): `additionLines` only holds patch lines
    // (e.g. 7 lines for lines 88..94), so trailing expansion must NOT clamp against 7.
    const partialDiff = {
      isPartial: true,
      additionLines: new Array<string>(7).fill('line'),
      hunks: [{ additionStart: 88, additionCount: 7, collapsedBefore: 87 }],
    } as Parameters<typeof computeEnclosingExpandPlan>[0];
    expect(computeEnclosingExpandPlan(partialDiff, 0, { startLine: 90, endLine: 110 })).toEqual({
      steps: [{ gapIndex: 1, direction: 'up', lines: 16 }], // lines 95..110
    });

    const outlineFile: CodeNavDiffOutlineFile = {
      path: 'a.ts',
      symbols: [],
      hunks: [
        {
          startLine: 296,
          endLine: 298,
          enclosing: {
            name: 'cleanupSessionCapabilities',
            kind: 'function',
            startLine: 288,
            endLine: 305,
          },
        },
      ],
    };
    expect(matchOutlineHunk(fileDiff, 1, outlineFile)?.enclosing?.name).toBe(
      'cleanupSessionCapabilities'
    );
  });

  it('positions token popover relative to contained dialog bounds and flips above when bottom would clip', () => {
    // Contained dialog offset at (44, 44) with size 1192x712 (like BoardArticleDialog on 1280x800).
    const dialogBounds = { left: 44, top: 44, width: 1192, height: 712 };

    // Anchor with plenty of room below: subtracts dialog origin (no +44px double offset).
    const below = computePopoverCoords({
      anchor: { left: 460, top: 200, bottom: 220 },
      bounds: dialogBounds,
      popoverWidth: 304,
      popoverHeight: 240,
    });
    expect(below).toEqual({
      left: 460 - 44,
      top: 220 - 44 + 6,
    });

    // Anchor near bottom of dialog (y=680..700 in viewport -> relBottom=656 inside 712px dialog):
    // 240px popover would overflow bottom (656 + 6 + 240 > 712), so it flips cleanly above anchor.
    const flipped = computePopoverCoords({
      anchor: { left: 460, top: 680, bottom: 700 },
      bounds: dialogBounds,
      popoverWidth: 304,
      popoverHeight: 240,
    });
    expect(flipped.top).toBe(680 - 44 - 240 - 6);
    expect(flipped.top).toBeGreaterThanOrEqual(12);
    expect(flipped.top + 240).toBeLessThanOrEqual(dialogBounds.height - 12);

    // Anchor near right edge clamps strictly within container width.
    const clampedRight = computePopoverCoords({
      anchor: { left: 1180, top: 200, bottom: 220 },
      bounds: dialogBounds,
      popoverWidth: 304,
      popoverHeight: 160,
    });
    expect(clampedRight.left + 304).toBeLessThanOrEqual(dialogBounds.width - 12);
  });
});
