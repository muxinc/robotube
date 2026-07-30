/**
 * Pure list-state and pagination decisions for the Shorts paged feed.
 *
 * Keeping these out of the screen component means the loading/empty/error/
 * exhausted matrix and the "start paginating before the last item" rule are
 * testable without a renderer, a native list, or a Convex client.
 *
 * No React and no react-native imports.
 */

/** Mirrors Convex's `usePaginatedQuery` status union. */
export type ShortsFeedStatus =
  | "LoadingFirstPage"
  | "CanLoadMore"
  | "LoadingMore"
  | "Exhausted";

/**
 * What the screen renders instead of (or behind) the list.
 *
 * `ready` covers the exhausted case too: running out of pages must never
 * replace the last playable page with a full-screen footer.
 *
 * There is no `error` member on purpose. Convex re-throws a failed paginated
 * query during render, so a query failure never reaches this function — it is
 * caught by `ShortsQueryErrorBoundary`, which owns the error screen. Note that
 * losing the network is *not* a query failure: the Convex client keeps serving
 * the last result while the socket reconnects, so an offline viewer stays in
 * `ready` with their current posters intact.
 */
export type ShortsListState = "loading" | "empty" | "ready";

export type ShortsListStateInputs = {
  status: ShortsFeedStatus;
  itemCount: number;
};

/**
 * Resolves the screen-level state.
 *
 * Anything already loaded wins over every transitional status: a later page
 * arriving, or failing to arrive, must not swap the feed the viewer is watching
 * for a spinner.
 */
export function resolveShortsListState({
  status,
  itemCount,
}: ShortsListStateInputs): ShortsListState {
  const count = Number.isFinite(itemCount) ? Math.max(0, itemCount) : 0;
  if (count > 0) return "ready";
  if (status === "LoadingFirstPage" || status === "LoadingMore") return "loading";
  return "empty";
}

/**
 * How many pages ahead of the viewer pagination is requested. Three full-screen
 * pages is roughly one fling of headroom, which keeps the request off the
 * critical path without fetching pages the viewer will never reach.
 */
export const SHORTS_PAGINATION_PREFETCH_PAGES = 3;

export type ShortsLoadMoreInputs = {
  status: ShortsFeedStatus;
  /** Committed (or candidate) index the viewer is on, or null before first focus. */
  activeIndex: number | null;
  itemCount: number;
  prefetchPages?: number;
};

/**
 * True when the next page should be requested.
 *
 * This is index-driven rather than scroll-offset-driven so pagination starts a
 * fixed number of *pages* before the end regardless of page height, and so it
 * cannot fire while the viewer is still far from the tail of the list.
 */
export function shouldLoadMoreShorts({
  status,
  activeIndex,
  itemCount,
  prefetchPages = SHORTS_PAGINATION_PREFETCH_PAGES,
}: ShortsLoadMoreInputs): boolean {
  if (status !== "CanLoadMore") return false;
  const count = Number.isFinite(itemCount) ? Math.floor(itemCount) : 0;
  if (count <= 0) return false;
  if (activeIndex === null || !Number.isFinite(activeIndex)) return false;

  const lead = Math.max(0, Math.floor(prefetchPages));
  return activeIndex >= count - 1 - lead;
}

/**
 * True when the end-of-feed notice should be shown.
 *
 * Deliberately index-scoped: the notice is an overlay on the last page, not a
 * list footer, because a viewport-tall footer would become an extra snap page
 * with no video in it.
 */
export function shouldShowShortsExhaustedNotice({
  status,
  activeIndex,
  itemCount,
}: {
  status: ShortsFeedStatus;
  activeIndex: number | null;
  itemCount: number;
}): boolean {
  if (status !== "Exhausted") return false;
  const count = Number.isFinite(itemCount) ? Math.floor(itemCount) : 0;
  if (count <= 0) return false;
  if (activeIndex === null) return false;
  return activeIndex >= count - 1;
}

/**
 * Index the list should be restored to after a viewport-size or orientation
 * change, so the active asset — not the active scroll offset — is what is
 * preserved.
 *
 * Falls back to the last known index (clamped into range) when the anchor asset
 * has left the list, and to null when there is nothing to restore.
 */
export function resolveShortsAnchorIndex<T extends { muxAssetId: string }>(
  items: readonly T[],
  anchorMuxAssetId: string | null,
  fallbackIndex: number | null,
): number | null {
  if (items.length === 0) return null;

  if (anchorMuxAssetId) {
    const found = items.findIndex((item) => item.muxAssetId === anchorMuxAssetId);
    if (found >= 0) return found;
  }

  if (fallbackIndex === null || !Number.isFinite(fallbackIndex)) return null;
  return Math.min(items.length - 1, Math.max(0, Math.floor(fallbackIndex)));
}

/**
 * Viewability threshold for full-viewport pages.
 *
 * Home uses 65% because several 16:9 cards share the viewport. One Shorts item
 * *is* the viewport, so a threshold that low makes both the outgoing and
 * incoming page viewable mid-swipe. Requiring most of the page removes that
 * ambiguity and leaves the lowest-index tie-break in the focus machine as a
 * safety net rather than the deciding factor.
 */
export const SHORTS_VIEWABILITY_CONFIG = {
  itemVisiblePercentThreshold: 80,
  minimumViewTime: 80,
} as const;
