import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { CodeNavCallerItem, CodeNavCallersOk } from '@lody/shared';
import {
  canUseWASM,
  type FileContents,
  type SupportedLanguages,
  type TokenEventBase,
} from '@pierre/diffs';
import {
  File as PierreFile,
  type FileOptions,
  type WorkerInitializationRenderOptions,
} from '@pierre/diffs/react';
import { DiffRenderWorkerProvider } from '@/ui/diff-viewer/diff-viewer';
import { DEFAULT_VSCODE_DIFF_THEME_FALLBACK } from '@/lib/vscode-theme';
import { useActiveVSCodeDiffThemeName, useResolvedTheme } from '@/theme-provider';
import { Skeleton } from '@lody/ui/skeleton';
import type { SessionFileProvider } from '@/lib/session-file-provider';
import { REVIEW_INTERACTIVE_TOKEN_UNSAFE_CSS } from './worktree-review-diff-view';
import { formatCodeNavSymbolDisplayName } from './worktree-review-tree-model';

const MAX_PAGED_READ_BYTES = 512 * 1024;

export type WorktreeReviewReadFileFn = (
  filePath: string
) => Promise<
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string }
>;

export interface WorktreeReviewFileViewProps {
  readonly filePath: string;
  readonly line: number;
  readonly endLine?: number;
  readonly fileProvider: SessionFileProvider | null;
  /** Optional injected file reader for Storybook and unit tests. */
  readonly readFileOverride?: WorktreeReviewReadFileFn;
  readonly callers?: CodeNavCallersOk | null;
  readonly callersLoading?: boolean;
  readonly codeNavSupported: boolean;
  readonly canOpenInIde: boolean;
  readonly onBackToDiff: () => void;
  readonly onTokenClick: (payload: {
    readonly filePath: string;
    readonly token: TokenEventBase;
    readonly event: MouseEvent;
  }) => void;
  readonly onSelectCaller: (caller: CodeNavCallerItem) => void;
  readonly onTraceCallerFurther: (caller: CodeNavCallerItem) => void;
  readonly onOpenInIde: (filePath: string, line?: number, column?: number) => void;
}

function splitPathParts(filePath: string): { dir: string; name: string } {
  const normalized = filePath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  if (idx === -1) return { dir: '', name: normalized };
  return { dir: normalized.slice(0, idx + 1), name: normalized.slice(idx + 1) };
}

function getExtension(filePath: string): SupportedLanguages | undefined {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1 || dot === filePath.length - 1) return undefined;
  return filePath.slice(dot + 1).toLowerCase() as SupportedLanguages;
}

async function readFileFromProvider(
  provider: SessionFileProvider,
  filePath: string,
  signal: AbortSignal
): Promise<
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string }
> {
  const opened = await provider.openFile(filePath);
  if (opened.status === 'unavailable') {
    return { ok: false, message: opened.message ?? opened.reason };
  }
  const { snapshot } = opened;
  if (snapshot.kind === 'text') {
    return { ok: true, text: snapshot.text };
  }
  if (snapshot.kind === 'paged-text') {
    const pagesToRead = Math.max(
      1,
      Math.ceil(
        Math.min(snapshot.source.sizeBytes, MAX_PAGED_READ_BYTES) / snapshot.source.pageBytes
      )
    );
    const chunks: string[] = [];
    for (let page = 0; page < pagesToRead; page += 1) {
      if (signal.aborted) return { ok: false, message: 'Cancelled' };
      chunks.push(await snapshot.source.readPage(page, signal));
    }
    return { ok: true, text: chunks.join('') };
  }
  if (snapshot.kind === 'binary') {
    return { ok: false, message: 'Binary file' };
  }
  return { ok: false, message: snapshot.message ?? snapshot.reason };
}

