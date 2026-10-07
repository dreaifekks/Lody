// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { atom, getDefaultStore, type PrimitiveAtom } from 'jotai';
import type { SessionId, SessionMeta } from '@lody/shared';
import { ElectronSessionCompletionNotifier } from '../src/components/electron-session-completion-notifier';

vi.mock('../src/hooks/use-visible-session-metas', () => ({
  useVisibleSessionMetas: vi.fn(),
}));

vi.mock('../src/atoms', () => ({
  currentWorkspaceSlugAtom: atom<string | null>('ws-1'),
  electronSessionCompletionNotificationsEnabledAtom: atom<boolean>(true),
  userAtom: atom<{ id: string } | null>({ id: 'user-1' }),
}));

const agentNoticesEnabledAtom = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../src/atoms/settings', async () => {
  const { atom: createAtom } = await import('jotai');
  const enabled = createAtom(true);
  agentNoticesEnabledAtom.current = enabled;
  return { agentNotifyFeatureEnabledAtom: enabled };
});
const setAgentNoticesEnabled = (value: boolean) =>
  getDefaultStore().set(agentNoticesEnabledAtom.current as PrimitiveAtom<boolean>, value);

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({
    navigate: vi.fn(),
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (params && typeof params === 'object' && 'title' in params) {
        return `${key}:${String(params.title)}`;
      }
      return key;
    },
  }),
}));

const showSessionCompletionNotification = vi.fn();
const unsubscribeClick = vi.fn();
const onSessionCompletionNotificationClick = vi.fn(() => unsubscribeClick);

function installWindowIpc() {
  Object.defineProperty(window, '__LODY_ELECTRON__', {
    configurable: true,
    value: true,
  });
  Object.defineProperty(window, 'ipc', {
    configurable: true,
    value: {
      invoke: async (channel: string, ...args: unknown[]) => {
        if (channel === 'notifications.showSessionCompletion') {
          return showSessionCompletionNotification(args[0]);
        }
        throw new Error(`unexpected invoke ${channel}`);
      },
      on: (channel: string, listener: (payload: unknown) => void) => {
        if (channel === 'app.sessionCompletionClick') {
          return onSessionCompletionNotificationClick(listener);
        }
        return () => {};
      },
      send: () => {},
    },
  });
}

function uninstallWindowIpc() {
  delete window.__LODY_ELECTRON__;
  delete window.ipc;
}

import { useVisibleSessionMetas } from '../src/hooks/use-visible-session-metas';
import { isAppForeground } from '../src/lib/session-completion-notification';

const mockedUseVisibleSessionMetas = vi.mocked(useVisibleSessionMetas);

function createSession(
  id: string,
  status: SessionMeta['status'],
  overrides: Partial<SessionMeta> = {}
): SessionMeta & { id: SessionId } {
  return {
    id: id as SessionId,
    userId: 'user-1',
    title: `Session ${id}`,
    status,
    ...overrides,
  } as SessionMeta & { id: SessionId };
}

