#!/usr/bin/env node
// Starts a packaged Linux desktop the way a user does and waits for its main
// process to report a loaded window. The packaging probes run the binary as
// Node, which never enters the startup of the main process.
//
//   node scripts/smoke-electron-appimage.mjs apps/electron/dist/LodyOSS-*.AppImage
//
// Home, configuration and data are temporary, but the desktop still reaches for
// the fixed loopback port of the local agent service. On a machine with a real
// one, run this in a network namespace of its own (bwrap --unshare-net ...).

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const LOADED_LINE = 'main window finished load';
const FAILED_LINE = 'Desktop startup failed';
const START_TIMEOUT_MS = 180_000;
const STOP_TIMEOUT_MS = 15_000;
const STOP_POLL_MS = 100;
const LOG_TAIL_LINES = 80;
const ELECTRON_FLAGS = [
  '--no-sandbox',
  '--ozone-platform=headless',
  '--disable-gpu',
  '--enable-logging=stderr',
];

function extract(appImage, root) {
  const result = spawnSync(appImage, ['--appimage-extract'], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Could not extract ${appImage}: ${result.error?.message ?? result.stderr}`);
  }
  return path.join(root, 'squashfs-root', 'AppRun');
}

function temporaryEnvironment(root) {
  const dirs = {
    HOME: 'home',
    XDG_CONFIG_HOME: 'config',
    XDG_CACHE_HOME: 'cache',
    XDG_DATA_HOME: 'share',
    XDG_RUNTIME_DIR: 'run',
    LODY_DATA_DIR: 'data',
  };
  const env = { PATH: process.env.PATH, LANG: 'C.UTF-8' };
  for (const [name, dir] of Object.entries(dirs)) {
    env[name] = path.join(root, dir);
    mkdirSync(env[name]);
  }
  chmodSync(env.XDG_RUNTIME_DIR, 0o700);
  return env;
}

function signal(target, name) {
  try {
    process.kill(target, name);
    return true;
  } catch {
    return false;
  }
}

async function waitForGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (signal(-pid, 0)) {
    if (Date.now() >= deadline) return false;
    await delay(STOP_POLL_MS);
  }
  return true;
}

/** The application leads its group and shuts its children down when it gets SIGTERM. */
async function stopGroup(pid, stopTimeoutMs) {
  if (!signal(pid, 'SIGTERM')) signal(-pid, 'SIGTERM');
  if (await waitForGroupExit(pid, stopTimeoutMs)) return;
  signal(-pid, 'SIGKILL');
  await waitForGroupExit(pid, STOP_TIMEOUT_MS);
}

function run(appRun, env, cwd) {
  const child = spawn(appRun, ELECTRON_FLAGS, {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tail = [];
  const state = { loaded: false, failed: false };
  const outcome = Promise.withResolvers();

  const readLine = (line) => {
    tail.push(line);
    if (tail.length > LOG_TAIL_LINES) tail.shift();
    if (line.includes(FAILED_LINE)) {
      state.failed = true;
      outcome.resolve(`it logged "${FAILED_LINE}"`);
    } else if (line.includes(LOADED_LINE)) {
      state.loaded = true;
      outcome.resolve();
    }
  };
  for (const stream of [child.stdout, child.stderr]) {
    let partial = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      const lines = (partial + chunk).split('\n');
      partial = lines.pop();
      lines.forEach(readLine);
    });
  }
  child.once('error', (error) => outcome.resolve(`it could not start: ${error.message}`));
  child.once('exit', (code, signal) => {
    outcome.resolve(`it exited (${signal ?? code}) before the window loaded`);
  });

  const stop = async (stopTimeoutMs) => {
    if (child.pid !== undefined) await stopGroup(child.pid, stopTimeoutMs);
    child.stdout.destroy();
    child.stderr.destroy();
  };
  return { outcome: outcome.promise, state, tail, stop };
}

/** Resolves to the reason the application did not start, or undefined when it did. */
export async function smokeAppImage(
  appImage,
  { timeoutMs = START_TIMEOUT_MS, stopTimeoutMs = STOP_TIMEOUT_MS, log = console } = {}
) {
  const root = mkdtempSync(path.join(tmpdir(), 'lody-smoke-'));
  try {
    const appRun = extract(path.resolve(appImage), root);
    const app = run(appRun, temporaryEnvironment(root), root);
    let timer;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(
        () => resolve(`"${LOADED_LINE}" did not appear within ${timeoutMs / 1000} s`),
        timeoutMs
      );
    });
    const reason = await Promise.race([app.outcome, timedOut]);
    clearTimeout(timer);
    await app.stop(stopTimeoutMs);
    const failure = app.state.failed ? `it logged "${FAILED_LINE}"` : reason;
    if (failure) {
      log.error(`--- last lines of the application log ---\n${app.tail.join('\n')}\n---`);
      return failure;
    }
    return undefined;
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

if (process.argv[1] === import.meta.filename) {
  const [appImage, ...rest] = process.argv.slice(2);
  if (!appImage || rest.length > 0) {
    console.error('Usage: smoke-electron-appimage.mjs <file.AppImage>');
    process.exit(2);
  }
  const failure = await smokeAppImage(appImage);
  if (failure) {
    console.error(`The packaged application did not start: ${failure}.`);
    process.exit(1);
  }
  console.log(`The packaged application loaded its window ("${LOADED_LINE}").`);
}
