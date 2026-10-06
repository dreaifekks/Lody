import type { SessionHistory } from '@lody/shared';

/**
 * The text protocol between a realtime voice call and the session's agent.
 *
 * The realtime voice runs the conversation (turn taking, fillers, quick
 * clarifications, retelling results) while the session's agent does the
 * thinking and the work. Three pieces of text connect them:
 *
 * - at call start, a summary of the session's recent turns for the voice;
 * - for every spoken request, a `<lody-voice-turn>` message to the agent with
 *   the user's own words, the voice's paraphrase and what the voice already said;
 * - for every finished reply, a relay back to the voice, taken from the
 *   reply's `<lody-voice-say>` talking points when the agent wrote them.
 *
 * Both tags carry a fork prefix so that ordinary text never matches them.
 * Sessions recorded before the rename hold `<voice_turn>` and `<say>`; see
 * `parseVoiceTurn` and `stripVoiceSay` for how those are still read.
 */

/** One finished utterance of the call, as transcribed by the realtime model. */
export type VoiceTranscriptLine = { role: 'user' | 'assistant'; text: string };

/**
 * The most recent finished assistant reply, keyed so a newer one is
 * recognizable. `answersVoiceTurn` says the user message it follows was spoken;
 * `voiceTurns` holds the exact text of every spoken message it answers (those
 * since the previous reply), so their requests can be matched.
 */
export type VoiceLatestReply = {
  key: string;
  text: string;
  answersVoiceTurn: boolean;
  voiceTurns: string[];
};

/** Upper bound of the call-start summary; Codex caps all initial items at 8192 tokens. */
export const VOICE_CONTEXT_MAX_CHARS = 6_000;
const CONTEXT_USER_MAX_CHARS = 600;
const CONTEXT_AGENT_MAX_CHARS = 1_200;

/** How long hand-offs keep merging after the last fragment when the user ended a sentence. */
export const VOICE_MERGE_WINDOW_MS = 2_000;

/** The same, when the user's last words trail off mid-sentence and more is likely coming. */
export const VOICE_MERGE_WINDOW_UNFINISHED_MS = 3_500;

const TRAILING_MARKS = /(?:-|—|–|…|\.\.\.|,|，|、)$/;
const TRAILING_WORDS =
  /(?:就是|那个|这个|然后|嗯|啊|呃|额|如何|怎么|的话|因为|所以|但是|而且|还有|或者|比如|对于|关于)$|\b(?:and|or|but|so|because|um|uh)$/i;

/**
 * Whether a transcribed utterance seems cut off mid-sentence: it ends on a
 * dash, ellipsis or comma, or on a filler or connective word. A plain
 * heuristic; the voice hands off at pauses, and hesitant speech pauses often.
 */
export function looksUnfinished(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return TRAILING_MARKS.test(trimmed) || TRAILING_WORDS.test(trimmed);
}

/** The merge window after the latest fragment, judged by the user's last words so far. */
export function voiceMergeWindowMs(spoken: readonly VoiceTranscriptLine[]): number {
  for (let i = spoken.length - 1; i >= 0; i -= 1) {
    const line = spoken[i];
    if (line?.role !== 'user') continue;
    return looksUnfinished(line.text) ? VOICE_MERGE_WINDOW_UNFINISHED_MS : VOICE_MERGE_WINDOW_MS;
  }
  return VOICE_MERGE_WINDOW_MS;
}

/** Text compared without case, whitespace or punctuation. */
const comparable = (text: string) => text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

/** Spoken lines carried into one voice turn message; older ones are dropped first. */
export const VOICE_TURN_SPOKEN_MAX_CHARS = 4_000;

/** Longest reply handed to the voice when the agent wrote no talking points. */
export const VOICE_RELAY_MAX_CHARS = 6_000;

const VOICE_TURN_OPEN = '<lody-voice-turn>';
const VOICE_TURN_CLOSE = '</lody-voice-turn>';
/** The wrapper of voice turns recorded before the rename. */
const LEGACY_VOICE_TURN_OPEN = '<voice_turn>';
const LEGACY_VOICE_TURN_CLOSE = '</voice_turn>';
const SAY_OPEN = '<lody-voice-say>';
const SAY_CLOSE = '</lody-voice-say>';
const USER_LINE_PREFIX = 'User: ';
const VOICE_LINE_PREFIX = 'Voice: ';

