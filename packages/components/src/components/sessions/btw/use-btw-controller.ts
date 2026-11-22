import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';
import {
  SESSION_BTW_MAX_EXCERPT_CHARS,
  SESSION_BTW_MAX_PATH_CHARS,
  SESSION_BTW_MAX_PRIOR_TURN_TEXT_CHARS,
  SESSION_BTW_MAX_PRIOR_TURNS,
  SESSION_BTW_MAX_QUESTION_CHARS,
  SESSION_BTW_MAX_SELECTION_CHARS,
  type AgentType,
  type MachineId,
  type SessionBtwArticleContext,
  type SessionBtwPriorTurn,
  type SessionBtwProgress,
  type SessionId,
} from '@lody/shared';
import { useAtom, useAtomValue, useStore } from 'jotai';
import { runtimeAtom, type WorkspaceRuntime } from '@/atoms/runtime';
import {
  activeBtwArticleContextAtomFamily,
  btwDraftAtomFamily,
  btwSessionStateAtomFamily,
  createInitialBtwSessionState,
  formatBtwFileName,
  resolveBtwModelPillLabel,
  type BtwActiveArticleContext,
  type BtwSelectionAttachment,
  type BtwSessionState,
  type BtwTurn,
} from './btw-atoms';

const createTurnId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `btw-turn-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

function buildPriorTurns(turns: readonly BtwTurn[]): SessionBtwPriorTurn[] | undefined {
  const valid = turns
    .filter((turn) => turn.text.trim().length > 0)
    .slice(-SESSION_BTW_MAX_PRIOR_TURNS)
    .map((turn) => ({
      role: turn.role,
      text: turn.text.slice(0, SESSION_BTW_MAX_PRIOR_TURN_TEXT_CHARS),
    }));
  return valid.length > 0 ? valid : undefined;
}

function buildRequestArticleContext(
  pendingSelection: BtwSelectionAttachment | null,
  activeArticle: BtwActiveArticleContext | null
): SessionBtwArticleContext | undefined {
  if (!pendingSelection && !activeArticle) return undefined;
  const rawPath = pendingSelection?.path || activeArticle?.path || '';
  const path = rawPath.trim().slice(0, SESSION_BTW_MAX_PATH_CHARS);
  if (!path) return undefined;

  const selection = pendingSelection?.text.trim().slice(0, SESSION_BTW_MAX_SELECTION_CHARS);
  const articleMatchesSelection =
    !pendingSelection || activeArticle?.path === pendingSelection.path;
  const excerpt =
    articleMatchesSelection && activeArticle?.excerpt
      ? activeArticle.excerpt.slice(0, SESSION_BTW_MAX_EXCERPT_CHARS)
      : undefined;
  const truncated = articleMatchesSelection && activeArticle?.truncated ? true : undefined;

  return {
    path,
    ...(selection ? { selection } : {}),
    ...(excerpt !== undefined ? { excerpt } : {}),
    ...(truncated ? { truncated } : {}),
  };
}

export type UseBtwControllerOptions = {
  readonly sessionId: SessionId;
  readonly machineId: MachineId | undefined;
  readonly agentType: AgentType | string | undefined;
  readonly isVisible: boolean;
  /** Element inside the owning conversation page, used to avoid stealing Escape from overlays/dialogs above this session. */
  readonly scopeElementRef?: RefObject<HTMLElement | null>;
  readonly onFocusComposer?: () => void;
};

export type BtwController = {
  readonly state: BtwSessionState;
  readonly modelPillLabel: string;
  readonly articleFileName: string | null;
  readonly completedTurnCount: number;
  readonly canClear: boolean;
  readonly open: () => void;
  readonly close: () => void;
  readonly toggleOpen: () => void;
  readonly ask: (question: string) => Promise<void>;
  readonly cancel: () => void;
  readonly clearAndClose: () => void;
  readonly toggleReadOnlyTools: () => void;
  readonly clearPendingSelection: () => void;
};

type ActiveBackendTarget = {
  readonly sessionId: SessionId;
  readonly btwId: string;
  readonly machineId: MachineId;
  readonly runtime: WorkspaceRuntime;
};

function finalizeCancelledStreamingState(
  current: BtwSessionState,
  expectedBtwId?: string
): BtwSessionState {
  if (expectedBtwId && current.btwId !== expectedBtwId) return current;
  if (!current.isStreaming) return current;
  const partial = current.streamingText;
  const nextTurns = partial
    ? [
        ...current.turns,
        {
          id: createTurnId(),
          role: 'assistant' as const,
          text: partial,
          cancelled: true,
        },
      ]
    : current.turns;
  return {
    ...current,
    turns: nextTurns,
    streamingText: '',
    isStreaming: false,
  };
}

export function useBtwController({
  sessionId,
  machineId,
  agentType,
  isVisible,
  scopeElementRef,
  onFocusComposer,
}: UseBtwControllerOptions): BtwController {
  const store = useStore();
  const [state, setState] = useAtom(btwSessionStateAtomFamily(sessionId));
  const activeArticleContext = useAtomValue(activeBtwArticleContextAtomFamily(sessionId));
  const runtime = useAtomValue(runtimeAtom);

  const activeArticleRef = useRef(activeArticleContext);
  activeArticleRef.current = activeArticleContext;
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  const machineIdRef = useRef(machineId);
  machineIdRef.current = machineId;
  const onFocusComposerRef = useRef(onFocusComposer);
  onFocusComposerRef.current = onFocusComposer;

  const abortControllerRef = useRef<AbortController | null>(null);
  const activeRequestSeqRef = useRef(0);
  const activeBackendTargetRef = useRef<ActiveBackendTarget | null>(null);
  const lastSessionIdRef = useRef(sessionId);
  const lastHandledFocusSeqRef = useRef(state.isOpen ? 0 : state.focusRequestSeq);
  if (lastSessionIdRef.current !== sessionId) {
    lastSessionIdRef.current = sessionId;
    lastHandledFocusSeqRef.current = state.isOpen ? 0 : state.focusRequestSeq;
  }

  const open = useCallback(() => {
    setState((current) => ({
      ...current,
      isOpen: true,
      hasUnread: false,
      focusRequestSeq: current.focusRequestSeq + 1,
    }));
  }, [setState]);

  const close = useCallback(() => {
    setState((current) => (current.isOpen ? { ...current, isOpen: false } : current));
  }, [setState]);

  const toggleOpen = useCallback(() => {
    setState((current) => {
      const nextOpen = !current.isOpen;
      return {
        ...current,
        isOpen: nextOpen,
        hasUnread: nextOpen ? false : current.hasUnread,
        focusRequestSeq: nextOpen ? current.focusRequestSeq + 1 : current.focusRequestSeq,
      };
    });
  }, [setState]);

  const toggleReadOnlyTools = useCallback(() => {
    setState((current) => ({
      ...current,
      readOnlyTools: !current.readOnlyTools,
    }));
  }, [setState]);

  const clearPendingSelection = useCallback(() => {
    setState((current) =>
      current.pendingSelection ? { ...current, pendingSelection: null } : current
    );
  }, [setState]);

  const cancel = useCallback(() => {
    activeRequestSeqRef.current += 1;
    const controller = abortControllerRef.current;
    abortControllerRef.current = null;
    controller?.abort();

    setState((current) => finalizeCancelledStreamingState(current));

    const target = activeBackendTargetRef.current;
    if (target && target.sessionId === sessionId) {
      void target.runtime
        .requestSessionBtw(target.machineId, {
          action: 'cancel',
          sessionId: target.sessionId,
          btwId: target.btwId,
        })
        .catch(() => undefined);
    }
  }, [sessionId, setState]);

  const clearAndClose = useCallback(() => {
    activeRequestSeqRef.current += 1;
    const controller = abortControllerRef.current;
    abortControllerRef.current = null;
    controller?.abort();

    const target = activeBackendTargetRef.current;
    const matchedTarget = target?.sessionId === sessionId ? target : null;
    if (matchedTarget) {
      activeBackendTargetRef.current = null;
    }

    setState(createInitialBtwSessionState());
    store.set(btwDraftAtomFamily(sessionId), '');

    if (matchedTarget) {
      void matchedTarget.runtime
        .requestSessionBtw(matchedTarget.machineId, {
          action: 'close',
          sessionId: matchedTarget.sessionId,
          btwId: matchedTarget.btwId,
        })
        .catch(() => undefined);
    }
  }, [sessionId, setState, store]);

  const ask = useCallback(
    async (rawQuestion: string) => {
      const question = rawQuestion.trim().slice(0, SESSION_BTW_MAX_QUESTION_CHARS);
      if (!question) {
        open();
        return;
      }

      const activeRuntime = runtimeRef.current;
      const activeMachineId = machineIdRef.current;
      if (!activeRuntime || !activeMachineId) {
        setState((current) => ({
          ...current,
          isOpen: true,
          hasUnread: false,
          error: '当前会话尚未连接到目标机器',
          focusRequestSeq: current.focusRequestSeq + 1,
        }));
        return;
      }

      if (abortControllerRef.current) {
        cancel();
      }

      const originSessionId = sessionId;
      const originAtom = btwSessionStateAtomFamily(originSessionId);
      const snapshot = store.get(originAtom);
      const btwId = snapshot.btwId;
      const readOnlyTools = snapshot.readOnlyTools;
      const pendingSelection = snapshot.pendingSelection;
      const articleContext = buildRequestArticleContext(pendingSelection, activeArticleRef.current);
      const priorTurns = buildPriorTurns(snapshot.turns);

      const userTurn: BtwTurn = {
        id: createTurnId(),
        role: 'user',
        text: question,
        ...(pendingSelection ? { selection: pendingSelection } : {}),
      };

      store.set(originAtom, (current) => ({
        ...current,
        isOpen: true,
        hasUnread: false,
        error: null,
        pendingSelection: null,
        streamingText: '',
        isStreaming: true,
        turns: [...current.turns, userTurn],
        focusRequestSeq: current.focusRequestSeq + 1,
      }));

      const requestSeq = ++activeRequestSeqRef.current;
      const controller = new AbortController();
      abortControllerRef.current = controller;
      activeBackendTargetRef.current = {
        sessionId: originSessionId,
        btwId,
        machineId: activeMachineId,
        runtime: activeRuntime,
      };

      try {
        const response = await activeRuntime.requestSessionBtw(
          activeMachineId,
          {
            action: 'ask',
            sessionId: originSessionId,
            btwId,
            question,
            ...(articleContext ? { articleContext } : {}),
            ...(readOnlyTools ? { readOnlyTools: true } : {}),
            ...(priorTurns ? { priorTurns } : {}),
          },
          {
            signal: controller.signal,
            onProgress: (progress: SessionBtwProgress) => {
              if (activeRequestSeqRef.current !== requestSeq) return;
              if (progress.btwId !== btwId) return;
              store.set(originAtom, (current) => {
                if (current.btwId !== btwId) return current;
                const nextModelId = progress.modelId ?? current.modelId;
                const nextModelLabel = progress.modelLabel ?? current.modelLabel;
                const nextStreamingText =
                  progress.kind === 'delta' && progress.delta
                    ? current.streamingText + progress.delta
                    : current.streamingText;
                if (
                  nextModelId === current.modelId &&
                  nextModelLabel === current.modelLabel &&
                  nextStreamingText === current.streamingText
                ) {
                  return current;
                }
                return {
                  ...current,
                  modelId: nextModelId,
                  modelLabel: nextModelLabel,
                  streamingText: nextStreamingText,
                };
              });
            },
          }
        );

        if (activeRequestSeqRef.current !== requestSeq) return;
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }

        store.set(originAtom, (current) => {
          if (current.btwId !== btwId) return current;

          if (!response) {
            if (controller.signal.aborted) {
              return finalizeCancelledStreamingState(current, btwId);
            }
            return {
              ...current,
              streamingText: '',
              isStreaming: false,
              error: '请求超时或未收到响应',
            };
          }

          const nextModelId = response.modelId ?? current.modelId;
          const nextModelLabel = response.modelLabel ?? current.modelLabel;
          const nextReadOnlyTools =
            current.readOnlyTools !== readOnlyTools
              ? current.readOnlyTools
              : response.readOnlyTools === false && readOnlyTools
                ? false
                : current.readOnlyTools;

          if (response.error) {
            return {
              ...current,
              modelId: nextModelId,
              modelLabel: nextModelLabel,
              readOnlyTools: nextReadOnlyTools,
              streamingText: '',
              isStreaming: false,
              error: response.error,
            };
          }

          const finalText = response.text || current.streamingText;
          const nextTurns =
            finalText || response.cancelled
              ? [
                  ...current.turns,
                  {
                    id: createTurnId(),
                    role: 'assistant' as const,
                    text: finalText,
                    ...(response.cancelled ? { cancelled: true } : {}),
                  },
                ]
              : current.turns;

          return {
            ...current,
            modelId: nextModelId,
            modelLabel: nextModelLabel,
            readOnlyTools: nextReadOnlyTools,
            turns: nextTurns,
            streamingText: '',
            isStreaming: false,
            hasUnread: current.isOpen ? false : true,
          };
        });
      } catch (error) {
        if (activeRequestSeqRef.current !== requestSeq) return;
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        store.set(originAtom, (current) => {
          if (current.btwId !== btwId) return current;
          if (controller.signal.aborted) {
            return finalizeCancelledStreamingState(current, btwId);
          }
          return {
            ...current,
            streamingText: '',
            isStreaming: false,
            error: error instanceof Error ? error.message : String(error),
          };
        });
      }
    },
    [cancel, open, sessionId, setState, store]
  );

  // Leaving/hiding a mounted session (tab switch, side-panel collapse, viewer
  // covering board thread, archive) resets `/btw` to closed so re-entering lands
  // on the main conversation while keeping history, unread state, and any
  // background stream alive.
  const prevVisibilityRef = useRef<{
    readonly sessionId: SessionId;
    readonly isVisible: boolean;
  }>({
    sessionId,
    isVisible,
  });
  useEffect(() => {
    const prev = prevVisibilityRef.current;
    prevVisibilityRef.current = { sessionId, isVisible };
    if (prev.sessionId === sessionId && prev.isVisible && !isVisible) {
      store.set(btwSessionStateAtomFamily(sessionId), (current) =>
        current.isOpen ? { ...current, isOpen: false } : current
      );
    }
  }, [isVisible, sessionId, store]);

  // Focus the shared composer whenever `/btw` is opened via icon, shortcut, or selection.
  useEffect(() => {
    if (!isVisible || !state.isOpen) return undefined;
    if (state.focusRequestSeq <= lastHandledFocusSeqRef.current) return undefined;
    lastHandledFocusSeqRef.current = state.focusRequestSeq;
    const frame = requestAnimationFrame(() => {
      onFocusComposerRef.current?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [isVisible, state.focusRequestSeq, state.isOpen]);

  // Capture-phase Escape returns to the main conversation before dialog listeners (e.g. BoardArticleDialog),
  // while yielding to any modal dialog/popover/search/menu stacked above or beside this surface.
  useEffect(() => {
    if (!isVisible || !state.isOpen) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229
      ) {
        return;
      }
      const targetEl =
        event.target instanceof Element
          ? event.target
          : document.activeElement instanceof Element
            ? document.activeElement
            : null;
      if (targetEl?.closest('[role="search"]')) {
        return;
      }
      if (
        document.querySelector(
          '[role="menu"]:not([hidden]):not([aria-hidden="true"]), [role="listbox"]:not([hidden]):not([aria-hidden="true"])'
        )
      ) {
        return;
      }
      const scopeRoot = scopeElementRef?.current?.parentElement ?? scopeElementRef?.current ?? null;
      if (scopeRoot) {
        const targetDialog = targetEl?.closest('[role="dialog"], [role="alertdialog"]');
        if (targetDialog && !targetDialog.contains(scopeRoot)) {
          return;
        }
        const openDialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
        const topmostDialog = openDialogs.item(openDialogs.length - 1);
        if (topmostDialog && !topmostDialog.contains(scopeRoot)) {
          return;
        }
      }
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [close, isVisible, scopeElementRef, state.isOpen]);

  // Clean up warm backend process, settle any in-flight stream, and reset `isOpen`
  // to false on unmount or session switch so returning later opens on the main
  // conversation while preserving in-memory `/btw` turns and unread state.
  useEffect(() => {
    const originSessionId = sessionId;
    return () => {
      activeRequestSeqRef.current += 1;
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;

      const target = activeBackendTargetRef.current;
      const matchedTarget = target?.sessionId === originSessionId ? target : null;
      if (matchedTarget) {
        activeBackendTargetRef.current = null;
      }

      // Synchronously settle `isStreaming` and close `isOpen` on the origin
      // session's Jotai atom (preserving turns, `btwId`, `hasUnread`, and any
      // partial streamed text as a cancelled turn).
      store.set(btwSessionStateAtomFamily(originSessionId), (current) => {
        const settled = finalizeCancelledStreamingState(current);
        return settled.isOpen ? { ...settled, isOpen: false } : settled;
      });

      if (matchedTarget) {
        void matchedTarget.runtime
          .requestSessionBtw(matchedTarget.machineId, {
            action: 'close',
            sessionId: matchedTarget.sessionId,
            btwId: matchedTarget.btwId,
          })
          .catch(() => undefined);
      }
    };
  }, [sessionId, store]);

  const modelPillLabel = useMemo(
    () =>
      resolveBtwModelPillLabel({
        modelLabel: state.modelLabel,
        agentType,
        readOnlyTools: state.readOnlyTools,
      }),
    [agentType, state.modelLabel, state.readOnlyTools]
  );

  const articleFileName = useMemo(
    () => formatBtwFileName(activeArticleContext?.path),
    [activeArticleContext?.path]
  );

  const completedTurnCount = useMemo(
    () => state.turns.filter((turn) => turn.role === 'user').length,
    [state.turns]
  );

  const canClear =
    state.isOpen && (state.turns.length > 0 || state.isStreaming || Boolean(state.error));

  return {
    state,
    modelPillLabel,
    articleFileName,
    completedTurnCount,
    canClear,
    open,
    close,
    toggleOpen,
    ask,
    cancel,
    clearAndClose,
    toggleReadOnlyTools,
    clearPendingSelection,
  };
}
