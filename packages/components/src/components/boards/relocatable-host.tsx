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
  /** Puts the node in `slot` until the returned release; the previous slot gets it back then. */
  claim(slot: HTMLElement): () => void;
};

type MovableParent = HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void };

export function createRelocatableHost(): RelocatableHost {
  const node = document.createElement('div');
  node.style.height = '100%';
  node.style.minHeight = '0';
  const slots: HTMLElement[] = [];
  const place = () => {
    const slot: MovableParent | undefined = slots.at(-1);
    if (!slot || node.parentElement === slot) return;
    if (typeof slot.moveBefore === 'function' && node.isConnected && slot.isConnected)
      slot.moveBefore(node, null);
    else slot.appendChild(node);
  };
  return {
    node,
    claim(slot) {
      slots.push(slot);
      place();
      return () => {
        slots.splice(slots.lastIndexOf(slot), 1);
        place();
      };
    },
  };
}

/** A place a relocatable subtree shows in while this slot is the latest one mounted. */
export function RelocatableSlot({
  host,
  className,
}: {
  host: RelocatableHost;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = ref.current;
    return slot ? host.claim(slot) : undefined;
  }, [host]);
  return <div ref={ref} className={className} />;
}
