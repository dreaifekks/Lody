import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { LoroRepo } from 'loro-repo';
import {
  parseSessionNotification,
  type AcpSessionNotification,
  type SessionHistoryInput,
  type SessionId,
} from '@lody/shared';
import { readSessionHistory } from '@lody/shared/session-data';

import {
  catchUpNativeTurns,
  readNativeTranscriptTailTurnId,
} from '../src/session/native-session-catch-up';
import { SessionDocument } from '../src/lib/loro/doc';
import type { Logger } from '../src/utils/logger';

const acpSessionId = 'native-session';
const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const logger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
  setLevel: () => {},
  child: () => logger,
  close: async () => {},
};

async function createSessionDoc(history: SessionHistoryInput[]): Promise<SessionDocument> {
  const repo = await LoroRepo.create({});
  disposers.push(() => repo.destroy());
  const doc = new SessionDocument(repo, 'catch-up-session' as SessionId, undefined, logger);
  await doc.initOffline({ history });
  return doc;
}

const userTurn = (id: string, text: string, status: 'handled' | 'pending' = 'handled') =>
  ({
    id,
    role: 'user',
    timestamp: '2026-09-30T00:00:00.000Z',
    status,
    read: true,
    fileDiff: [],
    items: [{ type: 'text', text }],
    inputConfig: { prompt: text, cliType: 'builtin', agentType: 'claude' },
  }) as SessionHistoryInput;

const assistantTurn = (id: string, text: string, acpTurnId?: string) =>
  ({
    id,
    role: 'assistant',
    timestamp: '2026-09-30T00:00:00.000Z',
    finished: true,
    fileDiff: [],
    items: [{ type: 'text', text }],
    ...(acpTurnId ? { acpTurnId } : {}),
  }) as SessionHistoryInput;

/** A turn as the Claude adapter replays it: prompt, answer, then the turn id. */
function replayedTurn(
  prompt: string,
  answer: string,
  turnId: string,
  sessionId = acpSessionId
): AcpSessionNotification[] {
  return [
    {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: prompt },
      messageId: `user-${turnId}`,
    },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer } },
    { sessionUpdate: 'session_info_update', _meta: { lody: { turnId } } },
  ].map((update) => parseSessionNotification({ sessionId, update }));
}

const texts = (history: readonly SessionHistoryInput[]) =>
  history.map((entry) => {
    const item = entry.items?.[0] as { text?: string } | undefined;
    return `${entry.role}:${item?.text ?? ''}`;
  });

