import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LanHub } from '@lody/shared/node/lan-hub';
import type { LanGitHubCredential } from '@lody/shared/node/lan-github';
import { GitHubCredentialResolver } from '@/lib/pr-poller/github-credential-resolver';
import type { Logger } from '@/utils/logger';
import { readLanHubGitHubConfig } from './hub-github';
import { startLanHubServer, type LanHubServer, type LanHubUpstream } from './hub-server';
import { applyLanGitHubCredentialEnv, createGhLoginProbe } from './lan-agent-github';
import { createLanGitHubSource } from './lan-github-credential';
import { createLanGitHubTokenPort } from './lan-github-tokens';

const silentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
  setLevel: () => {},
  setDebug: () => {},
  child: () => silentLogger(),
  close: async () => {},
});
const logger = silentLogger();
const hub: LanHub = { id: 'lan1', name: 'Home', url: 'http://hub.invalid', token: 'lan-secret' };

/** A host that answers with whatever `answer` holds, and counts what it was asked. */
function fakeHost(answer: { status: number; body?: unknown }) {
  const seen: { url: string; authorization: string | null }[] = [];
  const request: typeof fetch = (input, init) => {
    seen.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('authorization'),
    });
    return Promise.resolve(
      new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
        status: answer.status,
      })
    );
  };
  return { request, seen, answer };
}

function createPort(
  host: ReturnType<typeof fakeHost>,
  clock: { now: number },
  copies: Record<string, LanGitHubCredential> = {}
) {
  return createLanGitHubTokenPort({
    resolveHub: (workspaceId) => (workspaceId === 'lw_lan1' ? hub : null),
    logger,
    fetch: host.request,
    readCopy: (hubId) => copies[hubId] ?? null,
    now: () => clock.now,
  });
}

const unreachable: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));

const context = { requesterUserId: 'user', machineId: 'machine' };

