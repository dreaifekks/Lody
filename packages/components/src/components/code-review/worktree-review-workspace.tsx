import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { PanelLeft, X } from 'lucide-react';
import type {
  CodeCollabAllChangesScope,
  CodeNavCallerItem,
  CodeNavDiffOutlineFile,
  CodeNavLocation,
  MachineId,
  SessionId,
  SessionMeta,
  SessionProjectRun,
} from '@lody/shared';
import type { DiffTokenEventBaseProps, TokenEventBase } from '@pierre/diffs';
import { cn } from '@/lib/utils';
import type { SessionFileProvider } from '@/lib/session-file-provider';
import type { PathLauncherFileTarget } from '@/lib/session-path-launchers';
import { ArticleDialogThreadContext } from '../boards/board-article-dialog';
import type { FileDiffData } from '../sessions/session-conversation-diff-types';
import { useSessionAllChangesDiffData } from '../sessions/use-session-all-changes-diff-data';
import { useCodeNav, type CodeNavQueryFn } from './use-code-nav';
import { useSessionOpenInIde } from './use-session-open-in-ide';
import {
  WorktreeReviewDiffView,
  type WorktreeReviewDiffTokenClick,
} from './worktree-review-diff-view';
import { WorktreeReviewFileTree } from './worktree-review-file-tree';
import { WorktreeReviewFileView, type WorktreeReviewReadFileFn } from './worktree-review-file-view';
import {
  createInitialReviewNavStack,
  extractTokenIdentifier,
  popReviewStackTo,
  pushReviewFileFrame,
  resolveDefinitionDecision,
  updateDiffFrameTarget,
  updateTopReviewFileFrame,
  type WorktreeReviewNavStack,
} from './worktree-review-nav-model';
import {
  WorktreeReviewTokenPopover,
  type WorktreeReviewTokenPopoverState,
} from './worktree-review-token-popover';
import {
  buildWorktreeReviewFileTree,
  formatCodeNavSymbolDisplayName,
  normalizeReviewTreePath,
  type WorktreeReviewTreeSymbol,
} from './worktree-review-tree-model';

const EMPTY_FILE_PATHS: string[] = [];

export interface WorktreeReviewDiffDataOverride {
  readonly filePaths: readonly string[];
  readonly resolvedByPath: Readonly<Record<string, FileDiffData>>;
  readonly base?: string | null;
  readonly statsByPath?: Readonly<
    Record<
      string,
      { readonly additions: number; readonly deletions: number; readonly firstLine?: number }
    >
  >;
}

export interface WorktreeReviewIdeOverride {
  readonly canOpen: boolean;
  readonly launcherLabel: string;
  readonly openWorktreeInIde: (fileTarget?: PathLauncherFileTarget) => Promise<boolean> | void;
}

export interface WorktreeReviewWorkspaceProps {
  readonly sessionId: SessionId;
  /** Workspace-owning session ID (parent session ID for child sessions sharing a worktree). */
  readonly ownerSessionId?: SessionId;
  /** Owner session's Project Group run metadata for multi-root `rootId` mapping. */
  readonly ownerProjectRun?: SessionProjectRun | null;
  readonly machineId: MachineId | null | undefined;
  readonly session?: SessionMeta | null;
  readonly branchName?: string | null;
  readonly fileProvider: SessionFileProvider | null;
  readonly fileProviderPending?: boolean;
  readonly fileProviderMessage?: string | null;
  readonly focusFilePath?: string | null;
  readonly onClose: () => void;
  readonly className?: string;
  /** Optional overrides for Storybook and unit tests. */
  readonly diffDataOverride?: WorktreeReviewDiffDataOverride;
  readonly codeNavOverride?: CodeNavQueryFn;
  readonly readFileOverride?: WorktreeReviewReadFileFn;
  readonly ideOverride?: WorktreeReviewIdeOverride;
  readonly initialNavStack?: WorktreeReviewNavStack;
  readonly initialPopover?: WorktreeReviewTokenPopoverState | null;
}

function getBasename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

function formatShortRef(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const trimmed = ref.trim();
  if (!trimmed) return null;
  if (/^[0-9a-f]{12,}$/iu.test(trimmed)) return trimmed.slice(0, 7);
  return trimmed;
}

const NARROW_WORKSPACE_BREAKPOINT = 680;
const COMPACT_HEADER_BREAKPOINT = 500;
const AUTO_FOLD_THREAD_VIEWPORT_WIDTH = 640;

