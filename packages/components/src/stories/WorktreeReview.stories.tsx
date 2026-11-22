import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import type {
  CodeNavCallersOk,
  CodeNavDefinitionOk,
  CodeNavDiffOutlineOk,
  CodeNavQueryRequest,
  CodeNavQueryResponse,
  MachineId,
  SessionId,
} from '@lody/shared';
import { PopupContainerProvider } from '@lody/ui/popup-container';
import { BoardArticleDialog } from '@/components/boards/board-article-dialog';
import { createRelocatableHost } from '@/components/boards/relocatable-host';
import {
  WorktreeReviewWorkspace,
  type WorktreeReviewDiffDataOverride,
} from '@/components/code-review/worktree-review-workspace';
import type { WorktreeReviewReadFileFn } from '@/components/code-review/worktree-review-file-view';
import {
  createInitialReviewNavStack,
  pushReviewFileFrame,
  type WorktreeReviewNavStack,
} from '@/components/code-review/worktree-review-nav-model';
import type { WorktreeReviewTokenPopoverState } from '@/components/code-review/worktree-review-token-popover';

const DEMO_SESSION_ID = 'story-review-session' as SessionId;
const DEMO_MACHINE_ID = 'story-review-machine' as MachineId;

const MCP_RESOLVER_OLD = `import type { WorkspaceMcpServerMeta } from '@lody/shared';
import { resolveSessionMcpServers } from '@lody/shared';

export interface SessionMcpContext {
  readonly workspaceId: string;
  readonly machineId: string;
  readonly resumeMode: 'session/load' | 'session/resume';
  readonly turnSelection?: readonly string[];
  readonly project?: { readonly defaultMcpServerIds?: readonly string[] };
  readonly store: {
    listWorkspaceMcpServers(workspaceId: string): Promise<WorkspaceMcpServerMeta[]>;
  };
}

export async function loadSessionMcpCatalog(ctx: SessionMcpContext) {
  const defaults = ctx.project?.defaultMcpServerIds ?? [];
  const catalog = await ctx.store.listWorkspaceMcpServers(ctx.workspaceId);
  const requestedIds = ctx.turnSelection ?? defaults;
  return resolveSessionMcpServers(catalog, requestedIds);
}
`;

const MCP_RESOLVER_NEW = `import type { WorkspaceMcpServerMeta } from '@lody/shared';
import { resolveSessionMcpServers } from '@lody/shared';

export interface SessionMcpContext {
  readonly workspaceId: string;
  readonly machineId: string;
  readonly resumeMode: 'session/load' | 'session/resume';
  readonly turnSelection?: readonly string[];
  readonly project?: { readonly defaultMcpServerIds?: readonly string[] };
  readonly store: {
    listWorkspaceMcpServers(workspaceId: string): Promise<WorkspaceMcpServerMeta[]>;
  };
}

export async function loadSessionMcpCatalog(ctx: SessionMcpContext) {
  const defaults = ctx.project?.defaultMcpServerIds ?? [];
  const catalog = await ctx.store.listWorkspaceMcpServers(ctx.workspaceId);
  const requestedIds = ctx.turnSelection ?? defaults;
  const resolved = resolveSessionMcpServers(catalog, requestedIds, {
    preserveProjectDefaults: ctx.resumeMode === 'session/resume',
    machineId: ctx.machineId,
  });
  return resolved;
}
`;

const CAPABILITIES_OLD = `export interface CredentialBroker {
  readonly isActive: boolean;
  close(): Promise<void>;
}

export async function cleanupSessionCapabilities(broker: CredentialBroker) {
  if (broker.isActive) {
    // Broker kept alive previously.
  }
}
`;

const CAPABILITIES_NEW = `export interface CredentialBroker {
  readonly isActive: boolean;
  close(): Promise<void>;
}

export async function cleanupSessionCapabilities(broker: CredentialBroker) {
  if (broker.isActive) {
    await broker.close();
  }
}
`;

const AGENT_CLIENT_OLD = `import { loadSessionMcpCatalog } from './session-mcp-resolver';

export class AgentClient {
  constructor(private readonly workspaceId: string) {}

  async startSession(spec: { readonly kind: string }) {
    const resumeMode = 'session/load';
    const mcp = await loadSessionMcpCatalog({
      workspaceId: this.workspaceId,
      machineId: 'devNuc',
      resumeMode,
      store: { listWorkspaceMcpServers: async () => [] },
    });
    return { resumeMode, mcp };
  }
}
`;

