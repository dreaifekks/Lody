import { getIpcContext, IpcMethod, IpcService } from 'electron-ipc-decorator'
import { assertProductWindowSender } from '../assert-sender'
import { disownWidgetClick, isWidgetClickRect, takeWidgetClick } from '../../services/widget-clicks'
import { getWidgetHostUrl } from '../../services/widget-host'

export class WidgetsIpc extends IpcService {
  static override readonly groupName = 'widgets'

  /** Where conversation widgets are framed from; see `widget-host.ts`. */
  @IpcMethod()
  async getHostUrl() {
    return await getWidgetHostUrl()
  }

  /**
   * Spends the user's latest click when it landed in this widget frame's box;
   * see `widget-clicks.ts`. A widget question is asked only for one.
   */
  @IpcMethod()
  async takeClick(rect: unknown): Promise<boolean> {
    const { event } = getIpcContext()
    assertProductWindowSender(event)
    return isWidgetClickRect(rect) && (await takeWidgetClick(event.sender, rect))
  }

  /** The page itself received the user's latest press; no widget may take it. */
  @IpcMethod()
  async disownClick(): Promise<void> {
    const { event } = getIpcContext()
    assertProductWindowSender(event)
    disownWidgetClick(event.sender)
  }
}
