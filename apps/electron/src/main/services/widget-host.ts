import http from 'node:http'
import {
  LODY_WIDGET_SHELL_CONTENT_SECURITY_POLICY,
  LODY_WIDGET_SHELL_PATH,
  buildLodyWidgetShellHtml
} from '@lody/shared/lody-widget-shell'

/**
 * Serves the page that hosts agent-written widgets, from its own loopback
 * origin. The renderer's policy already frames `http://127.0.0.1:*`, so no
 * change to `index.html` is needed; the page is framed with
 * `sandbox="allow-scripts"`, which gives it an opaque origin besides, and it
 * carries its own policy (inline script plus a few CDNs, nothing local).
 *
 * The page is constant and holds no widget content or credential: the
 * conversation posts the code into it. Anything else answers 404.
 */
export function createWidgetHostServer(): http.Server {
  const html = buildLodyWidgetShellHtml()
  return http.createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (request.method !== 'GET' || pathname !== LODY_WIDGET_SHELL_PATH) {
      response.writeHead(404, { 'Content-Type': 'text/plain' }).end()
      return
    }
    response
      .writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': LODY_WIDGET_SHELL_CONTENT_SECURITY_POLICY,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-store'
      })
      .end(html)
  })
}

let started: Promise<string> | null = null

/** The page's URL, starting the server on first use. */
export function getWidgetHostUrl(): Promise<string> {
  started ??= new Promise<string>((resolve, reject) => {
    const server = createWidgetHostServer()
    server.once('error', (error) => {
      started = null
      reject(error)
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        started = null
        reject(new Error('Widget host did not bind a TCP port'))
        return
      }
      // Never keeps the app alive on quit.
      server.unref()
      resolve(`http://127.0.0.1:${address.port}${LODY_WIDGET_SHELL_PATH}`)
    })
  })
  return started
}
