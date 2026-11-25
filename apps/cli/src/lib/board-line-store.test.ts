import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOARD_LINE_MAX_PINS,
  BOARD_LINE_MAX_TAGS,
  BOARD_LINE_MAX_TITLE_CHARS,
  BoardLineStore,
  FOLD_BATCH_SIZE,
  FOLD_TRIGGER_COUNT,
  findFoldCandidates,
} from './board-line-store';

const WS = 'ws_line_test';
const BOARD = 'bd_line_test';

describe('BoardLineStore', () => {
  let scratch: string;
  let warnings: string[];
  let store: BoardLineStore;

  beforeEach(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'board-line-store-')));
    warnings = [];
    store = new BoardLineStore(() => path.join(scratch, 'data'), {
      warn: (message) => warnings.push(String(message)),
    });
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const makeSegment = (
    index: number,
    overrides: Partial<Parameters<BoardLineStore['appendSegment']>[2]> = {}
  ) =>
    store.appendSegment(WS, BOARD, {
      coversFrom: `2026-11-${String(index).padStart(2, '0')}T08:00:00.000Z`,
      coversTo: `2026-11-${String(index).padStart(2, '0')}T09:00:00.000Z`,
      title: `Segment ${index}`,
      tags: ['board', `s${index}`],
      summary: `First-person summary for segment ${index}.`,
      summaryQuality: 'written',
      outcome: 'rolled',
      turnRange: {
        startTurnId: `u-${index}-1`,
        endTurnId: `a-${index}-2`,
        turnCount: 2,
      },
      tokensBefore: 150_000,
      model: 'gemini-4-neon',
      agentType: 'antigravity',
      createdAt: `2026-11-${String(index).padStart(2, '0')}T09:05:00.000Z`,
      ...overrides,
    });

  it('writes immutable segment and fold nodes with strict permissions and refuses overwrites', async () => {
    const seg1 = await makeSegment(1, { id: 'seg_00000001' });
    const seg2 = await makeSegment(2, { id: 'seg_00000002' });
    expect(seg1.meta.seq).toBe(1);
    expect(seg2.meta.seq).toBe(2);

    const lineDir = store.linePath(WS, BOARD);
    const nodesDir = path.join(lineDir, 'nodes');
    expect(fs.statSync(lineDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(nodesDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(nodesDir, 'seg_00000001.json')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(nodesDir, 'seg_00000001.md')).mode & 0o777).toBe(0o600);

    // Refuses overwriting an existing nodeId.
    await expect(makeSegment(3, { id: 'seg_00000001' })).rejects.toThrow(/BOARD_LINE_NODE_EXISTS/);

    const fold = await store.appendFold(WS, BOARD, {
      id: 'fld_00000001',
      covers: [seg1.meta.id, seg2.meta.id],
      title: 'Early work',
      tags: ['milestone'],
      summary: 'Merged segments 1 and 2.',
      createdAt: '2026-11-02T10:00:00.000Z',
    });
    expect(fold.meta).toMatchObject({
      v: 1,
      id: 'fld_00000001',
      kind: 'fold',
      seq: 3,
      level: 1,
      covers: ['seg_00000001', 'seg_00000002'],
      coveredTurns: 4,
      coveredSegments: 2,
      coversFrom: seg1.meta.coversFrom,
      coversTo: seg2.meta.coversTo,
    });

    // Rebuilds exact topology from disk.
    const rebuilt = await store.readTree(WS, BOARD);
    expect(rebuilt.nodes.map((n) => n.meta.id)).toEqual([
      'seg_00000001',
      'seg_00000002',
      'fld_00000001',
    ]);
    expect(rebuilt.rootNodes.map((n) => n.meta.id)).toEqual(['fld_00000001']);
    expect(rebuilt.coveredBy.get('seg_00000001')).toBe('fld_00000001');
    expect(rebuilt.coveredBy.get('seg_00000002')).toBe('fld_00000001');
  });

  it('normalizes overly long titles and deduplicates/caps tags', async () => {
    const seg = await makeSegment(1, {
      title: '测'.repeat(BOARD_LINE_MAX_TITLE_CHARS + 20),
      tags: ['Alpha', 'alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta'],
    });
    expect(Array.from(seg.meta.title).length).toBeLessThanOrEqual(BOARD_LINE_MAX_TITLE_CHARS);
    expect(seg.meta.tags).toHaveLength(BOARD_LINE_MAX_TAGS);
    expect(seg.meta.tags).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta']);
  });

  it('warns and skips individual corrupt or incomplete node files without crashing', async () => {
    const seg1 = await makeSegment(1, { id: 'seg_00000001' });
    const nodesDir = path.join(store.linePath(WS, BOARD), 'nodes');
    // Corrupt JSON
    fs.writeFileSync(path.join(nodesDir, 'seg_00000002.json'), '{not-json');
    fs.writeFileSync(path.join(nodesDir, 'seg_00000002.md'), 'orphan');
    // Missing .md file
    fs.writeFileSync(
      path.join(nodesDir, 'seg_00000003.json'),
      JSON.stringify({ ...seg1.meta, id: 'seg_00000003', seq: 3 })
    );
    // Mismatched id inside JSON
    fs.writeFileSync(
      path.join(nodesDir, 'seg_00000004.json'),
      JSON.stringify({ ...seg1.meta, id: 'seg_00000099', seq: 4 })
    );
    fs.writeFileSync(path.join(nodesDir, 'seg_00000004.md'), 'mismatch');

    const tree = await store.readTree(WS, BOARD);
    expect(tree.nodes.map((n) => n.meta.id)).toEqual(['seg_00000001']);
    expect(warnings.length).toBeGreaterThanOrEqual(3);
  });

  it('enforces pin existence, idempotency, unpinning, and the 8-pin cap', async () => {
    const ids: string[] = [];
    for (let i = 1; i <= BOARD_LINE_MAX_PINS + 1; i++) {
      const seg = await makeSegment(i);
      ids.push(seg.meta.id);
    }
    await expect(store.setPinned(WS, BOARD, 'seg_deadbeef', true)).rejects.toThrow(
      /BOARD_LINE_NODE_NOT_FOUND/
    );
    for (let i = 0; i < BOARD_LINE_MAX_PINS; i++) {
      const res = await store.setPinned(WS, BOARD, ids[i]!, true);
      expect(res.pins).toHaveLength(i + 1);
    }
    // Pinning an already-pinned node is idempotent.
    const repeat = await store.setPinned(WS, BOARD, ids[0]!, true);
    expect(repeat.pins).toHaveLength(BOARD_LINE_MAX_PINS);

    // 9th distinct pin is rejected.
    await expect(store.setPinned(WS, BOARD, ids[BOARD_LINE_MAX_PINS]!, true)).rejects.toThrow(
      /BOARD_LINE_PIN_LIMIT/
    );

    // Unpin one and pin the 9th.
    const unpinned = await store.setPinned(WS, BOARD, ids[0]!, false);
    expect(unpinned.pins).toHaveLength(BOARD_LINE_MAX_PINS - 1);
    const pinned9 = await store.setPinned(WS, BOARD, ids[BOARD_LINE_MAX_PINS]!, true);
    expect(pinned9.pins).toHaveLength(BOARD_LINE_MAX_PINS);
    expect(pinned9.pins.at(-1)).toBe(ids[BOARD_LINE_MAX_PINS]);
    expect(fs.statSync(path.join(store.linePath(WS, BOARD), 'pins.json')).mode & 0o777).toBe(0o600);
  });

  it('finds multi-level fold candidates excluding covered and pinned nodes', async () => {
    const segIds: string[] = [];
    for (let i = 1; i <= FOLD_TRIGGER_COUNT; i++) {
      segIds.push((await makeSegment(i)).meta.id);
    }
    // Pinning one drops unpinned count at level 0 to 7 (< 8) -> no candidates yet.
    await store.setPinned(WS, BOARD, segIds[0]!, true);
    expect(findFoldCandidates(await store.readTree(WS, BOARD))).toBeNull();

    // Adding a 9th segment brings unpinned level-0 nodes back to 8 -> oldest 5 unpinned returned.
    segIds.push((await makeSegment(9)).meta.id);
    const level0 = findFoldCandidates(await store.readTree(WS, BOARD));
    expect(level0).not.toBeNull();
    expect(level0!.level).toBe(0);
    expect(level0!.targetLevel).toBe(1);
    expect(level0!.nodes.map((n) => n.meta.id)).toEqual(segIds.slice(1, 1 + FOLD_BATCH_SIZE));

    // Create 8 level-1 folds covering disjoint segment pairs to trigger level-1 -> level-2 folding.
    const freshStore = new BoardLineStore(() => path.join(scratch, 'data-multi'));
    const foldIds: string[] = [];
    for (let f = 1; f <= FOLD_TRIGGER_COUNT; f++) {
      const a = await freshStore.appendSegment(WS, BOARD, {
        coversFrom: `2026-10-${String(f).padStart(2, '0')}T01:00:00.000Z`,
        coversTo: `2026-10-${String(f).padStart(2, '0')}T02:00:00.000Z`,
        title: `Seg ${f}a`,
        summary: `Summary ${f}a`,
        summaryQuality: 'written',
        outcome: 'rolled',
        turnRange: { startTurnId: `u${f}a`, endTurnId: `a${f}a`, turnCount: 3 },
        createdAt: `2026-10-${String(f).padStart(2, '0')}T02:01:00.000Z`,
      });
      const b = await freshStore.appendSegment(WS, BOARD, {
        coversFrom: `2026-10-${String(f).padStart(2, '0')}T03:00:00.000Z`,
        coversTo: `2026-10-${String(f).padStart(2, '0')}T04:00:00.000Z`,
        title: `Seg ${f}b`,
        summary: `Summary ${f}b`,
        summaryQuality: 'written',
        outcome: 'rolled',
        turnRange: { startTurnId: `u${f}b`, endTurnId: `a${f}b`, turnCount: 2 },
        createdAt: `2026-10-${String(f).padStart(2, '0')}T04:01:00.000Z`,
      });
      const fold = await freshStore.appendFold(WS, BOARD, {
        covers: [a.meta.id, b.meta.id],
        title: `Fold ${f}`,
        summary: `Fold summary ${f}`,
        createdAt: `2026-10-${String(f).padStart(2, '0')}T04:02:00.000Z`,
      });
      foldIds.push(fold.meta.id);
    }
    const level1 = findFoldCandidates(await freshStore.readTree(WS, BOARD));
    expect(level1).not.toBeNull();
    expect(level1!.level).toBe(1);
    expect(level1!.targetLevel).toBe(2);
    expect(level1!.nodes.map((n) => n.meta.id)).toEqual(foldIds.slice(0, FOLD_BATCH_SIZE));

    const superFold = await freshStore.appendFold(WS, BOARD, {
      covers: level1!.nodes.map((n) => n.meta.id),
      title: 'Super fold',
      summary: 'Merged 5 level-1 folds.',
    });
    expect(superFold.meta.level).toBe(2);
    expect(superFold.meta.coveredSegments).toBe(10);
    expect(superFold.meta.coveredTurns).toBe(25);
  });

  it('rejects path traversal and symlinks at directory or leaf level', async () => {
    expect(() => store.linePath('../escape', BOARD)).toThrow(/BOARD_PATH_OUTSIDE/);
    expect(() => store.linePath(WS, 'bd/escape')).toThrow(/BOARD_PATH_OUTSIDE/);
    await expect(store.setPinned(WS, BOARD, '../pins', true)).rejects.toThrow(
      /BOARD_LINE_INVALID_NODE_ID/
    );

    // Directory symlink attack: replace `line` with a symlink to outside dir.
    const outsideDir = path.join(scratch, 'outside');
    fs.mkdirSync(outsideDir);
    const boardDir = path.join(scratch, 'data', 'boards', WS, 'bd_symlink_dir');
    fs.mkdirSync(boardDir, { recursive: true });
    fs.symlinkSync(outsideDir, path.join(boardDir, 'line'));
    await expect(store.readTree(WS, 'bd_symlink_dir')).rejects.toThrow(/BOARD_PATH_OUTSIDE/);
    await expect(
      store.appendSegment(WS, 'bd_symlink_dir', {
        coversFrom: '2026-11-01T00:00:00.000Z',
        coversTo: '2026-11-01T01:00:00.000Z',
        title: 'Nope',
        summary: 'Nope',
        summaryQuality: 'written',
        outcome: 'rolled',
        turnRange: { startTurnId: 'u1', endTurnId: 'a1', turnCount: 1 },
      })
    ).rejects.toThrow(/BOARD_PATH_OUTSIDE/);

    // Leaf symlink inside nodes/ is skipped with a warning on read.
    const warnSpy = vi.fn();
    const safeStore = new BoardLineStore(() => path.join(scratch, 'data'), { warn: warnSpy });
    await makeSegment(1, { id: 'seg_00000001' });
    const secret = path.join(outsideDir, 'secret.json');
    fs.writeFileSync(secret, JSON.stringify({ leak: true }));
    const nodesDir = path.join(store.linePath(WS, BOARD), 'nodes');
    fs.symlinkSync(secret, path.join(nodesDir, 'seg_000000aa.json'));
    fs.writeFileSync(path.join(nodesDir, 'seg_000000aa.md'), 'linked');
    const tree = await safeStore.readTree(WS, BOARD);
    expect(tree.byId.has('seg_000000aa')).toBe(false);
    expect(warnSpy).toHaveBeenCalled();

    // Symlink at pins.json is refused on write.
    const pinsTarget = path.join(outsideDir, 'pins-target.json');
    fs.writeFileSync(pinsTarget, '{}');
    fs.symlinkSync(pinsTarget, path.join(store.linePath(WS, BOARD), 'pins.json'));
    await expect(store.setPinned(WS, BOARD, 'seg_00000001', true)).rejects.toThrow(
      /BOARD_PATH_OUTSIDE/
    );
  });
});
