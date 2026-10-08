// The page a LAN hub serves at `/s/<id>`: it reads the share's manifest once,
// pins the deployment it names, and reads each conversation's history from
// that deployment when it is opened.
import {
  STRINGS,
  orderConversations,
  renderHistory,
  type Json,
  type Manifest,
  type RenderContext,
} from './render';

/** The packaged Lody icon, which the hub serves beside this script. */
const LODY_ICON_PATH = '/_lody/lody-icon.png';

type Share = { title: string; updatedAt: string; deployment: string; manifest: Manifest };

const strings = navigator.language.toLowerCase().startsWith('zh') ? STRINGS.zh : STRINGS.en;
const app = document.getElementById('app') ?? document.body;
const shareId = /^\/s\/([A-Za-z0-9_-]{32})\/?$/u.exec(location.pathname)?.[1];

function fail(): void {
  app.replaceChildren(
    Object.assign(document.createElement('p'), {
      className: 'empty',
      textContent: strings.unavailable,
    })
  );
}

async function readJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: 'no-store', credentials: 'omit' });
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return (await response.json()) as T;
}

async function open(): Promise<void> {
  if (!shareId) {
    fail();
    return;
  }
  const share = await readJson<Share>(`/s/${shareId}/share.json`);
  const base = `/s/${shareId}/d/${share.deployment}`;
  const context: RenderContext = {
    document,
    strings,
    manifest: share.manifest,
    objectUrl: (objectId) => `${base}/${encodeURIComponent(objectId)}`,
  };
  const conversations = new Map(share.manifest.conversations.map((entry) => [entry.id, entry]));
  const histories = new Map<string, Promise<Json>>();
  const titleOf = (id: string) => conversations.get(id)?.title || strings.untitled;
  const shareTitle = share.title || titleOf(share.manifest.rootConversationId);
  // The hub wrote the same title into the page it served.
  document.title = `${shareTitle} · Lody LAN`;

  const header = document.createElement('header');
  const brand = Object.assign(document.createElement('div'), { className: 'brand' });
  const tile = Object.assign(document.createElement('span'), { className: 'tile' });
  tile.append(Object.assign(document.createElement('img'), { src: LODY_ICON_PATH, alt: '' }));
  brand.append(tile, 'Lody LAN');
  const title = Object.assign(document.createElement('h1'), { textContent: shareTitle });
  const updated = Object.assign(document.createElement('p'), {
    className: 'meta',
    textContent: `${strings.updated} ${new Date(share.updatedAt).toLocaleString()}`,
  });
  header.append(brand, title, updated);

  const order = orderConversations(share.manifest);
  const nav = document.createElement('nav');
  const body = document.createElement('section');
  const links = new Map<string, HTMLAnchorElement>();
  if (order.length > 1) {
    for (const { id, depth } of order) {
      const link = Object.assign(document.createElement('a'), {
        href: `#${id}`,
        textContent: titleOf(id),
      });
      link.style.paddingInlineStart = `${depth * 16 + 8}px`;
      links.set(id, link);
      nav.append(link);
    }
  }

  const show = async () => {
    const requested = location.hash.slice(1);
    const id = conversations.has(requested) ? requested : share.manifest.rootConversationId;
    const conversation = conversations.get(id);
    if (!conversation) return;
    for (const [linkId, link] of links) link.classList.toggle('current', linkId === id);
    let history = histories.get(id);
    if (!history) {
      // A read that completed stays for the life of the page.
      history = readJson<Json>(`${base}/${encodeURIComponent(conversation.historyObjectId)}`);
      histories.set(id, history);
      history.catch(() => histories.delete(id));
    }
    try {
      const rendered = renderHistory(context, await history);
      const heading = Object.assign(document.createElement('h2'), { textContent: titleOf(id) });
      // The page's title already names the root conversation.
      body.replaceChildren(
        ...(id === share.manifest.rootConversationId ? [] : [heading]),
        rendered
      );
    } catch {
      body.replaceChildren(
        Object.assign(document.createElement('p'), {
          className: 'empty',
          textContent: strings.unavailable,
        })
      );
    }
  };

  app.replaceChildren(header, ...(order.length > 1 ? [nav] : []), body);
  window.addEventListener('hashchange', () => void show());
  await show();
}

open().catch(fail);
