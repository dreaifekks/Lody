import { protocol } from 'electron'
import http from 'node:http'
import https from 'node:https'
import { Readable } from 'node:stream'
import { LAN_HUB_SCHEME } from '@lody/shared/platform-kind'
import type { LanHubConfig } from '@lody/shared/node/lan-hub'

/**
 * Renderer access to the self-hosted Streams hub.
 *
 * The renderer addresses the hub as `lody-hub://hub`; this handler forwards
 * each request from the main process. That keeps the hub address and its
 * credential out of the renderer and its content security policy, and takes
 * live reads off Chromium's per-host connection budget: every joined room holds
 * one long-lived read, which a plain HTTP/1.1 hub would cap at six.
 */
export const LAN_HUB_SCHEME_PRIVILEGES = {
  scheme: LAN_HUB_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
    corsEnabled: true
  }
} as const

// Connection-scoped headers must not cross the proxy in either direction.
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])

// The renderer's origin and credential are local details of this bridge.
const RENDERER_ONLY_REQUEST_HEADERS = new Set(['authorization', 'host', 'origin', 'referer'])

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': '*'
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

const httpAgent = new http.Agent({ keepAlive: true })
const httpsAgent = new https.Agent({ keepAlive: true })

function preflightResponse(request: Request): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers':
        request.headers.get('access-control-request-headers') ?? 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400'
    }
  })
}

function errorResponse(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  })
}

function buildUpstreamHeaders(config: LanHubConfig, request: Request): Record<string, string> {
  const headers: Record<string, string> = {}
  request.headers.forEach((value, name) => {
    const key = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(key) || RENDERER_ONLY_REQUEST_HEADERS.has(key)) return
    headers[key] = value
  })
  headers.authorization = `Bearer ${config.token}`
  return headers
}

function buildRendererHeaders(response: http.IncomingMessage): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name)) continue
    // The hub answers its own CORS policy; this bridge owns the renderer's.
    if (name.startsWith('access-control-') || name === 'vary') continue
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item)
  }
  for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value)
  return headers
}

export async function forwardToLanHub(config: LanHubConfig, request: Request): Promise<Response> {
  if (request.method === 'OPTIONS') return preflightResponse(request)

  const source = new URL(request.url)
  const target = new URL(`${source.pathname}${source.search}`, config.url)
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  let body: Buffer | null = null
  try {
    body = hasBody ? Buffer.from(await request.arrayBuffer()) : null
  } catch {
    return errorResponse(400, 'unreadable request body')
  }

  return await new Promise<Response>((resolve) => {
    const secure = target.protocol === 'https:'
    const upstream = (secure ? https : http).request(
      target,
      {
        method: request.method,
        headers: buildUpstreamHeaders(config, request),
        agent: secure ? httpsAgent : httpAgent
      },
      (response) => {
        const status = response.statusCode ?? 502
        const headers = buildRendererHeaders(response)
        if (request.method === 'HEAD' || NULL_BODY_STATUSES.has(status)) {
          response.resume()
          resolve(new Response(null, { status, headers }))
          return
        }
        // Cancelling the returned stream destroys the upstream response, so a
        // live read the renderer leaves does not stay subscribed on the hub.
        resolve(
          new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, headers })
        )
      }
    )
    upstream.once('error', () => resolve(errorResponse(502, 'LAN hub is unreachable')))
    request.signal.addEventListener('abort', () => upstream.destroy(), { once: true })
    upstream.end(body ?? undefined)
  })
}

export function installLanHubProtocol(config: LanHubConfig): void {
  protocol.handle(LAN_HUB_SCHEME, (request) => forwardToLanHub(config, request))
}
