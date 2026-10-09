import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readFollowedLanRelease, writeFollowedLanRelease } from './lan-updater-follow.ts'

const stamp = { repository: 'someone/Lody', tag: 'lan-dev', commit: 'abcdef1' }

function dataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-follow-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

void test('the first start follows the stamp and records it', (t) => {
  const dir = dataDir(t)
  assert.deepEqual(readFollowedLanRelease(stamp, dir), stamp)
  // A later build, stamped for the other release, goes on following this one.
  assert.deepEqual(readFollowedLanRelease({ ...stamp, tag: 'lan-latest' }, dir), stamp)
})

void test('an installation follows the release it switched to', (t) => {
  const dir = dataDir(t)
  readFollowedLanRelease(stamp, dir)
  writeFollowedLanRelease(dir, 'lan-latest')
  assert.deepEqual(readFollowedLanRelease(stamp, dir), { ...stamp, tag: 'lan-latest' })
})

void test('a record of no release of the fork gives way to the stamp', (t) => {
  const dir = dataDir(t)
  fs.writeFileSync(path.join(dir, 'lan-release.json'), '{"tag":"nightly"}\n')
  assert.deepEqual(readFollowedLanRelease(stamp, dir), stamp)
  assert.deepEqual(readFollowedLanRelease({ ...stamp, tag: 'lan-latest' }, dir), stamp)
})
