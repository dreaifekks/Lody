import { describe, expect, it } from 'vitest';
import { buildLiveActivityConversationItems } from '../src/live-activity-summary';
import type { SessionMeta } from '../src/schema';

// Heartbeats are judged against the real clock.
const NOW = Date.now();

function startedAtOf(meta: Partial<SessionMeta>) {
  const [item] = buildLiveActivityConversationItems({
    sessions: [{ id: 's', userId: 'u', title: 'Task', ...meta } as SessionMeta],
    currentUserId: 'u',
    defaultTitle: 'New Task',
    statusLabels: { permission: 'P', question: 'Q', running: 'R', unread: 'U' },
    formatUpdatedAt: () => '',
  });
  return item ? { status: item.status, startedAt: item.startedAt } : null;
}

describe('Live Activity turn start', () => {
  it('times a running turn from when it began, not from the last reply', () => {
    expect(
      startedAtOf({
        status: { type: 'running' },
        lastRunningSeen: NOW - 1_000,
        lastMessageAt: NOW - 3_600_000,
      } as Partial<SessionMeta>)
    ).toEqual({ status: 'running', startedAt: NOW - 1_000 });
  });

  it('times a wait for the user from when it began', () => {
    expect(
      startedAtOf({
        status: { type: 'requestPermission' },
        lastRunningSeen: NOW - 1_000,
        awaitingUserSince: NOW - 30_000,
      } as Partial<SessionMeta>)
    ).toMatchObject({ startedAt: NOW - 30_000 });
  });

  it('gives finished work no running timer', () => {
    expect(
      startedAtOf({
        lastMessageAt: NOW - 1_000,
        lastRunningSeen: NOW - 5_000,
      } as Partial<SessionMeta>)
    ).toEqual({ status: 'unread', startedAt: undefined });
  });
});
