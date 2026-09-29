import { z } from 'zod';

/**
 * The releases a build of the LAN fork follows. A build does not name a
 * repository in its source: the workflow that made it stamps the repository it
 * ran in, so a fork of the fork follows its own releases.
 */
export const LAN_RELEASE_MANIFEST_NAME = 'manifest.json';
export const LAN_CLI_ASSET_NAME = 'lody-lan-cli.tgz';

const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/u;
const TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const COMMIT_PATTERN = /^[a-f0-9]{7,40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
// A name is joined to an address and to a directory, so it is one path segment.
const ASSET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const LAN_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)-lan\.(\d+)$/u;

export const LanReleaseSourceSchema = z
  .object({
    repository: z.string().regex(REPOSITORY_PATTERN),
    tag: z.string().regex(TAG_PATTERN),
    /** The commit this build was made from. */
    commit: z.string().regex(COMMIT_PATTERN).optional(),
  })
  .strict();
export type LanReleaseSource = z.infer<typeof LanReleaseSourceSchema>;

export const LanReleaseAssetSchema = z.object({
  name: z.string().regex(ASSET_NAME_PATTERN),
  size: z.number().int().positive(),
  sha256: z.string().regex(SHA256_PATTERN),
});
export type LanReleaseAsset = z.infer<typeof LanReleaseAssetSchema>;

// Not strict: a later build may describe itself with more than this one reads.
export const LanReleaseManifestSchema = z.object({
  version: z.string().regex(LAN_VERSION_PATTERN),
  commit: z.string().regex(COMMIT_PATTERN),
  repository: z.string().regex(REPOSITORY_PATTERN),
  tag: z.string().regex(TAG_PATTERN),
  builtAt: z.string().min(1),
  assets: z.array(LanReleaseAssetSchema),
});
export type LanReleaseManifest = z.infer<typeof LanReleaseManifestSchema>;

/** What a window or another machine may know about the newest build. */
export const LanReleaseSummarySchema = z
  .object({
    version: z.string(),
    commit: z.string(),
    builtAt: z.string(),
  })
  .strict();
export type LanReleaseSummary = z.infer<typeof LanReleaseSummarySchema>;

export function summarizeLanRelease(manifest: LanReleaseManifest): LanReleaseSummary {
  return { version: manifest.version, commit: manifest.commit, builtAt: manifest.builtAt };
}

