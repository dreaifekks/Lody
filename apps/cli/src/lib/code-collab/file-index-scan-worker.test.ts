import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import fileIndexScanWorker from './file-index-scan-worker';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd });
}

async function withGitWorkspace<T>(fn: (workspaceRoot: string) => Promise<T>): Promise<T> {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'lody-file-index-worker-'));
  try {
    await git(workspaceRoot, ['init', '-b', 'main']);
    await git(workspaceRoot, ['config', 'user.email', 'test@example.com']);
    await git(workspaceRoot, ['config', 'user.name', 'Test User']);
    await mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
    await writeFile(path.join(workspaceRoot, 'README.md'), '# Test\n');
    await writeFile(path.join(workspaceRoot, 'src', 'app.ts'), 'one\n');
    await git(workspaceRoot, ['add', '.']);
    await git(workspaceRoot, ['commit', '-m', 'initial']);

    await writeFile(path.join(workspaceRoot, 'src', 'app.ts'), 'one\ntwo\n');
    await writeFile(path.join(workspaceRoot, 'src', 'new.ts'), 'created\nfile\n');
    return await fn(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function withPlainWorkspace<T>(fn: (workspaceRoot: string) => Promise<T>): Promise<T> {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'lody-file-index-worker-plain-'));
  try {
    await mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
    await writeFile(path.join(workspaceRoot, 'README.md'), '# Plain\n');
    await writeFile(path.join(workspaceRoot, 'src', 'app.ts'), 'plain\n');
    return await fn(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

describe('fileIndexScanWorker', () => {
  it('rebuilds against the tracking base for a qualified local owner ref', async () => {
    await withGitWorkspace(async (workspaceRoot) => {
      await git(workspaceRoot, ['checkout', '-b', 'feature']);
      await git(workspaceRoot, ['add', '.']);
      await git(workspaceRoot, ['commit', '-m', 'upstream changes']);
      await git(workspaceRoot, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
      await writeFile(path.join(workspaceRoot, 'avatar.txt'), 'avatar fix\n');
      await git(workspaceRoot, ['add', '.']);
      await git(workspaceRoot, ['commit', '-m', 'avatar fix']);
      const scan = () =>
        fileIndexScanWorker({
          kind: 'full-state',
          workspaceRoot,
          preferredBaseBranch: 'refs/heads/main',
          maxRawTextBytes: 1024 * 1024,
          entryBudget: 1000,
        });
      const before = await scan();
      expect(before.status).toBe('ok');
      if (before.status !== 'ok') throw new Error('Expected Git scan');
      expect(before.allChanges).toEqual({ 'avatar.txt': { diff: [1, 0] } });
      await git(workspaceRoot, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
      const merged = await scan();
      expect(merged.status).toBe('ok');
      if (merged.status !== 'ok') throw new Error('Expected merged scan');
      expect(merged.allChanges).toEqual({});
      expect(merged.fileIndex['avatar.txt']).toBe(true);
    });
  });
  it('builds Git-backed full file-index state off the main service path', async () => {
    await withGitWorkspace(async (workspaceRoot) => {
      const result = await fileIndexScanWorker({
        kind: 'full-state',
        workspaceRoot,
        maxRawTextBytes: 1024 * 1024,
        entryBudget: 1000,
      });

      expect(result.kind).toBe('full-state');
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;

      expect(result.allChangesSource).toBe('git');
      expect(result.fileTreeEntries).toContainEqual(['src', { kind: 'lazy' }]);
      expect(result.fileTreeEntries).toContainEqual(['README.md', true]);
      expect(result.fileTreeEntries).toContainEqual(['src/app.ts', true]);
      expect(result.fileTreeEntries).toContainEqual(['src/new.ts', true]);
      expect(result.allChanges['src/app.ts']).toEqual({ diff: [1, 0] });
      expect(result.allChanges['src/new.ts']).toEqual({ diff: [2, 0] });
      expect(result.fileIndex['src/app.ts']).toEqual({
        kind: 'file',
        change: { diff: [1, 0] },
      });
      expect(result.fileIndex['src/new.ts']).toEqual({
        kind: 'file',
        change: { diff: [2, 0] },
      });
      expect(result.pathCount).toBe(Object.keys(result.fileIndex).length);
    });
  });

  it('lists Git-ignored paths as marked rows and restores the opened ignored directories', async () => {
    await withGitWorkspace(async (workspaceRoot) => {
      await writeFile(path.join(workspaceRoot, '.gitignore'), 'build/\n*.log\n');
      await writeFile(path.join(workspaceRoot, '.git', 'info', 'exclude'), 'notes/\n');
      await mkdir(path.join(workspaceRoot, 'notes', 'demoday'), { recursive: true });
      await mkdir(path.join(workspaceRoot, 'build', 'out'), { recursive: true });
      await mkdir(path.join(workspaceRoot, 'logs', 'old'), { recursive: true });
      await writeFile(path.join(workspaceRoot, 'notes', 'demoday', 'prep.md'), 'prep\n');
      await writeFile(path.join(workspaceRoot, 'build', 'out', 'bundle.js'), 'bundle\n');
      await writeFile(path.join(workspaceRoot, 'logs', 'old', 'a.log'), 'a\n');
      await writeFile(path.join(workspaceRoot, 'src', 'trace.log'), 'trace\n');
      const scan = (expandedWorkspacePaths: readonly string[]) =>
        fileIndexScanWorker({
          kind: 'full-state',
          workspaceRoot,
          maxRawTextBytes: 1024 * 1024,
          entryBudget: 1000,
          expandedIgnoredDirectories: expandedWorkspacePaths.map((workspacePath) => ({
            workspacePath,
            absolutePath: path.join(workspaceRoot, workspacePath),
          })),
        });
      const folded = {
        '.gitignore': true,
        'README.md': true,
        build: { kind: 'lazy', ignored: true },
        // Holds nothing but ignored files, so Git reports the directory itself.
        logs: { kind: 'lazy', ignored: true },
        notes: { kind: 'lazy', ignored: true },
        src: { kind: 'lazy' },
        'src/app.ts': true,
        'src/new.ts': true,
        'src/trace.log': { kind: 'file', ignored: true },
      };

      const result = await scan([]);
      if (result.status !== 'ok') throw new Error('Expected Git scan');
      expect(Object.fromEntries(result.fileTreeEntries)).toEqual(folded);
      expect(result.fileIndex).toMatchObject({
        notes: { kind: 'lazy', ignored: true },
        'src/trace.log': { kind: 'file', ignored: true },
        'src/new.ts': { kind: 'file', change: { diff: [2, 0] } },
      });
      expect(Object.keys(result.allChanges).sort()).toEqual([
        '.gitignore',
        'src/app.ts',
        'src/new.ts',
      ]);

      // `src` is not ignored and `gone` does not exist: neither is read.
      const restored = await scan(['notes/demoday', 'notes', 'src', 'gone']);
      if (restored.status !== 'ok') throw new Error('Expected Git scan');
      expect(Object.fromEntries(restored.fileTreeEntries)).toEqual({
        ...folded,
        'notes/demoday': { kind: 'lazy', ignored: true },
        'notes/demoday/prep.md': { kind: 'file', ignored: true },
      });
      expect(restored.fileIndex['notes/demoday/prep.md']).toEqual({ kind: 'file', ignored: true });
    });
  });

  it('gives ignored paths only the entry budget that tracked and untracked paths leave', async () => {
    await withGitWorkspace(async (workspaceRoot) => {
      await writeFile(path.join(workspaceRoot, '.gitignore'), '*.log\ncache/\n');
      await mkdir(path.join(workspaceRoot, 'cache'));
      await mkdir(path.join(workspaceRoot, 'logs'));
      for (const name of ['a.log', 'b.log', 'cache/x.bin', 'logs/c.log', 'src/trace.log']) {
        await writeFile(path.join(workspaceRoot, name), 'ignored\n');
      }
      const scan = async (entryBudget: number) => {
        const result = await fileIndexScanWorker({
          kind: 'scan',
          directoryAbsolutePath: workspaceRoot,
          directoryWorkspacePath: '',
          maxRawTextBytes: 1024 * 1024,
          entryBudget,
          recursive: true,
        });
        if (result.kind !== 'scan') throw new Error('Expected scan result');
        return Object.fromEntries(result.entries);
      };
      const regular = {
        '.gitignore': true,
        'README.md': true,
        src: { kind: 'lazy' },
        'src/app.ts': true,
        'src/new.ts': true,
      };

      // Four ignored rows sit at the root, above the files under `src`; they do
      // not push those out, and take what is left shallowest first.
      expect(await scan(7)).toEqual({
        ...regular,
        'a.log': { kind: 'file', ignored: true },
        'b.log': { kind: 'file', ignored: true },
      });
      expect(await scan(5)).toEqual(regular);
      expect(await scan(4)).toEqual({
        '.gitignore': true,
        'README.md': true,
        src: { kind: 'lazy' },
        'src/app.ts': true,
      });
      expect(await scan(1000)).toEqual({
        ...regular,
        'a.log': { kind: 'file', ignored: true },
        'b.log': { kind: 'file', ignored: true },
        cache: { kind: 'lazy', ignored: true },
        logs: { kind: 'lazy', ignored: true },
        'src/trace.log': { kind: 'file', ignored: true },
      });
    });
  });

  it('lists dependency and build directories outside Git as ignored without walking them', async () => {
    await withPlainWorkspace(async (workspaceRoot) => {
      await mkdir(path.join(workspaceRoot, 'node_modules', 'pkg'), { recursive: true });
      await writeFile(path.join(workspaceRoot, 'node_modules', 'pkg', 'index.js'), '1\n');
      await mkdir(path.join(workspaceRoot, 'src', 'dist'));
      await writeFile(path.join(workspaceRoot, 'src', 'dist', 'out.js'), 'out\n');
      await mkdir(path.join(workspaceRoot, '.git'));
      await writeFile(path.join(workspaceRoot, '.git', 'description'), 'not a repository\n');

      const result = await fileIndexScanWorker({
        kind: 'scan',
        directoryAbsolutePath: workspaceRoot,
        directoryWorkspacePath: '',
        maxRawTextBytes: 1024 * 1024,
        entryBudget: 1000,
        recursive: true,
      });

      expect(result.kind).toBe('scan');
      if (result.kind !== 'scan') return;
      expect(Object.fromEntries(result.entries)).toEqual({
        'README.md': true,
        node_modules: { kind: 'lazy', ignored: true },
        src: { kind: 'lazy' },
        'src/app.ts': true,
        'src/dist': { kind: 'lazy', ignored: true },
      });
    });
  });

  it('builds non-Git full file-index state with provided diff-store changes', async () => {
    await withPlainWorkspace(async (workspaceRoot) => {
      const probe = await fileIndexScanWorker({
        kind: 'full-state',
        workspaceRoot,
        maxRawTextBytes: 1024 * 1024,
        entryBudget: 1000,
      });

      expect(probe).toEqual({
        kind: 'full-state',
        status: 'needs-provided-all-changes',
        reason: 'not-git',
      });

      const result = await fileIndexScanWorker({
        kind: 'full-state',
        workspaceRoot,
        maxRawTextBytes: 1024 * 1024,
        entryBudget: 1000,
        providedAllChanges: {
          source: 'diff-store',
          state: {
            'src/app.ts': { diff: [1, 0] },
          },
          computeMs: 7,
        },
      });

      expect(result.kind).toBe('full-state');
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;

      expect(result.allChangesSource).toBe('diff-store');
      expect(result.allChangesMs).toBe(7);
      expect(result.fileTreeEntries).toContainEqual(['src', { kind: 'lazy' }]);
      expect(result.fileTreeEntries).toContainEqual(['README.md', true]);
      expect(result.fileTreeEntries).toContainEqual(['src/app.ts', true]);
      expect(result.allChanges['src/app.ts']).toEqual({ diff: [1, 0] });
      expect(result.fileIndex['src/app.ts']).toEqual({
        kind: 'file',
        change: { diff: [1, 0] },
      });
      expect(result.pathCount).toBe(Object.keys(result.fileIndex).length);
    });
  });
});
