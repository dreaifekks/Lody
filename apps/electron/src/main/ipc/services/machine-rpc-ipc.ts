import { app, BrowserWindow, dialog, type WebContents } from 'electron'
import path from 'node:path'
import { z } from 'zod'
import {
  FilePreviewV3ErrorSchema,
  LocalMachineRpcRequestSchema
} from '@lody/shared/local-machine-rpc'
import { LocalFileResolutionSchema } from '@lody/shared/local-file-preview'
import { localFileResources } from '../../services/local-file-resource-protocol'
import {
  memberFileResources,
  openMemberFileRange
} from '../../services/member-file-resource-protocol'
import { saveAgentFile, type AgentFileTarget } from '../../services/member-file-resource'
import { isLocalPlatform } from '../../platform'
import { formatUnknownError } from '../../utils'
import { getIpcContext, IpcMethod, IpcService } from 'electron-ipc-decorator'
import type { LocalMachineRpcRequest } from '@lody/shared/local-machine-rpc'
import { getIpcServiceDeps } from '../ipc-service-deps'

const text = z.string().trim().min(1).max(256)
/**
 * A file the agent service reads for the desktop: a block a session keeps
 * (`fileId`), or a file at a path of another machine of the LAN (`path`).
 */
const MemberFileSchema = z
  .object({
    workspaceId: text,
    machineId: text,
    sessionId: text,
    fileId: text.optional(),
    path: z.string().min(1).max(4096).optional(),
    /** A file of this Board's shared directory; `path` is then relative to it. */
    boardId: z.string().startsWith('bd_').max(256).optional(),
    /** Only what a player needs is taken from it. */
    mimeType: z.string().max(128).optional()
  })
  .strict()
  .refine((value) => (value.fileId === undefined) !== (value.path === undefined))
export type MemberFileInput = z.input<typeof MemberFileSchema>
export type MemberFileResource =
  | { ok: true; url: string; sizeBytes: number }
  | { ok: false; error: string }
export type SaveMemberFileResult =
  | { ok: true; saved: boolean; path?: string }
  | { ok: false; error: string }

const toTarget = ({ mimeType: _mimeType, ...target }: z.output<typeof MemberFileSchema>) =>
  target satisfies AgentFileTarget

export class MachineRpcIpc extends IpcService {
  static override readonly groupName = 'machineRpc'

  @IpcMethod()
  async previewFile(message: LocalMachineRpcRequest) {
    const parsed = LocalMachineRpcRequestSchema.parse(message)
    if (parsed.method !== 'file/resolve-local') throw new Error('Invalid preview request.')
    const { event } = getIpcContext()
    const owner = event.sender
    const generation = getResourceOwner(owner)
    const result = await getIpcServiceDeps().cliService.sendLocalMachineRpc(parsed)
    if (owner.isDestroyed() || resourceOwners.get(owner.id) !== generation)
      throw new Error('Preview window closed.')
    if (!result.ok) throw new Error(result.error)
    const file = LocalFileResolutionSchema.safeParse(result.result)
    if (!file.success) return FilePreviewV3ErrorSchema.parse(result.result)
    const response = await localFileResources.preview(generation, file.data)
    if (owner.isDestroyed() || resourceOwners.get(owner.id) !== generation) {
      localFileResources.releaseOwner(generation)
      throw new Error('Preview window closed.')
    }
    return response
  }

  /** A resource URL for a file only the agent service can read; local platform only. */
  @IpcMethod()
  async openMemberFile(input: MemberFileInput): Promise<MemberFileResource> {
    const parsed = MemberFileSchema.safeParse(input)
    if (!parsed.success || !isLocalPlatform()) return { ok: false, error: 'invalid_request' }
    const owner = getIpcContext().event.sender
    const generation = getResourceOwner(owner)
    const mimeType = parsed.data.mimeType ?? ''
    try {
      const resource = await memberFileResources.member(
        generation,
        toTarget(parsed.data),
        /^(?:audio|video)\/[\w.+-]+$/u.test(mimeType) ? mimeType : 'application/octet-stream'
      )
      if (owner.isDestroyed() || resourceOwners.get(owner.id) !== generation) {
        localFileResources.releaseOwner(generation)
        return { ok: false, error: 'Preview window closed.' }
      }
      return { ok: true, ...resource }
    } catch (error) {
      return { ok: false, error: formatUnknownError(error) }
    }
  }

  /** Saves such a file where the user chooses, whatever its size. */
  @IpcMethod()
  async saveMemberFile(
    input: MemberFileInput & { fileName: string }
  ): Promise<SaveMemberFileResult> {
    const { fileName, ...file } = input ?? {}
    const parsed = MemberFileSchema.safeParse(file)
    if (!parsed.success || typeof fileName !== 'string' || !isLocalPlatform())
      return { ok: false, error: 'invalid_request' }
    try {
      const window = BrowserWindow.fromWebContents(getIpcContext().event.sender)
      const options = {
        defaultPath: path.join(app.getPath('downloads'), path.basename(fileName) || 'download')
      }
      const chosen =
        window && !window.isDestroyed()
          ? await dialog.showSaveDialog(window, options)
          : await dialog.showSaveDialog(options)
      if (chosen.canceled || !chosen.filePath) return { ok: true, saved: false }
      await saveAgentFile(openMemberFileRange, toTarget(parsed.data), chosen.filePath)
      return { ok: true, saved: true, path: chosen.filePath }
    } catch (error) {
      return { ok: false, error: formatUnknownError(error) }
    }
  }

  @IpcMethod()
  async send(message: LocalMachineRpcRequest) {
    // `cli/*` answers a terminal of this machine's user, never a renderer.
    if (message.method.startsWith('cli/')) throw new Error('Invalid machine RPC request.')
    return await getIpcServiceDeps().cliService.sendLocalMachineRpc(message)
  }
}

// Each document gets a distinct owner, including reloads to the same URL. A late
// response from the old document must never revoke a new document's resources.
const resourceOwners = new Map<number, number>()
let nextResourceOwner = 0
function getResourceOwner(owner: WebContents): number {
  const current = resourceOwners.get(owner.id)
  if (current !== undefined) return current
  const generation = ++nextResourceOwner
  resourceOwners.set(owner.id, generation)
  owner.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace) return
    const previous = resourceOwners.get(owner.id)
    if (previous !== undefined) localFileResources.releaseOwner(previous)
    resourceOwners.set(owner.id, ++nextResourceOwner)
  })
  owner.once('destroyed', () => {
    const previous = resourceOwners.get(owner.id)
    if (previous !== undefined) localFileResources.releaseOwner(previous)
    resourceOwners.delete(owner.id)
  })
  return generation
}
