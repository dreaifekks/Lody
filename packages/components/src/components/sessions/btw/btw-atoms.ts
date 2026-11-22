import {
  SESSION_BTW_MAX_EXCERPT_CHARS,
  SESSION_BTW_MAX_PATH_CHARS,
  SESSION_BTW_MAX_SELECTION_CHARS,
  type AgentType,
  type SessionId,
} from '@lody/shared';
import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';

export type BtwSelectionAttachment = {
  readonly path: string;
  readonly text: string;
  readonly location?: string;
};

export type BtwTurn = {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly selection?: BtwSelectionAttachment;
  readonly cancelled?: boolean;
};

export type BtwSessionState = {
  readonly isOpen: boolean;
  readonly btwId: string;
  readonly turns: readonly BtwTurn[];
  readonly streamingText: string;
  readonly isStreaming: boolean;
  readonly hasUnread: boolean;
  readonly readOnlyTools: boolean;
  readonly modelId?: string;
  readonly modelLabel?: string;
  readonly pendingSelection: BtwSelectionAttachment | null;
  readonly error: string | null;
  /** Monotonic sequence incremented when an external trigger opens `/btw` so the shared composer focuses. */
  readonly focusRequestSeq: number;
};

export type BtwActiveArticleContext = {
  readonly path: string;
  readonly excerpt: string;
  readonly truncated?: boolean;
  /** Mount identity of the active view that published this context, preventing stale unmounts from clobbering a newer view. */
  readonly ownerId?: string;
  /** Higher priority surfaces (Article dialog = 2) outrank background file-viewer tabs (1). */
  readonly priority?: number;
};