export const VOICE_CONVERSATION_INSTRUCTIONS = [
  'You are the voice of a coding session. A background agent does the thinking and the work; you run the conversation.',
  'Do yourself: keep the conversation flowing, acknowledge briefly when the user finishes (for example "嗯，我看一下"), pick up right away when interrupted, ask a short question when a request is ambiguous, and answer what the shared context already answers, such as what has been done or what the agent said last.',
  'Hand off: every substantive question about the code, the project or facts you do not have, and every request to do something, goes to the background agent at once. Corrections and additions to a running request go to it too. Do not decide or conclude anything in its place.',
  'Results: when the background agent reports back with talking points, tell the user in your own spoken words, say what it marks as necessary and ask what it marks for confirmation. Never read code, file paths, commands, URLs or long lists aloud; summarize them.',
  'While waiting: until a handed-off request reports back, say only waiting words (checking, one moment, still in progress) or repeat the question to confirm it. Give no conclusion, cause or precondition about it; if asked how it is going, say it is still in progress. 等结果期间只说"在查/稍等/还在处理"，不对请求内容下任何结论。',
  'Never make up results, progress or details.',
  'Reply in the language the user speaks; the user mostly speaks Chinese. Keep spoken replies short.',
].join('\n\n');

const REPLY_INSTRUCTIONS = `The user is listening, not reading. Reply as usual, then end your reply with a ${SAY_OPEN}…${SAY_CLOSE} block for the voice assistant: two to four short spoken sentences in the language the user speaks, with the conclusion, anything that must be said, and anything the user has to confirm. No code, paths, commands or lists inside it.`;

const UNDERSTANDING_NOTE =
  "How the voice assistant understood the request. For reference only: where it differs from the user's words above, the user's words win.";

const collapseWhitespace = (text: string) => text.replace(/\s+/g, ' ').trim();

const shorten = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

/** The final message of an assistant turn: the text after its last tool call or other step. */
function finalAssistantText(turn: SessionHistory): string {
  const texts: string[] = [];
  const items = (turn.items ?? []) as ReadonlyArray<{ type?: unknown; text?: unknown }>;
  for (let j = items.length - 1; j >= 0; j -= 1) {
    const item = items[j];
    if (item?.type === 'text' && typeof item.text === 'string') texts.unshift(item.text);
    else if (item?.type !== 'thought') break;
  }
  return texts.join('').trim();
}

function userTurnText(turn: SessionHistory): string {
  const items = (turn.items ?? []) as ReadonlyArray<{ type?: unknown; text?: unknown }>;
  return items
    .map((item) => (item?.type === 'text' && typeof item.text === 'string' ? item.text : ''))
    .join('')
    .trim();
}

/** The text of the last finished assistant turn in the hydrated tail, if any. */
export function resolveVoiceLatestReply(turns: readonly SessionHistory[]): VoiceLatestReply | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (!turn || turn.role !== 'assistant' || turn.finished !== true) continue;
    // A reopened entry finishes again under the same id with a new end time.
    const endedAt = (turn as { endedAt?: unknown }).endedAt;
    const key = typeof endedAt === 'number' ? `${turn.id}@${endedAt}` : turn.id;
    let answersVoiceTurn: boolean | null = null;
    const voiceTurns: string[] = [];
    for (let j = i - 1; j >= 0; j -= 1) {
      const previous = turns[j];
      if (previous?.role === 'assistant') break;
      if (previous?.role !== 'user') continue;
      const text = userTurnText(previous);
      const spoken = parseVoiceTurn(text) !== null;
      answersVoiceTurn ??= spoken;
      if (spoken) voiceTurns.unshift(text);
    }
    return {
      key,
      text: finalAssistantText(turn),
      answersVoiceTurn: answersVoiceTurn ?? false,
      voiceTurns,
    };
  }
  return null;
}

/**
 * A plain summary of the session's recent turns for the voice to start from,
 * newest kept first under `maxChars`, printed oldest first. Voice turns are
 * reduced to what the user said and replies to their talking points.
 */
