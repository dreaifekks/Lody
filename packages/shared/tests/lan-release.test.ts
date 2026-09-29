import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  compareLanVersions,
  composeLanReleaseSource,
  findLanReleaseAsset,
  getLanReleaseBaseUrl,
  parseLanMachineBuild,
  parseLanMachineUpdate,
  parseLanReleaseSource,
  resolveLanDesktopAssetName,
  resolveLanUpdateAvailability,
  sameLanReleaseSource,
  type LanReleaseManifest,
  type LanReleaseSource,
} from '../src/lan-release';
import {
  LanReleaseError,
  downloadLanReleaseAsset,
  downloadNewestLanReleaseAsset,
  fetchLanReleaseManifest,
  resolveLanReleaseBaseUrl,
  type LanReleaseFetch,
} from '../src/node/lan-release';

const source: LanReleaseSource = {
  repository: 'someone/Lody',
  tag: 'lan-latest',
  commit: 'e6f927c0ac3ab03c64e3247450069e3c3c3e7439',
};

const payload = Buffer.from('a build of the command line');
const sha256 = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');

const manifest = (overrides: Partial<LanReleaseManifest> = {}): LanReleaseManifest => ({
  version: '0.100.0-lan.7',
  commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  repository: 'someone/Lody',
  tag: 'lan-latest',
  builtAt: '2026-09-29T00:00:00.000Z',
  assets: [{ name: 'lody-lan-cli.tgz', size: payload.byteLength, sha256: sha256(payload) }],
  ...overrides,
});

/** A release as a table of addresses; anything else is not published. */
const release =
  (files: Record<string, { status?: number; body: string | Buffer }>): LanReleaseFetch =>
  async (url) => {
    const file = files[url];
    if (!file) return new Response('not found', { status: 404 });
    return new Response(file.body, { status: file.status ?? 200 });
  };

const BASE = 'https://github.com/someone/Lody/releases/download/lan-latest';

describe('versions of the fork', () => {
  it('orders builds by the upstream release first and the build number second', () => {
    expect(compareLanVersions('0.100.0-lan.10', '0.100.0-lan.9')).toBeGreaterThan(0);
    expect(compareLanVersions('0.101.0-lan.1', '0.100.0-lan.99')).toBeGreaterThan(0);
    expect(compareLanVersions('0.100.0-lan.3', '0.100.0-lan.3')).toBe(0);
    expect(compareLanVersions('0.99.9-lan.50', '0.100.0-lan.1')).toBeLessThan(0);
  });

  it('follows nothing for a version the fork did not number', () => {
    expect(compareLanVersions('0.100.0', '0.100.0-lan.3')).toBeNull();
    expect(resolveLanUpdateAvailability('0.100.0', '0.100.0-lan.3')).toBe('unknown');
    expect(resolveLanUpdateAvailability(undefined, '0.100.0-lan.3')).toBe('unknown');
  });

  it('offers a later build and never an earlier one', () => {
    expect(resolveLanUpdateAvailability('0.100.0-lan.3', '0.100.0-lan.4')).toBe('available');
    expect(resolveLanUpdateAvailability('0.100.0-lan.4', '0.100.0-lan.4')).toBe('current');
    expect(resolveLanUpdateAvailability('0.100.0-lan.5', '0.100.0-lan.4')).toBe('current');
  });
});

