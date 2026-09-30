import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildHistoryReplayImport,
  sanitizeLodyInternalInstructions,
  type AcpSessionNotification,
  type AgentConfigCliType,
  type AgentType,
  type SessionHistoryInput,
} from '@lody/shared';
import type { SessionData, SessionHistoryReader } from '@lody/shared/session-data';

// # Catching up with turns written outside Lody
//
// A Lody session drives one native agent session, and that native session can
// also be continued elsewhere (`claude --resume`, Remote Control, `codex
// resume`). The agent keeps those turns in its own transcript; Lody's history
// only holds what passed through its ACP connection. Two moments close the gap:
//
// - Restore: `session/load` replays the whole native history. The replay is cut
//   after the native turn id Lody recorded last (`acpTurnId`, which both builtin
//   adapters emit live and during replay); what follows is new.
// - Reuse: a live Lody process never rereads its transcript, so a turn written
//   meanwhile would be forked away. The session GC compares the tail of the
//   transcript with the recorded id and reclaims an idle process on a mismatch,
//   so the next turn takes the restore path. A turn sent before that sweep
//   still runs on the stale process.

export type NativeCatchUpAnchor = {
  /** Native turn id of the last Lody assistant turn that recorded one. */
  readonly turnId: string;
  /**
   * Prompts of later Lody user turns that recorded no native id. Some may have
   * reached the agent (a turn cancelled before its first reply), so replayed
   * turns carrying the same prompt are Lody's own and are skipped.
   */
  readonly laterUserPrompts: readonly string[];
};

export type ExternalReplaySuffix =
  | { readonly status: 'none' }
  | { readonly status: 'unaligned' }
  | { readonly status: 'found'; readonly notifications: readonly AcpSessionNotification[] };

const turnIdOf = (notification: AcpSessionNotification): string | undefined => {
  const lody = (notification.update._meta as Record<string, unknown> | null | undefined)?.lody;
  if (!lody || typeof lody !== 'object') return undefined;
  const turnId = (lody as Record<string, unknown>).turnId;
  return typeof turnId === 'string' && turnId.length > 0 ? turnId : undefined;
};

const userTextOf = (turn: {
  readonly items?: readonly unknown[];
  readonly inputConfig?: unknown;
}): string => {
  const texts: string[] = [];
  for (const item of turn.items ?? []) {
    if (
      item &&
      typeof item === 'object' &&
      (item as { type?: unknown }).type === 'text' &&
      typeof (item as { text?: unknown }).text === 'string'
    ) {
      texts.push((item as { text: string }).text);
    }
  }
  if (texts.length > 0) return texts.join('');
  const prompt = (turn.inputConfig as { prompt?: unknown } | undefined)?.prompt;
  return typeof prompt === 'string' ? prompt : '';
};

const normalizePrompt = (text: string): string =>
  sanitizeLodyInternalInstructions(text).replace(/\s+/g, ' ').trim();

const MIN_PREFIX_MATCH_CHARS = 16;

/** The agent may receive a prompt with attachments or instructions appended. */
const isSamePrompt = (replayed: string, recorded: string): boolean => {
  if (!replayed || !recorded) return false;
  if (replayed === recorded) return true;
  return (
    Math.min(replayed.length, recorded.length) >= MIN_PREFIX_MATCH_CHARS &&
    (replayed.startsWith(recorded) || recorded.startsWith(replayed))
  );
};

/**
 * Finds the catch-up anchor among the turns stored before `beforeTurnId` (the
 * turn about to run, or the end of history when it is absent).
 */
export async function readCatchUpAnchor(
  history: SessionHistoryReader,
  beforeTurnId: string | undefined
): Promise<NativeCatchUpAnchor | undefined> {
  const rows = await history.readDirectory(0, await history.count());
  let end = rows.length;
  if (beforeTurnId) {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (rows[index]?.turnId === beforeTurnId) {
        end = index;
        break;
      }
    }
  }

  const laterUserTurnIds: string[] = [];
  for (let index = end - 1; index >= 0; index -= 1) {
    const scalars = rows[index]?.scalars;
    if (!scalars) continue;
    if (scalars.role === 'assistant' && scalars.acpTurnId) {
      const laterUserPrompts: string[] = [];
      for (const turnId of laterUserTurnIds.reverse()) {
        const read = await history.readTurn(turnId);
        if (read.state !== 'ready') continue;
        const prompt = normalizePrompt(userTextOf(read.turn));
        if (prompt) laterUserPrompts.push(prompt);
      }
      return { turnId: scalars.acpTurnId, laterUserPrompts };
    }
    if (scalars.role === 'user') laterUserTurnIds.push(scalars.id);
  }
  return undefined;
}

