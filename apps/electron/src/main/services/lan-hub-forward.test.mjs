import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import test from 'node:test'
import { createLanHubRequestHandler } from './lan-hub-forward.ts'

const HOME = 'a'.repeat(32)
const OFFICE = 'b'.repeat(32)

/** A hub that answers with what it received, so a test sees what crossed the bridge. */
async function startHub(t, name) {
  const liveReads = new Set()
  const received = []
  let liveReadClosed = () => {}
  const server = http.createServer((request, response) => {
    received.push(request.url)
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      if (request.url.includes('live=sse')) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.write('event: data\ndata: first\n\n')
        liveReads.add(response)
        response.once('close', () => {
          liveReads.delete(response)
          liveReadClosed()
        })
        return
      }
      response.writeHead(request.method === 'DELETE' ? 204 : 200, {
        'Content-Type': 'application/json',
        'Stream-Next-Offset': '7',
        'Access-Control-Allow-Origin': 'http://hub.invalid',
        Vary: 'Origin'
      })
      response.end(
        request.method === 'DELETE'
          ? undefined
          : JSON.stringify({
              hub: name,
              method: request.method,
              url: request.url,
              headers: request.headers,
              body: Buffer.concat(chunks).toString()
            })
      )
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(resolve)
      })
  )
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    liveReads,
    received,
    whenLiveReadCloses: () => new Promise((resolve) => (liveReadClosed = resolve))
  }
}

async function bridge(t) {
  const home = await startHub(t, 'home')
  const office = await startHub(t, 'office')
  const lans = new Map([
    [HOME, { url: home.url, token: 'home-token' }],
    [OFFICE, { url: office.url, token: 'office-token' }]
  ])
  return { home, office, lans, handle: createLanHubRequestHandler((id) => lans.get(id) ?? null) }
}

void test('reaches each LAN at its own address with its own credential', async (t) => {
  const { handle } = await bridge(t)

  const home = await (
    await handle(new Request(`lody-hub://${HOME}/ds/lody/room%3Ameta?offset=-1`))
  ).json()
  const office = await (
    await handle(new Request(`lody-hub://${OFFICE}/ds/lody/room%3Ameta`))
  ).json()

  assert.equal(home.hub, 'home')
  assert.equal(home.url, '/ds/lody/room%3Ameta?offset=-1')
  assert.equal(home.headers.authorization, 'Bearer home-token')
  assert.equal(office.hub, 'office')
  assert.equal(office.headers.authorization, 'Bearer office-token')
})

void test('replaces what the renderer sent as credential and origin', async (t) => {
  const { handle } = await bridge(t)

  const response = await handle(
    new Request(`lody-hub://${HOME}/ds/lody/room`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer lan-hub',
        Origin: 'file://',
        'Content-Type': 'application/octet-stream',
        'Stream-Seq': '3'
      },
      body: 'payload'
    })
  )
  const seen = await response.json()

  assert.equal(seen.headers.authorization, 'Bearer home-token')
  assert.equal(seen.headers.origin, undefined)
  assert.equal(seen.headers['stream-seq'], '3')
  assert.equal(seen.body, 'payload')
  assert.equal(response.headers.get('stream-next-offset'), '7')
  // The bridge states the renderer's CORS policy, not the hub.
  assert.equal(response.headers.get('access-control-allow-origin'), '*')
  assert.equal(response.headers.get('vary'), null)
})

void test('follows a LAN that is joined, moved or left while it runs', async (t) => {
  const { handle, lans, office } = await bridge(t)
  const request = () => new Request(`lody-hub://${HOME}/ds/lody/room`)

  lans.set(HOME, { url: office.url, token: 'moved-token' })
  const moved = await (await handle(request())).json()
  assert.equal(moved.hub, 'office')
  assert.equal(moved.headers.authorization, 'Bearer moved-token')

  lans.delete(HOME)
  const left = await handle(request())
  assert.equal(left.status, 404)
  assert.deepEqual(await left.json(), { error: 'unknown LAN' })
})

void test('never sends the credential to a host a path names', async (t) => {
  const { handle, office } = await bridge(t)
  const elsewhere = new URL(office.url).host

  for (const path of [`//${elsewhere}/ds/lody/room`, `/\\${elsewhere}/ds/lody/room`]) {
    const response = await handle(new Request(`lody-hub://${HOME}${path}`))
    assert.notEqual(response.status, 200, path)
  }
  assert.deepEqual(office.received, [])
})

