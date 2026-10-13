import assert from 'node:assert/strict'
import test from 'node:test'
import net from 'node:net'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AgentFileRefusal,
  MemberFileResources,
  openAgentFileRange,
  saveAgentFile
} from './member-file-resource.ts'

const target = { workspaceId: 'lw_home', machineId: 'devbox', sessionId: 's1', path: 'out/a.mp4' }

/**
 * The local file socket of an agent service that has one file. `cutAfter`
 * ends an answer after that many bytes of the part it announced, once.
 */
async function agentService(t, file, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'lody-agent-files-'))
  const socketPath = join(dir, 'files.sock')
  const requests = []
  let cutAfter = options.cutAfter
  const state = { revision: 'r1', file }
  const server = net.createServer((socket) => {
    socket.on('error', () => {})
    socket.once('data', (data) => {
      const request = JSON.parse(data.toString('utf8'))
      requests.push(request)
      const refusal =
        request.path !== target.path
          ? { code: 'path_not_allowed', message: 'path_not_allowed:File is outside the workspace' }
          : request.revision && request.revision !== state.revision
            ? { code: 'file_changed', message: 'file_changed:the file changed' }
            : null
      if (refusal) {
        socket.end(`${JSON.stringify({ type: 'error', ...refusal })}\n`)
        return
      }
      const end = Math.min(
        state.file.length,
        request.offset + (request.length ?? state.file.length)
      )
      const part = state.file.subarray(request.offset, end)
      socket.write(
        `${JSON.stringify({ type: 'range', sizeBytes: state.file.length, length: part.length, revision: state.revision })}\n`
      )
      if (cutAfter !== undefined && part.length > cutAfter) {
        const sent = part.subarray(0, cutAfter)
        cutAfter = undefined
        socket.end(sent)
        return
      }
      socket.end(part)
    })
  })
  await new Promise((resolve) => server.listen(socketPath, resolve))
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  })
  const open = (asked, range, signal) => openAgentFileRange(socketPath, asked, range, signal)
  return { dir, open, requests, state }
}

const bytesOf = async (body) => Buffer.from(await new Response(body).arrayBuffer())
const pattern = (size) => Buffer.from(Array.from({ length: size }, (_, index) => index % 251))

void test('a part of a file arrives as the agent service announced it', async (t) => {
  const file = pattern(300_000)
  const { open, requests } = await agentService(t, file)

  const part = await open(target, { offset: 1000, length: 200_000 })

  assert.equal(part.sizeBytes, file.length)
  assert.equal(part.revision, 'r1')
  assert.deepEqual(await bytesOf(part.body), file.subarray(1000, 201_000))
  await part.closed
  assert.deepEqual(requests[0], { type: 'range', ...target, offset: 1000, length: 200_000 })
})

void test('a refusal carries its code, and a part that ends early fails instead of ending', async (t) => {
  const { open } = await agentService(t, pattern(100_000), { cutAfter: 40_000 })

  await assert.rejects(
    open({ ...target, path: '/etc/passwd' }, { offset: 0 }),
    (error) => error instanceof AgentFileRefusal && error.code === 'path_not_allowed'
  )
  const cut = await open(target, { offset: 0 })
  await assert.rejects(bytesOf(cut.body), /could not be read to its end/)
})

void test('no agent service means no part, not a hang', async () => {
  await assert.rejects(
    openAgentFileRange(join(tmpdir(), 'lody-no-agent-service.sock'), target, { offset: 0 })
  )
})

void test('a file is saved whole, resuming a part that broke off from where it stopped', async (t) => {
  const file = pattern(500_000)
  const { dir, open, requests } = await agentService(t, file, { cutAfter: 120_000 })
  const destination = join(dir, 'saved.mp4')
  await writeFile(destination, 'what was there before')

  await saveAgentFile(open, target, destination)

  assert.deepEqual(await readFile(destination), file)
  assert.deepEqual(
    requests.map(({ offset, revision }) => ({ offset, revision })),
    [
      { offset: 0, revision: undefined },
      { offset: 120_000, revision: 'r1' }
    ]
  )
  assert.deepEqual((await readdir(dir)).sort(), ['files.sock', 'saved.mp4'])
})

