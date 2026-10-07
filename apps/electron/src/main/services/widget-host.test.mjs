import assert from 'node:assert/strict'
import test from 'node:test'
import { createWidgetHostServer, isBlockedWidgetFrameNavigation } from './widget-host.ts'

const listen = (server) =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })

void test('serves only the widget page, under its own policy', async (t) => {
  const server = createWidgetHostServer()
  const port = await listen(server)
  t.after(() => server.close())
  const base = `http://127.0.0.1:${port}`

  const page = await fetch(`${base}/widget`)
  assert.equal(page.status, 200)
  const policy = page.headers.get('content-security-policy') ?? ''
  assert.match(policy, /default-src 'none'/)
  assert.match(policy, /script-src 'unsafe-inline' https:\/\/cdnjs\.cloudflare\.com/)
  // Nothing local is reachable from a widget.
  assert.doesNotMatch(policy, /127\.0\.0\.1|localhost|'self'/)
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff')
  const html = await page.text()
  assert.match(html, /lody-widget:ready/)

  assert.equal((await fetch(`${base}/`)).status, 404)
  assert.equal((await fetch(`${base}/widget/../etc/passwd`)).status, 404)
  assert.equal((await fetch(`${base}/widget`, { method: 'POST', body: 'x' })).status, 404)
})

void test('keeps a widget frame on its page', () => {
  const shellUrl = 'http://127.0.0.1:41234/widget'
  const blocked = (currentUrl, targetUrl, shell = shellUrl) =>
    isBlockedWidgetFrameNavigation({ currentUrl, targetUrl, shellUrl: shell })

  // Loading the page, or reloading it, is the only way in.
  assert.equal(blocked('about:blank', shellUrl), false)
  assert.equal(blocked(shellUrl, shellUrl), false)
  assert.equal(blocked(shellUrl, `${shellUrl}#section`), false)

  // From the page: another local port, another path, another scheme.
  assert.equal(blocked(shellUrl, 'http://127.0.0.1:3000/admin'), true)
  assert.equal(blocked(shellUrl, 'http://localhost:41234/widget'), true)
  assert.equal(blocked(shellUrl, 'http://127.0.0.1:41234/'), true)
  assert.equal(blocked(shellUrl, 'http://127.0.0.1:41234/widget?x=1'), true)
  assert.equal(blocked(shellUrl, 'https://example.com/'), true)
  assert.equal(blocked(shellUrl, 'file:///etc/passwd'), true)
  assert.equal(blocked(shellUrl, 'data:text/html,hi'), true)
  assert.equal(blocked(shellUrl, 'about:blank'), true)
  // A frame moved off-path on the page's origin is still the widget's.
  assert.equal(blocked('http://127.0.0.1:41234/elsewhere', 'http://127.0.0.1:9/'), true)
  // Into the page's origin, only the page itself.
  assert.equal(blocked('about:blank', 'http://127.0.0.1:41234/other'), true)

  // Other frames of the app are not the widget guard's business.
  assert.equal(blocked('http://localhost:5173/preview', 'http://localhost:5173/other'), false)
  assert.equal(blocked('about:blank', 'http://127.0.0.1:3000/'), false)
  // Before the host starts there is no widget to keep.
  assert.equal(blocked(shellUrl, 'http://127.0.0.1:3000/', null), false)
})
