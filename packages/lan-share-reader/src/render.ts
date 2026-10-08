// Turns the history JSON of a shared conversation into a page. Everything a
// conversation says goes in as text, except Markdown, which micromark renders
// with raw HTML escaped and unsafe link targets dropped.
import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';
import {
  isLanShareActivity as isActivity,
  isLanShareTurnFinished,
  lanShareAnswered,
  lanShareSegments,
  lanShareWorkOf as workOf,
} from '../../shared/src/lan-share-visible';

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

/** What a group of steps did, counted as the desktop counts it. */
type Activity = {
  commands: number;
  readFiles: number;
  editedFiles: number;
  searches: number;
  fetches: number;
  tools: number;
};

export type Strings = {
  tool: string;
  untitled: string;
  unavailable: string;
  updated: string;
  image: string;
  /** The row a finished turn's work folds into, as the desktop words it. */
  workedFor: (duration: string) => string;
  /** That row when the history holds no duration for the turn. */
  steps: (count: number) => string;
  /** That row when there is neither a duration nor a step to count. */
  finished: string;
  units: { hour: string; minute: string; second: string; separator: string };
  /** The row of a group of steps names each kind it did. */
  activity: { [Kind in keyof Activity]: (count: number) => string };
};

const plural = (count: number, one: string, other: string) =>
  (count === 1 ? one : other).replace('{n}', String(count));

