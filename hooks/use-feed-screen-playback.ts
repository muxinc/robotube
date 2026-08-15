import { useCallback, useMemo, useState } from "react";
import { PixelRatio, useWindowDimensions } from "react-native";

import type { FeedVideoCardPlayback, FeedVideoItem } from "@/components/feed-video-card";
import { useFeedAdaptivePolicy } from "@/hooks/use-feed-adaptive-policy";
import { useFeedFocusController } from "@/hooks/use-feed-focus-controller";
import {
  useFeedPlaybackController,
  type FeedPlaybackTarget,
} from "@/hooks/use-feed-playback-controller";
import { useFeedPreloader } from "@/hooks/use-feed-preloader";
import {
  resolveThumbnailWidthPx,
  withThumbnailWidth,
} from "@/lib/feed/feed-adaptive-policy";
import {
  trackFeedEvent,
  type FeedTelemetryScreen,
} from "@/lib/feed/feed-telemetry";

export type UseFeedScreenPlaybackOptions = {
  items: readonly FeedVideoItem[];
  /** Whether the hosting tab/screen is focused. */
  isScreenFocused: boolean;
  screen: FeedTelemetryScreen;
};

export type FeedScreenPlayback = {
  /** Spread onto the FlashList. Stable identities; safe on the scroll path. */
  listProps: {
    onViewableItemsChanged: ReturnType<
      typeof useFeedFocusController<FeedVideoItem>
    >["onViewableItemsChanged"];
    viewabilityConfig: { itemVisiblePercentThreshold: number; minimumViewTime: number };
    onScrollBeginDrag: () => void;
    onScrollEndDrag: () => void;
    onMomentumScrollBegin: () => void;
    onMomentumScrollEnd: () => void;
    onScroll: ReturnType<typeof useFeedFocusController<FeedVideoItem>>["onScroll"];
    scrollEventThrottle: number;
  };
  /** Playback props for one card, or undefined when the card stays static. */
  getCardPlayback: (item: FeedVideoItem) => FeedVideoCardPlayback;
  /** Width-resolved thumbnail for a card. */
  getThumbnailUrl: (item: FeedVideoItem) => string;
  /**
   * Primitive that changes only when a card's rendered output can change.
   * Use as FlashList `extraData` instead of a fresh object every render.
   */
  extraData: string;
};

/**
 * Composes the feed focus controller, the single shared playback controller, the
 * bounded preload policy and the adaptive media policy into one wiring that the
 * Home feed and the search results screen share verbatim.
 *
 * Sharing this hook keeps the one-active-player guarantee true across screens:
 * only the focused screen allocates a player, and a card can only be active
 * when its `muxAssetId` matches that controller's committed asset.
 */
export function useFeedScreenPlayback({
  items,
  isScreenFocused,
  screen,
}: UseFeedScreenPlaybackOptions): FeedScreenPlayback {
  const { width } = useWindowDimensions();
  const policy = useFeedAdaptivePolicy();

  /**
   * YouTube-style preview sound: the autoplaying card plays with audio, and a
   * speaker toggle on the preview silences it. Session-scoped — the choice
   * survives scrolling and card changes, but the next app session starts with
   * sound again. Sound only exists while the preview is actually playing, so
   * the policy gates (reduced motion, low data) that stop autoplay also stop
   * audio for free.
   */
  const [isMuted, setIsMuted] = useState(false);
  const toggleMute = useCallback(() => {
    setIsMuted((current) => {
      trackFeedEvent(current ? "feed_preview_unmuted" : "feed_preview_muted", {
        screen,
        isMuted: !current,
      });
      return !current;
    });
  }, [screen]);

  const focus = useFeedFocusController<FeedVideoItem>({
    itemCount: items.length,
    isScreenFocused,
    isAutoplayAllowed: policy.isAutoplayAllowed,
    screen,
  });

  const committedItem =
    focus.committedIndex === null ? undefined : items[focus.committedIndex];

  const target = useMemo<FeedPlaybackTarget | null>(() => {
    if (!committedItem || focus.committedIndex === null) return null;
    if (!committedItem.playbackId) return null;
    return {
      muxAssetId: committedItem.muxAssetId,
      playbackId: committedItem.playbackId,
      title: committedItem.title,
      index: focus.committedIndex,
    };
  }, [committedItem, focus.committedIndex]);

  const controller = useFeedPlaybackController({
    isPlayerEnabled: isScreenFocused,
    target,
    isPlaybackAllowed: focus.isPlaybackAllowed,
    muted: isMuted,
    maxResolution: policy.maxResolution,
    screen,
  });

  const thumbnailWidthPx = useMemo(
    () => resolveThumbnailWidthPx(width, PixelRatio.get()),
    [width],
  );

  const getThumbnailUrl = useCallback(
    (item: FeedVideoItem) => withThumbnailWidth(item.thumbnailUrl, thumbnailWidthPx),
    [thumbnailWidthPx],
  );

  const preloadItems = useMemo(
    () =>
      items.map((item) => ({
        muxAssetId: item.muxAssetId,
        playbackId: item.playbackId,
        thumbnailUrl: withThumbnailWidth(item.thumbnailUrl, thumbnailWidthPx),
      })),
    [items, thumbnailWidthPx],
  );

  useFeedPreloader({
    items: preloadItems,
    committedIndex: focus.committedIndex,
    direction: focus.direction,
    isScrolling: focus.isScrolling,
    isActive: focus.isPlaybackAllowed,
    policy,
    screen,
  });

  const getCardPlayback = useCallback(
    (item: FeedVideoItem): FeedVideoCardPlayback => ({
      player: controller.player,
      isActive: controller.activeMuxAssetId === item.muxAssetId,
      hasFirstFrame: controller.hasFirstFrame,
      surface: controller.surface,
      getPreviewPositionSeconds: controller.getPreviewPositionSeconds,
      isMuted,
      onToggleMute: toggleMute,
    }),
    [controller, isMuted, toggleMute],
  );

  const listProps = useMemo(
    () => ({
      onViewableItemsChanged: focus.onViewableItemsChanged,
      viewabilityConfig: focus.viewabilityConfig,
      onScrollBeginDrag: focus.onScrollBeginDrag,
      onScrollEndDrag: focus.onScrollEndDrag,
      onMomentumScrollBegin: focus.onMomentumScrollBegin,
      onMomentumScrollEnd: focus.onMomentumScrollEnd,
      onScroll: focus.onScroll,
      scrollEventThrottle: 16,
    }),
    [
      focus.onMomentumScrollBegin,
      focus.onMomentumScrollEnd,
      focus.onScroll,
      focus.onScrollBeginDrag,
      focus.onScrollEndDrag,
      focus.onViewableItemsChanged,
      focus.viewabilityConfig,
    ],
  );

  return {
    listProps,
    getCardPlayback,
    getThumbnailUrl,
    extraData: `${controller.activeMuxAssetId ?? ""}|${controller.hasFirstFrame ? 1 : 0}|${isMuted ? 1 : 0}|${thumbnailWidthPx}`,
  };
}
