import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Logger } from '@/utils/logger';

export const BOARD_LINE_SCHEMA_VERSION = 1 as const;
export const BOARD_LINE_MAX_PINS = 8;
export const BOARD_LINE_MAX_TITLE_CHARS = 60;
export const BOARD_LINE_MAX_TAGS = 6;
export const BOARD_LINE_MAX_TAG_CHARS = 32;
export const FOLD_TRIGGER_COUNT = 8;
export const FOLD_BATCH_SIZE = 5;

/** Ids become one path segment each; anything else is rejected. */
const PATH_SEGMENT_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const SEGMENT_NODE_ID_RE = /^seg_[0-9a-f]{8}$/;
export const FOLD_NODE_ID_RE = /^fld_[0-9a-f]{8}$/;
export const BOARD_LINE_NODE_ID_RE = /^(?:seg|fld)_[0-9a-f]{8}$/;

const outside = (detail = 'the path leaves the Board line directory') =>
  new Error(`BOARD_PATH_OUTSIDE:${detail}`);

export const BoardLineTurnRangeSchema = z
  .object({
    startTurnId: z.string().min(1),
    endTurnId: z.string().min(1),
    turnCount: z.number().int().nonnegative(),
  })
  .strict();
export type BoardLineTurnRange = z.infer<typeof BoardLineTurnRangeSchema>;

const BoardLineBaseFields = {
  v: z.literal(BOARD_LINE_SCHEMA_VERSION),
  seq: z.number().int().positive(),
  coversFrom: z.string().min(1),
  coversTo: z.string().min(1),
  title: z
    .string()
    .min(1)
    .refine((value) => Array.from(value).length <= BOARD_LINE_MAX_TITLE_CHARS),
  tags: z.array(z.string().min(1).max(BOARD_LINE_MAX_TAG_CHARS)).max(BOARD_LINE_MAX_TAGS),
  model: z.string().min(1).optional(),
  agentType: z.string().min(1).optional(),
  summaryQuality: z.enum(['written', 'fallback']),
  createdAt: z.string().min(1),
};

export const BoardLineSegmentMetaSchema = z
  .object({
    ...BoardLineBaseFields,
    id: z.string().regex(SEGMENT_NODE_ID_RE),
    kind: z.literal('segment'),
    level: z.literal(0),
    turnRange: BoardLineTurnRangeSchema,
    outcome: z.enum(['rolled', 'fallback']),
    tokensBefore: z.number().nonnegative().optional(),
  })
  .strict();
export type BoardLineSegmentMeta = z.infer<typeof BoardLineSegmentMetaSchema>;

export const BoardLineFoldMetaSchema = z
  .object({
    ...BoardLineBaseFields,
    id: z.string().regex(FOLD_NODE_ID_RE),
    kind: z.literal('fold'),
    level: z.number().int().min(1),
    covers: z.array(z.string().regex(BOARD_LINE_NODE_ID_RE)).min(2),
    coveredTurns: z.number().int().nonnegative(),
    coveredSegments: z.number().int().positive(),
  })
  .strict();
export type BoardLineFoldMeta = z.infer<typeof BoardLineFoldMetaSchema>;

export const BoardLineNodeMetaSchema = z.discriminatedUnion('kind', [
  BoardLineSegmentMetaSchema,
  BoardLineFoldMetaSchema,
]);
export type BoardLineNodeMeta = z.infer<typeof BoardLineNodeMetaSchema>;

const BoardLinePinsFileSchema = z
  .object({
    v: z.literal(BOARD_LINE_SCHEMA_VERSION),
    pins: z.array(z.string().regex(BOARD_LINE_NODE_ID_RE)).max(BOARD_LINE_MAX_PINS),
  })
  .strict();

export type BoardLineSegmentNode = {
  readonly meta: BoardLineSegmentMeta;
  readonly summary: string;
};

export type BoardLineFoldNode = {
  readonly meta: BoardLineFoldMeta;
  readonly summary: string;
};

export type BoardLineNode = BoardLineSegmentNode | BoardLineFoldNode;

