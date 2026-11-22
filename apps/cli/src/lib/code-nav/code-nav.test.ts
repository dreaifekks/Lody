import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { estimateCodeNavResponseBytes, type SessionId } from '@lody/shared';
import { runCommandTextLegacy } from '@lody/shared/node/process';
import {
  AstGrepCodeNavProvider,
  BoundedAstLruCache,
  BoundedSymbolIndexCache,
  CodeNavService,
  trimResponseToBudget,
  type CodeNavProvider,
} from './index';

async function runGit(cwd: string, args: string[]): Promise<void> {
  const result = await runCommandTextLegacy({
    command: 'git',
    args,
    cwd,
    check: 'none',
  });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.code}): ${result.stderr}`);
  }
}

async function createTempGitRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'lody-code-nav-test-'));
  await runGit(root, ['init', '-b', 'main']);
  await runGit(root, ['config', 'user.email', 'test@example.com']);
  await runGit(root, ['config', 'user.name', 'Test User']);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
  await runGit(root, ['add', '.']);
  await runGit(root, ['commit', '-m', 'initial']);
  return root;
}

const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe('AstGrepCodeNavProvider', () => {
  it('computes diff-outline symbol attribution across functions, HOCs, classes, arrows, constants, and comments', async () => {
    const repo = await createTempGitRepo({
      'src/panel.tsx': [
        "import { memo } from 'react';",
        '',
        'export const DEFAULT_LIMIT = 10;',
        '',
        'export function formatTitle(name: string) {',
        '  return name.trim();',
        '}',
        '',
        'const PanelCardImpl = ({ title }: { title: string }) => {',
        '  return <div>{formatTitle(title)}</div>;',
        '};',
        '',
        'export const PanelCard = memo(PanelCardImpl);',
        '',
        'export const InlineMemo = memo(({ label }: { label: string }) => {',
        '  return <span>{label}</span>;',
        '});',
        '',
        'export class PanelStore {',
        '  load() {',
        '    return DEFAULT_LIMIT;',
        '  }',
        '}',
        '',
      ].join('\n'),
    });
    tempDirs.push(repo);

    await runGit(repo, ['checkout', '-b', 'feat/review']);
    await writeFile(
      path.join(repo, 'src/panel.tsx'),
      [
        "import { memo } from 'react';",
        '',
        'export const DEFAULT_LIMIT = 20;',
        '',
        '// Leading doc comment added above function',
        'export function formatTitle(name: string) {',
        '  return name.trim().toUpperCase();',
        '}',
        '',
        'const PanelCardImpl = ({ title }: { title: string }) => {',
        '  return <section>{formatTitle(title)}</section>;',
        '};',
        '',
        'export const PanelCard = memo(PanelCardImpl);',
        '',
        'export const InlineMemo = memo(({ label }: { label: string }) => {',
        '  return <strong>{label}</strong>;',
        '});',
        '',
        'export class PanelStore {',
        '  load() {',
        '    return DEFAULT_LIMIT + 1;',
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf8'
    );
    await runGit(repo, ['add', '.']);
    await runGit(repo, ['commit', '-m', 'update panel']);

    const provider = new AstGrepCodeNavProvider();
    const outline = await provider.diffOutline({
      workspaceRoot: repo,
      scope: 'branch',
      preferredBaseBranch: 'main',
    });

    expect(outline.status).toBe('ok');
    if (outline.status !== 'ok') throw new Error('expected ok');
    expect(outline.files).toHaveLength(1);
    const file = outline.files[0]!;
    expect(file.path).toBe('src/panel.tsx');

    const names = file.symbols.map((s) => s.name);
    expect(names).toContain('DEFAULT_LIMIT');
    expect(names).toContain('formatTitle');
    expect(names).toContain('PanelCardImpl');
    // Separated HOC export surfaces alongside modified implementation.
    expect(names).toContain('PanelCard');
    expect(names).toContain('InlineMemo');
    expect(names).toContain('load');

    const loadSymbol = file.symbols.find((s) => s.name === 'load');
    expect(loadSymbol).toMatchObject({ kind: 'method', containerName: 'PanelStore', hunkCount: 1 });

    // Hunk touching comment + formatTitle body attributes to formatTitle, not top-level.
    const titleHunk = file.hunks.find((h) => h.enclosing?.name === 'formatTitle');
    expect(titleHunk?.enclosing).toMatchObject({
      name: 'formatTitle',
      kind: 'function',
      startLine: 6,
      endLine: 8,
    });

    // Uncommitted scope on clean committed worktree sees no changes, then sees uncommitted edit.
    const cleanUncommitted = await provider.diffOutline({
      workspaceRoot: repo,
      scope: 'uncommitted',
    });
    expect(cleanUncommitted.status === 'ok' && cleanUncommitted.files).toEqual([]);

    await writeFile(
      path.join(repo, 'src/untracked.ts'),
      'export const helperArrow = () => 42;\n',
      'utf8'
    );
    const dirtyUncommitted = await provider.diffOutline({
      workspaceRoot: repo,
      scope: 'uncommitted',
    });
    expect(dirtyUncommitted.status).toBe('ok');
    if (dirtyUncommitted.status === 'ok') {
      expect(dirtyUncommitted.files.map((f) => f.path)).toContain('src/untracked.ts');
      expect(dirtyUncommitted.files[0]?.symbols[0]?.name).toBe('helperArrow');
    }
  });

  it('returns outermost-to-innermost enclosing symbol chains with full line bounds', async () => {
    const repo = await createTempGitRepo({
      'src/service.ts': [
        'export class WorkerController {',
        '  runJob(id: string) {',
        '    const inner = () => {',
        '      return id.length;',
        '    };',
        '    return inner();',
        '  }',
        '}',
        '',
      ].join('\n'),
    });
    tempDirs.push(repo);

    const provider = new AstGrepCodeNavProvider();
    const result = await provider.enclosing({
      workspaceRoot: repo,
      path: 'src/service.ts',
      startLine: 4,
      endLine: 4,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.chain).toEqual([
      { name: 'WorkerController', kind: 'class', startLine: 1, endLine: 8 },
      {
        name: 'runJob',
        kind: 'method',
        containerName: 'WorkerController',
        startLine: 2,
        endLine: 7,
      },
      {
        name: 'inner',
        kind: 'function',
        containerName: 'runJob',
        startLine: 3,
        endLine: 5,
      },
    ]);
  });

  it('resolves exact definitions via same-file, this, @/ alias, and 1-hop @lody barrel while marking generic member methods heuristic', async () => {
    const repo = await createTempGitRepo({
      'apps/cli/tsconfig.json': JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@/*': ['src/*'] },
        },
      }),
      'packages/shared/package.json': JSON.stringify({
        name: '@lody/shared',
        main: './src/index.ts',
      }),
      'packages/shared/src/index.ts': "export * from './format';\n",
      'packages/shared/src/format.ts':
        'export function formatSharedToken(v: string) { return v; }\n',
      'apps/cli/src/utils/calc.ts':
        'export function computeChecksum(s: string) { return s.length; }\n',
      'apps/cli/src/other-a.ts': 'export class SocketA { close() { return 1; } }\n',
      'apps/cli/src/other-b.ts': 'export class SocketB { close() { return 2; } }\n',
      'apps/cli/src/consumer.ts': [
        "import { formatSharedToken } from '@lody/shared';",
        "import { computeChecksum } from '@/utils/calc';",
        '',
        'function localHelper(x: string) { return x; }',
        '',
        'export class Runner {',
        '  execute(sock: { close(): void }) {',
        '    const a = localHelper("hi");',
        '    const b = computeChecksum(a);',
        '    const c = formatSharedToken(String(b));',
        '    this.finish(c);',
        '    sock.close();',
        '  }',
        '  finish(val: string) { return val; }',
        '}',
        '',
      ].join('\n'),
    });
    tempDirs.push(repo);

    const provider = new AstGrepCodeNavProvider();

    // 1. Same-file non-member -> exact
    const localDef = await provider.definitions({
      workspaceRoot: repo,
      path: 'apps/cli/src/consumer.ts',
      line: 8,
      character: 16,
    });
    expect(localDef).toMatchObject({
      status: 'ok',
      confidence: 'exact',
      items: [{ path: 'apps/cli/src/consumer.ts', line: 4, name: 'localHelper' }],
    });

    // 2. `@/` tsconfig alias import -> exact
    const aliasDef = await provider.definitions({
      workspaceRoot: repo,
      path: 'apps/cli/src/consumer.ts',
      line: 9,
      character: 16,
    });
    expect(aliasDef).toMatchObject({
      status: 'ok',
      confidence: 'exact',
      items: [{ path: 'apps/cli/src/utils/calc.ts', line: 1, name: 'computeChecksum' }],
    });

    // 3. 1-hop `@lody/shared` barrel re-export -> exact
    const barrelDef = await provider.definitions({
      workspaceRoot: repo,
      path: 'apps/cli/src/consumer.ts',
      line: 10,
      character: 16,
    });
    expect(barrelDef).toMatchObject({
      status: 'ok',
      confidence: 'exact',
      items: [{ path: 'packages/shared/src/format.ts', line: 1, name: 'formatSharedToken' }],
    });

    // 4. `this.finish` inside enclosing class -> exact
    const thisDef = await provider.definitions({
      workspaceRoot: repo,
      path: 'apps/cli/src/consumer.ts',
      line: 11,
      character: 10,
    });
    expect(thisDef).toMatchObject({
      status: 'ok',
      confidence: 'exact',
      items: [
        {
          path: 'apps/cli/src/consumer.ts',
          line: 14,
          name: 'finish',
          containerName: 'Runner',
        },
      ],
    });

    // 5. Generic member method `sock.close()` -> NEVER exact, returns heuristic candidates
    const memberDef = await provider.definitions({
      workspaceRoot: repo,
      path: 'apps/cli/src/consumer.ts',
      line: 12,
      character: 10,
    });
    expect(memberDef.status).toBe('ok');
    if (memberDef.status === 'ok') {
      expect(memberDef.confidence).toBe('heuristic');
      expect(memberDef.items.length).toBe(2);
      expect(memberDef.items.map((i) => i.containerName).sort()).toEqual(['SocketA', 'SocketB']);
    }
  });

  it('traces 1-2 hop callers, filters AST noise, ignores non-callable const initializers, and guards generic hop-2 fan-out', async () => {
    const repo = await createTempGitRepo({
      'src/leaf.ts': [
        'export function targetLeaf(x: number) {',
        '  return x + 1;',
        '}',
        '',
        '// Comment mentioning targetLeaf(123)',
        'const text = "targetLeaf(456)";',
        'const selfNamed = function targetLeaf() { return 0; };',
        '',
      ].join('\n'),
      'src/mid.ts': [
        "import { targetLeaf } from './leaf';",
        '',
        '// Top-level plain const MUST NOT be mistaken as an enclosing function',
        'export const topLevelResult = targetLeaf(1);',
        '',
        'export function middleOrchestrator() {',
        '  const localVal = targetLeaf(2);',
        '  return localVal;',
        '}',
        '',
        'export function close() {',
        '  return targetLeaf(3);',
        '}',
        '',
      ].join('\n'),
      'src/top.ts': [
        "import { middleOrchestrator, close } from './mid';",
        '',
        'export function entryWorkflow() {',
        '  return middleOrchestrator();',
        '}',
        '',
        'export function shutdownAll() {',
        '  return close();',
        '}',
        '',
      ].join('\n'),
    });
    tempDirs.push(repo);

    const provider = new AstGrepCodeNavProvider();
    const res = await provider.callers({
      workspaceRoot: repo,
      path: 'src/leaf.ts',
      line: 1,
      character: 17,
      maxDepth: 2,
    });

    expect(res.status).toBe('ok');
    if (res.status !== 'ok') throw new Error('expected ok');

    // Noise filtered: comment, string, declaration, import, function_expression self-name all excluded.
    expect(res.items.some((item) => item.path === 'src/leaf.ts')).toBe(false);

    const depth1 = res.items.filter((item) => item.depth === 1);
    // Top-level `const topLevelResult = targetLeaf(1)` has NO enclosing function (`caller === undefined`).
    const topLevelCall = depth1.find((item) => item.line === 4);
    expect(topLevelCall).toBeDefined();
    expect(topLevelCall?.caller).toBeUndefined();

    // `const localVal = targetLeaf(2)` inside `middleOrchestrator` reports `middleOrchestrator`, NOT `localVal`.
    const midCall = depth1.find((item) => item.line === 7);
    expect(midCall?.caller).toMatchObject({
      name: 'middleOrchestrator',
      kind: 'function',
      startLine: 6,
      endLine: 9,
    });

    // Depth-2 traces `middleOrchestrator` -> `entryWorkflow`, while generic `close` is fanout-protected!
    const depth2 = res.items.filter((item) => item.depth === 2);
    expect(depth2).toHaveLength(1);
    expect(depth2[0]).toMatchObject({
      path: 'src/top.ts',
      line: 4,
      depth: 2,
      viaSymbol: 'middleOrchestrator',
      caller: { name: 'entryWorkflow', kind: 'function', startLine: 3, endLine: 5 },
    });
    expect(res.truncated).toBe(true);
    expect(res.truncatedReason).toBe('fanout');
  });

  it('uses Rust multithreaded findInFiles path when >= 50 candidate files match', async () => {
    const files: Record<string, string> = {
      'src/target.ts': 'export function bulkTarget() { return 1; }\n',
    };
    for (let i = 0; i < 55; i += 1) {
      files[`src/callers/caller-${String(i).padStart(2, '0')}.ts`] = [
        "import { bulkTarget } from '../target';",
        `export function invoke${i}() { return bulkTarget(); }`,
        '',
      ].join('\n');
    }
    const repo = await createTempGitRepo(files);
    tempDirs.push(repo);

    const provider = new AstGrepCodeNavProvider();
    const res = await provider.callers({
      workspaceRoot: repo,
      path: 'src/target.ts',
      line: 1,
      character: 17,
      maxDepth: 1,
      limit: 60,
    });

    expect(res.status).toBe('ok');
    if (res.status !== 'ok') throw new Error('expected ok');
    expect(res.items).toHaveLength(55);
    expect(res.items.every((item) => item.caller?.name.startsWith('invoke'))).toBe(true);
  });

  it('rejects path traversal and symlinks escaping the worktree root', async () => {
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'lody-code-nav-outside-'));
    tempDirs.push(outsideDir);
    const secretFile = path.join(outsideDir, 'secret.ts');
    await writeFile(secretFile, 'export function secretFn() { return "secret"; }\n', 'utf8');

    const repo = await createTempGitRepo({
      'src/ok.ts': 'export function okFn() { return 1; }\n',
    });
    tempDirs.push(repo);
    await symlink(secretFile, path.join(repo, 'src/escape-link.ts'));

    const provider = new AstGrepCodeNavProvider();

    const traversal = await provider.enclosing({
      workspaceRoot: repo,
      path: '../outside/secret.ts',
      startLine: 1,
      endLine: 1,
    });
    expect(traversal).toMatchObject({ status: 'error', code: 'path_not_allowed' });

    const absOutside = await provider.enclosing({
      workspaceRoot: repo,
      path: secretFile,
      startLine: 1,
      endLine: 1,
    });
    expect(absOutside).toMatchObject({ status: 'error', code: 'path_not_allowed' });

    const symlinkEscape = await provider.enclosing({
      workspaceRoot: repo,
      path: 'src/escape-link.ts',
      startLine: 1,
      endLine: 1,
    });
    expect(symlinkEscape).toMatchObject({ status: 'error', code: 'path_not_allowed' });
  });

  it('returns structured unavailable error without throwing when @ast-grep/napi cannot load', async () => {
    const repo = await createTempGitRepo({ 'src/a.ts': 'export const a = 1;\n' });
    tempDirs.push(repo);

    const provider = new AstGrepCodeNavProvider({ loadAstGrep: async () => null });
    const res = await provider.enclosing({
      workspaceRoot: repo,
      path: 'src/a.ts',
      startLine: 1,
      endLine: 1,
    });
    expect(res).toMatchObject({
      type: 'code-nav/query',
      status: 'error',
      code: 'unavailable',
    });
  });
});

describe('Bounded L1/L2 caches, response budget trimming, and CodeNavService limits', () => {
  it('enforces L1 maxFiles, maxSourceBytes, and idle TTL with fake timers', () => {
    vi.useFakeTimers();
    const cache = new BoundedAstLruCache<string>({
      maxFiles: 2,
      maxSourceBytes: 100,
      idleClearMs: 5_000,
    });

    cache.set('a', { root: 'r1', source: 'x'.repeat(40), sourceBytes: 40 });
    cache.set('b', { root: 'r2', source: 'y'.repeat(40), sourceBytes: 40 });
    expect(cache.stats()).toEqual({ count: 2, totalSourceBytes: 80 });

    // Touch `a` so `b` is LRU; inserting `c` (40 bytes) evicts `b` for both count & bytes.
    expect(cache.get('a')?.root).toBe('r1');
    cache.set('c', { root: 'r3', source: 'z'.repeat(40), sourceBytes: 40 });
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')?.root).toBe('r1');
    expect(cache.get('c')?.root).toBe('r3');
    expect(cache.stats()).toEqual({ count: 2, totalSourceBytes: 80 });

    // Oversized single entry is not retained.
    cache.set('huge', { root: 'r4', source: 'h'.repeat(120), sourceBytes: 120 });
    expect(cache.get('huge')).toBeUndefined();

    // Idle clear drops all native references deterministically.
    vi.advanceTimersByTime(5_001);
    expect(cache.stats()).toEqual({ count: 0, totalSourceBytes: 0 });
  });

  it('enforces L2 global byte budget across snapshots', () => {
    const cache = new BoundedSymbolIndexCache(200);
    const makeIdx = (relPath: string, estimatedBytes: number) => ({
      relPath,
      language: 'typescript' as const,
      estimatedBytes,
      symbols: [],
      imports: [],
      exports: [],
    });

    cache.set('snap-1', 'a.ts', makeIdx('a.ts', 90));
    cache.set('snap-1', 'b.ts', makeIdx('b.ts', 90));
    expect(cache.stats()).toEqual({ count: 2, totalBytes: 180 });

    cache.set('snap-2', 'c.ts', makeIdx('c.ts', 90));
    expect(cache.get('snap-1', 'a.ts')).toBeUndefined();
    expect(cache.get('snap-1', 'b.ts')?.relPath).toBe('b.ts');
    expect(cache.get('snap-2', 'c.ts')?.relPath).toBe('c.ts');
    expect(cache.stats().totalBytes).toBeLessThanOrEqual(200);
  });

  it('trims oversized responses to <= 256 KiB budget', () => {
    const hugeCallers = {
      type: 'code-nav/query' as const,
      status: 'ok' as const,
      action: 'callers' as const,
      symbol: 'fn',
      items: Array.from({ length: 100 }, (_, i) => ({
        path: `src/dir/file-${i}.ts`,
        line: i + 1,
        character: 4,
        previewLine: 'x'.repeat(200),
        depth: 1 as const,
      })),
      totalCandidates: 100,
      truncated: false,
      provider: 'ast-grep' as const,
    };

    const trimmed = trimResponseToBudget(hugeCallers, 2_048);
    expect(trimmed.status).toBe('ok');
    if (trimmed.status === 'ok' && trimmed.action === 'callers') {
      expect(estimateCodeNavResponseBytes(trimmed)).toBeLessThanOrEqual(2_048);
      expect(trimmed.truncated).toBe(true);
      expect(trimmed.truncatedReason).toBe('budget');
      expect(trimmed.items.length).toBeLessThan(100);
    }
  });

  it('bounds CodeNavService concurrency and enforces AbortSignal timeouts', async () => {
    let active = 0;
    let peak = 0;
    const resolvers: Array<() => void> = [];

    const stubProvider: CodeNavProvider = {
      id: 'ast-grep',
      diffOutline: vi.fn(),
      definitions: vi.fn(),
      callers: vi.fn(),
      enclosing: async (_input, signal) => {
        active += 1;
        peak = Math.max(peak, active);
        try {
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => reject(new Error('aborted'));
            signal?.addEventListener('abort', onAbort, { once: true });
            resolvers.push(() => {
              signal?.removeEventListener('abort', onAbort);
              resolve();
            });
          });
          return {
            type: 'code-nav/query',
            status: 'ok',
            action: 'enclosing',
            path: 'a.ts',
            chain: [],
            provider: 'ast-grep',
          };
        } finally {
          active -= 1;
        }
      },
    };

    const service = new CodeNavService({
      resolveWorkspace: async (sessionId: SessionId) => ({
        ok: true,
        ownerSessionId: sessionId,
        workspaceRoot: '/tmp/ws',
      }),
      provider: stubProvider,
      maxConcurrency: 2,
      timeoutMs: 5_000,
    });

    const req = {
      action: 'enclosing' as const,
      sessionId: 'sess-1',
      path: 'a.ts',
      startLine: 1,
      endLine: 1,
    };

    const p1 = service.query(req);
    const p2 = service.query(req);
    const p3 = service.query(req);

    // Wait microtasks until 2 are active and 1 is queued.
    await vi.waitFor(() => {
      expect(resolvers.length).toBe(2);
    });
    expect(peak).toBe(2);

    // Cancel a 4th request via external AbortSignal while queued.
    const abortController = new AbortController();
    const p4 = service.query(req, abortController.signal);
    abortController.abort();
    expect(await p4).toMatchObject({ status: 'error', code: 'timeout' });

    // Release first two, third runs next.
    resolvers.shift()?.();
    resolvers.shift()?.();
    await vi.waitFor(() => {
      expect(resolvers.length).toBe(1);
    });
    resolvers.shift()?.();

    const results = await Promise.all([p1, p2, p3]);
    expect(results.every((r) => r.status === 'ok')).toBe(true);
    expect(peak).toBe(2);

    await service.dispose();
  });
});
