import type { MessageContent, SessionHistory, SessionMeta } from '@lody/shared';
import { buildAssistantMessageRenderItems } from '@/components/ai-gui/assistant-message-render-items';
import type { AssistantActivityRenderItem } from '@/components/ai-gui/assistant-turn-render-blocks';
import {
  findActiveNonBackgroundTool,
  summarizeCompactTools,
} from '@/components/ai-gui/compact-native-directory';
import { findContinuableInterruption } from '../session-continue';
import type { SessionStatusStripState } from '../session-status-strip';

export type MainConversationStatusKind = 'waiting' | 'working' | 'error' | 'done' | 'idle';

export type MainConversationStatus = {
  readonly kind: MainConversationStatusKind;
  readonly tooltip: string;
};

export type DeriveMainConversationStatusInput = {
  readonly hasPendingPermission?: boolean;
  readonly hasPendingQuestion?: boolean;
  readonly isWorking?: boolean;
  readonly agentActivityLabel?: string | null;
  readonly history?: readonly SessionHistory[] | null;
  readonly statusStripState?: SessionStatusStripState | null;
  readonly queuedCount?: number;
  readonly hasUnreadMainReply?: boolean;
  readonly completedWhileInBtw?: boolean;
  readonly sessionStatusType?: NonNullable<SessionMeta['status']>['type'];
};

function extractLatestAssistantActivityEntries(
  history: readonly SessionHistory[] | null | undefined
): AssistantActivityRenderItem[] {
  if (!history || history.length === 0) return [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (!entry) continue;
    if (entry.role === 'user') return [];
    if (entry.role === 'assistant') {
      const items = (entry.items ?? []) as readonly MessageContent[];
      const renderItems = buildAssistantMessageRenderItems(items);
      return renderItems.filter(
        (item): item is AssistantActivityRenderItem =>
          item.content.type === 'tool_call' || item.content.type === 'thought'
      );
    }
  }
  return [];
}

function hasTrailingChatFailure(history: readonly SessionHistory[] | null | undefined): boolean {
  if (!history || history.length === 0) return false;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (!entry) continue;
    if (entry.role === 'user') return false;
    for (const item of entry.items ?? []) {
      if (item && item.type === 'system_notice' && item.name === 'chat_failed') {
        return true;
      }
    }
  }
  return false;
}

/**
 * Pure status derivation for the main conversation icon shown in `SessionInfoBar`
 * while `/btw` is expanded. Priority: `waiting > working > error > done > idle`.
 */
export function deriveMainConversationStatus(
  input: DeriveMainConversationStatusInput
): MainConversationStatus {
  const {
    hasPendingPermission = false,
    hasPendingQuestion = false,
    isWorking = false,
    agentActivityLabel,
    history,
    statusStripState,
    queuedCount = 0,
    hasUnreadMainReply = false,
    completedWhileInBtw = false,
  } = input;

  // 1. Waiting on human approval or answer
  if (hasPendingPermission) {
    return { kind: 'waiting', tooltip: '返回主对话 · 等待审批' };
  }
  if (hasPendingQuestion) {
    return { kind: 'waiting', tooltip: '返回主对话 · 等待回答' };
  }

  // 2. Working (active foreground tool / thinking / dispatching)
  if (isWorking) {
    const entries = extractLatestAssistantActivityEntries(history);
    const activeTool = findActiveNonBackgroundTool(entries);
    const summary = summarizeCompactTools(entries);
    const completedTools =
      summary.readFileCount +
      summary.editFileCount +
      summary.searchCount +
      summary.commandCount +
      summary.fetchCount +
      summary.otherCount;

    if (activeTool) {
      const toolLabel =
        activeTool.shortTarget ||
        activeTool.entry.content.title?.trim() ||
        activeTool.entry.content.kind ||
        'tool';
      const countSuffix = completedTools > 0 ? ` (${completedTools + 1})` : '';
      return {
        kind: 'working',
        tooltip: `返回主对话 · Running ${toolLabel}${countSuffix}`,
      };
    }

    const trimmedLabel = agentActivityLabel?.trim();
    if (trimmedLabel) {
      return {
        kind: 'working',
        tooltip: `返回主对话 · ${trimmedLabel}`,
      };
    }

    return { kind: 'working', tooltip: '返回主对话 · 运行中' };
  }

  // 3. Error / interruption / unreachable host
  const interruption = findContinuableInterruption(history);
  if (interruption === 'disconnected') {
    return { kind: 'error', tooltip: '返回主对话 · 连接中断' };
  }
  if (interruption === 'restart') {
    return { kind: 'error', tooltip: '返回主对话 · 服务重启中断' };
  }
  if (interruption === 'stopped') {
    return { kind: 'error', tooltip: '返回主对话 · 已中断' };
  }
  if (hasTrailingChatFailure(history)) {
    return { kind: 'error', tooltip: '返回主对话 · 运行出错' };
  }
  if (statusStripState?.kind === 'machine-removed') {
    return { kind: 'error', tooltip: '返回主对话 · 机器已移除' };
  }
  if (statusStripState?.kind === 'browser-offline') {
    return { kind: 'error', tooltip: '返回主对话 · 网络离线' };
  }
  if (statusStripState?.kind === 'machine-offline') {
    const machineDetail = statusStripState.machineName
      ? `${statusStripState.machineName} 离线`
      : '机器离线';
    return { kind: 'error', tooltip: `返回主对话 · ${machineDetail}` };
  }

  // 4. Done / new reply in main conversation
  if (hasUnreadMainReply || completedWhileInBtw) {
    return { kind: 'done', tooltip: '返回主对话 · 已完成' };
  }

  // 5. Idle
  if (queuedCount > 0) {
    return { kind: 'idle', tooltip: `返回主对话 · 排队中 (${queuedCount})` };
  }
  return { kind: 'idle', tooltip: '返回主对话' };
}
