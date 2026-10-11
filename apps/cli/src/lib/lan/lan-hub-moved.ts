// What a member does for the world outside Lody once it follows a LAN's hub to
// another address. A tunnel, a reverse proxy or a monitor that names the hub
// may live on any machine, so every member runs the hook of its own data
// directory; and the machine that hosts the hub now tells the phones, which
// keep the address they were given.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import {
  LAN_HUB_TOKEN_ENV,
  LAN_HUB_URL_ENV,
  summarizeLanHubs,
  type LanHub,
} from '@lody/shared/node/lan-hub';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import { LAN_PUSH_EVENTS_PATH, type LanPushEvent } from './lan-push-protocol';

const HOOK_TIMEOUT_MS = 60_000;
const HOOK_OUTPUT_MAX_BYTES = 2048;
const HOOK_OUTPUT_GRACE_MS = 1_000;
const REPORT_TIMEOUT_MS = 8_000;

export type LanHubMove = {
  hub: LanHub;
  previousUrl: string;
  /** The term this machine follows the hub in; a move by hand starts none. */
  term: number;
  /** Whether this machine hosts the hub now. */
  hosting: boolean;
};

/** An executable file here runs after every move; without one nothing happens. */
export function getLanHubMovedHookPath(dataDir: string = getLodyDataDir()): string {
  return path.join(dataDir, 'hooks', 'lan-hub-moved');
}

/**
 * What the hook is told. The names stay clear of `LODY_LAN_HUB_URL`, which
 * would make a `lody` the hook runs read its LANs from the environment, and
 * the credential is not among them: the hook asks `lody lan` for what needs it.
 */
export function lanHubMovedHookEnvironment(
  move: LanHubMove,
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const { [LAN_HUB_URL_ENV]: _url, [LAN_HUB_TOKEN_ENV]: _token, ...inherited } = env;
  return {
    ...inherited,
    LODY_HOOK_EVENT: 'lan-hub-moved',
    LODY_HOOK_LAN_ID: move.hub.id,
    LODY_HOOK_LAN_NAME: move.hub.name,
    LODY_HOOK_HUB_URL: move.hub.url,
    LODY_HOOK_HUB_PREVIOUS_URL: move.previousUrl,
    LODY_HOOK_HUB_TERM: String(move.term),
    LODY_HOOK_HUB_HOSTED_HERE: move.hosting ? 'true' : 'false',
  };
}

/**
 * Runs this machine's hook for one move and waits for it to end. It is not
 * run again: a hook that sets things to where the hub is now needs no second
 * run, and the next move brings one.
 */
export async function runLanHubMovedHook(
  move: LanHubMove,
  options: {
    logger: Logger;
    hookPath?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    outputGraceMs?: number;
    platform?: NodeJS.Platform;
  }
): Promise<'absent' | 'ok' | 'failed'> {
  const hookPath = options.hookPath ?? getLanHubMovedHookPath();
  // Windows runs no file by its mode; a hook there would need a launcher of its own.
  if ((options.platform ?? process.platform) === 'win32' || !fs.existsSync(hookPath)) {
    return 'absent';
  }
  const timeoutMs = options.timeoutMs ?? HOOK_TIMEOUT_MS;
  const startedAt = Date.now();
  let output = Buffer.alloc(0);
  const keep = (chunk: Buffer) => {
    output = Buffer.concat([output, chunk]).subarray(-HOOK_OUTPUT_MAX_BYTES);
  };
  let outcome: string;
  try {
    outcome = await new Promise<string>((resolve, reject) => {
      // A group of its own: what the hook started is stopped with it.
      const child = spawn(hookPath, [], {
        cwd: path.dirname(hookPath),
        env: lanHubMovedHookEnvironment(move, options.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      let stopped = false;
      const timer = setTimeout(() => {
        stopped = true;
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      }, timeoutMs);
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        const ended = stopped
          ? `was stopped after ${timeoutMs} ms`
          : code === 0
            ? ''
            : `exited with ${code ?? signal}`;
        // What the hook left running may hold its output open; that is not waited for.
        const settle = () => {
          child.stdout.destroy();
          child.stderr.destroy();
          resolve(ended);
        };
        child.once('close', settle);
        setTimeout(settle, options.outputGraceMs ?? HOOK_OUTPUT_GRACE_MS).unref();
      });
    });
  } catch (error) {
    outcome = `could not start: ${formatErrorMessage(error)}`;
  }
  const said = output.toString('utf8').trim();
  if (outcome) {
    options.logger.warn(
      `[lan] ${hookPath} ${outcome} for ${move.hub.name} at ${move.hub.url}${said ? `: ${said}` : ''}`
    );
    return 'failed';
  }
  options.logger.info(
    `[lan] ${hookPath} ran for ${move.hub.name} at ${move.hub.url} in ${Date.now() - startedAt} ms.`
  );
  return 'ok';
}

/**
 * Has the hub this machine now hosts alert the phones of its LAN. Whether the
 * hub took the report; one without push answers 404.
 */
export async function reportLanHubMoved(
  move: LanHubMove,
  options: {
    machineId: string;
    machineName: string | null;
    logger: Logger;
    fetch?: typeof fetch;
  }
): Promise<boolean> {
  const { hub } = move;
  const summary = summarizeLanHubs([hub])[0];
  if (!summary) return false;
  const event: LanPushEvent = {
    type: 'hub-moved',
    machineId: options.machineId,
    machineName: options.machineName,
    workspaceId: summary.workspaceId,
    workspaceSlug: summary.slug,
    userId: summary.userId,
    lanName: hub.name,
    url: hub.url,
    term: move.term,
  };
  try {
    const response = await (options.fetch ?? fetch)(`${hub.url}${LAN_PUSH_EVENTS_PATH}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${hub.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      redirect: 'error',
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
    if (!response.ok) options.logger.debug(`[lan-push] hub-moved answered ${response.status}`);
    return response.ok;
  } catch (error) {
    options.logger.debug(`[lan-push] hub-moved not delivered: ${formatErrorMessage(error)}`);
    return false;
  }
}
