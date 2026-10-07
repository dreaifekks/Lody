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
/** The page's URL once the server listens; navigation guards compare against it. */
let startedUrl: string | null = null

export function getStartedWidgetHostUrl(): string | null {
  return startedUrl
}

const originOf = (url: string): string | null => {
  try {
    const origin = new URL(url).origin
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}

const isShellUrl = (url: string, shellUrl: string): boolean => {
  try {
    const target = new URL(url)
    const shell = new URL(shellUrl)
    return (
      target.origin === shell.origin && target.pathname === shell.pathname && target.search === ''
    )
  } catch {
    return false
  }
}

/**
 * Whether a frame navigation (or redirect) must be stopped. A widget frame is
 * sandboxed but may still navigate itself; `index.html` frames any loopback
 * port and the page's own policy governs only frames it embeds, so this is the
 * one place that keeps a widget on its page. Every navigation that leaves the
 * page's origin, or enters it, must land exactly on the page.
 */
export function isBlockedWidgetFrameNavigation(input: {
  /** The frame's current URL, before the navigation. */
  currentUrl: string
  targetUrl: string
  shellUrl: string | null
}): boolean {
  if (!input.shellUrl) return false
  const shellOrigin = originOf(input.shellUrl)
  const governed =
    originOf(input.currentUrl) === shellOrigin || originOf(input.targetUrl) === shellOrigin
  return governed && !isShellUrl(input.targetUrl, input.shellUrl)
}

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
      startedUrl = `http://127.0.0.1:${address.port}${LODY_WIDGET_SHELL_PATH}`
      resolve(startedUrl)
    })
  })
  return started
}
