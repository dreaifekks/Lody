import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getIpcContext, IpcMethod, IpcService } from 'electron-ipc-decorator'
import {
  ElectronLanAddInputSchema,
  ElectronLanIdInputSchema,
  ElectronLanJoinInputSchema,
  ElectronLanMachineNameInputSchema,
  ElectronLanUpdateInputSchema,
  type ElectronLanFailure,
  type ElectronLanReachability,
  type ElectronLanResult,
  type ElectronLanState,
  type ElectronLanSummary
} from '@lody/shared/electron-ipc'
import { measureLanHubLatency, probeLanHub } from '@lody/shared/node/lan-hub'
import type { LanHubStore } from '@lody/shared/node/lan-hub-store'
import {
  LAN_SHARE_IMAGE_MAX_BYTES,
  LanShareIdSchema,
  LanShareImageKindSchema,
  LanShareSourceSchema
} from '@lody/shared/lan-share'
import type { LocalProjectControlResponse, WorkspaceId } from '@lody/shared'
import { z } from 'zod'
import { assertProductWindowSender } from '../assert-sender'
import { getIpcServiceDeps } from '../ipc-service-deps'
import { sendLocalProjectControl } from '../local-project-dispatch'

const UNAVAILABLE: ElectronLanFailure = {
  ok: false,
  code: 'unavailable',
  message: 'LANs are not available in this application'
}

const INVALID_INPUT: ElectronLanFailure = {
  ok: false,
  code: 'invalid_input',
  message: 'The request is not valid'
}

const BytesSchema = z.custom<ArrayBuffer | Uint8Array>(
  (value) => value instanceof ArrayBuffer || value instanceof Uint8Array
)

/** A frozen share package, as the window captured it. */
const PublishShareInputSchema = z
  .object({
    workspaceId: z.string().min(1),
    shareId: LanShareIdSchema.optional(),
    expectedRevision: z.number().int().positive().optional(),
    rootSourceId: z.string().min(1).max(256),
    sources: z.array(LanShareSourceSchema).min(1).max(64),
    manifest: BytesSchema,
    objects: z
      .array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), bytes: BytesSchema }))
      .max(1024)
  })
  .strict()

export type PublishLanShareInput = z.input<typeof PublishShareInputSchema>

/** An image of the LAN's share pages the window read, or `null` to use Lody's again. */
const ShareImageInputSchema = z
  .object({
    workspaceId: z.string().min(1),
    kind: LanShareImageKindSchema,
    bytes: BytesSchema.nullable()
  })
  .strict()
  .refine(
    (input) =>
      input.bytes === null || input.bytes.byteLength <= LAN_SHARE_IMAGE_MAX_BYTES[input.kind]
  )

/**
 * The LANs of this installation. A summary never carries a credential; only
 * `getInvite` hands one out, on an explicit request of a product window.
 */
export class LanIpc extends IpcService {
  static override readonly groupName = 'lan'

  @IpcMethod()
  async getState(): Promise<ElectronLanState | null> {
    return getIpcServiceDeps().lanHubStore?.getState() ?? null
  }

  @IpcMethod()
  async join(input: unknown): Promise<ElectronLanResult<{ lan: ElectronLanSummary }>> {
    return edit(ElectronLanJoinInputSchema.safeParse(input), (store, value) => store.join(value))
  }

  @IpcMethod()
  async add(input: unknown): Promise<ElectronLanResult<{ lan: ElectronLanSummary }>> {
    return edit(ElectronLanAddInputSchema.safeParse(input), (store, value) => store.add(value))
  }

  @IpcMethod()
  async update(input: unknown): Promise<ElectronLanResult<{ lan: ElectronLanSummary }>> {
    return edit(ElectronLanUpdateInputSchema.safeParse(input), (store, value) =>
      store.update(value)
    )
  }

  @IpcMethod()
  async remove(input: unknown): Promise<ElectronLanResult> {
    return edit(ElectronLanIdInputSchema.safeParse(input), (store, value) => store.remove(value))
  }

