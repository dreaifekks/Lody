// What a running turn is doing, distilled from its ACP updates for a Live
// Activity: the title of its current tool call and the tail of its latest
// stretch of prose. A stretch stays on show through the tool calls after it
// until the next one starts. Reported at most once per interval per session; a
// permission request goes out at once.
import type { CloudLiveActivityDetailInput } from '@lody/platform';
import type { AcpSessionNotification, SessionId } from '@lody/shared';

const DEFAULT_INTERVAL_MS = 12_000;
/** Enough for two lines on a Lock Screen. */
const THOUGHT_MAX_CHARS = 140;
const ACTIVITY_MAX_CHARS = 120;
const BUFFER_MAX_CHARS = 1_000;

type Detail = Omit<CloudLiveActivityDetailInput, 'sessionId' | 'workspaceId' | 'userId'>;
type Entry = {
  prose: string;
  /** Which update the prose came from; the other kind starts a new stretch. */
  proseKind: 'agent_thought_chunk' | 'agent_message_chunk' | null;
  /** A tool call ended the stretch; the next prose replaces it. */
  proseEnded: boolean;
  activity: string | null;
  sent: string;
  lastSentAt: number;
  timer: NodeJS.Timeout | null;
};

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The end of the latest prose, cut at a word when there is one nearby. */
export function tailOfProse(prose: string, max = THOUGHT_MAX_CHARS): string | null {
  const text = oneLine(prose);
  if (!text) return null;
  if (text.length <= max) return text;
  let tail = text.slice(-(max - 1));
  const space = tail.indexOf(' ');
  if (space > 0 && space < 24) tail = tail.slice(space + 1);
  return `…${tail}`;
}

export class LiveActivityDetailTracker {
  private readonly entries = new Map<SessionId, Entry>();
  private readonly intervalMs: number;
  private readonly now: () => number;

  constructor(
    private readonly send: (sessionId: SessionId, detail: Detail) => void,
    options: { intervalMs?: number; now?: () => number } = {}
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  observe(sessionId: SessionId, notification: AcpSessionNotification): void {
    const update = notification.update;
    const entry = this.entry(sessionId);
    switch (update.sessionUpdate) {
      case 'agent_thought_chunk':
      case 'agent_message_chunk': {
        const content = update.content as { type?: string; text?: unknown } | undefined;
        if (content?.type !== 'text' || typeof content.text !== 'string') return;
        if (
          !content.text.trim() &&
          (entry.proseEnded || entry.proseKind !== update.sessionUpdate)
        ) {
          return;
        }
        // Until new words arrive, the last stretch stays on show: a turn spends
        // most of its time in tool calls, and an empty line says only "Working".
        const continues = !entry.proseEnded && entry.proseKind === update.sessionUpdate;
        entry.prose = ((continues ? entry.prose : '') + content.text).slice(-BUFFER_MAX_CHARS);
        entry.proseKind = update.sessionUpdate;
        entry.proseEnded = false;
        break;
      }
      case 'tool_call': {
        const title = typeof update.title === 'string' ? oneLine(update.title) : '';
        if (!title) return;
        entry.activity = title.slice(0, ACTIVITY_MAX_CHARS);
        // The reasoning that led to this step is done; the next replaces it.
        entry.proseEnded = true;
        break;
      }
      case 'tool_call_update': {
        const title = typeof update.title === 'string' ? oneLine(update.title) : '';
        if (!title) return;
        entry.activity = title.slice(0, ACTIVITY_MAX_CHARS);
        break;
      }
      default:
        return;
    }
    this.schedule(sessionId, entry);
  }

  /** A permission request, or `null` once answered; sent without waiting. */
  permission(sessionId: SessionId, permission: Detail['permission']): void {
    const entry = this.entry(sessionId);
    this.flush(sessionId, entry, { permission });
  }

  /** The turn ended; nothing more to report for it. */
  clear(sessionId: SessionId): void {
    const entry = this.entries.get(sessionId);
    if (entry?.timer) clearTimeout(entry.timer);
    this.entries.delete(sessionId);
  }

  dispose(): void {
    for (const sessionId of [...this.entries.keys()]) this.clear(sessionId);
  }

  private entry(sessionId: SessionId): Entry {
    let entry = this.entries.get(sessionId);
    if (!entry) {
      entry = {
        prose: '',
        proseKind: null,
        proseEnded: false,
        activity: null,
        sent: '',
        lastSentAt: 0,
        timer: null,
      };
      this.entries.set(sessionId, entry);
    }
    return entry;
  }

  private schedule(sessionId: SessionId, entry: Entry): void {
    if (entry.timer) return;
    const wait = Math.max(0, entry.lastSentAt + this.intervalMs - this.now());
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (this.entries.get(sessionId) === entry) this.flush(sessionId, entry);
    }, wait);
    entry.timer.unref?.();
  }

  private flush(sessionId: SessionId, entry: Entry, extra: Partial<Detail> = {}): void {
    const detail: Detail = {
      activity: entry.activity,
      thought: tailOfProse(entry.prose),
      ...extra,
    };
    const key = JSON.stringify(detail);
    if (key === entry.sent && !('permission' in extra)) return;
    entry.sent = key;
    entry.lastSentAt = this.now();
    this.send(sessionId, detail);
  }
}