const AGENT_CLIENT_NEW = `import { loadSessionMcpCatalog } from './session-mcp-resolver';

function isAntigravityServer(spec: { readonly kind: string }): boolean {
  return spec.kind === 'antigravity';
}

export class AgentClient {
  constructor(private readonly workspaceId: string) {}

  async startSession(spec: { readonly kind: string }) {
    const resumeMode = isAntigravityServer(spec) ? 'session/resume' : 'session/load';
    const mcp = await loadSessionMcpCatalog({
      workspaceId: this.workspaceId,
      machineId: 'devNuc',
      resumeMode,
      store: { listWorkspaceMcpServers: async () => [] },
    });
    return { resumeMode, mcp };
  }
}
`;

const WORKSPACE_MCP_FILE = `export interface WorkspaceMcpServer {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
}

export interface ResolveMcpOptions {
  readonly preserveProjectDefaults?: boolean;
  readonly machineId?: string;
}

export interface ResolvedMcpResult {
  readonly activeIds: readonly string[];
  readonly servers: readonly WorkspaceMcpServer[];
}

function filterEnabledMcp(
  byId: ReadonlyMap<string, WorkspaceMcpServer>,
  requestedIds: readonly string[],
  options?: ResolveMcpOptions
): ResolvedMcpResult {
  const servers: WorkspaceMcpServer[] = [];
  for (const id of requestedIds) {
    const server = byId.get(id);
    if (server && (server.enabled || options?.preserveProjectDefaults)) {
      servers.push(server);
    }
  }
  return { activeIds: servers.map((s) => s.id), servers };
}

export function resolveSessionMcpServers(
  catalog: WorkspaceMcpServer[],
  requestedIds: readonly string[],
  options?: ResolveMcpOptions
): ResolvedMcpResult {
  const byId = new Map(catalog.map((s) => [s.id, s]));
  return filterEnabledMcp(byId, requestedIds, options);
}
`;

const COMPACT_ROW_OLD = `export function CompactWorkHeaderRow({ title }: { readonly title: string }) {
  return <header className="truncate text-xs">{title}</header>;
}
`;

const COMPACT_ROW_NEW = `export function CompactWorkHeaderRow({
  title,
  count,
}: {
  readonly title: string;
  readonly count: number;
}) {
  return (
    <header className="flex items-center justify-between gap-2 text-xs">
      <span className="truncate">{title}</span>
      <span className="tabular-nums text-muted-foreground">{count}</span>
    </header>
  );
}
`;

const THOUGHT_PREVIEW_OLD = `export function inspectLatestThoughtParagraph(raw: string): string {
  return raw.trim();
}
`;

const THOUGHT_PREVIEW_NEW = `export function inspectLatestThoughtParagraph(raw: string): string {
  const blocks = raw
    .split(/\\n\\s*\\n/u)
    .map((block) => block.trim())
    .filter(Boolean);
  return blocks[blocks.length - 1] ?? '';
}
`;

const SYNTHETIC_FILES: Record<string, string> = {
  'apps/cli/src/agent/session-mcp-resolver.ts': MCP_RESOLVER_NEW,
  'apps/cli/src/agent/acp-capabilities.ts': CAPABILITIES_NEW,
  'apps/cli/src/agent/agent-client.ts': AGENT_CLIENT_NEW,
  'packages/shared/src/workspace-mcp.ts': WORKSPACE_MCP_FILE,
  'packages/components/src/components/ai-gui/compact-native-directory-row.tsx': COMPACT_ROW_NEW,
  'packages/components/src/components/ai-gui/streaming-thought-preview.ts': THOUGHT_PREVIEW_NEW,
};