export function buildVoiceSessionContext(
  turns: readonly SessionHistory[],
  maxChars = VOICE_CONTEXT_MAX_CHARS
): string | null {
  const header =
    'Background, not new messages: the recent conversation between the user and the background agent in this session, oldest first. Long messages are shortened.';
  const lines: string[] = [];
  let used = header.length;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (!turn) continue;
    let line: string | null = null;
    if (turn.role === 'user') {
      const text = userTurnText(turn);
      const spoken = parseVoiceTurn(text);
      const words = spoken ? spoken.userWords.join(' ') || spoken.understanding.join(' ') : text;
      if (words) line = `User: ${shorten(collapseWhitespace(words), CONTEXT_USER_MAX_CHARS)}`;
    } else if (turn.role === 'assistant') {
      const { say, rest } = extractVoiceSay(finalAssistantText(turn));
      const text = collapseWhitespace(say ?? rest);
      if (turn.finished !== true) {
        line = text
          ? `Agent (still working): ${shorten(text, CONTEXT_AGENT_MAX_CHARS)}`
          : 'Agent: (still working on this)';
      } else if (text) {
        line = `Agent: ${shorten(text, CONTEXT_AGENT_MAX_CHARS)}`;
      }
    }
    if (!line) continue;
    if (used + line.length + 1 > maxChars) break;
    lines.unshift(line);
    used += line.length + 1;
  }
  if (lines.length === 0) return null;
  return [header, ...lines].join('\n');
}

/** Appends a finished utterance, dropping the oldest lines past `maxChars`. */
export function appendVoiceTranscript(
  lines: readonly VoiceTranscriptLine[],
  line: VoiceTranscriptLine,
  maxChars = VOICE_TURN_SPOKEN_MAX_CHARS
): VoiceTranscriptLine[] {
  const text = collapseWhitespace(line.text);
  if (!text) return [...lines];
  const next = [...lines, { role: line.role, text: shorten(text, maxChars) }];
  let total = next.reduce((sum, entry) => sum + entry.text.length, 0);
  while (next.length > 1 && total > maxChars) {
    total -= next.shift()!.text.length;
  }
  return next;
}

/**
 * The message a spoken request sends to the session. `spoken` is everything
 * said in the call since the previous voice turn, in order, so the agent sees
 * the user's own words (with their hesitations and corrections) and whatever
 * the voice already told them; `understanding` holds the voice's paraphrase
 * of each request merged into this turn.
 */
export function buildVoiceTurnMessage(input: {
  spoken: readonly VoiceTranscriptLine[];
  understanding: readonly string[];
}): string {
  const parts = [
    VOICE_TURN_OPEN,
    'The user is talking with you by voice. A realtime voice assistant holds the conversation and reads your reply to them.',
  ];
  if (input.spoken.length > 0) {
    const lines = input.spoken.map(
      (line) =>
        `${line.role === 'user' ? USER_LINE_PREFIX : VOICE_LINE_PREFIX}${collapseWhitespace(line.text)}`
    );
    parts.push(`<conversation>\n${lines.join('\n')}\n</conversation>`);
  }
  const understanding = input.understanding.map(collapseWhitespace).filter(Boolean);
  // A paraphrase that only repeats the user's words adds nothing for the agent.
  const userWords = comparable(
    input.spoken
      .filter((line) => line.role === 'user')
      .map((line) => line.text)
      .join(' ')
  );
  const repeatsUser =
    userWords.length > 0 &&
    understanding.every((text) => {
      const paraphrase = comparable(text);
      return paraphrase.length > 0 && userWords.includes(paraphrase);
    });
  if (understanding.length > 0 && !repeatsUser) {
    parts.push(
      `<voice_understanding>\n${UNDERSTANDING_NOTE}\n${understanding.map((text) => `- ${text}`).join('\n')}\n</voice_understanding>`
    );
  }
  parts.push(`<reply_instructions>\n${REPLY_INSTRUCTIONS}\n</reply_instructions>`);
  parts.push(VOICE_TURN_CLOSE);
  return parts.join('\n\n');
}

/**
 * What a voice turn message holds, or null for any other text. Messages
 * recorded before the rename, wrapped in `<voice_turn>`, are read the same way.
 */