void test('a file that changes while it is saved leaves what was there before', async (t) => {
  const { dir, open, state } = await agentService(t, pattern(500_000), { cutAfter: 120_000 })
  const destination = join(dir, 'saved.mp4')
  await writeFile(destination, 'what was there before')
  const changing = async (asked, range, signal) => {
    if (range.offset > 0) state.revision = 'r2'
    return await open(asked, range, signal)
  }

  await assert.rejects(
    saveAgentFile(changing, target, destination),
    (error) => error instanceof AgentFileRefusal && error.code === 'file_changed'
  )

  assert.equal(await readFile(destination, 'utf8'), 'what was there before')
  assert.deepEqual((await readdir(dir)).sort(), ['files.sock', 'saved.mp4'])
})

void test('a member resource answers ranges, as a player asks for them', async (t) => {
  const file = pattern(300_000)
  const { open, requests } = await agentService(t, file)
  const resources = new MemberFileResources(open)

  const { url, sizeBytes } = await resources.member(1, target, 'video/mp4')

  assert.match(url, /^lody-resource:\/\/member\/[0-9a-f-]{36}$/)
  assert.equal(sizeBytes, file.length)
  const head = await resources.respond(new Request(url, { headers: { Range: 'bytes=0-' } }))
  assert.equal(head.status, 206)
  assert.equal(head.headers.get('Content-Type'), 'video/mp4')
  assert.equal(head.headers.get('Accept-Ranges'), 'bytes')
  assert.equal(head.headers.get('Content-Range'), `bytes 0-${file.length - 1}/${file.length}`)
  assert.deepEqual(await bytesOf(head.body), file)
  const seek = await resources.respond(new Request(url, { headers: { Range: 'bytes=250000-' } }))
  assert.equal(seek.headers.get('Content-Length'), '50000')
  assert.deepEqual(await bytesOf(seek.body), file.subarray(250_000))
  const whole = await resources.respond(new Request(url))
  assert.equal(whole.status, 200)
  assert.deepEqual(await bytesOf(whole.body), file)
  // Every part after the first names the content the resource was opened on.
  assert.deepEqual(
    requests.slice(1).map(({ offset, length, revision }) => ({ offset, length, revision })),
    [
      { offset: 0, length: file.length, revision: 'r1' },
      { offset: 250_000, length: 50_000, revision: 'r1' },
      { offset: 0, length: file.length, revision: 'r1' }
    ]
  )
  for (const range of ['bytes=300000-', 'bytes=5-2', 'bytes=-500', 'lines=1-2']) {
    const refused = await resources.respond(new Request(url, { headers: { Range: range } }))
    assert.equal(refused.status, 416, range)
  }
  assert.equal((await resources.respond(new Request(url, { method: 'POST' }))).status, 405)
})

void test('a member resource ends with its owner, and says when its file changed', async (t) => {
  const { open, state } = await agentService(t, pattern(100_000))
  const resources = new MemberFileResources(open)
  const first = await resources.member(1, target, 'video/mp4')
  const again = await resources.member(1, target, 'video/mp4')
  const other = await resources.member(2, target, 'video/mp4')

  assert.equal(again.url, first.url)
  assert.notEqual(other.url, first.url)
  await assert.rejects(resources.member(1, { ...target, path: '/etc/passwd' }, 'video/mp4'))

  resources.releaseOwner(1)
  assert.equal((await resources.respond(new Request(first.url))).status, 404)
  state.revision = 'r2'
  const changed = await resources.respond(new Request(other.url))
  assert.equal(changed.status, 409)
  assert.equal(await changed.text(), 'File changed. Reopen the preview.')
  assert.equal((await resources.respond(new Request('lody-resource://member/unknown'))).status, 404)
  assert.equal((await resources.respond(new Request('lody-resource://file/unknown'))).status, 404)
})

void test('a player that stops reading a part closes its connection', async (t) => {
  const { open } = await agentService(t, Buffer.alloc(8 * 1024 * 1024, 7))
  const resources = new MemberFileResources(open)
  const { url } = await resources.member(1, target, 'video/mp4')
  const player = new AbortController()

  const response = await resources.respond(new Request(url, { signal: player.signal }))
  const reader = response.body.getReader()
  assert.ok((await reader.read()).value.length > 0)
  player.abort()

  await assert.rejects(async () => {
    for (;;) if ((await reader.read()).done) return
  })
})