export type BoardLineTree = {
  readonly nodes: readonly BoardLineNode[];
  readonly byId: ReadonlyMap<string, BoardLineNode>;
  readonly pins: readonly string[];
  /** Maps a covered child nodeId to the covering fold nodeId. */
  readonly coveredBy: ReadonlyMap<string, string>;
  /** Nodes not covered by any higher-level fold, in ascending `seq` order. */
  readonly rootNodes: readonly BoardLineNode[];
  readonly segments: readonly BoardLineSegmentNode[];
  readonly folds: readonly BoardLineFoldNode[];
  readonly maxSeq: number;
};

export type BoardLineFoldCandidates = {
  readonly level: number;
  readonly targetLevel: number;
  readonly nodes: readonly BoardLineNode[];
};

export type AppendSegmentInput = {
  id?: string;
  coversFrom: string;
  coversTo: string;
  title: string;
  tags?: readonly string[];
  summary: string;
  summaryQuality: 'written' | 'fallback';
  outcome: 'rolled' | 'fallback';
  turnRange: BoardLineTurnRange;
  tokensBefore?: number;
  model?: string;
  agentType?: string;
  createdAt?: string;
};

export type AppendFoldInput = {
  id?: string;
  covers: readonly string[];
  title: string;
  tags?: readonly string[];
  summary: string;
  summaryQuality?: 'written' | 'fallback';
  model?: string;
  agentType?: string;
  createdAt?: string;
};

export function isValidBoardLineNodeId(nodeId: string): boolean {
  return BOARD_LINE_NODE_ID_RE.test(nodeId);
}

export function generateBoardLineNodeId(kind: 'segment' | 'fold'): string {
  const prefix = kind === 'segment' ? 'seg' : 'fld';
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}

/** Clamp a string to at most `maxChars` Unicode code points. */
export function clampCodePoints(value: string, maxChars: number): string {
  const chars = Array.from(value);
  if (chars.length <= maxChars) return value;
  if (maxChars <= 1) return chars.slice(0, Math.max(0, maxChars)).join('');
  return `${chars.slice(0, maxChars - 1).join('')}…`;
}

export function normalizeBoardLineTitle(title: string, fallback = 'Untitled segment'): string {
  const singleLine = title.replace(/\s+/g, ' ').trim();
  const base = singleLine.length > 0 ? singleLine : fallback;
  return clampCodePoints(base, BOARD_LINE_MAX_TITLE_CHARS);
}

export function normalizeBoardLineTags(tags: readonly string[] | undefined): string[] {
  if (!tags || tags.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const cleaned = clampCodePoints(raw.replace(/\s+/g, ' ').trim(), BOARD_LINE_MAX_TAG_CHARS);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= BOARD_LINE_MAX_TAGS) break;
  }
  return out;
}

/**
 * Rebuild the in-memory Board line tree from parsed nodes and pin ids.
 * Pure so both disk reads and unit tests use the exact same topology logic.
 */
export function buildBoardLineTree(
  nodes: readonly BoardLineNode[],
  rawPins: readonly string[] = []
): BoardLineTree {
  const sorted = [...nodes].sort(
    (a, b) =>
      a.meta.seq - b.meta.seq ||
      a.meta.createdAt.localeCompare(b.meta.createdAt) ||
      a.meta.id.localeCompare(b.meta.id)
  );
  const byId = new Map<string, BoardLineNode>();
  const deduped: BoardLineNode[] = [];
  for (const node of sorted) {
    if (byId.has(node.meta.id)) continue;
    byId.set(node.meta.id, node);
    deduped.push(node);
  }
  const segments: BoardLineSegmentNode[] = [];
  const folds: BoardLineFoldNode[] = [];
  for (const node of deduped) {
    if (node.meta.kind === 'segment') segments.push(node as BoardLineSegmentNode);
    else folds.push(node as BoardLineFoldNode);
  }
  const coveredBy = new Map<string, string>();
  for (const fold of folds) {
    for (const childId of fold.meta.covers) {
      if (!coveredBy.has(childId)) coveredBy.set(childId, fold.meta.id);
    }
  }
  const pins: string[] = [];
  const pinSeen = new Set<string>();
  for (const pinId of rawPins) {
    if (!byId.has(pinId) || pinSeen.has(pinId)) continue;
    pinSeen.add(pinId);
    pins.push(pinId);
    if (pins.length >= BOARD_LINE_MAX_PINS) break;
  }
  const rootNodes = deduped.filter((node) => !coveredBy.has(node.meta.id));
  const maxSeq = deduped.reduce((max, node) => Math.max(max, node.meta.seq), 0);
  return {
    nodes: deduped,
    byId,
    pins,
    coveredBy,
    rootNodes,
    segments,
    folds,
    maxSeq,
  };
}

