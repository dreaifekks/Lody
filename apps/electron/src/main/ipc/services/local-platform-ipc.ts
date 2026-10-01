import { getIpcContext, IpcMethod, IpcService } from 'electron-ipc-decorator'
import { isLocalPlatform, readLocalPlatformSnapshot } from '../../platform'
import { readGitHubCliToken, type GitHubCliTokenResult } from '../../services/github-cli-token'
import { assertProductWindowSender } from '../assert-sender'
import { getIpcServiceDeps } from '../ipc-service-deps'

export class LocalPlatformIpc extends IpcService {
  static override readonly groupName = 'localPlatform'

  @IpcMethod()
  async getSnapshot() {
    if (!isLocalPlatform()) return null
    return await readLocalPlatformSnapshot(getIpcServiceDeps().lanHubStore?.getState().lans ?? [])
  }

  /** This machine's `gh` login token, for pull request details and actions. */
  @IpcMethod()
  async getGitHubToken(): Promise<GitHubCliTokenResult | null> {
    assertProductWindowSender(getIpcContext().event)
    if (!isLocalPlatform()) return null
    return await readGitHubCliToken()
  }
}
