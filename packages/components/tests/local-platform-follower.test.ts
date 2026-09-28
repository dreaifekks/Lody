import { describe, expect, it } from 'vitest';
import { createStore, type PlatformSessionState, type WorkspacesState } from '@lody/platform';
import type { ElectronLocalPlatformSnapshot } from '@lody/shared/electron-ipc';
import {
  createLocalPlatformFollower,
  resolveLocalWorkspace,
} from '../src/providers/local-platform-follower';

const HOME_LAN = 'a'.repeat(32);
const OFFICE_LAN = 'b'.repeat(32);

type SnapshotWorkspace = ElectronLocalPlatformSnapshot['workspaces'][number];

const workspace = (
  workspaceId: string,
  name: string,
  slug: string | null,
  lan: string | null
): SnapshotWorkspace => ({
  workspaceId,
  name,
  slug,
  role: 'owner',
  lan: lan ? { id: lan, url: `http://${name.toLowerCase()}.invalid:8788` } : null,
  // The members of a LAN share a user; a workspace without one has the installation's.
  userId: lan ? `local:${name.toLowerCase()}` : 'local:user-1',
});

const snapshot = (userId: string, workspaces: SnapshotWorkspace[]): ElectronLocalPlatformSnapshot => {
  const [first] = workspaces;
  if (!first) throw new Error('a snapshot lists at least one workspace');
  const { lan: _lan, userId: _userId, ...implicit } = first;
  return { userId, workspace: implicit, workspaces };
};

const local = workspace('lw_local', 'Lody', 'local', null);
const home = workspace('lw_home', 'Home', 'lan-home', HOME_LAN);
const office = workspace('lw_office', 'Office', 'office', OFFICE_LAN);

function createFollower(initial: ElectronLocalPlatformSnapshot | null | Error) {
  let current: ElectronLocalPlatformSnapshot | null | Error = initial;
  let preferredSlug: string | null = null;
  let reads = 0;
  const session = createStore<PlatformSessionState>({ status: 'loading' });
  const workspaces = createStore<WorkspacesState>({ status: 'loading' });
  const published: WorkspacesState[] = [];
  workspaces.subscribe(() => published.push(workspaces.get()));
  const identityChanges: number[] = [];
  const errors: unknown[] = [];
  const follower = createLocalPlatformFollower({
    read: async () => {
      reads += 1;
      if (current instanceof Error) throw current;
      return current;
    },
    session,
    workspaces,
    readPreferredSlug: () => preferredSlug,
    onIdentityChanged: () => identityChanges.push(reads),
    onError: (error) => errors.push(error),
  });
  return {
    follower,
    session,
    workspaces,
    published,
    identityChanges,
    errors,
    reads: () => reads,
    becomes: (next: ElectronLocalPlatformSnapshot | null | Error) => (current = next),
    prefers: (slug: string | null) => (preferredSlug = slug),
    names: () => {
      const state = workspaces.get();
      return state.status === 'ready' ? state.workspaces.map((entry) => entry.name) : state.status;
    },
    active: () => {
      const state = workspaces.get();
      return state.status === 'ready' ? state.activeWorkspaceId : null;
    },
  };
}