const SYNTHETIC_DIFF_DATA: WorktreeReviewDiffDataOverride = {
  base: '00a63444b91234',
  filePaths: [
    'apps/cli/src/agent/session-mcp-resolver.ts',
    'apps/cli/src/agent/acp-capabilities.ts',
    'apps/cli/src/agent/agent-client.ts',
    'packages/components/src/components/ai-gui/compact-native-directory-row.tsx',
    'packages/components/src/components/ai-gui/streaming-thought-preview.ts',
  ],
  resolvedByPath: {
    'apps/cli/src/agent/session-mcp-resolver.ts': {
      status: 'ready',
      oldSnapshot: { kind: 'text', text: MCP_RESOLVER_OLD },
      newSnapshot: { kind: 'text', text: MCP_RESOLVER_NEW },
    },
    'apps/cli/src/agent/acp-capabilities.ts': {
      status: 'ready',
      oldSnapshot: { kind: 'text', text: CAPABILITIES_OLD },
      newSnapshot: { kind: 'text', text: CAPABILITIES_NEW },
    },
    'apps/cli/src/agent/agent-client.ts': {
      status: 'ready',
      oldSnapshot: { kind: 'text', text: AGENT_CLIENT_OLD },
      newSnapshot: { kind: 'text', text: AGENT_CLIENT_NEW },
    },
    'packages/components/src/components/ai-gui/compact-native-directory-row.tsx': {
      status: 'ready',
      oldSnapshot: { kind: 'text', text: COMPACT_ROW_OLD },
      newSnapshot: { kind: 'text', text: COMPACT_ROW_NEW },
    },
    'packages/components/src/components/ai-gui/streaming-thought-preview.ts': {
      status: 'ready',
      oldSnapshot: { kind: 'text', text: THOUGHT_PREVIEW_OLD },
      newSnapshot: { kind: 'text', text: THOUGHT_PREVIEW_NEW },
    },
  },
  statsByPath: {
    'apps/cli/src/agent/session-mcp-resolver.ts': { additions: 5, deletions: 1, firstLine: 19 },
    'apps/cli/src/agent/acp-capabilities.ts': { additions: 1, deletions: 1, firstLine: 8 },
    'apps/cli/src/agent/agent-client.ts': { additions: 5, deletions: 1, firstLine: 11 },
    'packages/components/src/components/ai-gui/compact-native-directory-row.tsx': {
      additions: 12,
      deletions: 2,
      firstLine: 1,
    },
    'packages/components/src/components/ai-gui/streaming-thought-preview.ts': {
      additions: 6,
      deletions: 1,
      firstLine: 2,
    },
  },
};

const SYNTHETIC_OUTLINE: CodeNavDiffOutlineOk = {
  type: 'code-nav/query',
  status: 'ok',
  action: 'diff-outline',
  headSha: 'cb716bebb',
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
          endLine: 23,
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
      hunks: [
        {
          startLine: 8,
          endLine: 8,
          enclosing: {
            name: 'cleanupSessionCapabilities',
            kind: 'function',
            startLine: 6,
            endLine: 10,
          },
        },
      ],
    },
    {
      path: 'apps/cli/src/agent/agent-client.ts',
      symbols: [
        {
          name: 'startSession',
          kind: 'method',
          containerName: 'AgentClient',
          startLine: 10,
          endLine: 19,
          hunkCount: 1,
        },
      ],
      hunks: [
        {
          startLine: 11,
          endLine: 12,
          enclosing: {
            name: 'startSession',
            kind: 'method',
            containerName: 'AgentClient',
            startLine: 10,
            endLine: 19,
          },
        },
      ],
    },
    {
      path: 'packages/components/src/components/ai-gui/compact-native-directory-row.tsx',
      symbols: [
        {
          name: 'CompactWorkHeaderRow',
          kind: 'component',
          startLine: 1,
          endLine: 14,
          hunkCount: 1,
        },
      ],
      hunks: [
        {
          startLine: 1,
          endLine: 14,
          enclosing: {
            name: 'CompactWorkHeaderRow',
            kind: 'component',
            startLine: 1,
            endLine: 14,
          },
        },
      ],
    },
    {
      path: 'packages/components/src/components/ai-gui/streaming-thought-preview.ts',
      symbols: [
        {
          name: 'inspectLatestThoughtParagraph',
          kind: 'function',
          startLine: 1,
          endLine: 7,
          hunkCount: 1,
        },
      ],
      hunks: [
        {
          startLine: 2,
          endLine: 6,
          enclosing: {
            name: 'inspectLatestThoughtParagraph',
            kind: 'function',
            startLine: 1,
            endLine: 7,
          },
        },
      ],
    },
  ],
  truncated: false,
  provider: 'ast-grep',
};

