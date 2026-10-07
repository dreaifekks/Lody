/**
 * Whether the user just clicked into a widget frame, judged from the host page
 * alone: nothing the widget's own code says can be trusted.
 *
 * Checked in Electron 43 (Chromium): a sandboxed widget can move focus into
 * itself without any user input (`window.focus()`, `element.focus()`), so focus
 * alone proves nothing. What it cannot do is grant user activation: a real
 * click or key press inside the frame activates the host page too, and a
 * script never does. The host's own clicks and keys activate it as well, but
 * those reach the host's listeners and a frame's never do, so an activation
 * with no host input in its lifespan came from a frame — the focused one,
 * which is where clicks and keys land.
 */

/** Chromium's transient activation lifespan. */
const ACTIVATION_LIFESPAN_MS = 5_000;

/** The events that give a page user activation. */
const ACTIVATING_EVENTS = ['keydown', 'mousedown', 'pointerdown', 'pointerup', 'touchend'] as const;

type HostWatch = { lastInputAt: number };
const watches = new WeakMap<Window, HostWatch>();

/**
 * Starts noting the host page's own input; idempotent per window. Runs on
 * import as well, so input from before the first widget mounts counts.
 */
export function watchHostInput(host: Window): void {
  if (watches.has(host)) return;
  const watch: HostWatch = { lastInputAt: -Infinity };
  watches.set(host, watch);
  for (const type of ACTIVATING_EVENTS) {
    host.addEventListener(
      type,
      (event) => {
        if (event.isTrusted) watch.lastInputAt = host.performance.now();
      },
      { capture: true, passive: true }
    );
  }
}

if (typeof window !== 'undefined') watchHostInput(window);

/**
 * True while the user's latest click or key press went into this frame: it
 * holds focus, the page is activated, and the host saw no input of its own
 * while that activation could still be its own.
 */
export function isUserGestureInFrame(frame: HTMLIFrameElement): boolean {
  const host = frame.ownerDocument.defaultView;
  if (!host || frame.ownerDocument.activeElement !== frame) return false;
  if (host.navigator.userActivation?.isActive !== true) return false;
  const lastInputAt = watches.get(host)?.lastInputAt ?? -Infinity;
  return host.performance.now() - lastInputAt > ACTIVATION_LIFESPAN_MS;
}
