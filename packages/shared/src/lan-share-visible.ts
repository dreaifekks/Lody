// What a reader of a LAN share sees of an assistant turn: its answer, and not
// the work before it. The reader page folds that work by these rules, and the
// window publishes nothing else, so the two must agree; both use this file,
// which imports only `lody-agent-tool-names.ts`, itself importing nothing (the
// reader bundles both by path). The rules are the desktop's
// (`ai-gui/message-copy.ts` and `assistant-turn-render-blocks.ts` of
// `@lody/components`): a finished turn shows its closing run of text, and every
// earlier text folds with the work, however long it is.
// See `.agents/docs/lan-sharing.md#shared-conversations`.
import { agentSurfaceToolOf, toolArguments, type ToolCallLike } from './lody-agent-tool-names';

/** An item of a history entry, as JSON; nothing of it is trusted. */
export type LanShareTurnItem = { readonly [key: string]: unknown };

/** The plan-approval card, which closes a segment of a turn. */
export const isLanSharePlanExit = (item: LanShareTurnItem): boolean =>
  item.type === 'tool_call' && item.kind === 'switch_mode';

/**
 * A plan to review or a widget, which the desktop draws as a card of its own
 * (`isSurfaceToolCall` of `@lody/components`, here with every surface on, as a
 * share has no device to ask): it never folds, so the answer before it stays
 * the answer, and a share never publishes the card itself. A call that failed,
 * and a finished one whose input history did not keep, is an ordinary step.
 */
const isSurfaceCard = (item: LanShareTurnItem): boolean => {
  if (item.type !== 'tool_call' || item.status === 'failed') return false;
  const call = item as ToolCallLike;
  const tool = agentSurfaceToolOf(call);
  return (
    tool !== null &&
    tool.kind !== 'notify' &&
    (toolArguments(call) !== undefined || item.status !== 'completed')
  );
};

/** Attachments, plans, notices and cards trail the answer and never fold. */
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
  ((typeof item.type === 'string' && NEVER_FOLDED.has(item.type)) ||
    isLanSharePlanExit(item) ||
    isSurfaceCard(item));

/** Thinking and tool calls: a run of them is one group of steps. */
export const isLanShareActivity = (item: LanShareTurnItem): boolean =>
  item.type === 'thought' ||
  (item.type === 'tool_call' &&
    !isLanSharePlanExit(item) &&
    item.activityKind === undefined &&
    !isSurfaceCard(item));

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

/**
 * The indexes of a finished segment's items that fold into its work: thinking,
 * tool calls and every text before the closing run.
 */
