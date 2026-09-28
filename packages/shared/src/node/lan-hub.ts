// Node-only contract for the self-hosted Streams hubs ("LANs") a local
// installation belongs to. The CLI and the Electron shell read the same file,
// so every local process agrees on the same LANs and on how this machine
// presents itself in them.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getLodyDataDir } from './installation-profile';
import { LOCAL_USER_ID_PREFIX } from '../platform-kind';
import {
  LAN_HUB_DEFAULT_NAME,
  LanHubInputError,
  getLanHubWorkspaceId,
  normalizeLanHubName,
  normalizeLanHubToken,
  normalizeLanHubUrl,
  normalizeMachineName,
  resolveLanHubSlug,
  type LanHubSummary,
} from '../lan-hub';

export const LAN_HUB_CONFIG_FILE_NAME = 'lan-hub.json';
export const LAN_HUB_URL_ENV = 'LODY_LAN_HUB_URL';
export const LAN_HUB_TOKEN_ENV = 'LODY_LAN_HUB_TOKEN';
export const LAN_HUB_CONFIG_VERSION = 2;
export const MACHINE_NAME_MAX_LENGTH = 64;

export type LanHub = {
  /** Derived from the credential, so every device of one LAN agrees on it. */
  id: string;
  name: string;
  /** Origin of the hub, e.g. `http://100.64.0.1:8788`. No trailing slash. */
  url: string;
  /** Bearer credential shared by every device that joined this LAN. */
  token: string;
};

export type LanHubSettings = {
  hubs: readonly LanHub[];
  /** How this machine is called in every LAN; `null` follows the host name. */
  machineName: string | null;
  /**
   * `environment` settings describe one LAN given by the process environment.
   * They cannot be edited: a change written to the file would not take effect.
   */
  source: 'file' | 'environment' | 'none';
};

export type LanHubSettingsLocation = { env?: NodeJS.ProcessEnv; filePath?: string };

const EMPTY_SETTINGS: LanHubSettings = { hubs: [], machineName: null, source: 'none' };

export function getLanHubConfigPath(): string {
  return path.join(getLodyDataDir('local'), LAN_HUB_CONFIG_FILE_NAME);
}

/**
 * The id names the workspace a LAN carries. It depends on the credential only,
 * so moving a hub to another address keeps its workspace, and two devices that
 * were given the same credential meet in the same workspace.
 */
