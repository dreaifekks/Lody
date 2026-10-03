import assert from 'node:assert/strict'
import test from 'node:test'
import { readGitHubToken } from './github-token-source.ts'

const HOME = { id: 'a'.repeat(32), url: 'http://home.invalid', token: 'home-token' }
const OFFICE = { id: 'b'.repeat(32), url: 'http://office.invalid', token: 'office-token' }

/** Each hub answers as `answers` says: a token, none (404), or nothing at all. */
function hubs(answers) {
  return async (input) => {
    const answer = answers[new URL(String(input)).host]
    if (answer === 'away') throw new TypeError('fetch failed')
    if (answer === 'none')
      return new Response(JSON.stringify({ error: 'not_configured' }), { status: 404 })
    return new Response(JSON.stringify({ token: answer, login: 'o', userId: '7' }), { status: 200 })
  }
}

const copies = (entries) => (hubId) => entries[hubId] ?? null
const ghLogin = async () => ({ ok: true, token: 'gho_machine' })

void test('prefers the token a host gives over the copy and the gh login', async () => {
  const result = await readGitHubToken([HOME], {
    fetch: hubs({ 'home.invalid': 'github_pat_hub' }),
    readCopy: copies({ [HOME.id]: { token: 'github_pat_copy' } }),
    readGhLogin: ghLogin
  })
  assert.deepEqual(result, { ok: true, token: 'github_pat_hub' })
})

void test('stands in with the copy of a host that is away', async () => {
  const result = await readGitHubToken([HOME], {
    fetch: hubs({ 'home.invalid': 'away' }),
    readCopy: copies({ [HOME.id]: { token: 'github_pat_copy' } }),
    readGhLogin: ghLogin
  })
  assert.deepEqual(result, { ok: true, token: 'github_pat_copy' })
})

void test('ignores the copy of a host that says it keeps no token', async () => {
  const result = await readGitHubToken([HOME, OFFICE], {
    fetch: hubs({ 'home.invalid': 'none', 'office.invalid': 'away' }),
    readCopy: copies({ [HOME.id]: { token: 'github_pat_removed' } }),
    readGhLogin: ghLogin
  })
  assert.deepEqual(result, { ok: true, token: 'gho_machine' })
})
