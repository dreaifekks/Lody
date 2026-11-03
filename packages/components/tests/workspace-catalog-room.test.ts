import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_ROLE_VERSION,
  getProjectMcpKey,
  workspaceFlockKeys,
  type AgentConfigId,
  type AgentRole,
  type AgentRoleId,
  type LocalProjectId,
  type MachineId,
  type WorkspaceMcpServerMeta,
  type WorkspaceVoiceSetting,
} from '@lody/shared';
import type { WorkspaceRuntime } from '../src/atoms/runtime';
import {
  acquireWorkspaceCatalog,
  type WorkspaceCatalogSnapshot,
} from '../src/lib/workspace-catalog-room';
import { singleMachineRole } from './agent-role-fixture';

const entry = (id: string, name: string): WorkspaceMcpServerMeta => ({
  id: id as WorkspaceMcpServerMeta['id'],
  name,
  transport: 'stdio',
  connection: { transport: 'stdio', command: 'mcp-files' },
  createdAt: 1,
  updatedAt: 1,
});

const roleRow = (id: string, name: string): AgentRole =>
  singleMachineRole({
    v: AGENT_ROLE_VERSION,
    id: id as AgentRoleId,
    ownerUserId: 'user-1',
    visibility: 'private',
    name,
    mentionSlug: name.toLowerCase(),
    machineId: 'machine-1' as MachineId,
    agentConfigId: 'config-1' as AgentConfigId,
    runConfig: {},
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  });

// The room's startup is a chain of awaits on already-resolved promises, so
// draining microtasks settles it deterministically — no timers, no wall clock.
const settle = async (): Promise<void> => {
  for (let tick = 0; tick < 20; tick += 1) {
    await Promise.resolve();
  }
};

/**
 * Minimal stand-in for the workspace runtime: one Flock document whose rows,
 * events, and first remote sync are driven by the test rather than a transport.
 */
function createRuntime(
  workspaceId: string,
  rows: WorkspaceMcpServerMeta[],
  roles: AgentRole[] = [],
  projectDefaults: Record<string, { ids: string[] }> = {}
) {
  const listeners: Array<(batch: unknown) => void> = [];
  let completeFirstSync!: () => void;
  const firstSyncedWithRemote = new Promise<void>((resolve) => {
    completeFirstSync = resolve;
  });
  const unsubscribeRoom = vi.fn();
  const current = [...rows];

  const flock = {
    scan: (options?: { prefix?: readonly unknown[] }) =>
      options?.prefix?.[0] === 'agentRole'
        ? roles.map((value) => ({ key: workspaceFlockKeys.agentRole(value.id), value }))
        : options?.prefix?.[0] === 'projectMcpDefault'
          ? Object.entries(projectDefaults).map(([projectKey, value]) => ({
              key: workspaceFlockKeys.projectMcpDefault(projectKey),
              value,
            }))
          : current.map((value) => ({ key: workspaceFlockKeys.mcpServer(value.id), value })),
    subscribe: (listener: (batch: unknown) => void) => {
      listeners.push(listener);
      return () => {
        listeners.splice(listeners.indexOf(listener), 1);
      };
    },
  };
  const joinRoom = vi.fn(async () => ({ unsubscribe: unsubscribeRoom, firstSyncedWithRemote }));
  const openFlockDoc = vi.fn(async () => ({ flock, joinRoom }));

  return {
    runtime: { workspaceId, repo: { openFlockDoc } } as unknown as WorkspaceRuntime,
    openFlockDoc,
    joinRoom,
    unsubscribeRoom,
    subscriberCount: () => listeners.length,
    emit: (value: WorkspaceMcpServerMeta) => {
      current.push(value);
      for (const listener of listeners) {
        listener({ events: [{ key: workspaceFlockKeys.mcpServer(value.id), value }] });
      }
    },
    emitVoice: (value: WorkspaceVoiceSetting) => {
      for (const listener of listeners) {
        listener({ events: [{ key: workspaceFlockKeys.voiceSetting(), value }] });
      }
    },
    emitPromptSuggestions: (enabled: boolean) => {
      for (const listener of listeners) {
        listener({
          events: [
            {
              key: workspaceFlockKeys.promptSuggestionsSetting(),
              value: enabled ? { version: 1 } : undefined,
            },
          ],
        });
      }
    },
    emitPinnedProjects: (keys: readonly string[] | null) => {
      for (const listener of listeners) {
        listener({
          events: [
            {
              key: workspaceFlockKeys.pinnedProjectsSetting(),
              value: keys ? { version: 1, keys: [...keys] } : undefined,
            },
          ],
        });
      }
    },
    completeFirstSync: () => completeFirstSync(),
  };
}