describe('catchUpNativeTurns', () => {
  it('adds the turns written after the recorded turn before the turn about to run', async () => {
    const doc = await createSessionDoc([
      userTurn('u1', 'first prompt'),
      assistantTurn('a1', 'first answer', 'native-1'),
      userTurn('u2', 'next prompt', 'pending'),
    ]);

    const result = await catchUpNativeTurns({
      sessionData: doc.sessionData,
      acpSessionId,
      cliType: 'builtin',
      agentType: 'claude',
      userId: 'user',
      beforeTurnId: 'u2',
      replay: [
        ...replayedTurn('first prompt', 'first answer', 'native-1'),
        ...replayedTurn('terminal prompt', 'terminal answer', 'native-2'),
        // A native subagent's child session is replayed alongside.
        ...replayedTurn('child prompt', 'child answer', 'child-1', 'child-session'),
      ],
    });

    expect(result).toMatchObject({ status: 'added', added: 2 });
    const history = readSessionHistory(doc.sessionData.history);
    expect(texts(history)).toEqual([
      'user:first prompt',
      'assistant:first answer',
      'user:terminal prompt',
      'assistant:terminal answer',
      'user:next prompt',
    ]);
    const added = history[2]!;
    expect(added.status).toBe('handled');
    expect(history[3]!.acpTurnId).toBe('native-2');

    // The next load replays the same history; nothing is added twice.
    const again = await catchUpNativeTurns({
      sessionData: doc.sessionData,
      acpSessionId,
      cliType: 'builtin',
      agentType: 'claude',
      beforeTurnId: 'u2',
      replay: [
        ...replayedTurn('first prompt', 'first answer', 'native-1'),
        ...replayedTurn('terminal prompt', 'terminal answer', 'native-2'),
      ],
    });
    expect(again).toEqual({ status: 'none' });
    expect(readSessionHistory(doc.sessionData.history)).toHaveLength(5);
  });

  it('skips a Lody turn that reached the agent without recording a turn id', async () => {
    const doc = await createSessionDoc([
      userTurn('u1', 'first prompt'),
      assistantTurn('a1', 'first answer', 'native-1'),
      userTurn('u2', 'stopped before any answer'),
      assistantTurn('a2', ''),
      userTurn('u3', 'next prompt', 'pending'),
    ]);

    const result = await catchUpNativeTurns({
      sessionData: doc.sessionData,
      acpSessionId,
      cliType: 'builtin',
      agentType: 'claude',
      beforeTurnId: 'u3',
      replay: [
        ...replayedTurn('first prompt', 'first answer', 'native-1'),
        parseSessionNotification({
          sessionId: acpSessionId,
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'stopped before any answer' },
            messageId: 'user-stopped',
          },
        }),
        ...replayedTurn('terminal prompt', 'terminal answer', 'native-3'),
      ],
    });

    expect(result).toMatchObject({ status: 'added', added: 2, skippedOwnTurns: 1 });
    expect(texts(readSessionHistory(doc.sessionData.history)).slice(-3)).toEqual([
      'user:terminal prompt',
      'assistant:terminal answer',
      'user:next prompt',
    ]);
  });

  it('writes nothing when the recorded turn is not in the replay', async () => {
    const doc = await createSessionDoc([
      userTurn('u1', 'first prompt'),
      assistantTurn('a1', 'first answer', 'native-1'),
      userTurn('u2', 'next prompt', 'pending'),
    ]);

    const result = await catchUpNativeTurns({
      sessionData: doc.sessionData,
      acpSessionId,
      cliType: 'builtin',
      agentType: 'claude',
      beforeTurnId: 'u2',
      replay: replayedTurn('rewritten prompt', 'rewritten answer', 'native-x'),
    });

    expect(result).toEqual({ status: 'unaligned' });
    expect(readSessionHistory(doc.sessionData.history)).toHaveLength(3);
  });
});

describe('readNativeTranscriptTailTurnId', () => {
  it('reads the last top-level Claude assistant message and the last Codex turn', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-native-tail-'));
    disposers.push(() => fs.rm(root, { recursive: true, force: true }));
    const jsonl = (entries: unknown[]) => entries.map((entry) => JSON.stringify(entry)).join('\n');

    const claudeDir = path.join(root, 'claude', 'projects', '-synthetic-project');
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeDir, 'claude-session.jsonl'),
      jsonl([
        { type: 'user', uuid: 'u-1' },
        { type: 'assistant', uuid: 'a-1', isSidechain: false },
        { type: 'assistant', uuid: 'side-1', isSidechain: true },
        { type: 'user', uuid: 'u-2' },
        { type: 'ai-title' },
      ]) + '\n'
    );

    const codexDir = path.join(root, 'codex', 'sessions', '2026', '09', '30');
    await fs.mkdir(codexDir, { recursive: true });
    await fs.writeFile(
      path.join(codexDir, 'rollout-2026-09-30T00-00-00-codex-thread.jsonl'),
      jsonl([
        { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
        { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
        { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-2' } },
      ])
    );

    const env = {
      CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      CODEX_HOME: path.join(root, 'codex'),
    };
    await expect(
      readNativeTranscriptTailTurnId({ agentType: 'claude', acpSessionId: 'claude-session', env })
    ).resolves.toBe('a-1');
    await expect(
      readNativeTranscriptTailTurnId({ agentType: 'codex', acpSessionId: 'codex-thread', env })
    ).resolves.toBe('turn-2');
    await expect(
      readNativeTranscriptTailTurnId({ agentType: 'claude', acpSessionId: 'missing', env })
    ).resolves.toBeUndefined();
  });
});
