import type { CodeNavDiffOutlineFile, CodeNavDiffOutlineSymbol } from '@lody/shared';

export interface WorktreeReviewFileInput {
  readonly path: string;
  readonly additions?: number;
  readonly deletions?: number;
}

export interface WorktreeReviewTreeSymbol {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly kind: CodeNavDiffOutlineSymbol['kind'];
  readonly startLine: number;
  readonly endLine: number;
  readonly hunkCount: number;
}

export interface WorktreeReviewTreeFileNode {
  readonly kind: 'file';
  readonly path: string;
  readonly name: string;
  readonly additions: number;
  readonly deletions: number;
  readonly symbols: readonly WorktreeReviewTreeSymbol[];
}

export interface WorktreeReviewTreeDirNode {
  readonly kind: 'dir';
  /** Full slash-joined directory path from workspace root (unique collapse key). */
  readonly path: string;
  /** Display label; compressed across single-child directory chains (e.g. `apps/cli/src/agent`). */
  readonly name: string;
  readonly dirs: readonly WorktreeReviewTreeDirNode[];
  readonly files: readonly WorktreeReviewTreeFileNode[];
}

export interface WorktreeReviewFileTreeModel {
  readonly dirs: readonly WorktreeReviewTreeDirNode[];
  readonly files: readonly WorktreeReviewTreeFileNode[];
  readonly fileCount: number;
  readonly totalAdditions: number;
  readonly totalDeletions: number;
  readonly symbolCount: number;
}

export type WorktreeReviewFlatTreeRow =
  | {
      readonly kind: 'dir';
      readonly key: string;
      readonly path: string;
      readonly name: string;
      readonly depth: number;
      readonly collapsed: boolean;
    }
  | {
      readonly kind: 'file';
      readonly key: string;
      readonly file: WorktreeReviewTreeFileNode;
      readonly depth: number;
    }
  | {
      readonly kind: 'symbol';
      readonly key: string;
      readonly filePath: string;
      readonly symbol: WorktreeReviewTreeSymbol;
      readonly depth: number;
    };

export function normalizeReviewTreePath(rawPath: string): string {
  return rawPath
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
}

export function formatCodeNavSymbolDisplayName(symbol: {
  readonly name: string;
  readonly containerName?: string;
}): string {
  return symbol.containerName ? `${symbol.containerName}.${symbol.name}` : symbol.name;
}

type MutableDirNode = {
  path: string;
  name: string;
  dirs: Map<string, MutableDirNode>;
  files: WorktreeReviewTreeFileNode[];
};

function createMutableDir(path: string, name: string): MutableDirNode {
  return { path, name, dirs: new Map(), files: [] };
}

