#!/usr/bin/env node
// Release helpers for a fork that ships the self-hosted LAN build: a rolling
// GitHub Release carrying the desktop installers, the CLI tarball and the
// install scripts under names that never change, so one documented command
// keeps working for every later build.
//
//   node scripts/lan-release.mjs version            # the next release tag's version
//   node scripts/lan-release.mjs version --channel dev   # the next dev tag's version
//   node scripts/lan-release.mjs version --tag v0.103.0-lan.1 --write
//   node scripts/lan-release.mjs version --set 0.103.0-lan.1 --write
//   node scripts/lan-release.mjs plan --tag v0.103.0-lan.1 --commit <sha> \
//     --dev-manifest <lan-dev manifest.json> --stable-manifest <lan-latest manifest.json>
//     # prints the version, and what to build: full | cli | reuse
//   node scripts/lan-release.mjs assemble --version 0.103.0-lan.1 --commit <sha> \
//     --repository owner/repo --tag lan-latest --artifacts <dir> --out <dir> \
//     [--carry <manifest.json the release published last>]
//   node scripts/lan-release.mjs promote --from <lan-dev files> --version 0.103.0-lan.1 \
//     --commit <sha> --repository owner/repo --tag lan-latest --out <dir> \
//     --stable-manifest <lan-latest manifest.json>
//   node scripts/lan-release.mjs signing --certificate <pem>
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { COMMIT_PATTERN, REPOSITORY_PATTERN, TAG_PATTERN } from './lan-build-stamp.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const VERSIONED_MANIFESTS = ['apps/cli/package.json', 'apps/electron/package.json'];
const CHANGELOG_DIRECTORY = 'site-docs/content/changelog/en';
const INSTALL_SCRIPT_TEMPLATES = ['install.sh', 'install-mac.sh'];
const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+-lan\.\d+$/u;

/**
 * Where a tag publishes. A release tag `v<upstream>-lan.<n>` replaces the
 * rolling release everyone follows; a dev tag `dev-v<upstream>-lan.<n>`
 * replaces `lan-dev`, which only installations made from it follow. Each
 * channel numbers its builds on its own, since a build only ever compares
 * itself with the builds of the release it follows.
 */
export const LAN_CHANNELS = {
  stable: { tagPrefix: 'v', rollingTag: 'lan-latest' },
  dev: { tagPrefix: 'dev-v', rollingTag: 'lan-dev' },
};

export function resolveTagChannel(tag) {
  return String(tag).startsWith(LAN_CHANNELS.dev.tagPrefix) ? 'dev' : 'stable';
}

/**
 * A dev tag ending in this builds the CLI tarball only; the release keeps the
 * desktop installers it already carries. The suffix is not part of the version.
 */
export const CLI_ONLY_TAG_SUFFIX = '-cli';

function stripCliOnlySuffix(tag) {
  const text = String(tag);
  return text.endsWith(CLI_ONLY_TAG_SUFFIX) ? text.slice(0, -CLI_ONLY_TAG_SUFFIX.length) : text;
}

/**
 * The fork follows the upstream release line and numbers its own builds in the
 * prerelease part, so an upstream version bump and a fork rebuild both sort
 * after every earlier fork build.
 */
export function composeLanVersion(baseVersion, buildNumber) {
  const match = /^(\d+\.\d+\.\d+)(?:[-+].*)?$/u.exec(String(baseVersion).trim());
  if (!match) {
    throw new Error(`Cannot derive a LAN build version from ${JSON.stringify(baseVersion)}`);
  }
  const build = Number(buildNumber);
  if (!Number.isInteger(build) || build < 1) {
    throw new Error(`LAN build number must be a positive integer, got ${String(buildNumber)}`);
  }
  return `${match[1]}-lan.${build}`;
}

/**
 * Upstream never bumps the manifests (they stay at the version of an old
 * release); each release instead adds a changelog entry whose frontmatter names
 * it. The newest of those is the upstream release this checkout has synced.
 */
export function readBaseVersion(root = repositoryRoot) {
  const directory = path.join(root, CHANGELOG_DIRECTORY);
  const versions = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.mdx'))
    .map((name) => {
      const text = fs.readFileSync(path.join(directory, name), 'utf8');
      return /^---\r?\n[\s\S]*?^version:\s*(\d+)\.(\d+)\.(\d+)\s*$/mu.exec(text);
    })
    .filter((match) => match !== null)
    .map((match) => match.slice(1, 4).map(Number));
  if (versions.length === 0) {
    throw new Error(`No released version found in ${CHANGELOG_DIRECTORY}`);
  }
  versions.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return versions.at(-1).join('.');
}

