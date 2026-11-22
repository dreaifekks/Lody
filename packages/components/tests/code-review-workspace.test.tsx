// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CodeNavDiffOutlineOk,
  CodeNavQueryRequest,
  CodeNavQueryResponse,
  MachineId,
  SessionId,
} from '@lody/shared';

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
    }: {
      fileDiff: { name: string };
      options?: {
        onTokenClick?: (
          props: {
            type: 'token';
            side: 'additions' | 'deletions';
            lineNumber: number;
            lineCharStart: number;
            lineCharEnd: number;
            tokenText: string;
            tokenElement: HTMLElement;
          },
          event: MouseEvent
        ) => void;
      };
    }) =>
      React.createElement(
        'div',
        { 'data-testid': `mock-file-diff:${fileDiff.name}` },
        React.createElement(
          'span',
          {
            'data-testid': `mock-token:${fileDiff.name}`,
            onClick: (event: React.MouseEvent<HTMLSpanElement>) => {
              options?.onTokenClick?.(
                {
                  type: 'token',
                  side: 'additions',
                  lineNumber: 19,
                  lineCharStart: 18,
                  lineCharEnd: 42,
                  tokenText: fileDiff.name.includes('capabilities')
                    ? 'broker.close'
                    : 'resolveSessionMcpServers',
                  tokenElement: event.currentTarget,
                },
                event.nativeEvent
              );
            },
          },
          fileDiff.name.includes('capabilities') ? 'broker.close' : 'resolveSessionMcpServers'
        ),
        React.createElement(
          'span',
          {
            'data-testid': `mock-deletion-token:${fileDiff.name}`,
            onClick: (event: React.MouseEvent<HTMLSpanElement>) => {
              options?.onTokenClick?.(
                {
                  type: 'token',
                  side: 'deletions',
                  lineNumber: 19,
                  lineCharStart: 18,
                  lineCharEnd: 42,
                  tokenText: 'resolveSessionMcpServers',
                  tokenElement: event.currentTarget,
                },
                event.nativeEvent
              );
            },
          },
          'resolveSessionMcpServers'
        )
      ),
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

import { WorktreeReviewWorkspace } from '../src/components/code-review/worktree-review-workspace';
import { WorktreeReviewFileView } from '../src/components/code-review/worktree-review-file-view';
import { sessionSupportsWorktreeReview } from '../src/components/code-review/worktree-review-open-context';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION_ID = 'sess-ws-1' as SessionId;
const MACHINE_ID = 'machine-ws-1' as MachineId;

const OUTLINE: CodeNavDiffOutlineOk = {
  type: 'code-nav/query',
  status: 'ok',
  action: 'diff-outline',
  files: [
    {
      path: 'apps/cli/src/agent/session-mcp-resolver.ts',
      symbols: [
        {
          name: 'loadSessionMcpCatalog',
          kind: 'function',
          startLine: 15,
          endLine: 24,
          hunkCount: 1,
        },
      ],
      hunks: [
        {
          startLine: 19,
          endLine: 21,
          enclosing: {
            name: 'loadSessionMcpCatalog',
            kind: 'function',
            startLine: 15,
            endLine: 24,
          },
        },
      ],
    },
    {
      path: 'apps/cli/src/agent/acp-capabilities.ts',
      symbols: [
        {
          name: 'cleanupSessionCapabilities',
          kind: 'function',
          startLine: 6,
          endLine: 10,
          hunkCount: 1,
        },
      ],
      hunks: [],
    },
  ],
  truncated: false,
  provider: 'ast-grep',
};

