import { describe, expect, it, vi } from 'vitest';

import type {
  McpServerId,
  SessionId,
  WorkspaceFlockReadableFlock,
  WorkspaceId,
} from '@lody/shared';
import { loadSessionMcpCatalog, loadSessionWorkspaceSettings } from './session-mcp-resolver';

const workspaceId = 'workspace-1' as WorkspaceId;
const sessionId = 'session-1' as SessionId;
const selectedId = 'server-1' as McpServerId;

const flockWithRows = (rows: Array<{ key: readonly unknown[]; value: unknown }>) =>
  ({
    scan: ({ prefix }: { prefix?: readonly unknown[] } = {}) =>
      rows.filter(({ key }) => prefix?.every((part, index) => key[index] === part) ?? true),
  }) satisfies WorkspaceFlockReadableFlock;

const catalogFlock = flockWithRows([
  {
    key: ['mcpServer', selectedId],
    value: {
      id: selectedId,
      name: 'filesystem',
      transport: 'stdio',
      connection: {
        transport: 'stdio',
        command: '${NODE_BIN}',
        args: ['${ENTRYPOINT}'],
      },
      createdAt: 1,
      updatedAt: 1,
    },
  },
]);

describe('loadSessionMcpCatalog', () => {
  it('does not open or sync a document for an empty selection', async () => {
    const openFlockDoc = vi.fn();
    const syncFlockDoc = vi.fn();
    const select = await loadSessionMcpCatalog({
      repo: { openFlockDoc },
      syncFlockDoc,
      workspaceId,
      sessionId,
      selectedIds: [],
      logger: { debug: vi.fn() },
    });
    expect(select(undefined)).toEqual({ servers: [], problems: [] });
    expect(openFlockDoc).not.toHaveBeenCalled();
    expect(syncFlockDoc).not.toHaveBeenCalled();
  });

  it('reads the catalog and expands target-daemon environment variables', async () => {
    const select = await loadSessionMcpCatalog({
      repo: { openFlockDoc: vi.fn(async () => ({ flock: catalogFlock })) },
      workspaceId,
      sessionId,
      selectedIds: [selectedId],
      logger: { debug: vi.fn() },
      env: { NODE_BIN: 'node', ENTRYPOINT: 'server.js' },
    });
    expect(select(undefined)).toEqual({
      servers: [{ name: 'filesystem', command: 'node', args: ['server.js'], env: [] }],
      problems: [],
    });
  });

  it('finishes every read before the agent capabilities are known', async () => {
    const openFlockDoc = vi.fn(async () => ({ flock: catalogFlock }));
    const select = await loadSessionMcpCatalog({
      repo: { openFlockDoc },
      workspaceId,
      sessionId,
      selectedIds: [selectedId],
      logger: { debug: vi.fn() },
      env: { NODE_BIN: 'node', ENTRYPOINT: 'server.js' },
    });
    expect(openFlockDoc).toHaveBeenCalledTimes(1);

    // Selecting twice with different capabilities must not touch the document
    // again: the load phase is what ACP startup overlaps with its handshake.
    expect(select({ http: true }).servers).toHaveLength(1);
    expect(select({ http: false }).servers).toHaveLength(1);
    expect(openFlockDoc).toHaveBeenCalledTimes(1);
  });

  it('turns catalog read failures into catalog_unavailable', async () => {
    const select = await loadSessionMcpCatalog({
      repo: { openFlockDoc: vi.fn(async () => Promise.reject(new Error('database unavailable'))) },
      workspaceId,
      sessionId,
      selectedIds: [selectedId],
      logger: { debug: vi.fn() },
    });
    const result = select(undefined);
    expect(result.servers).toEqual([]);
    expect(result.problems).toEqual([
      { kind: 'catalog_unavailable', reason: 'database unavailable' },
    ]);
  });

  it('refreshes first and falls back to local rows if refresh fails', async () => {
    const order: string[] = [];
    const syncFlockDoc = vi.fn(async () => {
      order.push('sync');
      throw new Error('offline');
    });
    const openFlockDoc = vi.fn(async () => {
      order.push('open');
      return { flock: catalogFlock };
    });
    const select = await loadSessionMcpCatalog({
      repo: { openFlockDoc },
      syncFlockDoc,
      workspaceId,
      sessionId,
      selectedIds: [selectedId],
      logger: { debug: vi.fn() },
      env: { NODE_BIN: 'node', ENTRYPOINT: 'server.js' },
    });
    expect(order).toEqual(['sync', 'open']);
    expect(syncFlockDoc).toHaveBeenCalledWith('workspace-1:wf:workspace', { timeoutMs: 5_000 });
    expect(select(undefined).servers).toHaveLength(1);
  });
});

