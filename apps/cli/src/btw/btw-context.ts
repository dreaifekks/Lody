import {
  buildReplayPromptFromHistory,
  redactSensitiveTokens,
  type SessionBtwArticleContext,
  type SessionBtwPriorTurn,
  type SessionHistoryInput,
} from '@lody/shared';
import type { SessionBackend } from '@/session/session-backend';

export const BTW_MAIN_HISTORY_MAX_ROUNDS = 8;
export const BTW_MAIN_HISTORY_MAX_CHARS = 16_000;
export const BTW_MAIN_HISTORY_TERMINAL_TAIL_CHARS = 512;

export type BtwHistoryReader = Pick<SessionBackend, 'readHistory'> &
  Partial<Pick<SessionBackend, 'readHistorySelection'>>;

/**
 * Selects indices of the most recent `maxRounds` user/assistant rounds (ignoring
 * system entries), capped at `maxRounds * 2` entries to keep replay compact.
 */
export function selectRecentMainHistoryPositions(
  rows: readonly { readonly role?: unknown }[],
  maxRounds: number = BTW_MAIN_HISTORY_MAX_ROUNDS
): number[] {
  const maxEntries = Math.max(1, maxRounds) * 2;
  const positions: number[] = [];
  let userRounds = 0;

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row || (row.role !== 'user' && row.role !== 'assistant')) continue;
    positions.push(index);
    if (row.role === 'user') {
      userRounds += 1;
      if (userRounds >= maxRounds) break;
    }
    if (positions.length >= maxEntries) break;
  }

  positions.reverse();
  return positions;
}

export async function readRecentMainHistoryEntries(
  backend: BtwHistoryReader,
  maxRounds: number = BTW_MAIN_HISTORY_MAX_ROUNDS
): Promise<SessionHistoryInput[]> {
  if (backend.readHistorySelection) {
    return await backend.readHistorySelection((rows) =>
      selectRecentMainHistoryPositions(rows, maxRounds)
    );
  }
  const all = await backend.readHistory();
  const positions = selectRecentMainHistoryPositions(all, maxRounds);
  return positions.map((index) => all[index]!);
}

const stripThinkingItems = (entries: readonly SessionHistoryInput[]): SessionHistoryInput[] =>
  entries.map((entry) => ({
    ...entry,
    items: entry.items?.filter((item) => item.type !== 'thought'),
  }));

export function formatMainConversationTail(entries: readonly SessionHistoryInput[]): string {
  if (entries.length === 0) return '';
  const withoutThinking = stripThinkingItems(entries);
  const replay = buildReplayPromptFromHistory({
    history: withoutThinking,
    maxChars: BTW_MAIN_HISTORY_MAX_CHARS,
    terminalTailChars: BTW_MAIN_HISTORY_TERMINAL_TAIL_CHARS,
  });
  if (replay.stats.messagesIncluded === 0) {
    return '';
  }
  return redactSensitiveTokens(replay.promptText).trim();
}

export function formatArticleContextBlock(
  article: SessionBtwArticleContext,
  options?: { readonly selectionOnly?: boolean }
): string {
  const lines: string[] = [
    options?.selectionOnly
      ? '=== Updated Article Selection ==='
      : '=== Current Article Context ===',
    `Path: ${article.path}`,
  ];
  const selection = article.selection?.trim();
  if (selection) {
    lines.push('<article_selection>', selection, '</article_selection>');
  }
  if (!options?.selectionOnly) {
    const excerpt = article.excerpt?.trim();
    if (excerpt) {
      const attr = article.truncated ? ' truncated="true"' : '';
      lines.push(`<article_excerpt${attr}>`, excerpt, '</article_excerpt>');
    }
  }
  return lines.join('\n');
}

export function formatPriorBtwTurns(priorTurns: readonly SessionBtwPriorTurn[]): string {
  const parts: string[] = [];
  for (const turn of priorTurns) {
    const text = turn.text.trim();
    if (!text) continue;
    parts.push(`${turn.role === 'user' ? '[User]' : '[Assistant]'}\n${text}`);
  }
  if (parts.length === 0) return '';
  return ['=== Prior /btw Conversation ===', parts.join('\n\n')].join('\n');
}

export function buildBtwInitialPrompt(input: {
  readonly question: string;
  readonly mainHistoryText?: string;
  readonly articleContext?: SessionBtwArticleContext;
  readonly readOnlyTools: boolean;
  readonly priorTurns?: readonly SessionBtwPriorTurn[];
}): string {
  const instructions = input.readOnlyTools
    ? [
        'You are answering a lightweight side-question (/btw) alongside an ongoing main conversation.',
        'Read-only repository inspection is enabled; do not modify files or execute commands.',
        'Answer concisely and directly based on the provided context and any needed read-only inspection, matching the language of the question.',
      ].join('\n')
    : [
        'You are answering a lightweight side-question (/btw) alongside an ongoing main conversation.',
        'You are in lightweight text-only mode with no repository file or terminal tools enabled.',
        'Answer concisely and directly based on the main conversation context and any attached Article context, matching the language of the question.',
        'If answering accurately requires inspecting other files in the repository not shown below, briefly tell the user they can click「开启只读查代码」to grant read-only repository access.',
      ].join('\n');

  const sections: string[] = [instructions];

  const mainHistory = input.mainHistoryText?.trim();
  if (mainHistory) {
    sections.push(mainHistory);
  }

  if (input.articleContext) {
    sections.push(formatArticleContextBlock(input.articleContext));
  }

  if (input.priorTurns && input.priorTurns.length > 0) {
    const prior = formatPriorBtwTurns(input.priorTurns);
    if (prior) {
      sections.push(prior);
    }
  }

  sections.push(`<btw_question>\n${input.question.trim()}\n</btw_question>`);
  return sections.join('\n\n');
}

export function buildBtwFollowUpPrompt(input: {
  readonly question: string;
  readonly articleContext?: SessionBtwArticleContext;
  readonly previousArticleContext?: SessionBtwArticleContext;
}): string {
  const trimmedQuestion = input.question.trim();
  const next = input.articleContext;
  const prev = input.previousArticleContext;

  if (!next) {
    return trimmedQuestion;
  }

  if (!prev || next.path !== prev.path) {
    return `${formatArticleContextBlock(next)}\n\n${trimmedQuestion}`;
  }

  const nextSelection = next.selection?.trim() ?? '';
  const prevSelection = prev.selection?.trim() ?? '';
  if (nextSelection && nextSelection !== prevSelection) {
    return `${formatArticleContextBlock(next, { selectionOnly: true })}\n\n${trimmedQuestion}`;
  }

  return trimmedQuestion;
}