export function deriveLanHubId(token: string): string {
  return crypto
    .createHash('sha256')
    .update(`lody-lan-hub:workspace:${token}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * The user the members of a LAN act as. Derived from the credential like the
 * workspace, so every build that knows the credential agrees on it, whichever
 * other LANs an installation belongs to.
 */
export function deriveLanHubUserId(token: string): string {
  const id = crypto
    .createHash('sha256')
    .update(`lody-lan-hub:user:${token}`)
    .digest('hex')
    .slice(0, 32);
  return `${LOCAL_USER_ID_PREFIX}${id}`;
}

function normalizeMachineNameSetting(value: unknown, source: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`LAN config ${source} has a machine name that is not text`);
  }
  const name = value.replace(/\s+/g, ' ').trim();
  if (!name) return null;
  if (name.length > MACHINE_NAME_MAX_LENGTH) {
    throw new LanHubInputError(
      'invalid_name',
      `Machine name must be at most ${MACHINE_NAME_MAX_LENGTH} characters`
    );
  }
  return name;
}

function parseHub(source: string, value: unknown, fallbackName: string): LanHub {
  if (!value || typeof value !== 'object') {
    throw new Error(`LAN config ${source} contains an entry that is not an object`);
  }
  const entry = value as { name?: unknown; url?: unknown; token?: unknown };
  if (typeof entry.url !== 'string' || typeof entry.token !== 'string') {
    throw new Error(`LAN config ${source} requires both url and token for every LAN`);
  }
  try {
    const token = normalizeLanHubToken(entry.token);
    return {
      id: deriveLanHubId(token),
      name: normalizeLanHubName(
        typeof entry.name === 'string' && entry.name.trim() ? entry.name : fallbackName
      ),
      url: normalizeLanHubUrl(entry.url),
      token,
    };
  } catch (error) {
    // The credential never reaches a log: the entry is named by its position.
    throw new Error(
      `LAN config ${source} is invalid: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

function parseSettingsFile(filePath: string, decoded: unknown): LanHubSettings {
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error(`LAN config ${filePath} must be an object`);
  }
  const value = decoded as {
    version?: unknown;
    hubs?: unknown;
    machineName?: unknown;
    url?: unknown;
    token?: unknown;
  };
  // The first format held one LAN as `{ url, token }`.
  if (value.version === undefined && value.hubs === undefined) {
    return {
      hubs: [parseHub(filePath, value, LAN_HUB_DEFAULT_NAME)],
      machineName: normalizeMachineNameSetting(value.machineName, filePath),
      source: 'file',
    };
  }
  if (value.version !== LAN_HUB_CONFIG_VERSION) {
    throw new Error(
      `LAN config ${filePath} has unsupported version ${JSON.stringify(value.version)}`
    );
  }
  if (!Array.isArray(value.hubs)) {
    throw new Error(`LAN config ${filePath} must list its LANs in "hubs"`);
  }
  const hubs: LanHub[] = [];
  for (const [index, entry] of value.hubs.entries()) {
    const hub = parseHub(
      `${filePath} (LAN ${index + 1})`,
      entry,
      index === 0 ? LAN_HUB_DEFAULT_NAME : `${LAN_HUB_DEFAULT_NAME} ${index + 1}`
    );
    if (hubs.some((existing) => existing.id === hub.id)) {
      throw new Error(`LAN config ${filePath} lists the same LAN twice (LAN ${index + 1})`);
    }
    hubs.push(hub);
  }
  return {
    hubs,
    machineName: normalizeMachineNameSetting(value.machineName, filePath),
    source: 'file',
  };
}

/**
 * Returns the LANs this installation belongs to; none means plain local-only.
 * A present but malformed config throws: silently falling back to local-only
 * would strand writes the user expects to reach other devices.
 */
export function readLanHubSettings(options: LanHubSettingsLocation = {}): LanHubSettings {
  const env = options.env ?? process.env;
  const envUrl = env[LAN_HUB_URL_ENV]?.trim();
  const envToken = env[LAN_HUB_TOKEN_ENV]?.trim();
  if (envUrl || envToken) {
    return {
      hubs: [parseHub('from the environment', { url: envUrl, token: envToken }, LAN_HUB_DEFAULT_NAME)],
      machineName: null,
      source: 'environment',
    };
  }

  const filePath = options.filePath ?? getLanHubConfigPath();
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_SETTINGS;
    throw error;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    throw new Error(`LAN config ${filePath} is not valid JSON`, { cause: error });
  }
  return parseSettingsFile(filePath, decoded);
}

/**
 * Written atomically: the CLI and the desktop read this file without a lock,
 * and a half-written config would stop both from starting.
 */
export function writeLanHubSettings(
  settings: Pick<LanHubSettings, 'hubs' | 'machineName'>,
  options: LanHubSettingsLocation = {}
): string {
  const env = options.env ?? process.env;
  if (env[LAN_HUB_URL_ENV]?.trim() || env[LAN_HUB_TOKEN_ENV]?.trim()) {
    throw new Error(
      `LANs are set by ${LAN_HUB_URL_ENV} and ${LAN_HUB_TOKEN_ENV}; unset them to manage LANs here`
    );
  }
  const filePath = options.filePath ?? getLanHubConfigPath();
  const document = {
    version: LAN_HUB_CONFIG_VERSION,
    ...(settings.machineName ? { machineName: settings.machineName } : {}),
    hubs: settings.hubs.map((hub) => ({ name: hub.name, url: hub.url, token: hub.token })),
  };
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
  return filePath;
}

/** Slugs depend on the other LANs, so they are resolved for the whole list. */
export function summarizeLanHubs(hubs: readonly LanHub[]): LanHubSummary[] {
  const taken = new Set<string>();
  return hubs.map((hub) => {
    const slug = resolveLanHubSlug(hub, taken);
    taken.add(slug);
    return {
      id: hub.id,
      name: hub.name,
      url: hub.url,
      slug,
      workspaceId: getLanHubWorkspaceId(hub.id),
      userId: deriveLanHubUserId(hub.token),
    };
  });
}

/**
 * Finds one LAN by what a person would type: its name, its slug, its id or an
 * unambiguous start of its id.
 */
