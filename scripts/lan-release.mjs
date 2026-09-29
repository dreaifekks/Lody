#!/usr/bin/env node
// Release helpers for a fork that ships the self-hosted LAN build: a rolling
// GitHub Release carrying the desktop installers, the CLI tarball and the
// install scripts under names that never change, so one documented command
// keeps working for every later build.
//
//   node scripts/lan-release.mjs version --build 12 --write
//   node scripts/lan-release.mjs assemble --version 0.100.0-lan.12 --commit <sha> \
//     --repository owner/repo --tag lan-latest --artifacts <dir> --out <dir>
//   node scripts/lan-release.mjs signing --certificate <pem>
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { COMMIT_PATTERN, REPOSITORY_PATTERN, TAG_PATTERN } from './lan-build-stamp.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const VERSIONED_MANIFESTS = ['apps/cli/package.json', 'apps/electron/package.json'];
const INSTALL_SCRIPT_TEMPLATES = ['install.sh', 'install-mac.sh'];
const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+-lan\.\d+$/u;

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

export function readBaseVersion(root = repositoryRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, VERSIONED_MANIFESTS[1]), 'utf8'));
  return manifest.version;
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

export function assembleRelease(options) {
  const { version, commit, repository, tag, artifactsDir, outDir } = options;
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
  if (!published.has('lody-lan-cli.tgz')) {
    throw new Error(`No CLI tarball found under ${artifactsDir}`);
  }

  const templatesDir = options.templatesDir ?? path.join(repositoryRoot, 'scripts', 'lan');
  for (const templateName of INSTALL_SCRIPT_TEMPLATES) {
    const template = fs.readFileSync(path.join(templatesDir, templateName), 'utf8');
    const targetPath = path.join(outDir, templateName);
    fs.writeFileSync(targetPath, renderInstallScript(template, { repository, tag, version }), {
      mode: 0o755,
    });
    published.set(templateName, path.join(templatesDir, templateName));
  }

  const assets = [...published.keys()].sort().map((name) => {
    const assetPath = path.join(outDir, name);
    return { name, size: fs.statSync(assetPath).size, sha256: sha256(assetPath) };
  });
  fs.writeFileSync(
    path.join(outDir, 'SHA256SUMS'),
    `${assets.map((asset) => `${asset.sha256}  ${asset.name}`).join('\n')}\n`
  );
  const manifest = {
    version,
    commit,
    repository,
    tag,
    builtAt: options.builtAt ?? new Date().toISOString(),
    assets,
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function renderReleaseNotes(manifest) {
  const base = `https://github.com/${manifest.repository}/releases/download/${manifest.tag}`;
  const has = (name) => manifest.assets.some((asset) => asset.name === name);
  const lines = [
    `Rolling build \`${manifest.version}\` of commit \`${manifest.commit.slice(0, 12)}\`.`,
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

function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'version') {
    const { values } = parseArgs({
      args: rest,
      options: { build: { type: 'string' }, write: { type: 'boolean', default: false } },
    });
    const version = composeLanVersion(
      readBaseVersion(),
      values.build ?? process.env.GITHUB_RUN_NUMBER
    );
    if (values.write) writeVersion(version);
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
    }
    console.log(version);
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
      },
    });
    const manifest = assembleRelease({
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
  throw new Error('Usage: lan-release.mjs <version|assemble|signing> [options]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