describe('WorktreeReviewWorkspace interactions', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('toggles directory collapse & nested symbols, jumps on exact Cmd+Click, shows candidates on heuristic Cmd+Click, and launches IDE with file:line', async () => {
    const openIde = vi.fn();
    const codeNavOverride = vi.fn(
      async (request: CodeNavQueryRequest): Promise<CodeNavQueryResponse> => {
        if (request.action === 'diff-outline') return OUTLINE;
        if (request.action === 'definition') {
          if (request.symbolHint === 'close') {
            return {
              type: 'code-nav/query',
              status: 'ok',
              action: 'definition',
              symbol: 'close',
              items: [
                {
                  path: 'apps/cli/src/agent/codex-credential-broker.ts',
                  line: 106,
                  character: 2,
                  name: 'close',
                  kind: 'method',
                  containerName: 'CredentialBroker',
                  previewLine: 'async close() {',
                },
              ],
              confidence: 'heuristic',
              totalCandidates: 516,
              truncated: true,
              provider: 'ast-grep',
            };
          }
          return {
            type: 'code-nav/query',
            status: 'ok',
            action: 'definition',
            symbol: 'resolveSessionMcpServers',
            items: [
              {
                path: 'packages/shared/src/workspace-mcp.ts',
                line: 32,
                character: 16,
                name: 'resolveSessionMcpServers',
                kind: 'function',
                previewLine: 'export function resolveSessionMcpServers(',
              },
            ],
            confidence: 'exact',
            totalCandidates: 1,
            truncated: false,
            provider: 'ast-grep',
          };
        }
        return {
          type: 'code-nav/query',
          status: 'ok',
          action: 'callers',
          symbol: request.action === 'callers' ? (request.symbolHint ?? '') : '',
          items: [
            {
              path: 'apps/cli/src/agent/session-mcp-resolver.ts',
              line: 19,
              character: 18,
              previewLine: 'resolveSessionMcpServers(catalog, requestedIds)',
              depth: 1,
              caller: {
                name: 'loadSessionMcpCatalog',
                kind: 'function',
                startLine: 15,
                endLine: 24,
              },
            },
          ],
          totalCandidates: 1,
          truncated: false,
          provider: 'ast-grep',
        };
      }
    );

    await act(async () => {
      root.render(
        createElement(WorktreeReviewWorkspace, {
          sessionId: SESSION_ID,
          machineId: MACHINE_ID,
          branchName: 'fix/agy-replay-leak',
          fileProvider: null,
          diffDataOverride: {
            filePaths: [
              'apps/cli/src/agent/session-mcp-resolver.ts',
              'apps/cli/src/agent/acp-capabilities.ts',
            ],
            resolvedByPath: {
              'apps/cli/src/agent/session-mcp-resolver.ts': {
                status: 'ready',
                oldSnapshot: { kind: 'text', text: 'const a = 1;\n' },
                newSnapshot: { kind: 'text', text: 'const a = 2;\n' },
              },
              'apps/cli/src/agent/acp-capabilities.ts': {
                status: 'ready',
                oldSnapshot: { kind: 'text', text: 'const b = 1;\n' },
                newSnapshot: { kind: 'text', text: 'const b = 2;\n' },
              },
            },
            statsByPath: {
              'apps/cli/src/agent/session-mcp-resolver.ts': {
                additions: 14,
                deletions: 3,
                firstLine: 19,
              },
              'apps/cli/src/agent/acp-capabilities.ts': {
                additions: 9,
                deletions: 2,
                firstLine: 8,
              },
            },
          },
          codeNavOverride,
          readFileOverride: async (filePath) => ({
            ok: true,
            text: `// content of ${filePath}\nexport function resolveSessionMcpServers() {}\n`,
          }),
          ideOverride: {
            canOpen: true,
            launcherLabel: 'VS Code',
            openWorktreeInIde: openIde,
          },
          onClose: vi.fn(),
        })
      );
    });

    // Compressed directory renders with nested changed symbols by default, and
    // each file card exposes `data-diff-path` for IntersectionObserver viewport loading.
    expect(container.querySelector('[data-tree-dir="apps/cli/src/agent"]')).not.toBeNull();
    expect(container.querySelector('[data-tree-symbol="loadSessionMcpCatalog"]')).not.toBeNull();
    expect(
      container.querySelector(
        'section[data-diff-path="apps/cli/src/agent/session-mcp-resolver.ts"]'
      )
    ).not.toBeNull();
    expect(
      container.querySelector('section[data-diff-path="apps/cli/src/agent/acp-capabilities.ts"]')
    ).not.toBeNull();

    // Tree toggle button collapses and restores the left file tree.
    expect(container.querySelector('[data-worktree-review-tree]')).not.toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-review-toggle-tree]')!.click();
    });
    expect(container.querySelector('[data-worktree-review-tree]')).toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-review-toggle-tree]')!.click();
    });
    expect(container.querySelector('[data-worktree-review-tree]')).not.toBeNull();

    // Deletion-side tokens must NOT trigger definition/callers lookups on Cmd+Click or plain click.
    const callsBeforeDeletionClick = codeNavOverride.mock.calls.length;
    await act(async () => {
      container
        .querySelector(
          '[data-testid="mock-deletion-token:apps/cli/src/agent/session-mcp-resolver.ts"]'
        )!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
      container
        .querySelector(
          '[data-testid="mock-deletion-token:apps/cli/src/agent/session-mcp-resolver.ts"]'
        )!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(codeNavOverride.mock.calls.length).toBe(callsBeforeDeletionClick);
    expect(document.querySelector('[data-worktree-review-popover]')).toBeNull();
    expect(container.querySelector('[data-worktree-review-file-view]')).toBeNull();

    // Toggling `ƒ 符号` hides nested symbols while keeping files visible.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-worktree-review-symbol-toggle]')!.click();
    });
    expect(container.querySelector('[data-tree-symbol="loadSessionMcpCatalog"]')).toBeNull();
    expect(
      container.querySelector('[data-tree-file="apps/cli/src/agent/session-mcp-resolver.ts"]')
    ).not.toBeNull();

    // Top IDE button opens worktree with active file and line.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-review-open-ide-top]')!.click();
    });
    expect(openIde).toHaveBeenLastCalledWith({
      filePath: 'apps/cli/src/agent/session-mcp-resolver.ts',
      line: 19,
    });

    // Cmd+Click on heuristic `close` does NOT blind-jump; opens candidate picker with total badge.
    await act(async () => {
      container
        .querySelector('[data-testid="mock-token:apps/cli/src/agent/acp-capabilities.ts"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
    });
    expect(document.querySelector('[data-worktree-review-popover="candidates"]')).not.toBeNull();
    expect(document.querySelector('[data-worktree-review-candidate-badge]')?.textContent).toContain(
      '516'
    );
    expect(container.querySelector('[data-worktree-review-file-view]')).toBeNull();

    // Pressing Escape dismisses the popover.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[data-worktree-review-popover]')).toBeNull();

    // Cmd+Click on exact single `resolveSessionMcpServers` jumps directly into <File> view
    // while keeping Diff mounted (hidden) and pushing a breadcrumb.
    await act(async () => {
      container
        .querySelector('[data-testid="mock-token:apps/cli/src/agent/session-mcp-resolver.ts"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
    });
    expect(
      container.querySelector(
        '[data-worktree-review-file-view="packages/shared/src/workspace-mcp.ts"]'
      )
    ).not.toBeNull();
    expect(container.querySelector('[data-review-diff-scroll]')?.hasAttribute('hidden')).toBe(true);
    expect(container.querySelector('[data-review-crumb="1"]')?.textContent).toBe(
      'resolveSessionMcpServers'
    );

    // Clicking the root Diff breadcrumb pops back and unhides the keep-alive Diff view.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-review-crumb="0"]')!.click();
    });
    expect(container.querySelector('[data-review-diff-scroll]')?.hasAttribute('hidden')).toBe(
      false
    );
    expect(container.querySelector('[data-worktree-review-file-view]')).toBeNull();
  });

  it('gates review affordance strictly to non-archived project or worktree sessions', () => {
    expect(sessionSupportsWorktreeReview(null)).toBe(false);
    expect(sessionSupportsWorktreeReview({ isWorktree: false, isArchived: false })).toBe(false);
    expect(
      sessionSupportsWorktreeReview({
        project: { kind: 'local', localProjectId: 'p1' as never },
        isArchived: true,
      })
    ).toBe(false);
    expect(
      sessionSupportsWorktreeReview({
        project: { kind: 'local', localProjectId: 'p1' as never },
        isArchived: false,
      })
    ).toBe(true);
    expect(sessionSupportsWorktreeReview({ isWorktree: true, isArchived: false })).toBe(true);
  });

  it('displays terminal fileProviderMessage instead of permanent loading skeleton when provider fails', async () => {
    await act(async () => {
      root.render(
        createElement(WorktreeReviewWorkspace, {
          sessionId: SESSION_ID,
          machineId: MACHINE_ID,
          fileProvider: null,
          fileProviderPending: false,
          fileProviderMessage: 'Remote file index unavailable',
          codeNavOverride: async () => OUTLINE,
          onClose: vi.fn(),
        })
      );
    });

    expect(container.textContent).toContain('Remote file index unavailable');
    expect(container.querySelector('[data-review-diff-scroll]')?.textContent).toContain(
      'Remote file index unavailable'
    );
  });

  it('reads paged-text files past 512 KiB (up to 1 MiB) so definitions in large local files are not truncated', async () => {
    // 10 pages of 64 KiB = 640 KiB total (> old 512 KiB / 8-page cap, <= 1 MiB).
    const lineText = `${'x'.repeat(63)}\n`; // 64 bytes per line -> 1024 lines per 64 KiB page
    const pageText = lineText.repeat(1024);
    const totalPages = 10;
    const totalBytes = pageText.length * totalPages;
    const targetLine = 9500; // sits on page 10 (> 512 KiB)
    const readPage = vi.fn(async (_pageIndex: number) => pageText);

    const fileProvider = {
      openFile: vi.fn(async () => ({
        status: 'ok' as const,
        snapshot: {
          kind: 'paged-text' as const,
          source: {
            sizeBytes: totalBytes,
            pageBytes: pageText.length,
            readPage,
          },
        },
      })),
    } as unknown as Parameters<typeof WorktreeReviewFileView>[0]['fileProvider'];

    await act(async () => {
      root.render(
        createElement(WorktreeReviewFileView, {
          filePath: 'src/large-file.ts',
          line: targetLine,
          fileProvider,
          canOpenInIde: false,
          codeNavSupported: false,
          onBackToDiff: vi.fn(),
          onTokenClick: vi.fn(),
          onSelectCaller: vi.fn(),
          onTraceCallerFurther: vi.fn(),
          onOpenInIde: vi.fn(),
        })
      );
    });

    // Must read all 10 pages (> 8) to cover line 9500 within the 1 MiB budget.
    expect(readPage).toHaveBeenCalledTimes(10);
    const rendered = container.querySelector(
      '[data-testid="mock-readonly-file:src/large-file.ts"]'
    );
    expect(rendered).not.toBeNull();
    expect(rendered!.textContent!.split('\n').length).toBeGreaterThan(targetLine);
  });

  it('closes an open token popover when diff data refreshes so stale preview targets cannot be jumped to', async () => {
    const queryOverride = vi.fn(async (req: CodeNavQueryRequest) => {
      if (req.action === 'diff-outline') return OUTLINE;
      if (req.action === 'definition') return DEF_EXACT;
      return CALLERS_RESULT;
    });

    const initialDiffOverride = {
      status: 'ready' as const,
      filePaths: ['apps/cli/src/agent/session-mcp-resolver.ts'],
      resolvedByPath: {
        'apps/cli/src/agent/session-mcp-resolver.ts': {
          status: 'ready' as const,
          oldSnapshot: { kind: 'text' as const, text: 'old\n' },
          newSnapshot: { kind: 'text' as const, text: 'new\n' },
          baseRef: 'lan-hub',
        },
      },
      base: 'lan-hub',
      diffScope: 'branch' as const,
      loading: false,
      error: null,
    };

    await act(async () => {
      root.render(
        createElement(WorktreeReviewWorkspace, {
          sessionId: SESSION_ID,
          machineId: MACHINE_ID,
          fileProvider: null,
          diffDataOverride: initialDiffOverride,
          codeNavOverride: queryOverride,
          readFileOverride: async () => ({ ok: true as const, text: 'export function a() {}\n' }),
          onClose: vi.fn(),
        })
      );
    });

    // Click token (without metaKey) to open popover and load preview.
    await act(async () => {
      container
        .querySelector('[data-testid="mock-token:apps/cli/src/agent/session-mcp-resolver.ts"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.querySelector('[data-worktree-review-popover]')).not.toBeNull();

    // Refresh diffDataOverride -> open popover must close immediately.
    const refreshedDiffOverride = {
      ...initialDiffOverride,
      base: 'lan-hub-2',
    };
    await act(async () => {
      root.render(
        createElement(WorktreeReviewWorkspace, {
          sessionId: SESSION_ID,
          machineId: MACHINE_ID,
          fileProvider: null,
          diffDataOverride: refreshedDiffOverride,
          codeNavOverride: queryOverride,
          readFileOverride: async () => ({ ok: true as const, text: 'export function b() {}\n' }),
          onClose: vi.fn(),
        })
      );
    });
    expect(document.querySelector('[data-worktree-review-popover]')).toBeNull();
  });

  it('reloads file A cleanly when returning from an in-flight file B instead of sticking in loading skeleton', async () => {
    let resolveB: ((res: { ok: true; text: string }) => void) | null = null;
    const readFileOverride = vi.fn((path: string) => {
      if (path === 'src/a.ts') {
        return Promise.resolve({ ok: true as const, text: 'export const A = 1;\n' });
      }
      return new Promise<{ ok: true; text: string }>((resolve) => {
        resolveB = resolve;
      });
    });

    const renderView = (filePath: string) =>
      createElement(WorktreeReviewFileView, {
        filePath,
        line: 1,
        fileProvider: null,
        readFileOverride,
        canOpenInIde: false,
        codeNavSupported: false,
        onBackToDiff: vi.fn(),
        onTokenClick: vi.fn(),
        onSelectCaller: vi.fn(),
        onTraceCallerFurther: vi.fn(),
        onOpenInIde: vi.fn(),
      });

    // 1. Load file A to ready.
    await act(async () => {
      root.render(renderView('src/a.ts'));
    });
    expect(container.querySelector('[data-testid="mock-readonly-file:src/a.ts"]')).not.toBeNull();

    // 2. Navigate to slow-loading file B (puts view in loading state).
    await act(async () => {
      root.render(renderView('src/b.ts'));
    });
    expect(container.querySelector('[data-testid="mock-readonly-file:src/a.ts"]')).toBeNull();

    // 3. Before B settles, return to file A -> must reload A and render ready content.
    await act(async () => {
      root.render(renderView('src/a.ts'));
    });
    expect(container.querySelector('[data-testid="mock-readonly-file:src/a.ts"]')).not.toBeNull();

    // 4. Late settlement of B must be ignored and keep A visible.
    await act(async () => {
      resolveB?.({ ok: true, text: 'export const B = 2;\n' });
    });
    expect(container.querySelector('[data-testid="mock-readonly-file:src/a.ts"]')).not.toBeNull();
  });
});
