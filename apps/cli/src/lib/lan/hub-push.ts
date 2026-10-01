// Push for a self-hosted hub. Phones register their APNs tokens here, members
// report what their agents did, and the hub turns that into alerts and Live
// Activity updates. A LAN has one user, so every registered phone hears about
// every member.
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import type { LiveActivityConversationItem } from '@lody/shared';
import { isApnsDeviceToken, type ApnsPush, type ApnsSender } from './apns';
import {
  LAN_PUSH_DEVICES_PATH,
  LAN_PUSH_EVENTS_PATH,
  LAN_PUSH_STATUS_PATH,
  LAN_PUSH_TEST_PATH,
  type LanPushDevice,
  type LanPushEvent,
  type LanPushLiveActivityResult,
} from './lan-push-protocol';

const DEVICES_FILE_NAME = 'push-devices.json';
const MAX_BODY_BYTES = 512 * 1024;
const MAX_DEVICES = 32;
const SEEN_EVENT_LIMIT = 512;
/** A member that stopped reporting no longer speaks for its sessions. */
const SUMMARY_TTL_MS = 30 * 60_000;
/** Finished work stays on the activity briefly, then leaves. */
const UNREAD_WINDOW_MS = 15 * 60_000;
const STALE_AFTER_S = 30 * 60;
/** Machines heard from this recently count as members when naming senders. */
const MEMBER_WINDOW_MS = 24 * 60 * 60_000;
const DISMISS_AFTER_S = 60;
const LIVE_ACTIVITY_ATTRIBUTES_TYPE = 'LodyConversationLiveActivityAttributes';
const ACTIVE_STATUSES = new Set(['running', 'permission', 'question']);
/** The widget's own ordering (`Item.Status.priority`): who needs the user first. */
const STATUS_PRIORITY: Record<string, number> = { question: 0, permission: 1, running: 2 };
/** The phone draws the focus and at most this many more; it sends no more itself. */
const VISIBLE_ITEMS = 2;
const FAILURE_WINDOW_MS = 10 * 60_000;

type Language = 'en' | 'zh';
type Copy = {
  completed: string;
  failed: (detail: string) => string;
  permission: (tool: string) => string;
  permissionNoTool: string;
  question: string;
  scheduleStarted: string;
  scheduleBlocked: (code: string) => string;
  scheduleSkipped: (code: string) => string;
  untitled: string;
  test: string;
};
const COPY: Record<Language, Copy> = {
  en: {
    completed: 'Finished',
    failed: (detail) => (detail ? `Failed: ${detail}` : 'Failed'),
    permission: (tool) => `Needs your approval: ${tool}`,
    permissionNoTool: 'Needs your approval',
    question: 'Waiting for your answer',
    scheduleStarted: 'Scheduled task started',
    scheduleBlocked: (code) => `Scheduled task could not run (${code})`,
    scheduleSkipped: (code) => `Scheduled task skipped (${code})`,
    untitled: 'New Task',
    test: 'Push notifications from this LAN work.',
  },
  zh: {
    completed: '已完成',
    failed: (detail) => (detail ? `失败：${detail}` : '失败'),
    permission: (tool) => `需要你批准：${tool}`,
    permissionNoTool: '需要你批准',
    question: '在等你回答',
    scheduleStarted: '定时任务开始运行',
    scheduleBlocked: (code) => `定时任务没能运行（${code}）`,
    scheduleSkipped: (code) => `定时任务已跳过（${code}）`,
    untitled: '新任务',
    test: '局域网推送已接通。',
  },
};