/** The stamp of a build, or `null` for a build nobody stamped. */
export function parseLanReleaseSource(value: unknown): LanReleaseSource | null {
  let candidate = value;
  if (typeof value === 'string') {
    try {
      candidate = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  const parsed = LanReleaseSourceSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * The stamp a build is given from what its workflow knows. A build without a
 * repository or a tag follows nothing; one that names them wrongly fails, so a
 * release never ships a build that silently cannot follow it.
 */
export function composeLanReleaseSource(values: {
  repository?: string | null;
  tag?: string | null;
  commit?: string | null;
}): LanReleaseSource | null {
  const repository = values.repository?.trim();
  const tag = values.tag?.trim();
  if (!repository || !tag) return null;
  const commit = values.commit?.trim();
  return LanReleaseSourceSchema.parse({ repository, tag, ...(commit ? { commit } : {}) });
}

export function getLanReleaseBaseUrl(source: Pick<LanReleaseSource, 'repository' | 'tag'>): string {
  return `https://github.com/${source.repository}/releases/download/${source.tag}`;
}

export function getLanReleasePageUrl(source: Pick<LanReleaseSource, 'repository' | 'tag'>): string {
  return `https://github.com/${source.repository}/releases/tag/${source.tag}`;
}

export type LanVersion = { major: number; minor: number; patch: number; build: number };

/** `null` for a version the fork did not number, such as an upstream one. */
export function parseLanVersion(version: string | null | undefined): LanVersion | null {
  const match = LAN_VERSION_PATTERN.exec(version?.trim() ?? '');
  if (!match) return null;
  const [major, minor, patch, build] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
  ];
  return { major, minor, patch, build };
}

/**
 * Positive when `left` is the later build. The fork follows the upstream
 * release line and numbers its own builds after it, so the upstream part
 * decides before the build number does. `null` when either is no fork build.
 */
export function compareLanVersions(
  left: string | null | undefined,
  right: string | null | undefined
): number | null {
  const a = parseLanVersion(left);
  const b = parseLanVersion(right);
  if (!a || !b) return null;
  return (
    a.major - b.major || a.minor - b.minor || a.patch - b.patch || a.build - b.build
  );
}

/**
 * - `available`: the newest build is later than the running one.
 * - `current`: the running build is the newest, or later than what was read.
 * - `unknown`: the running version is not one of the fork, so nothing follows it.
 */
export type LanUpdateAvailability = 'available' | 'current' | 'unknown';

export function resolveLanUpdateAvailability(
  runningVersion: string | null | undefined,
  newestVersion: string | null | undefined
): LanUpdateAvailability {
  const order = compareLanVersions(newestVersion, runningVersion);
  if (order === null) return 'unknown';
  return order > 0 ? 'available' : 'current';
}

/**
 * The file a desktop of this platform installs, or `null` where the fork
 * builds none. The names carry no version: a release replaces them in place.
 */
export function resolveLanDesktopAssetName(platform: string, arch: string): string | null {
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'LodyOSS-lan-mac-arm64.zip' : 'LodyOSS-lan-mac-x64.zip';
  }
  // Windows on ARM runs the x64 build.
  if (platform === 'win32') return 'LodyOSS-lan-win-x64-setup.exe';
  if (platform === 'linux' && arch === 'x64') return 'LodyOSS-lan-linux-x64.AppImage';
  return null;
}

export function findLanReleaseAsset(
  manifest: Pick<LanReleaseManifest, 'assets'>,
  name: string | null
): LanReleaseAsset | null {
  if (!name) return null;
  return manifest.assets.find((asset) => asset.name === name) ?? null;
}

/**
 * Who replaces the agent service of a machine with a later build:
 * - `service`: the service itself, when any member of the LAN asks. It was put
 *   there by the install script and something starts it again after it exits.
 * - `desktop`: the desktop application that carries it, from its own window.
 * - `manual`: whoever installed it; a checkout, a package manager, or a
 *   service started by hand that nothing would start again.
 */
export const LAN_UPDATE_CHANNELS = ['service', 'desktop', 'manual'] as const;
export type LanUpdateChannel = (typeof LAN_UPDATE_CHANNELS)[number];
export const LanUpdateChannelSchema = z.enum(LAN_UPDATE_CHANNELS);

/** What a machine tells the members of a LAN about the build it runs. */
export const LanMachineBuildSchema = z
  .object({
    version: z.string().min(1).max(64),
    update: LanUpdateChannelSchema,
    /** Absent for a build nobody stamped; nothing follows such a build. */
    source: LanReleaseSourceSchema.optional(),
  })
  .strict();
export type LanMachineBuild = z.infer<typeof LanMachineBuildSchema>;

export function parseLanMachineBuild(value: unknown): LanMachineBuild | null {
  const parsed = LanMachineBuildSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Where an update of a machine stands, as the machine itself reports it. A
 * finished update is not a state: the machine starts again and reports the
 * version it then runs.
 */
export const LAN_MACHINE_UPDATE_PHASES = [
  'downloading',
  'installing',
  'restarting',
  'failed',
] as const;
export type LanMachineUpdatePhase = (typeof LAN_MACHINE_UPDATE_PHASES)[number];

export const LanMachineUpdateSchema = z
  .object({
    phase: z.enum(LAN_MACHINE_UPDATE_PHASES),
    /** The version being installed. */
    version: z.string().min(1).max(64),
    /** When the machine reported this, by its own clock. */
    at: z.number().finite().nonnegative(),
    /** Why it failed, in words for a person. Never a directory of the machine. */
    error: z.string().max(500).optional(),
  })
  .strict();
export type LanMachineUpdate = z.infer<typeof LanMachineUpdateSchema>;

export function parseLanMachineUpdate(value: unknown): LanMachineUpdate | null {
  const parsed = LanMachineUpdateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function sameLanReleaseSource(
  left: Pick<LanReleaseSource, 'repository' | 'tag'> | null | undefined,
  right: Pick<LanReleaseSource, 'repository' | 'tag'> | null | undefined
): boolean {
  if (!left || !right) return false;
  return (
    left.repository.toLowerCase() === right.repository.toLowerCase() && left.tag === right.tag
  );
}
