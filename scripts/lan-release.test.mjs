import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { defineBuildStamp, readBuildStamp } from './lan-build-stamp.mjs';
import {
  assembleRelease,
  canReuseDevBuild,
  composeLanVersion,
  planBuild,
  promoteDevBuild,
  restampCliTarball,
  nextLanVersion,
  describeSigningCertificate,
  readBaseVersion,
  renderInstallScript,
  renderReleaseNotes,
  resolveTagVersion,
  resolvePublishedName,
  writeVersion,
  LAN_CHANNELS,
  resolveTagChannel,
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

test('the base version is the newest upstream release in the changelog, not the manifest', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lan-release-base-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const changelog = path.join(root, 'site-docs', 'content', 'changelog', 'en');
  await mkdir(changelog, { recursive: true });
  assert.throws(() => readBaseVersion(root), /No released version/u);
  const entry = (version) => `---\ntitle: 'x'\nversion: ${version}\n---\n\nVersion ${version}\n`;
  await writeFile(path.join(changelog, '20260929-0.102.0.mdx'), entry('0.102.0'));
  // A Windows checkout converts line endings.
  await writeFile(path.join(changelog, '20260930.mdx'), entry('0.103.0').replaceAll('\n', '\r\n'));
  await writeFile(path.join(changelog, '20260801.mdx'), entry('0.99.4'));
  await writeFile(path.join(changelog, 'notes.md'), entry('9.9.9'));
  assert.equal(readBaseVersion(root), '0.103.0');
  assert.equal(composeLanVersion(readBaseVersion(root), 23), '0.103.0-lan.23');
});

test('release numbers restart at 1 with each upstream release and follow the tags', () => {
  assert.equal(nextLanVersion('0.103.0', []), '0.103.0-lan.1');
  const tags = [
    'v0.102.0-lan.7',
    'v0.103.0-lan.1',
    'v0.103.0-lan.3',
    'v0.103.0-lan.x',
    'lan-latest',
  ];
  assert.equal(nextLanVersion('0.103.0', tags), '0.103.0-lan.4');
  assert.equal(nextLanVersion('0.104.0', tags), '0.104.0-lan.1');
});

test('dev builds number themselves apart from the releases', () => {
  const tags = ['v0.103.0-lan.7', 'dev-v0.103.0-lan.2', 'dev-v0.103.0-lan.3'];
  assert.equal(nextLanVersion('0.103.0', tags, 'dev'), '0.103.0-lan.4');
  assert.equal(nextLanVersion('0.103.0', tags), '0.103.0-lan.8');
  assert.equal(resolveTagVersion('dev-v0.103.0-lan.4', '0.103.0'), '0.103.0-lan.4');
  assert.equal(resolveTagChannel('dev-v0.103.0-lan.4'), 'dev');
  assert.equal(resolveTagChannel('v0.103.0-lan.4'), 'stable');
  assert.equal(LAN_CHANNELS.dev.rollingTag, 'lan-dev');
  assert.throws(() => resolveTagVersion('dev-0.103.0-lan.4', '0.103.0'), /looks like/u);
});

test('a dev tag ending in -cli builds the CLI only and numbers like any dev tag', () => {
  assert.equal(resolveTagVersion('dev-v0.103.0-lan.4-cli', '0.103.0'), '0.103.0-lan.4');
  assert.equal(resolveTagChannel('dev-v0.103.0-lan.4-cli'), 'dev');
  assert.equal(
    nextLanVersion('0.103.0', ['dev-v0.103.0-lan.3', 'dev-v0.103.0-lan.4-cli'], 'dev'),
    '0.103.0-lan.5'
  );
  assert.throws(() => resolveTagVersion('v0.103.0-lan.4-cli', '0.103.0'), /only a dev tag/u);

  const plan = (tag, requested) =>
    planBuild({ tag, requested, version: '0.103.0-lan.4', commit: COMMIT, devManifest: null });
  assert.equal(plan('dev-v0.103.0-lan.4-cli', ''), 'cli');
  assert.equal(plan('dev-v0.103.0-lan.4', 'cli'), 'cli');
  assert.equal(plan('dev-v0.103.0-lan.4', ''), 'full');
  assert.equal(plan(undefined, 'cli'), 'cli');
  assert.equal(plan(undefined, ''), 'full');
  assert.throws(() => plan('v0.103.0-lan.4', 'cli'), /builds everything/u);
  assert.throws(() => plan(undefined, 'desktop'), /full or cli/u);
});

