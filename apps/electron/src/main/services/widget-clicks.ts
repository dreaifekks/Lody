import type { WebContents } from 'electron'

/**
 * Real clicks, for conversation widgets. A widget is agent-written code in a
 * sandboxed frame; nothing it reports can be trusted, and on Electron 43 it can
 * even move focus into itself unasked. `before-mouse-event` sees every press
 * the user makes in a window, including presses inside frames, and nothing a
 * page does produces one. So a widget question counts only against a press
 * the user made inside that widget's frame, and each press pays for one.
 */

/** From press to the widget's click handler asking: a click, not a held button. */
export const WIDGET_CLICK_MAX_AGE_MS = 3_000

/** A frame's box in the page's CSS pixels, as `getBoundingClientRect` gives it. */
export type WidgetClickRect = { left: number; top: number; right: number; bottom: number }

type Press = { x: number; y: number; at: number }

export type WidgetClickLedger = {
  /** A left press at page coordinates (DIP, from the page's top left). */
  record: (x: number, y: number) => void
  /**
   * Whether the latest press, not yet spent, landed in `rect` recently; spends
   * it when it did. `zoomFactor` converts DIP to the page's CSS pixels.
   */
  take: (rect: WidgetClickRect, zoomFactor: number) => boolean
}

export function createWidgetClickLedger(now: () => number = Date.now): WidgetClickLedger {
  let press: Press | null = null
  return {
    record: (x, y) => {
      press = { x, y, at: now() }
    },
    take: (rect, zoomFactor) => {
      if (!press || now() - press.at > WIDGET_CLICK_MAX_AGE_MS) return false
      const x = press.x / zoomFactor
      const y = press.y / zoomFactor
      if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) return false
      press = null
      return true
    }
  }
}

export const isWidgetClickRect = (value: unknown): value is WidgetClickRect => {
  if (typeof value !== 'object' || value === null) return false
  const rect = value as Record<string, unknown>
  return (['left', 'top', 'right', 'bottom'] as const).every(
    (key) => typeof rect[key] === 'number' && Number.isFinite(rect[key])
  )
}

const ledgers = new WeakMap<WebContents, WidgetClickLedger>()

/**
 * Starts noting a window's presses; one ledger per web contents. A press inside
 * a frame arrives in that frame's own coordinates, so the ledger keeps the
 * screen position less `contentOrigin`, the page's top left on screen.
 */
export function installWidgetClickWatch(
  contents: WebContents,
  contentOrigin: () => { x: number; y: number } | null
): void {
  const ledger = createWidgetClickLedger()
  ledgers.set(contents, ledger)
  contents.on('before-mouse-event', (_event, mouse) => {
    if (mouse.type !== 'mouseDown' || mouse.button !== 'left') return
    // A press that cannot be placed still replaces the last one, and lands nowhere.
    const origin = contentOrigin()
    ledger.record(
      origin && mouse.globalX !== undefined ? mouse.globalX - origin.x : NaN,
      origin && mouse.globalY !== undefined ? mouse.globalY - origin.y : NaN
    )
  })
}

export function takeWidgetClick(contents: WebContents, rect: WidgetClickRect): boolean {
  return ledgers.get(contents)?.take(rect, contents.getZoomFactor()) ?? false
}