export function lanShareWorkOf(items: readonly LanShareTurnItem[]): Set<number> {
  const answerStart = finalTextRunStart(items);
  const work = new Set<number>();
  items.forEach((item, index) => {
    const isAnswer = textOf(item) !== null && index >= answerStart;
    const folds =
      isLanShareActivity(item) ||
      (items.length > 1 && index < items.length - 1 && !isAnswer && !isNeverFolded(item));
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

const isRecord = (value: unknown): value is { [key: string]: unknown } =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `value` with only the `keys` it has, as a new object. */
function pick(value: { readonly [key: string]: unknown }, keys: readonly string[]) {
  const picked: { [key: string]: unknown } = {};
  for (const key of keys) if (value[key] !== undefined) picked[key] = value[key];
  return picked;
}

/** What the exporter reads of an attachment, and the reader shows of it. */
const ATTACHMENT_KEYS = [
  'type',
  'imageId',
  'fileId',
  'fileName',
  'mimeType',
  'sha256',
  'sizeBytes',
  'storageSessionId',
  'machineId',
  'sourcePath',
];

/** The file types a conversation shows as a picture (`SESSION_IMAGE_ALLOWED_MIME_TYPES`). */
const PICTURE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/**
 * A picture as a share carries it. A LAN keeps the picture of a message as a
 * file on one machine, and sharing leaves every file out, so such a file is
 * rebuilt as the image it is shown as; the window then reads it from the
 * machine that keeps it. `null` for any other item.
 */
function pictureOf(item: LanShareTurnItem): LanShareTurnItem | null {
  if (
    item.type !== 'file' ||
    item.transport !== 'local' ||
    typeof item.fileId !== 'string' ||
    typeof item.machineId !== 'string' ||
    typeof item.mimeType !== 'string' ||
    !PICTURE_TYPES.has(item.mimeType)
  ) {
    return null;
  }
  return {
    ...pick(item, ['fileName', 'mimeType', 'sha256', 'sizeBytes', 'storageSessionId', 'machineId']),
    type: 'image',
    imageId: item.fileId,
  };
}

/** A user's message as it was sent, its pictures as a share carries them. */
const sentItems = (items: unknown): unknown =>
  Array.isArray(items)
    ? items.map((item: unknown) => (isRecord(item) ? (pictureOf(item) ?? item) : item))
    : items;

/** An item kept for a reader, rebuilt from the fields a reader reads; `null` when none is. */
function publicItem(item: LanShareTurnItem): LanShareTurnItem | null {
  if (item.type === 'text') return { type: 'text', text: textOf(item) ?? '' };
  if (item.type === 'image' || item.type === 'file') {
    return pictureOf(item) ?? pick(item, ATTACHMENT_KEYS);
  }
  if (item.type === 'image_group') {
    const images = Array.isArray(item.images) ? item.images.filter(isRecord) : [];
    return { type: 'image_group', images: images.map((image) => pick(image, ATTACHMENT_KEYS)) };
  }
  return null;
}

/**
 * The items of an assistant turn a LAN publishes, rebuilt from their public
 * fields: of each segment that shows an answer when the turn is over, what the
 * desktop leaves outside its work, which is the closing run of text and the
 * pictures and files. Thinking, tool calls, every text before the closing run,
 * subagent tasks, plans and notices stay home, and so does all of a segment
 * that shows no answer, still running or ending in work, so a share never
 * carries the process.
 */
export function projectLanShareTurnItems(
  items: readonly LanShareTurnItem[],
  finished: boolean
): LanShareTurnItem[] {
  if (!finished) return [];
  return lanShareSegments(items.filter((item) => item.type !== 'subagent_task')).flatMap(
    (segment) => {
      const work = lanShareWorkOf(segment);
      if (!lanShareAnswered(segment, work)) return [];
      return segment.flatMap((item, index) => {
        if (work.has(index) || textOf(item)?.trim() === '') return [];
        const rebuilt = publicItem(item);
        return rebuilt ? [rebuilt] : [];
      });
    }
  );
}

/** The named fields of `value` that hold text. */
function texts(value: unknown, keys: readonly string[]) {
  const picked: { [key: string]: string } = {};
  if (!isRecord(value)) return picked;
  for (const key of keys) {
    const text = value[key];
    if (typeof text === 'string' && text.trim() !== '') picked[key] = text;
  }
  return picked;
}

/**
 * The agent that wrote an entry, as a reader is told: its name or Role, its
 * model and its effort, and none of its ids. An assistant turn records the
 * model that ran and the effort's label (`modelInfo`), which the desktop shows
 * and which is said before what the author was configured with. Nothing for a
 * person, whose author holds only an id.
 */
function publicAuthor(entry: { readonly [key: string]: unknown }) {
  const author = isRecord(entry.author) && entry.author.kind === 'agent' ? entry.author : null;
  const ran = entry.role === 'assistant' && isRecord(entry.modelInfo) ? entry.modelInfo : null;
  if (!author && !ran) return {};
  const role = texts(author?.role, ['name', 'emoji']);
  const configured = texts(author?.model, ['id', 'name']);
  // The agent's own label for the model, less the mark of its default.
  const name = texts(ran, ['name']).name?.replace(/\s*\(recommended\)/gi, '') ?? configured.name;
  const id = texts(ran, ['modelId']).modelId ?? configured.id;
  const effort = texts(ran?._meta, ['lodyThoughtLevel']).lodyThoughtLevel;
  return {
    author: {
      kind: 'agent',
      ...texts(author, ['name', 'reasoningEffort']),
      ...(effort ? { reasoningEffort: effort } : {}),
      ...(role.name ? { role } : {}),
      ...(id ? { model: { id, ...(name ? { name } : {}) } } : {}),
    },
  };
}

/** Whether an assistant turn ended, as the reader tells it. */
export const isLanShareTurnFinished = (entry: LanShareTurnItem): boolean =>
  entry.finished === true || typeof entry.endedAt === 'number';

/**
 * Whether an assistant turn is one a LAN published: its answers only, already
 * folded by these rules, so a reader shows it as it is. Folded again, a picture
 * between the answers of two segments would read as the work before the last
 * one. A turn without the mark, of a full history or of a share published
 * before turns carried it, is folded as usual.
 */
export const isLanShareAnswerOnly = (entry: LanShareTurnItem): boolean => entry.answerOnly === true;

/**
 * A conversation's history as a LAN publishes it, every entry rebuilt from the
 * fields a reader reads: the user's messages as they were sent, and of each
 * assistant turn what {@link projectLanShareTurnItems} keeps, with its times
 * and the mark of {@link isLanShareAnswerOnly}.
 * An entry an agent wrote also says which agent, model and effort.
 * Entries of other roles are dropped, and so is an assistant turn with nothing
 * left. The history itself is not changed.
 */
export function projectLanShareHistory(history: unknown): unknown[] {
  if (!Array.isArray(history)) return [];
  return history.flatMap<unknown>((entry: unknown) => {
    if (!isRecord(entry)) return [];
    if (entry.role === 'user') {
      const blocks = isRecord(entry.inputConfig) ? entry.inputConfig.inputBlocks : undefined;
      return [
        {
          ...pick(entry, ['id', 'role', 'timestamp']),
          ...(entry.items !== undefined ? { items: sentItems(entry.items) } : {}),
          ...publicAuthor(entry),
          // Older histories kept a message's content only in its input blocks.
          ...(Array.isArray(blocks) ? { inputConfig: { inputBlocks: sentItems(blocks) } } : {}),
        },
      ];
    }
    if (entry.role !== 'assistant') return [];
    const items = Array.isArray(entry.items) ? entry.items.filter(isRecord) : [];
    const kept = projectLanShareTurnItems(items, isLanShareTurnFinished(entry));
    if (kept.length === 0) return [];
    return [
      {
        ...pick(entry, ['id', 'role', 'timestamp', 'finished', 'endedAt', 'permissionWaitMs']),
        ...publicAuthor(entry),
        answerOnly: true,
        items: kept,
      },
    ];
  });
}
