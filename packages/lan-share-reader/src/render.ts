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
};

export const STRINGS: Record<'en' | 'zh', Strings> = {
  en: {
    thinking: 'Thinking',
    tool: 'Tool',
    untitled: 'Untitled conversation',
    unavailable: 'This conversation is not available.',
    updated: 'Updated',
    image: 'Image',
  },
  zh: {
    thinking: '思考',
    tool: '工具',
    untitled: '未命名对话',
    unavailable: '这个对话无法打开。',
    updated: '更新于',
    image: '图片',
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
  details.append(element(document, 'summary', undefined, summary), ...body);
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
    const nodes = items
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
