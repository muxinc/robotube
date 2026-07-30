import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { PixelRatio, useWindowDimensions } from "react-native";

import type { FeedVideoItem } from "@/components/feed-video-card";
import { useFeedAdaptivePolicy } from "@/hooks/use-feed-adaptive-policy";
import { useFeedFocusController } from "@/hooks/use-feed-focus-controller";
import {
  useFeedPlaybackController,
  type FeedPlaybackSurfaceCallbacks,
  type FeedPlaybackTarget,
} from "@/hooks/use-feed-playback-controller";
import { useFeedPreloader } from "@/hooks/use-feed-preloader";
import {
  resolveThumbnailWidthPx,
  withThumbnailWidth,
} from "@/lib/feed/feed-adaptive-policy";
import { trackFeedEvent } from "@/lib/feed/feed-telemetry";
import { SHORTS_VIEWABILITY_CONFIG } from "@/lib/shorts/shorts-paging";
import {
  createShortsPlaybackIntentState,
  isShortsAssetPausedByViewer,
  resolveShortsShouldPlay,
  shortsPlaybackIntentReducer,
} from "@/lib/shorts/shorts-playback-intent";
import type { MuxVideoPlayer } from "@mux/mux-react-native-player";

/** Identifies the vertical surface separately from Home in Mux Data. */
const SHORTS_PLAYER_NAME = "Robotube shorts";

export type UseShortsScreenPlaybackOptions = {
  items: readonly FeedVideoItem[];
  /** Whether the Shorts tab is focused. */
  isScreenFocused: boolean;
  /** Rendered page width, used to size thumbnails. Defaults to window width. */
  pageWidth?: number;
};

/** Everything one Shorts cell needs from the shared controllers. */
export type ShortsCellPlayback = {
  player: MuxVideoPlayer;
  /** True for the committed cell only. At most one cell may receive true. */
  isActive: boolean;
  /** True once the committed source produced a frame; hides the poster. */
  hasFirstFrame: boolean;
  /** True when this cell's video is playing right now. */
  isPlaying: boolean;
  /** True when the viewer (or policy) is holding this cell paused. */
  isPaused: boolean;
  /** True when this cell's source failed and has not been retried. */
  hasError: boolean;
  isMuted: boolean;
  surface: FeedPlaybackSurfaceCallbacks;
};

export type ShortsScreenPlayback = {
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
  getCellPlayback: (item: FeedVideoItem) => ShortsCellPlayback;
  getThumbnailUrl: (item: FeedVideoItem) => string;
  /** The only index allowed to own a player surface. */
  committedIndex: number | null;
  /** Cheap viewport tracker. Drives pagination and diagnostics, never playback. */
  candidateIndex: number | null;
  committedMuxAssetId: string | null;
  isMuted: boolean;
  /** True when the committed video is playing. */
  isPlaying: boolean;
  /** Policy-level autoplay switch, for the empty/paused affordances. */
  isAutoplayAllowed: boolean;
  toggleMute: () => void;
  togglePlayback: () => void;
  retryPlayback: () => void;
  /** Position handed to video detail so it resumes where the preview was. */
  getPreviewPositionSeconds: (muxAssetId: string) => number;
  /** Primitive FlashList `extraData`; changes only when a cell's output can. */
  extraData: string;
};

/**
 * Composes the shared feed focus controller, single playback controller, bounded
 * preloader, and adaptive policy for the vertical Shorts feed.
 *
 * The Shorts-specific parts are all parameterization, not a second stack:
 *
 *  - viewability requires most of a full-viewport page rather than Home's 65%;
 *  - the autoplay gate is applied when deciding to *play*, not when deciding to
 *    *commit*, so reduced motion still leaves a surface the viewer can press
 *    play on (Home has no manual control, so it gates at commit time);
 *  - viewer intent (session mute, manual pause, retry) is layered on top of the
 *    lifecycle gate; and
 *  - the player reports a Shorts-specific name to Mux Data.
 *
 * One controller per screen is what keeps the one-playing-video invariant true:
 * Home and Shorts each own exactly one, and each pauses on tab blur.
 */
