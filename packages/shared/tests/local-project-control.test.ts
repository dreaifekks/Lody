import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import {
  LocalProjectControlResponseSchema,
  safeParseLocalProjectControlRequest,
} from '../src/message-schemas';
import {
  isLocalProjectControlRequest,
  isLocalProjectControlResponse,
} from '../src/node/local-project-control';

describe('what the members of a LAN ask of each other', () => {
  const commonJs = createRequire(import.meta.url)('../src/node/local-project-control.cjs') as {
    isLocalProjectControlRequest: (value: unknown) => boolean;
    isLocalProjectControlResponse: (value: unknown) => boolean;
  };

  const accepts = (request: unknown) => ({
    schema: safeParseLocalProjectControlRequest(JSON.stringify(request)).success,
    module: isLocalProjectControlRequest(request),
    commonJs: commonJs.isLocalProjectControlRequest(request),
  });
  const answers = (response: unknown) => ({
    schema: LocalProjectControlResponseSchema.safeParse(response).success,
    module: isLocalProjectControlResponse(response),
    commonJs: commonJs.isLocalProjectControlResponse(response),
  });
  const all = (value: boolean) => ({ schema: value, module: value, commonJs: value });

  const member = { machineId: 'machine-2', workspaceId: 'lw_home' };
  const update = { type: 'lan/update-machine', ...member };
  const install = { type: 'lan/install-agent', ...member, agentType: 'claude' };
  const preview = { type: 'hosted-config/preview', ...member };
  const importing = {
    type: 'hosted-config/import',
    ...member,
    sourceWorkspaceId: 'hosted',
    categories: ['agentConfigs', 'localProjects'],
  };
  const usage = { type: 'lan/usage', ...member, sinceMs: 1_700_000_000_000 };
  const usageByAgent = { type: 'lan/usage-by-agent', ...member, sinceMs: 1_700_000_000_000 };
  const restart = { type: 'lan/restart-machine', ...member };
  const github = { type: 'lan/github', ...member };

  it('reads each request the same way at every boundary', () => {
    for (const request of [
      update,
      install,
      preview,
      importing,
      usage,
      { ...usage, sinceMs: undefined },
      usageByAgent,
      { ...usageByAgent, sinceMs: undefined },
      restart,
      github,
    ]) {
      expect(accepts(request)).toEqual(all(true));
      expect(accepts({ type: 'lan/forward', machineId: 'machine-1', request })).toEqual(all(true));
    }
    expect(accepts({ type: 'lan/machines', machineId: 'machine-1' })).toEqual(all(true));
    const alias = { type: 'lan/alias-machine', machineId: 'machine-1', target: 'machine-2' };
    expect(accepts({ ...alias, alias: 'nas' })).toEqual(all(true));
    expect(accepts({ ...alias, alias: null })).toEqual(all(true));
    expect(accepts({ ...alias, alias: 'x'.repeat(33) })).toEqual(all(false));
    expect(accepts({ ...alias, alias: 'nas', target: undefined })).toEqual(all(false));
    expect(accepts({ ...alias, alias: 'nas', color: 'teal' })).toEqual(all(true));
    expect(accepts({ ...alias, alias: 'nas', color: null })).toEqual(all(true));
    expect(accepts({ ...alias, alias: 'nas', color: '#ff0000' })).toEqual(all(false));

    expect(accepts({ ...install, agentType: undefined })).toEqual(all(false));
    expect(accepts({ ...importing, categories: ['sessions'] })).toEqual(all(false));
    expect(accepts({ type: 'lan/update-machine', machineId: 'machine-2' })).toEqual(all(false));
    expect(accepts({ type: 'lan/restart-machine', machineId: 'machine-2' })).toEqual(all(false));
    expect(accepts({ ...usage, sinceMs: -1 })).toEqual(all(false));
    expect(accepts({ ...usage, sinceMs: 1.5 })).toEqual(all(false));

    const token = { type: 'lan/github-token', machineId: 'machine-1', workspaceId: 'lw_home' };
    expect(accepts({ ...token, token: 'github_pat_1' })).toEqual(all(true));
    expect(accepts({ ...token, token: null })).toEqual(all(true));
    expect(accepts({ ...token, token: '   ' })).toEqual(all(false));
    expect(accepts({ ...token, token: 'x'.repeat(1_001) })).toEqual(all(false));
    expect(accepts({ ...token, token: 'github_pat_1', workspaceId: undefined })).toEqual(
      all(false)
    );

    const lan = { machineId: 'machine-1', workspaceId: 'lw_home' };
    const shareId = 'A'.repeat(32);
    const publish = {
      type: 'lan/share-publish',
      ...lan,
      directory: '/tmp/share-1',
      rootSourceId: 'root',
      sources: [{ sourceId: 'root', conversationId: 'session-1' }],
    };
    expect(accepts({ type: 'lan/shares', ...lan })).toEqual(all(true));
    expect(accepts(publish)).toEqual(all(true));
    expect(accepts({ ...publish, shareId, expectedRevision: 2 })).toEqual(all(true));
    expect(accepts({ ...publish, sources: [] })).toEqual(all(false));
    expect(accepts({ ...publish, shareId: 'short' })).toEqual(all(false));
    expect(accepts({ type: 'lan/share-revoke', ...lan, shareId })).toEqual(all(true));
    expect(accepts({ type: 'lan/share-revoke', ...lan, shareId: '../x' })).toEqual(all(false));
    const settings = { type: 'lan/share-settings', ...lan };
    expect(accepts(settings)).toEqual(all(true));
    expect(accepts({ ...settings, publicUrl: 'https://share.example.com' })).toEqual(all(true));
    expect(accepts({ ...settings, publicUrl: null })).toEqual(all(true));
    expect(accepts({ ...settings, publicUrl: 1 })).toEqual(all(false));
    const image = { type: 'lan/share-image', ...lan, kind: 'icon', path: '/tmp/icon.png' };
    expect(accepts(image)).toEqual(all(true));
    expect(accepts({ ...image, kind: 'preview', path: null })).toEqual(all(true));
    expect(accepts({ ...image, kind: 'banner' })).toEqual(all(false));
    expect(accepts({ ...image, path: '' })).toEqual(all(false));
  });

  it('forwards nothing but what members ask of each other', () => {
    const forward = (request: unknown) =>
      accepts({ type: 'lan/forward', machineId: 'machine-1', request });

    expect(
      forward({ type: 'local-project/add', machineId: 'machine-2', rootPath: '/tmp/project' })
    ).toEqual(all(false));
    expect(forward({ type: 'lan/machines', machineId: 'machine-2' })).toEqual(all(false));
    // A short name is written by this machine; no member is asked for it.
    expect(
      forward({
        type: 'lan/alias-machine',
        machineId: 'machine-2',
        target: 'machine-2',
        alias: 'x',
      })
    ).toEqual(all(false));
    expect(forward({ type: 'lan/forward', machineId: 'machine-2', request: update })).toEqual(
      all(false)
    );
    // A token goes to the hub from this machine; no member is handed one.
    expect(forward({ type: 'lan/github-token', ...member, token: 'github_pat_1' })).toEqual(
      all(false)
    );
    expect(forward(undefined)).toEqual(all(false));
  });

  it('reads each answer the same way at every boundary', () => {
    const usageRow = {
      startMs: 1_700_000_000_000,
      spanMs: 3_600_000,
      modelId: 'claude-opus',
      inputTokens: 10,
      outputTokens: 2,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
      costUSD: 0.01,
    };
    const started = {
      ok: true,
      type: 'lan/update-machine',
      result: { outcome: 'started', version: '0.100.0-lan.4' },
    };
    const refused = {
      ok: false,
      type: 'lan/update-machine',
      error: 'execution_failed',
      message: 'The desktop application updates this agent service',
      data: { reason: 'desktop' },
    };
    const shareSettings = {
      publicUrl: 'https://share.example.com',
      hubUrl: 'http://hub.lan:18790',
      icon: true,
      preview: false,
    };
    const sharedConversation = {
      shareId: 'A'.repeat(32),
      title: 'A discussion',
      rootSourceId: 'root',
      sources: [{ sourceId: 'root', conversationId: 'session-1' }],
      conversationCount: 1,
      revision: 1,
      deployment: 'a'.repeat(64),
      createdAt: '2026-10-08T00:00:00.000Z',
      updatedAt: '2026-10-08T00:00:00.000Z',
      url: null,
    };
    const machines = {
      ok: true,
      type: 'lan/machines',
      result: {
        newest: { version: '0.100.0-lan.4', commit: 'abcdef1', builtAt: '2026-09-29T00:00:00Z' },
        machines: [
          {
            machineId: 'machine-2',
            name: 'server',
            alias: 'nas',
            os: 'linux',
            self: false,
            online: true,
            lans: [{ workspaceId: 'lw_home', name: 'Home' }],
            version: '0.100.0-lan.3',
            build: { version: '0.100.0-lan.3', update: 'service' },
            update: null,
            controllable: true,
            agents: [
              { agentType: 'claude', name: 'Claude Code', version: '2.1.280', state: 'current' },
            ],
          },
        ],
      },
    };

    for (const response of [
      started,
      refused,
      machines,
      { ok: true, type: 'lan/install-agent', result: { agentType: 'claude', outcome: 'current' } },
      { ok: true, type: 'lan/alias-machine', result: { alias: 'nas' } },
      { ok: true, type: 'lan/alias-machine', result: { alias: null } },
      { ok: true, type: 'lan/alias-machine', result: { alias: 'nas', color: 'teal' } },
      { ok: true, type: 'lan/forward', result: { response: started } },
      { ok: true, type: 'lan/forward', result: { response: refused } },
      { ok: true, type: 'lan/usage', result: { rows: [usageRow] } },
      {
        ok: true,
        type: 'lan/usage-by-agent',
        result: { rows: [{ ...usageRow, agent: 'claude' }] },
      },
      { ok: true, type: 'lan/usage-by-agent', result: { rows: [{ ...usageRow, agent: null }] } },
      { ok: true, type: 'lan/restart-machine', result: { outcome: 'started' } },
      { ok: true, type: 'lan/github', result: { own: { login: 'me' }, lan: null } },
      { ok: true, type: 'lan/github', result: { own: null, lan: { login: null } } },
      { ok: true, type: 'lan/github-token', result: { login: 'octocat' } },
      { ok: true, type: 'lan/github-token', result: { login: null } },
      { ok: true, type: 'lan/shares', result: { shares: [sharedConversation] } },
      { ok: true, type: 'lan/share-publish', result: { share: sharedConversation } },
      { ok: true, type: 'lan/share-revoke', result: { revoked: true } },
      { ok: true, type: 'lan/share-settings', result: shareSettings },
      { ok: true, type: 'lan/share-image', result: { ...shareSettings, publicUrl: null } },
      {
        ok: true,
        type: 'lan/forward',
        result: { response: { ok: true, type: 'lan/github', result: { own: null, lan: null } } },
      },
      {
        ok: true,
        type: 'lan/forward',
        result: { response: { ok: true, type: 'lan/usage', result: { rows: [] } } },
      },
      {
        ok: true,
        type: 'lan/forward',
        result: { response: { ok: true, type: 'lan/usage-by-agent', result: { rows: [] } } },
      },
    ]) {
      expect(answers(response)).toEqual(all(true));
    }

    expect(
      answers({ ok: true, type: 'lan/update-machine', result: { outcome: 'done', version: '1' } })
    ).toEqual(all(false));
    expect(
      answers({ ok: true, type: 'lan/restart-machine', result: { outcome: 'current' } })
    ).toEqual(all(false));
    expect(answers({ ok: true, type: 'lan/forward', result: { response: machines } })).toEqual(
      all(false)
    );
    expect(answers({ ok: true, type: 'lan/github', result: { own: 'me', lan: null } })).toEqual(
      all(false)
    );
    expect(answers({ ok: true, type: 'lan/github-token', result: {} })).toEqual(all(false));
    expect(answers({ ok: true, type: 'lan/share-revoke', result: {} })).toEqual(all(false));
    expect(
      answers({ ok: true, type: 'lan/share-settings', result: { ...shareSettings, icon: 'x' } })
    ).toEqual(all(false));
    expect(
      answers({ ok: true, type: 'lan/share-image', result: { ...shareSettings, token: 't' } })
    ).toEqual(all(false));
    expect(
      answers({
        ok: true,
        type: 'lan/usage',
        result: { rows: [{ ...usageRow, costUSD: undefined }] },
      })
    ).toEqual(all(false));
    // The agent travels only with its own request: a build before it reads
    // `lan/usage` rows strictly, and a row of the new one says which agent it had.
    expect(
      answers({ ok: true, type: 'lan/usage', result: { rows: [{ ...usageRow, agent: 'claude' }] } })
    ).toEqual(all(false));
    expect(answers({ ok: true, type: 'lan/usage-by-agent', result: { rows: [usageRow] } })).toEqual(
      all(false)
    );
  });
});