export function parseVoiceTurn(
  text: string
): { userWords: string[]; understanding: string[] } | null {
  const trimmed = text.trim();
  const wrapped = (open: string, close: string) =>
    trimmed.startsWith(open) && trimmed.endsWith(close);
  if (
    !wrapped(VOICE_TURN_OPEN, VOICE_TURN_CLOSE) &&
    !wrapped(LEGACY_VOICE_TURN_OPEN, LEGACY_VOICE_TURN_CLOSE)
  ) {
    return null;
  }
  const section = (tag: string) => {
    const match = new RegExp(`<${tag}>\\n?([\\s\\S]*?)\\n?</${tag}>`).exec(trimmed);
    return match?.[1] ?? '';
  };
  const userWords = section('conversation')
    .split('\n')
    .filter((line) => line.startsWith(USER_LINE_PREFIX))
    .map((line) => line.slice(USER_LINE_PREFIX.length).trim())
    .filter(Boolean);
  const understanding = section('voice_understanding')
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
  return { userWords, understanding };
}

/** What a user bubble shows for a voice turn: the user's words, else the paraphrase. */
export function voiceTurnDisplayText(text: string): string | null {
  const parsed = parseVoiceTurn(text);
  if (!parsed) return null;
  const words = parsed.userWords.length > 0 ? parsed.userWords : parsed.understanding;
  return words.join('\n');
}

const FENCE = /^[ \t]*(`{3,}|~{3,})/;
const BLANK_LINE = /\n[ \t]*\n/;

/**
 * The text with fenced code blocks and inline code spans filled with a
 * placeholder, keeping offsets and line breaks, so tags written as code are
 * not mistaken for real ones. An unclosed fence runs to the end, as Markdown
 * renders it; an unmatched backtick stays literal.
 */
function maskMarkdownCode(text: string): string {
  const out = text.split('');
  const fill = (from: number, to: number) => {
    for (let i = from; i < to; i += 1) if (out[i] !== '\n') out[i] = 'x';
  };
  const maskInline = (from: number, to: number) => {
    const runs = /`+/g;
    runs.lastIndex = from;
    for (let run = runs.exec(text); run && run.index < to; run = runs.exec(text)) {
      // A code span ends at the next backtick run of the same length within its paragraph.
      const paragraphEnd = BLANK_LINE.exec(text.slice(run.index, to));
      const limit = paragraphEnd ? run.index + paragraphEnd.index : to;
      const closing = new RegExp(`(?<!\`)${run[0]}(?!\`)`, 'g');
      closing.lastIndex = run.index + run[0].length;
      const match = closing.exec(text);
      if (!match || match.index + match[0].length > limit) continue;
      fill(run.index, match.index + match[0].length);
      runs.lastIndex = match.index + match[0].length;
    }
  };
  let fence: string | null = null;
  let proseStart = 0;
  let lineStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const marker = FENCE.exec(text.slice(lineStart, lineEnd))?.[1];
    if (fence === null && marker !== undefined) {
      maskInline(proseStart, lineStart);
      fence = marker;
      proseStart = lineStart;
    } else if (
      fence !== null &&
      marker?.[0] === fence[0] &&
      marker.length >= fence.length &&
      text.slice(lineStart, lineEnd).trim() === marker
    ) {
      fill(proseStart, lineEnd);
      fence = null;
      proseStart = lineEnd;
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  if (fence === null) maskInline(proseStart, text.length);
  else fill(proseStart, text.length);
  return out.join('');
}

/** A talking-point block in a reply: its span and, when it is closed here, its body. */
type VoiceSayBlock = { start: number; end: number; body: string | null };

/**
 * Where the text ends in the start of an opening tag still being streamed,
 * such as `<lody-voi`, or -1.
 */
function partialSayOpenAt(text: string): number {
  for (let length = Math.min(SAY_OPEN.length - 1, text.length); length > 0; length -= 1) {
    if (SAY_OPEN.startsWith(text.slice(-length))) return text.length - length;
  }
  return -1;
}

/**
 * A talking-points block of a reply recorded before the rename: only a
 * `<say>` that starts a line and whose block ends the text. Anywhere else
 * `<say>` is ordinary text.
 */
const LEGACY_SAY_AT_END = /(?:^|\n)[ \t]*(<say>)(?:(?!<\/?say>)[\s\S])*<\/say>\s*$/;

/**
 * The talking-point blocks of a reply, ignoring tags inside code. A block
 * runs from `<lody-voice-say>` to the next closing tag or, while it is still
 * streaming, to the end; an opening tag only partly streamed is hidden as
 * well. A text item that continues a block from the previous one starts with
 * its tail, up to the closing tag. Without any of these, a legacy `<say>`
 * block at the very end counts.
 */