describe('ElectronSessionCompletionNotifier', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let hasFocusSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    installWindowIpc();
    showSessionCompletionNotification.mockClear();
    onSessionCompletionNotificationClick.mockClear();
    unsubscribeClick.mockClear();
    hasFocusSpy = vi.spyOn(document, 'hasFocus').mockReturnValue(true);

    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.useRealTimers();
    uninstallWindowIpc();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    hasFocusSpy?.mockRestore();
    hasFocusSpy = undefined;
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = undefined;
    }
    if (container) {
      container.remove();
      container = undefined;
    }
    vi.clearAllMocks();
  });

  async function renderComponent() {
    root = createRoot(container!);
    await act(async () => {
      root!.render(React.createElement(ElectronSessionCompletionNotifier));
    });
  }

  async function updateSessions(sessions: ReturnType<typeof createSession>[]) {
    mockedUseVisibleSessionMetas.mockReturnValue({
      sessions,
      allActiveSessions: sessions,
      visibleMachineIds: new Set(),
      visibleLocalProjectKeys: new Set(),
      isLoading: false,
    });
    await act(async () => {
      root?.render(React.createElement(ElectronSessionCompletionNotifier));
    });
  }

  it('does not show completion notification immediately when session becomes idle', async () => {
    mockedUseVisibleSessionMetas.mockReturnValue({
      sessions: [createSession('s1', { type: 'running' })],
      allActiveSessions: [createSession('s1', { type: 'running' })],
      visibleMachineIds: new Set(),
      visibleLocalProjectKeys: new Set(),
      isLoading: false,
    });

    await renderComponent();

    await updateSessions([createSession('s1', { type: 'idle' })]);
    expect(showSessionCompletionNotification).not.toHaveBeenCalled();
  });

  it('shows completion notification after 5s if session stays idle and app is not foreground', async () => {
    mockedUseVisibleSessionMetas.mockReturnValue({
      sessions: [createSession('s1', { type: 'running' })],
      allActiveSessions: [createSession('s1', { type: 'running' })],
      visibleMachineIds: new Set(),
      visibleLocalProjectKeys: new Set(),
      isLoading: false,
    });

    await renderComponent();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    hasFocusSpy?.mockReturnValue(false);
    expect(isAppForeground()).toBe(false);

    await updateSessions([createSession('s1', { type: 'idle' })]);
    expect(showSessionCompletionNotification).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(showSessionCompletionNotification).toHaveBeenCalledTimes(1);
    expect(showSessionCompletionNotification).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1' })
    );
  });

  it('cancels pending completion notification if session goes back to working within 5s', async () => {
    mockedUseVisibleSessionMetas.mockReturnValue({
      sessions: [createSession('s1', { type: 'running' })],
      allActiveSessions: [createSession('s1', { type: 'running' })],
      visibleMachineIds: new Set(),
      visibleLocalProjectKeys: new Set(),
      isLoading: false,
    });

    await renderComponent();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });

    await updateSessions([createSession('s1', { type: 'idle' })]);

    act(() => {
      vi.advanceTimersByTime(2500);
    });
    await updateSessions([createSession('s1', { type: 'running' })]);

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(showSessionCompletionNotification).not.toHaveBeenCalled();
  });

  it('does not show completion notification after 5s if app is in foreground', async () => {
    mockedUseVisibleSessionMetas.mockReturnValue({
      sessions: [createSession('s1', { type: 'running' })],
      allActiveSessions: [createSession('s1', { type: 'running' })],
      visibleMachineIds: new Set(),
      visibleLocalProjectKeys: new Set(),
      isLoading: false,
    });

    await renderComponent();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });

    await updateSessions([createSession('s1', { type: 'idle' })]);

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(showSessionCompletionNotification).not.toHaveBeenCalled();
  });
  describe('agent messages', () => {
    const notice = (id: string, body: string, title?: string) => ({
      id,
      body,
      at: 1,
      ...(title ? { title } : {}),
    });
    const background = () => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      hasFocusSpy?.mockReturnValue(false);
    };

    afterEach(() => {
      setAgentNoticesEnabled(true);
    });

    it('alerts each new message once, in the agent words, while the app is in the background', async () => {
      const initial = [
        createSession('s1', { type: 'running' }, { agentNotice: notice('n0', 'old') }),
      ];
      mockedUseVisibleSessionMetas.mockReturnValue({
        sessions: initial,
        allActiveSessions: initial,
        visibleMachineIds: new Set(),
        visibleLocalProjectKeys: new Set(),
        isLoading: false,
      });
      await renderComponent();
      background();

      // A message that was already there when the window opened stays quiet.
      expect(showSessionCompletionNotification).not.toHaveBeenCalled();

      const next = createSession(
        's1',
        { type: 'running' },
        { agentNotice: notice('n1', 'CI is green; may I merge?') }
      );
      await updateSessions([next]);
      await updateSessions([next]);
      expect(showSessionCompletionNotification).toHaveBeenCalledTimes(1);
      expect(showSessionCompletionNotification).toHaveBeenCalledWith({
        sessionId: 's1',
        workspaceSlug: 'ws-1',
        title: 'Session s1',
        body: 'CI is green; may I merge?',
      });

      await updateSessions([
        createSession(
          's1',
          { type: 'running' },
          { agentNotice: notice('n2', 'Blocked', 'Need a key') }
        ),
      ]);
      expect(showSessionCompletionNotification).toHaveBeenLastCalledWith(
        expect.objectContaining({ title: 'Need a key', body: 'Blocked' })
      );
    });

    it('stays quiet in the foreground and while the experiment is off', async () => {
      const initial = [createSession('s1', { type: 'running' })];
      mockedUseVisibleSessionMetas.mockReturnValue({
        sessions: initial,
        allActiveSessions: initial,
        visibleMachineIds: new Set(),
        visibleLocalProjectKeys: new Set(),
        isLoading: false,
      });
      await renderComponent();

      await updateSessions([
        createSession('s1', { type: 'running' }, { agentNotice: notice('n1', 'seen') }),
      ]);
      expect(showSessionCompletionNotification).not.toHaveBeenCalled();

      background();
      act(() => setAgentNoticesEnabled(false));
      await updateSessions([
        createSession('s1', { type: 'running' }, { agentNotice: notice('n2', 'off') }),
      ]);
      expect(showSessionCompletionNotification).not.toHaveBeenCalled();
    });
  });
});