void test('keeps every route but the documents from the renderer', async (t) => {
  const { handle, home } = await bridge(t)

  for (const path of [
    '/lan/snapshot',
    '/lan/credentials',
    '/github/token',
    '/push/devices',
    '/ds/../lan/snapshot',
    '/ds/%2e%2e/lan/credentials',
    '/ds',
    '/api/time'
  ]) {
    const response = await handle(new Request(`lody-hub://${HOME}${path}`, { method: 'POST' }))
    assert.equal(response.status, 403, path)
  }
  assert.deepEqual(home.received, [])
})

void test('lets the renderer read the clock of its LAN', async (t) => {
  const { handle } = await bridge(t)

  const response = await handle(new Request(`lody-hub://${HOME}/api/time`))
  const received = await response.json()

  assert.equal(response.status, 200)
  assert.equal(received.url, '/api/time')
  assert.equal(received.headers.authorization, 'Bearer home-token')
})

void test('never forwards a request for a LAN that is not joined', async (t) => {
  const { handle } = await bridge(t)
  for (const url of [`lody-hub://hub/ds/lody/room`, `lody-hub://${'c'.repeat(32)}/ds/lody/room`]) {
    assert.equal((await handle(new Request(url))).status, 404)
  }
})

void test('answers a preflight itself and passes an empty answer through', async (t) => {
  const { handle } = await bridge(t)

  const preflight = await handle(
    new Request(`lody-hub://${HOME}/ds/lody/room`, {
      method: 'OPTIONS',
      headers: { 'Access-Control-Request-Headers': 'authorization,stream-seq' }
    })
  )
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'authorization,stream-seq')

  const removed = await handle(new Request(`lody-hub://${HOME}/ds/lody/room`, { method: 'DELETE' }))
  assert.equal(removed.status, 204)
  assert.equal(removed.body, null)
})

void test('reports a LAN that cannot be reached', async (t) => {
  const { handle, lans } = await bridge(t)
  // Nothing listens on the discard port of loopback.
  lans.set(HOME, { url: 'http://127.0.0.1:9', token: 'home-token' })

  const response = await handle(new Request(`lody-hub://${HOME}/ds/lody/room`))

  assert.equal(response.status, 502)
  assert.deepEqual(await response.json(), { error: 'LAN is unreachable' })
})

void test('repeats a request the hub never read because it closed the idle connection', async (t) => {
  // The first connection answers once and is then closed by the hub as idle,
  // just as the next request arrives on it; later connections answer.
  let connections = 0
  const sockets = new Set()
  const server = net.createServer((socket) => {
    connections += 1
    sockets.add(socket)
    const closeWhenIdle = connections === 1
    let answered = 0
    socket.on('data', () => {
      if (closeWhenIdle && answered === 1) {
        socket.destroy()
        return
      }
      answered += 1
      socket.write(
        'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{"ok":true}'
      )
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(
    () =>
      new Promise((resolve) => {
        // The bridge keeps its connection for the next request.
        for (const socket of sockets) socket.destroy()
        server.close(resolve)
      })
  )
  const handle = createLanHubRequestHandler(() => ({
    url: `http://127.0.0.1:${server.address().port}`,
    token: 'home-token'
  }))

  const first = await handle(new Request(`lody-hub://${HOME}/ds/lody/room`))
  assert.deepEqual(await first.json(), { ok: true })
  const second = await handle(new Request(`lody-hub://${HOME}/ds/lody/room`))

  assert.equal(second.status, 200)
  assert.deepEqual(await second.json(), { ok: true })
  assert.equal(connections, 2)
})

void test('releases the subscription of a live read the renderer left', async (t) => {
  const { handle, home } = await bridge(t)
  const controller = new AbortController()

  const response = await handle(
    new Request(`lody-hub://${HOME}/ds/lody/room?live=sse`, { signal: controller.signal })
  )
  const reader = response.body.getReader()
  const first = await reader.read()
  assert.equal(new TextDecoder().decode(first.value), 'event: data\ndata: first\n\n')
  assert.equal(home.liveReads.size, 1)

  const closed = home.whenLiveReadCloses()
  await reader.cancel()
  await closed

  assert.equal(home.liveReads.size, 0)
})
