import { randomUUID } from 'node:crypto';
import type {
  LodyNotifyUserInput,
  LodyNotifyUserResult,
  SessionAgentNoticeMeta,
  SessionId,
  SessionMeta,
} from '@lody/shared';

/**
 * `lody_notify_user`: an agent asks for the user's attention.
 *
 * The message lands in two places. `SessionMeta.agentNotice` is what desktops
 * watch for their own alert, and it moves `lastMessageAt` so a device showing
 * the conversation marks it read. The phone alert goes out through the
 * notifications port after the port's grace period, unless someone read the
 * conversation meanwhile, exactly like a completion alert.
 */

/** At most one message per session this often. */
export const AGENT_NOTICE_SESSION_MIN_INTERVAL_MS = 60_000;
/** At most this many messages per session in any hour. */
export const AGENT_NOTICE_SESSION_HOURLY_LIMIT = 6;
/** At most this many messages from all sessions of this machine in any hour. */
export const AGENT_NOTICE_MACHINE_HOURLY_LIMIT = 30;
const HOUR_MS = 60 * 60_000;

export type AgentNoticeDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

/** Sliding-window limits per session and per machine; the clock is injected. */
export class AgentNoticeRateLimiter {
  private readonly bySession = new Map<string, number[]>();
  private machine: number[] = [];

  constructor(private readonly now: () => number) {}

  /** Records the message when it is allowed. */
  take(sessionId: string): AgentNoticeDecision {
    const now = this.now();
    const since = now - HOUR_MS;
    const session = (this.bySession.get(sessionId) ?? []).filter((at) => at > since);
    this.machine = this.machine.filter((at) => at > since);

    const waits: number[] = [];
    const last = session.at(-1);
    if (last !== undefined && now - last < AGENT_NOTICE_SESSION_MIN_INTERVAL_MS) {
      waits.push(last + AGENT_NOTICE_SESSION_MIN_INTERVAL_MS - now);
    }
    if (session.length >= AGENT_NOTICE_SESSION_HOURLY_LIMIT) {
      waits.push(
        (session[session.length - AGENT_NOTICE_SESSION_HOURLY_LIMIT] ?? now) + HOUR_MS - now
      );
    }
    if (this.machine.length >= AGENT_NOTICE_MACHINE_HOURLY_LIMIT) {
      waits.push(
        (this.machine[this.machine.length - AGENT_NOTICE_MACHINE_HOURLY_LIMIT] ?? now) +
          HOUR_MS -
          now
      );
    }
    if (waits.length > 0) {
      this.bySession.set(sessionId, session);
      return { allowed: false, retryAfterMs: Math.max(1, ...waits) };
    }
    session.push(now);
    this.machine.push(now);
    this.bySession.set(sessionId, session);
    return { allowed: true };
  }
}

export type AgentNoticeResult = LodyNotifyUserResult;

export type AgentNoticeDeps = {
  now: () => number;
  limiter: AgentNoticeRateLimiter;
  /** Whether the workspace currently offers the tool; read at each call. */
  isEnabled: () => boolean;
  writeNotice: (sessionId: SessionId, notice: SessionAgentNoticeMeta) => Promise<void>;
  readMeta: (sessionId: SessionId) => Promise<SessionMeta | undefined>;
  /** The phone alert; absent where the workspace has no notifications port. */
  push?: (input: {
    sessionId: SessionId;
    notice: SessionAgentNoticeMeta;
    meta: SessionMeta | undefined;
  }) => Promise<void>;
  /** Holds the phone alert this long; `undefined` sends at once. */
  graceMs?: number;
  afterGrace: (delayMs: number, run: () => Promise<void>) => void;
  createId?: () => string;
};

/** Someone has read the session up to its latest message. */
export const isSessionReadThrough = (meta: SessionMeta | undefined): boolean => {
  const lastReadAt = meta?.lastReadAt;
  const lastMessageAt = meta?.lastMessageAt;
  return (
    typeof lastReadAt === 'number' &&
    typeof lastMessageAt === 'number' &&
    lastReadAt >= lastMessageAt
  );
};

export async function deliverAgentNotice(
  deps: AgentNoticeDeps,
  sessionId: SessionId,
  input: LodyNotifyUserInput
): Promise<AgentNoticeResult> {
  if (!deps.isEnabled()) {
    return {
      ok: false,
      code: 'AGENT_NOTICE_DISABLED',
      message: 'Notifications from agents are turned off in Lody settings.',
    };
  }
  const decision = deps.limiter.take(sessionId);
  if (!decision.allowed) {
    const retryAfterSeconds = Math.ceil(decision.retryAfterMs / 1000);
    return {
      ok: false,
      code: 'AGENT_NOTICE_RATE_LIMITED',
      message: `Too many notifications. Do not notify again for ${retryAfterSeconds} seconds unless the user must act.`,
      retryAfterSeconds,
    };
  }
  const notice: SessionAgentNoticeMeta = {
    id: (deps.createId ?? randomUUID)(),
    ...(input.title ? { title: input.title } : {}),
    body: input.body,
    at: deps.now(),
  };
  await deps.writeNotice(sessionId, notice);

  const push = deps.push;
  if (push) {
    const send = async () => {
      const meta = await deps.readMeta(sessionId);
      // A device showing the conversation marked it read: nobody needs a push.
      if (deps.graceMs !== undefined && isSessionReadThrough(meta)) return;
      await push({ sessionId, notice, meta });
    };
    if (deps.graceMs === undefined) await send();
    else deps.afterGrace(deps.graceMs, send);
  }
  return { ok: true, noticeId: notice.id };
}
