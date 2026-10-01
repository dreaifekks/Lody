import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanHub } from '@lody/shared/node/lan-hub';
import { createApnsProviderToken, readApnsConfig, writeApnsConfig, type ApnsPush } from './apns';
import { startLanHubServer, type LanHubServer, type LanHubUpstream } from './hub-server';
import { createLanNotificationsPort } from './lan-push-notifier';

async function startUpstream(): Promise<{ upstream: LanHubUpstream; seen: string[] }> {
  const seen: string[] = [];
  const server = http.createServer((request, response) => {
    seen.push(request.url ?? '');
    response.writeHead(request.method === 'PUT' ? 201 : 200).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  let stopped: (code: number | null) => void = () => {};
  return {
    seen,
    upstream: {
      port: (server.address() as AddressInfo).port,
      exited: new Promise((resolve) => (stopped = resolve)),
      stop: () => {
        server.closeAllConnections();
        server.close(() => stopped(0));
      },
    },
  };
}

const PHONE = 'a'.repeat(64);
const START_TOKEN = 'b'.repeat(64);
const ACTIVITY_TOKEN = 'c'.repeat(64);
const WORKSPACE = 'lw_0123456789abcdef0123456789abcdef';
const USER = 'local:0123456789abcdef0123456789abcdef';
const ACTIVITY = `lody-conversations:v5:${WORKSPACE}:${USER}`;

describe('LAN host push', () => {
  let dataDir: string;
  let hub: LanHubServer;
  let upstream: Awaited<ReturnType<typeof startUpstream>>;
  let sent: ApnsPush[];
  let refuse: Set<string>;
  let clock: number;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-lan-push-'));
    upstream = await startUpstream();
    sent = [];
    refuse = new Set();
    clock = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    hub = await startLanHubServer({
      host: '127.0.0.1',
      port: 0,
      dataDir,
      startUpstream: async () => upstream.upstream,
      sendPush: async (push) => {
        sent.push(push);
        return refuse.has(push.deviceToken)
          ? { ok: false, status: 410, reason: 'Unregistered', unregistered: true }
          : { ok: true };
      },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await hub.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const call = async (method: string, pathname: string, body?: unknown, token = hub.token) => {
    const response = await fetch(`${hub.url}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  const register = (extra: Record<string, unknown> = {}) =>
    call('PUT', '/push/devices', {
      deviceToken: PHONE,
      environment: 'development',
      bundleId: 'com.example.lody',
      userId: USER,
      workspaceId: WORKSPACE,
      workspaceSlug: 'lan',
      workspaceName: 'Home',
      locale: 'zh-Hans-CN',
      pushToStartToken: START_TOKEN,
      activities: {},
      liveActivityLabels: { running: '运行中' },
      liveActivityCopy: { empty: '没有进行中的任务' },
      ...extra,
    });

  const member = (): LanHub => ({
    id: 'x'.repeat(32),
    name: 'Home',
    url: hub.url,
    token: hub.token,
  });
  const port = () =>
    createLanNotificationsPort({
      resolveHub: member,
      machineId: 'machine-1',
      logger: { debug: () => {} } as never,
    });

  it('keeps /push behind the credential and away from the streams', async () => {
    expect((await call('GET', '/push/status', undefined, 'wrong')).status).toBe(401);
    expect(await call('GET', '/push/status')).toEqual({
      status: 200,
      body: { configured: true, devices: 0 },
    });
    expect(upstream.seen.some((url) => url.startsWith('/push'))).toBe(false);
  });

  it('remembers a phone across restarts and refuses malformed registrations', async () => {
    expect((await register()).status).toBe(200);
    expect((await register({ deviceToken: 'not-hex' })).status).toBe(400);
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'push-devices.json'), 'utf8'));
    expect(stored.devices).toHaveLength(1);
    expect(stored.devices[0]).toMatchObject({ deviceToken: PHONE, locale: 'zh-Hans-CN' });
  });

  it('alerts a phone in its language when a turn finishes, once per turn', async () => {
    await register();
    const notifications = port();
    const completed = {
      sessionId: 'session-1' as never,
      occurrenceId: 'turn-1',
      sessionTitle: 'Fix the build',
      workspaceId: WORKSPACE as never,
      workspaceSlug: WORKSPACE,
      userId: USER,
    };
    await notifications.notifySessionCompleted(completed);
    await notifications.notifySessionCompleted(completed);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      deviceToken: PHONE,
      environment: 'development',
      topic: 'com.example.lody',
      pushType: 'alert',
      payload: {
        aps: { alert: { title: 'Fix the build', body: '已完成' }, 'thread-id': 'session-1' },
        // The phone's slug: that is the route its catalog resolves.
        route: '/lan/sessions/session-1',
        recipientUserId: USER,
      },
    });
  });

  it('tells a question from a permission and reports failures and schedules', async () => {
    await register({ locale: 'en-US' });
    const notifications = port();
    const base = { workspaceId: WORKSPACE as never, workspaceSlug: 'lan', userId: USER };
    await notifications.notifyPermissionRequested({
      ...base,
      sessionId: 's' as never,
      requestId: 'r1',
      toolCallId: 't1',
      toolTitle: 'rm -rf build',
    });
    await notifications.notifyPermissionRequested({
      ...base,
      sessionId: 's' as never,
      requestId: 'r2',
      toolCallId: 't2',
      requestKind: 'ask_user_question',
    });
    await notifications.notifySessionFailed({
      ...base,
      sessionId: 's' as never,
      reason: 'agent_disconnected',
      message: 'The agent process disconnected',
    });
    await notifications.notifyScheduleEvent({
      ...base,
      phase: 'dispatched',
      scheduleId: 'daily',
      runKey: 'run-1',
      title: 'Daily report',
      sessionId: 's2',
    });

    const bodies = sent.map((push) => (push.payload as { aps: { alert: unknown } }).aps.alert);
    expect(bodies).toEqual([
      { title: 'New Task', body: 'Needs your approval: rm -rf build' },
      { title: 'New Task', body: 'Waiting for your answer' },
      { title: 'New Task', body: 'Failed: The agent process disconnected' },
      { title: 'Daily report', body: 'Scheduled task started' },
    ]);
  });

  it('starts a Live Activity when work begins, updates it, and ends it when work stops', async () => {
    await register();
    const notifications = port();
    const item = (status: 'running' | 'unread') => ({
      id: 'session-1',
      status,
      statusLabel: status === 'running' ? 'Running' : 'Completed',
      agentLogoKind: 'claude' as const,
      agentLogoText: 'CC',
      title: 'Fix the build',
      updatedAt: clock,
      updatedAtLabel: 'now',
    });
    const summary = (status: 'running' | 'unread') => ({
      activityId: ACTIVITY,
      workspaceId: WORKSPACE as never,
      userId: USER,
      totalCount: 1,
      statusCounts: {
        permission: 0,
        question: 0,
        running: status === 'running' ? 1 : 0,
        unread: status === 'unread' ? 1 : 0,
      },
      items: [item(status)],
      updatedAt: clock,
    });

    await notifications.syncLiveActivitySummary(summary('running'));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      deviceToken: START_TOKEN,
      topic: 'com.example.lody.push-type.liveactivity',
      pushType: 'liveactivity',
      payload: {
        aps: {
          event: 'start',
          'attributes-type': 'LodyConversationLiveActivityAttributes',
          attributes: { activityId: ACTIVITY, workspaceSlug: 'lan', workspaceName: 'Home' },
          'content-state': {
            totalCount: 1,
            statusCounts: { running: 1 },
            items: [{ id: 'session-1', statusLabel: '运行中', updatedAtLabel: '' }],
            copy: { empty: '没有进行中的任务' },
          },
        },
      },
    });

    // Still running, but no activity token yet: no second start.
    await notifications.syncLiveActivitySummary(summary('running'));
    expect(sent).toHaveLength(1);

    // The phone reports the activity it started.
    await register({ activities: { [ACTIVITY]: ACTIVITY_TOKEN } });
    await notifications.syncLiveActivitySummary(summary('running'));
    expect(sent[1]).toMatchObject({
      deviceToken: ACTIVITY_TOKEN,
      priority: 5,
      payload: { aps: { event: 'update' } },
    });

    const result = await notifications.syncLiveActivitySummary(summary('unread'));
    expect(sent[2]).toMatchObject({
      deviceToken: ACTIVITY_TOKEN,
      payload: { aps: { event: 'end', 'dismissal-date': Math.floor(clock / 1000) + 60 } },
    });
    expect(result).toEqual({ sent: true, ended: true });
  });

  it('forgets a token APNs no longer accepts', async () => {
    await register();
    refuse.add(PHONE);
    await port().notifySessionCompleted({
      sessionId: 's' as never,
      occurrenceId: 'o',
      workspaceId: WORKSPACE as never,
      workspaceSlug: 'lan',
      userId: USER,
    });
    expect((await call('GET', '/push/status')).body.devices).toBe(0);
  });
});

describe('APNs credentials', () => {
  it('signs a provider token APNs can verify with the key', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const token = createApnsProviderToken(
      { keyId: 'ABCDEFGHIJ', teamId: 'TEAM123456', privateKey: pem },
      1_700_000_000_000
    );
    const [header, claims, signature] = token.split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: 'ABCDEFGHIJ',
    });
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toEqual({
      iss: 'TEAM123456',
      iat: 1_700_000_000,
    });
    expect(
      crypto.verify(
        'sha256',
        Buffer.from(`${header}.${claims}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature!, 'base64url')
      )
    ).toBe(true);
  });

  it('stores the key privately and refuses one that is not an APNs key', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-apns-'));
    try {
      const pem = crypto
        .generateKeyPairSync('ec', { namedCurve: 'P-256' })
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString();
      writeApnsConfig(dir, { keyId: 'ABCDEFGHIJ', teamId: 'TEAM123456', privateKey: pem });
      expect(fs.statSync(path.join(dir, 'apns-key.p8')).mode & 0o777).toBe(0o600);
      expect(readApnsConfig(dir)).toMatchObject({ keyId: 'ABCDEFGHIJ', teamId: 'TEAM123456' });
      expect(() =>
        writeApnsConfig(dir, { keyId: 'ABCDEFGHIJ', teamId: 'TEAM123456', privateKey: 'nope' })
      ).toThrow(/APNs/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