/**
 * A build is published only from a tag `v<upstream>-lan.<n>`, pushed once its
 * owner decides the branch is ready. The tag names the build, and its upstream
 * part has to be the release the tagged commit synced.
 */
export function resolveTagVersion(tag, baseVersion) {
  const channel = resolveTagChannel(tag);
  if (channel === 'stable' && String(tag).endsWith(CLI_ONLY_TAG_SUFFIX)) {
    throw new Error(
      `A release tag builds everything; only a dev tag may end in ${CLI_ONLY_TAG_SUFFIX}`
    );
  }
  const { tagPrefix } = LAN_CHANNELS[channel];
  const version = stripCliOnlySuffix(tag).slice(tagPrefix.length);
  if (!RELEASE_VERSION_PATTERN.test(version) || !String(tag).startsWith(tagPrefix)) {
    throw new Error(
      `A LAN release tag looks like v${baseVersion}-lan.1 or dev-v${baseVersion}-lan.1, got ${JSON.stringify(tag)}`
    );
  }
  if (!version.startsWith(`${baseVersion}-lan.`)) {
    throw new Error(
      `Tag ${tag} does not name ${baseVersion}, the upstream release this commit synced`
    );
  }
  composeLanVersion(baseVersion, version.slice(`${baseVersion}-lan.`.length));
  return version;
}

/**
 * The version the next release tag takes: numbers restart at 1 with every
 * upstream release, so a newer upstream part sorts after every earlier build.
 */
export function nextLanVersion(baseVersion, tags, channel = 'stable') {
  const prefix = `${LAN_CHANNELS[channel].tagPrefix}${baseVersion}-lan.`;
  const taken = tags
    .map(stripCliOnlySuffix)
    .filter((tag) => tag.startsWith(prefix) && /^\d+$/u.test(tag.slice(prefix.length)))
    .map((tag) => Number(tag.slice(prefix.length)));
  return composeLanVersion(baseVersion, Math.max(0, ...taken) + 1);
}