describe('what a build follows', () => {
  it('reads the stamp of a build and refuses what is not one', () => {
    expect(parseLanReleaseSource(JSON.stringify(source))).toEqual(source);
    expect(parseLanReleaseSource({ repository: 'someone/Lody', tag: 'lan-latest' })).toEqual({
      repository: 'someone/Lody',
      tag: 'lan-latest',
    });
    expect(parseLanReleaseSource(null)).toBeNull();
    expect(parseLanReleaseSource('not json')).toBeNull();
    expect(parseLanReleaseSource({ repository: '../evil', tag: 'lan-latest' })).toBeNull();
    expect(parseLanReleaseSource({ repository: 'someone/Lody', tag: 'a/b' })).toBeNull();
  });

  it('stamps a build with what its workflow names, or fails the build', () => {
    expect(
      composeLanReleaseSource({
        repository: ' someone/Lody ',
        tag: 'lan-latest',
        commit: source.commit,
      })
    ).toEqual(source);
    expect(composeLanReleaseSource({ repository: 'someone/Lody', tag: 'lan-latest' })).toEqual({
      repository: 'someone/Lody',
      tag: 'lan-latest',
    });
    expect(composeLanReleaseSource({ repository: 'someone/Lody' })).toBeNull();
    expect(composeLanReleaseSource({})).toBeNull();
    expect(() => composeLanReleaseSource({ repository: 'not a repository', tag: 'x' })).toThrow();
    expect(() =>
      composeLanReleaseSource({ repository: 'someone/Lody', tag: 'lan-latest', commit: 'HEAD' })
    ).toThrow();
  });

  it('names the file of each desktop the fork builds', () => {
    expect(resolveLanDesktopAssetName('darwin', 'arm64')).toBe('LodyOSS-lan-mac-arm64.zip');
    expect(resolveLanDesktopAssetName('darwin', 'x64')).toBe('LodyOSS-lan-mac-x64.zip');
    expect(resolveLanDesktopAssetName('win32', 'arm64')).toBe('LodyOSS-lan-win-x64-setup.exe');
    expect(resolveLanDesktopAssetName('linux', 'x64')).toBe('LodyOSS-lan-linux-x64.AppImage');
    expect(resolveLanDesktopAssetName('linux', 'arm64')).toBeNull();
    expect(findLanReleaseAsset(manifest(), 'lody-lan-cli.tgz')?.size).toBe(payload.byteLength);
    expect(findLanReleaseAsset(manifest(), null)).toBeNull();
  });

  it('compares repositories the way their host does', () => {
    expect(sameLanReleaseSource(source, { repository: 'Someone/lody', tag: 'lan-latest' })).toBe(
      true
    );
    expect(sameLanReleaseSource(source, { repository: 'someone/Lody', tag: 'other' })).toBe(false);
    expect(sameLanReleaseSource(source, null)).toBe(false);
  });

  it('reads what a machine says about its build', () => {
    expect(parseLanMachineBuild({ version: '0.100.0-lan.3', update: 'service', source })).toEqual({
      version: '0.100.0-lan.3',
      update: 'service',
      source,
    });
    expect(parseLanMachineBuild({ version: '0.100.0', update: 'manual' })).toEqual({
      version: '0.100.0',
      update: 'manual',
    });
    expect(parseLanMachineBuild({ version: '0.100.0-lan.3', update: 'magic' })).toBeNull();
    expect(parseLanMachineBuild(undefined)).toBeNull();
  });

  it('reads where an update of a machine stands', () => {
    expect(parseLanMachineUpdate({ phase: 'installing', version: '0.100.0-lan.4', at: 5 })).toEqual(
      { phase: 'installing', version: '0.100.0-lan.4', at: 5 }
    );
    expect(
      parseLanMachineUpdate({ phase: 'failed', version: '0.100.0-lan.4', at: 5, error: 'no npm' })
    ).toEqual({ phase: 'failed', version: '0.100.0-lan.4', at: 5, error: 'no npm' });
    expect(parseLanMachineUpdate({ phase: 'done', version: '0.100.0-lan.4', at: 5 })).toBeNull();
    expect(parseLanMachineUpdate(null)).toBeNull();
  });

  it('reads a mirror from the environment', () => {
    expect(getLanReleaseBaseUrl(source)).toBe(BASE);
    expect(resolveLanReleaseBaseUrl(source, {})).toBe(BASE);
    expect(
      resolveLanReleaseBaseUrl(source, { LODY_LAN_BASE_URL: 'https://mirror.example/lan/' })
    ).toBe('https://mirror.example/lan');
  });
});