/** Cuts a native replay after the anchor turn, at the next user message. */
export function selectExternalReplaySuffix(args: {
  replay: readonly AcpSessionNotification[];
  acpSessionId: string;
  anchorTurnId: string;
}): ExternalReplaySuffix {
  // A replay also addresses the child sessions of native subagents.
  const own = args.replay.filter((notification) => notification.sessionId === args.acpSessionId);
  let anchorIndex = -1;
  own.forEach((notification, index) => {
    if (turnIdOf(notification) === args.anchorTurnId) anchorIndex = index;
  });
  if (anchorIndex < 0) return { status: 'unaligned' };
  const start = own.findIndex(
    (notification, index) =>
      index > anchorIndex && notification.update.sessionUpdate === 'user_message_chunk'
  );
  if (start < 0) return { status: 'none' };
  return { status: 'found', notifications: own.slice(start) };
}

/**
 * Converts replayed turns into settled history rows. User rows are `handled`,
 * so dispatch never sends them to the agent again.
 */
export function buildExternalTurns(args: {
  notifications: readonly AcpSessionNotification[];
  acpSessionId: string;
  cliType: AgentConfigCliType;
  agentType: AgentType;
  userId?: string;
  laterUserPrompts: readonly string[];
}): { turns: SessionHistoryInput[]; skippedOwnTurns: number; droppedNotifications: number } {
  const { history, droppedNotifications } = buildHistoryReplayImport([...args.notifications], {
    acpSessionId: args.acpSessionId,
    provider: { cliType: args.cliType, agentType: args.agentType },
    userId: args.userId,
    mode: 'imported_snapshot',
    splitUserMessagesById: true,
    createId: () => `native:${args.acpSessionId}:${randomUUID()}`,
  });

  const groups: SessionHistoryInput[][] = [];
  for (const entry of history) {
    const current = groups[groups.length - 1];
    if (entry.role === 'user' || !current) groups.push([entry]);
    else current.push(entry);
  }

  const pending = [...args.laterUserPrompts];
  let skippedOwnTurns = 0;
  while (groups.length > 0 && pending.length > 0) {
    const first = groups[0]?.[0];
    if (!first || first.role !== 'user') break;
    const replayed = normalizePrompt(userTextOf(first));
    const matched = pending.findIndex((recorded) => isSamePrompt(replayed, recorded));
    if (matched < 0) break;
    pending.splice(0, matched + 1);
    groups.shift();
    skippedOwnTurns += 1;
  }

  return { turns: groups.flat(), skippedOwnTurns, droppedNotifications };
}

export type NativeCatchUpResult =
  | { readonly status: 'no-anchor' | 'target-missing' | 'unaligned' | 'none' }
  | {
      readonly status: 'added';
      readonly added: number;
      readonly skippedOwnTurns: number;
      readonly droppedNotifications: number;
    };

/**
 * Writes the turns found after the anchor in a `session/load` replay before
 * `beforeTurnId`, the turn about to run. Writes nothing unless the anchor is
 * in the replay and that turn is already in local history.
 */
export async function catchUpNativeTurns(args: {
  sessionData: SessionData;
  acpSessionId: string;
  cliType: AgentConfigCliType;
  agentType: AgentType;
  userId?: string;
  beforeTurnId: string;
  replay: readonly AcpSessionNotification[];
}): Promise<NativeCatchUpResult> {
  const { history, commands } = args.sessionData;
  const anchor = await readCatchUpAnchor(history, args.beforeTurnId);
  if (!anchor) return { status: 'no-anchor' };
  if ((await history.readTurn(args.beforeTurnId)).state !== 'ready') {
    return { status: 'target-missing' };
  }
  const suffix = selectExternalReplaySuffix({
    replay: args.replay,
    acpSessionId: args.acpSessionId,
    anchorTurnId: anchor.turnId,
  });
  if (suffix.status !== 'found') return { status: suffix.status };

  const { turns, skippedOwnTurns, droppedNotifications } = buildExternalTurns({
    notifications: suffix.notifications,
    acpSessionId: args.acpSessionId,
    cliType: args.cliType,
    agentType: args.agentType,
    userId: args.userId,
    laterUserPrompts: anchor.laterUserPrompts,
  });
  if (turns.length === 0) return { status: 'none' };
  for (const turn of turns) {
    await commands.applyHistoryAction({
      kind: 'upsert-turn',
      turn,
      beforeTurnId: args.beforeTurnId,
    });
  }
  return { status: 'added', added: turns.length, skippedOwnTurns, droppedNotifications };
}

