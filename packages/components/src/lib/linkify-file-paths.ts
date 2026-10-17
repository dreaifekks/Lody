import { isRecognizedFilePath } from '@/components/icons/file-icons/mappings';
import { parseMarkdownAgentFileHref } from './markdown-agent-file-link';

// Auto-detect bare file paths in agent Markdown (text nodes + inline code) and
// turn them into the same clickable file chips that explicit `[text](path)`
// links already render. Unlike URLs, bare paths have no unambiguous marker
// (`https://`), so detection is intentionally conservative to avoid turning
// prose like `and/or`, `Math.max`, or `Node.js` into broken file links:
//
//   - prose (plain text): require a path separator with a real extension
//     (`a/b/foo.ts`) OR an explicit line suffix (`foo.ts:32`, `foo.ts:L32`).
//   - inline code: the ENTIRE backtick content must be a single recognized
//     file path; partial spans inside commands/snippets are left as code.
//
// Wrongly-linkified paths fail open: the file viewer's open handler already
// degrades gracefully when a path cannot be resolved.

export type FilePathTextSegment = { type: 'text'; value: string } | { type: 'path'; value: string };

// One greedy run of path-ish characters, plus an optional GitHub/VSCode/colon
// line suffix. The first segment is ASCII only, so a candidate does not swallow
// the CJK prose in front of it (`详见packages/foo.ts`). Segments after the first
// separator also take letters, marks and digits of any script
// (`notes/准备.md`); whitespace and punctuation, full-width included, end it.
//
// With no space before the prose that follows, such a segment would run on into
// it (`src/foo.ts和src/bar.ts`). So a later segment is read as runs, and an ASCII
// extension (`.` plus letters and digits, at least one letter) that is directly
// followed by a non-ASCII character is the last thing the candidate takes; the
// scan carries on after it. A dot with digits only is part of a name (`v1.2版`).
// Each run is matched whole and nothing after it is required, so a failed
// attempt re-reads only the run it is on and the scan stays linear.
//
// A candidate may start with `./`, `../`, `/` or `~/`. The home prefix has to be
// part of the match: left in the text, the scan would resume at `/self/...` and
// link a path that exists nowhere. Only the session's machine knows its home
// directory, so `~/` travels verbatim and is expanded there; `~user/` is not a
// form we read.
const ASCII_SEGMENT = String.raw`[A-Za-z0-9._-]+`;
const NON_ASCII_RUN = String.raw`(?:(?!\p{ASCII})[\p{L}\p{M}\p{N}])+`;
const ASCII_EXTENSION = String.raw`\.[0-9]*[A-Za-z][A-Za-z0-9]*(?![A-Za-z0-9])`;
const OTHER_DOT = String.raw`\.[0-9]*(?![A-Za-z0-9])`;
const SEGMENT = String.raw`(?=[\p{L}\p{M}\p{N}._-])(?:${NON_ASCII_RUN}|[A-Za-z0-9_-]+|${OTHER_DOT}|${ASCII_EXTENSION}(?!\P{ASCII}))*(?:${ASCII_EXTENSION})?`;
const PATH_PREFIX = String.raw`(?:(?:~|\.{0,2})[\\/])?`;
const LINE_SUFFIX = String.raw`(?:#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?|:L?\d+(?:C\d+)?(?::\d+)?)`;
const CANDIDATE_PATTERN = new RegExp(
  `${PATH_PREFIX}${ASCII_SEGMENT}(?:[\\\\/]${SEGMENT})*(?:${LINE_SUFFIX})?`,
  'gu'
);
// The start of a candidate as far as it is ASCII, which is all it was before
// later segments took other scripts.
const ASCII_CANDIDATE_PATTERN = new RegExp(
  `^${PATH_PREFIX}${ASCII_SEGMENT}(?:[\\\\/]${ASCII_SEGMENT})*(?:${LINE_SUFFIX})?`
);
const NON_ASCII_PATTERN = /\P{ASCII}/u;
const ASCII_EXTENSION_END_PATTERN = /\.[A-Za-z0-9]+$/;