export function findLanHub(hubs: readonly LanHub[], selector: string): LanHub | null {
  const wanted = selector.trim();
  if (!wanted) return null;
  const lowered = wanted.toLowerCase();
  const summaries = summarizeLanHubs(hubs);
  const exact = hubs.find(
    (hub, index) =>
      hub.id === lowered ||
      hub.name.toLowerCase() === lowered ||
      summaries[index]!.slug === lowered ||
      summaries[index]!.workspaceId === wanted
  );
  if (exact) return exact;
  if (lowered.length < 4) return null;
  const byPrefix = hubs.filter((hub) => hub.id.startsWith(lowered));
  return byPrefix.length === 1 ? byPrefix[0]! : null;
}

function requireHub(hubs: readonly LanHub[], selector: string): LanHub {
  const hub = findLanHub(hubs, selector);
  if (!hub) throw new LanHubInputError('unknown_hub', `No LAN matches ${JSON.stringify(selector)}`);
  return hub;
}

function assertNameIsFree(hubs: readonly LanHub[], name: string, exceptId?: string): void {
  const lowered = name.toLowerCase();
  if (hubs.some((hub) => hub.id !== exceptId && hub.name.toLowerCase() === lowered)) {
    throw new LanHubInputError('duplicate_name', `Another LAN is already called ${name}`);
  }
}