function languageOf(locale: string): Language {
  return locale.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

function truncate(value: string, max: number): string {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function routeFor(workspaceSlug: string, sessionId: string): string {
  return `/${encodeURIComponent(workspaceSlug)}/sessions/${encodeURIComponent(sessionId)}`;
}

class BadRequest extends Error {}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BadRequest('body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new BadRequest('body is not JSON');
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const stringOr = (value: unknown, fallback: string, max = 200): string =>
  typeof value === 'string' && value.length <= max ? value : fallback;

function parseDevice(body: unknown, now: number): LanPushDevice {
  if (!isRecord(body)) throw new BadRequest('device must be an object');
  if (!isApnsDeviceToken(body.deviceToken)) throw new BadRequest('invalid deviceToken');
  const environment = body.environment === 'production' ? 'production' : 'development';
  const bundleId = stringOr(body.bundleId, '');
  if (!/^[A-Za-z0-9.-]{1,155}$/.test(bundleId)) throw new BadRequest('invalid bundleId');
  const activities: Record<string, string> = {};
  if (isRecord(body.activities)) {
    for (const [id, token] of Object.entries(body.activities).slice(0, 8)) {
      if (id.length <= 300 && isApnsDeviceToken(token)) activities[id] = token;
    }
  }
  const strings = (value: unknown, keys?: readonly string[]) => {
    if (!isRecord(value)) return null;
    const result: Record<string, string> = {};
    for (const [key, text] of Object.entries(value).slice(0, 32)) {
      if (keys && !keys.includes(key)) continue;
      if (typeof text === 'string' && text.length <= 200) result[key] = text;
    }
    return result;
  };
  return {
    deviceToken: body.deviceToken,
    environment,
    bundleId,
    userId: stringOr(body.userId, ''),
    workspaceId: stringOr(body.workspaceId, ''),
    workspaceSlug: stringOr(body.workspaceSlug, 'lan'),
    workspaceName: stringOr(body.workspaceName, 'Lody LAN'),
    locale: stringOr(body.locale, 'en', 40),
    alerts: body.alerts !== false,
    liveActivities: body.liveActivities !== false,
    pushToStartToken: isApnsDeviceToken(body.pushToStartToken) ? body.pushToStartToken : null,
    activities,
    liveActivityCopy: strings(body.liveActivityCopy),
    liveActivityLabels: strings(body.liveActivityLabels, [
      'permission',
      'question',
      'running',
      'unread',
    ]),
    updatedAt: now,
  };
}

const EVENT_TYPES = new Set([
  'session-completed',
  'session-failed',
  'permission-requested',
  'schedule',
  'live-activity',
]);

function parseEvent(body: unknown): LanPushEvent {
  if (!isRecord(body) || typeof body.type !== 'string' || !EVENT_TYPES.has(body.type)) {
    throw new BadRequest('unknown event');
  }
  for (const key of ['machineId', 'workspaceId', 'userId'] as const) {
    if (typeof body[key] !== 'string') throw new BadRequest(`missing ${key}`);
  }
  if (body.type === 'live-activity') {
    if (typeof body.activityId !== 'string' || !Array.isArray(body.items)) {
      throw new BadRequest('invalid live activity');
    }
  } else if (body.type === 'schedule') {
    if (typeof body.scheduleId !== 'string' || typeof body.runKey !== 'string') {
      throw new BadRequest('invalid schedule event');
    }
  } else if (typeof body.sessionId !== 'string') {
    throw new BadRequest('missing sessionId');
  }
  return {
    ...body,
    workspaceSlug: stringOr(body.workspaceSlug, String(body.workspaceId)),
  } as LanPushEvent;
}

type Summary = Extract<LanPushEvent, { type: 'live-activity' }>;
type ContentItem = LiveActivityConversationItem;

export type LanHubPush = {
  /** Answers `/push/*`; `false` for every other path. */
  handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<boolean>;
  deliver(event: LanPushEvent): Promise<LanPushLiveActivityResult | null>;
  devices(): readonly LanPushDevice[];
};

export function createLanHubPush(options: {
  dataDir: string;
  send: ApnsSender;
  isConfigured: () => boolean;
  now?: () => number;
  log?: (line: string) => void;
}): LanHubPush {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const devicesPath = path.join(options.dataDir, DEVICES_FILE_NAME);
  const devices = new Map<string, LanPushDevice>();
  try {
    const stored = JSON.parse(fs.readFileSync(devicesPath, 'utf8')) as { devices?: unknown };
    if (Array.isArray(stored.devices)) {
      for (const entry of stored.devices) {
        try {
          const device = parseDevice(entry, Number((entry as LanPushDevice).updatedAt) || now());
          devices.set(device.deviceToken, device);
        } catch {
          // A record this version cannot read is dropped; the phone registers again.
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log(`[push] ignoring unreadable ${devicesPath}: ${String(error)}`);
    }
  }

  const persist = () => {
    fs.mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    const temporary = `${devicesPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ devices: [...devices.values()] }), {
      mode: 0o600,
    });
    fs.renameSync(temporary, devicesPath);
  };

  const seen = new Set<string>();
  const firstTime = (key: string): boolean => {
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > SEEN_EVENT_LIMIT) seen.delete(seen.values().next().value as string);
    return true;
  };

  const summaries = new Map<string, Map<string, { summary: Summary; receivedAt: number }>>();
  /** Whether a phone last saw active work, so a remote start fires once per wave. */
  const wasActive = new Map<string, boolean>();
  /**
   * The earliest start seen while a session stays active: a permission pause
   * re-stamps `lastRunningSeen` when the agent resumes, the turn keeps going.
   */
  const workStarts = new Map<string, number>();
  /** Activities already ended; a phone lists them until they are dismissed. */
  const endedTokens = new Set<string>();
  /** What each activity last showed as running, so its end shows those as done. */
  const lastActiveItems = new Map<string, ContentItem[]>();
  const recentFailures = new Map<string, number>();
  const machinesSeen = new Map<string, number>();
  /** Naming the sender only helps once more than one machine reports. */
  const senderName = (event: { machineId: string; machineName?: string | null }) => {
    const cutoff = now() - MEMBER_WINDOW_MS;
    let members = 0;
    for (const [machineId, seenAt] of machinesSeen) {
      if (seenAt < cutoff) machinesSeen.delete(machineId);
      else members += 1;
    }
    return members > 1 && event.machineName ? truncate(event.machineName, 60) : null;
  };

  const push = async (device: LanPushDevice, message: Omit<ApnsPush, 'environment'>) => {
    const result = await options.send({ ...message, environment: device.environment });
    if (result.ok) return true;
    log(
      `[push] ${message.pushType} to ${device.deviceToken.slice(0, 8)}… failed: ${result.reason}`
    );
    if (result.unregistered) {
      const current = devices.get(device.deviceToken);
      if (current) {
        if (message.deviceToken === current.deviceToken) devices.delete(current.deviceToken);
        else if (message.deviceToken === current.pushToStartToken) current.pushToStartToken = null;
        else {
          for (const [id, token] of Object.entries(current.activities)) {
            if (token === message.deviceToken) delete current.activities[id];
          }
        }
        persist();
      }
    }
    return false;
  };

  const recipients = (userId: string) =>
    [...devices.values()].filter((device) => !device.userId || device.userId === userId);

  const alert = async (
    event: {
      userId: string;
      workspaceSlug: string;
      machineId: string;
      machineName?: string | null;
    },
    compose: (copy: Copy) => { title: string; body: string },
    target: { sessionId?: string | null; collapseId?: string }
  ) => {
    const subtitle = senderName(event);
    await Promise.all(
      recipients(event.userId)
        .filter((device) => device.alerts)
        .map((device) => {
          const { title, body } = compose(COPY[languageOf(device.locale)]);
          const slug = device.workspaceSlug || event.workspaceSlug;
          return push(device, {
            deviceToken: device.deviceToken,
            topic: device.bundleId,
            pushType: 'alert',
            priority: 10,
            collapseId: target.collapseId,
            payload: {
              aps: {
                alert: {
                  title: truncate(title, 120),
                  ...(subtitle ? { subtitle } : {}),
                  body: truncate(body, 240),
                },
                sound: 'default',
                ...(target.sessionId ? { 'thread-id': target.sessionId } : {}),
              },
              recipientUserId: event.userId,
              ...(target.sessionId
                ? { route: routeFor(slug, target.sessionId), sessionId: target.sessionId }
                : {}),
            },
          });
        })
    );
  };

  const mergedState = (activityId: string) => {
    const bySource = summaries.get(activityId);
    if (!bySource) return null;
    const cutoff = now() - SUMMARY_TTL_MS;
    const sources = [...bySource.entries()]
      .filter(([machineId, entry]) => {
        if (entry.receivedAt >= cutoff) return true;
        bySource.delete(machineId);
        return false;
      })
      .sort((a, b) => a[1].receivedAt - b[1].receivedAt);
    // The latest report about a session wins.
    const items = new Map<string, ContentItem>();
    let permissionAlert: Summary['permissionAlert'];
    let latest: Summary | null = null;
    for (const [, { summary }] of sources) {
      for (const item of summary.items) items.set(item.id, item);
      permissionAlert = summary.permissionAlert ?? permissionAlert;
      latest = summary;
    }
    if (!latest) return null;
    const recentUnread = now() - UNREAD_WINDOW_MS;
    const kept = [...items.values()].filter(
      (item) => ACTIVE_STATUSES.has(item.status) || item.updatedAt >= recentUnread
    );
    const starts = new Map<string, number>();
    const pinned = kept.map((item) => {
      if (!ACTIVE_STATUSES.has(item.status) || item.startedAt === undefined) return item;
      const startedAt = Math.min(item.startedAt, workStarts.get(item.id) ?? item.startedAt);
      starts.set(item.id, startedAt);
      return { ...item, startedAt };
    });
    workStarts.clear();
    for (const [id, startedAt] of starts) workStarts.set(id, startedAt);
    const statusCounts = { permission: 0, question: 0, running: 0, unread: 0 };
    for (const item of kept) statusCounts[item.status] += 1;
    const active = kept.some((item) => ACTIVE_STATUSES.has(item.status));
    if (active) {
      lastActiveItems.set(
        activityId,
        pinned.filter((item) => ACTIVE_STATUSES.has(item.status))
      );
    }
    return { latest, items: pinned, statusCounts, active, permissionAlert };
  };

  type MergedState = NonNullable<ReturnType<typeof mergedState>>;

  /**
   * The same state the phone builds for itself while it is open
   * (`LiveActivities.reconcile`): running work shows only active sessions,
   * the focus and one more; an ending activity turns what was running into
   * finished rows with their durations.
   */
  const contentStateFor = (device: LanPushDevice, activityId: string, state: MergedState) => {
    const labels = device.liveActivityLabels ?? {};
    const copy = device.liveActivityCopy ?? {};
    const shared = {
      ...(state.permissionAlert && state.active ? { permissionAlert: state.permissionAlert } : {}),
      ...(device.liveActivityCopy ? { copy: device.liveActivityCopy } : {}),
    };
    const label = (item: ContentItem) => ({
      ...item,
      statusLabel: labels[item.status] ?? item.statusLabel,
      // Relative labels age between pushes; the widget does not show them.
      updatedAtLabel: '',
    });
    if (state.active) {
      const active = state.items
        .filter((item) => ACTIVE_STATUSES.has(item.status))
        .sort(
          (a, b) =>
            (STATUS_PRIORITY[a.status] ?? 9) - (STATUS_PRIORITY[b.status] ?? 9) ||
            a.id.localeCompare(b.id)
        );
      return {
        totalCount: active.length,
        statusCounts: { ...state.statusCounts, unread: 0 },
        items: active.slice(0, VISIBLE_ITEMS).map(label),
        ...shared,
      };
    }
    const stamp = now();
    const finished = (lastActiveItems.get(activityId) ?? []).map((item) => {
      const failed = (recentFailures.get(item.id) ?? 0) >= stamp - FAILURE_WINDOW_MS;
      const { permissionCommand: _command, ...rest } = item;
      return {
        ...rest,
        status: failed ? 'failed' : 'unread',
        statusLabel:
          (failed ? copy.failedLabel : copy.completedLabel) ?? labels.unread ?? item.statusLabel,
        updatedAt: stamp,
        updatedAtLabel: '',
        completedAt: stamp,
      };
    });
    return {
      totalCount: finished.length,
      statusCounts: { permission: 0, question: 0, running: 0, unread: finished.length },
      items: finished,
      ...shared,
    };
  };

  /** Brings one running activity up to date, or ends it when the work stopped. */
  const updateActivity = async (
    device: LanPushDevice,
    activityId: string,
    state: MergedState
  ): Promise<boolean> => {
    const token = device.activities[activityId];
    if (!token) return false;
    const timestamp = Math.floor(now() / 1000);
    const contentState = contentStateFor(device, activityId, state);
    const ok = await push(device, {
      deviceToken: token,
      topic: `${device.bundleId}.push-type.liveactivity`,
      pushType: 'liveactivity',
      priority: state.active && !state.permissionAlert ? 5 : 10,
      payload: {
        aps: state.active
          ? {
              timestamp,
              event: 'update',
              'content-state': contentState,
              'stale-date': timestamp + STALE_AFTER_S,
            }
          : {
              timestamp,
              event: 'end',
              'content-state': contentState,
              'dismissal-date': timestamp + DISMISS_AFTER_S,
            },
      },
    });
    if (!state.active) {
      endedTokens.add(token);
      if (endedTokens.size > SEEN_EVENT_LIMIT) {
        endedTokens.delete(endedTokens.values().next().value as string);
      }
      if (device.activities[activityId] === token) {
        delete device.activities[activityId];
        persist();
      }
    }
    return ok;
  };

  /**
   * A phone reports the token of an activity some time after it starts, and
   * a short turn may finish first. Whatever happened meanwhile is pushed to
   * the new token right away, so the activity never stays behind.
   */
  const catchUp = async (device: LanPushDevice, previous: Record<string, string>) => {
    for (const [activityId, token] of Object.entries(device.activities)) {
      if (previous[activityId] === token || !summaries.has(activityId)) continue;
      const state = mergedState(activityId);
      if (!state) continue;
      wasActive.set(`${device.deviceToken}:${activityId}`, state.active);
      await updateActivity(device, activityId, state);
    }
  };

  const liveActivity = async (summary: Summary): Promise<LanPushLiveActivityResult> => {
    let bySource = summaries.get(summary.activityId);
    if (!bySource) summaries.set(summary.activityId, (bySource = new Map()));
    bySource.set(summary.machineId, { summary, receivedAt: now() });
    const state = mergedState(summary.activityId);
    if (!state) return { sent: false, reason: 'no_state' };
    const timestamp = Math.floor(now() / 1000);
    let delivered = 0;
    let ended = false;
    await Promise.all(
      recipients(summary.userId)
        .filter((device) => device.liveActivities)
        .map(async (device) => {
          const key = `${device.deviceToken}:${summary.activityId}`;
          const before = wasActive.get(key) ?? false;
          wasActive.set(key, state.active);
          if (device.activities[summary.activityId]) {
            if (await updateActivity(device, summary.activityId, state)) delivered += 1;
            if (!state.active) ended = true;
            return;
          }
          // No activity on this phone: start one when work begins, the way the
          // phone itself would if it were open.
          if (!state.active || before || !device.pushToStartToken) return;
          const labels = device.liveActivityLabels ?? {};
          const focus =
            state.items.find(
              (item) => item.status === 'permission' || item.status === 'question'
            ) ?? state.items.find((item) => item.status === 'running');
          const ok = await push(device, {
            deviceToken: device.pushToStartToken,
            topic: `${device.bundleId}.push-type.liveactivity`,
            pushType: 'liveactivity',
            priority: 10,
            payload: {
              aps: {
                timestamp,
                event: 'start',
                'content-state': contentStateFor(device, summary.activityId, state),
                'stale-date': timestamp + STALE_AFTER_S,
                'attributes-type': LIVE_ACTIVITY_ATTRIBUTES_TYPE,
                attributes: {
                  activityId: summary.activityId,
                  workspaceId: summary.workspaceId,
                  workspaceSlug: device.workspaceSlug,
                  workspaceName: device.workspaceName,
                  userId: summary.userId,
                },
                alert: {
                  title: truncate(focus?.title ?? device.workspaceName, 120),
                  body: labels[focus?.status ?? 'running'] ?? focus?.statusLabel ?? '',
                },
              },
            },
          });
          if (ok) delivered += 1;
        })
    );
    // Permission alerts always go out as notifications too; an activity on the
    // lock screen is easy to miss.
    if (summary.permissionAlert) return { sent: false, reason: 'alert_separately' };
    return delivered > 0 ? { sent: true, ended } : { sent: false, reason: 'no_activity' };
  };

  const deliver = async (event: LanPushEvent): Promise<LanPushLiveActivityResult | null> => {
    machinesSeen.set(event.machineId, now());
    if (event.type === 'live-activity') return await liveActivity(event);
    if (event.type === 'session-completed') {
      if (!firstTime(`completed:${event.sessionId}:${event.occurrenceId}`)) return null;
      await alert(
        event,
        (copy) => ({ title: event.sessionTitle || copy.untitled, body: copy.completed }),
        { sessionId: event.sessionId, collapseId: `done-${event.sessionId}` }
      );
    } else if (event.type === 'session-failed') {
      recentFailures.set(event.sessionId, now());
      if (recentFailures.size > SEEN_EVENT_LIMIT) {
        recentFailures.delete(recentFailures.keys().next().value as string);
      }
      // One failure is often recorded by more than one layer.
      const minute = Math.floor(now() / 60_000);
      if (!firstTime(`failed:${event.sessionId}:${minute}`)) return null;
      await alert(
        event,
        (copy) => ({
          title: event.sessionTitle || copy.untitled,
          body: copy.failed(truncate(event.message || event.reason, 160)),
        }),
        { sessionId: event.sessionId, collapseId: `done-${event.sessionId}` }
      );
    } else if (event.type === 'permission-requested') {
      if (!firstTime(`permission:${event.requestId}`)) return null;
      const body = (copy: Copy) => {
        if (event.requestKind === 'ask_user_question') return copy.question;
        if (event.toolTitle) return copy.permission(event.toolTitle);
        return copy.permissionNoTool;
      };
      await alert(
        event,
        (copy) => ({ title: event.sessionTitle || copy.untitled, body: body(copy) }),
        { sessionId: event.sessionId }
      );
    } else {
      if (!firstTime(`schedule:${event.runKey}:${event.phase}`)) return null;
      await alert(
        event,
        (copy) => {
          const code = event.code ?? 'unknown';
          const bodies = {
            dispatched: copy.scheduleStarted,
            blocked: copy.scheduleBlocked(code),
            skipped: copy.scheduleSkipped(code),
          };
          return { title: event.title || copy.untitled, body: bodies[event.phase] };
        },
        { sessionId: event.sessionId }
      );
    }
    return null;
  };

  const sendJson = (response: http.ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  };

  const handle = async (
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<boolean> => {
    const pathname = new URL(request.url ?? '/', 'http://hub').pathname;
    if (!pathname.startsWith('/push/')) return false;
    try {
      if (pathname === LAN_PUSH_DEVICES_PATH && request.method === 'PUT') {
        const device = parseDevice(await readJson(request), now());
        if (!devices.has(device.deviceToken) && devices.size >= MAX_DEVICES) {
          // The oldest registration is the likeliest to be dead.
          const oldest = [...devices.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0];
          if (oldest) devices.delete(oldest.deviceToken);
        }
        const previous = devices.get(device.deviceToken)?.activities ?? {};
        for (const [activityId, token] of Object.entries(device.activities)) {
          if (endedTokens.has(token)) delete device.activities[activityId];
        }
        devices.set(device.deviceToken, device);
        persist();
        sendJson(response, 200, { ok: true, configured: options.isConfigured() });
        if (options.isConfigured() && device.liveActivities) {
          void catchUp(device, previous).catch((error: unknown) =>
            log(`[push] catching up a new activity failed: ${String(error)}`)
          );
        }
      } else if (pathname === LAN_PUSH_DEVICES_PATH && request.method === 'DELETE') {
        const body = await readJson(request);
        const token = isRecord(body) ? body.deviceToken : undefined;
        if (!isApnsDeviceToken(token)) throw new BadRequest('invalid deviceToken');
        if (devices.delete(token)) persist();
        sendJson(response, 200, { ok: true });
      } else if (pathname === LAN_PUSH_EVENTS_PATH && request.method === 'POST') {
        const event = parseEvent(await readJson(request));
        if (!options.isConfigured()) {
          sendJson(response, 200, { sent: false, reason: 'not_configured' });
          return true;
        }
        const result = await deliver(event);
        sendJson(response, 200, result ?? { ok: true });
      } else if (pathname === LAN_PUSH_STATUS_PATH && request.method === 'GET') {
        sendJson(response, 200, { configured: options.isConfigured(), devices: devices.size });
      } else if (pathname === LAN_PUSH_TEST_PATH && request.method === 'POST') {
        if (!options.isConfigured()) {
          sendJson(response, 409, { error: 'not_configured' });
          return true;
        }
        let delivered = 0;
        await Promise.all(
          [...devices.values()].map(async (device) => {
            const copy = COPY[languageOf(device.locale)];
            const ok = await push(device, {
              deviceToken: device.deviceToken,
              topic: device.bundleId,
              pushType: 'alert',
              priority: 10,
              payload: {
                aps: { alert: { title: device.workspaceName, body: copy.test }, sound: 'default' },
                recipientUserId: device.userId,
              },
            });
            if (ok) delivered += 1;
          })
        );
        sendJson(response, 200, { devices: devices.size, delivered });
      } else {
        sendJson(response, 404, { error: 'not_found' });
      }
    } catch (error) {
      if (error instanceof BadRequest) {
        sendJson(response, 400, { error: error.message });
      } else {
        log(`[push] ${pathname} failed: ${String(error)}`);
        if (!response.headersSent) sendJson(response, 500, { error: 'push_failed' });
      }
    }
    return true;
  };

  return { handle, deliver, devices: () => [...devices.values()] };
}
