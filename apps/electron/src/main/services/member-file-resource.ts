import { randomUUID } from 'node:crypto'
import net from 'node:net'
import { open, rename, rm } from 'node:fs/promises'
import { LanFileRangeAnswerSchema, type LocalFileRangeRequest } from '@lody/shared/lan-file-range'

/**
 * A file the desktop cannot open itself: a block a session keeps, or a file at
 * a path of another machine of a LAN. The agent service of this machine reads
 * it, in the parts asked for, over its local file socket; the credential of the
 * LAN stays there.
 */
export type AgentFileTarget = Pick<
  LocalFileRangeRequest,
  'workspaceId' | 'machineId' | 'sessionId' | 'fileId' | 'path' | 'boardId'
>

export type AgentFileRange = {
  /** The size of the whole file. */
  sizeBytes: number
  /** What identifies the content these bytes are from. */
  revision: string
  /** The bytes asked for. It fails when the file cannot be read to there. */
  body: ReadableStream<Uint8Array>
  /** Settles once the connection that carries the bytes is gone. */
  closed: Promise<void>
}

export type AgentFileRangeOpener = (
  target: AgentFileTarget,
  range: { offset: number; length?: number; revision?: string },
  signal?: AbortSignal
) => Promise<AgentFileRange>

/** The agent service, or the machine that has the file, gives no such part. */
export class AgentFileRefusal extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

const ANSWER_MAX_BYTES = 64 * 1024

/** Asks the agent service for part of a file; one connection carries one part. */
export async function openAgentFileRange(
  socketPath: string,
  target: AgentFileTarget,
  range: { offset: number; length?: number; revision?: string },
  signal?: AbortSignal
): Promise<AgentFileRange> {
  const socket = net.connect(socketPath)
  // Whatever reads the connection reports its failure.
  socket.on('error', () => {})
  const abort = () => socket.destroy()
  signal?.addEventListener('abort', abort, { once: true })
  const closed = new Promise<void>((resolve) => {
    socket.once('close', () => {
      signal?.removeEventListener('abort', abort)
      resolve()
    })
  })
  if (signal?.aborted) socket.destroy()
  const chunks = (socket as AsyncIterable<Buffer>)[Symbol.asyncIterator]()
  try {
    socket.write(`${JSON.stringify({ type: 'range', ...target, ...range })}\n`)
    let received: Buffer = Buffer.alloc(0)
    let newline = -1
    while ((newline = received.indexOf(0x0a)) < 0) {
      if (received.length > ANSWER_MAX_BYTES) throw new Error('The local agent sent no answer.')
      const next = await chunks.next()
      if (next.done) throw new Error('The local agent closed the connection.')
      received = Buffer.concat([received, next.value])
    }
    const answer = LanFileRangeAnswerSchema.parse(
      JSON.parse(received.subarray(0, newline).toString('utf8'))
    )
    if (answer.type === 'error') throw new AgentFileRefusal(answer.code, answer.message)

    let buffered = received.subarray(newline + 1)
    let remaining = answer.length
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (remaining > 0 && buffered.length === 0) {
            const next = await chunks.next()
            if (next.done) throw new Error('The file could not be read to its end.')
            buffered = next.value
          }
          const chunk = buffered.subarray(0, remaining)
          buffered = buffered.subarray(chunk.length)
          remaining -= chunk.length
          if (chunk.length > 0) controller.enqueue(chunk)
          if (remaining === 0) {
            socket.destroy()
            controller.close()
          }
        } catch (error) {
          socket.destroy()
          controller.error(error)
        }
      },
      cancel() {
        socket.destroy()
      }
    })
    return { sizeBytes: answer.sizeBytes, revision: answer.revision, body, closed }
  } catch (error) {
    socket.destroy()
    throw error
  }
}

/**
 * Writes a whole file to `destinationPath`, part after part, so no size is too
 * large for it. A part that breaks off is asked for again from where it
 * stopped, as long as each attempt brought bytes; the file appears under its
 * name only once it is complete.
 */
