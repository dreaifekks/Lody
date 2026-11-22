import { describe, expect, it } from 'vitest';
import type { SessionHistory } from '@lody/shared';
import { deriveMainConversationStatus } from '../src/components/sessions/btw/main-conversation-status';

const makeToolTurn = (items: SessionHistory['items']): SessionHistory =>
  ({
    id: 'assistant-1',
    role: 'assistant',
    timestamp: '2026-11-22T00:00:00.000Z',
    items,
  }) as SessionHistory;

describe('deriveMainConversationStatus', () => {
  it('prioritizes waiting (permission/question) over working, error, and done', () => {
    expect(
      deriveMainConversationStatus({
        hasPendingPermission: true,
        isWorking: true,
        statusStripState: { kind: 'machine-removed' },
        hasUnreadMainReply: true,
      })
    ).toEqual({
      kind: 'waiting',
      tooltip: '返回主对话 · 等待审批',
    });

    expect(
      deriveMainConversationStatus({
        hasPendingQuestion: true,
        isWorking: true,
      })
    ).toEqual({
      kind: 'waiting',
      tooltip: '返回主对话 · 等待回答',
    });
  });

  it('derives active foreground tool and completed count while working', () => {
    const history: SessionHistory[] = [
      makeToolTurn([
        {
          type: 'tool_call',
          toolCallId: 'tc-1',
          kind: 'read',
          title: 'Read design.md',
          status: 'completed',
          locations: [{ path: 'design.md' }],
        },
        {
          type: 'tool_call',
          toolCallId: 'tc-bg',
          kind: 'execute',
          title: 'Run watcher',
          status: 'in_progress',
          backgroundTaskId: 'bg-1',
        },
        {
          type: 'tool_call',
          toolCallId: 'tc-2',
          kind: 'read',
          title: 'read_file',
          status: 'in_progress',
          locations: [{ path: 'packages/shared/src/btw.ts' }],
        },
      ]),
    ];

    const result = deriveMainConversationStatus({
      isWorking: true,
      agentActivityLabel: 'Thinking',
      history,
    });
    expect(result.kind).toBe('working');
    expect(result.tooltip).toContain('返回主对话 · Running');
    expect(result.tooltip).toContain('btw.ts');
    expect(result.tooltip).toContain('(2)');
  });

  it('falls back to agentActivityLabel and generic running copy when no foreground tool is active', () => {
    expect(
      deriveMainConversationStatus({
        isWorking: true,
        agentActivityLabel: 'Thinking',
      })
    ).toEqual({
      kind: 'working',
      tooltip: '返回主对话 · Thinking',
    });

    expect(deriveMainConversationStatus({ isWorking: true })).toEqual({
      kind: 'working',
      tooltip: '返回主对话 · 运行中',
    });
  });

  it('maps continuable interruptions, trailing failures, and offline/removed status strip to error', () => {
    const disconnectedHistory: SessionHistory[] = [
      makeToolTurn([
        {
          type: 'system_notice',
          name: 'chat_failed',
          text: 'Agent disconnected',
          meta: { reason: 'agent_disconnected' },
        },
      ]),
    ];
    expect(deriveMainConversationStatus({ history: disconnectedHistory })).toEqual({
      kind: 'error',
      tooltip: '返回主对话 · 连接中断',
    });

    const restartHistory: SessionHistory[] = [
      makeToolTurn([
        {
          type: 'system_notice',
          name: 'chat_failed',
          text: 'Restarted',
          meta: { reason: 'daemon_restart' },
        },
      ]),
    ];
    expect(deriveMainConversationStatus({ history: restartHistory })).toEqual({
      kind: 'error',
      tooltip: '返回主对话 · 服务重启中断',
    });

    const genericFailureHistory: SessionHistory[] = [
      makeToolTurn([
        {
          type: 'system_notice',
          name: 'chat_failed',
          text: 'Quota exceeded',
          meta: { reason: 'provider_error' },
        },
      ]),
    ];
    expect(deriveMainConversationStatus({ history: genericFailureHistory })).toEqual({
      kind: 'error',
      tooltip: '返回主对话 · 运行出错',
    });

    expect(
      deriveMainConversationStatus({
        statusStripState: { kind: 'machine-offline', machineName: 'devNuc' },
      })
    ).toEqual({
      kind: 'error',
      tooltip: '返回主对话 · devNuc 离线',
    });
  });

  it('distinguishes done from idle and surfaces queued count when idle', () => {
    expect(deriveMainConversationStatus({ completedWhileInBtw: true })).toEqual({
      kind: 'done',
      tooltip: '返回主对话 · 已完成',
    });
    expect(deriveMainConversationStatus({ hasUnreadMainReply: true })).toEqual({
      kind: 'done',
      tooltip: '返回主对话 · 已完成',
    });
    expect(deriveMainConversationStatus({ queuedCount: 2 })).toEqual({
      kind: 'idle',
      tooltip: '返回主对话 · 排队中 (2)',
    });
    expect(deriveMainConversationStatus({})).toEqual({
      kind: 'idle',
      tooltip: '返回主对话',
    });
  });
});
