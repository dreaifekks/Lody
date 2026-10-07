import { describe, expect, it } from 'vitest';
import type { SessionAgentNoticeMeta, SessionId, SessionMeta } from '@lody/shared';
import {
  AGENT_NOTICE_MACHINE_HOURLY_LIMIT,
  AGENT_NOTICE_SESSION_HOURLY_LIMIT,
  AGENT_NOTICE_SESSION_MIN_INTERVAL_MS,
  AgentNoticeRateLimiter,
  deliverAgentNotice,
  type AgentNoticeDeps,
} from './agent-notice';

const SESSION = 'session-1' as SessionId;
const GRACE_MS = 10_000;

/** A machine's view of session metadata, a clock and the held alerts. */
const setup = (options: { enabled?: boolean; graceMs?: number } = {}) => {
  let clock = 1_800_000_000_000;
  let ids = 0;
  const metas = new Map<string, SessionMeta>();
  const held: Array<{ at: number; run: () => Promise<void> }> = [];
  const pushed: Array<{ sessionId: string; notice: SessionAgentNoticeMeta }> = [];
  let enabled = options.enabled ?? true;
  const deps: AgentNoticeDeps = {
    now: () => clock,
    limiter: new AgentNoticeRateLimiter(() => clock),
    isEnabled: () => enabled,
    writeNotice: async (sessionId, notice) => {
      const meta = metas.get(sessionId) ?? ({ id: sessionId } as SessionMeta);
      metas.set(sessionId, { ...meta, agentNotice: notice, lastMessageAt: notice.at });
    },
    readMeta: async (sessionId) => metas.get(sessionId),
    push: async ({ sessionId, notice }) => {
      pushed.push({ sessionId, notice });
    },
    graceMs: 'graceMs' in options ? options.graceMs : GRACE_MS,
    afterGrace: (delayMs, run) => held.push({ at: clock + delayMs, run }),
    createId: () => `notice-${++ids}`,
  };
  return {
    deps,
    metas,
    pushed,
    advance: async (ms: number) => {
      clock += ms;
      for (const entry of held.splice(0).filter((item) => item.at <= clock)) await entry.run();
    },
    read: (sessionId: string) => {
      const meta = metas.get(sessionId);
      if (meta) metas.set(sessionId, { ...meta, lastReadAt: clock });
    },
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    tick: (ms: number) => {
      clock += ms;
    },
  };
};

describe('lody_notify_user delivery', () => {
  it('records the message for desktops and alerts the phone after the grace period', async () => {
    const env = setup();
    const result = await deliverAgentNotice(env.deps, SESSION, {
      title: 'Blocked',
      body: 'I need the staging password.',
    });

    expect(result).toEqual({ ok: true, noticeId: 'notice-1' });
    expect(env.metas.get(SESSION)?.agentNotice).toEqual({
      id: 'notice-1',
      title: 'Blocked',
      body: 'I need the staging password.',
      at: 1_800_000_000_000,
    });
    // Unread now, so a device showing the conversation marks it read.
    expect(env.metas.get(SESSION)?.lastMessageAt).toBe(1_800_000_000_000);
    expect(env.pushed).toEqual([]);
    await env.advance(GRACE_MS);
    expect(env.pushed.map((entry) => entry.notice.id)).toEqual(['notice-1']);
  });

  it('skips the phone when someone reads the conversation within the grace period', async () => {
    const env = setup();
    await deliverAgentNotice(env.deps, SESSION, { body: 'Done; tests pass.' });
    env.tick(3_000);
    env.read(SESSION);
    await env.advance(GRACE_MS);
    expect(env.pushed).toEqual([]);
    // The desktop record stays: it was read, not withdrawn.
    expect(env.metas.get(SESSION)?.agentNotice?.id).toBe('notice-1');
  });

  it('refuses while the experiment is off and records nothing', async () => {
    const env = setup({ enabled: false });
    expect(await deliverAgentNotice(env.deps, SESSION, { body: 'Hello' })).toMatchObject({
      ok: false,
      code: 'AGENT_NOTICE_DISABLED',
    });
    expect(env.metas.size).toBe(0);
    await env.advance(GRACE_MS);
    expect(env.pushed).toEqual([]);
  });

  it('allows one message a minute and a few an hour per session', async () => {
    const env = setup();
    expect((await deliverAgentNotice(env.deps, SESSION, { body: 'one' })).ok).toBe(true);
    env.tick(AGENT_NOTICE_SESSION_MIN_INTERVAL_MS - 1_000);
    expect(await deliverAgentNotice(env.deps, SESSION, { body: 'too soon' })).toMatchObject({
      ok: false,
      code: 'AGENT_NOTICE_RATE_LIMITED',
      retryAfterSeconds: 1,
    });
    // Another session is not held back by this one.
    expect(
      (await deliverAgentNotice(env.deps, 'session-2' as SessionId, { body: 'other' })).ok
    ).toBe(true);
    env.tick(1_000);
    for (let index = 1; index < AGENT_NOTICE_SESSION_HOURLY_LIMIT; index += 1) {
      expect((await deliverAgentNotice(env.deps, SESSION, { body: `n${index}` })).ok).toBe(true);
      env.tick(AGENT_NOTICE_SESSION_MIN_INTERVAL_MS);
    }
    const refused = await deliverAgentNotice(env.deps, SESSION, { body: 'over the hour' });
    expect(refused).toMatchObject({ ok: false, code: 'AGENT_NOTICE_RATE_LIMITED' });
    // The window slides: the first message leaves it an hour after it was sent.
    const elapsed = AGENT_NOTICE_SESSION_HOURLY_LIMIT * AGENT_NOTICE_SESSION_MIN_INTERVAL_MS;
    expect(
      refused.ok === false && 'retryAfterSeconds' in refused && refused.retryAfterSeconds
    ).toBe((60 * 60_000 - elapsed) / 1000);
  });

  it('caps the whole machine across sessions', async () => {
    const env = setup();
    for (let index = 0; index < AGENT_NOTICE_MACHINE_HOURLY_LIMIT; index += 1) {
      const result = await deliverAgentNotice(env.deps, `s-${index}` as SessionId, { body: 'x' });
      expect(result.ok).toBe(true);
    }
    expect(
      await deliverAgentNotice(env.deps, 'one-more' as SessionId, { body: 'x' })
    ).toMatchObject({ ok: false, code: 'AGENT_NOTICE_RATE_LIMITED' });
  });

  it('sends at once where the port holds no alerts', async () => {
    const env = setup({ graceMs: undefined });
    await deliverAgentNotice(env.deps, SESSION, { body: 'Done' });
    expect(env.pushed).toHaveLength(1);
  });
});
