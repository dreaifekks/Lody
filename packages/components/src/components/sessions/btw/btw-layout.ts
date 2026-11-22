import { useLayoutEffect, useState } from 'react';

/** Minimum conversation-surface width (main + `/btw`) required to split `/btw` into a right side panel. */
export const BTW_SIDE_PANEL_MIN_CONTAINER_WIDTH_PX = 900;

/** Default width of the `/btw` side panel when opened on a wide full-page conversation. */
export const BTW_SIDE_PANEL_DEFAULT_WIDTH_PX = 380;

/** Minimum comfortable reading & composer width for the `/btw` side panel. */
export const BTW_SIDE_PANEL_MIN_WIDTH_PX = 300;

/** Minimum width preserved for the main conversation column beside the `/btw` side panel. */
export const BTW_SIDE_PANEL_MIN_MAIN_WIDTH_PX = 460;

/** Upper bound for the `/btw` side panel as a fraction of the conversation surface width. */
export const BTW_SIDE_PANEL_MAX_WIDTH_RATIO = 0.5;

export type BtwPresentationMode = 'overlay' | 'side-panel';

export type ResolveBtwPresentationModeInput = {
  /** True only on a standalone desktop conversation page with no other side panel or dialog split active. */
  readonly allowSidePanel: boolean;
  readonly isMobile: boolean;
  readonly containerWidth: number | null;
};

/**
 * Decides whether `/btw` splits out as a right side panel or overlays the current conversation.
 *
 * Overlay is always used when another side panel is already open, inside a Board thread / Side Chat /
 * Article / Worktree Review split, on mobile, or whenever the conversation surface is narrower than
 * `BTW_SIDE_PANEL_MIN_CONTAINER_WIDTH_PX`.
 */
export function resolveBtwPresentationMode({
  allowSidePanel,
  isMobile,
  containerWidth,
}: ResolveBtwPresentationModeInput): BtwPresentationMode {
  if (!allowSidePanel || isMobile) return 'overlay';
  if (
    containerWidth === null ||
    !Number.isFinite(containerWidth) ||
    containerWidth < BTW_SIDE_PANEL_MIN_CONTAINER_WIDTH_PX
  ) {
    return 'overlay';
  }
  return 'side-panel';
}

/** Compute the valid width bounds for the `/btw` side panel given the full conversation surface width. */
export function getBtwSidePanelWidthBounds(containerWidth: number | null): {
  readonly min: number;
  readonly max: number;
} {
  if (containerWidth === null || !Number.isFinite(containerWidth) || containerWidth <= 0) {
    return {
      min: BTW_SIDE_PANEL_MIN_WIDTH_PX,
      max: BTW_SIDE_PANEL_DEFAULT_WIDTH_PX,
    };
  }
  const maxByMain = containerWidth - BTW_SIDE_PANEL_MIN_MAIN_WIDTH_PX;
  const maxByRatio = Math.floor(containerWidth * BTW_SIDE_PANEL_MAX_WIDTH_RATIO);
  const max = Math.max(BTW_SIDE_PANEL_MIN_WIDTH_PX, Math.min(maxByMain, maxByRatio));
  return {
    min: BTW_SIDE_PANEL_MIN_WIDTH_PX,
    max,
  };
}

/** Clamp a desired `/btw` side-panel width into the container's comfortable bounds. */
export function clampBtwSidePanelWidth(
  desiredWidth: number,
  containerWidth: number | null
): number {
  const rounded = Number.isFinite(desiredWidth)
    ? Math.round(desiredWidth)
    : BTW_SIDE_PANEL_DEFAULT_WIDTH_PX;
  if (containerWidth === null || !Number.isFinite(containerWidth) || containerWidth <= 0) {
    return Math.max(BTW_SIDE_PANEL_MIN_WIDTH_PX, rounded);
  }
  const { min, max } = getBtwSidePanelWidthBounds(containerWidth);
  return Math.min(max, Math.max(min, rounded));
}

/**
 * Observes the outer conversation surface width synchronously before paint and on resize.
 * Measuring the outer container (main column + `/btw` side panel combined) avoids width oscillation
 * when the side panel opens or closes.
 */
export function useBtwContainerWidth(element: HTMLElement | null, enabled: boolean): number | null {
  const [width, setWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!enabled || !element) {
      setWidth(null);
      return undefined;
    }

    const update = (rawWidth: number) => {
      if (!Number.isFinite(rawWidth)) return;
      const next = Math.round(rawWidth);
      setWidth((prev) => (prev === next ? prev : next));
    };

    update(element.getBoundingClientRect().width);

    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      const observed = entry ? entry.contentRect.width : element.getBoundingClientRect().width;
      update(observed);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, enabled]);

  return enabled ? width : null;
}