export async function saveAgentFile(
  openRange: AgentFileRangeOpener,
  target: AgentFileTarget,
  destinationPath: string
): Promise<void> {
  // A name of this download's own, created here: a file that happens to lie
  // beside the destination is neither written over nor removed.
  const partPath = `${destinationPath}.${randomUUID()}.part`
  const handle = await open(partPath, 'wx')
  let complete = false
  try {
    let written = 0
    let revision: string | undefined
    for (;;) {
      const range = await openRange(target, { offset: written, ...(revision ? { revision } : {}) })
      revision = range.revision
      const before = written
      const reader = range.body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          // A write may take fewer bytes than it was given.
          for (let offset = 0; offset < value.length;) {
            const { bytesWritten } = await handle.write(value, offset)
            offset += bytesWritten
            written += bytesWritten
          }
        }
        break
      } catch (error) {
        if (written === before) throw error
      }
    }
    complete = true
  } finally {
    await handle.close()
    if (complete) await rename(partPath, destinationPath)
    else await rm(partPath, { force: true })
  }
}

type MemberResource = {
  owner: number
  key: string
  target: AgentFileTarget
  revision: string
  size: number
  mime: string
  readers: Set<AbortController>
}

/**
 * Resource URLs for files the desktop cannot open itself, beside those
 * `local-file-resource.ts` issues for the files of this machine:
 * `lody-resource://member/<token>` stands for a block a session keeps or a
 * file of another machine of a LAN. A Range request becomes a ranged read of
 * the agent service, so a video seeks and nothing is held whole. The
 * capabilities are as opaque and as short-lived as the local ones.
 */
export class MemberFileResources {
  private readonly members = new Map<string, MemberResource>()
  private readonly openRange: AgentFileRangeOpener

  constructor(openRange: AgentFileRangeOpener) {
    this.openRange = openRange
  }

  releaseOwner(owner: number) {
    for (const [token, resource] of this.members)
      if (resource.owner === owner) this.revokeMember(token, resource)
  }

  private revokeMember(token: string, resource: MemberResource) {
    this.members.delete(token)
    for (const reader of resource.readers) reader.abort()
  }

  /** Asks for the size of the file, which also tells whether it can be read at all. */
  async member(owner: number, target: AgentFileTarget, mime: string) {
    const { sizeBytes, revision } = await this.openRange(target, { offset: 0, length: 0 })
    const key = JSON.stringify([
      target.workspaceId,
      target.machineId,
      target.sessionId,
      target.fileId ?? null,
      target.path ?? null,
      target.boardId ?? null,
      revision,
      mime
    ])
    // Reopening the same content reuses its capability; registrations are bounded per renderer.
    let token = [...this.members].find(([, r]) => r.owner === owner && r.key === key)?.[0]
    if (!token) {
      const owned = [...this.members].filter(([, r]) => r.owner === owner)
      if (owned.length >= 256) this.revokeMember(owned[0][0], owned[0][1])
      token = randomUUID()
      this.members.set(token, {
        owner,
        key,
        target,
        revision,
        size: sizeBytes,
        mime,
        readers: new Set()
      })
    }
    return { url: `lody-resource://member/${token}`, sizeBytes }
  }

  async respond(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const resource = url.hostname === 'member' ? this.members.get(url.pathname.slice(1)) : undefined
    if (!resource) return new Response(null, { status: 404 })
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return new Response(null, { status: 405 })
    const range = request.headers.get('Range')
    const match = range?.match(/^bytes=(\d+)-(\d*)$/u)
    const start = match ? Number(match[1]) : 0
    let end = match && match[2] ? Number(match[2]) : resource.size - 1
    if (
      (range && !match) ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start >= resource.size ||
      end < start
    ) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${resource.size}` }
      })
    }
    end = Math.min(end, resource.size - 1)
    const headers = {
      'Content-Type': resource.mime,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      // Opaque unguessable capability; never a path, a machine or a session.
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Range',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${resource.size}` } : {})
    }
    const status = range ? 206 : 200
    if (request.method === 'HEAD') return new Response(null, { headers, status })

    const reader = new AbortController()
    const abort = () => reader.abort()
    request.signal.addEventListener('abort', abort, { once: true })
    resource.readers.add(reader)
    const release = () => {
      resource.readers.delete(reader)
      request.signal.removeEventListener('abort', abort)
    }
    try {
      if (request.signal.aborted) throw new Error('Preview cancelled.')
      const part = await this.openRange(
        resource.target,
        { offset: start, length: end - start + 1, revision: resource.revision },
        reader.signal
      )
      void part.closed.then(release)
      return new Response(part.body, { status, headers })
    } catch (error) {
      release()
      return error instanceof AgentFileRefusal && error.code === 'file_changed'
        ? new Response('File changed. Reopen the preview.', { status: 409 })
        : new Response(error instanceof Error ? error.message : 'Preview unavailable.', {
            status: 503
          })
    }
  }
}
