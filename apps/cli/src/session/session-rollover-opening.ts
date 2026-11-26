import {
  estimateTokenCount,
  isBoardMaintenanceEntry,
  isBoardMaintenanceTurnId,
  isSessionRolloverEntry,
  isSessionRolloverTurnId,
  sanitizeLodyInternalInstructions,
  type MessageContent,
  type SessionHistoryInput,
  type SessionId,
} from '@lody/shared';
import {
  extractVisibleTurnText,
  isHumanUserTurn,
  truncateToTokenBudget,
} from '@/orchestration/board-fold-opening';
import { stripBoardCompactReminder } from './board-compact-reinject';
import {
  SESSION_ROLLOVER_MAX_SPINE_ENTRIES,
  createEmptySessionRolloverStateCard,
  type SessionRolloverSpineItem,
  type SessionRolloverStateCard,
} from './session-rollover-store';

/** Hard token ceiling for the core linear rollover opening (slots 0..6). */
export const SESSION_ROLLOVER_OPENING_MAX_TOKENS = 7_500;
export const SESSION_ROLLOVER_HEADER_BUDGET = 250;
export const SESSION_ROLLOVER_ORIGIN_BUDGET = 1_200;
export const SESSION_ROLLOVER_INVARIANTS_BUDGET = 700;
export const SESSION_ROLLOVER_STATE_CARD_BUDGET = 1_900;
export const SESSION_ROLLOVER_WORKSPACE_ANCHOR_BUDGET = 400;
export const SESSION_ROLLOVER_SPINE_BUDGET = 450;
export const SESSION_ROLLOVER_TAIL_BUDGET = 2_600;

export const SESSION_ROLLOVER_GOAL_BUDGET = 400;
export const SESSION_ROLLOVER_DECISIONS_BUDGET = 600;
export const SESSION_ROLLOVER_WORKSPACE_FACTS_BUDGET = 500;
export const SESSION_ROLLOVER_OPEN_NEXT_BUDGET = 400;

export const SESSION_ROLLOVER_MAX_WORKSPACE_FILES = 20;
export const SESSION_ROLLOVER_TAIL_QA_ROUNDS = 2;
export const SESSION_ROLLOVER_ONE_LINER_MAX_CHARS = 100;
export const SESSION_ROLLOVER_COLD_STREAM_DEFAULT_MAX_TOKENS = 16_000;
export const SESSION_ROLLOVER_COLD_STREAM_MAX_TOKENS = 20_000;

const ROLLOVER_COMMAND_RE = /^\/rollover(?:\s+([\s\S]*))?$/i;

export type ParsedSessionRolloverCommand =
  | { readonly matched: false }
  | { readonly matched: true; readonly hint?: string };

/**
 * Matches pure-text `/rollover` or `/rollover <focus hint>` (case-insensitive).
 * Rejects commands that only share a prefix (e.g. `/rollover2`).
 */
export function parseSessionRolloverCommand(text: string): ParsedSessionRolloverCommand {
  const match = text.trim().match(ROLLOVER_COMMAND_RE);
  if (!match) return { matched: false };
  const hint = match[1]?.trim();
  return hint ? { matched: true, hint } : { matched: true };
}

export type SessionRolloverWorkspaceAnchor = {
  readonly cwd?: string;
  readonly gitBranch?: string;
  readonly gitHead?: string;
  readonly recentFiles: readonly string[];
  readonly invariantsDocPath?: string;
};

export type SessionRolloverQaExchange = {
  readonly userTurnId: string;
  readonly timestamp: string;
  readonly userText: string;
  readonly assistantText?: string;
};

export type BuildLinearRolloverOpeningInput = {
  readonly sessionId: SessionId;
  readonly generation: number;
  readonly nodeId: string;
  readonly history: readonly SessionHistoryInput[];
  readonly originTurnId?: string;
  /** Previous node's last sealed turnId (exclusive start bound for non-overlapping Tail). */
  readonly previousLastSealedTurnId?: string;
  /** Inclusive end bound of the just-sealed segment. */
  readonly sealedThroughTurnId?: string;
  readonly stateCard: SessionRolloverStateCard;
  readonly spine: readonly SessionRolloverSpineItem[];
  readonly workspace?: Partial<SessionRolloverWorkspaceAnchor>;
  readonly nowIso: string;
  readonly usedBefore?: number;
  readonly userHint?: string;
};

export function cleanRolloverVisibleText(text: string): string {
  return stripBoardCompactReminder(sanitizeLodyInternalInstructions(text)).trim();
}

export function isOrdinaryRolloverHistoryEntry(entry: SessionHistoryInput): boolean {
  if (entry.role === 'system') return false;
  if (isBoardMaintenanceTurnId(entry.id) || isBoardMaintenanceEntry(entry)) return false;
  if (isSessionRolloverTurnId(entry.id) || isSessionRolloverEntry(entry)) return false;
  if (entry.role === 'user') {
    const raw = extractVisibleTurnText(entry);
    if (raw && parseSessionRolloverCommand(raw).matched) return false;
  }
  return true;
}

/**
 * Resolve the immutable Origin turn (first real user or delegated task turn).
 * Once locked in `state.originTurnId`, it never drifts across generations.
 */
