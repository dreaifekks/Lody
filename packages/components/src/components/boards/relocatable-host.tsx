import { useLayoutEffect, useRef } from 'react';

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
    if (!slot || node.parentElement === slot) return;
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

/** A place a relocatable subtree shows in; see `RelocatableHost.claim` for which one wins. */
export function RelocatableSlot({
  host,
  priority = 0,
  className,
}: {
  host: RelocatableHost;
  priority?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = ref.current;
    return slot ? host.claim(slot, priority) : undefined;
  }, [host, priority]);
  return <div ref={ref} className={className} />;
}
