import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import {
  flattenWorktreeReviewTree,
  type WorktreeReviewFileTreeModel,
  type WorktreeReviewTreeSymbol,
} from './worktree-review-tree-model';

export interface WorktreeReviewFileTreeProps {
  readonly tree: WorktreeReviewFileTreeModel;
  readonly activeFilePath: string | null;
  readonly activeSymbolId: string | null;
  /** Whether `codeNav` is available so the `ƒ 符号` toggle is meaningful. */
  readonly symbolsAvailable: boolean;
  readonly showSymbols: boolean;
  readonly onToggleShowSymbols: () => void;
  readonly onSelectFile: (filePath: string) => void;
  readonly onSelectSymbol: (filePath: string, symbol: WorktreeReviewTreeSymbol) => void;
  readonly className?: string;
}

export function WorktreeReviewFileTree({
  tree,
  activeFilePath,
  activeSymbolId,
  symbolsAvailable,
  showSymbols,
  onToggleShowSymbols,
  onSelectFile,
  onSelectSymbol,
  className,
}: WorktreeReviewFileTreeProps) {
  const [collapsedDirs, setCollapsedDirs] = useState<ReadonlySet<string>>(() => new Set());

  const toggleDir = (dirPath: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  };

  const rows = useMemo(
    () =>
      flattenWorktreeReviewTree(tree, {
        collapsedDirs,
        showSymbols: symbolsAvailable && showSymbols,
      }),
    [collapsedDirs, showSymbols, symbolsAvailable, tree]
  );

  return (
    <aside
      data-worktree-review-tree=""
      className={cn(
        'flex min-h-0 flex-col border-r border-border bg-[hsl(var(--sidebar-background))] select-none',
        className
      )}
    >
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-foreground/[0.07] px-2.5 text-[11.5px] text-muted-foreground">
        <div className="flex min-w-0 items-center gap-1.5 tabular-nums">
          <span>
            {tree.fileCount} {tree.fileCount === 1 ? 'file' : 'files'}
          </span>
          {(tree.totalAdditions > 0 || tree.totalDeletions > 0) && (
            <span className="inline-flex items-center gap-1 font-mono text-[11px]">
              <span className="text-[hsl(var(--github-addition))]">+{tree.totalAdditions}</span>
              <span className="text-[hsl(var(--github-deletion))]">-{tree.totalDeletions}</span>
            </span>
          )}
        </div>
        {symbolsAvailable ? (
          <button
            type="button"
            data-worktree-review-symbol-toggle=""
            aria-pressed={showSymbols}
            onClick={onToggleShowSymbols}
            className={cn(
              'rounded-[5px] px-1.5 py-0.5 text-[11px] transition-colors cursor-pointer',
              showSymbols
                ? 'bg-background font-medium text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
                : 'text-muted-foreground hover:bg-[hsl(var(--sidebar-hover))] hover:text-foreground'
            )}
          >
            ƒ 符号
          </button>
        ) : null}
      </div>

      <div className="scrollbar-pro min-h-0 flex-1 overflow-y-auto p-1.5">
        {rows.length === 0 ? (
          <div className="px-2 py-4 text-center text-xs text-muted-foreground">—</div>
        ) : (
          rows.map((row) => {
            if (row.kind === 'dir') {
              return (
                <button
                  key={row.key}
                  type="button"
                  data-tree-dir={row.path}
                  aria-expanded={!row.collapsed}
                  onClick={() => toggleDir(row.path)}
                  style={{ paddingLeft: `${7 + row.depth * 11}px` }}
                  className="flex h-[26px] w-full items-center gap-1.5 rounded-[6px] pr-2 text-left text-[11.8px] text-muted-foreground transition-colors hover:bg-[hsl(var(--sidebar-hover))] hover:text-foreground cursor-pointer"
                >
                  <span
                    className="w-3 shrink-0 text-center text-[10px] opacity-70"
                    aria-hidden="true"
                  >
                    {row.collapsed ? '▸' : '▾'}
                  </span>
                  <span className="min-w-0 truncate font-mono" title={row.path}>
                    {row.name}
                  </span>
                </button>
              );
            }

            if (row.kind === 'file') {
              const isActive = activeFilePath === row.file.path && activeSymbolId === null;
              return (
                <button
                  key={row.key}
                  type="button"
                  data-tree-file={row.file.path}
                  data-active={isActive ? '' : undefined}
                  onClick={() => onSelectFile(row.file.path)}
                  style={{ paddingLeft: `${7 + row.depth * 11}px` }}
                  className={cn(
                    'flex h-[26px] w-full items-center justify-between gap-1.5 rounded-[6px] pr-2 text-left text-[12px] transition-colors cursor-pointer',
                    isActive
                      ? 'bg-[hsl(var(--sidebar-selection))] font-medium text-foreground'
                      : 'text-foreground/80 hover:bg-[hsl(var(--sidebar-hover))] hover:text-foreground'
                  )}
                >
                  <span className="min-w-0 truncate font-mono" title={row.file.path}>
                    {row.file.name}
                  </span>
                  {(row.file.additions > 0 || row.file.deletions > 0) && (
                    <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[10.8px] tabular-nums">
                      {row.file.additions > 0 && (
                        <span className="text-[hsl(var(--github-addition))]">
                          +{row.file.additions}
                        </span>
                      )}
                      {row.file.deletions > 0 && (
                        <span className="text-[hsl(var(--github-deletion))]">
                          -{row.file.deletions}
                        </span>
                      )}
                    </span>
                  )}
                </button>
              );
            }

            const isSymActive = activeSymbolId === row.symbol.id;
            return (
              <button
                key={row.key}
                type="button"
                data-tree-symbol={row.symbol.displayName}
                data-active={isSymActive ? '' : undefined}
                onClick={() => onSelectSymbol(row.filePath, row.symbol)}
                style={{ paddingLeft: `${10 + row.depth * 11}px` }}
                className={cn(
                  'flex h-[23px] w-full items-center gap-1.5 rounded-[6px] pr-2 text-left text-[11.5px] transition-colors cursor-pointer',
                  isSymActive
                    ? 'bg-[color-mix(in_oklab,hsl(var(--primary))_13%,transparent)] font-medium text-[hsl(var(--primary))]'
                    : 'text-muted-foreground hover:bg-[hsl(var(--sidebar-hover))] hover:text-foreground'
                )}
              >
                <span
                  className="w-3 shrink-0 text-center text-[11px] text-[hsl(var(--primary))] opacity-85"
                  aria-hidden="true"
                >
                  ƒ
                </span>
                <span className="min-w-0 truncate font-mono" title={row.symbol.displayName}>
                  {row.symbol.displayName}
                </span>
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
}