// Paths essentially never end in punctuation, so we can strip a trailing run
// (sentence/quote/bracket chars, incl. full-width CJK) without balancing.
const TRAILING_PUNCT_PATTERN = /[.,;:!?'")\]}>，。！？；：、）】」』》“”‘’]+$/u;

// Bare-host TLDs we treat as "this is probably an unscheme'd URL, not a file".
const URL_LIKE_TLDS = new Set([
  'com',
  'org',
  'net',
  'io',
  'dev',
  'app',
  'co',
  'ai',
  'gov',
  'edu',
  'info',
]);

const stripTrailingPunctuation = (value: string): string => {
  const match = value.match(TRAILING_PUNCT_PATTERN);
  return match ? value.slice(0, value.length - match[0].length) : value;
};

// `example.com/page.html` looks exactly like `dir/file.html`; skip when the
// first segment is a dotted host ending in a known TLD.
const looksLikeBareDomain = (base: string): boolean => {
  const firstSegment = base.split(/[\\/]/, 1)[0] ?? '';
  const labels = firstSegment.split('.');
  if (labels.length < 2) {
    return false;
  }
  const tld = labels[labels.length - 1]?.toLowerCase() ?? '';
  return URL_LIKE_TLDS.has(tld);
};

const qualifiesAsFilePath = (raw: string, context: 'prose' | 'code'): boolean => {
  const parsed = parseMarkdownAgentFileHref(raw);
  if (!parsed) {
    return false;
  }

  const base = parsed.filePath;
  const hasLineSuffix = parsed.startLine != null;
  const hasSlash = base.includes('/');
  const lastSegment = base.slice(base.lastIndexOf('/') + 1);
  const dotIndex = lastSegment.lastIndexOf('.');
  const hasExtension = dotIndex > 0 && dotIndex < lastSegment.length - 1;
  const recognized = isRecognizedFilePath(lastSegment);

  // In prose a path with non-ASCII names has to end in an ASCII extension.
  if (
    context === 'prose' &&
    NON_ASCII_PATTERN.test(base) &&
    !ASCII_EXTENSION_END_PATTERN.test(lastSegment)
  ) {
    return false;
  }

  if (hasSlash) {
    // A separator + extension is a strong path signal on its own.
    return hasExtension && !looksLikeBareDomain(base);
  }

  if (context === 'prose') {
    // No separator in prose: only a line suffix on a recognized file is safe
    // enough (e.g. `app.ts:32`); a lone `app.ts` is too ambiguous in prose.
    return hasLineSuffix && hasExtension && recognized;
  }

  // Inline code, no separator: the author marked it as a token, so a
  // recognized file name/extension is sufficient (`tsconfig.json`, `foo.ts`).
  return hasExtension && recognized;
};

const resolveProsePath = (candidate: string): string | null => {
  const path = stripTrailingPunctuation(candidate);
  return path && qualifiesAsFilePath(path, 'prose') ? path : null;
};

// Split a plain-text node into text / file-path segments. Rejected candidates
// stay as text, so the result round-trips the original string.
export const splitTextIntoFilePathSegments = (value: string): FilePathTextSegment[] => {
  const segments: FilePathTextSegment[] = [];
  CANDIDATE_PATTERN.lastIndex = 0;

  let cursor = 0;
  let match = CANDIDATE_PATTERN.exec(value);
  while (match) {
    const rawMatch = match[0];
    const matchStart = match.index;
    const prevChar = matchStart > 0 ? value[matchStart - 1] : '';

    // Skip the host/path part of an email like `user@example.com/x`, and the
    // tail of a `~user/x` home we do not read.
    const isEmailTail = prevChar === '@' || prevChar === '~';
    // Cheap pre-filter: a real path has a separator, a line/anchor suffix, or
    // a `.ext`. Lone words fall through and stay as text.
    const couldBePath =
      /[\\/]/.test(rawMatch) || /[:#]/.test(rawMatch) || /\.[A-Za-z0-9]/.test(rawMatch);

    if (!isEmailTail && couldBePath) {
      // A candidate that does not hold up as a path with non-ASCII names
      // (`src/a.ts/以及其他`) is still the ASCII path in front of them. The rest
      // of it is not scanned again, so no tail of it turns into a link.
      const path =
        resolveProsePath(rawMatch) ??
        (NON_ASCII_PATTERN.test(rawMatch)
          ? resolveProsePath(ASCII_CANDIDATE_PATTERN.exec(rawMatch)?.[0] ?? '')
          : null);
      if (path) {
        if (matchStart > cursor) {
          segments.push({ type: 'text', value: value.slice(cursor, matchStart) });
        }
        segments.push({ type: 'path', value: path });
        // Leave any stripped trailing punctuation for the next text flush.
        cursor = matchStart + path.length;
      }
    }

    match = CANDIDATE_PATTERN.exec(value);
  }

  if (cursor < value.length) {
    segments.push({ type: 'text', value: value.slice(cursor) });
  }

  return segments;
};

// For inline code: returns the path when the ENTIRE content is one file path,
// else null (leave it rendered as code).
export const matchWholeFilePath = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    return null;
  }

  return qualifiesAsFilePath(trimmed, 'code') ? trimmed : null;
};