const createBtwId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `btw-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export function createInitialBtwSessionState(): BtwSessionState {
  return {
    isOpen: false,
    btwId: createBtwId(),
    turns: [],
    streamingText: '',
    isStreaming: false,
    hasUnread: false,
    readOnlyTools: false,
    pendingSelection: null,
    error: null,
    focusRequestSeq: 0,
  };
}

/** Pure in-memory per-session `/btw` state (never persisted to Loro or SessionMeta). */
export const btwSessionStateAtomFamily = atomFamily((_sessionId: SessionId) =>
  atom<BtwSessionState>(createInitialBtwSessionState())
);

type BtwArticleContextCandidateEntry = {
  readonly payload: BtwActiveArticleContext;
  readonly order: number;
};

let btwArticleContextOrderSeq = 0;

/**
 * Per-session candidate table of active Article / File Viewer surfaces keyed by `ownerId`.
 * Keeping all mounted candidates allows closing a higher-priority Article dialog (priority 2)
 * to fall back seamlessly to an underlying File Viewer (priority 1) without requiring its
 * effect to re-fire.
 */
export const btwArticleContextCandidatesAtomFamily = atomFamily((_sessionId: SessionId) =>
  atom<Readonly<Record<string, BtwArticleContextCandidateEntry>>>({})
);

/** Currently effective Article or File Viewer text synced for `/btw` context injection. */
export const activeBtwArticleContextAtomFamily = atomFamily((sessionId: SessionId) =>
  atom(
    (get): BtwActiveArticleContext | null => {
      const candidates = get(btwArticleContextCandidatesAtomFamily(sessionId));
      let best: BtwArticleContextCandidateEntry | null = null;
      for (const entry of Object.values(candidates)) {
        const entryPriority = entry.payload.priority ?? 0;
        const bestPriority = best ? (best.payload.priority ?? 0) : Number.NEGATIVE_INFINITY;
        if (
          !best ||
          entryPriority > bestPriority ||
          (entryPriority === bestPriority && entry.order > best.order)
        ) {
          best = entry;
        }
      }
      return best?.payload ?? null;
    },
    (_get, set, next: BtwActiveArticleContext | null) => {
      const candidatesAtom = btwArticleContextCandidatesAtomFamily(sessionId);
      if (next === null) {
        set(candidatesAtom, {});
        return;
      }
      const ownerKey = next.ownerId ?? '__default__';
      set(candidatesAtom, (prev) => ({
        ...prev,
        [ownerKey]: { payload: next, order: ++btwArticleContextOrderSeq },
      }));
    }
  )
);

export const upsertBtwArticleContextAtom = atom(
  null,
  (
    _get,
    set,
    input: { readonly sessionId: SessionId; readonly payload: BtwActiveArticleContext }
  ) => {
    const ownerKey = input.payload.ownerId ?? '__default__';
    set(btwArticleContextCandidatesAtomFamily(input.sessionId), (prev) => ({
      ...prev,
      [ownerKey]: { payload: input.payload, order: ++btwArticleContextOrderSeq },
    }));
  }
);

export const removeBtwArticleContextAtom = atom(
  null,
  (_get, set, input: { readonly sessionId: SessionId; readonly ownerId: string }) => {
    set(btwArticleContextCandidatesAtomFamily(input.sessionId), (prev) => {
      if (!(input.ownerId in prev)) return prev;
      const { [input.ownerId]: _removed, ...rest } = prev;
      return rest;
    });
  }
);

export function buildBtwArticleContextPayload(input: {
  readonly path: string;
  readonly text: string;
  readonly ownerId?: string;
  readonly priority?: number;
}): BtwActiveArticleContext | null {
  const path = input.path.trim().slice(0, SESSION_BTW_MAX_PATH_CHARS);
  if (!path) return null;
  const truncated = input.text.length > SESSION_BTW_MAX_EXCERPT_CHARS;
  const excerpt = truncated ? input.text.slice(0, SESSION_BTW_MAX_EXCERPT_CHARS) : input.text;
  return {
    path,
    excerpt,
    ...(truncated ? { truncated: true } : {}),
    ...(input.ownerId ? { ownerId: input.ownerId } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
  };
}

export type OpenBtwForSessionInput =
  | SessionId
  | {
      readonly sessionId: SessionId;
      readonly toggle?: boolean;
    };

/** Open (or toggle) `/btw` for a session without discarding existing turns. */
export const openBtwForSessionAtom = atom(null, (get, set, input: OpenBtwForSessionInput) => {
  const sessionId = typeof input === 'string' ? input : input.sessionId;
  const toggle = typeof input === 'string' ? false : input.toggle === true;
  const stateAtom = btwSessionStateAtomFamily(sessionId);
  const current = get(stateAtom);
  const nextOpen = toggle ? !current.isOpen : true;
  set(stateAtom, {
    ...current,
    isOpen: nextOpen,
    hasUnread: nextOpen ? false : current.hasUnread,
    focusRequestSeq: nextOpen ? current.focusRequestSeq + 1 : current.focusRequestSeq,
  });
});

export type OpenBtwWithSelectionInput = {
  readonly sessionId: SessionId;
  readonly selection: BtwSelectionAttachment;
};

/** Open `/btw` for a session and attach a document selection quote chip, preserving existing turns. */
export const openBtwWithSelectionAtom = atom(
  null,
  (get, set, { sessionId, selection }: OpenBtwWithSelectionInput) => {
    const trimmedPath = selection.path.trim().slice(0, SESSION_BTW_MAX_PATH_CHARS);
    const trimmedText = selection.text.trim().slice(0, SESSION_BTW_MAX_SELECTION_CHARS);
    if (!trimmedPath || !trimmedText) return;
    const stateAtom = btwSessionStateAtomFamily(sessionId);
    const current = get(stateAtom);
    set(stateAtom, {
      ...current,
      isOpen: true,
      hasUnread: false,
      pendingSelection: {
        path: trimmedPath,
        text: trimmedText,
        ...(selection.location ? { location: selection.location } : {}),
      },
      focusRequestSeq: current.focusRequestSeq + 1,
    });
  }
);

/** Derive the compact `/btw` composer model pill label before or after the first backend response. */
export function resolveBtwModelPillLabel(input: {
  readonly modelLabel?: string | null;
  readonly agentType?: AgentType | string | null;
  readonly readOnlyTools?: boolean;
}): string {
  let base = input.modelLabel?.trim();
  if (!base) {
    const normalized = (input.agentType ?? '').trim().toLowerCase();
    if (normalized === 'antigravity' || normalized === 'antigravity-acp') {
      base = 'Hydrogen · Low';
    } else if (normalized === 'claude' || /^claude(?:[-_]|$)/.test(normalized)) {
      base = 'Haiku · Low';
    } else if (normalized === 'codex' || /^codex(?:[-_]|$)/.test(normalized)) {
      base = 'Luna · Low';
    } else if (normalized) {
      const display = normalized.charAt(0).toUpperCase() + normalized.slice(1);
      base = `${display} · Low`;
    } else {
      base = 'Fast · Low';
    }
  }
  return input.readOnlyTools ? `${base} · 只读` : base;
}

/** Extract a concise filename (e.g. `design.md`) from a session/board/machine path. */
export function formatBtwFileName(path: string | null | undefined): string | null {
  if (!path) return null;
  const trimmed = path.trim();
  if (!trimmed) return null;
  const withoutMachinePrefix = trimmed.replace(/^[^/\\:]+:(?=[/\\])/, '');
  const segments = withoutMachinePrefix.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? trimmed;
}