const SYNTHETIC_CALLERS_RESOLVE: CodeNavCallersOk = {
  type: 'code-nav/query',
  status: 'ok',
  action: 'callers',
  symbol: 'resolveSessionMcpServers',
  items: [
    {
      path: 'apps/cli/src/agent/session-mcp-resolver.ts',
      line: 19,
      character: 19,
      previewLine: 'const resolved = resolveSessionMcpServers(catalog, requestedIds, {',
      depth: 1,
      caller: {
        name: 'loadSessionMcpCatalog',
        kind: 'function',
        startLine: 15,
        endLine: 24,
      },
    },
    {
      path: 'apps/cli/src/agent/agent-client.ts',
      line: 12,
      character: 22,
      previewLine:
        'const mcp = await loadSessionMcpCatalog({ workspaceId: this.workspaceId, ... })',
      depth: 2,
      viaSymbol: 'loadSessionMcpCatalog',
      caller: {
        name: 'startSession',
        kind: 'method',
        containerName: 'AgentClient',
        startLine: 10,
        endLine: 19,
      },
    },
  ],
  totalCandidates: 2,
  truncated: false,
  provider: 'ast-grep',
};

const SYNTHETIC_CALLERS_CATALOG: CodeNavCallersOk = {
  type: 'code-nav/query',
  status: 'ok',
  action: 'callers',
  symbol: 'loadSessionMcpCatalog',
  items: [
    {
      path: 'apps/cli/src/agent/agent-client.ts',
      line: 12,
      character: 22,
      previewLine:
        'const mcp = await loadSessionMcpCatalog({ workspaceId: this.workspaceId, ... })',
      depth: 1,
      caller: {
        name: 'startSession',
        kind: 'method',
        containerName: 'AgentClient',
        startLine: 10,
        endLine: 19,
      },
    },
  ],
  totalCandidates: 1,
  truncated: false,
  provider: 'ast-grep',
};

const SYNTHETIC_CLOSE_DEF: CodeNavDefinitionOk = {
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
      previewLine: 'async close(): Promise<void> {',
    },
    {
      path: 'apps/cli/src/agent/codex-credential-broker.ts',
      line: 10,
      character: 2,
      name: 'close',
      kind: 'method',
      containerName: 'CredentialBroker',
      previewLine: 'close(): Promise<void>;',
    },
    {
      path: 'apps/cli/src/agent/codex-profile-runtime.ts',
      line: 88,
      character: 2,
      name: 'close',
      kind: 'method',
      previewLine: 'close(): void {',
    },
  ],
  confidence: 'heuristic',
  totalCandidates: 516,
  truncated: true,
  provider: 'ast-grep',
};

