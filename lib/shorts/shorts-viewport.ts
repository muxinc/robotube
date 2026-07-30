/**
 * Pure viewport geometry for the Shorts paged feed.
 *
 * The vertical feed must page by the *measured content viewport inside the tab*,
 * never by a module-level `Dimensions.get("window").height`: a cached window
 * height disagrees with the native tab bar, changes on rotation, and is captured
 * once at import time for the life of the JS bundle.
 *
 * No React and no react-native imports, so this is directly unit testable.
 */

/** Below this a "page" is not a usable video viewport; treat it as unmeasured. */
export const MIN_SHORTS_PAGE_HEIGHT_PX = 240;

/**
 * Nominal height of the native tab bar above the bottom safe-area inset. Used
 * only to decide whether the measured page already excludes the tab bar; the
 * page height itself is always measured, never estimated from this.
 */
export const SHORTS_TAB_BAR_CLEARANCE_PX = 52;

/** Minimum distance between an overlay control and the page edge. */
export const SHORTS_EDGE_MARGIN_PX = 16;

export type ShortsPageHeightInputs = {
  /**
   * Height reported by `onLayout` on the screen's content container, or null
   * before the first layout pass.
   */
  measuredHeight: number | null;
  /** Current window height. Only used until the first real measurement. */
  windowHeight: number;
  topInset: number;
  bottomInset: number;
};

/**
 * The page and snap height for one Shorts item.
 *
 * A measurement always wins: it is the authoritative content viewport for
 * whatever the tab navigator actually handed the screen, which is why insets are
 * *not* subtracted from it. Insets only shape the pre-measurement estimate.
 *
 * The measured value is returned **exactly, including its fraction**. Rounding
 * it would desynchronize the two geometries that have to agree:
 *
 *  - on iOS, `pagingEnabled` snaps by the scroll view's real (fractional) frame
 *    height, so a floored item height drifts by the discarded fraction on every
 *    page and eventually rests between two items;
 *  - on Android, `snapToInterval` is given this same number, so it matches the
 *    item height by construction.
 *
 * A device pixel ratio of 3 makes fractional viewport heights (…/3 points) the
 * normal case, not an edge case.
 */
export function resolveShortsPageHeight({
  measuredHeight,
  windowHeight,
  topInset,
  bottomInset,
}: ShortsPageHeightInputs): number {
  if (isUsableHeight(measuredHeight)) {
    return measuredHeight;
  }

  const safeWindowHeight = Number.isFinite(windowHeight) ? windowHeight : 0;
  const estimate =
    safeWindowHeight - nonNegative(topInset) - nonNegative(bottomInset);
  if (isUsableHeight(estimate)) {
    return estimate;
  }
  if (isUsableHeight(safeWindowHeight)) {
    return safeWindowHeight;
  }
  return MIN_SHORTS_PAGE_HEIGHT_PX;
}

/** True when a candidate height is large enough to present a video page. */
export function isUsableShortsPageHeight(value: number | null): boolean {
  return isUsableHeight(value);
}

export type ShortsSnapProps = {
  /**
   * Native vertical paging. iOS only: React Native's `pagingEnabled` does not
   * support vertical pagination on Android.
   */
  pagingEnabled: boolean;
  /** Android's equivalent: snap every page-height of scroll. */
  snapToInterval?: number;
  snapToAlignment?: "start";
  /** Stops a fling from carrying past a single page. */
  disableIntervalMomentum?: boolean;
  decelerationRate: "fast";
};

/**
 * Snap configuration for the paged list.
 *
 * `pagingEnabled` and `snapToInterval` are deliberately never set together:
 * both are implemented through the same native snap path, so combining them
 * double-snaps on iOS. Each platform gets exactly the one that works there.
 */
export function resolveShortsSnapProps(
  pageHeight: number,
  platformOS: string,
): ShortsSnapProps {
  if (platformOS === "ios") {
    return { pagingEnabled: true, decelerationRate: "fast" };
  }
  return {
    pagingEnabled: false,
    snapToInterval: pageHeight,
    snapToAlignment: "start",
    disableIntervalMomentum: true,
    decelerationRate: "fast",
  };
}

/**
 * How many viewports beyond the visible page stay rendered.
 *
 * This is the committed cell's retention window. The single `MuxVideoView` lives
 * inside the committed cell, so a cell recycled out from under the player
 * detaches the surface; two pages of retention keeps the committed page mounted
 * across a short or medium fling, which is the common reverse-fling case.
 *
 * It is deliberately a small constant rather than something larger: retention is
 * bounded because the 50-item down/up memory target is, and an arbitrarily long
 * fling will still recycle the committed cell. That path is safe — it detaches
 * and pauses without replacing the source, and the page returns poster-first —
 * see `shorts-fling-invariants.test.ts`.
 */
export const SHORTS_RETAINED_PAGES = 2;

export function resolveShortsDrawDistance(
  pageHeight: number,
  retainedPages = SHORTS_RETAINED_PAGES,
): number {
  const safePageHeight = isUsableHeight(pageHeight)
    ? pageHeight
    : MIN_SHORTS_PAGE_HEIGHT_PX;
  const pages = Math.max(1, Math.floor(retainedPages));
  return Math.ceil(safePageHeight * pages);
}

export type ShortsOverlayInsetInputs = {
  /** Measured page height, as returned by `resolveShortsPageHeight`. */
  pageHeight: number;
  windowHeight: number;
  topInset: number;
  bottomInset: number;
};

export type ShortsOverlayInsets = {
  paddingTop: number;
  paddingBottom: number;
};

/**
 * Padding that keeps overlay controls inside the safe area and clear of the
 * native tab bar.
 *
 * Whether the measured page runs *under* the tab bar or stops above it depends
 * on the platform's native tab implementation, so it is derived rather than
 * assumed: any window height the page does not occupy is already-reserved space
 * below the content, and only the shortfall against the nominal tab-bar height
 * has to be padded back. When the tab bar is already excluded the overlay only
 * needs its edge margin.
 */
export function resolveShortsOverlayInsets({
  pageHeight,
  windowHeight,
  topInset,
  bottomInset,
}: ShortsOverlayInsetInputs): ShortsOverlayInsets {
  const safePageHeight = nonNegative(pageHeight);
  const safeWindowHeight = nonNegative(windowHeight);
  const safeTopInset = nonNegative(topInset);
  const safeBottomInset = nonNegative(bottomInset);

  const reservedBelowPx = Math.max(
    0,
    safeWindowHeight - safePageHeight - safeTopInset,
  );
  const clearanceShortfallPx = Math.max(
    0,
    SHORTS_TAB_BAR_CLEARANCE_PX + safeBottomInset - reservedBelowPx,
  );

  return {
    paddingTop: safeTopInset + SHORTS_EDGE_MARGIN_PX,
    paddingBottom: SHORTS_EDGE_MARGIN_PX + clearanceShortfallPx,
  };
}

function isUsableHeight(value: number | null | undefined): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_SHORTS_PAGE_HEIGHT_PX
  );
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
