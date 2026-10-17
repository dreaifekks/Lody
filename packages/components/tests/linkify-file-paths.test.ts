import { describe, expect, it } from 'vitest';
import { matchWholeFilePath, splitTextIntoFilePathSegments } from '../src/lib/linkify-file-paths';

const paths = (value: string): string[] =>
  splitTextIntoFilePathSegments(value)
    .filter((segment) => segment.type === 'path')
    .map((segment) => segment.value);

describe('splitTextIntoFilePathSegments (prose)', () => {
  it('linkifies the requested bare-path forms', () => {
    expect(paths('see packages/components/src/lib/session-file-language.ts here')).toEqual([
      'packages/components/src/lib/session-file-language.ts',
    ]);
    expect(paths('open packages/components/src/lib/session-file-language.ts:32 now')).toEqual([
      'packages/components/src/lib/session-file-language.ts:32',
    ]);
    expect(paths('jump to locale/session-file-language.ts:L32 please')).toEqual([
      'locale/session-file-language.ts:L32',
    ]);
    expect(paths('and README.md#L100 too')).toEqual(['README.md#L100']);
  });

  it('preserves surrounding text and order', () => {
    const segments = splitTextIntoFilePathSegments('edit src/a.ts then src/b.ts done');
    expect(segments).toEqual([
      { type: 'text', value: 'edit ' },
      { type: 'path', value: 'src/a.ts' },
      { type: 'text', value: ' then ' },
      { type: 'path', value: 'src/b.ts' },
      { type: 'text', value: ' done' },
    ]);
  });

  it('strips trailing sentence/bracket punctuation but keeps line suffixes', () => {
    expect(paths('look at src/foo.ts.')).toEqual(['src/foo.ts']);
    expect(paths('(see src/foo.ts:32)')).toEqual(['src/foo.ts:32']);
    expect(paths('"src/foo.ts", really')).toEqual(['src/foo.ts']);
  });

  it('works inside CJK prose without spaces', () => {
    expect(paths('详见packages/components/src/lib/foo.ts。')).toEqual([
      'packages/components/src/lib/foo.ts',
    ]);
  });

  it('takes non-ASCII names after the first separator', () => {
    expect(paths('notes/demoday/准备.md')).toEqual(['notes/demoday/准备.md']);
    expect(paths('见 notes/demoday/准备.md 这个文件')).toEqual(['notes/demoday/准备.md']);
    expect(paths('notes/准备/prep.md')).toEqual(['notes/准备/prep.md']);
    expect(paths('notes/v1.2版/x.md')).toEqual(['notes/v1.2版/x.md']);
    expect(paths('打开docs/設計/メモ.md:12。')).toEqual(['docs/設計/メモ.md:12']);
    expect(paths('看 ./docs/v1.2版本/说明.md#L3')).toEqual(['./docs/v1.2版本/说明.md#L3']);
  });

  it('ends a path at an ASCII extension that runs into non-ASCII text', () => {
    expect(splitTextIntoFilePathSegments('src/foo.ts和src/bar.ts')).toEqual([
      { type: 'path', value: 'src/foo.ts' },
      { type: 'text', value: '和' },
      { type: 'path', value: 'src/bar.ts' },
    ]);
    expect(paths('参考docs/设计.md和docs/计划.md的内容')).toEqual(['docs/设计.md', 'docs/计划.md']);
    expect(paths('详见packages/foo.d.ts的实现')).toEqual(['packages/foo.d.ts']);
    // Whether the extension is a known file type does not matter.
    expect(paths('见logs/app.log以及src/main.ts')).toEqual(['logs/app.log', 'src/main.ts']);
    expect(paths('见docs/a.xyz和src/b.ts')).toEqual(['docs/a.xyz', 'src/b.ts']);
    expect(paths('详见src/a.ini和src/b.conf')).toEqual(['src/a.ini', 'src/b.conf']);
    expect(paths('见docs/a.xyz这个文件')).toEqual(['docs/a.xyz']);
  });

  it('splits a long run of paths joined by non-ASCII text', () => {
    const expected = Array.from({ length: 3000 }, (_, index) => `src/f${index}.ts`);
    const found = paths(expected.join('和'));
    expect(found).toHaveLength(3000);
    expect(found.slice(0, 2)).toEqual(['src/f0.ts', 'src/f1.ts']);
    expect(found.slice(-2)).toEqual(['src/f2998.ts', 'src/f2999.ts']);
    expect(paths('src/f.ts和'.repeat(3000))).toEqual(
      Array.from({ length: 3000 }, () => 'src/f.ts')
    );
  });

  it('needs an ASCII first segment and, for a non-ASCII path, an ASCII extension', () => {
    expect(paths('目录/准备.md')).toEqual([]);
    expect(paths('notes/准备/目录')).toEqual([]);
    expect(paths('notes/准备.文档')).toEqual([]);
    expect(paths('读/写权限和I/O操作')).toEqual([]);
    // Then only the ASCII path in front counts, and no tail of the rest does.
    expect(paths('见src/a.ts/以及其他')).toEqual(['src/a.ts']);
    expect(paths('src/工具/a.b/说明')).toEqual([]);
  });

  it('keeps a home-relative path whole instead of linking its tail', () => {
    // `~` is not a path character, so the scan used to fail on it and link
    // `/self/done/2026-10-14.md` instead, a file that exists nowhere.
    expect(splitTextIntoFilePathSegments('written to ~/self/done/2026-10-14.md today')).toEqual([
      { type: 'text', value: 'written to ' },
      { type: 'path', value: '~/self/done/2026-10-14.md' },
      { type: 'text', value: ' today' },
    ]);
    expect(paths('见~/notes/准备.md:12。')).toEqual(['~/notes/准备.md:12']);
    // A lone `~` or `~user/…` is not a home-relative path.
    expect(paths('a ~ b/c.ts and ~me/d.ts')).toEqual(['b/c.ts']);
  });

  it('requires a slash or line suffix in prose', () => {
    expect(paths('we run Node.js in production')).toEqual([]);
    expect(paths('bump to version 2.0 today')).toEqual([]);
    expect(paths('the index.js file is large')).toEqual([]);
  });

  it('does not linkify non-path slash usage', () => {
    expect(paths('this and/or that')).toEqual([]);
    expect(paths('a ratio of 3/4 here')).toEqual([]);
    expect(paths('read/write access')).toEqual([]);
  });

  it('leaves real URLs and emails alone', () => {
    expect(paths('mail me at user@example.com/inbox now')).toEqual([]);
    expect(paths('visit example.com/page.html for docs')).toEqual([]);
  });

  it('does not touch plain text with no candidates', () => {
    expect(splitTextIntoFilePathSegments('just a normal sentence.')).toEqual([
      { type: 'text', value: 'just a normal sentence.' },
    ]);
  });
});

describe('matchWholeFilePath (inline code)', () => {
  it('matches when the whole content is a file path', () => {
    expect(matchWholeFilePath('locale/session-file-language.ts')).toBe(
      'locale/session-file-language.ts'
    );
    expect(matchWholeFilePath('src/foo.ts:32')).toBe('src/foo.ts:32');
    expect(matchWholeFilePath('tsconfig.json')).toBe('tsconfig.json');
    expect(matchWholeFilePath('README.md')).toBe('README.md');
    expect(matchWholeFilePath('~/self/done/2026-10-14.md')).toBe('~/self/done/2026-10-14.md');
  });

  it('rejects commands, identifiers, and unrecognized bare names', () => {
    expect(matchWholeFilePath('npm run build')).toBeNull();
    expect(matchWholeFilePath('useState')).toBeNull();
    expect(matchWholeFilePath('Math.max')).toBeNull();
    expect(matchWholeFilePath('foo.bar')).toBeNull();
  });
});
