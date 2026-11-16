import { IpcMethod } from 'electron-ipc-decorator'
import type { CheckForElectronUpdateResult } from '@lody/shared/electron-ipc'
import { LanReleaseChannelSchema } from '@lody/shared/lan-release'
import { ProductWindowIpcService } from '../product-window-ipc-service'
import { getIpcServiceDeps } from '../ipc-service-deps'

export class UpdaterIpc extends ProductWindowIpcService {
  static override readonly groupName = 'updater'

  @IpcMethod()
  async getState() {
    return getIpcServiceDeps().appUpdaterService.getState()
  }

  @IpcMethod()
  async checkForUpdates() {
    return await getIpcServiceDeps().appUpdaterService.checkForUpdates()
  }

  @IpcMethod()
  async quitAndInstall() {
    return await getIpcServiceDeps().appUpdaterService.quitAndInstall()
  }

  @IpcMethod()
  async follow(channel: unknown): Promise<CheckForElectronUpdateResult> {
    const updater = getIpcServiceDeps().appUpdaterService
    const parsed = LanReleaseChannelSchema.safeParse(channel)
    if (!parsed.success || !updater.follow) return { started: false, error: 'updater_disabled' }
    return await updater.follow(parsed.data)
  }
}