export function resolveOriginTurn(
  history: readonly SessionHistoryInput[],
  originTurnId?: string
): SessionHistoryInput | undefined {
  if (originTurnId) {
    const exact = history.find((entry) => entry.id === originTurnId);
    if (exact) return exact;
  }
  for (const entry of history) {
    if (entry.role !== 'user') continue;
    if (!isOrdinaryRolloverHistoryEntry(entry)) continue;
    if (cleanRolloverVisibleText(extractVisibleTurnText(entry)).length > 0) {
      return entry;
    }
  }
  return undefined;
}

/**
 * Slice strictly non-overlapping ordinary Loro turns in `(afterTurnId .. throughTurnId]`.
 */
export function sliceRolloverSegmentEntries(
  history: readonly SessionHistoryInput[],
  options: {
    readonly afterTurnId?: string;
    readonly throughTurnId?: string;
    readonly excludeTurnId?: string;
  } = {}
): SessionHistoryInput[] {
  let startIndex = 0;
  if (options.afterTurnId) {
    const foundAfter = history.findIndex((entry) => entry.id === options.afterTurnId);
    if (foundAfter < 0) {
      return [];
    }
    startIndex = foundAfter + 1;
  }

  let endIndex = history.length - 1;
  if (options.throughTurnId) {
    const foundThrough = history.findIndex((entry) => entry.id === options.throughTurnId);
    if (foundThrough < 0) {
      return [];
    }
    endIndex = foundThrough;
  }
  if (endIndex < startIndex) return [];

  const result: SessionHistoryInput[] = [];
  for (let i = startIndex; i <= endIndex; i++) {
    const entry = history[i]!;
    if (
      options.excludeTurnId &&
      (entry.id === options.excludeTurnId || entry.id === `assistant:${options.excludeTurnId}`)
    ) {
      continue;
    }
    if (!isOrdinaryRolloverHistoryEntry(entry)) continue;
    result.push(entry);
  }
  return result;
}

/**
 * Mechanically collect up to `maxFiles` newest unique file paths touched by
 * `edit` / `write` / `read` tool calls in the given segment entries.
 */
export function extractRecentSegmentFiles(
  segmentEntries: readonly SessionHistoryInput[],
  maxFiles = SESSION_ROLLOVER_MAX_WORKSPACE_FILES
): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();

  const record = (rawPath: string | undefined) => {
    const trimmed = rawPath?.trim();
    if (!trimmed) return;
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    ordered.push(trimmed);
  };

  for (let i = segmentEntries.length - 1; i >= 0 && ordered.length < maxFiles; i--) {
    const entry = segmentEntries[i]!;
    const items = (entry.items ?? []) as MessageContent[];
    for (let j = items.length - 1; j >= 0 && ordered.length < maxFiles; j--) {
      const item = items[j];
      if (!item || item.type !== 'tool_call') continue;
      if (item.content) {
        for (let k = item.content.length - 1; k >= 0 && ordered.length < maxFiles; k--) {
          const block = item.content[k];
          if (block?.type === 'diff' && block.path) {
            record(block.path);
          }
        }
      }
      if (
        item.locations &&
        (item.kind === 'edit' || item.kind === 'read' || item.kind === 'write')
      ) {
        for (let k = item.locations.length - 1; k >= 0 && ordered.length < maxFiles; k--) {
          record(item.locations[k]?.path);
        }
      }
    }
    if (entry.fileDiff?.length) {
      for (let k = entry.fileDiff.length - 1; k >= 0 && ordered.length < maxFiles; k--) {
        record(entry.fileDiff[k]?.filePath);
      }
    }
  }

  return ordered;
}

/**
 * Extract the last `maxRounds` (default 2) visible human Q&A exchanges from the
 * strictly non-overlapping segment entries. Delegation receipts and inter-agent
 * messages are excluded via `isHumanUserTurn`.
 */
export function extractTailHumanExchanges(
  segmentEntries: readonly SessionHistoryInput[],
  maxRounds = SESSION_ROLLOVER_TAIL_QA_ROUNDS
): SessionRolloverQaExchange[] {
  const assistantByUserTurnId = new Map<string, string>();
  const humanUsers: Array<{ id: string; timestamp: string; text: string }> = [];

  for (const entry of segmentEntries) {
    if (!isOrdinaryRolloverHistoryEntry(entry)) continue;
    if (entry.role === 'user') {
      if (!isHumanUserTurn(entry)) continue;
      const text = cleanRolloverVisibleText(extractVisibleTurnText(entry));
      if (!text) continue;
      humanUsers.push({ id: entry.id, timestamp: entry.timestamp, text });
    } else if (entry.role === 'assistant' && entry.userTurnId) {
      const text = cleanRolloverVisibleText(extractVisibleTurnText(entry));
      if (text) {
        assistantByUserTurnId.set(entry.userTurnId, text);
      }
    }
  }

  const completedPairs: SessionRolloverQaExchange[] = [];
  for (const user of humanUsers) {
    const assistantText = assistantByUserTurnId.get(user.id);
    if (assistantText) {
      completedPairs.push({
        userTurnId: user.id,
        timestamp: user.timestamp,
        userText: user.text,
        assistantText,
      });
    }
  }

  if (completedPairs.length > 0) {
    return completedPairs.slice(-maxRounds);
  }
  return humanUsers.slice(-maxRounds).map((user) => ({
    userTurnId: user.id,
    timestamp: user.timestamp,
    userText: user.text,
  }));
}

