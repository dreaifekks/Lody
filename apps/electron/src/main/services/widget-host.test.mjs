import assert from 'node:assert/strict'
import test from 'node:test'
import { createWidgetHostServer } from './widget-host.ts'

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
