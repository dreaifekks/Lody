import { IpcMethod, IpcService } from 'electron-ipc-decorator'
import { isLocalPlatform, readLocalPlatformSnapshot } from '../../platform'
import { getIpcServiceDeps } from '../ipc-service-deps'

export class LocalPlatformIpc extends IpcService {
  static override readonly groupName = 'localPlatform'

  @IpcMethod()
  async getSnapshot() {
    if (!isLocalPlatform()) return null
    return await readLocalPlatformSnapshot(getIpcServiceDeps().lanHubStore?.getState().lans ?? [])
  }
}