describe('workspace MCP catalog room', () => {
  it('publishes project defaults once the local document is read', async () => {
    const projectKey = getProjectMcpKey(
      { kind: 'local', localProjectId: 'project-1' as LocalProjectId },
      'machine-1'
    )!;
    const harness = createRuntime('workspace-project-defaults', [entry('server-1', 'Files')], [], {
      [projectKey]: { ids: [] },
    });
    const seen: WorkspaceCatalogSnapshot[] = [];
    const lease = acquireWorkspaceCatalog(harness.runtime, (snapshot) => seen.push(snapshot));
    // Nothing read yet: defaults are unknown, not empty.
    expect(lease.snapshot.loaded).toBe(false);
    await settle();

    expect(seen.at(-1)).toMatchObject({ loaded: true, failed: false, synced: false });
    expect(seen.at(-1)?.projectMcpDefaults).toEqual({ [projectKey]: { ids: [] } });

    lease.release();
  });

  it('publishes the prompt suggestions switch on its own', async () => {
    const harness = createRuntime('workspace-prompt-suggestions', []);
    const seen: WorkspaceCatalogSnapshot[] = [];
    const lease = acquireWorkspaceCatalog(harness.runtime, (snapshot) => seen.push(snapshot));
    await settle();
    expect(lease.snapshot.promptSuggestions).toBe(false);

    harness.emitPromptSuggestions(true);
    expect(seen.at(-1)?.promptSuggestions).toBe(true);
    harness.emitPromptSuggestions(false);
    expect(seen.at(-1)?.promptSuggestions).toBe(false);

    lease.release();
  });

  it('publishes the pinned projects and keeps their identity while unchanged', async () => {
    const harness = createRuntime('workspace-pinned-projects', []);
    const seen: WorkspaceCatalogSnapshot[] = [];
    const lease = acquireWorkspaceCatalog(harness.runtime, (snapshot) => seen.push(snapshot));
    await settle();
    expect(lease.snapshot.pinnedProjects).toEqual([]);

    harness.emitPinnedProjects(['machine-1:project-a']);
    expect(seen.at(-1)?.pinnedProjects).toEqual(['machine-1:project-a']);
    const first = seen.at(-1)?.pinnedProjects;
    const publishedBefore = seen.length;

    // A same-content rewrite from another device must not re-render consumers.
    harness.emitPinnedProjects(['machine-1:project-a']);
    expect(seen.length).toBe(publishedBefore);
    expect(seen.at(-1)?.pinnedProjects).toBe(first);

    harness.emitPinnedProjects(['machine-1:project-a', 'machine-2:project-b']);
    expect(seen.at(-1)?.pinnedProjects).toEqual(['machine-1:project-a', 'machine-2:project-b']);
    harness.emitPinnedProjects(null);
    expect(seen.at(-1)?.pinnedProjects).toEqual([]);

    lease.release();
  });

  it('publishes a new voice for the same shared voice agent', async () => {
    const harness = createRuntime('workspace-voice', []);
    const seen: WorkspaceCatalogSnapshot[] = [];
    const lease = acquireWorkspaceCatalog(harness.runtime, (snapshot) => seen.push(snapshot));
    await settle();
    const agent = {
      version: 1 as const,
      configId: 'config-1' as AgentConfigId,
      machineId: 'machine-1' as MachineId,
    };

    harness.emitVoice({ ...agent, voice: 'maple' });
    expect(seen.at(-1)?.voice).toEqual({ ...agent, voice: 'maple' });
    const stable = seen.at(-1)?.voice;

    // Only the voice moves; Settings must show the new one, and calls must use it.
    harness.emitVoice({ ...agent, voice: 'sol' });
    expect(seen.at(-1)?.voice).toEqual({ ...agent, voice: 'sol' });

    harness.emitVoice(agent);
    expect(seen.at(-1)?.voice).toEqual(agent);

    // An unchanged row still keeps its identity for memos keyed on it.
    harness.emitVoice({ ...agent, voice: 'sol' });
    const sol = seen.at(-1)?.voice;
    harness.emitVoice({ ...agent, voice: 'sol' });
    expect(seen.at(-1)?.voice).toBe(sol);
    expect(stable).not.toBe(sol);

    lease.release();
  });
});

it('shares capped retries, recovers every consumer and keeps another workspace usable', async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const failed = createRuntime('failed', [entry('files', 'Files')]);
  const healthy = createRuntime('healthy', [entry('other', 'Other')]);
  const open = failed.openFlockDoc.getMockImplementation()!;
  failed.openFlockDoc.mockRejectedValue(new Error('storage unavailable'));
  const seen: WorkspaceCatalogSnapshot[] = [];
  const other: WorkspaceCatalogSnapshot[] = [];
  const a = acquireWorkspaceCatalog(failed.runtime, (snapshot) => seen.push(snapshot));
  const b = acquireWorkspaceCatalog(failed.runtime, (snapshot) => other.push(snapshot));
  const independent = acquireWorkspaceCatalog(healthy.runtime, (snapshot) => {
    expect(snapshot.loaded).toBe(true);
  });
  try {
    await settle();
    expect(seen.at(-1)).toMatchObject({ loaded: false, failed: true });
    expect(healthy.subscriberCount()).toBe(1);
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const before = failed.openFlockDoc.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(failed.openFlockDoc.mock.calls.length).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(failed.openFlockDoc.mock.calls.length).toBe(before + 1);
    }
    failed.openFlockDoc.mockImplementation(open);
    await vi.advanceTimersByTimeAsync(30000);
    expect(seen.at(-1)).toMatchObject({ loaded: true, failed: false });
    expect(seen.at(-1)?.servers.map(({ id }) => id)).toEqual(['files']);
    expect(other.at(-1)).toBe(seen.at(-1));
    expect(failed.subscriberCount()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    a.release();
    b.release();
    independent.release();
    log.mockRestore();
    vi.useRealTimers();
  }
});
