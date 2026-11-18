#!/usr/bin/env node
// Lists the Codex threads of this machine whose Lody Session is archived while
// Codex still lists the thread as active; `--apply` archives them in Codex.
//
//   node scripts/codex-archive-backfill.mjs [--apply] [--json] [--machine-id <id>] [--codex <path>]
//
// The daemon archives a Session's Codex thread when the Session is archived and
// unarchives it on restore; Sessions archived before that stay active in Codex.
// Lody is read through the `lody-lan` command line (`LODY_CLI` overrides it),
// Codex through `codex app-server` in the Codex home that binary uses
// (`CODEX_HOME`, else ~/.codex). `codex unarchive <thread id>` undoes one archive.
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs, promisify } from 'node:util';

const { values: options } = parseArgs({
  options: {
    apply: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    'machine-id': { type: 'string' },
    codex: { type: 'string' },
  },
});
const dataDir = process.env.LODY_DATA_DIR ?? path.join(os.homedir(), '.lody-oss');
const machineId =
  options['machine-id'] ?? readFileSync(path.join(dataDir, 'machine-id'), 'utf8').trim();
const managedCodex = path.join(dataDir, 'bin', 'codex');
const codexBin = options.codex ?? (existsSync(managedCodex) ? managedCodex : 'codex');

const lody = async (...args) => {
  const { stdout } = await promisify(execFile)(
    process.env.LODY_CLI ?? 'lody-lan',
    [...args, '--json'],
    { maxBuffer: 256 * 1024 * 1024 }
  );
  return JSON.parse(stdout);
};

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function startAppServer() {
  const child = spawn(codexBin, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const pending = new Map();
  let lastId = 0;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    const waiter = message.method === undefined ? pending.get(message.id) : undefined;
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  child.on('exit', (code) => {
    for (const waiter of pending.values()) {
      waiter.reject(new Error(`codex app-server exited with ${code}`));
    }
    pending.clear();
  });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  return {
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const id = ++lastId;
        pending.set(id, { resolve, reject });
        send({ id, method, params });
      }),
    notify: (method) => send({ method }),
    close: () => child.kill(),
  };
}

const { sessions } = await lody('session', 'list', '--archived', '--machine-id', machineId);
const { items: configs } = await lody('agent-config', 'list');
const codexConfigIds = new Set(
  configs
    .filter((c) => c.machineId === machineId && c.cliType === 'builtin' && c.agentType === 'codex')
    .map((c) => c.id)
);
// `session list` names only the Provider; a Session without one shows its agent in `session show`.
const details = await mapLimit(
  sessions.filter((s) => !s.agentConfigId || codexConfigIds.has(s.agentConfigId)),
  6,
  async (s) => (await lody('session', 'show', s.id)).session
);
const threads = new Map();
for (const s of details) {
  // `show` is the later read: a Session restored since `list` is skipped here.
  if (s.isArchived !== true || s.cliType !== 'builtin' || s.agentType !== 'codex') continue;
  const threadId = s.acpSessionId ?? s.externalHistory?.sourceAcpSessionId;
  if (threadId) threads.set(threadId, { sessionId: s.id, threadId, title: s.title ?? '' });
}

const server = startAppServer();
try {
  const { codexHome } = await server.request('initialize', {
    clientInfo: { name: 'lody-codex-archive-backfill', version: '1.0.0' },
  });
  server.notify('initialized');
  const listThreadIds = async (archived) => {
    const ids = new Set();
    let cursor = null;
    do {
      const page = await server.request('thread/list', {
        archived,
        cursor,
        limit: 200,
        modelProviders: [],
        useStateDbOnly: true,
      });
      for (const thread of page.data) ids.add(thread.id);
      cursor = page.nextCursor;
    } while (cursor);
    return ids;
  };
  const active = await listThreadIds(false);
  const archivedInCodex = await listThreadIds(true);
  const all = [...threads.values()];
  const toArchive = all.filter((t) => active.has(t.threadId));
  const missing = all.filter((t) => !active.has(t.threadId) && !archivedInCodex.has(t.threadId));
  const results = [];
  if (options.apply) {
    for (const t of toArchive) {
      try {
        // A Session restored while this runs keeps its thread active.
        if ((await lody('session', 'show', t.sessionId)).session.isArchived !== true) {
          results.push({ ...t, archived: false, skipped: 'restored in Lody' });
          continue;
        }
        await server.request('thread/archive', { threadId: t.threadId });
        results.push({ ...t, archived: true });
      } catch (error) {
        results.push({ ...t, archived: false, error: error.message });
      }
    }
  }

  const summary = {
    machineId,
    codexHome,
    archivedLodySessions: sessions.length,
    codexThreads: all.length,
    alreadyArchivedInCodex: all.length - toArchive.length - missing.length,
    notFoundInCodex: missing,
    toArchive,
    ...(options.apply ? { results } : {}),
  };
  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Machine ${machineId}, Codex home ${codexHome} (${codexBin})`);
    console.log(`Archived Lody Sessions: ${sessions.length}; with a Codex thread: ${all.length}`);
    console.log(`  already archived in Codex: ${summary.alreadyArchivedInCodex}`);
    console.log(`  not found in Codex: ${missing.length}`);
    console.log(`  still active in Codex: ${toArchive.length}`);
    for (const t of options.apply ? results : toArchive) {
      const outcome = !options.apply
        ? ''
        : t.archived
          ? 'archived '
          : t.skipped
            ? `skipped (${t.skipped}) `
            : `FAILED ${t.error} `;
      console.log(`  ${outcome}${t.sessionId} ${t.threadId} ${t.title}`);
    }
    if (!options.apply && toArchive.length > 0) {
      console.log(`Run again with --apply to archive these ${toArchive.length} threads in Codex.`);
    }
  }
} finally {
  server.close();
}