/**
 * Find the lowest level that has at least `FOLD_TRIGGER_COUNT` (8) uncovered,
 * unpinned nodes and return the oldest `FOLD_BATCH_SIZE` (5) for folding into
 * `level + 1`. Supports multi-level folding.
 */
export function findFoldCandidates(tree: BoardLineTree): BoardLineFoldCandidates | null {
  const pinned = new Set(tree.pins);
  const byLevel = new Map<number, BoardLineNode[]>();
  for (const node of tree.nodes) {
    if (tree.coveredBy.has(node.meta.id) || pinned.has(node.meta.id)) continue;
    const list = byLevel.get(node.meta.level);
    if (list) list.push(node);
    else byLevel.set(node.meta.level, [node]);
  }
  const levels = [...byLevel.keys()].sort((a, b) => a - b);
  for (const level of levels) {
    const group = byLevel.get(level)!;
    if (group.length >= FOLD_TRIGGER_COUNT) {
      return {
        level,
        targetLevel: level + 1,
        nodes: group.slice(0, FOLD_BATCH_SIZE),
      };
    }
  }
  return null;
}

const compareIsoAsc = (a: string, b: string): number => {
  const pa = Date.parse(a);
  const pb = Date.parse(b);
  if (Number.isFinite(pa) && Number.isFinite(pb) && pa !== pb) return pa - pb;
  return a.localeCompare(b);
};

/**
 * Daemon-owned immutable node store for Board coordinator fold rollovers:
 *
 *   <dataDir>/boards/<workspaceId>/<boardId>/line/
 *     nodes/<nodeId>.json
 *     nodes/<nodeId>.md
 *     pins.json
 *
 * Sibling of `files/` and `memory/`, never exposed through `BoardFileArea`.
 * Every path segment is lstat-checked against symlinks and files open with
 * `O_NOFOLLOW`, permissions `0o700`/`0o600`.
 */
