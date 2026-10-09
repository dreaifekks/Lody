import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LanReleaseManifest, LanReleaseSource } from '@lody/shared/lan-release';
import type { LanReleaseFetch } from '@lody/shared/node/lan-release';
import { resolveLanInstallation, resolveLanUpdateChannel } from './lan-build';
import {
  LanSelfUpdateError,
  applyLanSelfUpdate,
  type LanSelfUpdateOptions,
  type LanUpdateCommandRunner,
} from './lan-self-update';

const source: LanReleaseSource = { repository: 'someone/Lody', tag: 'lan-latest' };
const BASE = 'https://github.com/someone/Lody/releases/download/lan-latest';
const tarball = Buffer.from('the newest build');
const RUNNING = '0.100.0-lan.3';
const NEWEST = '0.100.0-lan.4';

const manifest = (overrides: Partial<LanReleaseManifest> = {}): LanReleaseManifest => ({
  version: NEWEST,
  commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  repository: 'someone/Lody',
  tag: 'lan-latest',
  builtAt: '2026-09-29T00:00:00.000Z',
  assets: [
    {
      name: 'lody-lan-cli.tgz',
      size: tarball.byteLength,
      sha256: crypto.createHash('sha256').update(tarball).digest('hex'),
    },
  ],
  ...overrides,
});

const release =
  (described: LanReleaseManifest, file: Buffer = tarball): LanReleaseFetch =>
  async (url) => {
    if (url === `${BASE}/manifest.json`) return new Response(JSON.stringify(described));
    if (url === `${BASE}/lody-lan-cli.tgz`) return new Response(file);
    return new Response('not found', { status: 404 });
  };

describe('an agent service that replaces itself', () => {
  let root: string;
  let entry: string;
  let commands: string[][];

  /** Stands in for npm and for the build it installs. */
  const installing =
    (behavior: { npm?: number; reports?: string; starts?: boolean } = {}): LanUpdateCommandRunner =>
    async (command, args) => {
      commands.push([path.basename(command), ...args]);
      if (args[0] === 'install') {
        if ((behavior.npm ?? 0) !== 0) {
          return { code: behavior.npm ?? 1, stdout: '', stderr: `cannot write ${root}/x` };
        }
        const prefix = args[args.indexOf('--prefix') + 1]!;
        const dist = path.join(prefix, 'node_modules', 'lody', 'dist');
        fs.mkdirSync(dist, { recursive: true });
        fs.writeFileSync(path.join(dist, 'index.js'), `// ${NEWEST}`);
        fs.writeFileSync(path.join(prefix, 'package-lock.json'), '{"lockfileVersion":3}');
        return { code: 0, stdout: '', stderr: '' };
      }
      if (behavior.starts === false) return { code: 1, stdout: '', stderr: 'bad binding' };
      return { code: 0, stdout: `${behavior.reports ?? NEWEST}\n`, stderr: '' };
    };

  const update = (overrides: Partial<LanSelfUpdateOptions> = {}) =>
    applyLanSelfUpdate({
      installation: resolveLanInstallation({ entry, runtime: '/usr/bin/node' }),
      source,
      runningVersion: RUNNING,
      env: { PATH: '/bin' },
      fetch: release(manifest()),
      run: installing(),
      ...overrides,
    });

  const failure = async (run: Promise<unknown>): Promise<LanSelfUpdateError> => {
    const error = await run.then(
      () => null,
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(LanSelfUpdateError);
    return error as LanSelfUpdateError;
  };

  const installedBuild = () => fs.readFileSync(entry, 'utf8');
  const leftovers = () => fs.readdirSync(root).sort();

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lody-lan-update-')));
    commands = [];
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'lody-lan-install', private: true })
    );
    entry = path.join(root, 'node_modules', 'lody', 'dist', 'index.js');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, `// ${RUNNING}`);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('puts the newest build in place and keeps the one it replaced', async () => {
    const phases: string[] = [];
    const result = await update({ onPhase: (phase) => phases.push(phase) });

    expect(result).toEqual({ from: RUNNING, to: NEWEST, commit: manifest().commit });
    expect(phases).toEqual(['downloading', 'installing']);
    expect(installedBuild()).toBe(`// ${NEWEST}`);
    expect(
      fs.readFileSync(path.join(root, 'node_modules.previous', 'lody', 'dist', 'index.js'), 'utf8')
    ).toBe(`// ${RUNNING}`);
    expect(leftovers()).toEqual([
      'node_modules',
      'node_modules.previous',
      'package-lock.json',
      'package.json',
    ]);
  });

  it('installs with the runtime of the service on the search path', async () => {
    let searchPath: string | undefined;
    await update({
      run: async (command, args, options) => {
        searchPath = options.env.PATH;
        return await installing()(command, args, options);
      },
    });

    expect(searchPath).toBe(['/usr/bin', '/bin'].join(path.delimiter));
    expect(commands[0]?.slice(0, 3)).toEqual(['npm', 'install', '--prefix']);
    expect(commands[1]?.at(-1)).toBe('--version');
  });

  it('leaves the installation alone when the build does not install or start', async () => {
    const attempts: Array<[Partial<LanSelfUpdateOptions>, string]> = [
      [{ run: installing({ npm: 1 }) }, 'install_failed'],
      [{ run: installing({ starts: false }) }, 'install_failed'],
      [{ run: installing({ reports: RUNNING }) }, 'install_failed'],
      [{ fetch: release(manifest(), Buffer.from('another file of that size')) }, 'release'],
      [{ fetch: release(manifest({ assets: [] })) }, 'release'],
      [{ fetch: async () => new Response('gone', { status: 404 }) }, 'release'],
    ];
    for (const [overrides, code] of attempts) {
      expect((await failure(update(overrides))).code).toBe(code);
      expect(installedBuild()).toBe(`// ${RUNNING}`);
      expect(leftovers()).toEqual(['node_modules', 'package.json']);
    }
  });

  it('does not name a directory of the machine in what it reports', async () => {
    const error = await failure(update({ run: installing({ npm: 1 }) }));
    expect(error.message).toContain('<installation>');
    expect(error.message).not.toContain(root);
  });

  it('installs nothing when the running build is the newest, unless told to', async () => {
    expect((await failure(update({ runningVersion: NEWEST }))).code).toBe('current');
    expect(commands).toEqual([]);

    await expect(update({ runningVersion: NEWEST, force: true })).resolves.toMatchObject({
      to: NEWEST,
    });
  });

  it('follows the CLI tarball of a release that kept older desktop installers', async () => {
    const cliOnly = manifest({
      version: RUNNING,
      commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      cli: { version: NEWEST, commit: manifest().commit, builtAt: manifest().builtAt },
    });

    await expect(update({ fetch: release(cliOnly) })).resolves.toEqual({
      from: RUNNING,
      to: NEWEST,
      commit: manifest().commit,
    });
    expect(installedBuild()).toBe(`// ${NEWEST}`);
  });

  it('refuses a second update while one is under way, and recovers from a dead one', async () => {
    fs.mkdirSync(path.join(root, '.update'));
    expect((await failure(update())).code).toBe('busy');
    expect(installedBuild()).toBe(`// ${RUNNING}`);

    const later = Date.now() + 31 * 60_000;
    await expect(update({ now: () => later })).resolves.toMatchObject({ to: NEWEST });
  });

  it('replaces only what the install script installed and a release is followed by', async () => {
    expect((await failure(update({ source: null }))).code).toBe('unsupported');
    expect(
      (await failure(update({ installation: resolveLanInstallation({ desktop: true }) }))).code
    ).toBe('unsupported');

    const checkout = path.join(root, 'checkout', 'dist-dev', 'index.js');
    fs.mkdirSync(path.dirname(checkout), { recursive: true });
    fs.writeFileSync(checkout, '');
    expect(
      (await failure(update({ installation: resolveLanInstallation({ entry: checkout }) }))).code
    ).toBe('unsupported');
    expect(commands).toEqual([]);
  });
});