export function formatRolloverTimeWindow(fromIso: string | undefined, toIso: string): string {
  const from = fromIso || toIso;
  const fromDate = from.length >= 10 ? from.slice(5, 10) : from;
  const fromTime = from.length >= 16 ? from.slice(11, 16) : '';
  const toDate = toIso.length >= 10 ? toIso.slice(5, 10) : toIso;
  const toTime = toIso.length >= 16 ? toIso.slice(11, 16) : '';
  if (fromTime && toTime) {
    return fromDate === toDate
      ? `${fromDate} ${fromTime}~${toTime}`
      : `${fromDate} ${fromTime}~${toDate} ${toTime}`;
  }
  return fromDate === toDate ? fromDate : `${fromDate}~${toDate}`;
}

export function formatRolloverNodeId(generation: number): string {
  return `n_${String(Math.max(1, generation)).padStart(4, '0')}`;
}

function dedupeTrimmedLines(lines: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    const normalized = raw.replace(/\s+/g, ' ').trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function clampOneLiner(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return 'Node handoff checkpoint';
  const chars = Array.from(compact);
  if (chars.length <= SESSION_ROLLOVER_ONE_LINER_MAX_CHARS) return compact;
  return `${chars
    .slice(0, SESSION_ROLLOVER_ONE_LINER_MAX_CHARS - 1)
    .join('')
    .trimEnd()}…`;
}

function buildHeaderSection(input: {
  sessionId: SessionId;
  generation: number;
  nodeId: string;
  nowIso: string;
  usedBefore?: number;
  userHint?: string;
}): string {
  const usageNote =
    input.usedBefore !== undefined ? ` (previous node at ~${input.usedBefore} tokens)` : '';
  const lines = [
    `[Lody Session Node Handoff — Node #${input.generation} (${input.nodeId})${usageNote}]`,
    `This is a fresh underlying agent context for continuous Lody session ${input.sessionId}. The user does not see this handoff turn; earlier turns remain intact in Loro history.`,
    `If you need verbatim details from older turns not shown below, call lody_session_history({ sessionId: "${input.sessionId}" }).`,
    `Timestamp: ${input.nowIso}.`,
  ];
  if (input.userHint?.trim()) {
    lines.push(`User handoff focus: ${truncateToTokenBudget(input.userHint.trim(), 40, 'tail')}`);
  }
  lines.push(
    'Do not call tools or start work during this handoff turn. Reply with a single short line: "Ready."'
  );
  return truncateToTokenBudget(lines.join('\n'), SESSION_ROLLOVER_HEADER_BUDGET, 'tail');
}

function buildOriginSection(originEntry: SessionHistoryInput | undefined, budget: number): string {
  if (!originEntry || budget <= 20) return '';
  const cleaned = cleanRolloverVisibleText(extractVisibleTurnText(originEntry));
  if (!cleaned) return '';
  const heading = '## 1. Original Task Anchor';
  const headingTok = estimateTokenCount(`${heading}\n`);
  const body = truncateToTokenBudget(cleaned, Math.max(0, budget - headingTok - 2), 'head-tail');
  if (!body) return '';
  return `${heading}\n${body}`;
}

function buildLockedInvariantsSection(
  lockedInvariants: readonly string[],
  invariantsDocPath: string | undefined,
  budget: number,
  sessionId?: SessionId
): string {
  const items = dedupeTrimmedLines(lockedInvariants);
  if (items.length === 0 && !invariantsDocPath) return '';
  const heading = '## 2. Locked Invariants (Protected — Must Not Regress)';
  const headingTok = estimateTokenCount(`${heading}\n`);
  const available = Math.max(0, budget - headingTok - 2);
  if (available <= 10) return '';

  const prefixLines: string[] = [];
  let prefixUsed = 0;
  if (invariantsDocPath) {
    const docLine = `- Invariants document on disk: \`${invariantsDocPath}\``;
    const tok = estimateTokenCount(`${docLine}\n`);
    if (tok <= available) {
      prefixLines.push(docLine);
      prefixUsed += tok;
    }
  }

  const formattedItems = items.map((invariant) => {
    const line = `- ${invariant}`;
    return { line, tokens: estimateTokenCount(`${line}\n`) };
  });
  const totalItemsTokens = formattedItems.reduce((sum, item) => sum + item.tokens, 0);

  if (prefixUsed + totalItemsTokens <= available) {
    const allLines = [...prefixLines, ...formattedItems.map((item) => item.line)];
    if (allLines.length === 0) return '';
    return `${heading}\n${allLines.join('\n')}`;
  }

  // Overflow: NEVER clip a prohibition mid-sentence and NEVER silently drop the
  // newest user red lines. Reserve room for a concise pointer to the full list,
  // then retain as many complete newest invariants as fit in chronological order.
  const makeOverflowPointer = (omittedCount: number): string => {
    const refParts: string[] = [];
    if (invariantsDocPath) refParts.push(`\`${invariantsDocPath}\``);
    if (sessionId) refParts.push(`lody_session_history({ sessionId: "${sessionId}" })`);
    const refText =
      refParts.length > 0
        ? `; full list preserved in rollover state and ${refParts.join(' / ')}`
        : '; full list preserved in rollover state';
    return `- [${omittedCount} earlier locked invariant(s) omitted from inline budget${refText}]`;
  };

  // Upper-bound pointer tokens using total item count so reservation is exact.
  const pointerReserve = estimateTokenCount(`${makeOverflowPointer(items.length)}\n`);
  const itemBudget = Math.max(0, available - prefixUsed - pointerReserve);

  const keptReversed: string[] = [];
  let keptTokens = 0;
  for (let i = formattedItems.length - 1; i >= 0; i--) {
    const entry = formattedItems[i]!;
    if (keptTokens + entry.tokens <= itemBudget) {
      keptReversed.push(entry.line);
      keptTokens += entry.tokens;
    } else {
      break;
    }
  }

  const kept = keptReversed.reverse();
  const omittedCount = formattedItems.length - kept.length;
  const finalLines: string[] = [...prefixLines];
  if (omittedCount > 0) {
    const pointerLine = makeOverflowPointer(omittedCount);
    if (prefixUsed + keptTokens + estimateTokenCount(`${pointerLine}\n`) <= available) {
      finalLines.push(pointerLine);
    }
  }
  finalLines.push(...kept);
  if (finalLines.length === 0) return '';
  return `${heading}\n${finalLines.join('\n')}`;
}

function buildStateCardSection(card: SessionRolloverStateCard, budget: number): string {
  if (budget <= 40) return '';
  const heading = '## 3. Current State Card';
  const headingTok = estimateTokenCount(`${heading}\n`);
  const available = Math.max(0, budget - headingTok - 4);
  const nominalTotal =
    SESSION_ROLLOVER_GOAL_BUDGET +
    SESSION_ROLLOVER_DECISIONS_BUDGET +
    SESSION_ROLLOVER_WORKSPACE_FACTS_BUDGET +
    SESSION_ROLLOVER_OPEN_NEXT_BUDGET;
  const scale = available < nominalTotal ? available / nominalTotal : 1;

  const parts: string[] = [];

  const goal = truncateToTokenBudget(
    card.goalAndPlan,
    Math.floor(SESSION_ROLLOVER_GOAL_BUDGET * scale),
    'tail'
  );
  if (goal) parts.push(`### Goal & Plan\n${goal}`);

  const decisions = dedupeTrimmedLines(card.decisionsAndDeadEnds);
  if (decisions.length > 0) {
    const decisionsText = truncateToTokenBudget(
      decisions.map((d) => `- ${d}`).join('\n'),
      Math.floor(SESSION_ROLLOVER_DECISIONS_BUDGET * scale),
      'tail'
    );
    if (decisionsText) parts.push(`### Decisions & Dead Ends\n${decisionsText}`);
  }

  const facts = truncateToTokenBudget(
    card.workspaceFacts,
    Math.floor(SESSION_ROLLOVER_WORKSPACE_FACTS_BUDGET * scale),
    'tail'
  );
  if (facts) parts.push(`### Workspace Facts\n${facts}`);

  const openNext = truncateToTokenBudget(
    card.openAndNext,
    Math.floor(SESSION_ROLLOVER_OPEN_NEXT_BUDGET * scale),
    'tail'
  );
  if (openNext) parts.push(`### Open Questions & Next Steps\n${openNext}`);

  if (parts.length === 0) return '';
  return truncateToTokenBudget(`${heading}\n${parts.join('\n\n')}`, budget, 'tail');
}

function buildWorkspaceAnchorSection(
  anchor: SessionRolloverWorkspaceAnchor,
  budget: number
): string {
  if (budget <= 20) return '';
  const lines: string[] = [];
  if (anchor.cwd) lines.push(`- Working directory: \`${anchor.cwd}\``);
  if (anchor.gitBranch || anchor.gitHead) {
    const branch = anchor.gitBranch ? `branch \`${anchor.gitBranch}\`` : '';
    const head = anchor.gitHead ? `HEAD \`${anchor.gitHead}\`` : '';
    lines.push(`- Git: ${[branch, head].filter(Boolean).join(' · ')}`);
  }
  if (anchor.invariantsDocPath) {
    lines.push(`- Invariants reference: \`${anchor.invariantsDocPath}\``);
  }
  const files = anchor.recentFiles.slice(0, SESSION_ROLLOVER_MAX_WORKSPACE_FILES);
  if (files.length > 0) {
    lines.push(
      `- Recent segment files (${files.length}): ${files.map((f) => `\`${f}\``).join(', ')}`
    );
  }
  if (lines.length === 0) return '';
  return truncateToTokenBudget(`## 4. Workspace Anchor\n${lines.join('\n')}`, budget, 'tail');
}

function buildSpineSection(
  spine: readonly SessionRolloverSpineItem[],
  currentGeneration: number,
  budget: number
): string {
  if (spine.length === 0 || budget <= 20) return '';
  const heading = '## 5. Linear Node Spine';
  const kept = spine.slice(-SESSION_ROLLOVER_MAX_SPINE_ENTRIES);
  const firstKeptGen = kept[0]?.gen ?? 1;
  const omittedCount = Math.max(0, firstKeptGen - 1);
  const lines: string[] = [];
  if (omittedCount > 0) {
    lines.push(
      `- (${omittedCount} earlier node${omittedCount === 1 ? '' : 's'} omitted; use lody_session_history for older turns)`
    );
  }
  for (const item of kept) {
    lines.push(
      `- ${item.nodeId} (#${item.gen}/${currentGeneration}) | ${item.window} | ${item.turnCount}t | ${clampOneLiner(item.oneLiner)}`
    );
  }
  return truncateToTokenBudget(`${heading}\n${lines.join('\n')}`, budget, 'tail');
}

function buildTailSection(exchanges: readonly SessionRolloverQaExchange[], budget: number): string {
  if (exchanges.length === 0 || budget <= 40) return '';
  const heading = '## 6. Recent Human Q&A Tail (Non-Overlapping)';
  const headingTok = estimateTokenCount(`${heading}\n`);
  const available = Math.max(0, budget - headingTok - 4);
  const perRound = Math.max(40, Math.floor(available / exchanges.length));

  const blocks = exchanges.map((pair, idx) => {
    const roundHeader = `### Round ${idx + 1} (${pair.timestamp})`;
    const overhead = estimateTokenCount(`${roundHeader}\nUser: \nAssistant: \n`);
    const bodyBudget = Math.max(20, perRound - overhead - 4);
    if (!pair.assistantText) {
      const userBody = truncateToTokenBudget(pair.userText, bodyBudget, 'head-tail');
      return `${roundHeader}\nUser: ${userBody}`;
    }
    const userShare = Math.max(12, Math.floor(bodyBudget * 0.38));
    const assistantShare = Math.max(12, bodyBudget - userShare);
    const userBody = truncateToTokenBudget(pair.userText, userShare, 'head-tail');
    const assistantBody = truncateToTokenBudget(pair.assistantText, assistantShare, 'head-tail');
    return `${roundHeader}\nUser: ${userBody}\nAssistant: ${assistantBody}`;
  });

  return truncateToTokenBudget(`${heading}\n${blocks.join('\n\n')}`, budget, 'tail');
}

/**
 * Deterministic bounded linear rollover opening builder.
 * Guarantees `estimateTokenCount(result) <= SESSION_ROLLOVER_OPENING_MAX_TOKENS` (7,500)
 * across any number of generations (1..50+).
 */
export function buildLinearRolloverOpening(input: BuildLinearRolloverOpeningInput): string {
  const segmentEntries = sliceRolloverSegmentEntries(input.history, {
    afterTurnId: input.previousLastSealedTurnId,
    throughTurnId: input.sealedThroughTurnId,
  });
  const originEntry = resolveOriginTurn(input.history, input.originTurnId);
  const tailExchanges = extractTailHumanExchanges(segmentEntries, SESSION_ROLLOVER_TAIL_QA_ROUNDS);
  const recentFiles =
    input.workspace?.recentFiles && input.workspace.recentFiles.length > 0
      ? input.workspace.recentFiles.slice(0, SESSION_ROLLOVER_MAX_WORKSPACE_FILES)
      : extractRecentSegmentFiles(segmentEntries, SESSION_ROLLOVER_MAX_WORKSPACE_FILES);

  const workspaceAnchor: SessionRolloverWorkspaceAnchor = {
    ...(input.workspace?.cwd ? { cwd: input.workspace.cwd } : {}),
    ...(input.workspace?.gitBranch ? { gitBranch: input.workspace.gitBranch } : {}),
    ...(input.workspace?.gitHead ? { gitHead: input.workspace.gitHead } : {}),
    ...(input.workspace?.invariantsDocPath
      ? { invariantsDocPath: input.workspace.invariantsDocPath }
      : {}),
    recentFiles,
  };

  const header = buildHeaderSection({
    sessionId: input.sessionId,
    generation: input.generation,
    nodeId: input.nodeId,
    nowIso: input.nowIso,
    usedBefore: input.usedBefore,
    userHint: input.userHint,
  });

  const lockedInvariants = buildLockedInvariantsSection(
    input.stateCard.lockedInvariants,
    workspaceAnchor.invariantsDocPath,
    SESSION_ROLLOVER_INVARIANTS_BUDGET,
    input.sessionId
  );

  const origin = buildOriginSection(originEntry, SESSION_ROLLOVER_ORIGIN_BUDGET);
  const stateCard = buildStateCardSection(input.stateCard, SESSION_ROLLOVER_STATE_CARD_BUDGET);
  const anchorSection = buildWorkspaceAnchorSection(
    workspaceAnchor,
    SESSION_ROLLOVER_WORKSPACE_ANCHOR_BUDGET
  );
  const spineSection = buildSpineSection(
    input.spine,
    input.generation,
    SESSION_ROLLOVER_SPINE_BUDGET
  );
  const tailSection = buildTailSection(tailExchanges, SESSION_ROLLOVER_TAIL_BUDGET);

  const assemble = (parts: readonly string[]) => parts.filter(Boolean).join('\n\n');
  const firstPass = assemble([
    header,
    origin,
    lockedInvariants,
    stateCard,
    anchorSection,
    spineSection,
    tailSection,
  ]);
  if (estimateTokenCount(firstPass) <= SESSION_ROLLOVER_OPENING_MAX_TOKENS) {
    return firstPass;
  }

  // Secondary hard clamp: preserve Header and Locked Invariants verbatim first,
  // then proportionally scale the remaining variable slots to guarantee <= 7,500 tokens.
  const protectedBlock = assemble([header, lockedInvariants]);
  const protectedTokens = estimateTokenCount(`${protectedBlock}\n\n`);
  const remaining = Math.max(0, SESSION_ROLLOVER_OPENING_MAX_TOKENS - protectedTokens - 8);

  const nominalVariable =
    SESSION_ROLLOVER_ORIGIN_BUDGET +
    SESSION_ROLLOVER_STATE_CARD_BUDGET +
    SESSION_ROLLOVER_WORKSPACE_ANCHOR_BUDGET +
    SESSION_ROLLOVER_SPINE_BUDGET +
    SESSION_ROLLOVER_TAIL_BUDGET;
  const scale = remaining / nominalVariable;

  const clampedOrigin = buildOriginSection(
    originEntry,
    Math.floor(SESSION_ROLLOVER_ORIGIN_BUDGET * scale)
  );
  const clampedStateCard = buildStateCardSection(
    input.stateCard,
    Math.floor(SESSION_ROLLOVER_STATE_CARD_BUDGET * scale)
  );
  const clampedAnchor = buildWorkspaceAnchorSection(
    workspaceAnchor,
    Math.floor(SESSION_ROLLOVER_WORKSPACE_ANCHOR_BUDGET * scale)
  );
  const clampedSpine = buildSpineSection(
    input.spine,
    input.generation,
    Math.floor(SESSION_ROLLOVER_SPINE_BUDGET * scale)
  );
  const clampedTail = buildTailSection(
    tailExchanges,
    Math.floor(SESSION_ROLLOVER_TAIL_BUDGET * scale)
  );

  const secondPass = assemble([
    header,
    clampedOrigin,
    lockedInvariants,
    clampedStateCard,
    clampedAnchor,
    clampedSpine,
    clampedTail,
  ]);
  if (estimateTokenCount(secondPass) <= SESSION_ROLLOVER_OPENING_MAX_TOKENS) {
    return secondPass;
  }

  // Absolute invariant guard: keep header + lockedInvariants and truncate the rest.
  const rest = assemble([
    clampedOrigin,
    clampedStateCard,
    clampedAnchor,
    clampedSpine,
    clampedTail,
  ]);
  const finalRestBudget = Math.max(
    0,
    SESSION_ROLLOVER_OPENING_MAX_TOKENS - estimateTokenCount(`${protectedBlock}\n\n`) - 4
  );
  const trimmedRest = truncateToTokenBudget(rest, finalRestBudget, 'tail');
  const guarded = assemble([protectedBlock, trimmedRest]);
  return estimateTokenCount(guarded) <= SESSION_ROLLOVER_OPENING_MAX_TOKENS
    ? guarded
    : truncateToTokenBudget(guarded, SESSION_ROLLOVER_OPENING_MAX_TOKENS, 'tail');
}

const SEAL_JSON_SCHEMA_INSTRUCTIONS = [
  'Output ONLY a single JSON object (no markdown prose outside JSON, no tool calls) with this exact shape:',
  '{',
  '  "oneLiner": "<= 100 char milestone summary of this node>",',
  '  "stateCard": {',
  '    "goalAndPlan": "current overall goal and active phase plan (<= 400 tokens)",',
  '    "lockedInvariants": ["user-confirmed features to keep, UI/UX red lines, and negative constraints — NEVER merge into completed progress or drop unless explicitly revoked by the user"],',
  '    "revokedInvariants": ["optional exact prior invariants explicitly revoked by the user in this segment"],',
  '    "decisionsAndDeadEnds": ["key still-valid decisions with reasons and dead ends already ruled out"],',
  '    "workspaceFacts": "key files, verification state, and on-disk doc paths (e.g. invariants.md)",',
  '    "openAndNext": "unresolved questions and immediate next steps"',
  '  }',
  '}',
].join('\n');

/**
 * Warm-cache `:seal` prompt sent to the live underlying ACP session (no tools,
 * hits hot KV cache) to update the overwrite-in-place `StateCard`.
 */
export function buildWarmSealPrompt(input: {
  readonly previousCard: SessionRolloverStateCard;
  readonly generation: number;
  readonly userHint?: string;
}): string {
  const parts = [
    `[Lody Internal Handoff Seal — Node #${input.generation}]`,
    'Lody is preparing a clean context rollover to a fresh underlying agent session. Do NOT call any tools, run commands, or edit files.',
    'Update the overwrite-in-place StateCard so the next node can continue seamlessly without losing requirements or regressing confirmed work.',
    'CRITICAL: Preserve EVERY entry in `lockedInvariants` unless the user explicitly revoked it in this segment. Add any new confirmed requirements/red lines/prohibitions.',
    input.userHint?.trim() ? `User focus hint for this rollover: ${input.userHint.trim()}` : '',
    `Previous StateCard:\n${JSON.stringify(input.previousCard, null, 2)}`,
    SEAL_JSON_SCHEMA_INSTRUCTIONS,
  ].filter(Boolean);
  return parts.join('\n\n');
}

/**
 * Extract a bounded plain-text Q&A stream (`<= maxTokens`, default 16k, max 20k)
 * from the unsealed Loro segment, stripping all `<thinking>` blocks and raw tool
 * outputs so cold summarization never wakes a stale 350k ACP session.
 */
export function buildColdTextStreamForSeal(
  segmentEntries: readonly SessionHistoryInput[],
  maxTokens = SESSION_ROLLOVER_COLD_STREAM_DEFAULT_MAX_TOKENS
): string {
  const effectiveMax = Math.max(512, Math.min(maxTokens, SESSION_ROLLOVER_COLD_STREAM_MAX_TOKENS));
  const blocks: string[] = [];

  for (const entry of segmentEntries) {
    if (!isOrdinaryRolloverHistoryEntry(entry)) continue;
    if (entry.role !== 'user' && entry.role !== 'assistant') continue;
    const text = cleanRolloverVisibleText(extractVisibleTurnText(entry));
    if (!text) continue;
    const label =
      entry.role === 'user' ? (isHumanUserTurn(entry) ? '[Human]' : '[Agent/Task]') : '[Assistant]';
    blocks.push(`${label} (${entry.timestamp})\n${text}`);
  }

  if (blocks.length === 0) return '';
  const joined = blocks.join('\n\n');
  if (estimateTokenCount(joined) <= effectiveMax) {
    return joined;
  }

  // Keep the earliest turn + as many newest turns as fit within budget so both
  // opening framing and latest decisions survive.
  const firstBudget = Math.min(Math.floor(effectiveMax * 0.2), 2_000);
  const firstBlock = truncateToTokenBudget(blocks[0]!, firstBudget, 'head-tail');
  const marker = '\n\n... [middle turns condensed to fit cold-seal budget] ...\n\n';
  let remaining = Math.max(
    0,
    effectiveMax - estimateTokenCount(firstBlock) - estimateTokenCount(marker) - 8
  );

  const keptTail: string[] = [];
  for (let i = blocks.length - 1; i >= 1 && remaining > 32; i--) {
    const candidate = blocks[i]!;
    const tok = estimateTokenCount(`${candidate}\n\n`);
    if (tok <= remaining) {
      keptTail.unshift(candidate);
      remaining -= tok;
    } else if (keptTail.length === 0) {
      const clipped = truncateToTokenBudget(candidate, remaining, 'head-tail');
      if (clipped) keptTail.unshift(clipped);
      break;
    } else {
      break;
    }
  }

  const combined =
    keptTail.length > 0 ? `${firstBlock}${marker}${keptTail.join('\n\n')}` : firstBlock;
  return truncateToTokenBudget(combined, effectiveMax, 'head-tail');
}

/**
 * Cold-path toolless summarization prompt built purely from Loro plain text
 * (used when the old ACP session is cold, GC'd, or degraded by mid-turn native compact).
 */
export function buildColdSealPrompt(input: {
  readonly previousCard: SessionRolloverStateCard;
  readonly generation: number;
  readonly coldTextStream: string;
  readonly recentFiles?: readonly string[];
  readonly userHint?: string;
}): string {
  const parts = [
    `[Lody Cold Handoff Seal — Node #${input.generation}]`,
    'Summarize the conversation segment below into an updated overwrite-in-place StateCard JSON. Do NOT call any tools.',
    'CRITICAL: Preserve EVERY entry in `previousCard.lockedInvariants` unless explicitly revoked by the user in the transcript below.',
    input.userHint?.trim() ? `User focus hint: ${input.userHint.trim()}` : '',
    `Previous StateCard:\n${JSON.stringify(input.previousCard, null, 2)}`,
    input.recentFiles && input.recentFiles.length > 0
      ? `Touched files in this segment: ${input.recentFiles.slice(0, SESSION_ROLLOVER_MAX_WORKSPACE_FILES).join(', ')}`
      : '',
    `Segment Transcript (visible prose only):\n${input.coldTextStream}`,
    SEAL_JSON_SCHEMA_INSTRUCTIONS,
  ].filter(Boolean);
  return parts.join('\n\n');
}

export type ParsedRolloverSealResult = {
  readonly stateCard: SessionRolloverStateCard;
  readonly oneLiner: string;
};

function extractJsonObjectCandidate(rawText: string): string | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;
  return candidate.slice(firstBrace, lastBrace + 1);
}

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

