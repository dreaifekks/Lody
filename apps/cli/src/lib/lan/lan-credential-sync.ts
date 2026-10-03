// Keeps this member's copy of the credentials of each LAN it belongs to. The
// copy uses the hub's own file layout, so the readers of a hub's data directory
// read it unchanged: the GitHub token port while the hub is away, the push
// fallback, and a standby that takes the hub over.
import fs from 'node:fs';
import path from 'node:path';
import {
  getLanCredentialsDirectory,
  getLanCredentialsRoot,
  isLanCredentialsDirectoryName,
  LAN_CREDENTIALS_REVISION_FILE_NAME,
  LAN_HUB_CREDENTIALS_PATH,
} from '@lody/shared/node/lan-credentials';
import type { LanHub } from '@lody/shared/node/lan-hub';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import { APNS_CONFIG_FILE_NAME, APNS_KEY_FILE_NAME } from './apns';
import { LanHubCredentialsSchema, type LanHubCredentials } from './hub-credentials';
import { LAN_GITHUB_CONFIG_FILE_NAME } from './hub-github';
import { LAN_PUSH_DEVICES_FILE_NAME } from './hub-push';

/** Credentials change rarely; phones re-register on their own schedule. */
const SYNC_INTERVAL_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

function writePrivate(directory: string, name: string, content: string): void {
  const target = path.join(directory, name);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

function removeIfPresent(directory: string, name: string): void {
  fs.rmSync(path.join(directory, name), { force: true });
}

/** Writes a copy as the hub keeps its files; the revision goes last. */
export function writeLanCredentialsCopy(directory: string, credentials: LanHubCredentials): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  if (credentials.github) {
    writePrivate(
      directory,
      LAN_GITHUB_CONFIG_FILE_NAME,
      `${JSON.stringify(credentials.github, null, 2)}\n`
    );
  } else {
    removeIfPresent(directory, LAN_GITHUB_CONFIG_FILE_NAME);
  }
  if (credentials.apns) {
    writePrivate(directory, APNS_KEY_FILE_NAME, credentials.apns.privateKey);
    writePrivate(
      directory,
      APNS_CONFIG_FILE_NAME,
      `${JSON.stringify({ keyId: credentials.apns.keyId, teamId: credentials.apns.teamId }, null, 2)}\n`
    );
  } else {
    removeIfPresent(directory, APNS_CONFIG_FILE_NAME);
    removeIfPresent(directory, APNS_KEY_FILE_NAME);
  }
  writePrivate(
    directory,
    LAN_PUSH_DEVICES_FILE_NAME,
    JSON.stringify({ devices: credentials.devices })
  );
  writePrivate(directory, LAN_CREDENTIALS_REVISION_FILE_NAME, credentials.revision);
}

/**
 * Gives a hub that starts from a standby's copy what the copy lacks and this
 * machine's copy of the credentials holds, such as a token set after the
 * standby last pulled. What the hub already has stays. Returns what was added.
 */
export function fillMissingLanHubCredentials(hubDataDir: string, copyDirectory: string): string[] {
  const groups = [
    [LAN_GITHUB_CONFIG_FILE_NAME],
    [APNS_CONFIG_FILE_NAME, APNS_KEY_FILE_NAME],
    [LAN_PUSH_DEVICES_FILE_NAME],
  ];
  const added: string[] = [];
  for (const names of groups) {
    const missing = names.every((name) => !fs.existsSync(path.join(hubDataDir, name)));
    const held = names.every((name) => fs.existsSync(path.join(copyDirectory, name)));
    if (!missing || !held) continue;
    for (const name of names) {
      fs.copyFileSync(path.join(copyDirectory, name), path.join(hubDataDir, name));
      fs.chmodSync(path.join(hubDataDir, name), 0o600);
      added.push(name);
    }
  }
  return added;
}

export function readLanCredentialsRevision(directory: string): string | null {
  try {
    return fs.readFileSync(path.join(directory, LAN_CREDENTIALS_REVISION_FILE_NAME), 'utf8');
  } catch {
    return null;
  }
}

export type LanCredentialSync = {
  start(): void;
  close(): void;
  /** Copies from every hub that answers; one that does not keeps its last copy. */
  syncNow(): Promise<void>;
};

export function createLanCredentialSync(options: {
  /** Read at each round, so a LAN joined, left or moved is followed. */
  hubs: () => readonly LanHub[];
  logger: Logger;
  dataDir?: string;
  fetch?: typeof fetch;
  intervalMs?: number;
}): LanCredentialSync {
  const request = options.fetch ?? fetch;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;

  const syncHub = async (hub: LanHub): Promise<void> => {
    const directory = getLanCredentialsDirectory(hub.id, options.dataDir);
    let response: Response;
    try {
      response = await request(`${hub.url}${LAN_HUB_CREDENTIALS_PATH}`, {
        headers: { Authorization: `Bearer ${hub.token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      options.logger.debug(
        `[lan-credentials] ${hub.name} is away; keeping the copy: ${formatErrorMessage(error)}`
      );
      return;
    }
    // A hub of an earlier build has no such route; the copy stays as it was.
    if (!response.ok) {
      options.logger.debug(`[lan-credentials] ${hub.name} answered ${response.status}`);
      return;
    }
    const parsed = LanHubCredentialsSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      options.logger.warn(`[lan-credentials] ${hub.name} answered something else`);
      return;
    }
    if (readLanCredentialsRevision(directory) === parsed.data.revision) return;
    writeLanCredentialsCopy(directory, parsed.data);
    options.logger.info(`[lan-credentials] Copied the credentials of ${hub.name}.`);
  };

  /** A LAN this machine left takes its credentials with it. */
  const forgetLeft = (hubs: readonly LanHub[]) => {
    const root = getLanCredentialsRoot(options.dataDir);
    let names: string[];
    try {
      names = fs.readdirSync(root);
    } catch {
      return;
    }
    const kept = new Set(hubs.map((hub) => hub.id));
    for (const name of names) {
      if (isLanCredentialsDirectoryName(name) && !kept.has(name)) {
        fs.rmSync(path.join(root, name), { recursive: true, force: true });
      }
    }
  };

  const syncOnce = async () => {
    const hubs = options.hubs();
    forgetLeft(hubs);
    await Promise.all(
      hubs.map((hub) =>
        syncHub(hub).catch((error: unknown) =>
          options.logger.warn(
            `[lan-credentials] Copying from ${hub.name} failed: ${formatErrorMessage(error)}`
          )
        )
      )
    );
  };

  const syncNow = () => {
    running ??= syncOnce().finally(() => {
      running = null;
    });
    return running;
  };

  return {
    start: () => {
      if (timer) return;
      void syncNow();
      timer = setInterval(() => void syncNow(), options.intervalMs ?? SYNC_INTERVAL_MS);
      timer.unref?.();
    },
    close: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
    syncNow,
  };
}
