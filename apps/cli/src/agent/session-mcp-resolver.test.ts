import { describe, expect, it, vi } from 'vitest';

import type {
  McpServerId,
  SessionId,
  WorkspaceFlockReadableFlock,
  WorkspaceId,
} from '@lody/shared';
import { loadSessionMcpCatalog, loadSessionWorkspaceSettings } from './session-mcp-resolver';
import { WorkspaceSyncUnavailableError } from '@/lib/command-runtime';

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
  it('does not need a catalog for an empty selection', async () => {
    const unexpectedRead = async (): Promise<never> => {
      throw new Error('Empty selections must not access the catalog');
    };
    const select = await loadSessionMcpCatalog({
      repo: { openFlockDoc: unexpectedRead },
      waitForCatalogBaseline: unexpectedRead,
      workspaceId,
      sessionId,
      selectedIds: [],
      logger: { debug: vi.fn() },
    });
    expect(select(undefined)).toEqual({ servers: [], problems: [] });
  });

  it('waits for the shared baseline and then loads the selected server', async () => {
    const baseline = Promise.withResolvers<void>();
    let ready = false;
    const loading = loadSessionMcpCatalog({
      repo: {
        openFlockDoc: async () => {
          if (!ready) throw new Error('Read before the baseline');
          return { flock: catalogFlock };
        },
      },
      waitForCatalogBaseline: () => baseline.promise,
      workspaceId,
      sessionId,
      selectedIds: [selectedId],
      logger: { debug: vi.fn() },
      env: { NODE_BIN: 'node', ENTRYPOINT: 'server.js' },
    });
    ready = true;
    baseline.resolve();
    const select = await loading;
    expect(select(undefined).servers).toHaveLength(1);
  });

  it('preserves the original cold-baseline error instead of freezing an empty catalog', async () => {
    const cause = new Error('Synthetic initial-sync timeout');
    const error = new WorkspaceSyncUnavailableError({ message: 'Catalog is still syncing', cause });
    const loading = loadSessionMcpCatalog({
      repo: { openFlockDoc: async () => ({ flock: flockWithRows([]) }) },
      waitForCatalogBaseline: async () => {
        throw error;
      },
      workspaceId,
      sessionId,
      selectedIds: [selectedId],
      logger: { debug: () => {} },
    });
    await expect(loading).rejects.toBe(error);
    expect(error.cause).toBe(cause);
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
    let rows: Array<{ key: string[]; value: { version: number; tools?: string[] } }> = [
      toolsRow([]),
    ];
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

describe('LAN MCP environment', () => {
  it("fills variables from the LAN's table behind the machine's own environment", async () => {
    const lanEnv = vi.fn(() => ({ NODE_BIN: 'lan-node', ENTRYPOINT: 'lan-server.js' }));
    const select = await loadSessionMcpCatalog({
      repo: { openFlockDoc: vi.fn(async () => ({ flock: catalogFlock })) },
      workspaceId,
      sessionId,
      selectedIds: [selectedId],
      logger: { debug: vi.fn() },
      env: { NODE_BIN: 'node' },
      lanEnv,
    });
    // The machine keeps NODE_BIN; the LAN supplies what the machine lacks.
    expect(select(undefined)).toEqual({
      servers: [{ name: 'filesystem', command: 'node', args: ['lan-server.js'], env: [] }],
      problems: [],
    });
    // Read at the start, so a variable set since the daemon started counts.
    expect(lanEnv).toHaveBeenCalledTimes(1);
  });
});
