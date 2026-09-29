import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { defineBuildStamp, readBuildStamp } from './lan-build-stamp.mjs';
import {
  assembleRelease,
  composeLanVersion,
  renderInstallScript,
  renderReleaseNotes,
  resolvePublishedName,
  writeVersion,
} from './lan-release.mjs';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'lan-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactsDir = path.join(root, 'artifacts');
  const templatesDir = path.join(root, 'templates');
  const outDir = path.join(root, 'out');
  await mkdir(templatesDir, { recursive: true });
  await writeFile(
    path.join(templatesDir, 'install.sh'),
    'REPOSITORY="__LODY_LAN_REPOSITORY__"\nTAG="__LODY_LAN_TAG__"\n'
  );
  await writeFile(path.join(templatesDir, 'install-mac.sh'), 'VERSION="__LODY_LAN_VERSION__"\n');
  const add = async (artifact, name, content) => {
    await mkdir(path.join(artifactsDir, artifact), { recursive: true });
    await writeFile(path.join(artifactsDir, artifact, name), content);
  };
  return { root, artifactsDir, templatesDir, outDir, add };
}

function assemble(paths, overrides = {}) {
  return assembleRelease({
    version: '0.100.0-lan.7',
    commit: COMMIT,
    repository: 'someone/Lody',
    tag: 'lan-latest',
    builtAt: '2026-01-01T00:00:00.000Z',
    artifactsDir: paths.artifactsDir,
    templatesDir: paths.templatesDir,
    outDir: paths.outDir,
    ...overrides,
  });
}

test('a fork build sorts after the upstream version it is based on', () => {
  assert.equal(composeLanVersion('0.100.0', 7), '0.100.0-lan.7');
  assert.equal(composeLanVersion('0.100.0-lan.3', '8'), '0.100.0-lan.8');
  assert.throws(() => composeLanVersion('0.100.0', 0), /positive integer/u);
  assert.throws(() => composeLanVersion('0.100.0', undefined), /positive integer/u);
  assert.throws(() => composeLanVersion('next', 1), /Cannot derive/u);
});

test('the stamped version reaches both the CLI and the desktop manifest', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lan-release-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const app of ['cli', 'electron']) {
    await mkdir(path.join(root, 'apps', app), { recursive: true });
    await writeFile(
      path.join(root, 'apps', app, 'package.json'),
      `${JSON.stringify({ name: app, version: '0.100.0', private: true }, null, 2)}\n`
    );
  }
  writeVersion('0.100.0-lan.7', root);
  for (const app of ['cli', 'electron']) {
    const manifest = JSON.parse(
      await readFile(path.join(root, 'apps', app, 'package.json'), 'utf8')
    );
    assert.deepEqual(manifest, { name: app, version: '0.100.0-lan.7', private: true });
  }
});

test('built files publish under names that carry no version', () => {
  assert.equal(resolvePublishedName('lody-0.100.0-lan.7.tgz'), 'lody-lan-cli.tgz');
  assert.equal(
    resolvePublishedName('LodyOSS-0.100.0-lan.7-arm64.dmg'),
    'LodyOSS-lan-mac-arm64.dmg'
  );
  assert.equal(resolvePublishedName('LodyOSS-0.100.0-lan.7-x64.zip'), 'LodyOSS-lan-mac-x64.zip');
  assert.equal(
    resolvePublishedName('LodyOSS-0.100.0-lan.7-x64-setup.exe'),
    'LodyOSS-lan-win-x64-setup.exe'
  );
  assert.equal(
    resolvePublishedName('LodyOSS-0.100.0-lan.7-x86_64.AppImage'),
    'LodyOSS-lan-linux-x64.AppImage'
  );
  for (const ignored of [
    'latest.yml',
    'latest-mac.yml',
    'LodyOSS-0.100.0-lan.7-arm64.dmg.blockmap',
    'LodyOSS-0.100.0-lan.7-x64-setup.exe.blockmap',
    'builder-debug.yml',
  ]) {
    assert.equal(resolvePublishedName(ignored), null, ignored);
  }
});