function findVoiceSayBlocks(text: string): VoiceSayBlock[] {
  const mayHold =
    text.includes(SAY_OPEN) ||
    text.includes(SAY_CLOSE) ||
    text.includes('</say>') ||
    partialSayOpenAt(text) !== -1;
  if (!mayHold) return [];
  const masked = maskMarkdownCode(text);
  const blocks: VoiceSayBlock[] = [];
  let position = 0;
  const firstOpen = masked.indexOf(SAY_OPEN);
  const tail = masked.indexOf(SAY_CLOSE);
  if (tail !== -1 && (firstOpen === -1 || tail < firstOpen)) {
    position = tail + SAY_CLOSE.length;
    blocks.push({ start: 0, end: position, body: null });
  }
  for (
    let open = masked.indexOf(SAY_OPEN, position);
    open !== -1;
    open = masked.indexOf(SAY_OPEN, position)
  ) {
    const bodyStart = open + SAY_OPEN.length;
    const close = masked.indexOf(SAY_CLOSE, bodyStart);
    if (close === -1) {
      blocks.push({ start: open, end: text.length, body: null });
      return blocks;
    }
    position = close + SAY_CLOSE.length;
    blocks.push({ start: open, end: position, body: text.slice(bodyStart, close) });
  }
  const partial = partialSayOpenAt(masked);
  if (partial >= position) blocks.push({ start: partial, end: text.length, body: null });
  if (blocks.length > 0) return blocks;
  const legacy = LEGACY_SAY_AT_END.exec(masked);
  if (legacy) {
    const start = legacy.index + legacy[0].indexOf('<say>');
    blocks.push({ start, end: text.length, body: null });
  }
  return blocks;
}

const withoutBlocks = (text: string, blocks: readonly VoiceSayBlock[]) => {
  let result = '';
  let position = 0;
  for (const block of blocks) {
    result += text.slice(position, block.start);
    position = block.end;
  }
  return result + text.slice(position);
};

/**
 * The reply's last `<lody-voice-say>` talking points, and the reply without
 * any talking points. Legacy `<say>` blocks are removed from the reply but
 * never returned as talking points.
 */
export function extractVoiceSay(text: string): { say: string | null; rest: string } {
  const blocks = findVoiceSayBlocks(text);
  if (blocks.length === 0) return { say: null, rest: text };
  let say: string | null = null;
  for (const block of blocks) {
    const body = block.body?.trim();
    if (body) say = body;
  }
  return { say, rest: withoutBlocks(text, blocks).trim() };
}

/**
 * Hides talking points from a rendered reply. A block still streaming (no
 * closing tag yet) is hidden to the end, a half-streamed opening tag is
 * hidden, and the tail of a block split across two text items is hidden from
 * the start. Tags inside code stay visible, and so does a legacy `<say>`
 * anywhere but a block that starts a line and ends the reply.
 */
export function stripVoiceSay(text: string): string {
  const blocks = findVoiceSayBlocks(text);
  return blocks.length === 0 ? text : withoutBlocks(text, blocks).trimEnd();
}

/**
 * The text that hands a finished reply back to the voice. `requests` are the
 * paraphrases of the voice turns this reply answers.
 */
export function buildVoiceRelay(reply: VoiceLatestReply, requests: readonly string[]): string {
  const { say, rest } = extractVoiceSay(reply.text);
  const subject = !reply.answersVoiceTurn
    ? 'The background agent finished a turn the user typed rather than said. Mention it briefly, only if it helps the conversation.'
    : requests.length > 0
      ? `The background agent finished the spoken request ${requests.map((request) => `"${collapseWhitespace(request)}"`).join(' and ')}.`
      : 'The background agent finished another turn on the spoken request.';
  if (say) {
    return `${subject}\nIts talking points; tell the user in your own words:\n${say}`;
  }
  const written = rest.slice(0, VOICE_RELAY_MAX_CHARS);
  if (!written) return `${subject}\nIt finished without a written reply.`;
  return `${subject}\nIt wrote no talking points. Its reply, to summarize in a sentence or two without reading code, paths or lists aloud:\n${written}`;
}