describe('local platform follower', () => {
  it('waits for the CLI to provision a workspace', async () => {
    const harness = createFollower(null);

    await harness.follower.refresh();

    expect(harness.follower.isReady()).toBe(false);
    expect(harness.workspaces.get()).toEqual({ status: 'loading' });
    expect(harness.session.get()).toEqual({ status: 'loading' });
  });

  it('takes identity and workspace from one snapshot', async () => {
    const harness = createFollower(snapshot('local:user-1', [local]));

    await harness.follower.refresh();

    expect(harness.follower.isReady()).toBe(true);
    expect(harness.session.get()).toEqual({
      status: 'authenticated',
      user: { id: 'local:user-1', name: 'Local' },
    });
    expect(harness.workspaces.get()).toEqual({
      status: 'ready',
      workspaces: [
        { id: 'lw_local', name: 'Lody', slug: 'local', role: 'owner', userId: 'local:user-1' },
      ],
      activeWorkspaceId: 'lw_local',
    });
    expect(harness.follower.resolveStreams('lw_local')).toBeNull();
  });

  it('reaches every LAN workspace through the bridge of its own LAN', async () => {
    const harness = createFollower(snapshot('local:home', [home, office]));

    await harness.follower.refresh();

    expect(harness.names()).toEqual(['Home', 'Office']);
    expect(harness.follower.resolveStreams('lw_home')).toEqual({
      gatewayBaseUrl: `lody-hub://${HOME_LAN}`,
      token: 'lan-hub',
    });
    expect(harness.follower.resolveStreams('lw_office')?.gatewayBaseUrl).toBe(
      `lody-hub://${OFFICE_LAN}`
    );
    // Neither the address nor the credential of a LAN is part of how it is reached.
    expect(JSON.stringify(harness.follower.resolveStreams('lw_home'))).not.toContain('invalid');
  });

  it('follows a LAN that is joined, renamed and left while the window is open', async () => {
    const harness = createFollower(snapshot('local:home', [home]));
    await harness.follower.refresh();

    harness.becomes(snapshot('local:home', [home, office]));
    await harness.follower.refresh();
    expect(harness.names()).toEqual(['Home', 'Office']);

    harness.becomes(snapshot('local:home', [{ ...home, name: 'Flat', slug: 'flat' }, office]));
    await harness.follower.refresh();
    expect(harness.names()).toEqual(['Flat', 'Office']);

    harness.becomes(snapshot('local:home', [{ ...home, name: 'Flat', slug: 'flat' }]));
    await harness.follower.refresh();
    expect(harness.names()).toEqual(['Flat']);
    expect(harness.active()).toBe('lw_home');
    expect(harness.follower.resolveStreams('lw_office')).toBeNull();
  });

  it('publishes nothing while nothing changed', async () => {
    const harness = createFollower(snapshot('local:home', [home, office]));
    await harness.follower.refresh();
    const published = harness.published.length;

    await harness.follower.refresh();
    harness.becomes(snapshot('local:home', [home, office]));
    await harness.follower.refresh();

    expect(harness.published).toHaveLength(published);
  });

  it('opens where the user last was, and stays where the user goes', async () => {
    const harness = createFollower(snapshot('local:home', [home, office]));
    harness.prefers('office');
    await harness.follower.refresh();
    expect(harness.active()).toBe('lw_office');

    harness.follower.activate('lw_home');
    expect(harness.active()).toBe('lw_home');

    // A later snapshot keeps the choice, and a workspace that is gone cannot be chosen.
    harness.becomes(snapshot('local:home', [home, { ...office, name: 'Work' }]));
    await harness.follower.refresh();
    harness.follower.activate('lw_gone');
    expect(harness.active()).toBe('lw_home');
  });

  it('acts as the user of the LAN whose workspace is active', async () => {
    const harness = createFollower(snapshot('local:home', [home, office]));
    await harness.follower.refresh();
    expect(harness.session.get()).toMatchObject({ user: { id: 'local:home' } });

    harness.follower.activate('lw_office');

    expect(harness.session.get()).toMatchObject({ user: { id: 'local:office' } });
    expect(harness.identityChanges).toEqual([]);
  });

  it('starts over when the installation acts as another user', async () => {
    const harness = createFollower(snapshot('local:user-1', [local]));
    await harness.follower.refresh();

    harness.becomes(snapshot('local:home', [home]));
    await harness.follower.refresh();
    await harness.follower.refresh();

    expect(harness.identityChanges).toEqual([2]);
    // The previous user's workspaces stay until the renderer has started over.
    expect(harness.names()).toEqual(['Lody']);
    expect(harness.session.get()).toMatchObject({ user: { id: 'local:user-1' } });
    expect(harness.reads()).toBe(2);
  });

  it('keeps what it has while the CLI is between two sets of workspaces', async () => {
    const harness = createFollower(snapshot('local:home', [home]));
    await harness.follower.refresh();

    harness.becomes(null);
    await harness.follower.refresh();

    expect(harness.names()).toEqual(['Home']);
  });

  it('reports a catalog it cannot read, and recovers once it can', async () => {
    const harness = createFollower(new Error('Local platform catalog is not valid JSON'));

    await harness.follower.refresh();
    expect(harness.workspaces.get()).toEqual({
      status: 'error',
      message: 'Local platform catalog is not valid JSON',
    });
    expect(harness.errors).toHaveLength(1);

    harness.becomes(snapshot('local:user-1', [local]));
    await harness.follower.refresh();
    expect(harness.names()).toEqual(['Lody']);
  });

  it('does not blank a window over a catalog that fails to read once', async () => {
    const harness = createFollower(snapshot('local:home', [home]));
    await harness.follower.refresh();

    harness.becomes(new Error('EBUSY'));
    await harness.follower.refresh();

    expect(harness.names()).toEqual(['Home']);
    expect(harness.errors).toHaveLength(1);
  });

  it('reads once for requests that arrive together', async () => {
    const harness = createFollower(snapshot('local:home', [home]));

    await Promise.all([harness.follower.refresh(), harness.follower.refresh()]);

    expect(harness.reads()).toBe(1);
  });
});

describe('resolveLocalWorkspace', () => {
  const ready: WorkspacesState = {
    status: 'ready',
    workspaces: [
      { id: 'lw_home', name: 'Home', slug: 'lan-home', role: 'owner' },
      { id: 'lw_office', name: 'Office', slug: 'office', role: 'owner' },
      { id: 'lw_bare', name: 'Bare', slug: null, role: 'owner' },
    ],
    activeWorkspaceId: 'lw_office',
  };

  it('finds the workspace a route names', () => {
    expect(resolveLocalWorkspace(ready, 'lan-home')?.id).toBe('lw_home');
    expect(resolveLocalWorkspace(ready, 'local')?.id).toBe('lw_bare');
  });

  it('continues in the active workspace without a route or for a LAN that was left', () => {
    expect(resolveLocalWorkspace(ready, null)?.id).toBe('lw_office');
    expect(resolveLocalWorkspace(ready, 'garage')?.id).toBe('lw_office');
    expect(resolveLocalWorkspace({ ...ready, activeWorkspaceId: null }, null)?.id).toBe('lw_home');
  });

  it('has no workspace before the snapshot arrived', () => {
    expect(resolveLocalWorkspace({ status: 'loading' }, 'lan-home')).toBeNull();
    expect(resolveLocalWorkspace({ status: 'error', message: 'x' }, null)).toBeNull();
  });
});