  @IpcMethod()
  async setMachineName(input: unknown): Promise<ElectronLanResult> {
    return edit(ElectronLanMachineNameInputSchema.safeParse(input), (store, value) =>
      store.setMachineName(value)
    )
  }

  @IpcMethod()
  async getInvite(input: unknown): Promise<{ ok: true; invite: string } | ElectronLanFailure> {
    assertProductWindowSender(getIpcContext().event)
    const store = getIpcServiceDeps().lanHubStore
    if (!store) return UNAVAILABLE
    const parsed = ElectronLanIdInputSchema.safeParse(input)
    return parsed.success ? store.getInvite(parsed.data) : INVALID_INPUT
  }

  @IpcMethod()
  async probe(input: unknown): Promise<ElectronLanReachability> {
    const parsed = ElectronLanIdInputSchema.safeParse(input)
    const hub = parsed.success ? getIpcServiceDeps().lanHubStore?.resolve(parsed.data.id) : null
    return hub ? await probeLanHub(hub) : 'unreachable'
  }

  /**
   * Hands a captured share to the agent service of this machine, which
   * uploads it to the LAN's hub with the credential the window never holds.
   * The package goes as files, as the files of a message do.
   */
  @IpcMethod()
  async publishShare(input: unknown): Promise<LocalProjectControlResponse> {
    assertProductWindowSender(getIpcContext().event)
    const parsed = PublishShareInputSchema.safeParse(input)
    if (!parsed.success) {
      return {
        ok: false,
        type: 'lan/share-publish',
        error: 'invalid_request',
        message: INVALID_INPUT.message
      }
    }
    const { manifest, objects, ...request } = parsed.data
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-lan-share-'))
    try {
      await fs.writeFile(path.join(directory, 'manifest.json'), toBuffer(manifest))
      await fs.mkdir(path.join(directory, 'objects'))
      for (const object of objects) {
        await fs.writeFile(path.join(directory, 'objects', object.id), toBuffer(object.bytes))
      }
      return await sendLocalProjectControl({
        ...request,
        type: 'lan/share-publish',
        workspaceId: request.workspaceId as WorkspaceId,
        directory
      })
    } finally {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /**
   * Hands an image of the share pages to the agent service of this machine,
   * which gives it to the LAN's hub; as a file, as a share package goes.
   */
  @IpcMethod()
  async setShareImage(input: unknown): Promise<LocalProjectControlResponse> {
    assertProductWindowSender(getIpcContext().event)
    const parsed = ShareImageInputSchema.safeParse(input)
    if (!parsed.success) {
      return {
        ok: false,
        type: 'lan/share-image',
        error: 'invalid_request',
        message: INVALID_INPUT.message
      }
    }
    const { workspaceId, kind, bytes } = parsed.data
    const request = {
      type: 'lan/share-image' as const,
      workspaceId: workspaceId as WorkspaceId,
      kind
    }
    if (bytes === null) return await sendLocalProjectControl({ ...request, path: null })
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-lan-share-image-'))
    try {
      const filePath = path.join(directory, kind)
      await fs.writeFile(filePath, toBuffer(bytes))
      return await sendLocalProjectControl({ ...request, path: filePath })
    } finally {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /** The hub's round trip in milliseconds, or `null` when it does not answer. */
  @IpcMethod()
  async latency(input: unknown): Promise<number | null> {
    const parsed = ElectronLanIdInputSchema.safeParse(input)
    const hub = parsed.success ? getIpcServiceDeps().lanHubStore?.resolve(parsed.data.id) : null
    return hub ? await measureLanHubLatency(hub) : null
  }
}

function edit<Input, Output>(
  parsed: { success: true; data: Input } | { success: false },
  apply: (store: LanHubStore, input: Input) => Output
): Output | ElectronLanFailure {
  assertProductWindowSender(getIpcContext().event)
  const store = getIpcServiceDeps().lanHubStore
  if (!store) return UNAVAILABLE
  return parsed.success ? apply(store, parsed.data) : INVALID_INPUT
}

function toBuffer(bytes: ArrayBuffer | Uint8Array): Buffer {
  return bytes instanceof ArrayBuffer
    ? Buffer.from(bytes)
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}
