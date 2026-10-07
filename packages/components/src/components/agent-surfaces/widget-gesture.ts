import { isElectronRenderer } from '@/lib/electron';
import { getIpcServices } from '@/lib/electron-ipc-client';

/**
 * Whether a widget question comes from the user's own click on this frame,
 * spending that click. Nothing the widget's code says can be trusted: on
 * Electron 43 a sandboxed frame can even move focus into itself unasked, and
 * the page cannot see presses inside a frame at all. The desktop's main
 * process can (`apps/electron/src/main/services/widget-clicks.ts`), so it
 * answers: the latest press landed in this frame's box, recently, and has not
 * paid for another question. Focus must be in the frame too, so a press on
 * something drawn over it does not count.
 *
 * Builds without that process (the web app, Storybook) have no such signal
 * and accept no question.
 */
export async function takeUserClickInFrame(frame: HTMLIFrameElement): Promise<boolean> {
  const ipc = isElectronRenderer() ? getIpcServices() : null;
  if (!ipc || frame.ownerDocument.activeElement !== frame) return false;
  const { left, top, right, bottom } = frame.getBoundingClientRect();
  return await ipc.widgets.takeClick({ left, top, right, bottom }).catch(() => false);
}
