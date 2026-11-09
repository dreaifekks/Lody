import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { PopupContainerProvider, type PopupContainer } from '@lody/ui/popup-container';

/**
 * A DOM node that keeps one React subtree while it moves between places.
 *
 * The subtree is portalled into `node`; each place on screen renders a
 * `RelocatableSlot`, and the node sits in the slot claimed last. Moving a node
 * is a DOM operation, so React keeps the subtree mounted: its state, its refs
 * and whatever the user typed stay as they were. `moveBefore` also keeps
 * focus, scroll offsets and frames where the browser has it.
 */
export type RelocatableHost = {
  readonly node: HTMLDivElement;
  /**
   * Puts the node in `slot` until the returned release. The node sits in the
   * slot of the highest `priority`, the latest claimed among equals; a slot
   * that mounts later at a lower priority does not take it away.
   */
  claim(slot: HTMLElement, priority?: number): () => void;
};

type MovableParent = HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void };

export function createRelocatableHost(): RelocatableHost {
  const node = document.createElement('div');
  node.style.height = '100%';
  node.style.minHeight = '0';
  const slots: { readonly element: HTMLElement; readonly priority: number }[] = [];
  const place = () => {
    const slot: MovableParent | undefined = slots.reduce<(typeof slots)[number] | undefined>(
      (best, entry) => (best && best.priority > entry.priority ? best : entry),
      undefined
    )?.element;
    // With no place left the node leaves the document, so a host whose
    // subtree is gone cannot keep taking room in its last slot.
    if (!slot) {
      node.remove();
      return;
    }
    if (node.parentElement === slot) return;
    if (typeof slot.moveBefore === 'function' && node.isConnected && slot.isConnected)
      slot.moveBefore(node, null);
    else slot.appendChild(node);
  };
  return {
    node,
    claim(element, priority = 0) {
      const entry = { element, priority };
      slots.push(entry);
      place();
      return () => {
        slots.splice(slots.indexOf(entry), 1);
        place();
      };
    },
  };
}

/**
 * A place a relocatable subtree shows in; see `RelocatableHost.claim` for which
 * one wins. A slot about to leave the document lets go first (`held` false):
 * only a move between two places that are both in the document keeps scroll
 * offsets, since an element that is detached and attached again loses them.
 */
export function RelocatableSlot({
  host,
  priority = 0,
  held = true,
  className,
  'aria-hidden': ariaHidden,
}: {
  host: RelocatableHost;
  priority?: number;
  held?: boolean;
  className?: string | undefined;
  'aria-hidden'?: boolean | undefined;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = ref.current;
    return slot && held ? host.claim(slot, priority) : undefined;
  }, [held, host, priority]);
  return <div ref={ref} className={className} aria-hidden={ariaHidden} />;
}

/**
 * A conversation the article window can borrow: it is portalled into `host`,
 * which sits in the box rendered here until the window claims it. Its menus
 * and popovers mount in `popupContainer`, the window's panel while it is there.
 * Without a host it simply stays in the box.
 */
export function RelocatableConversation({
  host,
  popupContainer,
  className,
  'aria-hidden': ariaHidden,
  children,
}: {
  host: RelocatableHost | null;
  popupContainer: PopupContainer;
  className?: string | undefined;
  'aria-hidden'?: boolean | undefined;
  children: ReactNode;
}) {
  if (!host)
    return (
      <div className={className} aria-hidden={ariaHidden}>
        {children}
      </div>
    );
  return (
    <>
      <RelocatableSlot host={host} className={className} aria-hidden={ariaHidden} />
      {createPortal(
        <PopupContainerProvider container={popupContainer}>{children}</PopupContainerProvider>,
        host.node
      )}
    </>
  );
}

/** The host `id`'s conversation keeps in `hosts`, made on first use. */
export function relocatableHostFor<Id>(hosts: Map<Id, RelocatableHost>, id: Id): RelocatableHost {
  let host = hosts.get(id);
  if (!host) {
    host = createRelocatableHost();
    hosts.set(id, host);
  }
  return host;
}