function listReleaseTags(baseVersion, channel, root = repositoryRoot) {
  const pattern = `${LAN_CHANNELS[channel].tagPrefix}${baseVersion}-lan.*`;
  return execFileSync('git', ['-C', root, 'tag', '--list', pattern], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
}

export function writeVersion(version, root = repositoryRoot) {
  for (const relativePath of VERSIONED_MANIFESTS) {
    const manifestPath = path.join(root, relativePath);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.version = version;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

/**
 * Maps one built file to the name it is published under, or `null` for files
 * that are not part of the release (update metadata, block maps, unpacked
 * directories). The published name carries no version: the rolling release
 * replaces the file in place.
 */
export function resolvePublishedName(fileName) {
  if (/^lody-.*\.tgz$/u.test(fileName)) return 'lody-lan-cli.tgz';
  const desktop = /^LodyOSS-.+-(arm64|x64|x86_64|amd64)(-setup)?\.(dmg|zip|exe|AppImage)$/u.exec(
    fileName
  );
  if (!desktop) return null;
  const arch = desktop[1] === 'arm64' ? 'arm64' : 'x64';
  const extension = desktop[3];
  if (extension === 'exe') return `LodyOSS-lan-win-${arch}-setup.exe`;
  if (extension === 'AppImage') return `LodyOSS-lan-linux-${arch}.AppImage`;
  return `LodyOSS-lan-mac-${arch}.${extension}`;
}

const CLI_ASSET_NAME = 'lody-lan-cli.tgz';

export function isDesktopAssetName(name) {
  const published = resolvePublishedName(name);
  return published !== null && published !== CLI_ASSET_NAME;
}

function listFiles(directory) {
  const files = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  }
  return files.sort();
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function renderInstallScript(template, values) {
  const rendered = template
    .replaceAll('__LODY_LAN_REPOSITORY__', values.repository)
    .replaceAll('__LODY_LAN_TAG__', values.tag)
    .replaceAll('__LODY_LAN_VERSION__', values.version);
  const unresolved = /__LODY_LAN_[A-Z_]+__/u.exec(rendered);
  if (unresolved) {
    throw new Error(`Install script template has an unknown placeholder ${unresolved[0]}`);
  }
  return rendered;
}

/**
 * `carry` is the manifest the release published last. A build without desktop
 * installers keeps the files of the build it lists, the CLI tarball under its
 * fixed name included: they stay in the release, and the top level of the
 * manifest goes on describing that build. A desktop, every build older than
 * `cli` and the install script read only the top level, and the tarball they
 * install reports that version. The new tarball goes beside it under a name
 * of its own. `cli` always describes the CLI tarball assembled here.
 */
export function assembleRelease(options) {
  const { version, commit, repository, tag, artifactsDir, outDir, carry } = options;
  if (!RELEASE_VERSION_PATTERN.test(version)) {
    throw new Error(`Refusing to assemble a release for version ${JSON.stringify(version)}`);
  }
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error(`Invalid repository ${JSON.stringify(repository)}`);
  }
  if (!TAG_PATTERN.test(tag)) throw new Error(`Invalid release tag ${JSON.stringify(tag)}`);
  if (!COMMIT_PATTERN.test(commit)) throw new Error(`Invalid commit ${JSON.stringify(commit)}`);

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const published = new Map();
  for (const filePath of listFiles(artifactsDir)) {
    const name = resolvePublishedName(path.basename(filePath));
    if (!name) continue;
    if (published.has(name)) {
      throw new Error(
        `Both ${published.get(name)} and ${filePath} would be published as ${name}; ` +
          'one build produced two files for the same target'
      );
    }
    published.set(name, filePath);
    fs.copyFileSync(filePath, path.join(outDir, name));
  }
  if (!published.has(CLI_ASSET_NAME)) {
    throw new Error(`No CLI tarball found under ${artifactsDir}`);
  }

  const built = { version, commit, builtAt: options.builtAt ?? new Date().toISOString() };
  const carrying =
    ![...published.keys()].some(isDesktopAssetName) &&
    Boolean(carry?.assets.some((asset) => isDesktopAssetName(asset.name)));
  const carried = carrying
    ? carry.assets.filter(
        (asset) => isDesktopAssetName(asset.name) || asset.name === CLI_ASSET_NAME
      )
    : [];
  const top = carrying
    ? { version: carry.version, commit: carry.commit, builtAt: carry.builtAt }
    : built;
  let cliAsset = CLI_ASSET_NAME;
  if (carrying) {
    cliAsset = `lody-lan-cli-${version}.tgz`;
    fs.renameSync(path.join(outDir, CLI_ASSET_NAME), path.join(outDir, cliAsset));
    published.set(cliAsset, published.get(CLI_ASSET_NAME));
    published.delete(CLI_ASSET_NAME);
  }

  const templatesDir = options.templatesDir ?? path.join(repositoryRoot, 'scripts', 'lan');
  for (const templateName of INSTALL_SCRIPT_TEMPLATES) {
    const template = fs.readFileSync(path.join(templatesDir, templateName), 'utf8');
    const targetPath = path.join(outDir, templateName);
    fs.writeFileSync(
      targetPath,
      renderInstallScript(template, { repository, tag, version: top.version }),
      { mode: 0o755 }
    );
    published.set(templateName, path.join(templatesDir, templateName));
  }

  const assets = [
    ...[...published.keys()].map((name) => {
      const assetPath = path.join(outDir, name);
      return { name, size: fs.statSync(assetPath).size, sha256: sha256(assetPath) };
    }),
    ...carried.map(({ name, size, sha256: digest }) => ({ name, size, sha256: digest })),
  ].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  fs.writeFileSync(
    path.join(outDir, 'SHA256SUMS'),
    `${assets.map((asset) => `${asset.sha256}  ${asset.name}`).join('\n')}\n`
  );
  const manifest = { ...top, repository, tag, assets, cli: { ...built, asset: cliAsset } };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/**
 * Whether a release tag can publish what `lan-dev` carries instead of building
 * again: the dev release holds a whole build, desktop installers included, of
 * the same commit under the same version. The version is inside every file it
 * holds, and a desktop refuses an installer that names another one.
 *
 * The desktop installers keep the stamp of `lan-dev`; a desktop follows
 * `lan-latest` only because it recorded so when a build that records it first
 * started. So both releases have to be past the build that brought the
 * record, which is the one that brought `cli` into the manifest.
 */
export function canReuseDevBuild(devManifest, { version, commit, stableManifest }) {
  if (!devManifest?.cli || !stableManifest?.cli) return false;
  return (
    devManifest.commit === commit &&
    devManifest.version === version &&
    devManifest.cli.commit === commit &&
    devManifest.cli.version === version &&
    // A CLI-only rebuild of the same tag lists its tarball under a name of its
    // own beside the one of the whole build; that is no whole build any more.
    (devManifest.cli.asset ?? CLI_ASSET_NAME) === CLI_ASSET_NAME &&
    devManifest.assets.some((asset) => isDesktopAssetName(asset.name))
  );
}

/**
 * Makes a CLI tarball follow another release: the stamp is the JSON text the
 * bundler inlined once (`scripts/lan-build-stamp.mjs`), and nothing else may
 * read the same.
 */
export function restampCliTarball(tarball, from, to) {
  const before = JSON.stringify({
    repository: from.repository,
    tag: from.tag,
    commit: from.commit,
  });
  const after = JSON.stringify({ repository: to.repository, tag: to.tag, commit: to.commit });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-restamp-'));
  try {
    execFileSync('tar', ['-xzf', tarball, '-C', directory]);
    const stamped = listFiles(directory).filter((file) =>
      fs.readFileSync(file, 'utf8').includes(before)
    );
    const count = stamped.reduce(
      (total, file) => total + fs.readFileSync(file, 'utf8').split(before).length - 1,
      0
    );
    if (count !== 1) {
      throw new Error(`${path.basename(tarball)} carries its stamp ${count} times, not once`);
    }
    fs.writeFileSync(stamped[0], fs.readFileSync(stamped[0], 'utf8').replace(before, after));
    // Files only, as `npm pack` lists them.
    const entries = listFiles(directory).map((file) => path.relative(directory, file));
    execFileSync('tar', ['-czf', tarball, '-C', directory, ...entries]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * What a run of the workflow builds: `full`, `cli` (a dev build that keeps the
 * published desktop installers) or `reuse` (a release tag publishing the
 * build `lan-dev` already carries).
 */
export function planBuild({ tag, requested, version, commit, devManifest, stableManifest }) {
  if (requested && requested !== 'full' && requested !== 'cli') {
    throw new Error(`No build ${JSON.stringify(requested)}; it is full or cli`);
  }
  if (tag && resolveTagChannel(tag) === 'stable') {
    if (requested === 'cli') throw new Error('A release tag builds everything');
    return canReuseDevBuild(devManifest, { version, commit, stableManifest }) ? 'reuse' : 'full';
  }
  if (tag?.endsWith(CLI_ONLY_TAG_SUFFIX)) return 'cli';
  return requested || 'full';
}

/**
 * Publishes the build a dev release carries as a release: `fromDir` holds
 * every file of `lan-dev` as downloaded, its manifest included. The CLI
 * tarball is stamped again to follow the release; the desktop installers
 * cannot be, and follow what the desktop recorded.
 */
export function promoteDevBuild(options) {
  const { fromDir, version, commit, repository, tag, stableManifest } = options;
  const devManifest = JSON.parse(fs.readFileSync(path.join(fromDir, 'manifest.json'), 'utf8'));
  if (!canReuseDevBuild(devManifest, { version, commit, stableManifest })) {
    throw new Error(`lan-dev no longer carries a whole build of ${version} at ${commit}`);
  }
  for (const asset of devManifest.assets) {
    if (sha256(path.join(fromDir, asset.name)) !== asset.sha256) {
      throw new Error(
        `${asset.name} is not the file lan-dev describes; a newer build may be on its way`
      );
    }
  }
  restampCliTarball(path.join(fromDir, CLI_ASSET_NAME), devManifest, { repository, tag, commit });
  // The release also holds tarballs of earlier CLI-only builds that no manifest
  // lists any more; only what this one lists is published.
  const listed = `${fromDir}.listed`;
  fs.rmSync(listed, { recursive: true, force: true });
  fs.mkdirSync(listed);
  try {
    for (const asset of devManifest.assets) {
      fs.linkSync(path.join(fromDir, asset.name), path.join(listed, asset.name));
    }
    return assembleRelease({ ...options, artifactsDir: listed, builtAt: devManifest.builtAt });
  } finally {
    fs.rmSync(listed, { recursive: true, force: true });
  }
}

export function renderReleaseNotes(manifest) {
  const base = `https://github.com/${manifest.repository}/releases/download/${manifest.tag}`;
  const has = (name) => manifest.assets.some((asset) => asset.name === name);
  const cli = manifest.cli ?? manifest;
  const lines = [
    `Rolling build \`${cli.version}\` of commit \`${cli.commit.slice(0, 12)}\`.`,
    ...(cli.version === manifest.version
      ? []
      : [
          `This build made the CLI only; the desktop installers are build \`${manifest.version}\` ` +
            `of commit \`${manifest.commit.slice(0, 12)}\`.`,
        ]),
    'Every build replaces these files in place, so the commands below always install the newest one.',
    '',
    '## Server (hub and agent daemon)',
    '',
    'Host a LAN on this machine:',
    '',
    '```bash',
    `curl -fsSL ${base}/install.sh | bash -s -- up`,
    '```',
    '',
    'Join a LAN from another machine, using the link the host printed:',
    '',
    '```bash',
    `curl -fsSL ${base}/install.sh | bash -s -- join '<link>'`,
    '```',
  ];
  if (has('LodyOSS-lan-mac-arm64.zip') || has('LodyOSS-lan-mac-x64.zip')) {
    lines.push(
      '',
      '## macOS desktop',
      '',
      '```bash',
      `curl -fsSL ${base}/install-mac.sh | bash`,
      '```',
      '',
      'The build is not notarized. A copy downloaded with a browser needs',
      '`xattr -dr com.apple.quarantine "/Applications/Lody OSS.app"` before its first launch.'
    );
  }
  if (has('LodyOSS-lan-win-x64-setup.exe')) {
    lines.push(
      '',
      '## Windows desktop',
      '',
      `Download [LodyOSS-lan-win-x64-setup.exe](${base}/LodyOSS-lan-win-x64-setup.exe). The installer is not`,
      'signed, so SmartScreen asks for confirmation once.'
    );
  }
  if (has('LodyOSS-lan-linux-x64.AppImage')) {
    lines.push(
      '',
      '## Linux desktop',
      '',
      `Download [LodyOSS-lan-linux-x64.AppImage](${base}/LodyOSS-lan-linux-x64.AppImage) and mark it executable.`
    );
  }
  return `${lines.join('\n')}\n`;
}

// electron-builder chooses the certificate by what follows these, and refuses
// a name that still carries one.
const APPLE_CERTIFICATE_PREFIXES = [
  'Developer ID Application:',
  'Developer ID Installer:',
  '3rd Party Mac Developer Application:',
  '3rd Party Mac Developer Installer:',
];

function readNameFields(name) {
  const fields = new Map();
  for (const line of name.split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return fields;
}

/**
 * What the workflow has to know about the certificate that signs the macOS
 * build. One that Apple issued names a team, which every file it signs then
 * carries. One of the builder's own names none: the workflow has to trust it
 * before anything accepts it, and the application needs an exception to load
 * what it is bundled with.
 */
export function describeSigningCertificate(pem) {
  const certificate = new crypto.X509Certificate(pem);
  const subject = readNameFields(certificate.subject);
  const commonName = subject.get('CN')?.trim();
  if (!commonName) throw new Error('The signing certificate names nobody');
  // The name becomes a line of the workflow's outputs.
  if (/[\u0000-\u001f\u007f]/u.test(commonName)) {
    throw new Error('The name of the signing certificate holds a control character');
  }

  const prefix = APPLE_CERTIFICATE_PREFIXES.find((candidate) => commonName.startsWith(candidate));
  const name = prefix ? commonName.slice(prefix.length).trim() : commonName;
  const teamId =
    readNameFields(certificate.issuer).get('O') === 'Apple Inc.'
      ? subject.get('OU')?.trim() || null
      : null;
  return { name, teamId, selfSigned: teamId === null };
}

function requireOption(values, name) {
  const value = values[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing --${name}`);
  }
  return value.trim();
}

/** A manifest the workflow downloaded; it downloads none from a release that has none yet. */
function readPublishedManifest(file) {
  return file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'version') {
    const { values } = parseArgs({
      args: rest,
      options: {
        tag: { type: 'string' },
        set: { type: 'string' },
        channel: { type: 'string', default: 'stable' },
        write: { type: 'boolean', default: false },
      },
    });
    // `--tag` names a release build; `--set` stamps a version another job
    // already derived; without either this is the version the next tag takes.
    let version = values.set;
    if (version === undefined) {
      const base = readBaseVersion();
      const { channel } = values;
      if (!(channel in LAN_CHANNELS)) throw new Error(`No channel ${JSON.stringify(channel)}`);
      version =
        values.tag === undefined
          ? nextLanVersion(base, listReleaseTags(base, channel), channel)
          : resolveTagVersion(values.tag, base);
    } else if (!RELEASE_VERSION_PATTERN.test(version)) {
      throw new Error(`Refusing to stamp version ${JSON.stringify(version)}`);
    }
    if (values.write) writeVersion(version);
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
    }
    console.log(version);
    return;
  }
  if (command === 'plan') {
    const { values } = parseArgs({
      args: rest,
      options: {
        tag: { type: 'string' },
        build: { type: 'string' },
        commit: { type: 'string' },
        'dev-manifest': { type: 'string' },
        'stable-manifest': { type: 'string' },
      },
    });
    const base = readBaseVersion();
    const tag = values.tag?.trim() || undefined;
    const version = tag
      ? resolveTagVersion(tag, base)
      : nextLanVersion(base, listReleaseTags(base, 'stable'));
    const devManifest = readPublishedManifest(values['dev-manifest']);
    const build = planBuild({
      tag,
      requested: values.build?.trim(),
      version,
      commit: requireOption(values, 'commit'),
      devManifest,
      stableManifest: readPublishedManifest(values['stable-manifest']),
    });
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nbuild=${build}\n`);
    }
    console.log(`${version} (${build})`);
    return;
  }
  if (command === 'assemble') {
    const { values } = parseArgs({
      args: rest,
      options: {
        version: { type: 'string' },
        commit: { type: 'string' },
        repository: { type: 'string' },
        tag: { type: 'string' },
        artifacts: { type: 'string' },
        out: { type: 'string' },
        notes: { type: 'string' },
        carry: { type: 'string' },
      },
    });
    const manifest = assembleRelease({
      carry: readPublishedManifest(values.carry),
      version: requireOption(values, 'version'),
      commit: requireOption(values, 'commit'),
      repository: requireOption(values, 'repository'),
      tag: requireOption(values, 'tag'),
      artifactsDir: path.resolve(requireOption(values, 'artifacts')),
      outDir: path.resolve(requireOption(values, 'out')),
    });
    if (values.notes) fs.writeFileSync(path.resolve(values.notes), renderReleaseNotes(manifest));
    for (const asset of manifest.assets) console.log(`${asset.sha256}  ${asset.name}`);
    return;
  }
  if (command === 'promote') {
    const { values } = parseArgs({
      args: rest,
      options: {
        from: { type: 'string' },
        version: { type: 'string' },
        commit: { type: 'string' },
        repository: { type: 'string' },
        tag: { type: 'string' },
        out: { type: 'string' },
        notes: { type: 'string' },
        'stable-manifest': { type: 'string' },
      },
    });
    const manifest = promoteDevBuild({
      stableManifest: readPublishedManifest(values['stable-manifest']),
      fromDir: path.resolve(requireOption(values, 'from')),
      version: requireOption(values, 'version'),
      commit: requireOption(values, 'commit'),
      repository: requireOption(values, 'repository'),
      tag: requireOption(values, 'tag'),
      outDir: path.resolve(requireOption(values, 'out')),
    });
    if (values.notes) fs.writeFileSync(path.resolve(values.notes), renderReleaseNotes(manifest));
    for (const asset of manifest.assets) console.log(`${asset.sha256}  ${asset.name}`);
    return;
  }
  if (command === 'signing') {
    const { values } = parseArgs({ args: rest, options: { certificate: { type: 'string' } } });
    const { name, teamId, selfSigned } = describeSigningCertificate(
      fs.readFileSync(path.resolve(requireOption(values, 'certificate')), 'utf8')
    );
    if (teamId) {
      // The certificate of a person names that person. Whoever inspects a
      // build reads the name there; the log of a build does not repeat it.
      console.log(`::add-mask::${name}`);
      console.log(`::add-mask::${teamId}`);
    }
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        `name=${name}\nself_signed=${selfSigned ? '1' : ''}\n`
      );
    }
    console.log(
      selfSigned
        ? 'The certificate is the builder’s own and names no team.'
        : 'Apple issued the certificate, and it names a team.'
    );
    return;
  }
  throw new Error('Usage: lan-release.mjs <version|plan|assemble|promote|signing> [options]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