test('a release tag must name the upstream release its commit synced', () => {
  assert.equal(resolveTagVersion('v0.103.0-lan.2', '0.103.0'), '0.103.0-lan.2');
  assert.throws(() => resolveTagVersion('v0.102.0-lan.2', '0.103.0'), /does not name 0\.103\.0/u);
  assert.throws(() => resolveTagVersion('0.103.0-lan.2', '0.103.0'), /looks like/u);
  assert.throws(() => resolveTagVersion('v0.103.0-lan.0', '0.103.0'), /positive integer/u);
  assert.throws(() => resolveTagVersion('lan-latest', '0.103.0'), /looks like/u);
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

// Made for these tests with keys nobody kept: a certificate of a fork's own,
// one its own authority issued, and one issued by a stand-in for the authority
// Apple issues Developer ID certificates with.
const OWN_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIBqzCCAVGgAwIBAgIUL0VNwwiMy4maJUosbqeiswyRbngwCgYIKoZIzj0EAwIw
KjEWMBQGA1UEAwwNU29tZSBGb3JrIExBTjEQMA4GA1UECgwHc29tZW9uZTAgFw0y
NjA5MjkxMjA1MzRaGA8yMTI2MDkwNTEyMDUzNFowKjEWMBQGA1UEAwwNU29tZSBG
b3JrIExBTjEQMA4GA1UECgwHc29tZW9uZTBZMBMGByqGSM49AgEGCCqGSM49AwEH
A0IABMX2rq8Lj4rNL7tXd4b+gs5S+1wf5Ym+7xLdEaU1vqoyLUpcGvp7Z+gFhtgX
eE2I/re2XsXbJW3qIjKqtf2YcXajUzBRMB0GA1UdDgQWBBT6ZJm3CmWP9EcBKhoJ
tGDGq/tqajAfBgNVHSMEGDAWgBT6ZJm3CmWP9EcBKhoJtGDGq/tqajAPBgNVHRMB
Af8EBTADAQH/MAoGCCqGSM49BAMCA0gAMEUCIQDfjpmR/h7Y+qoBMXdEwvKO4MZH
GVZd9kOlzrbS5s+ZGAIgeAD9kcDUsmePVGpP6SoJ2I8yFSQSeFd13MFwifIIFLE=
-----END CERTIFICATE-----
`;
const OWN_AUTHORITY_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIBtTCCAVugAwIBAgIUdwoy+tXuSlxiKqyZfIWEUqFHHHcwCgYIKoZIzj0EAwIw
MDEcMBoGA1UEAwwTU29tZSBGb3JrIEF1dGhvcml0eTEQMA4GA1UECgwHc29tZW9u
ZTAgFw0yNjA5MjkxMjA1MzRaGA8yMTI2MDkwNTEyMDUzNFowPzEWMBQGA1UEAwwN
U29tZSBGb3JrIExBTjETMBEGA1UECwwKQUJDREUxMjM0NTEQMA4GA1UECgwHc29t
ZW9uZTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABEpSnWSEFsXmtwcDwqDDtUQC
rFbQbPA9mK3RwqTGnTJU+qU7Ji88LSOCFixN5TeVyv/xi30eNXk5Sm270x8OJnGj
QjBAMB0GA1UdDgQWBBR6G0NKsoPMLeKn2kiSYO5dpTtSGjAfBgNVHSMEGDAWgBQj
SBbDd4/ZfXtUU9OAHM5imA5O+jAKBggqhkjOPQQDAgNIADBFAiAFRJB0JetFL/8m
LChHojcX7cN6A/oq5Tf6OjwyVht7KgIhAL1TvLpVORH+/Rjin6dUFuDwttYl0/gS
qJ9emum7ubp0
-----END CERTIFICATE-----
`;
const DEVELOPER_ID_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIICNTCCAdygAwIBAgIUDKpe7Wc6f3gJOS2L3AGefZvnBu4wCgYIKoZIzj0EAwIw
XjELMAkGA1UEBhMCVVMxEzARBgNVBAoMCkFwcGxlIEluYy4xCzAJBgNVBAsMAkcy
MS0wKwYDVQQDDCREZXZlbG9wZXIgSUQgQ2VydGlmaWNhdGlvbiBBdXRob3JpdHkw
IBcNMjYwOTI5MTIwNTM0WhgPMjEyNjA5MDUxMjA1MzRaMIGRMRowGAYKCZImiZPy
LGQBAQwKQUJDREUxMjM0NTE7MDkGA1UEAwwyRGV2ZWxvcGVyIElEIEFwcGxpY2F0
aW9uOiBUZXN0IFBlcnNvbiAoQUJDREUxMjM0NSkxEzARBgNVBAsMCkFCQ0RFMTIz
NDUxFDASBgNVBAoMC1Rlc3QgUGVyc29uMQswCQYDVQQGEwJVUzBZMBMGByqGSM49
AgEGCCqGSM49AwEHA0IABMn6KUgnMo6QocyNcO8SE5wYZaUO0Dx/jpj0ZI2aXDal
4m/Vflouf4ewbBPb8YnqDHAMbxXIXvYWgi63uahCRH+jQjBAMB0GA1UdDgQWBBR0
k1iFug6TAZEhohkJ8s4N23vbXjAfBgNVHSMEGDAWgBTcCnXxMlPjUj9oxtDF1bUz
kEwUcDAKBggqhkjOPQQDAgNHADBEAiAXMy1pZailfDMVrw+VsqTtj5ebOkc+NjVw
HhrlYFd6ngIgEDLF0VSwQjb4z/fQw4E3pFP+CK05Rd3QX8Z4/q10k7w=
-----END CERTIFICATE-----
`;
// What `openssl pkcs12` writes in front of a certificate it takes out of a bundle.
const BAG_ATTRIBUTES = 'Bag Attributes\n    localKeyID: 01\nsubject=CN=x\nissuer=CN=y\n';

async function readSigning(t, certificate) {
  const root = await mkdtemp(path.join(tmpdir(), 'lan-signing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'signing.pem'), certificate);
  await writeFile(path.join(root, 'outputs'), '');
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./lan-release.mjs', import.meta.url)),
      'signing',
      '--certificate',
      path.join(root, 'signing.pem'),
    ],
    { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: path.join(root, 'outputs') } }
  );
  return { ...result, outputs: await readFile(path.join(root, 'outputs'), 'utf8') };
}

test('a certificate of a fork’s own names no team', () => {
  assert.deepEqual(describeSigningCertificate(OWN_CERTIFICATE), {
    name: 'Some Fork LAN',
    teamId: null,
    selfSigned: true,
  });
  // A unit its own authority wrote into it is no team either.
  assert.deepEqual(describeSigningCertificate(OWN_AUTHORITY_CERTIFICATE), {
    name: 'Some Fork LAN',
    teamId: null,
    selfSigned: true,
  });
});

test('a certificate Apple issued names a team and is chosen by what follows its kind', () => {
  const expected = { name: 'Test Person (ABCDE12345)', teamId: 'ABCDE12345', selfSigned: false };
  assert.deepEqual(describeSigningCertificate(DEVELOPER_ID_CERTIFICATE), expected);
  assert.deepEqual(
    describeSigningCertificate(`${BAG_ATTRIBUTES}${DEVELOPER_ID_CERTIFICATE}`),
    expected
  );
});

test('what is no certificate is refused', () => {
  assert.throws(() => describeSigningCertificate('-----BEGIN CERTIFICATE-----\n'));
  assert.throws(() => describeSigningCertificate(''));
});

test('the workflow learns how to sign and its log does not name a person', async (t) => {
  const issued = await readSigning(t, `${BAG_ATTRIBUTES}${DEVELOPER_ID_CERTIFICATE}`);
  assert.equal(issued.status, 0, issued.stderr);
  assert.equal(issued.outputs, 'name=Test Person (ABCDE12345)\nself_signed=\n');
  const lines = issued.stdout.split('\n');
  assert.ok(lines.includes('::add-mask::Test Person (ABCDE12345)'));
  assert.ok(lines.includes('::add-mask::ABCDE12345'));
  // Everything it prints that names the person or the team tells the runner to hide it.
  assert.deepEqual(
    lines.filter(
      (line) => /Test Person|ABCDE12345/u.test(line) && !line.startsWith('::add-mask::')
    ),
    []
  );

  const own = await readSigning(t, OWN_CERTIFICATE);
  assert.equal(own.status, 0, own.stderr);
  assert.equal(own.outputs, 'name=Some Fork LAN\nself_signed=1\n');
  assert.ok(!own.stdout.includes('::add-mask::'));

  const none = await readSigning(t, 'not a certificate');
  assert.notEqual(none.status, 0);
  assert.equal(none.outputs, '');
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

const OTHER_COMMIT = 'fedcba9876543210fedcba9876543210fedcba98';

test('a CLI-only build keeps the desktop installers the release published last', async (t) => {
  const paths = await fixture(t);
  await paths.add('lan-cli', 'lody-0.100.0-lan.8.tgz', 'new cli');
  const previous = {
    version: '0.100.0-lan.7',
    commit: OTHER_COMMIT,
    repository: 'someone/Lody',
    tag: 'lan-dev',
    builtAt: '2025-12-31T00:00:00.000Z',
    assets: [
      { name: 'LodyOSS-lan-mac-arm64.zip', size: 9, sha256: 'a'.repeat(64) },
      { name: 'install.sh', size: 1, sha256: 'b'.repeat(64) },
      { name: 'lody-lan-cli.tgz', size: 3, sha256: 'c'.repeat(64) },
    ],
  };

  const manifest = assemble(paths, { version: '0.100.0-lan.8', tag: 'lan-dev', carry: previous });

  // A desktop, and every older build, reads the top level: the installers it may download.
  assert.equal(manifest.version, '0.100.0-lan.7');
  assert.equal(manifest.commit, OTHER_COMMIT);
  assert.equal(manifest.builtAt, '2025-12-31T00:00:00.000Z');
  assert.deepEqual(manifest.cli, {
    version: '0.100.0-lan.8',
    commit: COMMIT,
    builtAt: '2026-01-01T00:00:00.000Z',
    asset: 'lody-lan-cli-0.100.0-lan.8.tgz',
  });
  assert.deepEqual(
    manifest.assets.find((asset) => asset.name === 'LodyOSS-lan-mac-arm64.zip'),
    {
      name: 'LodyOSS-lan-mac-arm64.zip',
      size: 9,
      sha256: 'a'.repeat(64),
    }
  );
  // The tarball under the fixed name stays: what reads the top level installs it.
  assert.deepEqual(
    manifest.assets.find((asset) => asset.name === 'lody-lan-cli.tgz'),
    { name: 'lody-lan-cli.tgz', size: 3, sha256: 'c'.repeat(64) }
  );
  const later = manifest.assets.find((asset) => asset.name === 'lody-lan-cli-0.100.0-lan.8.tgz');
  assert.equal(later.sha256, crypto.createHash('sha256').update('new cli').digest('hex'));
  // Uploaded: the new tarball and the scripts; the carried files stay as they are.
  assert.deepEqual((await readdir(paths.outDir)).sort(), [
    'SHA256SUMS',
    'install-mac.sh',
    'install.sh',
    'lody-lan-cli-0.100.0-lan.8.tgz',
    'manifest.json',
  ]);
  const sums = await readFile(path.join(paths.outDir, 'SHA256SUMS'), 'utf8');
  assert.deepEqual(
    sums.trimEnd().split('\n'),
    manifest.assets.map((asset) => `${asset.sha256}  ${asset.name}`)
  );
  assert.ok(sums.includes(`${'a'.repeat(64)}  LodyOSS-lan-mac-arm64.zip`));
  assert.ok(sums.includes(`${'c'.repeat(64)}  lody-lan-cli.tgz`));
  assert.equal(
    await readFile(path.join(paths.outDir, 'install-mac.sh'), 'utf8'),
    'VERSION="0.100.0-lan.7"\n'
  );
  const notes = renderReleaseNotes(manifest);
  assert.ok(notes.includes('`0.100.0-lan.8`'));
  assert.ok(notes.includes('desktop installers are build `0.100.0-lan.7`'));

  // A whole build describes itself at both levels and carries nothing over.
  await paths.add('lan-desktop-mac', 'LodyOSS-0.100.0-lan.9-arm64.zip', 'mac');
  const whole = assemble(paths, { version: '0.100.0-lan.9', tag: 'lan-dev', carry: previous });
  assert.equal(whole.version, '0.100.0-lan.9');
  assert.deepEqual(whole.cli, {
    version: whole.version,
    commit: whole.commit,
    builtAt: whole.builtAt,
    asset: 'lody-lan-cli.tgz',
  });
  assert.notEqual(
    whole.assets.find((asset) => asset.name === 'LodyOSS-lan-mac-arm64.zip').sha256,
    'a'.repeat(64)
  );
});

test('a release reuses only a whole dev build of its commit and version', () => {
  const build = { version: '0.100.0-lan.7', commit: COMMIT };
  const stableManifest = {
    version: '0.100.0-lan.5',
    commit: OTHER_COMMIT,
    cli: { version: '0.100.0-lan.5', commit: OTHER_COMMIT, builtAt: 'x' },
  };
  const target = { ...build, stableManifest };
  const dev = {
    ...build,
    repository: 'someone/Lody',
    tag: 'lan-dev',
    builtAt: '2026-01-01T00:00:00.000Z',
    assets: [
      { name: 'LodyOSS-lan-win-x64-setup.exe', size: 1, sha256: 'a'.repeat(64) },
      { name: 'lody-lan-cli.tgz', size: 1, sha256: 'b'.repeat(64) },
    ],
    cli: { ...build, builtAt: '2026-01-01T00:00:00.000Z' },
  };
  const cliOnly = { ...dev, version: '0.100.0-lan.6', commit: OTHER_COMMIT };

  assert.equal(canReuseDevBuild(dev, target), true);
  assert.equal(canReuseDevBuild(null, target), false);
  assert.equal(canReuseDevBuild(dev, { ...target, commit: OTHER_COMMIT }), false);
  // Another number: every file reports the dev version.
  assert.equal(canReuseDevBuild(dev, { ...target, version: '0.100.0-lan.2' }), false);
  assert.equal(canReuseDevBuild(cliOnly, target), false);
  assert.equal(
    canReuseDevBuild({ ...dev, cli: { ...dev.cli, version: '0.100.0-lan.8' } }, target),
    false
  );
  assert.equal(canReuseDevBuild({ ...dev, assets: dev.assets.slice(1) }, target), false);
  // Either release still on a build from before desktops recorded what they follow.
  const { cli: _devCli, ...olderDev } = dev;
  const { cli: _stableCli, ...olderStable } = stableManifest;
  assert.equal(canReuseDevBuild(olderDev, target), false);
  assert.equal(canReuseDevBuild(dev, { ...target, stableManifest: olderStable }), false);
  assert.equal(canReuseDevBuild(dev, { ...target, stableManifest: null }), false);

  const plan = (devManifest) =>
    planBuild({ tag: 'v0.100.0-lan.7', requested: '', ...target, devManifest });
  assert.equal(plan(dev), 'reuse');
  assert.equal(plan(cliOnly), 'full');
  assert.equal(plan(null), 'full');
});

test('a release is built in full after a CLI-only rebuild of the same dev tag', async (t) => {
  const paths = await fixture(t);
  const version = '0.100.0-lan.7';
  await paths.add('lan-cli', `lody-${version}.tgz`, 'cli');
  await paths.add('lan-desktop-mac', `LodyOSS-${version}-arm64.zip`, 'mac-arm64');
  const whole = assemble(paths, { version, tag: 'lan-dev' });
  const stableManifest = { cli: { version: '0.100.0-lan.3', commit: OTHER_COMMIT, builtAt: 'x' } };
  const plan = (devManifest) =>
    planBuild({
      tag: `v${version}`,
      requested: '',
      version,
      commit: COMMIT,
      devManifest,
      stableManifest,
    });
  assert.equal(plan(whole), 'reuse');

  // `build: cli` dispatched on the same tag: same version, same commit.
  await rm(path.join(paths.artifactsDir, 'lan-desktop-mac'), { recursive: true });
  await paths.add('lan-cli', `lody-${version}.tgz`, 'cli rebuilt');
  const rebuilt = assemble(paths, { version, tag: 'lan-dev', carry: whole });
  assert.equal(rebuilt.version, version);
  assert.equal(rebuilt.cli.version, version);
  assert.equal(rebuilt.cli.asset, `lody-lan-cli-${version}.tgz`);
  assert.equal(plan(rebuilt), 'full');
});

async function packCli(root, name, files) {
  const staging = await mkdtemp(path.join(tmpdir(), 'lan-pack-'));
  await mkdir(path.join(staging, 'package', 'dist'), { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    await writeFile(path.join(staging, 'package', file), content);
  }
  await mkdir(root, { recursive: true });
  const tarball = path.join(root, name);
  spawnSync('tar', ['-czf', tarball, '-C', staging, 'package']);
  await rm(staging, { recursive: true, force: true });
  return tarball;
}

async function unpackCli(tarball, file) {
  const directory = await mkdtemp(path.join(tmpdir(), 'lan-unpack-'));
  spawnSync('tar', ['-xzf', tarball, '-C', directory]);
  const content = await readFile(path.join(directory, 'package', file), 'utf8');
  await rm(directory, { recursive: true, force: true });
  return content;
}

const stampOf = (tag) => JSON.stringify({ repository: 'someone/Lody', tag, commit: COMMIT });

test('a reused dev build is published under the release with its own manifest', async (t) => {
  const paths = await fixture(t);
  await packCli(path.join(paths.artifactsDir, 'lan-cli'), 'lody-0.100.0-lan.7.tgz', {
    'dist/index.js': `parse('${stampOf('lan-dev')}');\n`,
    'package.json': '{"name":"lody","version":"0.100.0-lan.7"}\n',
  });
  await paths.add('lan-desktop-mac', 'LodyOSS-0.100.0-lan.7-arm64.zip', 'mac-arm64');
  const devDir = path.join(paths.root, 'lan-dev');
  const dev = assemble(paths, { tag: 'lan-dev', outDir: devDir });
  // Left in the release by an earlier CLI-only build; no manifest lists it.
  await writeFile(path.join(devDir, 'lody-lan-cli-0.100.0-lan.6.tgz'), 'stale');
  const stableManifest = { cli: { version: '0.100.0-lan.3', commit: OTHER_COMMIT, builtAt: 'x' } };
  const promote = (overrides = {}) =>
    promoteDevBuild({
      fromDir: devDir,
      version: '0.100.0-lan.7',
      commit: COMMIT,
      repository: 'someone/Lody',
      tag: 'lan-latest',
      stableManifest,
      templatesDir: paths.templatesDir,
      outDir: paths.outDir,
      ...overrides,
    });

  assert.throws(() => promote({ stableManifest: {} }), /no longer carries/u);
  const manifest = promote();
  assert.equal(manifest.tag, 'lan-latest');
  assert.deepEqual(manifest.cli, dev.cli);
  assert.deepEqual(
    manifest.assets.map((asset) => asset.name),
    dev.assets.map((asset) => asset.name)
  );
  assert.ok(!(await readdir(paths.outDir)).includes('lody-lan-cli-0.100.0-lan.6.tgz'));
  const sums = await readFile(path.join(paths.outDir, 'SHA256SUMS'), 'utf8');
  assert.deepEqual(
    sums.trimEnd().split('\n'),
    manifest.assets.map((asset) => `${asset.sha256}  ${asset.name}`)
  );
  const cli = path.join(paths.outDir, 'lody-lan-cli.tgz');
  assert.equal(await unpackCli(cli, 'dist/index.js'), `parse('${stampOf('lan-latest')}');\n`);
  assert.equal(
    manifest.assets.find((asset) => asset.name === 'lody-lan-cli.tgz').sha256,
    crypto
      .createHash('sha256')
      .update(await readFile(cli))
      .digest('hex')
  );
  assert.equal(manifest.version, '0.100.0-lan.7');
  assert.equal(manifest.builtAt, dev.builtAt);
  assert.equal(
    await readFile(path.join(paths.outDir, 'install.sh'), 'utf8'),
    'REPOSITORY="someone/Lody"\nTAG="lan-latest"\n'
  );
  const zip = manifest.assets.find((asset) => asset.name === 'LodyOSS-lan-mac-arm64.zip');
  assert.deepEqual(
    zip,
    dev.assets.find((asset) => asset.name === zip.name)
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(paths.outDir, 'manifest.json'), 'utf8')),
    manifest
  );

  assert.throws(() => promote({ version: '0.100.0-lan.2' }), /no longer carries/u);
  await writeFile(path.join(devDir, 'LodyOSS-lan-mac-arm64.zip'), 'replaced meanwhile');
  assert.throws(() => promote(), /not the file lan-dev describes/u);
});

test('a CLI tarball is stamped again only where its one stamp is', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lan-restamp-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const from = { repository: 'someone/Lody', tag: 'lan-dev', commit: COMMIT };
  const to = { ...from, tag: 'lan-latest' };

  const twice = await packCli(root, 'twice.tgz', {
    'dist/index.js': `a('${stampOf('lan-dev')}');\n`,
    'dist/other.js': `b('${stampOf('lan-dev')}');\n`,
  });
  assert.throws(() => restampCliTarball(twice, from, to), /stamp 2 times/u);
  const none = await packCli(root, 'none.tgz', { 'dist/index.js': 'a(null);\n' });
  assert.throws(() => restampCliTarball(none, from, to), /stamp 0 times/u);
});
