// Replaces an agent service that the install script installed with the newest
// build of the release it follows. The running process keeps the code it
// loaded; whoever calls this starts the service again afterwards.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  LAN_CLI_ASSET_NAME,
  findLanReleaseAsset,
  readLanCliRelease,
  resolveLanCliAssetName,
  resolveLanUpdateAvailability,
  type LanReleaseManifest,
  type LanReleaseSource,
} from '@lody/shared/lan-release';
import {
  LanReleaseError,
  downloadNewestLanReleaseAsset,
  fetchLanReleaseManifest,
  type LanReleaseFetch,
} from '@lody/shared/node/lan-release';
import { LAN_INSTALL_PACKAGE_NAME, type LanInstallation } from './lan-build';

/**
 * - `unsupported`: this agent service cannot replace itself.
 * - `current`: it already runs the newest build.
 * - `busy`: another update of this installation is under way.
 * - `release`: the release could not be read; `cause` says how.
 * - `install_failed`: the new build did not install or does not start. The
 *   installation is as it was.
 */
export type LanSelfUpdateErrorCode =
  | 'unsupported'
  | 'current'
  | 'busy'
  | 'release'
  | 'install_failed';

export class LanSelfUpdateError extends Error {
  readonly code: LanSelfUpdateErrorCode;

  constructor(code: LanSelfUpdateErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LanSelfUpdateError';
    this.code = code;
  }
}

export type LanSelfUpdatePhase = 'downloading' | 'installing';

export type LanSelfUpdateResult = { from: string; to: string; commit: string };

export type LanUpdateCommandResult = { code: number | null; stdout: string; stderr: string };

export type LanUpdateCommandRunner = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number }
) => Promise<LanUpdateCommandResult>;

const STAGING_NAME = '.update';
const PREVIOUS_NAME = 'node_modules.previous';
// An update that was killed leaves its directory behind. None takes this long.
const STALE_STAGING_MS = 30 * 60_000;
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const PROBE_TIMEOUT_MS = 60_000;
const OUTPUT_LIMIT = 16 * 1024;