/**
 * Parse structured `:seal` JSON output and protect `previousCard.lockedInvariants`:
 * every prior invariant is retained unless explicitly listed in `revokedInvariants`.
 */
export function parseRolloverSealJson(
  rawText: string,
  previousCard: SessionRolloverStateCard = createEmptySessionRolloverStateCard()
): ParsedRolloverSealResult | null {
  const jsonText = extractJsonObjectCandidate(rawText);
  if (!jsonText) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const root = parsed as Record<string, unknown>;
  const rawCard =
    root.stateCard && typeof root.stateCard === 'object' && !Array.isArray(root.stateCard)
      ? (root.stateCard as Record<string, unknown>)
      : root;

  const goalAndPlan =
    typeof rawCard.goalAndPlan === 'string' ? rawCard.goalAndPlan.trim() : previousCard.goalAndPlan;
  const workspaceFacts =
    typeof rawCard.workspaceFacts === 'string'
      ? rawCard.workspaceFacts.trim()
      : previousCard.workspaceFacts;
  const openAndNext =
    typeof rawCard.openAndNext === 'string' ? rawCard.openAndNext.trim() : previousCard.openAndNext;

  const rawDecisions = asStringArray(rawCard.decisionsAndDeadEnds);
  const decisionsAndDeadEnds =
    rawDecisions.length > 0
      ? dedupeTrimmedLines(rawDecisions)
      : [...previousCard.decisionsAndDeadEnds];

  const revokedSet = new Set(
    asStringArray(rawCard.revokedInvariants).map((item) =>
      item.replace(/\s+/g, ' ').trim().toLowerCase()
    )
  );
  const survivingPrevious = previousCard.lockedInvariants.filter(
    (item) => !revokedSet.has(item.replace(/\s+/g, ' ').trim().toLowerCase())
  );
  const proposedInvariants = asStringArray(rawCard.lockedInvariants);
  const lockedInvariants = dedupeTrimmedLines([...survivingPrevious, ...proposedInvariants]);

  const hasMeaningfulField =
    typeof rawCard.goalAndPlan === 'string' ||
    typeof rawCard.workspaceFacts === 'string' ||
    typeof rawCard.openAndNext === 'string' ||
    Array.isArray(rawCard.decisionsAndDeadEnds) ||
    Array.isArray(rawCard.lockedInvariants) ||
    typeof root.oneLiner === 'string';
  if (!hasMeaningfulField) return null;

  const oneLinerRaw =
    typeof root.oneLiner === 'string' && root.oneLiner.trim()
      ? root.oneLiner
      : openAndNext || goalAndPlan || 'Node handoff checkpoint';

  return {
    stateCard: {
      goalAndPlan: truncateToTokenBudget(goalAndPlan, SESSION_ROLLOVER_GOAL_BUDGET, 'tail'),
      lockedInvariants,
      decisionsAndDeadEnds,
      workspaceFacts: truncateToTokenBudget(
        workspaceFacts,
        SESSION_ROLLOVER_WORKSPACE_FACTS_BUDGET,
        'tail'
      ),
      openAndNext: truncateToTokenBudget(openAndNext, SESSION_ROLLOVER_OPEN_NEXT_BUDGET, 'tail'),
    },
    oneLiner: clampOneLiner(oneLinerRaw),
  };
}