export function useShortsScreenPlayback({
  items,
  isScreenFocused,
  pageWidth,
}: UseShortsScreenPlaybackOptions): ShortsScreenPlayback {
  const { width: windowWidth } = useWindowDimensions();
  const policy = useFeedAdaptivePolicy();
  const [intent, dispatchIntent] = useReducer(
    shortsPlaybackIntentReducer,
    undefined,
    createShortsPlaybackIntentState,
  );

  const focus = useFeedFocusController<FeedVideoItem>({
    itemCount: items.length,
    isScreenFocused,
    // Committing is deliberately not gated on autoplay policy here. Shorts has
    // manual controls, so a reduced-motion or low-data viewer still needs a
    // committed page with a real (paused) surface to press play on. The autoplay
    // decision moves to `resolveShortsShouldPlay` below.
    isAutoplayAllowed: true,
    viewabilityConfig: SHORTS_VIEWABILITY_CONFIG,
    screen: "shorts",
  });

  const committedItem =
    focus.committedIndex === null ? undefined : items[focus.committedIndex];
  const committedMuxAssetId = committedItem?.muxAssetId ?? null;

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

  // Reset per-asset intent whenever focus commits somewhere else, so a pause
  // gesture never carries onto the next video.
  useEffect(() => {
    dispatchIntent({ type: "committedChanged", muxAssetId: committedMuxAssetId });
  }, [committedMuxAssetId]);

  const shouldPlay = resolveShortsShouldPlay({
    state: intent,
    muxAssetId: committedMuxAssetId,
    isFocusPlaybackAllowed: focus.isPlaybackAllowed,
    isScrolling: focus.isScrolling,
    isAutoplayAllowed: policy.isAutoplayAllowed,
  });

  const handleSourceError = useCallback((muxAssetId: string) => {
    dispatchIntent({ type: "playbackFailed", muxAssetId });
  }, []);

  // A surface lost underneath the committed player: drop the commitment so the
  // next idle evaluation rebuilds it against whatever cell is now on screen.
  const reportSurfaceLost = focus.reportSurfaceLost;
  const committedIndexRef = useRef(focus.committedIndex);
  committedIndexRef.current = focus.committedIndex;
  const handleActiveSurfaceLost = useCallback(() => {
    const index = committedIndexRef.current;
    if (index === null) return;
    reportSurfaceLost(index);
  }, [reportSurfaceLost]);

  const controller = useFeedPlaybackController({
    target,
    isPlaybackAllowed: shouldPlay,
    muted: intent.isMuted,
    maxResolution: policy.maxResolution,
    playerName: SHORTS_PLAYER_NAME,
    sourceAttempt: intent.retryNonce,
    onSourceErrorReported: handleSourceError,
    onActiveSurfaceLost: handleActiveSurfaceLost,
    screen: "shorts",
  });

  const thumbnailWidthPx = useMemo(
    () => resolveThumbnailWidthPx(pageWidth ?? windowWidth, PixelRatio.get()),
    [pageWidth, windowWidth],
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

  /**
   * Bounded direction-aware preload: the committed item plus one likely next
   * item, suspended during a fling, on blur, in low-data mode, and under memory
   * pressure.
   *
   * What this actually warms on Shorts today is the **next page's thumbnail**,
   * not its media. `@mux/mux-react-native-player@0.1.10` exposes no data-only
   * preload API — every playback function is declared inside `View(MuxVideoView)`
   * and a source only reaches native through a mounted view's `source` prop, so
   * an unattached player downloads zero bytes (see the evidence block in
   * `lib/feed/feed-preloader.ts`). The shipped preloader is therefore a no-op
   * recorder, and the honest fail-safe is what the cell already does: hold the
   * poster until the committed source produces its own first frame. Swiping to a
   * cold page costs a cold start, and no claim of a warm first frame is made for
   * it. Passing a real `preloader` here is the only change needed once such an
   * API exists.
   */
  useFeedPreloader({
    items: preloadItems,
    committedIndex: focus.committedIndex,
    direction: focus.direction,
    isScrolling: focus.isScrolling,
    // Preload follows lifecycle and focus, not viewer intent: a manually paused
    // page should still have its neighbour prepared.
    isActive: focus.isPlaybackAllowed,
    policy,
    screen: "shorts",
  });

  const isPausedByViewer = isShortsAssetPausedByViewer(
    intent,
    committedMuxAssetId,
    policy.isAutoplayAllowed,
  );

  /**
   * The playback state the viewer sees, which deliberately ignores the transient
   * pause taken while the list is settling.
   *
   * Using the real transport state here instead would flip the play/pause icon
   * on every swipe, and would make a tap that lands during a settle read as
   * "resume" and set the wrong intent.
   */
  const isPlaying =
    committedMuxAssetId !== null &&
    !isPausedByViewer &&
    intent.failedMuxAssetId !== committedMuxAssetId;

  const toggleMute = useCallback(() => {
    dispatchIntent({ type: "toggleMute" });
    // `intent.isMuted` is this render's value, so the event names the new state.
    trackFeedEvent(intent.isMuted ? "shorts_unmuted" : "shorts_muted", {
      screen: "shorts",
      muxAssetId: committedMuxAssetId ?? undefined,
    });
  }, [committedMuxAssetId, intent.isMuted]);

  const togglePlayback = useCallback(() => {
    if (committedMuxAssetId === null) return;
    dispatchIntent({
      type: "togglePlayback",
      muxAssetId: committedMuxAssetId,
      isPlaying,
    });
    trackFeedEvent(isPlaying ? "shorts_manual_pause" : "shorts_manual_resume", {
      screen: "shorts",
      muxAssetId: committedMuxAssetId,
      feedIndex: focus.committedIndex ?? undefined,
    });
  }, [committedMuxAssetId, focus.committedIndex, isPlaying]);

  const retryPlayback = useCallback(() => {
    if (committedMuxAssetId === null) return;
    dispatchIntent({ type: "retryRequested", muxAssetId: committedMuxAssetId });
    trackFeedEvent("shorts_retry_playback", {
      screen: "shorts",
      muxAssetId: committedMuxAssetId,
      feedIndex: focus.committedIndex ?? undefined,
    });
  }, [committedMuxAssetId, focus.committedIndex]);

  const getCellPlayback = useCallback(
    (item: FeedVideoItem): ShortsCellPlayback => {
      const isActive = controller.activeMuxAssetId === item.muxAssetId;
      return {
        player: controller.player,
        isActive,
        hasFirstFrame: controller.hasFirstFrame,
        isPlaying: isActive && isPlaying,
        isPaused: isActive && isPausedByViewer,
        // Every playback-state flag is scoped to the active cell. The
        // play/pause and retry controls act on the committed asset, so a
        // pre-rendered neighbour must not display them.
        hasError: isActive && intent.failedMuxAssetId === item.muxAssetId,
        isMuted: intent.isMuted,
        surface: controller.surface,
      };
    },
    [
      controller,
      intent.failedMuxAssetId,
      intent.isMuted,
      isPausedByViewer,
      isPlaying,
    ],
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
    getCellPlayback,
    getThumbnailUrl,
    committedIndex: focus.committedIndex,
    candidateIndex: focus.candidateIndex,
    committedMuxAssetId,
    isMuted: intent.isMuted,
    isPlaying,
    isAutoplayAllowed: policy.isAutoplayAllowed,
    toggleMute,
    togglePlayback,
    retryPlayback,
    getPreviewPositionSeconds: controller.getPreviewPositionSeconds,
    extraData: [
      controller.activeMuxAssetId ?? "",
      controller.hasFirstFrame ? 1 : 0,
      isPlaying ? 1 : 0,
      isPausedByViewer ? 1 : 0,
      intent.isMuted ? 1 : 0,
      intent.failedMuxAssetId ?? "",
      thumbnailWidthPx,
    ].join("|"),
  };
}
