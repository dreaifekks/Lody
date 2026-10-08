// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalProjectControlResponse } from '@lody/shared';
import type { LanSharedConversation, LanShareSettingsResult } from '@lody/shared/lan-share';

import {
  LanShareSettingsError,
  readLanShareSettings,
  revokeLanShare,
  saveLanShareImage,
  saveLanSharePublicUrl,
  useLanSessionShareStatus,
  useLanShares,
  type LanSharesState,
} from '../src/lib/lan-session-share';

const shell = vi.hoisted(() => ({
  requests: [] as Array<{ type: string; shareId?: string; publicUrl?: string | null }>,
  shares: new Map<string, unknown[] | null>(),
  settings: {
    publicUrl: null as string | null,
    hubUrl: 'http://hub:18790',
    icon: false,
    preview: false,
  },
  images: [] as Array<{ kind: string; bytes: Uint8Array | null }>,
}));
vi.mock('@/lib/electron', () => ({ isElectronRenderer: () => true }));
vi.mock('@/lib/electron-ipc-client', () => ({
  getIpcServices: () => ({
    localProjects: {
      control: async (request: {
        type: string;
        workspaceId: string;
        shareId?: string;
        publicUrl?: string | null;
      }) => {
        shell.requests.push(request);
        if (request.type === 'lan/share-settings') {
          if (request.publicUrl === 'ftp://nope') {
            return {
              ok: false,
              type: request.type,
              error: 'execution_failed',
              message: 'The hub refused: A share address is an http or https address',
              data: { status: 400 },
            };
          }
          if (request.publicUrl !== undefined) shell.settings.publicUrl = request.publicUrl;
          return { ok: true, type: request.type, result: { ...shell.settings } };
        }
        const shares = shell.shares.get(request.workspaceId) ?? null;
        if (request.type === 'lan/share-revoke') {
          shell.shares.set(
            request.workspaceId,
            (shares ?? []).filter(
              (share) => (share as LanSharedConversation).shareId !== request.shareId
            )
          );
          return { ok: true, type: request.type, result: { revoked: true } };
        }
        return shares === null
          ? { ok: false, type: request.type, error: 'workspace_not_found', message: 'no LAN' }
          : ({ ok: true, type: 'lan/shares', result: { shares } } as LocalProjectControlResponse);
      },
    },
    lan: {
      setShareImage: async (input: { kind: 'icon' | 'preview'; bytes: Uint8Array | null }) => {
        shell.images.push(input);
        shell.settings[input.kind] = input.bytes !== null;
        return { ok: true, type: 'lan/share-image', result: { ...shell.settings } };
      },
    },
  }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const share = (shareId: string, rootSourceId: string): LanSharedConversation => ({
  shareId: shareId.padEnd(32, 'x'),
  title: 'A discussion',
  rootSourceId,
  sources: [{ sourceId: rootSourceId, conversationId: 'c1' }],
  conversationCount: 1,
  revision: 1,
  deployment: 'a'.repeat(64),
  createdAt: '2026-10-08T00:00:00.000Z',
  updatedAt: '2026-10-08T00:00:00.000Z',
  url: `http://hub:8789/s/${shareId.padEnd(32, 'x')}`,
});

describe('what a LAN workspace says about its shared conversations', () => {
  let container: HTMLDivElement;
  let root: Root;
  const seen: Record<string, { status: string; shares: LanSharesState }> = {};

  function Probe({ workspaceId, sessionId }: { workspaceId: string; sessionId: string }) {
    seen[`${workspaceId}:${sessionId}`] = {
      status: useLanSessionShareStatus(workspaceId, sessionId),
      shares: useLanShares(workspaceId),
    };
    return null;
  }

  const mount = async (pairs: Array<[string, string]>) => {
    await act(async () => {
      root.render(
        <>
          {pairs.map(([workspaceId, sessionId]) => (
            <Probe
              key={`${workspaceId}:${sessionId}`}
              workspaceId={workspaceId}
              sessionId={sessionId}
            />
          ))}
        </>
      );
    });
  };

  beforeEach(() => {
    container = document.createElement('div');
    root = createRoot(container);
    shell.requests.length = 0;
    shell.shares.clear();
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it('reads a conversation as shared only when a share is rooted at it', async () => {
    shell.shares.set('lw_home', [share('one', 'session-a')]);
    await mount([
      ['lw_home', 'session-a'],
      ['lw_home', 'session-b'],
    ]);
    expect(seen['lw_home:session-a']?.status).toBe('shared');
    expect(seen['lw_home:session-b']?.status).toBe('none');
    // Both headers read one list.
    expect(shell.requests.filter((request) => request.type === 'lan/shares')).toHaveLength(1);
  });

  it('offers nothing in a workspace that is not one of a LAN', async () => {
    await mount([['lw_alone', 'session-a']]);
    expect(seen['lw_alone:session-a']).toMatchObject({
      status: 'none',
      shares: { status: 'unavailable' },
    });
  });

  it('reads the conversation as unshared again once its share is revoked', async () => {
    shell.shares.set('lw_lab', [share('two', 'session-a')]);
    await mount([['lw_lab', 'session-a']]);
    expect(seen['lw_lab:session-a']?.status).toBe('shared');

    await act(async () => {
      await revokeLanShare('lw_lab', 'two'.padEnd(32, 'x'));
    });
    expect(seen['lw_lab:session-a']?.status).toBe('none');
  });
});

describe("the settings of a LAN workspace's share pages", () => {
  beforeEach(() => {
    shell.requests.length = 0;
    shell.images.length = 0;
    shell.shares.set('lw_home', []);
    Object.assign(shell.settings, { publicUrl: null, icon: false, preview: false });
  });

  it('reads the address, sets one, takes it back, and reads the links again', async () => {
    expect(await readLanShareSettings('lw_home')).toEqual<LanShareSettingsResult>({
      publicUrl: null,
      hubUrl: 'http://hub:18790',
      icon: false,
      preview: false,
    });
    const saved = await saveLanSharePublicUrl('lw_home', 'https://share.example.com');
    expect(saved.publicUrl).toBe('https://share.example.com');
    // The links of the list follow the address.
    expect(shell.requests.map((request) => request.type)).toEqual([
      'lan/share-settings',
      'lan/share-settings',
      'lan/shares',
    ]);
    expect((await saveLanSharePublicUrl('lw_home', null)).publicUrl).toBeNull();
    await expect(saveLanSharePublicUrl('lw_home', 'ftp://nope')).rejects.toEqual(
      new LanShareSettingsError('invalid_address')
    );
  });

  it('sends an image the hub would take and refuses the rest before sending', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    expect(await saveLanShareImage('lw_home', 'icon', png)).toMatchObject({ icon: true });
    expect(shell.images).toEqual([{ workspaceId: 'lw_home', kind: 'icon', bytes: png }]);

    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    await expect(saveLanShareImage('lw_home', 'icon', svg)).rejects.toEqual(
      new LanShareSettingsError('unsupported')
    );
    const large = new Uint8Array(2 * 1024 * 1024 + 1);
    large.set(png);
    await expect(saveLanShareImage('lw_home', 'preview', large)).rejects.toEqual(
      new LanShareSettingsError('too_large')
    );
    expect(shell.images).toHaveLength(1);

    expect(await saveLanShareImage('lw_home', 'icon', null)).toMatchObject({ icon: false });
  });
});
