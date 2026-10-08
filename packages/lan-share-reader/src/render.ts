// Turns the history JSON of a shared conversation into a page. Everything a
// conversation says goes in as text, except Markdown, which micromark renders
// with raw HTML escaped and unsafe link targets dropped.
import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

export type Manifest = {
  rootConversationId: string;
  conversations: Array<{
    id: string;
    title: string;
    historyObjectId: string;
    parentConversationId?: string;
    openedByConversationId?: string;
  }>;
  attachments: Array<{ id: string; kind: 'image' | 'file'; objectId: string }>;
};

export type Strings = {
  thinking: string;
  tool: string;
  untitled: string;
  unavailable: string;
  updated: string;
  image: string;
  /** The row a finished turn's work folds into, as the desktop words it. */
  workedFor: (duration: string) => string;
  /** That row when the history holds no duration for the turn. */
  steps: (count: number) => string;
  units: { hour: string; minute: string; second: string; separator: string };
};

export const STRINGS: Record<'en' | 'zh', Strings> = {
  en: {
    thinking: 'Thinking',
    tool: 'Tool',
    untitled: 'Untitled conversation',
    unavailable: 'This conversation is not available.',
    updated: 'Updated',
    image: 'Image',
    workedFor: (duration) => `Worked for ${duration}`,
    steps: (count) => (count === 1 ? 'Took 1 step' : `Took ${count} steps`),
    units: { hour: 'h', minute: 'm', second: 's', separator: ' ' },
  },
  zh: {
    thinking: '思考',
    tool: '工具',
    untitled: '未命名对话',
    unavailable: '这个对话无法打开。',
    updated: '更新于',
    image: '图片',
    workedFor: (duration) => `工作了${duration}`,
    steps: (count) => `已处理 ${count} 步`,
    units: { hour: '时', minute: '分', second: '秒', separator: '' },
  },
};

/** The longest text of a tool payload shown in full. */
const PAYLOAD_LIMIT = 20_000;

export function renderMarkdown(text: string): string {
  return micromark(text, { extensions: [gfm()], htmlExtensions: [gfmHtml()] });
}

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: Json | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function markdown(document: Document, text: string, className = 'md'): HTMLElement {
  const node = element(document, 'div', className);
  node.innerHTML = renderMarkdown(text);
  return node;
}

function clip(text: string): string {
  return text.length > PAYLOAD_LIMIT ? `${text.slice(0, PAYLOAD_LIMIT)}\n…` : text;
}

function pre(document: Document, text: string): HTMLElement {
  return element(document, 'pre', undefined, clip(text));
}

function folded(document: Document, className: string, summary: string, body: Node[]) {
  const details = element(document, 'details', className);
  const row = element(document, 'summary');
  row.append(element(document, 'span', 'label', summary));
  details.append(row, ...body);
  return details;
}

export type RenderContext = {
  document: Document;
  strings: Strings;
  /** Where the bytes of an attachment of this deployment are read. */
  objectUrl: (objectId: string) => string;
  manifest: Manifest;
};

function image(context: RenderContext, block: JsonObject): HTMLElement | null {
  const id = str(block.imageId);
  const attachment = context.manifest.attachments.find((entry) => entry.id === id);
  if (!attachment || attachment.kind !== 'image') return null;
  const node = element(context.document, 'img', 'image');
  node.src = context.objectUrl(attachment.objectId);
  node.alt = str(block.fileName) ?? context.strings.image;
  node.loading = 'lazy';
  return node;
}

/** Restores a title the capture left out because it repeated the first command. */
function toolTitle(item: JsonObject, strings: Strings): string {
  const content = Array.isArray(item.content) ? item.content : [];
  const command = content.find((block) => isObject(block) && block.type === 'terminal_command');
  return (
    str(item.title) ??
    (isObject(command) ? str(command.command) : null) ??
    str(item.toolName) ??
    str(item.kind) ??
    strings.tool
  );
}

function toolBody(context: RenderContext, item: JsonObject): Node[] {
  const { document } = context;
  const body: Node[] = [];
  const content = Array.isArray(item.content) ? item.content : [];
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type === 'terminal_command') {
      const args = Array.isArray(block.args) ? block.args.map((arg) => String(arg)) : [];
      body.push(pre(document, `$ ${[str(block.command) ?? '', ...args].join(' ')}`));
    } else if (block.type === 'diff') {
      const lines = [
        str(block.path) ?? '',
        ...(str(block.oldText) ?? '').split('\n').map((line) => `- ${line}`),
        ...(str(block.newText) ?? '').split('\n').map((line) => `+ ${line}`),
      ];
      body.push(pre(document, lines.join('\n')));
    } else if (block.type === 'content' && isObject(block.content)) {
      const inner = block.content;
      const text =
        str(inner.text) ?? (isObject(inner.resource) ? str(inner.resource.text) : null) ?? null;
      if (text !== null) body.push(pre(document, text));
    }
  }
  if (body.length === 0 && item.rawInput !== undefined) {
    body.push(pre(document, JSON.stringify(item.rawInput, null, 2)));
  }
  if (content.length === 0 && item.rawOutput !== undefined) {
    const output = item.rawOutput;
    body.push(pre(document, typeof output === 'string' ? output : JSON.stringify(output, null, 2)));
  }
  return body;
}