describe('LAN GitHub token port', () => {
  it('asks the host of the workspace once and answers every repository with its token', async () => {
    const host = fakeHost({
      status: 200,
      body: { token: 'github_pat_1', login: 'octocat', userId: '583231' },
    });
    const clock = { now: 0 };
    const manager = createPort(host, clock).createTokenManager('lw_lan1');

    await expect(manager.getWriteTokenInfoForRepo('a/one', context)).resolves.toEqual({
      token: 'github_pat_1',
      tokenSource: 'app',
      rateLimitScope: 'github:user:583231',
    });
    await expect(manager.getAppTokenForRepo('b/two')).resolves.toBe('github_pat_1');
    expect(host.seen).toEqual([
      { url: 'http://hub.invalid/github/token', authorization: 'Bearer lan-secret' },
    ]);
    await expect(manager.getCredentialPolicy(context)).resolves.toEqual({
      personalEnabled: false,
    });

    // A token GitHub turned down is asked for again.
    host.answer.body = { token: 'github_pat_2', login: 'octocat', userId: '583231' };
    manager.invalidate('a/one', { invalidatedToken: 'github_pat_1' });
    await expect(manager.getAppTokenForRepo('a/one')).resolves.toBe('github_pat_2');
    expect(host.seen).toHaveLength(2);
  });

  it('remembers for a while that the host keeps no token', async () => {
    const host = fakeHost({ status: 404, body: { error: 'not_configured' } });
    const clock = { now: 0 };
    const manager = createPort(host, clock).createTokenManager('lw_lan1');

    await expect(manager.getAppTokenForRepo('a/one')).rejects.toThrow('keeps no GitHub token');
    await expect(manager.getAppTokenForRepo('a/one')).rejects.toThrow();
    expect(host.seen).toHaveLength(1);

    host.answer.status = 200;
    host.answer.body = { token: 'github_pat_1', login: null, userId: null };
    clock.now = 60_000;
    await expect(manager.getAppTokenInfoForRepo('a/one')).resolves.toMatchObject({
      token: 'github_pat_1',
      rateLimitScope: 'github:lan:lw_lan1',
    });
  });

  it("uses this machine's copy of the token while the host is away", async () => {
    const host = fakeHost({
      status: 200,
      body: { token: 'github_pat_2', login: 'o', userId: '7' },
    });
    const away = { ...host, request: unreachable };
    const clock = { now: 0 };
    const copies = { lan1: { token: 'github_pat_1', login: 'o', userId: '7' } };

    const manager = createPort(away, clock, copies).createTokenManager('lw_lan1');
    await expect(manager.getAppTokenForRepo('a/one')).resolves.toBe('github_pat_1');

    const noCopy = createPort(away, clock).createTokenManager('lw_lan1');
    await expect(noCopy.getAppTokenForRepo('a/one')).rejects.toThrow('could not be asked');
  });

  it('asks the host again soon after standing in with the copy', async () => {
    let away = true;
    const host = fakeHost({
      status: 200,
      body: { token: 'github_pat_2', login: 'o', userId: '7' },
    });
    const flaky = {
      ...host,
      request: ((input, init) =>
        away ? unreachable(input, init) : host.request(input, init)) as typeof fetch,
    };
    const clock = { now: 0 };
    const manager = createPort(flaky, clock, {
      lan1: { token: 'github_pat_1', login: 'o', userId: '7' },
    }).createTokenManager('lw_lan1');

    await expect(manager.getAppTokenForRepo('a/one')).resolves.toBe('github_pat_1');
    away = false;
    clock.now = 15_000;
    await expect(manager.getAppTokenForRepo('a/one')).resolves.toBe('github_pat_2');
  });

  it('has nothing for a workspace no LAN carries', async () => {
    const host = fakeHost({ status: 200, body: { token: 'github_pat_1' } });
    const manager = createPort(host, { now: 0 }).createTokenManager('lw_other');
    await expect(manager.getAppTokenForRepo('a/one')).rejects.toThrow('belongs to no LAN');
    expect(host.seen).toHaveLength(0);
  });

  it('lets the PR poller fall back to the gh login when the host keeps no token', async () => {
    const make = (host: ReturnType<typeof fakeHost>) =>
      new GitHubCredentialResolver({
        tokenManager: createPort(host, { now: 0 }).createTokenManager('lw_lan1'),
        writeTokenContext: context,
        workspaceId: 'lw_lan1',
        logger,
        harvestGhToken: () => Promise.resolve({ outcome: 'token', token: 'gho_machine' }),
        fetchGhUserId: () => Promise.resolve('1'),
      });

    const withToken = make(
      fakeHost({ status: 200, body: { token: 'github_pat_1', login: 'o', userId: '7' } })
    );
    await expect(withToken.resolve('a/one')).resolves.toEqual({
      token: 'github_pat_1',
      source: 'managed',
      credentialScope: 'github:user:7',
    });

    const without = make(fakeHost({ status: 404 }));
    await expect(without.resolve('a/one')).resolves.toMatchObject({
      token: 'gho_machine',
      source: 'gh',
    });
  });
});

describe('LAN GitHub token for agents', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** `git credential fill` in an isolated home, as an agent's git would ask. */
  function fill(env: Record<string, string>, host = 'github.com') {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-lan-github-'));
    dirs.push(home);
    const result = spawnSync('git', ['credential', 'fill'], {
      input: `protocol=https\nhost=${host}\n\n`,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: home,
        XDG_CONFIG_HOME: home,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        ...env,
      },
    });
    return result;
  }

  it('gives git and gh the token while keeping the git configuration it inherits', () => {
    const inherited = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'Inherited',
    };
    const env: Record<string, string> = {};
    applyLanGitHubCredentialEnv(env, 'github_pat_1', inherited);

    expect(env.GH_TOKEN).toBe('github_pat_1');
    expect(env.GIT_CONFIG_COUNT).toBe('3');
    expect(env.GIT_CONFIG_KEY_0).toBe('user.name');
    expect(env.GIT_CONFIG_VALUE_0).toBe('Inherited');

    const answered = fill(env);
    expect(answered.status).toBe(0);
    expect(answered.stdout).toContain('username=x-access-token\n');
    expect(answered.stdout).toContain('password=github_pat_1\n');

    // Another host never sees the token.
    const elsewhere = fill(env, 'gitlab.com');
    expect(elsewhere.stdout).not.toContain('github_pat_1');
  });

  it('asks gh whether it is logged in at most once a minute', async () => {
    const clock = { now: 0 };
    const answers = [false, true];
    let asked = 0;
    const probe = createGhLoginProbe(
      () => Promise.resolve(answers[asked++] ?? true),
      () => clock.now
    );
    await expect(probe()).resolves.toBe(false);
    clock.now = 59_999;
    await expect(probe()).resolves.toBe(false);
    clock.now = 60_000;
    await expect(probe()).resolves.toBe(true);
    expect(asked).toBe(2);
  });
});