// ── Transcript tails ────────────────────────────────────────────────────────

const TAIL_BYTES = 512 * 1024;
/** A missing transcript is searched for again only after this long. */
const MISSING_TRANSCRIPT_RETRY_MS = 10 * 60 * 1000;
const transcriptPaths = new Map<string, string>();
const missingTranscripts = new Map<string, number>();

/** Looks a transcript up once, then remembers where it is or that it is missing. */
async function findTranscript(
  key: string,
  search: () => Promise<string | undefined>
): Promise<string | undefined> {
  const cached = transcriptPaths.get(key);
  if (cached && (await isFile(cached))) return cached;
  const missingSince = missingTranscripts.get(key);
  if (missingSince !== undefined && Date.now() - missingSince < MISSING_TRANSCRIPT_RETRY_MS) {
    return undefined;
  }
  const found = await search();
  if (found) {
    transcriptPaths.set(key, found);
    missingTranscripts.delete(key);
  } else {
    missingTranscripts.set(key, Date.now());
  }
  return found;
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

async function readTailLines(file: string): Promise<string[]> {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    // A read that starts mid-file begins with a partial line.
    if (start > 0) lines.shift();
    return lines;
  } finally {
    await handle.close();
  }
}

function parseLine(line: string): Record<string, unknown> | undefined {
  if (!line.trim()) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function findClaudeTranscript(
  acpSessionId: string,
  env: NodeJS.ProcessEnv
): Promise<string | undefined> {
  const projects = path.join(
    env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    'projects'
  );
  return await findTranscript(`claude:${projects}:${acpSessionId}`, async () => {
    let dirs: string[];
    try {
      dirs = await fs.readdir(projects);
    } catch {
      return undefined;
    }
    for (const dir of dirs) {
      const candidate = path.join(projects, dir, `${acpSessionId}.jsonl`);
      if (await isFile(candidate)) return candidate;
    }
    return undefined;
  });
}

async function findCodexRollout(
  threadId: string,
  env: NodeJS.ProcessEnv
): Promise<string | undefined> {
  const root = path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  const suffix = `-${threadId}.jsonl`;
  const listDirs = async (dir: string): Promise<string[]> => {
    try {
      return (await fs.readdir(dir)).sort().reverse();
    } catch {
      return [];
    }
  };
  return await findTranscript(`codex:${root}:${threadId}`, async () => {
    // sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl, newest day first.
    for (const year of await listDirs(root)) {
      for (const month of await listDirs(path.join(root, year))) {
        for (const day of await listDirs(path.join(root, year, month))) {
          const dayDir = path.join(root, year, month, day);
          const match = (await listDirs(dayDir)).find((name) => name.endsWith(suffix));
          if (match) return path.join(dayDir, match);
        }
      }
    }
    return undefined;
  });
}

/**
 * The native id of the newest turn in a transcript, in the form the adapter
 * reports as `acpTurnId`: Claude's last top-level assistant message uuid, or
 * Codex's last started turn id. `undefined` when it cannot be determined.
 */
export async function readNativeTranscriptTailTurnId(args: {
  agentType: AgentType;
  acpSessionId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const env = args.env ?? process.env;
  if (args.agentType === 'claude') {
    const file = await findClaudeTranscript(args.acpSessionId, env);
    if (!file) return undefined;
    const lines = await readTailLines(file);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const entry = parseLine(lines[index] ?? '');
      if (
        entry?.type === 'assistant' &&
        entry.isSidechain !== true &&
        typeof entry.uuid === 'string'
      ) {
        return entry.uuid;
      }
    }
    return undefined;
  }
  if (args.agentType === 'codex') {
    const file = await findCodexRollout(args.acpSessionId, env);
    if (!file) return undefined;
    const lines = await readTailLines(file);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const entry = parseLine(lines[index] ?? '');
      const payload = entry?.payload as Record<string, unknown> | undefined;
      if (
        entry?.type === 'event_msg' &&
        payload?.type === 'task_started' &&
        typeof payload.turn_id === 'string'
      ) {
        return payload.turn_id;
      }
    }
    return undefined;
  }
  return undefined;
}