describe('loadSessionWorkspaceSettings', () => {
  const switchRow = { key: ['setting', 'promptSuggestions'], value: { version: 1 } };

  /** This machine's copy of the workspace document, which a sync brings up to date. */
  const workspaceCopy = (local: boolean, remote: boolean | Error) => {
    let rows = local ? [switchRow] : [];
    return {
      repo: { openFlockDoc: vi.fn(async () => ({ flock: flockWithRows(rows) })) },
      syncFlockDoc: vi.fn(async () => {
        if (remote instanceof Error) throw remote;
        rows = remote ? [switchRow] : [];
      }),
    };
  };

  it.each([
    { local: false, remote: true, expected: true },
    { local: true, remote: false, expected: false },
  ])(
    'syncs before reading even with no MCP servers selected ($local -> $remote)',
    async ({ local, remote, expected }) => {
      const copy = workspaceCopy(local, remote);
      // The MCP catalog skips its sync for an empty selection...
      await loadSessionMcpCatalog({
        ...copy,
        workspaceId,
        sessionId,
        selectedIds: [],
        logger: { debug: vi.fn() },
      });
      // ...and the switch still reads what other devices set.
      await expect(
        loadSessionWorkspaceSettings({
          ...copy,
          workspaceId,
          sessionId,
          logger: { debug: vi.fn() },
        })
      ).resolves.toMatchObject({ promptSuggestions: expected });
    }
  );

  it('reads the local copy when the sync fails', async () => {
    const copy = workspaceCopy(true, new Error('offline'));
    await expect(
      loadSessionWorkspaceSettings({
        ...copy,
        workspaceId,
        sessionId,
        logger: { debug: vi.fn() },
      })
    ).resolves.toMatchObject({ promptSuggestions: true });
  });

  it('reads the offered agent tools from the synced copy, with no MCP servers selected', async () => {
    const toolsRow = (tools: string[]) => ({
      key: ['setting', 'agentTools'],
      value: { version: 1, tools },
    });
    // Another device turned notifications on; this machine still holds them off.
    let rows = [toolsRow([])];
    const copy = {
      repo: { openFlockDoc: vi.fn(async () => ({ flock: flockWithRows(rows) })) },
      syncFlockDoc: vi.fn(async () => {
        rows = [toolsRow(['notify', 'widget']), switchRow];
      }),
    };
    await loadSessionMcpCatalog({
      ...copy,
      workspaceId,
      sessionId,
      selectedIds: [],
      logger: { debug: vi.fn() },
    });
    await expect(
      loadSessionWorkspaceSettings({ ...copy, workspaceId, sessionId, logger: { debug: vi.fn() } })
    ).resolves.toEqual({ promptSuggestions: true, agentTools: ['notify', 'widget'] });
  });

  it('reports everything off when the document cannot be read', async () => {
    await expect(
      loadSessionWorkspaceSettings({
        repo: { openFlockDoc: vi.fn(async () => Promise.reject(new Error('closed'))) },
        workspaceId,
        sessionId,
        logger: { debug: vi.fn() },
      })
    ).resolves.toEqual({ promptSuggestions: false, agentTools: [] });
  });
});
