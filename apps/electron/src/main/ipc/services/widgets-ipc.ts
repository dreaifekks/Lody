import { IpcMethod, IpcService } from 'electron-ipc-decorator'
import { getWidgetHostUrl } from '../../services/widget-host'

export class WidgetsIpc extends IpcService {
  static override readonly groupName = 'widgets'

  /** Where conversation widgets are framed from; see `widget-host.ts`. */
  @IpcMethod()
  async getHostUrl() {
    return await getWidgetHostUrl()
  }
}
