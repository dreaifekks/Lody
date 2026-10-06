import type { SessionHistory } from '@lody/shared';

/**
 * The text protocol between a realtime voice call and the session's agent.
 *
 * The realtime voice runs the conversation (turn taking, fillers, quick
 * clarifications, retelling results) while the session's agent does the
 * thinking and the work. Three pieces of text connect them:
 *
 * - at call start, a summary of the session's recent turns for the voice;
 * - for every spoken request, a `<voice_turn>` message to the agent with the
 *   user's own words, the voice's paraphrase and what the voice already said;
 * - for every finished reply, a relay back to the voice, taken from the
 *   reply's `<say>` talking points when the agent wrote them.
 */

/** One finished utterance of the call, as transcribed by the realtime model. */
export type VoiceTranscriptLine = { role: 'user' | 'assistant'; text: string };

/**
 * The most recent finished assistant reply, keyed so a newer one is
 * recognizable. `answersVoiceTurn` says the user message it follows was spoken.
 */
export type VoiceLatestReply = { key: string; text: string; answersVoiceTurn: boolean };

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

/** Spoken lines carried into one `<voice_turn>`; older ones are dropped first. */
export const VOICE_TURN_SPOKEN_MAX_CHARS = 4_000;

/** Longest reply handed to the voice when the agent wrote no talking points. */
export const VOICE_RELAY_MAX_CHARS = 6_000;

const VOICE_TURN_OPEN = '<voice_turn>';
const VOICE_TURN_CLOSE = '</voice_turn>';
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

const REPLY_INSTRUCTIONS =
  'The user is listening, not reading. Reply as usual, then end your reply with a <say>…</say> block for the voice assistant: two to four short spoken sentences in the language the user speaks, with the conclusion, anything that must be said, and anything the user has to confirm. No code, paths, commands or lists inside it.';

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
    let answersVoiceTurn = false;
    for (let j = i - 1; j >= 0; j -= 1) {
      const previous = turns[j];
      if (previous?.role !== 'user') continue;
      answersVoiceTurn = parseVoiceTurn(userTurnText(previous)) !== null;
      break;
    }
    return { key, text: finalAssistantText(turn), answersVoiceTurn };
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

/** What a `<voice_turn>` message holds, or null for any other text. */
export function parseVoiceTurn(
  text: string
): { userWords: string[]; understanding: string[] } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(VOICE_TURN_OPEN) || !trimmed.endsWith(VOICE_TURN_CLOSE)) return null;
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

const SAY_BLOCK = /<say>([\s\S]*?)<\/say>/g;

/** The reply's last `<say>` talking points, and the reply without any of them. */
export function extractVoiceSay(text: string): { say: string | null; rest: string } {
  if (!text.includes('<say>')) return { say: null, rest: text };
  let say: string | null = null;
  for (const match of text.matchAll(SAY_BLOCK)) {
    const body = match[1]?.trim();
    if (body) say = body;
  }
  return { say, rest: stripVoiceSay(text).trim() };
}

/**
 * Hides `<say>` talking points from a rendered reply. A block still streaming
 * (no closing tag yet) is hidden to the end, and the tail of a block split
 * across two text items is hidden from the start.
 */
export function stripVoiceSay(text: string): string {
  if (!text.includes('<say>') && !text.includes('</say>')) return text;
  let result = text.replace(SAY_BLOCK, '');
  const close = result.indexOf('</say>');
  const open = result.indexOf('<say>');
  if (close !== -1 && (open === -1 || close < open)) {
    result = result.slice(close + '</say>'.length);
  }
  const dangling = result.indexOf('<say>');
  if (dangling !== -1) result = result.slice(0, dangling);
  return result.trimEnd();
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
