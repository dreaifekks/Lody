/**
 * A comparison of UI options (experimental): one `<name>.compare.md` per
 * question, listing the options as links to files beside it. The list's
 * order names them A, B, C…, so "B" in a reply means the second link.
 *
 *     ---
 *     viewport: 1280x800
 *     ---
 *     # Settings navigation
 *
 *     Only the navigation differs.
 *
 *     - [Sidebar](nav-a.html) clear hierarchy, narrower content
 *     - [Top tabs](nav-b.html)
 *     - [Phone](nav-c.html) 390x844
 *
 * Anywhere that does not know the format it is still a Markdown list of links.
 */

export const isCompareManifestPath = (path: string): boolean => /\.compare\.md$/iu.test(path);

export interface CompareSize {
  readonly width: number;
  readonly height: number;
}

export interface CompareVariant {
  /** A, B, C… by position. */
  readonly letter: string;
  readonly label: string;
  /** The words after the link, without a size. */
  readonly note: string;
  /** Workspace path, resolved against the manifest's directory. */
  readonly path: string;
  readonly kind: 'html' | 'image';
  readonly size: CompareSize;
}

export interface CompareManifest {
  /** The first `# ` heading, if any. */
  readonly title: string | null;
  /** Everything but the frontmatter, the title and the options: shown above them. */
  readonly intro: string;
  readonly variants: readonly CompareVariant[];
}

export const DEFAULT_COMPARE_SIZE: CompareSize = { width: 1280, height: 800 };

const SIZE = /(?:^|\s)(\d{2,5})\s*[x×]\s*(\d{2,5})\s*$/u;
const VARIANT_ITEM =
  /^\s*(?:[-*+]|\d+[.)])\s+\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)(.*)$/u;
const KIND: readonly [RegExp, CompareVariant['kind']][] = [
  [/\.html?$/iu, 'html'],
  [/\.(?:png|jpe?g|gif|webp|svg)$/iu, 'image'],
];

const letterOf = (index: number): string =>
  index < 26
    ? String.fromCharCode(65 + index)
    : `${letterOf(Math.floor(index / 26) - 1)}${String.fromCharCode(65 + (index % 26))}`;

const parseSize = (text: string): CompareSize | null => {
  const match = SIZE.exec(text);
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
};

/** `path` from the manifest's directory; `..` past the workspace root stays out. */
export function resolveCompareRelativePath(manifestPath: string, path: string): string {
  const parts = manifestPath.split('/').slice(0, -1);
  for (const segment of decodeURI(path).split('/')) {
    if (segment === '..') parts.pop();
    else if (segment !== '.' && segment !== '') parts.push(segment);
  }
  return parts.join('/');
}

export function parseCompareManifest(text: string, manifestPath: string): CompareManifest {
  let body = text.replace(/\r\n?/gu, '\n');
  let viewport = DEFAULT_COMPARE_SIZE;
  const front = /^---\n([\s\S]*?)\n---\n?/u.exec(body);
  if (front) {
    body = body.slice(front[0].length);
    const line = /^viewport\s*:\s*(.+)$/mu.exec(front[1]);
    viewport = (line && parseSize(` ${line[1].trim()}`)) ?? viewport;
  }
  let title: string | null = null;
  const variants: CompareVariant[] = [];
  const intro: string[] = [];
  for (const line of body.split('\n')) {
    const heading = /^#\s+(.+?)\s*#*\s*$/u.exec(line);
    if (heading && title === null) {
      title = heading[1];
      continue;
    }
    const item = VARIANT_ITEM.exec(line);
    const kind = item && KIND.find(([pattern]) => pattern.test(item[2]))?.[1];
    if (!item || !kind || /^[a-z][a-z0-9+.-]*:/iu.test(item[2])) {
      intro.push(line);
      continue;
    }
    const rest = item[3].trim();
    const size = parseSize(rest);
    variants.push({
      letter: letterOf(variants.length),
      label: item[1].trim() || item[2],
      note: (size ? rest.replace(SIZE, '') : rest).replace(/^[-–—:：\s]+/u, '').trim(),
      path: resolveCompareRelativePath(manifestPath, item[2]),
      kind,
      size: size ?? viewport,
    });
  }
  return { title, intro: intro.join('\n').trim(), variants };
}

/** Tells two revisions of a file apart without keeping either (FNV-1a). */
export function compareContentHash(content: string | Uint8Array): string {
  let hash = 0x811c9dc5;
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193);
  return (hash >>> 0).toString(36);
}
