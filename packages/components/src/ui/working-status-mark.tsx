import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';

import { WorkingGrid } from './working-grid';
import { WorkingGridCollapse } from './working-grid-collapse';

export type BackgroundStatusMarkProps = {
  /** Draw the breathing ring without motion (e.g. low-stimulus mode). */
  still?: boolean;
  /** Text colour class for the ring and inner dot. */
  className?: string;
};

/**
 * Restrained 12px concentric breathing ring indicating a session with native
 * background task(s) waiting after its main turn completed
 * (`backgroundTaskState: 'background'`), visually distinct from the active
 * 3×3 {@link WorkingGrid} / tab spinner.
 */
export function BackgroundStatusMark({ still = false, className }: BackgroundStatusMarkProps) {
  return (
    <span
      data-session-background-indicator={still ? 'still' : ''}
      aria-hidden="true"
      className={cn(
        'relative inline-flex h-3 w-3 shrink-0 items-center justify-center text-muted-foreground',
        className
      )}
    >
      <span
        className={cn(
          'h-[10px] w-[10px] rounded-full border-[1.4px] border-current opacity-75',
          !still && 'animate-bg-calm-breath'
        )}
      />
      <span className="absolute h-[3.5px] w-[3.5px] rounded-full bg-current" />
    </span>
  );
}

export type WorkingStatusMarkProps = {
  /** The session's agent is running. */
  working: boolean;
  /** The session is only waiting on native background task(s) (`backgroundTaskState: 'background'`). */
  background?: boolean;
  /** The session has messages the user has not read. */
  unread: boolean;
  /** Play the working → unread transition; `false` goes straight to the dot. */
  doneTransition?: boolean;
  /** Draw the grid / background ring without motion. */
  still?: boolean;
  /** Text colour class for the grid, transition and dot. */
  className?: string;
};

/**
 * A session's working / background / unread mark, with the hand-over between them:
 *
 * - working (active foreground) → the {@link WorkingGrid};
 * - background (silent background task wait) → the {@link BackgroundStatusMark};
 * - working → unread → the {@link WorkingGridCollapse} plays once (the tiles
 *   spin and gather, the dot pops and bounces), then the unread dot; with
 *   `doneTransition={false}` the dot comes at once;
 * - unread → the 8px unread dot;
 * - neither → nothing.
 *
 * The transition fires only when `unread` is already true in the render where
 * `working` turns false. The two arrive on different transports, so pass
 * `working` through {@link useWorkingHandOver} first; it holds the grid until the
 * unread write lands. The previous `working` value is state adjusted during
 * render, so the transition lands in the same commit that removes the grid; keep
 * this component mounted across both states for it to see the change.
 */
export function WorkingStatusMark({
  working,
  background = false,
  unread,
  doneTransition = true,
  still = false,
  className,
}: WorkingStatusMarkProps) {
  const [wasWorking, setWasWorking] = useState(working);
  const [finishing, setFinishing] = useState(false);
  if (wasWorking !== working) {
    setWasWorking(working);
    setFinishing(doneTransition && wasWorking && !working && unread);
  }

  if (working && !background) {
    return (
      <WorkingGrid
        data-session-working-indicator={still ? 'still' : ''}
        still={still}
        className={className}
      />
    );
  }
  if (background) {
    return <BackgroundStatusMark still={still} />;
  }
  if (unread && finishing) {
    return (
      <WorkingGridCollapse
        data-session-done-transition=""
        className={className}
        onDone={() => setFinishing(false)}
      />
    );
  }
  if (unread) {
    return (
      <span
        data-session-unread-dot=""
        className={cn('h-2 w-2 rounded-full bg-current', className)}
      />
    );
  }
  return null;
}

/** How long a finished row keeps its grid while it waits for the unread write. */
export const WORKING_HAND_OVER_MS = 1_500;

/**
 * The `working` value to draw, holding the grid briefly after work stops so the
 * done transition can still play when `unread` lands after `working` clears.
 *
 * A turn's end reaches the renderer on two transports with no ordering between
 * them: presence (working) is ephemeral and applied at once, while the unread
 * bump is a doc-meta write that the projection flushes a task later
 * (`atoms/doc-meta.ts`). Presence therefore usually clears first; without the
 * hold the mark unmounts and the dot later appears without the transition.
 * When `unread` never comes (the user is reading the session) the hold simply
 * lapses after {@link WORKING_HAND_OVER_MS}. Call it where the row stays mounted.
 */
export function useWorkingHandOver(working: boolean, unread: boolean): boolean {
  const [wasWorking, setWasWorking] = useState(working);
  const [holding, setHolding] = useState(false);
  if (wasWorking !== working) {
    setWasWorking(working);
    setHolding(wasWorking && !working && !unread);
  } else if (holding && unread) {
    setHolding(false);
  }
  useEffect(() => {
    if (!holding) return undefined;
    const timer = setTimeout(() => setHolding(false), WORKING_HAND_OVER_MS);
    return () => clearTimeout(timer);
  }, [holding]);
  return working || holding;
}