function finalizeDirNode(node: MutableDirNode): WorktreeReviewTreeDirNode {
  const sortedDirs = Array.from(node.dirs.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(finalizeDirNode);
  const sortedFiles = [...node.files].sort((a, b) => a.name.localeCompare(b.name));

  // Compress single-child directory chains with no sibling files into one row
  // (e.g. `apps` -> `cli` -> `src` -> `agent` becomes `apps/cli/src/agent`).
  if (sortedFiles.length === 0 && sortedDirs.length === 1) {
    const onlyChild = sortedDirs[0]!;
    return {
      kind: 'dir',
      path: onlyChild.path,
      name: `${node.name}/${onlyChild.name}`,
      dirs: onlyChild.dirs,
      files: onlyChild.files,
    };
  }

  return {
    kind: 'dir',
    path: node.path,
    name: node.name,
    dirs: sortedDirs,
    files: sortedFiles,
  };
}

function buildFileSymbols(
  filePath: string,
  outlineFile: CodeNavDiffOutlineFile | undefined
): WorktreeReviewTreeSymbol[] {
  if (!outlineFile || outlineFile.symbols.length === 0) return [];
  const seen = new Set<string>();
  const symbols: WorktreeReviewTreeSymbol[] = [];
  const ordered = [...outlineFile.symbols].sort((a, b) => a.startLine - b.startLine);
  for (const sym of ordered) {
    const displayName = formatCodeNavSymbolDisplayName(sym);
    const id = `${filePath}:${sym.startLine}:${displayName}`;
    if (seen.has(id)) continue;
    seen.add(id);
    symbols.push({
      id,
      name: sym.name,
      displayName,
      kind: sym.kind,
      startLine: sym.startLine,
      endLine: sym.endLine,
      hunkCount: sym.hunkCount,
    });
  }
  return symbols;
}

export function buildWorktreeReviewFileTree(
  files: readonly WorktreeReviewFileInput[],
  outlineByPath?: ReadonlyMap<string, CodeNavDiffOutlineFile>
): WorktreeReviewFileTreeModel {
  const root = createMutableDir('', '');
  const seenPaths = new Set<string>();
  let fileCount = 0;
  let totalAdditions = 0;
  let totalDeletions = 0;
  let symbolCount = 0;

  for (const entry of files) {
    const normalized = normalizeReviewTreePath(entry.path);
    if (!normalized || seenPaths.has(normalized)) continue;
    seenPaths.add(normalized);

    const segments = normalized.split('/').filter(Boolean);
    if (segments.length === 0) continue;
    const fileName = segments[segments.length - 1]!;
    const dirSegments = segments.slice(0, -1);

    let cursor = root;
    let dirPath = '';
    for (const seg of dirSegments) {
      dirPath = dirPath ? `${dirPath}/${seg}` : seg;
      let next = cursor.dirs.get(seg);
      if (!next) {
        next = createMutableDir(dirPath, seg);
        cursor.dirs.set(seg, next);
      }
      cursor = next;
    }

    const additions = Math.max(0, entry.additions ?? 0);
    const deletions = Math.max(0, entry.deletions ?? 0);
    const outlineFile = outlineByPath?.get(normalized) ?? outlineByPath?.get(entry.path);
    const symbols = buildFileSymbols(normalized, outlineFile);

    cursor.files.push({
      kind: 'file',
      path: entry.path,
      name: fileName,
      additions,
      deletions,
      symbols,
    });

    fileCount += 1;
    totalAdditions += additions;
    totalDeletions += deletions;
    symbolCount += symbols.length;
  }

  const dirs = Array.from(root.dirs.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(finalizeDirNode);
  const rootFiles = [...root.files].sort((a, b) => a.name.localeCompare(b.name));

  return {
    dirs,
    files: rootFiles,
    fileCount,
    totalAdditions,
    totalDeletions,
    symbolCount,
  };
}

export function flattenWorktreeReviewTree(
  tree: WorktreeReviewFileTreeModel,
  options: {
    readonly collapsedDirs: ReadonlySet<string>;
    readonly showSymbols: boolean;
  }
): WorktreeReviewFlatTreeRow[] {
  const rows: WorktreeReviewFlatTreeRow[] = [];

  const pushFile = (file: WorktreeReviewTreeFileNode, depth: number) => {
    rows.push({
      kind: 'file',
      key: `file:${file.path}`,
      file,
      depth,
    });
    if (options.showSymbols && file.symbols.length > 0) {
      for (const symbol of file.symbols) {
        rows.push({
          kind: 'symbol',
          key: `sym:${symbol.id}`,
          filePath: file.path,
          symbol,
          depth: depth + 1,
        });
      }
    }
  };

  const pushDir = (dir: WorktreeReviewTreeDirNode, depth: number) => {
    const collapsed = options.collapsedDirs.has(dir.path);
    rows.push({
      kind: 'dir',
      key: `dir:${dir.path}`,
      path: dir.path,
      name: dir.name,
      depth,
      collapsed,
    });
    if (collapsed) return;
    for (const childDir of dir.dirs) {
      pushDir(childDir, depth + 1);
    }
    for (const file of dir.files) {
      pushFile(file, depth + 1);
    }
  };

  for (const dir of tree.dirs) {
    pushDir(dir, 0);
  }
  for (const file of tree.files) {
    pushFile(file, 0);
  }

  return rows;
}
