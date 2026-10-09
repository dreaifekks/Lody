import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanHub } from '@lody/shared/node/lan-hub';
import { createApnsProviderToken, readApnsConfig, writeApnsConfig, type ApnsPush } from './apns';
import {
  agentNoticeCollapseId,
  createLanHubPush,
  LAN_PUSH_SWEEP_INTERVAL_MS,
  type LanHubPush,
} from './hub-push';
import { startLanHubServer, type LanHubServer, type LanHubUpstream } from './hub-server';
import { createLanNotificationsPort } from './lan-push-notifier';
import { createLanCredentialSync } from './lan-credential-sync';
import { createLanPushFallback } from './lan-push-fallback';
import type { LanPushEvent } from './lan-push-protocol';
import {
  LAN_HUB_CREDENTIALS_APNS_PATH,
  LAN_HUB_CREDENTIALS_GITHUB_PATH,
  getLanCredentialsDirectory,
  readLanCredentialsGitHub,
} from '@lody/shared/node/lan-credentials';

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
  const port = (machineId = 'machine-1', machineName = 'homenucserver') =>
    createLanNotificationsPort({
      resolveHub: member,
      machineId,
      // Read from the LAN's workspace, where a short name may stand in for it.
      machineName: async () => machineName,
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

  it('alerts an agent message once, opening its conversation', async () => {
    await register();
    const notifications = port();
    const message = {
      sessionId: 'session-1' as never,
      noticeId: 'notice-1',
      sessionTitle: 'Fix the build',
      body: 'CI is green; may I merge?',
      workspaceId: WORKSPACE as never,
      workspaceSlug: WORKSPACE,
      userId: USER,
    };
    await notifications.notifyAgentMessage(message);
    // The member sends it again after the hub was busy: still one alert.
    await notifications.notifyAgentMessage(message);
    await notifications.notifyAgentMessage({ ...message, noticeId: 'notice-2', title: 'Blocked' });

    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      collapseId: agentNoticeCollapseId('notice-1'),
      payload: {
        aps: { alert: { title: 'Fix the build', body: 'CI is green; may I merge?' } },
        route: '/lan/sessions/session-1',
        sessionId: 'session-1',
        lodyKind: 'agent-message',
      },
    });
    expect(sent[1]).toMatchObject({
      payload: { aps: { alert: { title: 'Blocked' } } },
    });
    expect(
      (
        await call('POST', '/push/events', {
          ...message,
          type: 'agent-message',
          machineId: 'm',
          body: 1,
        })
      ).status
    ).toBe(400);
  });

  it('keeps every Agent write apart in the 64 bytes APNs collapses on', async () => {
    await register();
    const notifications = port();
    // Two revisions of one Role differ only past the first 64 bytes of their ids.
    const noticeId = (revision: string) =>
      `config:9b2f6c1e-4a7d-4f3b-8e21-5c0d7a9e3f14:agent-role:0e8d4c2a-6b1f-4e9a-9c37-2f5a8b1d6e40:update:${revision}`;
    for (const revision of ['r2-1a2b3c4d5e6f7a8b', 'r3-9f8e7d6c5b4a3f2e'])
      await notifications.notifyAgentMessage({
        sessionId: 'session-1' as never,
        noticeId: noticeId(revision),
        body: 'Reviewer, by an Agent in “Planning”',
        workspaceId: WORKSPACE as never,
        workspaceSlug: WORKSPACE,
        userId: USER,
      });
    // What reaches APNs: `apns.ts` sends the first 64 characters as the header.
    const collapseIds = sent.map((push) => push.collapseId!.slice(0, 64));
    expect(collapseIds).toHaveLength(2);
    expect(collapseIds[0]).not.toBe(collapseIds[1]);
  });

  it('copies its credentials to members, which alert phones themselves while it is away', async () => {
    await register({ locale: 'en-US' });
    const pem = crypto
      .generateKeyPairSync('ec', { namedCurve: 'P-256' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    const apns = { keyId: 'ABCDEFGHIJ', teamId: 'TEAM123456', privateKey: pem };
    expect((await call('PUT', LAN_HUB_CREDENTIALS_APNS_PATH, apns, 'wrong')).status).toBe(401);
    expect(
      (await call('PUT', LAN_HUB_CREDENTIALS_APNS_PATH, { ...apns, privateKey: 'nope' })).status
    ).toBe(400);
    expect((await call('PUT', LAN_HUB_CREDENTIALS_APNS_PATH, apns)).status).toBe(200);
    const github = { token: 'github_pat_1', login: 'octocat', userId: '583231' };
    expect((await call('PUT', LAN_HUB_CREDENTIALS_GITHUB_PATH, github)).status).toBe(200);
    // Set from a member, kept by the hub as `lody lan github setup` on it would.
    expect(readApnsConfig(dataDir)).toMatchObject({ keyId: 'ABCDEFGHIJ' });

    const memberDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-lan-member-'));
    try {
      const lan = { ...member(), id: 'd'.repeat(32) };
      let joined = [lan];
      const sync = createLanCredentialSync({
        hubs: () => joined,
        logger: { debug: () => {}, info: () => {}, warn: () => {} } as never,
        dataDir: memberDir,
      });
      await sync.syncNow();
      const copy = getLanCredentialsDirectory(lan.id, memberDir);
      expect(readLanCredentialsGitHub(lan.id, memberDir)).toEqual(github);
      expect(fs.statSync(path.join(copy, 'apns-key.p8')).mode & 0o777).toBe(0o600);
      expect(fs.statSync(copy).mode & 0o777).toBe(0o700);

      const direct: ApnsPush[] = [];
      const fallback = createLanPushFallback({
        logger: { debug: () => {} } as never,
        dataDir: memberDir,
        createSender: () =>
          Object.assign(
            async (push: ApnsPush) => {
              direct.push(push);
              return { ok: true as const };
            },
            { close: () => {} }
          ),
      });
      const memberPort = (fetch: typeof globalThis.fetch) =>
        createLanNotificationsPort({
          resolveHub: () => lan,
          machineId: 'machine-1',
          logger: { debug: () => {} } as never,
          fetch,
          fallback,
        });
      const away = memberPort(() => Promise.reject(new TypeError('fetch failed')));
      const base = { workspaceId: WORKSPACE as never, workspaceSlug: 'lan', userId: USER };
      await away.notifySessionCompleted({
        ...base,
        sessionId: 'session-1' as never,
        occurrenceId: 'turn-1',
        sessionTitle: 'Fix the build',
      });
      await away.syncLiveActivitySummary({
        ...base,
        activityId: ACTIVITY,
        summary: { items: [] },
      } as never);

      expect(sent).toHaveLength(0);
      expect(direct).toHaveLength(1);
      expect(direct[0]).toMatchObject({
        deviceToken: PHONE,
        topic: 'com.example.lody',
        pushType: 'alert',
        // The hub collapses the same alert by the same id.
        collapseId: 'done-session-1',
        payload: { aps: { alert: { title: 'Fix the build', body: 'Finished' } } },
      });

      // A hub that hands over (503) or moved away (410) sent nothing either.
      for (const [status, sessionId] of [
        [503, 'session-2'],
        [410, 'session-3'],
      ] as const) {
        await memberPort(async () => new Response('{}', { status })).notifySessionCompleted({
          ...base,
          sessionId: sessionId as never,
          occurrenceId: 'turn-1',
          sessionTitle: 'Fix the build',
        });
      }
      // A hub without push holds no key this member could have copied.
      await memberPort(async () => new Response('{}', { status: 404 })).notifySessionCompleted({
        ...base,
        sessionId: 'session-4' as never,
        occurrenceId: 'turn-1',
        sessionTitle: 'Fix the build',
      });
      expect(direct.map((push) => push.collapseId)).toEqual([
        'done-session-1',
        'done-session-2',
        'done-session-3',
      ]);

      // A removal reaches the copy, and a LAN left takes its copy with it.
      expect((await call('DELETE', LAN_HUB_CREDENTIALS_GITHUB_PATH)).body).toEqual({
        removed: true,
      });
      await sync.syncNow();
      expect(readLanCredentialsGitHub(lan.id, memberDir)).toBeNull();
      joined = [];
      await sync.syncNow();
      expect(fs.existsSync(copy)).toBe(false);
    } finally {
      fs.rmSync(memberDir, { recursive: true, force: true });
    }
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

    // The phone reports the activity it started and is brought up to date.
    await register({ activities: { [ACTIVITY]: ACTIVITY_TOKEN } });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    // The same state again changes nothing on the phone and costs no push.
    await notifications.syncLiveActivitySummary(summary('running'));
    expect(sent).toHaveLength(2);
    // Past ten minutes it is pushed again, quietly, to move its stale date.
    clock += 10 * 60_000;
    await notifications.syncLiveActivitySummary(summary('running'));
    expect(sent[2]).toMatchObject({
      deviceToken: ACTIVITY_TOKEN,
      priority: 5,
      payload: { aps: { event: 'update' } },
    });

    const result = await notifications.syncLiveActivitySummary(summary('unread'));
    expect(sent[3]).toMatchObject({
      deviceToken: ACTIVITY_TOKEN,
      payload: {
        aps: {
          event: 'end',
          'dismissal-date': Math.floor(clock / 1000) + 60,
          // What was running ends as finished, with when it finished.
          'content-state': {
            totalCount: 1,
            statusCounts: { running: 0, unread: 1 },
            items: [{ id: 'session-1', status: 'unread', completedAt: clock }],
          },
        },
      },
    });
    expect(result).toEqual({ sent: true, ended: true });
  });

  it('shows only running work, the focus and one more, like the phone itself', async () => {
    await register({ activities: { [ACTIVITY]: ACTIVITY_TOKEN } });
    const item = (id: string, status: 'running' | 'question' | 'unread') => ({
      id,
      status,
      statusLabel: status,
      agentLogoKind: 'claude' as const,
      agentLogoText: 'CC',
      title: id,
      updatedAt: clock,
      updatedAtLabel: '',
    });
    await port().syncLiveActivitySummary({
      activityId: ACTIVITY,
      workspaceId: WORKSPACE as never,
      userId: USER,
      totalCount: 4,
      statusCounts: { permission: 0, question: 1, running: 2, unread: 1 },
      items: [
        item('b', 'running'),
        item('done', 'unread'),
        item('a', 'running'),
        item('q', 'question'),
      ],
      updatedAt: clock,
    });
    const state = (sent.at(-1)!.payload as { aps: { 'content-state': Record<string, unknown> } })
      .aps['content-state'];
    expect(state).toMatchObject({
      totalCount: 3,
      statusCounts: { question: 1, running: 2, unread: 0 },
      items: [{ id: 'q' }, { id: 'a' }],
    });
  });

  it('names the sending machine once more than one machine reports', async () => {
    await register({ locale: 'en-US' });
    const base = { workspaceId: WORKSPACE as never, workspaceSlug: 'lan', userId: USER };
    const done = (occurrenceId: string) => ({
      ...base,
      sessionId: 's' as never,
      occurrenceId,
      sessionTitle: 'Build',
    });
    await port('machine-1', 'homenucserver').notifySessionCompleted(done('t1'));
    await port('machine-2', 'macbook-air').notifySessionCompleted(done('t2'));

    const alerts = sent.map((push) => (push.payload as { aps: { alert: unknown } }).aps.alert);
    expect(alerts).toEqual([
      { title: 'Build', body: 'Finished' },
      { title: 'Build', subtitle: 'macbook-air', body: 'Finished' },
    ]);
  });

  it('keeps the earliest start of a turn across a permission pause', async () => {
    await register({ activities: { [ACTIVITY]: ACTIVITY_TOKEN } });
    const notifications = port();
    const summary = (status: 'running' | 'permission', startedAt: number) => ({
      activityId: ACTIVITY,
      workspaceId: WORKSPACE as never,
      userId: USER,
      totalCount: 1,
      statusCounts: { permission: 0, question: 0, running: 0, unread: 0, [status]: 1 },
      items: [
        {
          id: 'session-1',
          status,
          statusLabel: status,
          agentLogoKind: 'claude' as const,
          agentLogoText: 'CC',
          title: 'Fix the build',
          updatedAt: clock - 3_600_000,
          updatedAtLabel: '',
          startedAt,
        },
      ],
      updatedAt: clock,
    });
    type Pushed = { aps: { 'content-state': { items: { startedAt?: number }[] } } };
    const startedAtOf = (index: number) =>
      (sent[index]!.payload as Pushed).aps['content-state'].items[0]?.startedAt;

    await notifications.syncLiveActivitySummary(summary('running', clock - 600_000));
    await notifications.syncLiveActivitySummary(summary('permission', clock - 120_000));
    // The agent resumes after approval and stamps a later lastRunningSeen.
    await notifications.syncLiveActivitySummary(summary('running', clock - 60_000));
    expect(sent).toHaveLength(3);
    expect(startedAtOf(0)).toBe(clock - 600_000);
    expect(startedAtOf(1)).toBe(clock - 600_000);
    expect(startedAtOf(2)).toBe(clock - 600_000);
  });

  it('ends an activity whose token arrives after its turn already finished', async () => {
    await register();
    const notifications = port();
    const summary = (status: 'running' | 'unread') => ({
      activityId: ACTIVITY,
      workspaceId: WORKSPACE as never,
      userId: USER,
      totalCount: 1,
      statusCounts: { permission: 0, question: 0, running: 0, unread: 0, [status]: 1 },
      items: [
        {
          id: 'session-1',
          status,
          statusLabel: status,
          agentLogoKind: 'claude' as const,
          agentLogoText: 'CC',
          title: 'Quick fix',
          updatedAt: clock,
          updatedAtLabel: '',
        },
      ],
      updatedAt: clock,
    });
    await notifications.syncLiveActivitySummary(summary('running'));
    expect(sent.map((push) => (push.payload as { aps: { event: string } }).aps.event)).toEqual([
      'start',
    ]);
    // The turn is over before the phone reports the started activity.
    await notifications.syncLiveActivitySummary(summary('unread'));
    expect(sent).toHaveLength(1);

    await register({ activities: { [ACTIVITY]: ACTIVITY_TOKEN } });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({
      deviceToken: ACTIVITY_TOKEN,
      payload: { aps: { event: 'end' } },
    });
    // Registering the same token again pushes nothing more.
    await register({ activities: { [ACTIVITY]: ACTIVITY_TOKEN } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent).toHaveLength(2);
  });

  it('adds what the agent is doing and answers a permission from the phone', async () => {
    await register({ activities: { [ACTIVITY]: ACTIVITY_TOKEN } });
    const notifications = port();
    const base = { workspaceId: WORKSPACE as never, userId: USER };
    const summary = (status: 'running' | 'permission') => ({
      ...base,
      activityId: ACTIVITY,
      totalCount: 1,
      statusCounts: { permission: 0, question: 0, running: 0, unread: 0, [status]: 1 },
      items: [
        {
          id: 'session-1',
          status,
          statusLabel: status,
          agentLogoKind: 'claude' as const,
          agentLogoText: 'CC',
          title: 'Deploy',
          updatedAt: clock,
          updatedAtLabel: '',
        },
      ],
      updatedAt: clock,
    });
    const lastItem = () =>
      (
        sent.at(-1)!.payload as {
          aps: { 'content-state': { items: Record<string, unknown>[] } };
        }
      ).aps['content-state'].items[0];

    await notifications.syncLiveActivitySummary(summary('running'));
    await notifications.syncLiveActivityDetail({
      ...base,
      sessionId: 'session-1' as never,
      activity: 'Run pnpm build',
      thought: 'The bundle is ready to ship.',
    });
    await vi.waitFor(() =>
      expect(lastItem()).toMatchObject({
        activity: 'Run pnpm build',
        thought: 'The bundle is ready to ship.',
      })
    );
    // One member: no need to say which.
    expect(lastItem()).not.toHaveProperty('machineName');

    const options = [
      { id: 'once', label: 'Allow', kind: 'allow_once' },
      { id: 'no', label: 'Reject', kind: 'reject_once' },
    ];
    await notifications.syncLiveActivitySummary(summary('permission'));
    await notifications.syncLiveActivityDetail({
      ...base,
      sessionId: 'session-1' as never,
      permission: { requestId: 'req-1', command: 'git push', options },
    });
    await vi.waitFor(() =>
      expect(lastItem()).toMatchObject({
        permissionRequestId: 'req-1',
        permissionCommand: 'git push',
        permissionOptions: options,
      })
    );

    const answered: unknown[] = [];
    const stop = notifications.watchPermissionAnswers(async (answer) => {
      answered.push(answer);
    });
    try {
      const answer = (requestId: string, optionId: string) =>
        call('POST', '/push/permission', { sessionId: 'session-1', requestId, optionId });
      expect((await answer('req-0', 'once')).status).toBe(409);
      expect((await answer('req-1', 'bogus')).status).toBe(409);
      expect(await answer('req-1', 'once')).toEqual({ status: 200, body: { ok: true } });
      await vi.waitFor(() =>
        expect(answered).toEqual([{ sessionId: 'session-1', requestId: 'req-1', optionId: 'once' }])
      );
      // Answered once; the same request cannot be answered again.
      expect((await answer('req-1', 'no')).status).toBe(409);
    } finally {
      stop();
    }
  });

  const sessionItem = (status: 'running' | 'permission' | 'unread', title = 'Deploy') => ({
    id: 'session-1',
    status,
    statusLabel: status,
    agentLogoKind: 'claude' as const,
    agentLogoText: 'CC',
    title,
    updatedAt: clock,
    updatedAtLabel: '',
  });
  const sessionSummary = (
    status: 'running' | 'permission' | 'unread',
    extra: { title?: string; permissionAlert?: { title: string; body: string } } = {}
  ) => ({
    activityId: ACTIVITY,
    workspaceId: WORKSPACE as never,
    userId: USER,
    totalCount: 1,
    statusCounts: { permission: 0, question: 0, running: 0, unread: 0, [status]: 1 },
    items: [sessionItem(status, extra.title)],
    updatedAt: clock,
    ...(extra.permissionAlert ? { permissionAlert: extra.permissionAlert } : {}),
  });
  type ContentState = {
    statusCounts: Record<string, number>;
    items: Record<string, unknown>[];
    permissionAlert?: unknown;
  };
  const contentOf = (push: ApnsPush) =>
    (push.payload as { aps: { 'content-state': ContentState } }).aps['content-state'];

  it('shows at once a permission request answered on another device', async () => {
    await register({ activities: { [ACTIVITY]: ACTIVITY_TOKEN } });
    const notifications = port();
    const base = { workspaceId: WORKSPACE as never, userId: USER };
    const alertCopy = { title: 'Permission Required', body: 'Deploy' };

    await notifications.syncLiveActivitySummary(
      sessionSummary('permission', { permissionAlert: alertCopy })
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ priority: 10 });
    expect(contentOf(sent[0]!)).toMatchObject({
      statusCounts: { permission: 1 },
      permissionAlert: alertCopy,
    });
    await notifications.syncLiveActivityDetail({
      ...base,
      sessionId: 'session-1' as never,
      permission: {
        requestId: 'req-1',
        command: 'git push',
        options: [{ id: 'once', label: 'Allow', kind: 'allow_once' }],
      },
    });
    await vi.waitFor(() => expect(sent).toHaveLength(2));

    // Approved on the desktop. The member clears the request first and sends
    // its next summary only once the session runs again.
    await notifications.syncLiveActivityDetail({
      ...base,
      sessionId: 'session-1' as never,
      permission: null,
    });
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    expect(sent[2]).toMatchObject({ priority: 10, payload: { aps: { event: 'update' } } });
    expect(contentOf(sent[2]!)).toMatchObject({
      statusCounts: { permission: 0, running: 1 },
      items: [{ id: 'session-1', status: 'running', statusLabel: '运行中' }],
    });
    expect(contentOf(sent[2]!)).not.toHaveProperty('permissionAlert');
    expect(contentOf(sent[2]!).items[0]).not.toHaveProperty('permissionRequestId');

    // The summary that follows agrees with what the phone shows already.
    await notifications.syncLiveActivitySummary(sessionSummary('running'));
    expect(sent).toHaveLength(3);
    // Later changes to running work go out quietly again.
    await notifications.syncLiveActivitySummary(sessionSummary('running', { title: 'Deploy v2' }));
    expect(sent).toHaveLength(4);
    expect(sent[3]).toMatchObject({ priority: 5 });
  });

  it('pushes leaving a permission request at high priority', async () => {
    await register({ activities: { [ACTIVITY]: ACTIVITY_TOKEN } });
    const notifications = port();
    await notifications.syncLiveActivitySummary(sessionSummary('running'));
    await notifications.syncLiveActivitySummary(
      sessionSummary('permission', { permissionAlert: { title: 'Permission Required', body: '' } })
    );
    await notifications.syncLiveActivitySummary(sessionSummary('running'));
    expect(sent.map((push) => push.priority)).toEqual([5, 10, 10]);
    expect(contentOf(sent[2]!)).toMatchObject({ statusCounts: { permission: 0, running: 1 } });
  });

  it('withdraws a permission alert once the request is answered', async () => {
    await register({ locale: 'en-US' });
    const notifications = port();
    const request = {
      workspaceId: WORKSPACE as never,
      workspaceSlug: 'lan',
      userId: USER,
      sessionId: 'session-1' as never,
      sessionTitle: 'Deploy',
      requestId: 'req-1',
      toolCallId: 'tool-1',
      toolTitle: 'git push',
    };

    // Answered before its alert went out: nothing to withdraw, and an alert
    // arriving after the answer is not sent at all.
    await notifications.resolvePermissionRequested({ ...request, requestId: 'req-0' });
    await notifications.notifyPermissionRequested({ ...request, requestId: 'req-0' });
    expect(sent).toHaveLength(0);

    await notifications.notifyPermissionRequested(request);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      pushType: 'alert',
      priority: 10,
      collapseId: 'permission-req-1',
      payload: {
        aps: {
          alert: { title: 'Deploy', body: 'Needs your approval: git push' },
          sound: 'default',
        },
        lodyKind: 'permission-requested',
        requestId: 'req-1',
        sessionId: 'session-1',
      },
    });

    await notifications.resolvePermissionRequested(request);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({
      deviceToken: PHONE,
      environment: 'development',
      topic: 'com.example.lody',
      pushType: 'alert',
      priority: 5,
      collapseId: 'permission-req-1',
      payload: {
        aps: {
          alert: { title: 'Deploy', body: 'Handled on another device' },
          'interruption-level': 'passive',
          'thread-id': 'session-1',
        },
        lodyKind: 'permission-resolved',
        sessionId: 'session-1',
        requestId: 'req-1',
        recipientUserId: USER,
        route: '/lan/sessions/session-1',
      },
    });

    // Withdrawn once.
    await notifications.resolvePermissionRequested(request);
    expect(sent).toHaveLength(2);
  });

  it('withdraws an alert a member sent itself while the hub was away', async () => {
    await register();
    const pem = crypto
      .generateKeyPairSync('ec', { namedCurve: 'P-256' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    const apns = { keyId: 'ABCDEFGHIJ', teamId: 'TEAM123456', privateKey: pem };
    expect((await call('PUT', LAN_HUB_CREDENTIALS_APNS_PATH, apns)).status).toBe(200);
    const memberDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-lan-member-'));
    try {
      const lan = { ...member(), id: 'd'.repeat(32) };
      await createLanCredentialSync({
        hubs: () => [lan],
        logger: { debug: () => {}, info: () => {}, warn: () => {} } as never,
        dataDir: memberDir,
      }).syncNow();
      const direct: ApnsPush[] = [];
      let away = true;
      const notifications = createLanNotificationsPort({
        resolveHub: () => lan,
        machineId: 'machine-1',
        logger: { debug: () => {} } as never,
        fetch: (input, init) =>
          away ? Promise.reject(new TypeError('fetch failed')) : fetch(input, init),
        fallback: createLanPushFallback({
          logger: { debug: () => {} } as never,
          dataDir: memberDir,
          createSender: () =>
            Object.assign(
              async (push: ApnsPush) => {
                direct.push(push);
                return { ok: true as const };
              },
              { close: () => {} }
            ),
        }),
      });
      const request = {
        workspaceId: WORKSPACE as never,
        workspaceSlug: 'lan',
        userId: USER,
        sessionId: 'session-1' as never,
        requestId: 'req-1',
        toolCallId: 'tool-1',
      };
      await notifications.notifyPermissionRequested(request);
      expect(direct).toHaveLength(1);

      // The hub is back but never heard of the alert; the member withdraws its own.
      away = false;
      await notifications.resolvePermissionRequested(request);
      expect(sent).toHaveLength(0);
      expect(direct).toHaveLength(2);
      expect(direct[1]).toMatchObject({
        priority: 5,
        collapseId: 'permission-req-1',
        payload: {
          aps: {
            alert: { title: '新任务', body: '已在其他设备处理' },
            'interruption-level': 'passive',
          },
          lodyKind: 'permission-resolved',
          requestId: 'req-1',
        },
      });
      expect((direct[1]!.payload as { aps: object }).aps).not.toHaveProperty('sound');
    } finally {
      fs.rmSync(memberDir, { recursive: true, force: true });
    }
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

describe('LAN hub push sweep', () => {
  const START = 1_800_000_000_000;
  let dataDir: string;
  let sent: ApnsPush[];
  let failing: Set<string>;
  let pushes: LanHubPush[];

  beforeEach(() => {
    vi.useFakeTimers({ now: START });
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-lan-sweep-'));
    sent = [];
    failing = new Set();
    pushes = [];
  });

  afterEach(() => {
    for (const push of pushes) push.close();
    vi.useRealTimers();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /** A phone the hub remembers from before it started. */
  const storePhone = (activities: Record<string, string>) =>
    fs.writeFileSync(
      path.join(dataDir, 'push-devices.json'),
      JSON.stringify({
        devices: [
          {
            deviceToken: PHONE,
            environment: 'development',
            bundleId: 'com.example.lody',
            userId: USER,
            workspaceId: WORKSPACE,
            workspaceSlug: 'lan',
            workspaceName: 'Home',
            locale: 'en-US',
            pushToStartToken: null,
            activities,
            updatedAt: START,
          },
        ],
      })
    );
  const start = (options: { sweepIntervalMs?: number; isServing?: () => boolean } = {}) => {
    const push = createLanHubPush({
      dataDir,
      send: async (message) => {
        sent.push(message);
        return failing.has(message.deviceToken)
          ? { ok: false, status: 500, reason: 'InternalServerError', unregistered: false }
          : { ok: true };
      },
      isConfigured: () => true,
      sweepIntervalMs: LAN_PUSH_SWEEP_INTERVAL_MS,
      ...options,
    });
    pushes.push(push);
    return push;
  };
  const register = async (push: LanHubPush, activities: Record<string, string>) => {
    const request = Object.assign(
      Readable.from([
        Buffer.from(
          JSON.stringify({
            deviceToken: PHONE,
            environment: 'development',
            bundleId: 'com.example.lody',
            userId: USER,
            workspaceId: WORKSPACE,
            locale: 'en-US',
            activities,
          })
        ),
      ]),
      { url: '/push/devices', method: 'PUT', headers: {} }
    ) as unknown as http.IncomingMessage;
    let status = 0;
    const response = {
      headersSent: false,
      writeHead: (code: number) => (status = code),
      end: () => {},
    } as unknown as http.ServerResponse;
    await push.handle(request, response);
    expect(status).toBe(200);
  };
  const summary = (status: 'running' | 'unread'): LanPushEvent => ({
    type: 'live-activity',
    machineId: 'machine-1',
    workspaceId: WORKSPACE,
    workspaceSlug: WORKSPACE,
    userId: USER,
    activityId: ACTIVITY,
    totalCount: 1,
    statusCounts: { permission: 0, question: 0, running: 0, unread: 0, [status]: 1 },
    items: [
      {
        id: 'session-1',
        status,
        statusLabel: status,
        agentLogoKind: 'claude',
        agentLogoText: 'CC',
        title: 'Deploy',
        updatedAt: START,
        updatedAtLabel: '',
      },
    ],
    updatedAt: Date.now(),
  });
  const events = () =>
    sent.map((message) => (message.payload as { aps: { event: string } }).aps.event);
  const minutes = (count: number) => vi.advanceTimersByTimeAsync(count * 60_000);

  it('ends an activity once the member running it stops reporting', async () => {
    storePhone({ [ACTIVITY]: ACTIVITY_TOKEN });
    const push = start();
    await push.deliver(summary('running'));
    expect(events()).toEqual(['update']);

    await minutes(7);
    expect(events()).toEqual(['update']);
    await minutes(2);
    expect(events()).toEqual(['update', 'end']);
    expect(sent[1]).toMatchObject({
      deviceToken: ACTIVITY_TOKEN,
      priority: 10,
      payload: { aps: { 'content-state': { items: [{ id: 'session-1', status: 'unread' }] } } },
    });
    expect(push.devices()[0]!.activities).toEqual({});
    await minutes(10);
    expect(sent).toHaveLength(2);
  });

  it('keeps an activity its member keeps reporting, and refreshes it quietly', async () => {
    storePhone({ [ACTIVITY]: ACTIVITY_TOKEN });
    const push = start();
    await push.deliver(summary('running'));
    for (let beat = 0; beat < 12; beat += 1) {
      await minutes(2);
      await push.deliver(summary('running'));
    }
    // Nothing changed: pushed when it began and to move its stale date since.
    expect(events()).toEqual(['update', 'update', 'update']);
    expect(sent.map((message) => message.priority)).toEqual([5, 5, 5]);
  });

  it('ends after a restart an activity no member reports, once they had time to', async () => {
    storePhone({ [ACTIVITY]: ACTIVITY_TOKEN });
    const push = start();
    await minutes(4);
    expect(sent).toHaveLength(0);
    await minutes(1);
    expect(events()).toEqual(['end']);
    expect(sent[0]).toMatchObject({
      deviceToken: ACTIVITY_TOKEN,
      payload: { aps: { 'content-state': { totalCount: 0, items: [] } } },
    });
    expect(push.devices()[0]!.activities).toEqual({});
  });

  it('gives a member time to report an activity the phone just started', async () => {
    storePhone({});
    const push = start();
    await minutes(10);
    await register(push, { [ACTIVITY]: ACTIVITY_TOKEN });
    await minutes(4);
    expect(sent).toHaveLength(0);
    await minutes(1);
    expect(events()).toEqual(['end']);
  });

  it('leaves activities alone where it does not serve the LAN or only sends alerts', async () => {
    storePhone({ [ACTIVITY]: ACTIVITY_TOKEN });
    start({ isServing: () => false });
    // A member's copy, for alerts while the hub is away.
    start({ sweepIntervalMs: undefined });
    await minutes(30);
    expect(sent).toHaveLength(0);
  });

  it('keeps the token of an end APNs did not take, and ends it later', async () => {
    storePhone({ [ACTIVITY]: ACTIVITY_TOKEN });
    const push = start();
    await push.deliver(summary('running'));
    failing.add(ACTIVITY_TOKEN);
    await push.deliver(summary('unread'));
    expect(events()).toEqual(['update', 'end']);
    expect(push.devices()[0]!.activities).toEqual({ [ACTIVITY]: ACTIVITY_TOKEN });
    // The phone still lists the activity and registers it again; it stays.
    await register(push, { [ACTIVITY]: ACTIVITY_TOKEN });
    expect(push.devices()[0]!.activities).toEqual({ [ACTIVITY]: ACTIVITY_TOKEN });

    failing.clear();
    await minutes(1);
    expect(events()).toEqual(['update', 'end', 'end']);
    expect(push.devices()[0]!.activities).toEqual({});
    // Ended for good: registering it again does not bring it back.
    await register(push, { [ACTIVITY]: ACTIVITY_TOKEN });
    expect(push.devices()[0]!.activities).toEqual({});
    await minutes(10);
    expect(sent).toHaveLength(3);
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