test('a release carries every built file, the install scripts and their checksums', async (t) => {
  const paths = await fixture(t);
  await paths.add('lan-cli', 'lody-0.100.0-lan.7.tgz', 'cli');
  await paths.add('lan-desktop-mac', 'LodyOSS-0.100.0-lan.7-arm64.zip', 'mac-arm64');
  await paths.add('lan-desktop-mac', 'LodyOSS-0.100.0-lan.7-arm64.zip.blockmap', 'ignored');
  await paths.add('lan-desktop-win', 'LodyOSS-0.100.0-lan.7-x64-setup.exe', 'win');
  await paths.add('lan-desktop-win', 'latest.yml', 'ignored');

  const manifest = assemble(paths);

  assert.deepEqual((await readdir(paths.outDir)).sort(), [
    'LodyOSS-lan-mac-arm64.zip',
    'LodyOSS-lan-win-x64-setup.exe',
    'SHA256SUMS',
    'install-mac.sh',
    'install.sh',
    'lody-lan-cli.tgz',
    'manifest.json',
  ]);
  assert.equal(await readFile(path.join(paths.outDir, 'lody-lan-cli.tgz'), 'utf8'), 'cli');
  assert.equal(
    await readFile(path.join(paths.outDir, 'install.sh'), 'utf8'),
    'REPOSITORY="someone/Lody"\nTAG="lan-latest"\n'
  );
  assert.equal(
    await readFile(path.join(paths.outDir, 'install-mac.sh'), 'utf8'),
    'VERSION="0.100.0-lan.7"\n'
  );
  assert.ok((await stat(path.join(paths.outDir, 'install.sh'))).mode & 0o100);

  assert.deepEqual(JSON.parse(await readFile(path.join(paths.outDir, 'manifest.json'), 'utf8')), {
    ...manifest,
  });
  assert.equal(manifest.version, '0.100.0-lan.7');
  assert.equal(manifest.builtAt, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(
    manifest.assets.map((asset) => asset.name),
    [
      'LodyOSS-lan-mac-arm64.zip',
      'LodyOSS-lan-win-x64-setup.exe',
      'install-mac.sh',
      'install.sh',
      'lody-lan-cli.tgz',
    ]
  );
  const cli = manifest.assets.find((asset) => asset.name === 'lody-lan-cli.tgz');
  assert.equal(cli.size, 3);
  // sha256('cli')
  assert.equal(cli.sha256, '99bb88401742848e032fd6f51709415fb6be169a72d2e5d7fc44289255160d3c');
  const sums = await readFile(path.join(paths.outDir, 'SHA256SUMS'), 'utf8');
  assert.deepEqual(
    sums.trimEnd().split('\n'),
    manifest.assets.map((asset) => `${asset.sha256}  ${asset.name}`)
  );
});

test('a release without the CLI tarball is refused', async (t) => {
  const paths = await fixture(t);
  await paths.add('lan-desktop-win', 'LodyOSS-0.100.0-lan.7-x64-setup.exe', 'win');
  assert.throws(() => assemble(paths), /No CLI tarball/u);
});

test('two files for one target are refused instead of one silently winning', async (t) => {
  const paths = await fixture(t);
  await paths.add('lan-cli', 'lody-0.100.0-lan.7.tgz', 'cli');
  await paths.add('lan-desktop-mac', 'LodyOSS-0.100.0-lan.7-arm64.zip', 'first');
  await paths.add('lan-desktop-mac-retry', 'LodyOSS-0.100.0-lan.6-arm64.zip', 'second');
  assert.throws(() => assemble(paths), /would be published as LodyOSS-lan-mac-arm64\.zip/u);
});

test('release inputs that would produce a broken download address are refused', async (t) => {
  const paths = await fixture(t);
  await paths.add('lan-cli', 'lody-0.100.0-lan.7.tgz', 'cli');
  assert.throws(() => assemble(paths, { version: '0.100.0' }), /Refusing to assemble/u);
  assert.throws(() => assemble(paths, { repository: 'not a repository' }), /Invalid repository/u);
  assert.throws(() => assemble(paths, { tag: 'lan latest' }), /Invalid release tag/u);
  assert.throws(() => assemble(paths, { commit: 'HEAD' }), /Invalid commit/u);
});

test('an install script with an unknown placeholder is refused', () => {
  assert.throws(
    () =>
      renderInstallScript('URL="__LODY_LAN_MIRROR__"', {
        repository: 'someone/Lody',
        tag: 'lan-latest',
        version: '0.100.0-lan.7',
      }),
    /unknown placeholder __LODY_LAN_MIRROR__/u
  );
});

test('release notes only advertise the platforms that were built', async (t) => {
  const paths = await fixture(t);
  await paths.add('lan-cli', 'lody-0.100.0-lan.7.tgz', 'cli');
  await paths.add('lan-desktop-win', 'LodyOSS-0.100.0-lan.7-x64-setup.exe', 'win');
  const notes = renderReleaseNotes(assemble(paths));
  const base = 'https://github.com/someone/Lody/releases/download/lan-latest';
  assert.ok(notes.includes(`curl -fsSL ${base}/install.sh | bash -s -- up`));
  assert.ok(notes.includes(`${base}/LodyOSS-lan-win-x64-setup.exe`));
  assert.ok(notes.includes('`0.100.0-lan.7`'));
  assert.ok(!notes.includes('macOS desktop'));
  assert.ok(!notes.includes('Linux desktop'));
});

test('a build is stamped with the repository and tag its workflow names', () => {
  const env = { LODY_LAN_REPOSITORY: ' someone/Lody ', LODY_LAN_TAG: 'lan-latest' };
  assert.deepEqual(readBuildStamp(env), { repository: 'someone/Lody', tag: 'lan-latest' });
  assert.deepEqual(readBuildStamp({ ...env, LODY_LAN_COMMIT: COMMIT }), {
    repository: 'someone/Lody',
    tag: 'lan-latest',
    commit: COMMIT,
  });

  const defined = defineBuildStamp({ ...env, LODY_LAN_COMMIT: COMMIT });
  // The constant is source text: evaluating it gives the JSON the build reads.
  assert.deepEqual(JSON.parse(JSON.parse(defined.__LODY_LAN_RELEASE_JSON__)), {
    repository: 'someone/Lody',
    tag: 'lan-latest',
    commit: COMMIT,
  });
});

test('a build made outside a release workflow follows nothing', () => {
  assert.equal(readBuildStamp({}), null);
  assert.equal(readBuildStamp({ LODY_LAN_REPOSITORY: 'someone/Lody' }), null);
  assert.deepEqual(defineBuildStamp({}), { __LODY_LAN_RELEASE_JSON__: 'null' });
});

test('a wrong stamp fails the build', () => {
  assert.throws(() => readBuildStamp({ LODY_LAN_REPOSITORY: 'nope', LODY_LAN_TAG: 'lan-latest' }));
  assert.throws(() => readBuildStamp({ LODY_LAN_REPOSITORY: 'a/b', LODY_LAN_TAG: 'x/y' }));
  assert.throws(() =>
    readBuildStamp({ LODY_LAN_REPOSITORY: 'a/b', LODY_LAN_TAG: 'lan', LODY_LAN_COMMIT: 'HEAD' })
  );
});