export function WorktreeReviewWorkspace({
  sessionId,
  ownerSessionId,
  ownerProjectRun,
  machineId,
  session,
  branchName,
  fileProvider,
  fileProviderPending = false,
  fileProviderMessage = null,
  focusFilePath = null,
  onClose,
  className,
  diffDataOverride,
  codeNavOverride,
  readFileOverride,
  ideOverride,
  initialNavStack,
  initialPopover = null,
}: WorktreeReviewWorkspaceProps) {
  const threadControl = useContext(ArticleDialogThreadContext);

  // Independent local scope — defaults strictly to `'branch'`, never polluted
  // by the global `allChangesDiffScopeAtom`.
  const [scope] = useState<CodeCollabAllChangesScope>('branch');
  const [diffScrollNode, setDiffScrollNode] = useState<HTMLDivElement | null>(null);
  const [priorityFilePath, setPriorityFilePath] = useState<string | null>(focusFilePath);

  useEffect(() => {
    if (focusFilePath) {
      setPriorityFilePath(focusFilePath);
    }
  }, [focusFilePath]);

  // Responsive container width tracking so narrow panes auto-collapse the file
  // tree into an overlay drawer and keep the top bar overlap-free.
  const [workspaceNode, setWorkspaceNode] = useState<HTMLDivElement | null>(null);
  const [workspaceWidth, setWorkspaceWidth] = useState<number | null>(null);
  const [treeOpen, setTreeOpen] = useState(true);
  const prevNarrowRef = useRef<boolean | null>(null);
  const autoFoldedThreadRef = useRef(false);

  useEffect(() => {
    if (!workspaceNode || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => {
      const width = workspaceNode.getBoundingClientRect().width;
      if (width > 0) setWorkspaceWidth(width);
    };
    measure();
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (typeof width === 'number' && width > 0) {
        setWorkspaceWidth(width);
      }
    });
    observer.observe(workspaceNode);
    return () => observer.disconnect();
  }, [workspaceNode]);

  const isNarrowLayout = workspaceWidth !== null && workspaceWidth < NARROW_WORKSPACE_BREAKPOINT;
  const isCompactHeader = workspaceWidth !== null && workspaceWidth < COMPACT_HEADER_BREAKPOINT;

  useEffect(() => {
    if (workspaceWidth === null) return;
    const prev = prevNarrowRef.current;
    if (prev === null) {
      if (isNarrowLayout) setTreeOpen(false);
    } else if (prev !== isNarrowLayout) {
      setTreeOpen(!isNarrowLayout);
    }
    prevNarrowRef.current = isNarrowLayout;
  }, [isNarrowLayout, workspaceWidth]);

  useEffect(() => {
    if (!threadControl || autoFoldedThreadRef.current || typeof window === 'undefined') return;
    if (window.innerWidth < AUTO_FOLD_THREAD_VIEWPORT_WIDTH && !threadControl.hidden) {
      autoFoldedThreadRef.current = true;
      threadControl.setHidden(true);
    }
  }, [threadControl, workspaceWidth]);

  const liveDiffData = useSessionAllChangesDiffData({
    sessionId,
    filePaths: EMPTY_FILE_PATHS,
    focusPath: priorityFilePath,
    fileProvider,
    fileProviderPending,
    enabled: diffDataOverride === undefined,
    scope,
    viewport: { scrollContainer: diffScrollNode, priorityPath: priorityFilePath },
  });

  const filePaths = diffDataOverride ? diffDataOverride.filePaths : liveDiffData.normalizedPaths;
  const resolvedByPath = diffDataOverride
    ? diffDataOverride.resolvedByPath
    : liveDiffData.resolvedByPath;
  const visiblePaths = useMemo(
    () =>
      diffDataOverride
        ? new Set<string>(diffDataOverride.filePaths)
        : new Set<string>(liveDiffData.viewport.loadPaths),
    [diffDataOverride, liveDiffData.viewport.loadPaths]
  );
  const diffBase = diffDataOverride ? (diffDataOverride.base ?? null) : liveDiffData.base;

  // Monotonic diff revision fingerprint so AST query caches and in-flight
  // outlines invalidate immediately whenever the diff batch refreshes.
  const overrideRevisionRef = useRef<{
    override: WorktreeReviewDiffDataOverride | undefined;
    seq: number;
  }>({ override: diffDataOverride, seq: 0 });
  if (overrideRevisionRef.current.override !== diffDataOverride) {
    overrideRevisionRef.current = {
      override: diffDataOverride,
      seq: overrideRevisionRef.current.seq + 1,
    };
  }
  const diffRevision = useMemo(() => {
    if (diffDataOverride) {
      return `override:${overrideRevisionRef.current.seq}:${diffDataOverride.base ?? ''}:${diffDataOverride.filePaths.join('|')}`;
    }
    const contentKeys = filePaths
      .map((path) => {
        const entry = resolvedByPath[path];
        const key =
          entry && 'contentKey' in entry && typeof entry.contentKey === 'string'
            ? entry.contentKey
            : '';
        return `${path}@${entry?.status ?? ''}:${key}`;
      })
      .join('|');
    return `live:${liveDiffData.batchRevision}:${diffBase ?? ''}:${contentKeys}`;
  }, [diffBase, diffDataOverride, filePaths, liveDiffData.batchRevision, resolvedByPath]);

  const effectiveOwnerSessionId = (ownerSessionId ??
    session?.parentSessionId ??
    sessionId) as SessionId;
  const effectiveProjectRun = ownerProjectRun ?? session?.projectRun ?? null;

  const codeNav = useCodeNav({
    sessionId,
    ownerSessionId: effectiveOwnerSessionId,
    projectRun: effectiveProjectRun,
    machineId,
    revision: diffRevision,
    enabled: true,
    queryOverride: codeNavOverride,
  });

  const liveIde = useSessionOpenInIde(ideOverride ? null : session);
  const canOpenInIde = ideOverride ? ideOverride.canOpen : liveIde.canOpen;
  const ideLauncherLabel = ideOverride ? ideOverride.launcherLabel : liveIde.launcherLabel;
  const openWorktreeInIde = useCallback(
    (filePath?: string | null, line?: number, column?: number) => {
      const target: PathLauncherFileTarget | undefined = filePath
        ? {
            filePath,
            ...(line !== undefined && line > 0 ? { line } : {}),
            ...(column !== undefined && column > 0 ? { column } : {}),
          }
        : undefined;
      if (ideOverride) {
        void ideOverride.openWorktreeInIde(target);
        return;
      }
      void liveIde.openWorktreeInIde(target);
    },
    [ideOverride, liveIde]
  );

  // Fetch diff outline via `code-nav/query` when supported; re-runs and drops
  // stale in-flight replies whenever the diff revision changes.
  const [outlineFiles, setOutlineFiles] = useState<readonly CodeNavDiffOutlineFile[]>([]);
  useEffect(() => {
    if (!codeNav.supported) {
      setOutlineFiles([]);
      return undefined;
    }
    let cancelled = false;
    void codeNav.queryDiffOutline(scope, diffBase ?? undefined).then((result) => {
      if (!cancelled && result) {
        setOutlineFiles(result.files);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [codeNav, diffBase, diffRevision, scope]);

  const outlineByPath = useMemo(() => {
    const map = new Map<string, CodeNavDiffOutlineFile>();
    for (const file of outlineFiles) {
      map.set(file.path, file);
      map.set(normalizeReviewTreePath(file.path), file);
    }
    return map;
  }, [outlineFiles]);

  // Line stats resolved from DiffViewer parsed metadata (or fixture overrides).
  const [statsByPath, setStatsByPath] = useState<
    Map<string, { additions: number; deletions: number; firstLine: number }>
  >(() => {
    const map = new Map<string, { additions: number; deletions: number; firstLine: number }>();
    if (diffDataOverride?.statsByPath) {
      for (const [path, stat] of Object.entries(diffDataOverride.statsByPath)) {
        map.set(path, {
          additions: stat.additions,
          deletions: stat.deletions,
          firstLine: stat.firstLine ?? 1,
        });
      }
    }
    return map;
  });

  const handleStatsResolved = useCallback(
    (filePath: string, next: { additions: number; deletions: number; firstLine: number }) => {
      setStatsByPath((prev) => {
        const cur = prev.get(filePath);
        if (
          cur &&
          cur.additions === next.additions &&
          cur.deletions === next.deletions &&
          cur.firstLine === next.firstLine
        ) {
          return prev;
        }
        const copy = new Map(prev);
        copy.set(filePath, next);
        return copy;
      });
    },
    []
  );

  // Seed stats immediately for `ready-parsed` diffs.
  useEffect(() => {
    setStatsByPath((prev) => {
      let changed = false;
      const copy = new Map(prev);
      for (const path of filePaths) {
        const data = resolvedByPath[path];
        if (data?.status === 'ready-parsed') {
          let additions = 0;
          let deletions = 0;
          for (const hunk of data.fileDiff.hunks) {
            additions += hunk.additionLines;
            deletions += hunk.deletionLines;
          }
          const firstLine = Math.max(1, data.fileDiff.hunks[0]?.additionStart ?? 1);
          const cur = copy.get(path);
          if (
            !cur ||
            cur.additions !== additions ||
            cur.deletions !== deletions ||
            cur.firstLine !== firstLine
          ) {
            copy.set(path, { additions, deletions, firstLine });
            changed = true;
          }
        }
      }
      return changed ? copy : prev;
    });
  }, [filePaths, resolvedByPath]);

  const treeModel = useMemo(
    () =>
      buildWorktreeReviewFileTree(
        filePaths.map((path) => {
          const stat = statsByPath.get(path);
          return {
            path,
            additions: stat?.additions ?? 0,
            deletions: stat?.deletions ?? 0,
          };
        }),
        outlineByPath
      ),
    [filePaths, outlineByPath, statsByPath]
  );

  const [showTreeSymbols, setShowTreeSymbols] = useState(true);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(
    () => focusFilePath ?? filePaths[0] ?? null
  );
  const [activeSymbolId, setActiveSymbolId] = useState<string | null>(null);
  const [openByPath, setOpenByPath] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!activeFilePath && filePaths.length > 0) {
      setActiveFilePath(focusFilePath ?? filePaths[0]!);
    }
  }, [activeFilePath, filePaths, focusFilePath]);

  const [navStack, setNavStack] = useState<WorktreeReviewNavStack>(
    () => initialNavStack ?? createInitialReviewNavStack(focusFilePath ?? filePaths[0] ?? null)
  );
  const topFrame = navStack[navStack.length - 1]!;

  useEffect(() => {
    if (!activeFilePath) return;
    const outline = outlineByPath.get(activeFilePath);
    const stat = statsByPath.get(activeFilePath);
    const line =
      outline?.hunks[0]?.startLine && outline.hunks[0].startLine > 0
        ? outline.hunks[0].startLine
        : stat?.firstLine;
    setNavStack((prev) => updateDiffFrameTarget(prev, activeFilePath, line));
  }, [activeFilePath, outlineByPath, statsByPath]);

  // Card DOM elements for smooth scroll from the File Tree.
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const registerCardRef = useCallback(
    (filePath: string, node: HTMLElement | null) => {
      if (node) cardRefs.current.set(filePath, node);
      else cardRefs.current.delete(filePath);
      if (!diffDataOverride) {
        liveDiffData.viewport.registerPath(filePath, node as HTMLDivElement | null);
      }
    },
    [diffDataOverride, liveDiffData.viewport]
  );

  const scrollToFileCard = useCallback((filePath: string) => {
    const scroll = () => {
      const node = cardRefs.current.get(filePath);
      node?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(scroll);
    } else {
      scroll();
    }
  }, []);

  const [popover, setPopover] = useState<WorktreeReviewTokenPopoverState | null>(initialPopover);
  const prevInitialPopoverRef = useRef(initialPopover);
  useEffect(() => {
    if (prevInitialPopoverRef.current !== initialPopover) {
      prevInitialPopoverRef.current = initialPopover;
      setPopover(initialPopover);
    }
  }, [initialPopover]);
  const popoverSeqRef = useRef(0);
  const prevDiffRevisionRef = useRef(diffRevision);
  useEffect(() => {
    if (prevDiffRevisionRef.current !== diffRevision) {
      prevDiffRevisionRef.current = diffRevision;
      popoverSeqRef.current += 1;
      setPopover(null);
    }
  }, [diffRevision]);

  const handleClosePopover = useCallback(() => {
    popoverSeqRef.current += 1;
    setPopover(null);
  }, []);

  const handleSelectTreeFile = useCallback(
    (filePath: string) => {
      handleClosePopover();
      setActiveFilePath(filePath);
      setPriorityFilePath(filePath);
      setActiveSymbolId(null);
      setOpenByPath((prev) => (prev[filePath] === false ? { ...prev, [filePath]: true } : prev));
      setNavStack((prev) => popReviewStackTo(prev, 0));
      if (isNarrowLayout) setTreeOpen(false);
      scrollToFileCard(filePath);
    },
    [handleClosePopover, isNarrowLayout, scrollToFileCard]
  );

  const handleSelectTreeSymbol = useCallback(
    (filePath: string, symbol: WorktreeReviewTreeSymbol) => {
      handleClosePopover();
      setActiveFilePath(filePath);
      setPriorityFilePath(filePath);
      setActiveSymbolId(symbol.id);
      setOpenByPath((prev) => (prev[filePath] === false ? { ...prev, [filePath]: true } : prev));
      setNavStack((prev) =>
        updateDiffFrameTarget(popReviewStackTo(prev, 0), filePath, symbol.startLine)
      );
      if (isNarrowLayout) setTreeOpen(false);
      scrollToFileCard(filePath);
    },
    [handleClosePopover, isNarrowLayout, scrollToFileCard]
  );

  const handleCardOpenChange = useCallback((filePath: string, nextOpen: boolean) => {
    setOpenByPath((prev) => ({ ...prev, [filePath]: nextOpen }));
  }, []);

  const openLocationInFileView = useCallback(
    (location: CodeNavLocation, options?: { readonly loadCallers?: boolean }) => {
      handleClosePopover();
      const label = formatCodeNavSymbolDisplayName(location);
      setNavStack((prev) =>
        pushReviewFileFrame(prev, {
          kind: 'file',
          label,
          filePath: location.path,
          line: location.line,
          ...(location.endLine !== undefined ? { endLine: location.endLine } : {}),
          ...(options?.loadCallers ? { callersLoading: true, callersSymbol: location.name } : {}),
        })
      );
      if (options?.loadCallers && codeNav.supported) {
        void codeNav
          .queryCallers({
            path: location.path,
            line: location.line,
            character: location.character,
            symbolHint: location.name,
            maxDepth: 1,
          })
          .then((callersResult) => {
            setNavStack((prev) =>
              updateTopReviewFileFrame(prev, (frame) => {
                if (frame.filePath !== location.path || frame.line !== location.line) return frame;
                return {
                  ...frame,
                  callersLoading: false,
                  callers: callersResult && callersResult.items.length > 0 ? callersResult : null,
                };
              })
            );
          });
      }
    },
    [codeNav, handleClosePopover]
  );

  const handleTokenInteraction = useCallback(
    (filePath: string, token: TokenEventBase | DiffTokenEventBaseProps, event: MouseEvent) => {
      // Never intercept drag-selection.
      if (typeof window !== 'undefined' && window.getSelection()?.toString().trim()) {
        return;
      }
      // Deletion-side rows carry pre-change coordinates that do not match the
      // current worktree AST; disable current-worktree definition/callers lookups
      // and Cmd/Ctrl+Click jumps to prevent jumping to an unrelated new-side symbol.
      const isDeletionSide = 'side' in token && token.side === 'deletions';
      if (isDeletionSide) {
        return;
      }
      const extracted = extractTokenIdentifier(token.tokenText, token.lineCharStart);
      if (!extracted) return;

      const rect = token.tokenElement.getBoundingClientRect();
      const anchor = { left: rect.left, top: rect.top, bottom: rect.bottom };
      const reqId = ++popoverSeqRef.current;

      // Cmd/Ctrl+Click: fast-path jump to definition ONLY for unique exact matches;
      // otherwise open the compact candidate picker without blind-jumping.
      if ((event.metaKey || event.ctrlKey) && codeNav.supported) {
        event.preventDefault();
        void codeNav
          .queryDefinition({
            path: filePath,
            line: token.lineNumber,
            character: extracted.character,
            symbolHint: extracted.symbol,
          })
          .then((result) => {
            if (popoverSeqRef.current !== reqId) return;
            if (!result || result.items.length === 0) {
              setPopover({
                mode: 'candidates',
                symbol: extracted.symbol,
                filePath,
                line: token.lineNumber,
                character: extracted.character,
                anchor,
                items: [],
                confidence: 'heuristic',
                totalCandidates: 0,
              });
              return;
            }
            const decision = resolveDefinitionDecision(result);
            if (decision.kind === 'direct-jump') {
              openLocationInFileView(decision.target, { loadCallers: true });
            } else {
              setPopover({
                mode: 'candidates',
                symbol: decision.symbol || extracted.symbol,
                filePath,
                line: token.lineNumber,
                character: extracted.character,
                anchor,
                items: decision.items,
                confidence: decision.confidence,
                totalCandidates: decision.totalCandidates,
              });
            }
          });
        return;
      }

      // Plain click: open minimalist action menu immediately and prefetch definition target preview.
      setPopover({
        mode: 'actions',
        symbol: extracted.symbol,
        filePath,
        line: token.lineNumber,
        character: extracted.character,
        anchor,
        loadingAction: null,
        emptyNotice: null,
      });

      if (codeNav.supported) {
        void codeNav
          .queryDefinition({
            path: filePath,
            line: token.lineNumber,
            character: extracted.character,
            symbolHint: extracted.symbol,
          })
          .then((result) => {
            if (popoverSeqRef.current !== reqId || !result) return;
            const decision = resolveDefinitionDecision(result);
            setPopover((current) => {
              if (!current || current.mode !== 'actions') return current;
              if (decision.kind === 'direct-jump') {
                return {
                  ...current,
                  definitionPreview: {
                    targetLabel: `${getBasename(decision.target.path)}:${decision.target.line}`,
                    location: decision.target,
                  },
                  definitionCount: 1,
                };
              }
              return {
                ...current,
                definitionCount: decision.totalCandidates,
              };
            });
          });
      }
    },
    [codeNav, openLocationInFileView]
  );

  const handleDiffTokenClick = useCallback(
    (payload: WorktreeReviewDiffTokenClick) => {
      handleTokenInteraction(payload.filePath, payload.token, payload.event);
    },
    [handleTokenInteraction]
  );

  const handleFileTokenClick = useCallback(
    (payload: {
      readonly filePath: string;
      readonly token: TokenEventBase;
      readonly event: MouseEvent;
    }) => {
      handleTokenInteraction(payload.filePath, payload.token, payload.event);
    },
    [handleTokenInteraction]
  );

  const handlePopoverGoToDefinition = useCallback(() => {
    if (!popover || popover.mode !== 'actions' || popover.codeNavDisabled) return;
    if (popover.definitionPreview) {
      openLocationInFileView(popover.definitionPreview.location, { loadCallers: true });
      return;
    }
    const reqId = ++popoverSeqRef.current;
    const { filePath, line, character, symbol, anchor } = popover;
    setPopover((current) =>
      current && current.mode === 'actions'
        ? { ...current, loadingAction: 'definition', emptyNotice: null }
        : current
    );
    void codeNav
      .queryDefinition({ path: filePath, line, character, symbolHint: symbol })
      .then((result) => {
        if (popoverSeqRef.current !== reqId) return;
        if (!result || result.items.length === 0) {
          setPopover((current) =>
            current && current.mode === 'actions'
              ? { ...current, loadingAction: null, emptyNotice: 'definition' }
              : current
          );
          return;
        }
        const decision = resolveDefinitionDecision(result);
        if (decision.kind === 'direct-jump') {
          openLocationInFileView(decision.target, { loadCallers: true });
        } else {
          setPopover({
            mode: 'candidates',
            symbol: decision.symbol || symbol,
            filePath,
            line,
            character,
            anchor,
            items: decision.items,
            confidence: decision.confidence,
            totalCandidates: decision.totalCandidates,
          });
        }
      });
  }, [codeNav, openLocationInFileView, popover]);

  const handlePopoverFindCallers = useCallback(() => {
    if (!popover || popover.mode !== 'actions' || popover.codeNavDisabled) return;
    const reqId = ++popoverSeqRef.current;
    const { filePath, line, character, symbol } = popover;
    setPopover((current) =>
      current && current.mode === 'actions'
        ? { ...current, loadingAction: 'callers', emptyNotice: null }
        : current
    );
    void codeNav
      .queryCallers({ path: filePath, line, character, symbolHint: symbol, maxDepth: 1 })
      .then((result) => {
        if (popoverSeqRef.current !== reqId) return;
        if (!result || result.items.length === 0) {
          setPopover((current) =>
            current && current.mode === 'actions'
              ? { ...current, loadingAction: null, emptyNotice: 'callers', callersCount: 0 }
              : current
          );
          return;
        }
        handleClosePopover();
        setNavStack((prev) =>
          pushReviewFileFrame(prev, {
            kind: 'file',
            label: symbol,
            filePath,
            line,
            callers: result,
            callersSymbol: symbol,
            callersHopDepth: 1,
          })
        );
      });
  }, [codeNav, handleClosePopover, popover]);

  const handleSelectCaller = useCallback(
    (caller: CodeNavCallerItem) => {
      handleClosePopover();
      const label = caller.caller
        ? formatCodeNavSymbolDisplayName(caller.caller)
        : getBasename(caller.path);
      setNavStack((prev) =>
        pushReviewFileFrame(prev, {
          kind: 'file',
          label,
          filePath: caller.path,
          line: caller.line,
        })
      );
    },
    [handleClosePopover]
  );

  const handleTraceCallerFurther = useCallback(
    (caller: CodeNavCallerItem) => {
      handleClosePopover();
      const enclosing = caller.caller;
      const label = enclosing
        ? formatCodeNavSymbolDisplayName(enclosing)
        : getBasename(caller.path);
      const targetLine = enclosing ? enclosing.startLine : caller.line;
      setNavStack((prev) =>
        pushReviewFileFrame(prev, {
          kind: 'file',
          label,
          filePath: caller.path,
          line: caller.line,
          callersLoading: Boolean(enclosing && codeNav.supported),
          callersSymbol: enclosing?.name,
          callersHopDepth: 2,
        })
      );
      if (!enclosing || !codeNav.supported) return;
      void codeNav
        .queryCallers({
          path: caller.path,
          line: targetLine,
          character: 0,
          symbolHint: enclosing.name,
          maxDepth: 1,
        })
        .then((nextCallers) => {
          setNavStack((prev) =>
            updateTopReviewFileFrame(prev, (frame) => {
              if (frame.filePath !== caller.path || frame.line !== caller.line) return frame;
              return {
                ...frame,
                callersLoading: false,
                callers: nextCallers,
              };
            })
          );
        });
    },
    [codeNav, handleClosePopover]
  );

  const branchBadgeLabel =
    branchName?.trim() ||
    session?.branchName?.trim() ||
    formatShortRef(diffBase) ||
    session?.title?.trim() ||
    'worktree';

  const topIdeFilePath = topFrame.filePath ?? activeFilePath;
  const topIdeLine = topFrame.line;
  const topIdeLabel = isCompactHeader
    ? 'IDE'
    : topIdeLine
      ? `${ideLauncherLabel} :${topIdeLine}`
      : ideLauncherLabel;

  const providerUnavailableMessage =
    !diffDataOverride && !fileProviderPending && (!fileProvider || !fileProvider.getAllChangesDiff)
      ? fileProviderMessage?.trim() || 'Diff unavailable'
      : null;

  const emptyMessage = useMemo(() => {
    if (diffDataOverride) {
      return diffDataOverride.filePaths.length === 0 ? 'No changes.' : null;
    }
    if (providerUnavailableMessage) return providerUnavailableMessage;
    if (liveDiffData.unavailableMessage) return liveDiffData.unavailableMessage;
    if (liveDiffData.isDiffUnavailable) return 'Diff unavailable';
    if (liveDiffData.batchReady && filePaths.length === 0) return 'No changes.';
    return null;
  }, [
    diffDataOverride,
    filePaths.length,
    liveDiffData.batchReady,
    liveDiffData.isDiffUnavailable,
    liveDiffData.unavailableMessage,
    providerUnavailableMessage,
  ]);

  return (
    <div
      ref={setWorkspaceNode}
      data-worktree-review-workspace=""
      className={cn(
        'flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground',
        className
      )}
    >
      {/* Top Bar */}
      <header
        className={cn(
          'flex h-11 shrink-0 items-center justify-between border-b border-border overflow-hidden',
          isCompactHeader ? 'gap-1.5 px-2.5' : 'gap-2.5 px-3.5'
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          <button
            type="button"
            data-review-toggle-tree=""
            aria-label="Toggle file tree"
            aria-expanded={treeOpen}
            title={treeOpen ? '收起文件树' : '展开文件树'}
            onClick={() => setTreeOpen((prev) => !prev)}
            className={cn(
              'inline-flex h-[27px] w-[27px] shrink-0 items-center justify-center rounded-[7px] border transition-colors cursor-pointer',
              treeOpen
                ? 'border-border bg-foreground/[0.06] text-foreground hover:bg-[hsl(var(--hover))]'
                : 'border-border bg-background text-muted-foreground hover:bg-[hsl(var(--hover))] hover:text-foreground'
            )}
          >
            <PanelLeft className="h-3.5 w-3.5" aria-hidden="true" />
          </button>

          {!isCompactHeader ? (
            <span
              data-review-branch-pill=""
              className="inline-flex max-w-[200px] shrink-0 items-center gap-1.5 rounded-[6px] bg-foreground/[0.06] px-2 py-0.5 font-mono text-[11.5px] text-foreground/85"
              title={branchBadgeLabel}
            >
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-[hsl(var(--status-success))]"
                aria-hidden="true"
              />
              <span className="truncate">{branchBadgeLabel}</span>
            </span>
          ) : null}

          <nav
            aria-label="Review navigation"
            data-review-breadcrumbs=""
            className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden text-[12.5px]"
          >
            {navStack.map((frame, index) => {
              const isCurrent = index === navStack.length - 1;
              return (
                <div
                  key={`${frame.kind}:${frame.label}:${index}`}
                  className="flex min-w-0 items-center gap-0.5"
                >
                  {index > 0 ? (
                    <span
                      className="select-none px-0.5 text-muted-foreground/60"
                      aria-hidden="true"
                    >
                      ›
                    </span>
                  ) : null}
                  <button
                    type="button"
                    data-review-crumb={index}
                    aria-current={isCurrent ? 'page' : undefined}
                    onClick={() => {
                      handleClosePopover();
                      setNavStack((prev) => popReviewStackTo(prev, index));
                    }}
                    className={cn(
                      'max-w-[210px] truncate rounded-[6px] px-2 py-0.5 transition-colors cursor-pointer',
                      frame.kind !== 'diff' && 'font-mono',
                      isCurrent
                        ? 'bg-foreground/[0.06] font-medium text-foreground'
                        : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground'
                    )}
                    title={frame.label}
                  >
                    {frame.label}
                  </button>
                </div>
              );
            })}
          </nav>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {canOpenInIde ? (
            <button
              type="button"
              data-review-open-ide-top=""
              onClick={() => openWorktreeInIde(topIdeFilePath, topIdeLine)}
              title={topIdeLine ? `${ideLauncherLabel} :${topIdeLine}` : ideLauncherLabel}
              className="inline-flex h-[27px] items-center gap-1 rounded-[7px] bg-[color-mix(in_oklab,hsl(var(--primary))_13%,transparent)] px-2.5 text-[12px] font-medium text-[hsl(var(--primary))] transition-colors hover:bg-[color-mix(in_oklab,hsl(var(--primary))_20%,transparent)] cursor-pointer whitespace-nowrap"
            >
              <span aria-hidden="true">↗</span>
              <span className="font-mono">{topIdeLabel}</span>
            </button>
          ) : null}

          {threadControl ? (
            <button
              type="button"
              data-review-toggle-chat=""
              onClick={() => threadControl.setHidden(!threadControl.hidden)}
              className="inline-flex h-[27px] items-center rounded-[7px] border border-border bg-background px-2.5 text-[12px] text-foreground transition-colors hover:bg-[hsl(var(--hover))] cursor-pointer whitespace-nowrap"
            >
              {threadControl.hidden ? '展开对话' : '收起对话'}
            </button>
          ) : null}

          <button
            type="button"
            data-review-close=""
            aria-label="Close"
            onClick={onClose}
            className="inline-flex h-[27px] w-[27px] items-center justify-center rounded-[7px] border border-border bg-background text-muted-foreground transition-colors hover:bg-[hsl(var(--hover))] hover:text-foreground cursor-pointer"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </header>

      {/* Body: Left File Tree (collapsible / overlay on narrow viewports) + Main Diff / Traced File Canvas */}
      <div
        className={cn(
          'relative grid min-h-0 flex-1',
          !isNarrowLayout && treeOpen
            ? 'grid-cols-[248px_minmax(0,1fr)]'
            : 'grid-cols-[minmax(0,1fr)]'
        )}
      >
        {!isNarrowLayout && treeOpen ? (
          <WorktreeReviewFileTree
            tree={treeModel}
            activeFilePath={activeFilePath}
            activeSymbolId={activeSymbolId}
            symbolsAvailable={codeNav.supported}
            showSymbols={showTreeSymbols}
            onToggleShowSymbols={() => setShowTreeSymbols((prev) => !prev)}
            onSelectFile={handleSelectTreeFile}
            onSelectSymbol={handleSelectTreeSymbol}
          />
        ) : null}

        {isNarrowLayout && treeOpen ? (
          <>
            <div
              aria-hidden="true"
              data-review-tree-backdrop=""
              onClick={() => setTreeOpen(false)}
              className="absolute inset-0 z-20 bg-black/25"
            />
            <div
              data-review-tree-overlay=""
              className="absolute inset-y-0 left-0 z-30 flex w-[248px] max-w-[85%] shadow-xl"
            >
              <WorktreeReviewFileTree
                tree={treeModel}
                activeFilePath={activeFilePath}
                activeSymbolId={activeSymbolId}
                symbolsAvailable={codeNav.supported}
                showSymbols={showTreeSymbols}
                onToggleShowSymbols={() => setShowTreeSymbols((prev) => !prev)}
                onSelectFile={handleSelectTreeFile}
                onSelectSymbol={handleSelectTreeSymbol}
                className="w-full"
              />
            </div>
          </>
        ) : null}

        <div className="relative min-h-0 min-w-0 flex flex-col">
          {/* Diff scroll container stays mounted and keeps its scroll offset & expanded functions alive */}
          <div
            ref={setDiffScrollNode}
            role="region"
            aria-label="Diff"
            hidden={topFrame.kind !== 'diff'}
            data-review-diff-scroll=""
            className="scrollbar-pro min-h-0 flex-1 overflow-y-auto px-[18px] pb-7 pt-3.5"
          >
            <WorktreeReviewDiffView
              filePaths={filePaths}
              resolvedByPath={resolvedByPath}
              visiblePaths={visiblePaths}
              outlineByPath={outlineByPath}
              statsByPath={statsByPath}
              openByPath={openByPath}
              onOpenChange={handleCardOpenChange}
              loading={!diffDataOverride && !providerUnavailableMessage && !liveDiffData.batchReady}
              emptyMessage={emptyMessage}
              codeNavSupported={codeNav.supported}
              canOpenInIde={canOpenInIde}
              onTokenClick={handleDiffTokenClick}
              onOpenInIde={(filePath, line) => openWorktreeInIde(filePath, line)}
              onCardRef={registerCardRef}
              onStatsResolved={handleStatsResolved}
            />
          </div>

          {/* Traced read-only file view (`@pierre/diffs` `<File>`, zero Monaco) */}
          {topFrame.kind === 'file' ? (
            <div
              role="region"
              aria-label={topFrame.filePath}
              data-review-file-scroll=""
              className="scrollbar-pro min-h-0 flex-1 overflow-y-auto px-[18px] pb-7 pt-3.5"
            >
              <WorktreeReviewFileView
                filePath={topFrame.filePath}
                line={topFrame.line}
                endLine={topFrame.endLine}
                fileProvider={fileProvider}
                readFileOverride={readFileOverride}
                callers={topFrame.callers}
                callersLoading={topFrame.callersLoading}
                codeNavSupported={codeNav.supported}
                canOpenInIde={canOpenInIde}
                onBackToDiff={() => {
                  handleClosePopover();
                  setNavStack((prev) => popReviewStackTo(prev, 0));
                }}
                onTokenClick={handleFileTokenClick}
                onSelectCaller={handleSelectCaller}
                onTraceCallerFurther={handleTraceCallerFurther}
                onOpenInIde={(filePath, line, column) => openWorktreeInIde(filePath, line, column)}
              />
            </div>
          ) : null}
        </div>
      </div>

      <WorktreeReviewTokenPopover
        state={popover}
        canOpenInIde={canOpenInIde}
        onClose={handleClosePopover}
        onGoToDefinition={handlePopoverGoToDefinition}
        onFindCallers={handlePopoverFindCallers}
        onSelectCandidate={(location) => openLocationInFileView(location, { loadCallers: true })}
        onOpenInIde={(filePath, line, column) => openWorktreeInIde(filePath, line, column)}
      />
    </div>
  );
}
