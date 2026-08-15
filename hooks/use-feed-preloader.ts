import { Image } from "expo-image";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  createDisabledFeedPreloader,
  FEED_MEDIA_PRELOAD_ENABLED,
  type FeedPreloader,
} from "@/lib/feed/feed-preloader";
import {
  diffPreloadWindow,
  feedPreloadCacheKey,
  selectPreloadWindow,
} from "@/lib/feed/feed-preload-policy";
import type { FeedScrollDirection } from "@/lib/feed/feed-focus-machine";
import type { FeedMediaPolicy } from "@/lib/feed/feed-adaptive-policy";
import type { FeedTelemetryScreen } from "@/lib/feed/feed-telemetry";
import {
  isPreloadKillSwitchEngaged,
  subscribeToPreloadKillSwitch,
} from "@/lib/feed-feature-kill-switch";

export type FeedPreloadItem = {
  muxAssetId: string;
  playbackId: string;
  /** Already width-resolved by the adaptive policy. */
  thumbnailUrl: string;
};

export type UseFeedPreloaderOptions = {
  items: readonly FeedPreloadItem[];
  committedIndex: number | null;
  direction: FeedScrollDirection;
  isScrolling: boolean;
  /** Lifecycle + focus gate. False cancels everything. */
  isActive: boolean;
  policy: FeedMediaPolicy;
  screen?: FeedTelemetryScreen;
  /** Injection point for a real implementation once one exists. */
  preloader?: FeedPreloader;
};

/**
 * Runs the bounded preload-window policy and drives two sinks:
 *
 *  - an injected media `FeedPreloader` (Shorts uses the Mux native adapter; a
 *    surface without one stays disabled); and
 *  - `expo-image` thumbnail prefetch for the next likely card, which *is*
 *    demonstrably reusable — the prefetched image lands in the same disk/memory
 *    cache the card's `<Image>` reads from.
 *
 * Everything runs off the committed index, so a fast fling starts no work.
 */
export function useFeedPreloader({
  items,
  committedIndex,
  direction,
  isScrolling,
  isActive,
  policy,
  screen = "home",
  preloader,
}: UseFeedPreloaderOptions): void {
  const defaultPreloader = useMemo(() => createDisabledFeedPreloader(screen), [screen]);
  const activePreloader = preloader ?? defaultPreloader;
  const prefetchedThumbnailsRef = useRef(new Set<string>());
  const [isKilled, setIsKilled] = useState(isPreloadKillSwitchEngaged);

  useEffect(
    () =>
      subscribeToPreloadKillSwitch((state) => {
        setIsKilled(state.engaged);
        if (state.engaged) activePreloader.cancelAll();
      }),
    [activePreloader],
  );

  const isMediaPreloadAllowed =
    FEED_MEDIA_PRELOAD_ENABLED &&
    !isKilled &&
    activePreloader.isEnabled() &&
    policy.isMediaPreloadAllowed &&
    isActive;

  const committedCacheKey = useMemo(() => {
    if (committedIndex === null) return null;
    const item = items[committedIndex];
    if (!item) return null;
    return feedPreloadCacheKey({
      playbackId: item.playbackId,
      maxResolution: policy.maxResolution,
    });
  }, [committedIndex, items, policy.maxResolution]);

  // Convert a predictive preload into an active-source hit before the window
  // diff starts the following neighbour. The adapter keeps promoted keys as
  // logical window members, but releases/consumes their native preload state.
  const lastPromotedCacheKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (committedCacheKey === null) {
      lastPromotedCacheKeyRef.current = null;
      return;
    }
    if (lastPromotedCacheKeyRef.current === committedCacheKey) return;
    lastPromotedCacheKeyRef.current = committedCacheKey;
    activePreloader.promoteToActive(committedCacheKey);
  }, [activePreloader, committedCacheKey]);

  const windowIndexes = useMemo(
    () =>
      selectPreloadWindow({
        committedIndex,
        direction,
        itemCount: items.length,
        preloadAhead: policy.preloadAhead,
        preloadBehind: policy.preloadBehind,
        isPreloadAllowed: isMediaPreloadAllowed,
        isScrolling,
        // Committed focus never advances mid-fling, so reaching this hook at all
        // means the list already settled.
        isFling: false,
      }),
    [
      committedIndex,
      direction,
      isMediaPreloadAllowed,
      isScrolling,
      items.length,
      policy.preloadAhead,
      policy.preloadBehind,
    ],
  );

  useEffect(() => {
    const desired: string[] = [];
    const byKey = new Map<string, { item: FeedPreloadItem; index: number }>();
    for (const index of windowIndexes) {
      const item = items[index];
      if (!item) continue;
      const cacheKey = feedPreloadCacheKey({
        playbackId: item.playbackId,
        maxResolution: policy.maxResolution,
      });
      desired.push(cacheKey);
      byKey.set(cacheKey, { item, index });
    }

    const { start, cancel } = diffPreloadWindow(activePreloader.retainedKeys(), desired);
    // Cancel first so a direction change frees resources before new work starts
    // and active playback never contends with a stale request.
    for (const cacheKey of cancel) activePreloader.cancel(cacheKey);
    for (const cacheKey of start) {
      const entry = byKey.get(cacheKey);
      if (!entry) continue;
      // The active player already owns the committed source. Only start a
      // headless preload for predictive neighbours; a committed key appears in
      // `desired` solely so a formerly-predictive preload survives promotion.
      if (entry.index === committedIndex) continue;
      activePreloader.start({
        cacheKey,
        muxAssetId: entry.item.muxAssetId,
        playbackId: entry.item.playbackId,
        feedIndex: entry.index,
        maxResolution: policy.maxResolution,
      });
    }
  }, [activePreloader, committedIndex, items, policy.maxResolution, windowIndexes]);

  // Suspend and release everything when the feed backgrounds or loses focus.
  useEffect(() => {
    if (isActive) return;
    activePreloader.cancelAll();
  }, [activePreloader, isActive]);

  useEffect(() => {
    const preloaderOnUnmount = activePreloader;
    return () => preloaderOnUnmount.cancelAll();
  }, [activePreloader]);

  // Thumbnail prefetch: active card plus one direction-aware neighbour only.
  useEffect(() => {
    if (!isActive || isScrolling) return;
    if (!policy.isThumbnailPrefetchAllowed) return;
    if (committedIndex === null) return;

    const neighbour = direction === "backward" ? committedIndex - 1 : committedIndex + 1;
    const urls: string[] = [];
    for (const index of [committedIndex, neighbour]) {
      const item = items[index];
      if (!item?.thumbnailUrl) continue;
      if (prefetchedThumbnailsRef.current.has(item.thumbnailUrl)) continue;
      prefetchedThumbnailsRef.current.add(item.thumbnailUrl);
      urls.push(item.thumbnailUrl);
    }
    if (urls.length === 0) return;

    let isCurrent = true;
    void Image.prefetch(urls, { cachePolicy: "memory-disk" }).catch(() => {
      // A failed prefetch just means the card loads its thumbnail normally.
      if (!isCurrent) return;
      for (const url of urls) prefetchedThumbnailsRef.current.delete(url);
    });
    return () => {
      // Marks the in-flight prefetch stale; the card's own <Image> still wins
      // because expo-image dedupes by URL.
      isCurrent = false;
    };
  }, [
    committedIndex,
    direction,
    isActive,
    isScrolling,
    items,
    policy.isThumbnailPrefetchAllowed,
  ]);
}