/**
 * Deterministic mechanical fallback card when warm/cold LLM summarization fails
 * or is unavailable. Always preserves `previousCard.lockedInvariants`.
 */
export function buildFallbackRolloverCard(input: {
  readonly previousCard: SessionRolloverStateCard;
  readonly segmentEntries: readonly SessionHistoryInput[];
  readonly originEntry?: SessionHistoryInput;
  readonly recentFiles?: readonly string[];
  readonly userHint?: string;
}): ParsedRolloverSealResult {
  const { previousCard, segmentEntries, originEntry, userHint } = input;
  const exchanges = extractTailHumanExchanges(segmentEntries, 2);
  const latestExchange = exchanges.at(-1);
  const files =
    input.recentFiles && input.recentFiles.length > 0
      ? input.recentFiles.slice(0, SESSION_ROLLOVER_MAX_WORKSPACE_FILES)
      : extractRecentSegmentFiles(segmentEntries, SESSION_ROLLOVER_MAX_WORKSPACE_FILES);

  const originText = originEntry
    ? cleanRolloverVisibleText(extractVisibleTurnText(originEntry))
    : '';
  const goalAndPlan = truncateToTokenBudget(
    previousCard.goalAndPlan ||
      originText ||
      latestExchange?.userText ||
      'Continue ongoing session task.',
    SESSION_ROLLOVER_GOAL_BUDGET,
    'tail'
  );

  const fileSummary = files.length > 0 ? `Recent touched files: ${files.join(', ')}` : '';
  const workspaceFacts = truncateToTokenBudget(
    [previousCard.workspaceFacts, fileSummary].filter(Boolean).join('\n'),
    SESSION_ROLLOVER_WORKSPACE_FACTS_BUDGET,
    'tail'
  );

  const latestSnippet = latestExchange
    ? [
        `Latest user request: ${truncateToTokenBudget(latestExchange.userText, 120, 'head-tail')}`,
        latestExchange.assistantText
          ? `Latest assistant status: ${truncateToTokenBudget(latestExchange.assistantText, 160, 'head-tail')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n')
    : '';

  const openAndNext = truncateToTokenBudget(
    [
      userHint?.trim() ? `User handoff focus: ${userHint.trim()}` : '',
      latestSnippet || previousCard.openAndNext,
    ]
      .filter(Boolean)
      .join('\n'),
    SESSION_ROLLOVER_OPEN_NEXT_BUDGET,
    'tail'
  );

  const oneLinerSource =
    userHint?.trim() ||
    latestExchange?.userText ||
    previousCard.openAndNext ||
    goalAndPlan ||
    'Mechanical handoff checkpoint';

  return {
    stateCard: {
      goalAndPlan,
      lockedInvariants: dedupeTrimmedLines(previousCard.lockedInvariants),
      decisionsAndDeadEnds: dedupeTrimmedLines(previousCard.decisionsAndDeadEnds),
      workspaceFacts,
      openAndNext,
    },
    oneLiner: clampOneLiner(oneLinerSource),
  };
}
