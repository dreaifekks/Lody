import type { WebContents } from 'electron'
import { getStartedWidgetHostUrl, isBlockedWidgetFrameNavigation } from './widget-host'

type FrameNavigation = {
  url: string
  isMainFrame: boolean
  frame: { url: string } | null
  preventDefault: () => void
}

/**
 * Keeps conversation widgets on their page: a sub-frame showing the widget
 * page (or asked to load it) may only load that exact page again. The main
 * frame keeps its own guard in `window.ts`.
 */
export function installWidgetFrameGuard(contents: WebContents): void {
  const guard = (details: FrameNavigation): void => {
    if (details.isMainFrame) return
    if (
      isBlockedWidgetFrameNavigation({
        currentUrl: details.frame?.url ?? '',
        targetUrl: details.url,
        shellUrl: getStartedWidgetHostUrl()
      })
    ) {
      details.preventDefault()
      console.warn('[Electron] Blocked widget frame navigation', { url: details.url })
    }
  }
  contents.on('will-frame-navigate', guard)
  contents.on('will-redirect', guard)
}