export function WorktreeReviewFileView({
  filePath,
  line,
  endLine,
  fileProvider,
  readFileOverride,
  callers,
  callersLoading = false,
  codeNavSupported,
  canOpenInIde,
  onBackToDiff,
  onTokenClick,
  onSelectCaller,
  onTraceCallerFurther,
  onOpenInIde,
}: WorktreeReviewFileViewProps) {
  const resolvedTheme = useResolvedTheme();
  const activeDiffThemeName = useActiveVSCodeDiffThemeName();

  const [fileState, setFileState] = useState<
    | { readonly status: 'loading' }
    | { readonly status: 'ready'; readonly text: string }
    | { readonly status: 'error'; readonly message: string }
  >({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setFileState({ status: 'loading' });

    const run = async () => {
      try {
        const result = readFileOverride
          ? await readFileOverride(filePath)
          : fileProvider
            ? await readFileFromProvider(fileProvider, filePath, controller.signal)
            : { ok: false as const, message: 'File provider unavailable' };
        if (cancelled) return;
        if (result.ok) {
          setFileState({ status: 'ready', text: result.text });
        } else {
          setFileState({ status: 'error', message: result.message });
        }
      } catch (error) {
        if (!cancelled) {
          setFileState({
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };
    void run();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [filePath, fileProvider, readFileOverride]);

  const scrolledTargetRef = useRef<string | null>(null);
  const targetKey = `${filePath}:${line}`;

  const onTokenClickRef = useRef(onTokenClick);
  onTokenClickRef.current = onTokenClick;

  const handleTokenClick = useCallback(
    (token: TokenEventBase, event: MouseEvent) => {
      onTokenClickRef.current({ filePath, token, event });
    },
    [filePath]
  );

  const handlePostRender = useCallback(
    (node: HTMLElement) => {
      if (scrolledTargetRef.current === targetKey) return;
      const lineNode = node.shadowRoot?.querySelector<HTMLElement>(`[data-line="${line}"]`);
      if (lineNode) {
        scrolledTargetRef.current = targetKey;
        lineNode.scrollIntoView({ block: 'center', behavior: 'instant' });
      }
    },
    [line, targetKey]
  );

  const renderGutterUtility = useCallback(
    (getHoveredLine: () => { lineNumber: number } | undefined) => {
      if (!canOpenInIde) return null;
      return (
        <button
          type="button"
          title="↗ IDE"
          aria-label="Open line in IDE"
          onClick={(event) => {
            event.stopPropagation();
            const hovered = getHoveredLine();
            if (hovered) onOpenInIde(filePath, hovered.lineNumber);
          }}
          className="flex h-5 w-5 items-center justify-center rounded text-[11px] text-muted-foreground transition-colors hover:bg-[hsl(var(--hover))] hover:text-[hsl(var(--primary))] cursor-pointer"
        >
          ↗
        </button>
      );
    },
    [canOpenInIde, filePath, onOpenInIde]
  );

  const workerOptions = useMemo<WorkerInitializationRenderOptions>(
    () => ({
      lineDiffType: 'word',
      preferredHighlighter: canUseWASM() ? 'highlights' : 'shiki-js',
      theme: activeDiffThemeName ?? DEFAULT_VSCODE_DIFF_THEME_FALLBACK,
      tokenizeMaxLineLength: 20_000,
      ...(codeNavSupported ? { useTokenTransformer: true } : {}),
    }),
    [activeDiffThemeName, codeNavSupported]
  );

  const fileContents = useMemo<FileContents | null>(() => {
    if (fileState.status !== 'ready') return null;
    return {
      name: filePath,
      contents: fileState.text,
      lang: getExtension(filePath),
    };
  }, [filePath, fileState]);

  const fileOptions = useMemo<FileOptions<undefined, undefined>>(
    () => ({
      preferredHighlighter: canUseWASM() ? 'highlights' : 'shiki-js',
      theme: activeDiffThemeName ?? DEFAULT_VSCODE_DIFF_THEME_FALLBACK,
      themeType: resolvedTheme,
      overflow: 'wrap',
      disableFileHeader: true,
      enableGutterUtility: canOpenInIde,
      ...(codeNavSupported
        ? {
            useTokenTransformer: true,
            onTokenClick: handleTokenClick,
            unsafeCSS: REVIEW_INTERACTIVE_TOKEN_UNSAFE_CSS,
          }
        : {}),
      onPostRender: handlePostRender,
    }),
    [
      activeDiffThemeName,
      canOpenInIde,
      codeNavSupported,
      handlePostRender,
      handleTokenClick,
      resolvedTheme,
    ]
  );

  const selectedLines = useMemo(
    () => ({
      start: Math.max(1, line),
      end: Math.max(line, endLine ?? line),
    }),
    [endLine, line]
  );

  const pierreHostStyle = useMemo<CSSProperties>(
    () =>
      ({
        ['--diffs-light-bg' as string]: 'hsl(var(--background))',
        ['--diffs-dark-bg' as string]: 'hsl(var(--background))',
        ['--diffs-bg-buffer-override' as string]: 'hsl(var(--background))',
        ['--diffs-bg-context-override' as string]: 'hsl(var(--background))',
        ['--diffs-selection-color-override' as string]:
          'color-mix(in oklab, hsl(var(--primary)) 16%, hsl(var(--background)))',
      }) as CSSProperties,
    []
  );

  const { dir, name } = splitPathParts(filePath);

  return (
    <div data-worktree-review-file-view={filePath}>
      <section className="overflow-hidden rounded-[10px] border border-foreground/[0.12] bg-background dark:border-border">
        <div className="flex items-center justify-between gap-2 border-b border-border bg-[color-mix(in_oklab,hsl(var(--foreground))_4%,hsl(var(--background)))] px-3 py-2">
          <div
            className="min-w-0 truncate font-mono text-[12px] font-medium text-foreground"
            title={`${filePath}:${line}`}
          >
            {dir ? <span className="font-normal text-muted-foreground">{dir}</span> : null}
            {name}
            <span className="ml-1 font-normal text-muted-foreground tabular-nums">:{line}</span>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {canOpenInIde ? (
              <button
                type="button"
                data-file-view-open-ide=""
                onClick={() => onOpenInIde(filePath, line)}
                className="rounded-[5px] border border-border bg-background px-2 py-0.5 font-mono text-[11px] text-foreground/80 transition-colors hover:bg-[hsl(var(--hover))] hover:text-foreground cursor-pointer"
              >
                ↗ IDE :{line}
              </button>
            ) : null}
            <button
              type="button"
              data-file-view-back-diff=""
              onClick={onBackToDiff}
              className="rounded-[5px] border border-border bg-background px-2 py-0.5 text-[11px] text-foreground/80 transition-colors hover:bg-[hsl(var(--hover))] hover:text-foreground cursor-pointer"
            >
              ← Diff
            </button>
          </div>
        </div>

        <div
          className="lody-pierre-diff w-full bg-background text-[0.8rem]"
          style={pierreHostStyle}
        >
          {fileState.status === 'loading' ? (
            <div className="flex flex-col gap-2 px-4 py-4">
              <Skeleton width="88%" height={12} />
              <Skeleton width="72%" height={12} />
              <Skeleton width="94%" height={12} />
              <Skeleton width="66%" height={12} />
            </div>
          ) : fileState.status === 'error' ? (
            <div className="px-4 py-4 text-xs text-muted-foreground">{fileState.message}</div>
          ) : fileContents ? (
            <DiffRenderWorkerProvider renderOptions={workerOptions}>
              <PierreFile
                file={fileContents}
                options={fileOptions}
                selectedLines={selectedLines}
                renderGutterUtility={canOpenInIde ? renderGutterUtility : undefined}
                className="w-full"
              />
            </DiffRenderWorkerProvider>
          ) : null}
        </div>
      </section>

      {callersLoading || callers ? (
        <section
          data-worktree-review-callers=""
          className="mt-3 overflow-hidden rounded-[10px] border border-foreground/[0.12] bg-background dark:border-border"
        >
          <div className="flex items-center justify-between border-b border-foreground/[0.07] bg-[color-mix(in_oklab,hsl(var(--foreground))_4%,hsl(var(--background)))] px-3 py-[7px] text-[12px] font-medium text-foreground">
            <span>
              调用方{' '}
              {callersLoading
                ? '(…)'
                : `(${callers?.items.length ?? 0}${
                    callers?.truncated && callers.totalCandidates
                      ? ` / ${callers.totalCandidates}`
                      : ''
                  })`}
            </span>
          </div>

          {callersLoading ? (
            <div className="flex flex-col gap-2 px-3 py-3">
              <Skeleton width="60%" height={12} />
              <Skeleton width="85%" height={12} />
            </div>
          ) : !callers || callers.items.length === 0 ? (
            <div className="px-3 py-3 text-xs text-muted-foreground">0</div>
          ) : (
            <div>
              {callers.items.map((item, idx) => {
                const callerDisplayName = item.caller
                  ? formatCodeNavSymbolDisplayName(item.caller)
                  : splitPathParts(item.path).name;
                const fileName = splitPathParts(item.path).name;
                return (
                  <div
                    key={`${item.path}:${item.line}:${item.character}:${idx}`}
                    data-caller-row={`${item.path}:${item.line}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelectCaller(item)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onSelectCaller(item);
                      }
                    }}
                    className="flex items-center justify-between gap-2.5 border-b border-foreground/[0.07] px-3 py-2 transition-colors last:border-b-0 hover:bg-[hsl(var(--hover))] cursor-pointer"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2 truncate">
                        <span className="truncate font-mono text-[12.2px] font-medium text-foreground">
                          {callerDisplayName}
                        </span>
                        <span
                          className="shrink-0 font-mono text-[11.2px] text-muted-foreground tabular-nums"
                          title={`${item.path}:${item.line}`}
                        >
                          {fileName} :{item.line}
                        </span>
                      </div>
                      {item.previewLine ? (
                        <div className="mt-0.5 truncate font-mono text-[11.5px] text-muted-foreground">
                          {item.previewLine.trim()}
                        </div>
                      ) : null}
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5">
                      {item.caller && codeNavSupported ? (
                        <button
                          type="button"
                          data-caller-trace-further=""
                          onClick={(event) => {
                            event.stopPropagation();
                            onTraceCallerFurther(item);
                          }}
                          className="rounded-[5px] border border-border bg-background px-2 py-0.5 text-[11px] text-foreground/80 transition-colors hover:bg-[hsl(var(--hover))] hover:text-foreground cursor-pointer"
                        >
                          ↑ 继续追查
                        </button>
                      ) : null}
                      {canOpenInIde ? (
                        <button
                          type="button"
                          data-caller-open-ide=""
                          onClick={(event) => {
                            event.stopPropagation();
                            onOpenInIde(item.path, item.line, item.character + 1);
                          }}
                          className="rounded-[5px] border border-border bg-background px-2 py-0.5 text-[11px] text-foreground/80 transition-colors hover:bg-[hsl(var(--hover))] hover:text-foreground cursor-pointer"
                        >
                          ↗ IDE
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