export const STRINGS: Record<'en' | 'zh', Strings> = {
  en: {
    tool: 'Tool',
    untitled: 'Untitled conversation',
    unavailable: 'This conversation is not available.',
    updated: 'Updated',
    image: 'Image',
    workedFor: (duration) => `Worked for ${duration}`,
    steps: (count) => plural(count, 'Took {n} step', 'Took {n} steps'),
    finished: 'Finished working',
    units: { hour: 'h', minute: 'm', second: 's', separator: ' ' },
    activity: {
      commands: (count) => plural(count, 'Ran {n} command', 'Ran {n} commands'),
      readFiles: (count) => plural(count, 'Read {n} file', 'Read {n} files'),
      editedFiles: (count) => plural(count, 'Edited {n} file', 'Edited {n} files'),
      searches: (count) => plural(count, 'Ran {n} search', 'Ran {n} searches'),
      fetches: (count) => plural(count, 'Fetched {n} resource', 'Fetched {n} resources'),
      tools: (count) => plural(count, 'Called {n} tool', 'Called {n} tools'),
    },
  },
  zh: {
    tool: '工具',
    untitled: '未命名对话',
    unavailable: '这个对话无法打开。',
    updated: '更新于',
    image: '图片',
    workedFor: (duration) => `工作了${duration}`,
    steps: (count) => `已处理 ${count} 步`,
    finished: '已完成工作',
    units: { hour: '时', minute: '分', second: '秒', separator: '' },
    activity: {
      commands: (count) => `调用了 ${count} 个命令`,
      readFiles: (count) => `阅读了 ${count} 个文件`,
      editedFiles: (count) => `编辑了 ${count} 个文件`,
      searches: (count) => `进行了 ${count} 次搜索`,
      fetches: (count) => `获取了 ${count} 项内容`,
      tools: (count) => `调用了 ${count} 个工具`,
    },
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
// before it (thinking, tool calls, short narration) folds into one row. The
// rules are those the window publishes by, in `lan-share-visible.ts` of
// `@lody/shared`, which imports nothing and is bundled by its path.

const isShownStep = (item: JsonObject): boolean =>
  item.type === 'tool_call' && item.kind !== 'think';

/** A retry the agent already got past; the desktop shows none. */
const isSettledRetry = (item: JsonObject): boolean =>
  item.type === 'tool_call' &&
  item.activityKind === 'codex_retry' &&
  item.status !== 'pending' &&
  item.status !== 'in_progress';

function toolPaths(item: JsonObject): string[] {
  const paths = new Set<string>();
  for (const location of Array.isArray(item.locations) ? item.locations : []) {
    const at = isObject(location) ? str(location.path) : null;
    if (at) paths.add(at);
  }
  for (const block of Array.isArray(item.content) ? item.content : []) {
    const at = isObject(block) && block.type === 'diff' ? str(block.path) : null;
    if (at) paths.add(at);
  }
  return [...paths];
}

const hasCommand = (item: JsonObject): boolean =>
  (Array.isArray(item.content) ? item.content : []).some(
    (block) => isObject(block) && block.type === 'terminal_command'
  );

/** What a group did; files read or edited more than once count once. */
function summarize(items: JsonObject[]): Activity {
  const read = new Set<string>();
  const edited = new Set<string>();
  const activity: Activity = {
    commands: 0,
    readFiles: 0,
    editedFiles: 0,
    searches: 0,
    fetches: 0,
    tools: 0,
  };
  for (const item of items) {
    if (item.type !== 'tool_call' || item.kind === 'think') continue;
    const paths = toolPaths(item);
    switch (item.kind) {
      case 'execute':
      case 'bash':
        activity.commands += 1;
        break;
      case 'read':
        if (paths.length === 0) activity.readFiles += 1;
        for (const at of paths) read.add(at);
        break;
      case 'edit':
      case 'write':
      case 'delete':
      case 'move':
        if (paths.length === 0) activity.editedFiles += 1;
        for (const at of paths) edited.add(at);
        break;
      case 'search':
        activity.searches += 1;
        break;
      case 'fetch':
        activity.fetches += 1;
        break;
      default:
        if (hasCommand(item)) activity.commands += 1;
        else activity.tools += 1;
    }
  }
  activity.readFiles += read.size;
  activity.editedFiles += edited.size;
  return activity;
}

/** A run of steps as one folded row; `null` when it holds nothing a reader is shown. */
function activityGroup(context: RenderContext, items: JsonObject[]): HTMLElement | null {
  const steps = items
    .filter(isShownStep)
    .map((item) => renderItem(context, item))
    .filter((node): node is HTMLElement => node !== null);
  if (steps.length === 0) return null;
  const activity = summarize(items);
  const label = (Object.keys(activity) as Array<keyof Activity>)
    .filter((kind) => activity[kind] > 0)
    .map((kind) => context.strings.activity[kind](activity[kind]))
    .join(' · ');
  return folded(context.document, 'group', label, steps);
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
  const nodes = new Map<JsonObject, HTMLElement>();
  const kept: JsonObject[] = [];
  const tasks: HTMLElement[] = [];
  for (const item of items) {
    if (!isObject(item) || isSettledRetry(item)) continue;
    // Subagent tasks follow the turn's last segment, as on the desktop.
    if (item.type === 'subagent_task') {
      const node = renderItem(context, item);
      if (node) tasks.push(node);
      continue;
    }
    if (isActivity(item)) {
      kept.push(item);
      continue;
    }
    const node = renderItem(context, item);
    if (!node) continue;
    nodes.set(item, node);
    kept.push(item);
  }
  const finished = isLanShareTurnFinished(entry);
  // A plan's exit card closes a segment of its own, folded on its own.
  const segments = lanShareSegments(kept);
  const duration = durationOf(entry);
  return segments.flatMap((segment, index) => {
    const last = index === segments.length - 1;
    const segmentTasks = last ? tasks : [];
    const work = finished ? workOf(segment) : new Set<number>();
    const shown: HTMLElement[] = [];
    const folding: HTMLElement[] = [];
    let steps = segmentTasks.length;
    for (let at = 0; at < segment.length;) {
      let end = at + 1;
      let node: HTMLElement | null | undefined;
      if (isActivity(segment[at])) {
        while (end < segment.length && isActivity(segment[end])) end += 1;
        const run = segment.slice(at, end);
        node = activityGroup(context, run);
        steps += run.filter(isShownStep).length;
      } else {
        node = nodes.get(segment[at]);
      }
      if (node) {
        shown.push(node);
        if (work.has(at)) folding.push(node);
      }
      at = end;
    }
    shown.push(...segmentTasks);
    folding.push(...segmentTasks);
    const answered = lanShareAnswered(segment, work);
    // Thinking alone is work too: the row then says how long the turn took.
    if (!finished || !answered || (work.size === 0 && segmentTasks.length === 0)) return shown;
    // The turn's duration covers every segment, so only the last claims it.
    const label =
      duration !== null && last
        ? context.strings.workedFor(formatDuration(duration, context.strings.units))
        : steps > 0
          ? context.strings.steps(steps)
          : context.strings.finished;
    return [workedRow(context.document, label, folding), ...shown];
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
