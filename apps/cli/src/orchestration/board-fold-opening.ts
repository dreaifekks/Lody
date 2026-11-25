import {
  estimateTokenCount,
  isBoardMaintenanceEntry,
  isBoardMaintenanceTurnId,
  readMessageAuthor,
  type BoardMeta,
  type SessionHistoryInput,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import type {
  BoardLineFoldNode,
  BoardLineNode,
  BoardLineSegmentNode,
  BoardLineTree,
} from '@/lib/board-line-store';

export const BOARD_FOLD_OPENING_MAX_TOKENS = 14_000;
/**
 * Minimum core budget retained for the rollover header, pinned anchor and expand
 * guide when the user's own `board.instructions` consume nearly all (or more than)
 * 14,000 tokens; user Board rules are never truncated.
 */
export const BOARD_FOLD_OPENING_MIN_CORE_BUDGET = 1_500;
export const BOARD_FOLD_HISTORY_BUDGET = 2_500;
export const BOARD_FOLD_RECENT_TREE_BUDGET = 4_000;
export const BOARD_FOLD_THREADS_BUDGET = 1_500;
export const BOARD_FOLD_VERBATIM_BUDGET = 4_000;
export const BOARD_FOLD_FOOTER_BUDGET = 500;
export const BOARD_FOLD_RECENT_FULL_SEGMENTS = 2;
export const BOARD_FOLD_RECENT_USER_COUNT = 4;
export const BOARD_FOLD_RECENT_QA_ROUNDS = 2;

const AGENT_SENDER_HEADER_PREFIX = '[Lody] This message was sent by another agent';

export type CoordinatorUserUtterance = {
  readonly turnId: string;
  readonly timestamp: string;
  readonly text: string;
};

export type CoordinatorQaExchange = {
  readonly userTurnId: string;
  readonly timestamp: string;
  readonly userText: string;
  readonly assistantText: string;
};

export type BuildBoardFoldOpeningInput = {
  readonly sessionId: SessionId;
  readonly board: Pick<BoardMeta, 'id' | 'name'>;
  readonly tree: BoardLineTree;
  readonly threads: readonly SessionMeta[];
  readonly recentUserMessages: readonly CoordinatorUserUtterance[];
  readonly recentExchanges: readonly CoordinatorQaExchange[];
  readonly nowIso: string;
  readonly lastSegmentEndedAtIso?: string;
  readonly usage?: SessionMeta['contextWindowUsage'];
  /**
   * Estimated tokens already reserved for appended Board instructions/reminders
   * (`renewBoardInstructions: true`). Deducted from the 14,000-token ceiling so
   * the combined rollover prompt stays within budget without truncating user rules.
   */
  readonly reservedTokens?: number;
};

/** Extract only visible plain text items (never thinking or tool output). */
export function extractVisibleTurnText(
  entry: Pick<SessionHistoryInput, 'items'> | undefined
): string {
  if (!entry?.items?.length) return '';
  return entry.items
    .flatMap((item) =>
      item.type === 'text' && item.text.trim().length > 0 ? [item.text.trim()] : []
    )
    .join('\n\n')
    .trim();
}

/**
 * True only for human-authored user turns. Rejects agent/system authors,
 * unrecognized future author shapes, and legacy unattributed turns carrying
 * Lody's cross-agent header prefix so inter-agent traffic is never mistaken for
 * human utterances.
 */
export function isHumanUserTurn(
  entry: Pick<SessionHistoryInput, 'role' | 'author' | 'items'>
): boolean {
  if (entry.role !== 'user') return false;
  if (entry.author !== undefined) {
    return readMessageAuthor(entry.author)?.kind === 'human';
  }
  return !extractVisibleTurnText(entry).startsWith(AGENT_SENDER_HEADER_PREFIX);
}

/**
 * Extract the coordinator's recent human user messages (last 4) and closing
 * complete human Q&A exchanges (last 2, visible text only) from Loro history.
 */
export function extractRecentCoordinatorContext(history: readonly SessionHistoryInput[]): {
  recentUserMessages: CoordinatorUserUtterance[];
  recentExchanges: CoordinatorQaExchange[];
} {
  const userEntries: SessionHistoryInput[] = [];
  const assistantTextByUserTurnId = new Map<string, string>();
  for (const entry of history) {
    if (isBoardMaintenanceTurnId(entry.id) || isBoardMaintenanceEntry(entry)) continue;
    if (isHumanUserTurn(entry)) {
      userEntries.push(entry);
    } else if (entry.role === 'assistant' && entry.userTurnId) {
      const text = extractVisibleTurnText(entry);
      if (text) assistantTextByUserTurnId.set(entry.userTurnId, text);
    }
  }

  const allUserUtterances: CoordinatorUserUtterance[] = [];
  const allExchanges: CoordinatorQaExchange[] = [];
  for (const entry of userEntries) {
    const text = extractVisibleTurnText(entry);
    if (!text) continue;
    allUserUtterances.push({
      turnId: entry.id,
      timestamp: entry.timestamp,
      text,
    });
    const assistantText = assistantTextByUserTurnId.get(entry.id);
    if (assistantText) {
      allExchanges.push({
        userTurnId: entry.id,
        timestamp: entry.timestamp,
        userText: text,
        assistantText,
      });
    }
  }

  return {
    recentUserMessages: allUserUtterances.slice(-BOARD_FOLD_RECENT_USER_COUNT),
    recentExchanges: allExchanges.slice(-BOARD_FOLD_RECENT_QA_ROUNDS),
  };
}

/**
 * Truncate `text` so `estimateTokenCount(result) <= maxTokens` using code-point
 * binary search (safe for CJK and surrogate pairs).
 */
export function truncateToTokenBudget(
  text: string,
  maxTokens: number,
  mode: 'tail' | 'head-tail' = 'tail'
): string {
  const normalized = text.trim();
  if (maxTokens <= 0 || !normalized) return '';
  if (estimateTokenCount(normalized) <= maxTokens) return normalized;
  const chars = Array.from(normalized);
  const ellipsis = mode === 'head-tail' ? '\n…\n' : '…';
  if (estimateTokenCount(ellipsis) >= maxTokens) return '';

  const compose = (kept: number): string => {
    if (kept <= 0) return '';
    if (mode === 'head-tail') {
      const head = Math.ceil(kept * 0.45);
      const tail = kept - head;
      return `${chars.slice(0, head).join('').trimEnd()}${ellipsis}${chars
        .slice(chars.length - tail)
        .join('')
        .trimStart()}`;
    }
    return `${chars.slice(0, kept).join('').trimEnd()}${ellipsis}`;
  };

  let low = 0;
  let high = chars.length;
  let best = '';
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = compose(mid);
    if (estimateTokenCount(candidate) <= maxTokens) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

const isoDate = (iso: string): string => (iso.length >= 10 ? iso.slice(0, 10) : iso);

const formatSegmentWindow = (fromIso: string, toIso: string): string => {
  const fromDate = fromIso.length >= 10 ? fromIso.slice(5, 10) : fromIso;
  const fromTime = fromIso.length >= 16 ? fromIso.slice(11, 16) : '';
  const toDate = toIso.length >= 10 ? toIso.slice(5, 10) : toIso;
  const toTime = toIso.length >= 16 ? toIso.slice(11, 16) : '';
  if (fromTime && toTime) {
    return fromDate === toDate
      ? `${fromDate} ${fromTime}~${toTime}`
      : `${fromDate} ${fromTime}~${toDate} ${toTime}`;
  }
  return fromDate === toDate ? fromDate : `${fromDate}~${toDate}`;
};

export function formatElapsedInterval(fromIso: string | undefined, toIso: string): string {
  if (!fromIso) return 'first rollover';
  const start = Date.parse(fromIso);
  const end = Date.parse(toIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'unknown';
  const diffMs = Math.max(0, end - start);
  const totalMinutes = Math.floor(diffMs / 60_000);
  if (totalMinutes < 1) return '< 1m';
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  const remMinutes = totalMinutes % 60;
  if (totalHours < 24) return remMinutes > 0 ? `${totalHours}h ${remMinutes}m` : `${totalHours}h`;
  const days = Math.floor(totalHours / 24);
  const remHours = totalHours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

const formatFoldHeader = (node: BoardLineFoldNode): string =>
  `[${node.meta.id} · ${isoDate(node.meta.coversFrom)} ~ ${isoDate(node.meta.coversTo)} · 覆盖 ${node.meta.coveredSegments} 段 / ${node.meta.coveredTurns} 轮]`;

const formatPinnedHeader = (node: BoardLineNode): string =>
  node.meta.kind === 'fold'
    ? `[PINNED] ${formatFoldHeader(node as BoardLineFoldNode)}`
    : `[PINNED] [${node.meta.id} · ${isoDate(node.meta.coversFrom)} ~ ${isoDate(node.meta.coversTo)} · ${node.meta.turnRange.turnCount} 轮]`;

const formatSegmentOneLine = (node: BoardLineSegmentNode): string => {
  const tags = node.meta.tags.length > 0 ? `[${node.meta.tags.join(', ')}]` : '[]';
  return `${node.meta.id} | ${formatSegmentWindow(node.meta.coversFrom, node.meta.coversTo)} | ${tags} | ${node.meta.title}`;
};

function buildFoldedHistorySection(tree: BoardLineTree, budget: number): string {
  const heading = '## Folded History';
  const pinnedNodes: BoardLineNode[] = [];
  const pinnedSet = new Set<string>();
  for (const pinId of tree.pins) {
    const node = tree.byId.get(pinId);
    if (!node) continue;
    pinnedNodes.push(node);
    pinnedSet.add(pinId);
  }
  const topFolds = tree.rootNodes.filter(
    (node): node is BoardLineFoldNode => node.meta.kind === 'fold' && !pinnedSet.has(node.meta.id)
  );
  if (topFolds.length === 0 && pinnedNodes.length === 0) return '';

  const headingTokens = estimateTokenCount(`${heading}\n`);
  let remaining = Math.max(0, budget - headingTokens);

  // Reserve budget for pinned nodes first so important pinned records are never dropped.
  const pinnedBlocks: string[] = [];
  if (pinnedNodes.length > 0 && remaining > 0) {
    const pinnedShare =
      topFolds.length > 0
        ? Math.min(remaining, Math.max(Math.floor(remaining * 0.45), 600))
        : remaining;
    const perPin = Math.max(40, Math.floor(pinnedShare / pinnedNodes.length));
    let pinnedUsed = 0;
    for (const node of pinnedNodes) {
      const header = formatPinnedHeader(node);
      const headerTok = estimateTokenCount(`${header} `);
      const summaryBudget = Math.max(20, perPin - headerTok - 2);
      const summary = truncateToTokenBudget(node.summary, summaryBudget, 'tail');
      const block = summary ? `${header} ${summary}` : header;
      const blockTok = estimateTokenCount(`${block}\n\n`);
      if (pinnedUsed + blockTok <= remaining) {
        pinnedBlocks.push(block);
        pinnedUsed += blockTok;
      } else {
        const tight = truncateToTokenBudget(block, Math.max(20, remaining - pinnedUsed), 'tail');
        if (tight) {
          pinnedBlocks.push(tight);
          pinnedUsed += estimateTokenCount(`${tight}\n\n`);
        }
      }
    }
    remaining = Math.max(0, remaining - pinnedUsed);
  }

  // Pack top-level folds newest-first so recent history takes priority, then emit chronologically.
  const keptFolds: string[] = [];
  const omittedIds: string[] = [];
  if (topFolds.length > 0 && remaining > 0) {
    const foldPerCap = Math.max(120, Math.floor(remaining / Math.min(topFolds.length, 4)));
    let used = 0;
    for (let index = topFolds.length - 1; index >= 0; index--) {
      const fold = topFolds[index]!;
      const header = formatFoldHeader(fold);
      const headerTok = estimateTokenCount(`${header} `);
      const avail = remaining - used;
      if (avail <= headerTok + 12) {
        omittedIds.unshift(fold.meta.id);
        continue;
      }
      const summaryBudget = Math.min(foldPerCap, avail - headerTok - 4);
      const summary = truncateToTokenBudget(fold.summary, summaryBudget, 'tail');
      const entry = summary ? `${header} ${summary}` : header;
      const entryTok = estimateTokenCount(`${entry}\n\n`);
      if (used + entryTok <= remaining) {
        keptFolds.unshift(entry);
        used += entryTok;
      } else {
        omittedIds.unshift(fold.meta.id);
      }
    }
  } else {
    for (const fold of topFolds) omittedIds.push(fold.meta.id);
  }

  const bodyParts: string[] = [];
  if (omittedIds.length > 0) {
    const note = `(Earlier folds omitted for budget: ${omittedIds.join(', ')} — expand with lody_board_line_expand.)`;
    if (estimateTokenCount([heading, note, ...keptFolds, ...pinnedBlocks].join('\n\n')) <= budget) {
      bodyParts.push(note);
    }
  }
  bodyParts.push(...keptFolds, ...pinnedBlocks);
  if (bodyParts.length === 0) return '';
  return truncateToTokenBudget(`${heading}\n${bodyParts.join('\n\n')}`, budget, 'tail');
}

function buildRecentTreeSection(tree: BoardLineTree, budget: number): string {
  const uncoveredSegments = tree.rootNodes.filter(
    (node): node is BoardLineSegmentNode => node.meta.kind === 'segment'
  );
  if (uncoveredSegments.length === 0) return '';

  const heading = '## Recent Segment Tree';
  const headingTok = estimateTokenCount(`${heading}\n`);
  const available = Math.max(0, budget - headingTok);
  const fullStart = Math.max(0, uncoveredSegments.length - BOARD_FOLD_RECENT_FULL_SEGMENTS);
  const earlier = uncoveredSegments.slice(0, fullStart);
  const recentFull = uncoveredSegments.slice(fullStart);

  // Reserve room for earlier one-liners if present, while guaranteeing the latest 2 get full summaries.
  const earlierLinesAll = earlier.map((node) => `- ${formatSegmentOneLine(node)}`);
  const earlierRawTokens = earlierLinesAll.length
    ? estimateTokenCount(`${earlierLinesAll.join('\n')}\n\n`)
    : 0;
  const earlierBudget = Math.min(earlierRawTokens, Math.floor(available * 0.3));
  const fullBudget = Math.max(200, available - earlierBudget);

  const perFull = Math.max(100, Math.floor(fullBudget / Math.max(1, recentFull.length)));
  const fullBlocks: string[] = [];
  let fullUsed = 0;
  for (let i = 0; i < recentFull.length; i++) {
    const seg = recentFull[i]!;
    const header = `### ${formatSegmentOneLine(seg)}`;
    const headerTok = estimateTokenCount(`${header}\n`);
    const remainingForThis = Math.max(
      40,
      Math.min(perFull, fullBudget - fullUsed - (recentFull.length - 1 - i) * 80)
    );
    const summaryBudget = Math.max(24, remainingForThis - headerTok - 4);
    const summary = truncateToTokenBudget(seg.summary, summaryBudget, 'tail');
    const block = summary ? `${header}\n${summary}` : header;
    fullBlocks.push(block);
    fullUsed += estimateTokenCount(`${block}\n\n`);
  }

  const remainingForEarlier = Math.max(0, available - fullUsed);
  const keptEarlier: string[] = [];
  let earlierUsed = 0;
  for (let i = earlierLinesAll.length - 1; i >= 0; i--) {
    const line = earlierLinesAll[i]!;
    const lineTok = estimateTokenCount(`${line}\n`);
    if (earlierUsed + lineTok > remainingForEarlier) break;
    keptEarlier.unshift(line);
    earlierUsed += lineTok;
  }

  const parts: string[] = [heading];
  if (keptEarlier.length > 0) parts.push(keptEarlier.join('\n'));
  if (fullBlocks.length > 0) parts.push(fullBlocks.join('\n\n'));
  return truncateToTokenBudget(parts.join('\n\n'), budget, 'tail');
}

function buildOpenThreadsSection(threads: readonly SessionMeta[], budget: number): string {
  const heading = '## Open Threads';
  if (threads.length === 0) {
    return `${heading}\nThis Board has no threads yet. (lody_board_overview has live status.)`;
  }
  const sorted = [...threads].sort(
    (a, b) =>
      Number(Boolean(a.isArchived)) - Number(Boolean(b.isArchived)) || a.id.localeCompare(b.id)
  );
  const intro = 'Threads of this Board (use lody_board_overview for live online status):';
  const baseTokens = estimateTokenCount(`${heading}\n${intro}\n`);
  const reserveFooter = 24;
  const maxBody = Math.max(0, budget - baseTokens - reserveFooter);
  const lines: string[] = [];
  let used = 0;
  for (const meta of sorted) {
    const title = meta.title?.trim() || '(untitled)';
    const line = `- ${title} — ${meta.id}${meta.isArchived ? ' (archived)' : ''}`;
    const tok = estimateTokenCount(`${line}\n`);
    if (used + tok > maxBody) break;
    lines.push(line);
    used += tok;
  }
  const omitted = sorted.length - lines.length;
  if (omitted > 0) lines.push(`- … ${omitted} more (call lody_board_overview)`);
  return truncateToTokenBudget(`${heading}\n${intro}\n${lines.join('\n')}`, budget, 'tail');
}

function buildRecentVerbatimSection(
  recentUserMessages: readonly CoordinatorUserUtterance[],
  recentExchanges: readonly CoordinatorQaExchange[],
  budget: number
): string {
  if (recentUserMessages.length === 0 && recentExchanges.length === 0) return '';
  const heading = '## Recent Verbatim Context';
  const headingTok = estimateTokenCount(`${heading}\n`);
  const available = Math.max(0, budget - headingTok);

  const userMessages = recentUserMessages.slice(-BOARD_FOLD_RECENT_USER_COUNT);
  const exchanges = recentExchanges.slice(-BOARD_FOLD_RECENT_QA_ROUNDS);

  const hasUsers = userMessages.length > 0;
  const hasExchanges = exchanges.length > 0;
  const userTarget = hasUsers ? (hasExchanges ? Math.floor(available * 0.42) : available) : 0;

  let userSection = '';
  let userUsed = 0;
  if (hasUsers && userTarget > 40) {
    const sub = '### Recent User Messages';
    const subTok = estimateTokenCount(`${sub}\n`);
    const perMsg = Math.max(40, Math.floor((userTarget - subTok) / userMessages.length));
    const lines = userMessages.map((msg, idx) => {
      const prefix = `${idx + 1}. [${msg.timestamp}] `;
      const body = truncateToTokenBudget(
        msg.text,
        Math.max(20, perMsg - estimateTokenCount(prefix) - 2),
        'head-tail'
      );
      return `${prefix}${body}`;
    });
    userSection = truncateToTokenBudget(`${sub}\n${lines.join('\n')}`, userTarget, 'tail');
    userUsed = estimateTokenCount(`${userSection}\n\n`);
  }

  let exchangeSection = '';
  const exchangeBudget = Math.max(0, available - userUsed);
  if (hasExchanges && exchangeBudget > 60) {
    const sub = '### Previous Segment Closing Q&A';
    const subTok = estimateTokenCount(`${sub}\n`);
    const perRound = Math.max(60, Math.floor((exchangeBudget - subTok) / exchanges.length));
    const blocks = exchanges.map((pair, idx) => {
      const roundHeader = `#### Round ${idx + 1} (${pair.timestamp})`;
      const headerTok = estimateTokenCount(`${roundHeader}\nUser: \nAssistant: \n`);
      const bodyBudget = Math.max(30, perRound - headerTok - 4);
      const userShare = Math.max(15, Math.floor(bodyBudget * 0.35));
      const assistantShare = Math.max(15, bodyBudget - userShare);
      const userBody = truncateToTokenBudget(pair.userText, userShare, 'head-tail');
      const assistantBody = truncateToTokenBudget(pair.assistantText, assistantShare, 'head-tail');
      return `${roundHeader}\nUser: ${userBody}\nAssistant: ${assistantBody}`;
    });
    exchangeSection = truncateToTokenBudget(
      `${sub}\n${blocks.join('\n\n')}`,
      exchangeBudget,
      'tail'
    );
  }

  const parts = [heading, userSection, exchangeSection].filter(Boolean);
  if (parts.length <= 1) return '';
  return truncateToTokenBudget(parts.join('\n\n'), budget, 'tail');
}

function buildFooterSection(input: {
  nowIso: string;
  lastSegmentEndedAtIso?: string;
  usage?: SessionMeta['contextWindowUsage'];
}): string {
  const interval = formatElapsedInterval(input.lastSegmentEndedAtIso, input.nowIso);
  const usageLine = input.usage
    ? `Previous segment context usage: ${input.usage.used} / ${input.usage.size} tokens.`
    : 'Previous segment context usage: unavailable.';
  return truncateToTokenBudget(
    [
      '## This Rollover & Expand Guide',
      `Current time: ${input.nowIso} · Interval since previous segment: ${interval}.`,
      usageLine,
      '以上摘要是缓存，Loro 原文是证据；需要任何历史细节时调用 lody_board_line_expand({ nodeId }) 展开下层节点或读取原文，不要凭粗摘要猜测；关键节点可用 lody_board_line_pin 钉住。',
      'Do not open sessions or message anyone in this turn. Reply with one short line saying you are ready.',
    ].join('\n'),
    BOARD_FOLD_FOOTER_BUDGET,
    'tail'
  );
}

/**
 * Deterministic fold-rollover opening builder.
 * Strictly capped at `<= 14,000` estimated tokens including `reservedTokens`
 * (Board instructions appended by `renewBoardInstructions`), with a
 * `BOARD_FOLD_OPENING_MIN_CORE_BUDGET` (1,500-token) floor when user Board
 * instructions themselves consume nearly all or more than 14,000 tokens.
 */
export function buildBoardFoldOpening(input: BuildBoardFoldOpeningInput): string {
  const header = [
    `Lody rolled over Board coordinator "${input.board.name}" into a fresh underlying agent session (fold rollover). The user does not see this turn.`,
    `The Lody conversation continues uninterrupted on session ${input.sessionId}; earlier turns remain stored in Loro history. The current Board instructions follow and replace any earlier version.`,
  ].join('\n');

  const footer = buildFooterSection({
    nowIso: input.nowIso,
    lastSegmentEndedAtIso: input.lastSegmentEndedAtIso,
    usage: input.usage,
  });

  const reserved = Math.max(0, Math.floor(input.reservedTokens ?? 0));
  const openingBudget = Math.max(
    BOARD_FOLD_OPENING_MIN_CORE_BUDGET,
    BOARD_FOLD_OPENING_MAX_TOKENS - reserved
  );
  const fixedTokens = estimateTokenCount(`${header}\n\n${footer}\n\n`);
  const availableVariable = Math.max(0, openingBudget - fixedTokens);
  const nominalVariable =
    BOARD_FOLD_HISTORY_BUDGET +
    BOARD_FOLD_RECENT_TREE_BUDGET +
    BOARD_FOLD_THREADS_BUDGET +
    BOARD_FOLD_VERBATIM_BUDGET;
  const scale = availableVariable < nominalVariable ? availableVariable / nominalVariable : 1;
  const historyBudget = Math.floor(BOARD_FOLD_HISTORY_BUDGET * scale);
  const recentTreeBudget = Math.floor(BOARD_FOLD_RECENT_TREE_BUDGET * scale);
  const threadsBudget = Math.floor(BOARD_FOLD_THREADS_BUDGET * scale);
  const verbatimBudget = Math.floor(BOARD_FOLD_VERBATIM_BUDGET * scale);

  const foldedHistory =
    historyBudget > 0 ? buildFoldedHistorySection(input.tree, historyBudget) : '';
  const recentTree =
    recentTreeBudget > 0 ? buildRecentTreeSection(input.tree, recentTreeBudget) : '';
  const openThreads =
    threadsBudget > 0 ? buildOpenThreadsSection(input.threads, threadsBudget) : '';
  const recentVerbatim =
    verbatimBudget > 0
      ? buildRecentVerbatimSection(input.recentUserMessages, input.recentExchanges, verbatimBudget)
      : '';

  const sections = [header, foldedHistory, recentTree, openThreads, recentVerbatim, footer].filter(
    Boolean
  );
  const assembled = sections.join('\n\n');
  if (estimateTokenCount(assembled) <= openingBudget) {
    return assembled;
  }

  // Final hard invariant guard: preserve header and footer verbatim, trim middle sections.
  const middleBudget = Math.max(0, openingBudget - fixedTokens);
  const middle = [foldedHistory, recentTree, openThreads, recentVerbatim]
    .filter(Boolean)
    .join('\n\n');
  const trimmedMiddle = truncateToTokenBudget(middle, middleBudget, 'tail');
  return [header, trimmedMiddle, footer].filter(Boolean).join('\n\n');
}