export class BoardLineStore {
  private readonly writeQueues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly dataDir: () => string,
    private readonly logger?: Pick<Logger, 'warn'>
  ) {}

  /** Absolute `<boardDir>/line` path after strict workspace/board segment validation. */
  linePath(workspaceId: string, boardId: string): string {
    if (!PATH_SEGMENT_RE.test(workspaceId) || !PATH_SEGMENT_RE.test(boardId)) {
      throw outside('invalid workspaceId or boardId');
    }
    return path.join(this.dataDir(), 'boards', workspaceId, boardId, 'line');
  }

  private enqueue<T>(workspaceId: string, boardId: string, fn: () => Promise<T>): Promise<T> {
    const key = `${workspaceId}\0${boardId}`;
    const previous = this.writeQueues.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.writeQueues.set(key, tail);
    return run.finally(() => {
      if (this.writeQueues.get(key) === tail) this.writeQueues.delete(key);
    });
  }

  /**
   * Walk `<dataDir>/boards/<workspaceId>/<boardId>/line/nodes`, lstat-checking
   * every segment against symlinks. When `create` is false and a segment does
   * not exist yet, returns `null` without mutating disk.
   */
  private async resolveSafeDirs(
    workspaceId: string,
    boardId: string,
    create: boolean
  ): Promise<{ lineDir: string; nodesDir: string } | null> {
    this.linePath(workspaceId, boardId);
    let current = this.dataDir();
    if (create) {
      await fs.promises.mkdir(current, { recursive: true, mode: 0o700 });
    }
    const segments = ['boards', workspaceId, boardId, 'line', 'nodes'] as const;
    let lineDir = '';
    let nodesDir = '';
    for (const segment of segments) {
      current = path.join(current, segment);
      let stat: fs.Stats | null = null;
      try {
        stat = await fs.promises.lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (!stat) {
        if (!create) return null;
        await fs.promises.mkdir(current, { recursive: true, mode: 0o700 });
        if (segment === 'line' || segment === 'nodes') {
          await fs.promises.chmod(current, 0o700).catch(() => undefined);
        }
        stat = await fs.promises.lstat(current);
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw outside(`non-directory or symbolic link at ${segment}`);
      }
      if (segment === 'line') lineDir = current;
      if (segment === 'nodes') nodesDir = current;
    }
    return { lineDir, nodesDir };
  }

  private async readTextNoFollow(filePath: string): Promise<string> {
    const stat = await fs.promises.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw outside(`refused symbolic link or non-file: ${path.basename(filePath)}`);
    }
    const handle = await fs.promises.open(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    try {
      return await handle.readFile({ encoding: 'utf8' });
    } finally {
      await handle.close();
    }
  }

  /**
   * Atomically write an immutable file without clobbering any existing entry.
   * Uses temp file (`0o600`) + hard link (`EEXIST` fails atomically) + unlink.
   */
  private async writeImmutableFile(targetPath: string, content: string): Promise<void> {
    const existing = await fs.promises.lstat(targetPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existing) {
      if (existing.isSymbolicLink())
        throw outside(`refused symbolic link at ${path.basename(targetPath)}`);
      throw new Error(`BOARD_LINE_NODE_EXISTS:${path.basename(targetPath)} already exists`);
    }
    const tmpPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.promises.writeFile(tmpPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fs.promises.chmod(tmpPath, 0o600).catch(() => undefined);
      try {
        await fs.promises.link(tmpPath, targetPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') {
          throw new Error(`BOARD_LINE_NODE_EXISTS:${path.basename(targetPath)} already exists`);
        }
        // Fallback only for filesystems that disallow hard links.
        if (code === 'EPERM' || code === 'ENOSYS' || code === 'EXDEV') {
          const check = await fs.promises.lstat(targetPath).catch(() => null);
          if (check) {
            throw new Error(`BOARD_LINE_NODE_EXISTS:${path.basename(targetPath)} already exists`);
          }
          await fs.promises.rename(tmpPath, targetPath);
          return;
        }
        throw error;
      }
    } finally {
      await fs.promises.rm(tmpPath, { force: true }).catch(() => undefined);
    }
  }

  /** Atomically replace mutable `pins.json` via temp file (`0o600`) + rename. */
  private async writeAtomicReplace(targetPath: string, content: string): Promise<void> {
    const existing = await fs.promises.lstat(targetPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
      throw outside(`refused symbolic link or non-file at ${path.basename(targetPath)}`);
    }
    const tmpPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.promises.writeFile(tmpPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fs.promises.chmod(tmpPath, 0o600).catch(() => undefined);
      await fs.promises.rename(tmpPath, targetPath);
    } finally {
      await fs.promises.rm(tmpPath, { force: true }).catch(() => undefined);
    }
  }

  /** Scan `nodes/*.json` + `*.md` and `pins.json` from disk to rebuild the tree. */
  async readTree(workspaceId: string, boardId: string): Promise<BoardLineTree> {
    const dirs = await this.resolveSafeDirs(workspaceId, boardId, false);
    if (!dirs) return buildBoardLineTree([], []);
    const { lineDir, nodesDir } = dirs;
    const entries = await fs.promises.readdir(nodesDir, { withFileTypes: true });
    const nodes: BoardLineNode[] = [];
    for (const entry of entries) {
      if (!entry.name.endsWith('.json')) continue;
      if (entry.isSymbolicLink() || !entry.isFile()) {
        this.logger?.warn(`[board-line] Skipping non-file or symlink in nodes/: ${entry.name}`);
        continue;
      }
      const nodeId = entry.name.slice(0, -'.json'.length);
      if (!isValidBoardLineNodeId(nodeId)) {
        this.logger?.warn(`[board-line] Skipping invalid node filename: ${entry.name}`);
        continue;
      }
      const jsonPath = path.join(nodesDir, entry.name);
      const mdPath = path.join(nodesDir, `${nodeId}.md`);
      try {
        const rawJson = await this.readTextNoFollow(jsonPath);
        const parsedJson = JSON.parse(rawJson) as unknown;
        const parsed = BoardLineNodeMetaSchema.safeParse(parsedJson);
        if (!parsed.success) {
          this.logger?.warn(
            `[board-line] Skipping invalid node metadata ${entry.name}: ${parsed.error.message}`
          );
          continue;
        }
        if (parsed.data.id !== nodeId) {
          this.logger?.warn(
            `[board-line] Skipping node with mismatched id (${parsed.data.id} vs ${nodeId})`
          );
          continue;
        }
        const summary = (await this.readTextNoFollow(mdPath)).trim();
        nodes.push({ meta: parsed.data, summary } as BoardLineNode);
      } catch (error) {
        this.logger?.warn(
          `[board-line] Skipping unreadable node ${entry.name}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    let rawPins: string[] = [];
    const pinsPath = path.join(lineDir, 'pins.json');
    try {
      const raw = await this.readTextNoFollow(pinsPath);
      const parsed = BoardLinePinsFileSchema.safeParse(JSON.parse(raw));
      if (parsed.success) rawPins = parsed.data.pins;
      else {
        this.logger?.warn(`[board-line] Ignoring invalid pins.json: ${parsed.error.message}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger?.warn(
          `[board-line] Ignoring unreadable pins.json: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return buildBoardLineTree(nodes, rawPins);
  }

  /** Write a new immutable `segment` node (`nodes/seg_xxxxxxxx.{md,json}`). */
  appendSegment(
    workspaceId: string,
    boardId: string,
    input: AppendSegmentInput
  ): Promise<BoardLineSegmentNode> {
    return this.enqueue(workspaceId, boardId, async () => {
      const dirs = (await this.resolveSafeDirs(workspaceId, boardId, true))!;
      const tree = await this.readTree(workspaceId, boardId);
      const id = this.allocateNodeId('segment', input.id, tree);
      const meta: BoardLineSegmentMeta = BoardLineSegmentMetaSchema.parse({
        v: BOARD_LINE_SCHEMA_VERSION,
        id,
        kind: 'segment',
        seq: tree.maxSeq + 1,
        level: 0,
        coversFrom: input.coversFrom,
        coversTo: input.coversTo,
        title: normalizeBoardLineTitle(input.title),
        tags: normalizeBoardLineTags(input.tags),
        ...(input.model ? { model: input.model } : {}),
        ...(input.agentType ? { agentType: input.agentType } : {}),
        summaryQuality: input.summaryQuality,
        createdAt: input.createdAt ?? new Date().toISOString(),
        turnRange: input.turnRange,
        outcome: input.outcome,
        ...(input.tokensBefore !== undefined ? { tokensBefore: input.tokensBefore } : {}),
      });
      const summary = input.summary.trim() || meta.title;
      await this.writeNodePair(dirs.nodesDir, meta, summary);
      return { meta, summary };
    });
  }

  /** Write a new immutable `fold` node covering at least 2 existing lower-level nodes. */
  appendFold(
    workspaceId: string,
    boardId: string,
    input: AppendFoldInput
  ): Promise<BoardLineFoldNode> {
    return this.enqueue(workspaceId, boardId, async () => {
      const dirs = (await this.resolveSafeDirs(workspaceId, boardId, true))!;
      const tree = await this.readTree(workspaceId, boardId);
      const uniqueCovers: string[] = [];
      const seen = new Set<string>();
      for (const childId of input.covers) {
        if (!isValidBoardLineNodeId(childId)) {
          throw new Error(`BOARD_LINE_INVALID_NODE_ID:${childId}`);
        }
        if (seen.has(childId)) continue;
        seen.add(childId);
        uniqueCovers.push(childId);
      }
      if (uniqueCovers.length < 2) {
        throw new Error('BOARD_LINE_INVALID_FOLD:a fold must cover at least 2 nodes');
      }
      const children: BoardLineNode[] = [];
      for (const childId of uniqueCovers) {
        const child = tree.byId.get(childId);
        if (!child) throw new Error(`BOARD_LINE_NODE_NOT_FOUND:${childId}`);
        children.push(child);
      }
      const level = Math.max(...children.map((child) => child.meta.level)) + 1;
      const coversFrom = children.map((child) => child.meta.coversFrom).sort(compareIsoAsc)[0]!;
      const coversTo = children
        .map((child) => child.meta.coversTo)
        .sort(compareIsoAsc)
        .at(-1)!;
      let coveredTurns = 0;
      let coveredSegments = 0;
      for (const child of children) {
        if (child.meta.kind === 'segment') {
          coveredTurns += child.meta.turnRange.turnCount;
          coveredSegments += 1;
        } else {
          coveredTurns += child.meta.coveredTurns;
          coveredSegments += child.meta.coveredSegments;
        }
      }
      const id = this.allocateNodeId('fold', input.id, tree);
      const meta: BoardLineFoldMeta = BoardLineFoldMetaSchema.parse({
        v: BOARD_LINE_SCHEMA_VERSION,
        id,
        kind: 'fold',
        seq: tree.maxSeq + 1,
        level,
        coversFrom,
        coversTo,
        title: normalizeBoardLineTitle(input.title, 'Folded history'),
        tags: normalizeBoardLineTags(input.tags),
        ...(input.model ? { model: input.model } : {}),
        ...(input.agentType ? { agentType: input.agentType } : {}),
        summaryQuality: input.summaryQuality ?? 'written',
        createdAt: input.createdAt ?? new Date().toISOString(),
        covers: uniqueCovers,
        coveredTurns,
        coveredSegments,
      });
      const summary = input.summary.trim() || meta.title;
      await this.writeNodePair(dirs.nodesDir, meta, summary);
      return { meta, summary };
    });
  }

  /** Pin or unpin an existing node in `pins.json` (max 8 pins). */
  setPinned(
    workspaceId: string,
    boardId: string,
    nodeId: string,
    pinned: boolean
  ): Promise<{ nodeId: string; pinned: boolean; pins: string[] }> {
    return this.enqueue(workspaceId, boardId, async () => {
      if (!isValidBoardLineNodeId(nodeId)) {
        throw new Error(`BOARD_LINE_INVALID_NODE_ID:Invalid nodeId "${nodeId}"`);
      }
      const tree = await this.readTree(workspaceId, boardId);
      if (!tree.byId.has(nodeId)) {
        throw new Error(`BOARD_LINE_NODE_NOT_FOUND:Node "${nodeId}" does not exist`);
      }
      const nextPins = [...tree.pins];
      const existingIndex = nextPins.indexOf(nodeId);
      if (pinned) {
        if (existingIndex === -1) {
          if (nextPins.length >= BOARD_LINE_MAX_PINS) {
            throw new Error(
              `BOARD_LINE_PIN_LIMIT:Maximum of ${BOARD_LINE_MAX_PINS} pinned nodes reached (${nextPins.join(', ')}). Unpin one first with lody_board_line_pin({ nodeId, pinned: false }).`
            );
          }
          nextPins.push(nodeId);
        }
      } else if (existingIndex !== -1) {
        nextPins.splice(existingIndex, 1);
      }
      const dirs = (await this.resolveSafeDirs(workspaceId, boardId, true))!;
      const pinsPath = path.join(dirs.lineDir, 'pins.json');
      await this.writeAtomicReplace(
        pinsPath,
        `${JSON.stringify({ v: BOARD_LINE_SCHEMA_VERSION, pins: nextPins }, null, 2)}\n`
      );
      return { nodeId, pinned, pins: nextPins };
    });
  }

  private allocateNodeId(
    kind: 'segment' | 'fold',
    explicitId: string | undefined,
    tree: BoardLineTree
  ): string {
    const pattern = kind === 'segment' ? SEGMENT_NODE_ID_RE : FOLD_NODE_ID_RE;
    if (explicitId !== undefined) {
      if (!pattern.test(explicitId)) {
        throw new Error(`BOARD_LINE_INVALID_NODE_ID:Invalid ${kind} nodeId "${explicitId}"`);
      }
      if (tree.byId.has(explicitId)) {
        throw new Error(`BOARD_LINE_NODE_EXISTS:Node "${explicitId}" already exists`);
      }
      return explicitId;
    }
    for (let attempt = 0; attempt < 32; attempt++) {
      const candidate = generateBoardLineNodeId(kind);
      if (!tree.byId.has(candidate)) return candidate;
    }
    throw new Error('BOARD_LINE_ID_EXHAUSTED:Could not allocate a unique node id');
  }

  private async writeNodePair(
    nodesDir: string,
    meta: BoardLineNodeMeta,
    summary: string
  ): Promise<void> {
    const mdPath = path.join(nodesDir, `${meta.id}.md`);
    const jsonPath = path.join(nodesDir, `${meta.id}.json`);
    // Write markdown first so a crash before JSON never produces a dangling metadata row.
    await this.writeImmutableFile(mdPath, `${summary}\n`);
    try {
      await this.writeImmutableFile(jsonPath, `${JSON.stringify(meta, null, 2)}\n`);
    } catch (error) {
      await fs.promises.rm(mdPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