function nextDefaultName(hubs: readonly LanHub[]): string {
  const names = new Set(hubs.map((hub) => hub.name.toLowerCase()));
  if (!names.has(LAN_HUB_DEFAULT_NAME.toLowerCase())) return LAN_HUB_DEFAULT_NAME;
  for (let index = 2; ; index += 1) {
    const candidate = `${LAN_HUB_DEFAULT_NAME} ${index}`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Joins a LAN. Joining one this installation already belongs to updates its
 * address (and its name when one is given) instead of adding a second entry:
 * the credential is what identifies a LAN.
 */
export function addLanHub(
  hubs: readonly LanHub[],
  input: { url: string; token: string; name?: string | null }
): { hubs: LanHub[]; hub: LanHub; created: boolean } {
  const token = normalizeLanHubToken(input.token);
  const url = normalizeLanHubUrl(input.url);
  const id = deriveLanHubId(token);
  const requestedName = input.name?.trim() ? normalizeLanHubName(input.name) : null;
  const existing = hubs.find((hub) => hub.id === id);
  if (existing) {
    if (requestedName) assertNameIsFree(hubs, requestedName, id);
    const hub: LanHub = { ...existing, url, name: requestedName ?? existing.name };
    return { hubs: hubs.map((entry) => (entry.id === id ? hub : entry)), hub, created: false };
  }
  if (requestedName) assertNameIsFree(hubs, requestedName);
  const hub: LanHub = { id, name: requestedName ?? nextDefaultName(hubs), url, token };
  return { hubs: [...hubs, hub], hub, created: true };
}

export function updateLanHub(
  hubs: readonly LanHub[],
  selector: string,
  patch: { name?: string | null; url?: string | null }
): { hubs: LanHub[]; hub: LanHub } {
  const current = requireHub(hubs, selector);
  const name = patch.name?.trim() ? normalizeLanHubName(patch.name) : current.name;
  const url = patch.url?.trim() ? normalizeLanHubUrl(patch.url) : current.url;
  assertNameIsFree(hubs, name, current.id);
  const hub: LanHub = { ...current, name, url };
  return { hubs: hubs.map((entry) => (entry.id === current.id ? hub : entry)), hub };
}

export function removeLanHub(
  hubs: readonly LanHub[],
  selector: string
): { hubs: LanHub[]; hub: LanHub } {
  const hub = requireHub(hubs, selector);
  return { hubs: hubs.filter((entry) => entry.id !== hub.id), hub };
}

export type LanHubReachability = 'reachable' | 'unauthorized' | 'unreachable';

/** Asks a hub whether it accepts this credential, without changing anything. */
export async function probeLanHub(
  hub: Pick<LanHub, 'url' | 'token' | 'id'>,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {}
): Promise<LanHubReachability> {
  const request = options.fetch ?? fetch;
  try {
    const response = await request(
      `${hub.url}/ds/lody/${encodeURIComponent(`${getLanHubWorkspaceId(hub.id)}:meta`)}`,
      {
        method: 'HEAD',
        headers: { Authorization: `Bearer ${hub.token}` },
        signal: AbortSignal.timeout(options.timeoutMs ?? 3_000),
      }
    );
    if (response.status === 401 || response.status === 403) return 'unauthorized';
    // A hub that never saw this workspace answers 404, which is an answer.
    return response.status < 500 ? 'reachable' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

export function normalizeMachineNameInput(input: string | null | undefined): string | null {
  return normalizeMachineNameSetting(input ?? null, 'input');
}

/**
 * The name this machine registers under. An explicit name wins; otherwise the
 * host name without the domain of the network the machine happens to be on.
 */
export function resolveMachineName(options: {
  override?: string | null;
  settings?: Pick<LanHubSettings, 'machineName'> | null;
  hostname?: string;
}): { name: string; explicit: boolean } {
  const explicit = options.override?.trim() || options.settings?.machineName?.trim() || '';
  if (explicit) return { name: explicit, explicit: true };
  const hostname = options.hostname ?? os.hostname();
  return { name: normalizeMachineName(hostname) || hostname, explicit: false };
}

export type LanHubChange =
  /** Nothing a running process has to act on. */
  | { kind: 'none' }
  /** LANs were added, removed or renamed; their workspaces can follow live. */
  | { kind: 'workspaces' }
  /**
   * The process has to start again: it switches between local-only and LAN
   * operation, a LAN moved to another address, or this machine was renamed.
   */
  | { kind: 'restart'; reason: string };

/** What a running process has to do to follow a settings change. */
export function classifyLanHubChange(
  previous: Pick<LanHubSettings, 'hubs' | 'machineName'>,
  next: Pick<LanHubSettings, 'hubs' | 'machineName'>
): LanHubChange {
  if ((previous.hubs.length === 0) !== (next.hubs.length === 0)) {
    return {
      kind: 'restart',
      reason: next.hubs.length === 0 ? 'the last LAN was removed' : 'the first LAN was added',
    };
  }
  // A process acts as the user of its first LAN wherever no workspace says
  // otherwise, and it cannot change who it is while it runs.
  if (previous.hubs[0]?.id !== next.hubs[0]?.id) {
    return { kind: 'restart', reason: 'the first LAN of this machine changed' };
  }
  if ((previous.machineName ?? null) !== (next.machineName ?? null)) {
    return { kind: 'restart', reason: 'this machine was renamed' };
  }
  for (const hub of next.hubs) {
    const before = previous.hubs.find((entry) => entry.id === hub.id);
    if (before && before.url !== hub.url) {
      return { kind: 'restart', reason: `${hub.name} moved to another address` };
    }
  }
  const before = summarizeLanHubs(previous.hubs);
  const after = summarizeLanHubs(next.hubs);
  const unchanged =
    before.length === after.length &&
    before.every((hub, index) => {
      const other = after[index]!;
      return hub.id === other.id && hub.name === other.name && hub.slug === other.slug;
    });
  return unchanged ? { kind: 'none' } : { kind: 'workspaces' };
}

export type LanHubSettingsWatcher = { close(): void };

/**
 * Reports every settings change to a running process. The directory is
 * watched rather than the file, because a change replaces the file; bursts of
 * events coalesce into one read.
 */
export function watchLanHubSettings(options: {
  filePath?: string;
  env?: NodeJS.ProcessEnv;
  onChange: (settings: LanHubSettings) => void;
  onError: (error: unknown) => void;
  watchDirectory?: (
    directory: string,
    onEvent: (filename: string | Buffer | null) => void
  ) => { close(): void };
  debounceMs?: number;
}): LanHubSettingsWatcher {
  const filePath = options.filePath ?? getLanHubConfigPath();
  const directory = path.dirname(filePath);
  const basename = path.basename(filePath);
  const watchDirectory =
    options.watchDirectory ??
    ((target, onEvent) => fs.watch(target, (_event, filename) => onEvent(filename)));
  let timer: NodeJS.Timeout | null = null;
  let closed = false;

  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const watcher = watchDirectory(directory, (filename) => {
    if (closed) return;
    // Some platforms report no name; read then, rather than miss a change.
    if (filename && filename.toString() !== basename) return;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (closed) return;
      try {
        options.onChange(readLanHubSettings({ env: options.env, filePath }));
      } catch (error) {
        options.onError(error);
      }
    }, options.debounceMs ?? 100);
    timer.unref?.();
  });

  return {
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      watcher.close();
    },
  };
}
