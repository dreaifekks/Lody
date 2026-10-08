// What a reader of a LAN share sees of an assistant turn: its answer, and not
// the work before it. The reader page folds that work by these rules, and the
// window publishes nothing else, so the two must agree; both use this file,
// which imports nothing (the reader bundles it by its path). The rules follow
// `ai-gui/message-copy.ts` and `assistant-turn-render-blocks.ts` of
// `@lody/components`. See `.agents/docs/lan-sharing.md#shared-conversations`.

/** An item of a history entry, as JSON; nothing of it is trusted. */
export type LanShareTurnItem = { readonly [key: string]: unknown };

/** Length from which earlier text in a turn reads as content, not narration. */
const SUBSTANTIVE_TEXT_MIN_CHARS = 300;
const STRUCTURED_TEXT_PATTERN = /(?:^|\n)[ \t]*(?:[-*+] |\d+[.)] |\||#{1,6} )/;

export const isSubstantiveLanShareText = (text: string): boolean =>
  text.trim().length >= SUBSTANTIVE_TEXT_MIN_CHARS || STRUCTURED_TEXT_PATTERN.test(text);

/** The plan-approval card, which closes a segment of a turn. */
export const isLanSharePlanExit = (item: LanShareTurnItem): boolean =>
  item.type === 'tool_call' && item.kind === 'switch_mode';

/** Attachments, plans and notices trail the answer and never fold. */
const NEVER_FOLDED = new Set([
  'image',
  'image_group',
  'file',
  'plan',
  'goal',
  'proposed_plan',
  'system_notice',
]);

const isNeverFolded = (item: LanShareTurnItem | undefined): boolean =>
  item !== undefined &&
  ((typeof item.type === 'string' && NEVER_FOLDED.has(item.type)) || isLanSharePlanExit(item));

/** Thinking and tool calls: a run of them is one group of steps. */
export const isLanShareActivity = (item: LanShareTurnItem): boolean =>
  item.type === 'thought' ||
  (item.type === 'tool_call' && !isLanSharePlanExit(item) && item.activityKind === undefined);

const textOf = (item: LanShareTurnItem | undefined): string | null =>
  item?.type === 'text' ? (typeof item.text === 'string' ? item.text : '') : null;

/** Where the closing run of text begins; `items.length` when the turn ends in work. */
function finalTextRunStart(items: readonly LanShareTurnItem[]): number {
  let index = items.length - 1;
  while (index >= 0 && isNeverFolded(items[index])) index -= 1;
  if (textOf(items[index]) === null) return items.length;
  while (index > 0 && textOf(items[index - 1]) !== null) index -= 1;
  return index;
}

/** The closing text run, and the run before the last work too when the closing one is thin. */
function visibleTextStart(items: readonly LanShareTurnItem[]): number {
  const start = finalTextRunStart(items);
  if (start >= items.length) return start;
  const closing = items
    .slice(start)
    .map((item) => textOf(item) ?? '')
    .join('\n\n');
  if (isSubstantiveLanShareText(closing)) return start;
  let index = start - 1;
  while (index >= 0 && textOf(items[index]) === null) index -= 1;
  if (index < 0) return start;
  while (index > 0 && textOf(items[index - 1]) !== null) index -= 1;
  return index;
}

/** The indexes of a finished segment's items that fold into its work. */
export function lanShareWorkOf(items: readonly LanShareTurnItem[]): Set<number> {
  const visibleStart = visibleTextStart(items);
  const work = new Set<number>();
  items.forEach((item, index) => {
    const text = textOf(item);
    const keepsText =
      text !== null &&
      visibleStart < items.length &&
      (index >= visibleStart || isSubstantiveLanShareText(text));
    const folds =
      isLanShareActivity(item) ||
      (items.length > 1 && index < items.length - 1 && !keepsText && !isNeverFolded(item));
    if (folds) work.add(index);
  });
  return work;
}

/** Whether a segment leaves something showing outside its work: the condition for folding. */
export const lanShareAnswered = (items: readonly LanShareTurnItem[], work: Set<number>): boolean =>
  items.some((item, index) => !work.has(index) && item.type !== 'system_notice');

/** A turn's items cut after each plan exit, so each region folds on its own. */
export function lanShareSegments<T extends LanShareTurnItem>(items: readonly T[]): T[][] {
  const segments: T[][] = [];
  let current: T[] = [];
  for (const item of items) {
    current.push(item);
    if (isLanSharePlanExit(item)) {
      segments.push(current);
      current = [];
    }
  }
  // A turn ending exactly on the card leaves no segment after it.
  if (current.length > 0 || segments.length === 0) segments.push(current);
  return segments;
}

const ATTACHMENTS = new Set(['image', 'image_group', 'file']);

/**
 * The items of an assistant turn a LAN publishes: the text a reader sees with
 * the work folded, and the pictures and files of the answer. Thinking, tool
 * calls, short narration, subagent tasks, plans and notices stay home. A turn
 * that shows no answer (one still running, or ending in work) keeps only its
 * substantive text, so a share never carries the process.
 */
export function projectLanShareTurnItems<T extends LanShareTurnItem>(items: readonly T[]): T[] {
  return lanShareSegments(items.filter((item) => item.type !== 'subagent_task')).flatMap(
    (segment) => {
      const work = lanShareWorkOf(segment);
      const answered = lanShareAnswered(segment, work);
      return segment.filter((item, index) => {
        if (typeof item.type === 'string' && ATTACHMENTS.has(item.type)) return true;
        const text = textOf(item);
        if (text === null || !text.trim()) return false;
        return answered ? !work.has(index) : isSubstantiveLanShareText(text);
      });
    }
  );
}

const isRecord = (value: unknown): value is { [key: string]: unknown } =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A conversation's history as a LAN publishes it: the messages of its user,
 * and of each assistant turn what {@link projectLanShareTurnItems} keeps, with
 * the turn's plan left out. Entries of other roles are dropped; an assistant
 * turn with nothing left is dropped too. The history itself is not changed.
 */
export function projectLanShareHistory(history: unknown): unknown[] {
  if (!Array.isArray(history)) return [];
  return history.flatMap((entry: unknown) => {
    if (!isRecord(entry)) return [];
    if (entry.role === 'user') return [entry];
    if (entry.role !== 'assistant') return [];
    const items = Array.isArray(entry.items) ? entry.items.filter(isRecord) : [];
    const kept = projectLanShareTurnItems(items);
    if (kept.length === 0) return [];
    const { plan: _plan, ...rest } = entry;
    return [{ ...rest, items: kept }];
  });
}