describe('GitHub credentials in Settings > GitHub', () => {
  let dataDir: string;
  let upstream: http.Server;
  let server: LanHubServer;
  let member: LanHub;
  /** Who GitHub says each token acts as; a token it does not know is refused. */
  let accounts: Record<string, { login: string; id: number }>;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-lan-github-settings-'));
    // The data plane the hub fronts; it only has to take the bucket.
    upstream = http.createServer((request, response) =>
      response.writeHead(request.method === 'PUT' ? 201 : 200).end()
    );
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    let stopped: (code: number | null) => void = () => {};
    server = await startLanHubServer({
      host: '127.0.0.1',
      port: 0,
      dataDir,
      startUpstream: async (): Promise<LanHubUpstream> => ({
        port: (upstream.address() as AddressInfo).port,
        exited: new Promise((resolve) => (stopped = resolve)),
        stop: () => {
          upstream.closeAllConnections();
          upstream.close(() => stopped(0));
        },
      }),
    });
    member = { id: 'e'.repeat(32), name: 'Home', url: server.url, token: server.token };
    accounts = {
      github_pat_hub: { login: 'octocat', id: 583231 },
      gho_own: { login: 'me', id: 7 },
    };
  });

  afterEach(async () => {
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /** GitHub answers from `accounts`; everything else reaches the real hub. */
  const request: typeof fetch = (input, init) => {
    if (!String(input).startsWith('https://api.github.com/')) return fetch(input, init);
    const token = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ?? '';
    const account = accounts[token];
    return Promise.resolve(
      account
        ? new Response(JSON.stringify(account), { status: 200 })
        : new Response('{}', { status: 401 })
    );
  };

  it('hands the hub a token and tells only whose it is', async () => {
    const source = createLanGitHubSource({ fetch: request, readOwnToken: async () => null });

    const saved = await source.save(member, 'github_pat_hub');
    expect(saved).toEqual({ login: 'octocat' });
    expect(readLanHubGitHubConfig(dataDir)).toMatchObject({
      token: 'github_pat_hub',
      login: 'octocat',
      userId: '583231',
    });

    const described = await source.describe(member);
    expect(described).toEqual({ own: null, lan: { login: 'octocat' } });
    expect(JSON.stringify([saved, described])).not.toContain('github_pat_hub');

    await expect(source.save(member, null)).resolves.toEqual({ login: null });
    expect(readLanHubGitHubConfig(dataDir)).toBeNull();
    await expect(source.describe(member)).resolves.toEqual({ own: null, lan: null });
  });

  it('keeps the hub as it was when GitHub refuses the token', async () => {
    const source = createLanGitHubSource({ fetch: request, readOwnToken: async () => null });
    await source.save(member, 'github_pat_hub');

    await expect(source.save(member, 'github_pat_typo')).rejects.toThrow(/does not accept/);
    expect(readLanHubGitHubConfig(dataDir)?.token).toBe('github_pat_hub');
  });

  it("names the machine's own gh login, and the copy of the token while the hub is away", async () => {
    const away: typeof fetch = (input, init) =>
      String(input).startsWith(server.url)
        ? Promise.reject(new TypeError('fetch failed'))
        : request(input, init);
    const source = createLanGitHubSource({
      fetch: away,
      readOwnToken: async () => 'gho_own',
      readCopy: (hubId) =>
        hubId === member.id ? { token: 'github_pat_copy', login: 'octocat', userId: null } : null,
    });
    await expect(source.describe(member)).resolves.toEqual({
      own: { login: 'me' },
      lan: { login: 'octocat' },
    });

    // A login GitHub cannot be asked about is still the one agents use.
    accounts = {};
    await expect(source.describe(null)).resolves.toEqual({ own: { login: null }, lan: null });
  });
});