describe('reading a release', () => {
  const expectFailure = async (run: Promise<unknown>, code: LanReleaseError['code']) => {
    const failure = await run.then(
      () => null,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(LanReleaseError);
    expect((failure as LanReleaseError).code).toBe(code);
  };

  it('returns the description of the release the build follows', async () => {
    const described = manifest();
    await expect(
      fetchLanReleaseManifest(source, {
        env: {},
        fetch: release({ [`${BASE}/manifest.json`]: { body: JSON.stringify(described) } }),
      })
    ).resolves.toEqual(described);
  });

  it('tells a missing release from a broken or a foreign one', async () => {
    await expectFailure(
      fetchLanReleaseManifest(source, { env: {}, fetch: release({}) }),
      'not_published'
    );
    await expectFailure(
      fetchLanReleaseManifest(source, {
        env: {},
        fetch: release({ [`${BASE}/manifest.json`]: { body: '<html>' } }),
      }),
      'invalid_manifest'
    );
    await expectFailure(
      fetchLanReleaseManifest(source, {
        env: {},
        fetch: release({
          [`${BASE}/manifest.json`]: { body: JSON.stringify({ ...manifest(), assets: 'none' }) },
        }),
      }),
      'invalid_manifest'
    );
    await expectFailure(
      fetchLanReleaseManifest(source, {
        env: {},
        fetch: release({
          [`${BASE}/manifest.json`]: {
            body: JSON.stringify(manifest({ repository: 'another/Lody' })),
          },
        }),
      }),
      'other_release'
    );
    await expectFailure(
      fetchLanReleaseManifest(source, {
        env: {},
        fetch: release({ [`${BASE}/manifest.json`]: { status: 503, body: 'busy' } }),
      }),
      'unreachable'
    );
    await expectFailure(
      fetchLanReleaseManifest(source, {
        env: {},
        fetch: async () => {
          throw new Error('no route to host');
        },
      }),
      'unreachable'
    );
  });
});

describe('downloading a file of a release', () => {
  let directory: string;
  let destination: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-lan-release-'));
    destination = path.join(directory, 'lody-lan-cli.tgz');
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const download = (body: Buffer, progress: number[] = []) =>
    downloadLanReleaseAsset({
      source,
      asset: manifest().assets[0]!,
      destination,
      env: {},
      fetch: release({ [`${BASE}/lody-lan-cli.tgz`]: { body } }),
      onProgress: (received) => progress.push(received),
    });

  it('keeps the file the release describes', async () => {
    const progress: number[] = [];
    await download(payload, progress);

    expect(fs.readFileSync(destination)).toEqual(payload);
    expect(progress.at(-1)).toBe(payload.byteLength);
    expect(fs.readdirSync(directory)).toEqual(['lody-lan-cli.tgz']);
  });

  it('keeps nothing of a file that is not the described one', async () => {
    const sameSize = Buffer.from(payload);
    sameSize[0] = sameSize[0]! ^ 0xff;

    for (const body of [sameSize, payload.subarray(1), Buffer.concat([payload, payload])]) {
      const failure = await download(body).then(
        () => null,
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(LanReleaseError);
      expect((failure as LanReleaseError).code).toBe('mismatch');
      expect(fs.readdirSync(directory)).toEqual([]);
    }
  });

  it('follows a build that is published while its description is read', async () => {
    // The description still names build 7 while the file is already build 8's.
    const newer = Buffer.from('the next build of the command line');
    const next = manifest({
      version: '0.100.0-lan.8',
      assets: [{ name: 'lody-lan-cli.tgz', size: newer.byteLength, sha256: sha256(newer) }],
    });
    const heard: string[] = [];
    const result = await downloadNewestLanReleaseAsset({
      source,
      manifest: manifest(),
      assetName: 'lody-lan-cli.tgz',
      destination,
      env: {},
      fetch: release({
        [`${BASE}/lody-lan-cli.tgz`]: { body: newer },
        [`${BASE}/manifest.json`]: { body: JSON.stringify(next) },
      }),
      onManifest: (described) => heard.push(described.version),
    });

    expect(result.version).toBe('0.100.0-lan.8');
    expect(heard).toEqual(['0.100.0-lan.8']);
    expect(fs.readFileSync(destination)).toEqual(newer);
  });

  it('gives up when the newer description does not match either', async () => {
    const failure = await downloadNewestLanReleaseAsset({
      source,
      manifest: manifest(),
      assetName: 'lody-lan-cli.tgz',
      destination,
      env: {},
      fetch: release({
        [`${BASE}/lody-lan-cli.tgz`]: { body: Buffer.concat([payload, payload]) },
        [`${BASE}/manifest.json`]: { body: JSON.stringify(manifest()) },
      }),
    }).then(
      () => null,
      (error: unknown) => error
    );

    expect((failure as LanReleaseError).code).toBe('mismatch');
    expect((failure as LanReleaseError).message).toMatch(/a newer build may be on its way/);
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('reports a file the release does not have', async () => {
    const failure = await downloadLanReleaseAsset({
      source,
      asset: manifest().assets[0]!,
      destination,
      env: {},
      fetch: release({}),
    }).then(
      () => null,
      (error: unknown) => error
    );
    expect((failure as LanReleaseError).code).toBe('not_published');
    expect(fs.readdirSync(directory)).toEqual([]);
  });
});
