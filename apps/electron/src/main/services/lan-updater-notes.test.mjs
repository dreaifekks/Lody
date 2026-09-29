import assert from 'node:assert/strict'
import test from 'node:test'
import { composeLanReleaseNotes, getLanCompareUrl, readLanChanges } from './lan-updater-notes.ts'

const source = { repository: 'someone/Lody', tag: 'lan-latest' }
const commit = (message) => ({ sha: 'abc', commit: { message } })

void test('the repository is asked what changed between the two builds', () => {
  assert.equal(
    getLanCompareUrl(source, 'aaaaaaa', 'bbbbbbb'),
    'https://api.github.com/repos/someone/Lody/compare/aaaaaaa...bbbbbbb'
  )
})

void test('the changes are the subjects of the commits, newest first', () => {
  assert.deepEqual(
    readLanChanges({
      commits: [
        commit('fix: first\n\nWhy it was broken.'),
        commit('  feat: second  '),
        commit('\n'),
        { sha: 'no message' }
      ]
    }),
    ['feat: second', 'fix: first']
  )
})

void test('what is not a comparison names no change', () => {
  for (const answer of [null, 'rate limited', { message: 'Not Found' }, { commits: 'many' }, []]) {
    assert.deepEqual(readLanChanges(answer), [])
  }
})

void test('the notes name the build, what changed and where its files are', () => {
  const notes = composeLanReleaseNotes({
    source,
    version: '0.100.0-lan.5',
    commit: '0123456789abcdef0123456789abcdef01234567',
    changes: ['feat: update the machines of a LAN', 'fix: keep `code` and [links](x) as text']
  })

  assert.equal(
    notes.en,
    [
      'Build `0.100.0-lan.5` of commit `01234567`.',
      'What changed since the build you run:',
      '- feat: update the machines of a LAN\n' +
        '- fix: keep \\`code\\` and \\[links\\]\\(x\\) as text',
      '[All files of this release](https://github.com/someone/Lody/releases/tag/lan-latest)'
    ].join('\n\n')
  )
  assert.ok(notes.zh_CN.startsWith('版本 `0.100.0-lan.5`，提交 `01234567`。'))
  assert.ok(notes.zh_CN.includes('- feat: update the machines of a LAN'))
})

void test('the notes of a build without known changes name the build alone', () => {
  const notes = composeLanReleaseNotes({
    source,
    version: '0.100.0-lan.5',
    commit: '0123456789abcdef',
    changes: []
  })
  assert.equal(
    notes.en,
    'Build `0.100.0-lan.5` of commit `01234567`.\n\n' +
      '[All files of this release](https://github.com/someone/Lody/releases/tag/lan-latest)'
  )
})

void test('the notes of a build with many changes say how many they leave out', () => {
  const changes = Array.from({ length: 34 }, (_, index) => `fix: number ${index}`)
  const notes = composeLanReleaseNotes({
    source,
    version: '0.100.0-lan.5',
    commit: '0123456789abcdef',
    changes
  })
  assert.ok(notes.en.includes('- fix: number 29\n- … and 4 more'))
  assert.ok(!notes.en.includes('fix: number 30'))
})
