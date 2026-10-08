// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalProjectControlResponse } from '@lody/shared';
import type { LanSharedConversation } from '@lody/shared/lan-share';

import {
  revokeLanShare,
  useLanSessionShareStatus,
  useLanShares,
  type LanSharesState,
} from '../src/lib/lan-session-share';

const shell = vi.hoisted(() => ({
  requests: [] as Array<{ type: string; shareId?: string }>,
  shares: new Map<string, unknown[] | null>(),
}));
vi.mock('@/lib/electron', () => ({ isElectronRenderer: () => true }));
vi.mock('@/lib/electron-ipc-client', () => ({
  getIpcServices: () => ({
    localProjects: {
      control: async (request: { type: string; workspaceId: string; shareId?: string }) => {
        shell.requests.push(request);
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
