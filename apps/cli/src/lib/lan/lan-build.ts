import fs from 'node:fs';
import path from 'node:path';
import {
  parseLanReleaseSource,
  type LanMachineBuild,
  type LanReleaseSource,
  type LanUpdateChannel,
} from '@lody/shared/lan-release';
import { version } from '@/pkg';

// The workflow that builds a release stamps the repository it ran in. A build
// made anywhere else carries no stamp and follows no release.
declare const __LODY_LAN_RELEASE_JSON__: string | null;

export function getLanReleaseSource(): LanReleaseSource | null {
  return typeof __LODY_LAN_RELEASE_JSON__ === 'string'
    ? parseLanReleaseSource(__LODY_LAN_RELEASE_JSON__)
    : null;
}

/** The name the install script gives the directory it installs into. */
export const LAN_INSTALL_PACKAGE_NAME = 'lody-lan-install';

export type LanInstallation =
  | {
      kind: 'installer';
      /** The directory the install script installed into. */
      root: string;
      /** The runtime and entry the services of this machine run. */
      runtime: string;
      entry: string;
    }
  | { kind: 'desktop' }
  | { kind: 'other' };

function readPackageName(manifestPath: string): string | null {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { name?: unknown };
    return typeof manifest.name === 'string' ? manifest.name : null;
  } catch {
    return null;
  }
}

/**
 * How this agent service came to be on its machine. The install script leaves
 * `<root>/node_modules/lody/dist/index.js` below a package of its own name;
 * nothing else is laid out like that.
 */
export function resolveLanInstallation(
  options: {
    entry?: string;
    runtime?: string;
    /** Whether a desktop application started this agent service. */
    desktop?: boolean;
  } = {}
): LanInstallation {
  if (options.desktop) return { kind: 'desktop' };
  const entry = options.entry ?? process.argv[1];
  if (!entry) return { kind: 'other' };

  let resolved: string;
  try {
    resolved = fs.realpathSync(entry);
  } catch {
    return { kind: 'other' };
  }
  const packageDir = path.dirname(path.dirname(resolved));
  const modulesDir = path.dirname(packageDir);
  const root = path.dirname(modulesDir);
  if (
    path.basename(resolved) !== 'index.js' ||
    path.basename(path.dirname(resolved)) !== 'dist' ||
    path.basename(packageDir) !== 'lody' ||
    path.basename(modulesDir) !== 'node_modules' ||
    readPackageName(path.join(root, 'package.json')) !== LAN_INSTALL_PACKAGE_NAME
  ) {
    return { kind: 'other' };
  }
  return { kind: 'installer', root, runtime: options.runtime ?? process.execPath, entry: resolved };
}

/**
 * Who replaces this agent service with a later build. It replaces itself only
 * when it would come back: the install script laid it out, a release is
 * followed, and something starts the service again after it exits.
 */
export function resolveLanUpdateChannel(options: {
  installation: LanInstallation;
  source: LanReleaseSource | null;
  /** Whether a service manager or a supervisor starts this process again. */
  restarted: boolean;
}): LanUpdateChannel {
  if (options.installation.kind === 'desktop') return 'desktop';
  return options.installation.kind === 'installer' && options.source && options.restarted
    ? 'service'
    : 'manual';
}

/** What this machine tells the members of a LAN about the build it runs. */
export function describeLanMachineBuild(
  update: LanUpdateChannel,
  source: LanReleaseSource | null = getLanReleaseSource()
): LanMachineBuild {
  return { version, update, ...(source ? { source } : {}) };
}