function renderItem(context: RenderContext, item: Json): HTMLElement | null {
  const { document, strings } = context;
  if (!isObject(item)) return null;
  switch (item.type) {
    case 'text': {
      const text = str(item.text);
      return text?.trim() ? markdown(document, text) : null;
    }
    case 'thought': {
      const text = str(item.text);
      return text?.trim()
        ? folded(document, 'thought', strings.thinking, [markdown(document, text)])
        : null;
    }
    case 'proposed_plan': {
      const text = str(item.markdown);
      return text?.trim() && item.status !== 'cleared' ? markdown(document, text) : null;
    }
    case 'plan': {
      const entries = Array.isArray(item.entries) ? item.entries : [];
      if (entries.length === 0) return null;
      const list = element(document, 'ul', 'plan');
      for (const entry of entries) {
        if (!isObject(entry)) continue;
        const row = element(document, 'li', undefined, str(entry.content) ?? '');
        if (entry.status === 'completed') row.className = 'done';
        list.append(row);
      }
      return list;
    }
    case 'tool_call': {
      const status = str(item.status);
      const node = folded(document, 'tool', toolTitle(item, strings), toolBody(context, item));
      if (status === 'failed') node.classList.add('failed');
      return node;
    }
    case 'image':
      return image(context, item);
    case 'image_group': {
      const images = (Array.isArray(item.images) ? item.images : [])
        .map((entry) => (isObject(entry) ? image(context, entry) : null))
        .filter((node): node is HTMLElement => node !== null);
      if (images.length === 0) return null;
      const group = element(document, 'div', 'images');
      group.append(...images);
      return group;
    }
    case 'subagent_task': {
      const name = str(item.description) ?? str(item.subagentType) ?? str(item.taskType);
      return name ? element(document, 'p', 'subagent', name) : null;
    }
    default:
      return null;
  }
}

// A finished turn reads like the desktop's: its answer shows, and the work
// before it (thinking, tool calls, short narration) folds into one row. These
// rules follow `ai-gui/message-copy.ts` and `assistant-turn-render-blocks.ts`
// of `@lody/components`, which this page may not import.

/** Length from which earlier text in a turn reads as content, not narration. */
const SUBSTANTIVE_TEXT_MIN_CHARS = 300;
const STRUCTURED_TEXT_PATTERN = /(?:^|\n)[ \t]*(?:[-*+] |\d+[.)] |\||#{1,6} )/;

const isSubstantiveText = (text: string): boolean =>
  text.trim().length >= SUBSTANTIVE_TEXT_MIN_CHARS || STRUCTURED_TEXT_PATTERN.test(text);

const isPlanExit = (item: JsonObject): boolean =>
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

const isNeverFolded = (item: JsonObject): boolean =>
  (typeof item.type === 'string' && NEVER_FOLDED.has(item.type)) || isPlanExit(item);

/** A step of the work: it folds whenever the turn has an answer to show. */
const isStep = (item: JsonObject): boolean =>
  item.type === 'thought' ||
  item.type === 'subagent_task' ||
  (item.type === 'tool_call' && !isPlanExit(item) && item.activityKind === undefined);

const textOf = (item: JsonObject | undefined): string | null =>
  item?.type === 'text' ? (str(item.text) ?? '') : null;

/** Where the closing run of text begins; `items.length` when the turn ends in work. */
function finalTextRunStart(items: JsonObject[]): number {
  let index = items.length - 1;
  while (index >= 0 && isNeverFolded(items[index])) index -= 1;
  if (textOf(items[index]) === null) return items.length;
  while (index > 0 && textOf(items[index - 1]) !== null) index -= 1;
  return index;
}

/** The closing text run, and the run before the last work too when the closing one is thin. */
function visibleTextStart(items: JsonObject[]): number {
  const start = finalTextRunStart(items);
  if (start >= items.length) return start;
  const closing = items
    .slice(start)
    .map((item) => textOf(item) ?? '')
    .join('\n\n');
  if (isSubstantiveText(closing)) return start;
  let index = start - 1;
  while (index >= 0 && textOf(items[index]) === null) index -= 1;
  if (index < 0) return start;
  while (index > 0 && textOf(items[index - 1]) !== null) index -= 1;
  return index;
}

/** The indexes of a segment's items that fold, or none when no answer would remain. */
function workOf(items: JsonObject[]): Set<number> {
  const visibleStart = visibleTextStart(items);
  const work = new Set<number>();
  items.forEach((item, index) => {
    const text = textOf(item);
    const keepsText =
      text !== null &&
      visibleStart < items.length &&
      (index >= visibleStart || isSubstantiveText(text));
    const folds =
      isStep(item) ||
      (items.length > 1 && index < items.length - 1 && !keepsText && !isNeverFolded(item));
    if (folds) work.add(index);
  });
  const answered = items.some((item, index) => !work.has(index) && item.type !== 'system_notice');
  return answered ? work : new Set();
}