describe('who updates an agent service', () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lody-lan-install-')));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const layOut = (packageName: string) => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: packageName }));
    const entry = path.join(root, 'node_modules', 'lody', 'dist', 'index.js');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, '');
    return entry;
  };

  it('recognizes what the install script laid out, through a link as well', () => {
    const entry = layOut('lody-lan-install');
    const link = path.join(root, 'lody-lan');
    fs.symlinkSync(entry, link);

    expect(resolveLanInstallation({ entry: link, runtime: '/usr/bin/node' })).toEqual({
      kind: 'installer',
      root,
      runtime: '/usr/bin/node',
      entry,
    });
  });

  it('takes anything else for an installation somebody else maintains', () => {
    expect(resolveLanInstallation({ entry: layOut('some-project') })).toEqual({ kind: 'other' });
    expect(resolveLanInstallation({ entry: path.join(root, 'missing.js') })).toEqual({
      kind: 'other',
    });
    expect(resolveLanInstallation({ entry: layOut('lody-lan-install'), desktop: true })).toEqual({
      kind: 'desktop',
    });
  });

  it('lets a service replace itself only when it would come back', () => {
    const installation = resolveLanInstallation({ entry: layOut('lody-lan-install') });
    const channel = (overrides: Partial<Parameters<typeof resolveLanUpdateChannel>[0]>) =>
      resolveLanUpdateChannel({ installation, source, restarted: true, ...overrides });

    expect(channel({})).toBe('service');
    expect(channel({ restarted: false })).toBe('manual');
    expect(channel({ source: null })).toBe('manual');
    expect(channel({ installation: { kind: 'other' } })).toBe('manual');
    expect(channel({ installation: { kind: 'desktop' }, restarted: false })).toBe('desktop');
  });
});