async function syntheticCodeNavQuery(request: CodeNavQueryRequest): Promise<CodeNavQueryResponse> {
  if (request.action === 'diff-outline') {
    return SYNTHETIC_OUTLINE;
  }
  if (request.action === 'definition') {
    if (request.symbolHint === 'close') return SYNTHETIC_CLOSE_DEF;
    return {
      type: 'code-nav/query',
      status: 'ok',
      action: 'definition',
      symbol: request.symbolHint ?? 'resolveSessionMcpServers',
      items: [
        {
          path: 'packages/shared/src/workspace-mcp.ts',
          line: 32,
          character: 16,
          endLine: 39,
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
  if (request.action === 'callers') {
    if (request.symbolHint === 'loadSessionMcpCatalog') return SYNTHETIC_CALLERS_CATALOG;
    return SYNTHETIC_CALLERS_RESOLVE;
  }
  return {
    type: 'code-nav/query',
    status: 'ok',
    action: 'enclosing',
    path: request.path,
    chain: [],
    provider: 'ast-grep',
  };
}

const syntheticReadFile: WorktreeReviewReadFileFn = async (filePath) => {
  const text = SYNTHETIC_FILES[filePath];
  if (text !== undefined) return { ok: true, text };
  return { ok: false, message: `Not found: ${filePath}` };
};

function SyntheticThreadChatPane() {
  return (
    <aside className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-3.5 text-[12.5px] font-medium">
        <span className="truncate">fix/agy-replay-leak</span>
        <span className="font-mono text-[11px] text-muted-foreground">cb716bebb</span>
      </div>
      <div className="flex flex-1 flex-col gap-3.5 overflow-y-auto p-3.5 text-[12.5px] leading-relaxed">
        <div className="self-end max-w-[90%] rounded-xl bg-foreground/[0.06] px-3 py-2">
          排查会话恢复时的回放泄漏问题，修完后在本地 commit 等我 review。
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="text-[11.5px] text-muted-foreground">Worked for 1m 42s</div>
          <div>
            已切换恢复路径为{' '}
            <code className="rounded bg-foreground/[0.06] px-1 py-0.5 font-mono text-[11.5px]">
              session/resume
            </code>
            ，并在{' '}
            <code className="rounded bg-foreground/[0.06] px-1 py-0.5 font-mono text-[11.5px]">
              loadSessionMcpCatalog
            </code>{' '}
            保留项目默认 MCP 集合，同时清理过期 broker。
          </div>
        </div>
      </div>
      <div className="m-3 flex items-center justify-between rounded-xl border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
        <span>向该线程追问或提修改意见…</span>
        <kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-[10.5px]">⌘↵</kbd>
      </div>
    </aside>
  );
}

function StoryFrame({
  initialNavStack,
  initialPopover = null,
}: {
  readonly initialNavStack?: WorktreeReviewNavStack;
  readonly initialPopover?: WorktreeReviewTokenPopoverState | null;
}) {
  const threadHost = useMemo(() => createRelocatableHost(), []);
  const [panel, setPanel] = useState<HTMLElement | null>(null);
  const onOpenIde = useMemo(() => fn(), []);
  const onClose = useMemo(() => fn(), []);

  return (
    <div className="h-screen w-screen bg-[hsl(var(--sidebar-background))]">
      {createPortal(<SyntheticThreadChatPane />, threadHost.node)}
      <BoardArticleDialog
        title="Worktree Review"
        wide
        threadHost={threadHost}
        holdsThread
        onPanelChange={setPanel}
        onClose={onClose}
        article={
          <PopupContainerProvider container={panel}>
            <WorktreeReviewWorkspace
              sessionId={DEMO_SESSION_ID}
              machineId={DEMO_MACHINE_ID}
              branchName="fix/agy-replay-leak"
              fileProvider={null}
              diffDataOverride={SYNTHETIC_DIFF_DATA}
              codeNavOverride={syntheticCodeNavQuery}
              readFileOverride={syntheticReadFile}
              ideOverride={{
                canOpen: true,
                launcherLabel: 'VS Code',
                openWorktreeInIde: onOpenIde,
              }}
              initialNavStack={initialNavStack}
              initialPopover={initialPopover}
              onClose={onClose}
            />
          </PopupContainerProvider>
        }
      />
    </div>
  );
}

const meta = {
  title: 'CodeReview/WorktreeReview',
  component: StoryFrame,
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof StoryFrame>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DiffWithFileTree: Story = {
  args: {},
};

const TRACED_NAV_STACK: WorktreeReviewNavStack = pushReviewFileFrame(
  createInitialReviewNavStack('apps/cli/src/agent/session-mcp-resolver.ts', 19),
  {
    kind: 'file',
    label: 'resolveSessionMcpServers',
    filePath: 'packages/shared/src/workspace-mcp.ts',
    line: 32,
    endLine: 36,
    callers: SYNTHETIC_CALLERS_RESOLVE,
    callersSymbol: 'resolveSessionMcpServers',
    callersHopDepth: 1,
  }
);

export const TracedDefinitionAndCallers: Story = {
  args: {
    initialNavStack: TRACED_NAV_STACK,
  },
};

const HEURISTIC_POPOVER: WorktreeReviewTokenPopoverState = {
  mode: 'candidates',
  symbol: 'close',
  filePath: 'apps/cli/src/agent/acp-capabilities.ts',
  line: 8,
  character: 17,
  anchor: { left: 460, top: 340, bottom: 360 },
  items: SYNTHETIC_CLOSE_DEF.items,
  confidence: 'heuristic',
  totalCandidates: 516,
};

export const HeuristicCandidatesPopover: Story = {
  args: {
    initialPopover: HEURISTIC_POPOVER,
  },
};
