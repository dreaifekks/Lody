import { describe, expect, it } from 'vitest';
import { normalizeBoardMeta, type BoardMeta, type SessionId } from '@lody/shared';
import {
  boardFileLinkPath,
  fileSourceKey,
  resolveDocumentLink,
  type FileTarget,
} from '../src/lib/document-link-open';
import { resolveBoardFileLink } from '../src/lib/board-directory-file-provider';

const board = normalizeBoardMeta({
  version: 1,
  id: 'bd_test',
  name: 'Release',
  purpose: 'Ship it',
  coordinatorSessionId: 'coordinator',
  createdAtMs: 1,
  createdByUserId: 'user',
}) as BoardMeta;

const inSession = (path: string): FileTarget => ({
  source: { kind: 'session', sessionId: 'thread' as SessionId },
  path,
});
const inBoard = (path: string): FileTarget => ({
  source: { kind: 'board', boardId: 'bd_test' },
  path,
});

/** Resolves `href` written in `document`, against files that exist where `existing` says. */
async function resolve(href: string, document: FileTarget, existing: readonly string[] = []) {
  const probed: string[] = [];
  const target = await resolveDocumentLink({
    href,
    document,
    readerSessionId: 'coordinator' as SessionId,
    workspaceId: 'ws',
    boards: [board],
    probe: async (candidate) => {
      const key = `${fileSourceKey(candidate.source)}:${candidate.path}`;
      probed.push(key);
      return existing.includes(key) ? { state: 'found' } : { state: 'missing' };
    },
  });
  return { target, probed };
}

describe('document links', () => {
  it('reads a relative link beside the document, then from the workspace root', async () => {
    const document = inSession('docs/guide.md');
    expect(await resolve('setup.md', document, ['session:thread:docs/setup.md'])).toEqual({
      target: inSession('docs/setup.md'),
      probed: ['session:thread:docs/setup.md'],
    });
    expect(
      await resolve('packages/app/src/main.ts#L12', document, [
        'session:thread:packages/app/src/main.ts',
      ])
    ).toEqual({
      target: { ...inSession('packages/app/src/main.ts'), startLine: 12 },
      probed: [
        'session:thread:docs/packages/app/src/main.ts',
        'session:thread:packages/app/src/main.ts',
      ],
    });
    // Found in neither place: the document's own reading, which the viewer reports missing.
    expect((await resolve('./gone.md', document)).target).toEqual(inSession('docs/gone.md'));
    // `..` climbs from the document's folder.
    expect((await resolve('../README.md', document, ['session:thread:README.md'])).target).toEqual(
      inSession('README.md')
    );
  });

  it('asks nothing when the document folder is the workspace root or the path is absolute', async () => {
    expect(await resolve('setup.md', inSession('guide.md'))).toEqual({
      target: inSession('setup.md'),
      probed: [],
    });
    expect(await resolve('/srv/notes/a.md:3', inSession('docs/guide.md'))).toEqual({
      target: { ...inSession('/srv/notes/a.md'), startLine: 3 },
      probed: [],
    });
    expect(await resolve('~/notes/a%20b.md', inSession('docs/guide.md'))).toEqual({
      target: inSession('~/notes/a b.md'),
      probed: [],
    });
  });

  it('keeps a document outside the workspace on its own folder first', async () => {
    const document = inSession('/home/me/notes/today.md');
    expect(
      (await resolve('later.md', document, ['session:thread:/home/me/notes/later.md'])).target
    ).toEqual(inSession('/home/me/notes/later.md'));
    expect((await resolve('later.md', document, ['session:thread:later.md'])).target).toEqual(
      inSession('later.md')
    );
  });

  it('opens a Board directory path in its Board, wherever the link is written', async () => {
    for (const document of [inSession('docs/guide.md'), inBoard('memory/index.md')]) {
      expect(await resolve('/data/boards/ws/bd_test/files/ui-todo/design.md#L4', document)).toEqual(
        { target: inBoard('files/ui-todo/design.md'), probed: [] }
      );
    }
    // A Board the catalog does not list (yet) keeps its id for the preview to report.
    expect(
      (await resolve('/data/boards/ws/bd_gone/memory/a.md', inSession('a.md'))).target
    ).toEqual({ source: { kind: 'board', boardId: 'bd_gone' }, path: 'memory/a.md' });
  });

  it("reads a Board document's links in its Board, then in its reader's workspace", async () => {
    const document = inBoard('files/ui-todo/design.md');
    expect(
      (await resolve('shots/light.png', document, ['board:bd_test:files/ui-todo/shots/light.png']))
        .target
    ).toEqual(inBoard('files/ui-todo/shots/light.png'));
    expect(
      (await resolve('../../memory/ui-todo.md', document, ['board:bd_test:memory/ui-todo.md']))
        .target
    ).toEqual(inBoard('memory/ui-todo.md'));
    // What the Board does not hold is the reader's: the coordinator's workspace.
    expect(
      await resolve('packages/components/src/x.ts:9', document, [
        'session:coordinator:packages/components/src/x.ts',
      ])
    ).toEqual({
      target: {
        source: { kind: 'session', sessionId: 'coordinator' },
        path: 'packages/components/src/x.ts',
        startLine: 9,
      },
      probed: [
        'board:bd_test:files/ui-todo/packages/components/src/x.ts',
        'session:coordinator:packages/components/src/x.ts',
      ],
    });
    // A path that leaves the Board's areas is the reader's, with nothing to ask.
    expect(await resolve('../../../README.md', document)).toEqual({
      target: { source: { kind: 'session', sessionId: 'coordinator' }, path: '../../../README.md' },
      probed: [],
    });
    // The shared notes have no folder: their links start at the Board directory.
    expect(
      (await resolve('files/plan.md', inBoard('notes'), ['board:bd_test:files/plan.md'])).target
    ).toEqual(inBoard('files/plan.md'));
  });

  it('keeps the document reading while its source cannot answer', async () => {
    const target = await resolveDocumentLink({
      href: 'setup.md',
      document: inSession('docs/guide.md'),
      readerSessionId: 'coordinator' as SessionId,
      workspaceId: 'ws',
      boards: [board],
      probe: async () => ({ state: 'unknown' }),
    });
    expect(target).toEqual(inSession('docs/setup.md'));
  });

  it('leaves non-file links alone', async () => {
    for (const href of ['https://example.com/a.md', '#section', 'mailto:me@example.com'])
      expect((await resolve(href, inSession('docs/guide.md'))).target).toBeNull();
  });

  it('spells a Board file the way the session page recognizes it', () => {
    const path = boardFileLinkPath('ws', inBoard('files/ui-todo/design.md'));
    expect(resolveBoardFileLink(path, 'ws', [board], 'canonical')).toMatchObject({
      boardId: 'bd_test',
      area: 'files',
      path: 'ui-todo/design.md',
    });
    expect(boardFileLinkPath('ws', inSession('docs/a.md'))).toBe('docs/a.md');
  });
});