export const runLanUpdateCommand: LanUpdateCommandRunner = (command, args, options) =>
  new Promise((resolve) => {
    const child = spawn(command, [...args], {
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const keep = (current: string, chunk: Buffer) =>
      `${current}${chunk.toString()}`.slice(-OUTPUT_LIMIT);
    child.stdout.on('data', (chunk: Buffer) => (stdout = keep(stdout, chunk)));
    child.stderr.on('data', (chunk: Buffer) => (stderr = keep(stderr, chunk)));
    const timer = setTimeout(() => {
      stderr = keep(stderr, Buffer.from(`\ntimed out after ${options.timeoutMs}ms`));
      child.kill('SIGKILL');
    }, options.timeoutMs);
    timer.unref();
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: String(error) });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

/** npm starts `node` from the search path, which a service may not have. */
function withRuntimeOnPath(env: NodeJS.ProcessEnv, runtime: string): NodeJS.ProcessEnv {
  const runtimeDir = path.dirname(runtime);
  const entries = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return {
    ...env,
    PATH: [runtimeDir, ...entries.filter((entry) => entry !== runtimeDir)].join(path.delimiter),
  };
}

function resolveNpm(runtime: string): string {
  const beside = path.join(path.dirname(runtime), 'npm');
  return fs.existsSync(beside) ? beside : 'npm';
}

/** The last words of a command, without the directories it names. */
function summarizeFailure(result: LanUpdateCommandResult, root: string): string {
  const output = (result.stderr.trim() || result.stdout.trim() || 'no output')
    .replaceAll(root, '<installation>')
    .replace(/\s+/gu, ' ');
  return output.slice(-300);
}

function claimStaging(root: string, now: number): string {
  const staging = path.join(root, STAGING_NAME);
  try {
    fs.mkdirSync(staging);
    return staging;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const age = now - fs.statSync(staging).mtimeMs;
  if (age < STALE_STAGING_MS) {
    throw new LanSelfUpdateError('busy', 'Another update of this installation is under way');
  }
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging);
  return staging;
}

/**
 * Puts the staged build where the running one is. The running one stays
 * beside it until the next update, so a build that does not come up can be
 * put back by hand.
 */
function replaceInstallation(root: string, staging: string): void {
  const current = path.join(root, 'node_modules');
  const previous = path.join(root, PREVIOUS_NAME);
  fs.rmSync(previous, { recursive: true, force: true });
  fs.renameSync(current, previous);
  try {
    fs.renameSync(path.join(staging, 'node_modules'), current);
  } catch (error) {
    fs.renameSync(previous, current);
    throw error;
  }
  for (const name of ['package.json', 'package-lock.json']) {
    const staged = path.join(staging, name);
    if (fs.existsSync(staged)) fs.copyFileSync(staged, path.join(root, name));
  }
}

export type LanSelfUpdateOptions = {
  installation: LanInstallation;
  source: LanReleaseSource | null;
  runningVersion: string;
  /** Installs the newest build even when it is the running one. */
  force?: boolean;
  /** The description of the release, when the caller has read it already. */
  manifest?: LanReleaseManifest;
  onPhase?: (phase: LanSelfUpdatePhase, manifest: LanReleaseManifest) => void;
  signal?: AbortSignal;
  run?: LanUpdateCommandRunner;
  fetch?: LanReleaseFetch;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
};

export async function readNewestLanRelease(
  options: Pick<LanSelfUpdateOptions, 'source' | 'fetch' | 'env' | 'signal'>
): Promise<LanReleaseManifest> {
  if (!options.source) {
    throw new LanSelfUpdateError('unsupported', 'This build follows no release');
  }
  try {
    return await fetchLanReleaseManifest(options.source, {
      fetch: options.fetch,
      env: options.env,
      signal: options.signal,
    });
  } catch (error) {
    throw new LanSelfUpdateError(
      'release',
      error instanceof Error ? error.message : 'The release could not be read',
      { cause: error }
    );
  }
}

/**
 * Installs the newest build beside the running one, proves that it starts,
 * and only then puts it in place. Whatever fails before that leaves the
 * installation untouched.
 */
export async function applyLanSelfUpdate(
  options: LanSelfUpdateOptions
): Promise<LanSelfUpdateResult> {
  const { installation, source } = options;
  if (installation.kind !== 'installer' || !source) {
    throw new LanSelfUpdateError(
      'unsupported',
      installation.kind === 'desktop'
        ? 'The desktop application updates this agent service'
        : 'This agent service was not installed by the install script'
    );
  }
  const env = options.env ?? process.env;
  const run = options.run ?? runLanUpdateCommand;
  const { root, runtime } = installation;

  const manifest = readLanCliRelease(options.manifest ?? (await readNewestLanRelease(options)));
  if (
    !options.force &&
    resolveLanUpdateAvailability(options.runningVersion, manifest.version) !== 'available'
  ) {
    throw new LanSelfUpdateError('current', `${options.runningVersion} is the newest build`);
  }
  const assetName = resolveLanCliAssetName(manifest);
  const asset = findLanReleaseAsset(manifest, assetName);
  if (!asset) {
    throw new LanSelfUpdateError('release', `The release carries no ${assetName}`);
  }

  const staging = claimStaging(root, (options.now ?? Date.now)());
  try {
    fs.writeFileSync(
      path.join(staging, 'package.json'),
      `${JSON.stringify({ name: LAN_INSTALL_PACKAGE_NAME, private: true }, null, 2)}\n`
    );
    const tarball = path.join(staging, LAN_CLI_ASSET_NAME);

    options.onPhase?.('downloading', manifest);
    let downloaded: LanReleaseManifest;
    try {
      downloaded = readLanCliRelease(
        await downloadNewestLanReleaseAsset({
          source,
          manifest,
          assetName: asset.name,
          destination: tarball,
          fetch: options.fetch,
          env,
          signal: options.signal,
          // A build published meanwhile is the one installed.
          onManifest: (newer) => options.onPhase?.('downloading', readLanCliRelease(newer)),
        })
      );
    } catch (error) {
      if (!(error instanceof LanReleaseError)) throw error;
      throw new LanSelfUpdateError('release', error.message, { cause: error });
    }

    options.onPhase?.('installing', downloaded);
    const commandEnv = withRuntimeOnPath(env, runtime);
    const installed = await run(
      resolveNpm(runtime),
      [
        'install',
        '--prefix',
        staging,
        '--no-audit',
        '--no-fund',
        '--omit=dev',
        '--loglevel=error',
        tarball,
      ],
      { env: commandEnv, timeoutMs: INSTALL_TIMEOUT_MS }
    );
    if (installed.code !== 0) {
      throw new LanSelfUpdateError(
        'install_failed',
        `npm could not install the build: ${summarizeFailure(installed, root)}`
      );
    }

    const stagedEntry = path.join(staging, 'node_modules', 'lody', 'dist', 'index.js');
    const probe = await run(runtime, [stagedEntry, '--version'], {
      env: commandEnv,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const reported = probe.stdout.trim().split('\n').at(-1)?.trim();
    if (probe.code !== 0 || reported !== downloaded.version) {
      throw new LanSelfUpdateError(
        'install_failed',
        probe.code === 0
          ? `The installed build reports ${reported ?? 'nothing'}, not ${downloaded.version}`
          : `The installed build does not start: ${summarizeFailure(probe, root)}`
      );
    }

    replaceInstallation(root, staging);
    return { from: options.runningVersion, to: downloaded.version, commit: downloaded.commit };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