function formatDuration(ms: number, units: Strings['units']): string {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  const { hour, minute, second, separator } = units;
  if (hours > 0)
    return `${hours}${hour}${separator}${pad(minutes)}${minute}${separator}${pad(seconds)}${second}`;
  if (minutes > 0) return `${minutes}${minute}${separator}${pad(seconds)}${second}`;
  return `${seconds}${second}`;
}

/** The turn's working time, less any wait for permission; `null` when not recorded. */
function durationOf(entry: JsonObject): number | null {
  const endedAt = entry.endedAt;
  const startedAt = Date.parse(str(entry.timestamp) ?? '');
  if (typeof endedAt !== 'number' || !Number.isFinite(startedAt) || endedAt < startedAt) {
    return null;
  }
  const wait = typeof entry.permissionWaitMs === 'number' ? entry.permissionWaitMs : 0;
  return Math.max(0, endedAt - startedAt - Math.max(0, wait));
}

/** The row that shows or hides a segment's work, which stays in place between the answer's text. */
function workedRow(document: Document, label: string, work: HTMLElement[]): HTMLElement {
  const row = element(document, 'button', 'worked');
  row.type = 'button';
  row.append(element(document, 'span', 'label', label));
  row.setAttribute('aria-expanded', 'false');
  for (const node of work) node.hidden = true;
  row.addEventListener('click', () => {
    const expanded = row.getAttribute('aria-expanded') !== 'true';
    row.setAttribute('aria-expanded', String(expanded));
    for (const node of work) node.hidden = !expanded;
  });
  return row;
}

function renderAssistant(context: RenderContext, entry: JsonObject, items: Json[]): HTMLElement[] {
  const rendered = items.flatMap((item) => {
    const node = renderItem(context, item);
    return node && isObject(item) ? [{ item, node }] : [];
  });
  if (entry.finished !== true && typeof entry.endedAt !== 'number') {
    return rendered.map(({ node }) => node);
  }
  // A plan's exit card closes a segment of its own, folded on its own.
  const segments: Array<typeof rendered> = [];
  let current: typeof rendered = [];
  for (const part of rendered) {
    current.push(part);
    if (isPlanExit(part.item)) {
      segments.push(current);
      current = [];
    }
  }
  // A turn ending exactly on the card leaves no segment after it.
  if (current.length > 0 || segments.length === 0) segments.push(current);
  const duration = durationOf(entry);
  return segments.flatMap((segment, index) => {
    const work = workOf(segment.map(({ item }) => item));
    const nodes = segment.map(({ node }) => node);
    if (work.size === 0) return nodes;
    // The turn's duration covers every segment, so only the last claims it.
    const label =
      duration !== null && index === segments.length - 1
        ? context.strings.workedFor(formatDuration(duration, context.strings.units))
        : context.strings.steps(
            segment.filter(({ item }, at) => work.has(at) && isStep(item)).length
          );
    const row = workedRow(
      context.document,
      label,
      nodes.filter((_, at) => work.has(at))
    );
    return [row, ...nodes];
  });
}

/** One conversation's history; entries of other roles, and unknown items, are left out. */
export function renderHistory(context: RenderContext, history: Json): HTMLElement {
  const list = element(context.document, 'div', 'history');
  for (const entry of Array.isArray(history) ? history : []) {
    if (!isObject(entry) || (entry.role !== 'user' && entry.role !== 'assistant')) continue;
    let items = Array.isArray(entry.items) ? entry.items : [];
    // Older histories kept a message's content only in its input blocks.
    if (items.length === 0 && isObject(entry.inputConfig)) {
      const blocks = entry.inputConfig.inputBlocks;
      if (Array.isArray(blocks)) items = blocks;
    }
    const nodes =
      entry.role === 'assistant'
        ? renderAssistant(context, entry, items)
        : items
            .map((item) => renderItem(context, item))
            .filter((node): node is HTMLElement => node !== null);
    if (nodes.length === 0) continue;
    const message = element(context.document, 'article', `message ${entry.role}`);
    message.append(...nodes);
    list.append(message);
  }
  return list;
}

/** The conversations in reading order: each followed by those it opened or contains. */
export function orderConversations(manifest: Manifest): Array<{ id: string; depth: number }> {
  const children = new Map<string, string[]>();
  for (const conversation of manifest.conversations) {
    const owner = conversation.parentConversationId ?? conversation.openedByConversationId;
    if (!owner) continue;
    children.set(owner, [...(children.get(owner) ?? []), conversation.id]);
  }
  const ordered: Array<{ id: string; depth: number }> = [];
  const seen = new Set<string>();
  const visit = (id: string, depth: number) => {
    if (seen.has(id)) return;
    seen.add(id);
    ordered.push({ id, depth });
    for (const child of children.get(id) ?? []) visit(child, depth + 1);
  };
  visit(manifest.rootConversationId, 0);
  for (const conversation of manifest.conversations) visit(conversation.id, 0);
  return ordered;
}
