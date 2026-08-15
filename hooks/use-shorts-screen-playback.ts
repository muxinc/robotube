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
import { createMuxMediaFeedPreloader } from "@/lib/feed/mux-media-preloader";
import { feedPreloadCacheKey } from "@/lib/feed/feed-preload-policy";
import { trackFeedEvent } from "@/lib/feed/feed-telemetry";
import {
  SHORTS_FOCUS_TIMINGS,
  SHORTS_VIEWABILITY_CONFIG,
} from "@/lib/shorts/shorts-paging";
import {
  EMPTY_SHORTS_SLOT_ASSIGNMENT,
  resolveShortsSlotAssignment,
  resolveShortsStandbyIndex,
  type ShortsSlotAssignment,
  type ShortsSlotId,
} from "@/lib/shorts/shorts-player-slots";
import {
  createShortsPlaybackIntentState,
  isShortsAssetPausedByViewer,
  resolveShortsShouldPlay,
  shortsPlaybackIntentReducer,
  shortsRetryNonceFor,
} from "@/lib/shorts/shorts-playback-intent";
import type { MuxVideoPlayer } from "@mux/mux-react-native-player";

/**
 * Identifies the vertical surfaces separately from Home in Mux Data. The two
 * slots need distinct names: on iOS, `MUXSDKStats` keys player bindings by
 * name, and the active and standby surfaces are monitored concurrently. Each
 * name is fixed to its slot for the life of the screen — a name that followed
 * the *role* would change the source metadata on every promote.
 */
const SHORTS_PLAYER_NAMES: Record<ShortsSlotId, string> = {
  a: "Robotube shorts A",
  b: "Robotube shorts B",
};

export type UseShortsScreenPlaybackOptions = {
  items: readonly FeedVideoItem[];
  /** Whether the Shorts tab is focused. */
  isScreenFocused: boolean;
  /** Rendered page width, used to size thumbnails. Defaults to window width. */
  pageWidth?: number;
};

/**
 * Everything one Shorts cell needs from the shared controllers. Supplied only
 * to cells bound to a player slot: the committed page (active, playing) and
 * the predicted next page (standby — paused, muted, pre-rendered to its first
 * frame so the swipe never shows a thumbnail). Every other cell gets
 * `undefined` and renders poster-only.
 */
export type ShortsCellPlayback = {
  player: MuxVideoPlayer | null;
  /** True for the committed cell only. At most one cell may receive true. */
  isActive: boolean;
  /** True once this cell's source produced a frame; hides the poster. */
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
  /** Slot playback for the committed and standby cells; undefined otherwise. */
  getCellPlayback: (item: FeedVideoItem) => ShortsCellPlayback | undefined;
  getThumbnailUrl: (item: FeedVideoItem) => string;
  /** The index whose surface is allowed to play. */
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
  /** Primitive FlashList `extraData`; changes only when a cell's output can. */
  extraData: string;
};

/**
 * Composes the shared feed focus controller, a two-slot playback stack, the
 * bounded preloader, and adaptive policy for the vertical Shorts feed.
 *
 * Two playback controllers (each owning one player) leapfrog through the feed:
 * the *active* slot plays the committed page, while the *standby* slot mounts
 * a paused, muted surface inside the predicted next page and renders its first
 * frame off-screen. Committing to that page requires no source replacement —
 * the standby simply starts playing and the vacated slot rebinds to the new
 * prediction. Combined with native media preloading, this is what makes a
 * swipe land on moving video instead of a thumbnail.
 *
 * The rest is parameterization, not a second stack:
 *
 *  - viewability requires most of a full-viewport page rather than Home's 65%;
 *  - the autoplay gate is applied when deciding to *play*, not when deciding to
 *    *commit*, so reduced motion still leaves a surface the viewer can press
 *    play on (Home has no manual control, so it gates at commit time);
 *  - viewer intent (session mute, manual pause, retry) is layered on top of the
 *    lifecycle gate; and
 *  - each slot reports a fixed Shorts-specific name to Mux Data.
 *
 * Only the focused feed owns players. Native tabs retain inactive routes, so
 * allocation as well as playback is gated by tab focus.
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
    // Tighter settle/dwell than Home: a paged list has one unambiguous
    // candidate, and every millisecond here delays the next video's start.
    timings: SHORTS_FOCUS_TIMINGS,
    screen: "shorts",
  });

  const committedItem =
    focus.committedIndex === null ? undefined : items[focus.committedIndex];
  const committedMuxAssetId = committedItem?.muxAssetId ?? null;

  const standbyIndex = resolveShortsStandbyIndex(
    items.length,
    focus.committedIndex,
    focus.direction,
  );
  // The standby slot streams real media ahead of need, so it obeys the same
  // policy gate as media preloading: low-data mode and memory pressure fall
  // back to single-player, poster-first behaviour.
  const standbyMuxAssetId =
    standbyIndex === null || !policy.isMediaPreloadAllowed
      ? null
      : (items[standbyIndex]?.muxAssetId ?? null);

  /**
   * Slot assignment persists across renders in a ref and is re-resolved during
   * render (the resolver is pure and identity-stable). An asset keeps its slot
   * across a promote — that continuity is the entire feature: the promoted
   * slot's target does not change, so its already-rendered player just plays.
   */
  const slotAssignmentRef = useRef<ShortsSlotAssignment>(
    EMPTY_SHORTS_SLOT_ASSIGNMENT,
  );
  const assignment = resolveShortsSlotAssignment(
    slotAssignmentRef.current,
    committedMuxAssetId,
    standbyMuxAssetId,
  );
  slotAssignmentRef.current = assignment;

  const targetA = useSlotTarget(items, assignment.a);
  const targetB = useSlotTarget(items, assignment.b);

  // Reset per-asset intent whenever focus commits somewhere else, so a pause
  // gesture never carries onto the next video.
  useEffect(() => {
    dispatchIntent({ type: "committedChanged", muxAssetId: committedMuxAssetId });
  }, [committedMuxAssetId]);

  const shouldPlay = resolveShortsShouldPlay({
    state: intent,
    muxAssetId: committedMuxAssetId,
    isFocusPlaybackAllowed: focus.isPlaybackAllowed,
    isAutoplayAllowed: policy.isAutoplayAllowed,
  });

  const handleSourceError = useCallback((muxAssetId: string) => {
    dispatchIntent({ type: "playbackFailed", muxAssetId });
  }, []);

  // A surface lost underneath the committed player: drop the commitment so the
  // next idle evaluation rebuilds it against whatever cell is now on screen.
  // Scoped per slot — a recycled *standby* surface is routine (its slot simply
  // rebinds later) and must not disturb committed focus.
  const reportSurfaceLost = focus.reportSurfaceLost;
  const committedIndexRef = useRef(focus.committedIndex);
  committedIndexRef.current = focus.committedIndex;
  const makeSurfaceLostHandler = useCallback(
    (slotId: ShortsSlotId) => () => {
      if (slotAssignmentRef.current.active !== slotId) return;
      const index = committedIndexRef.current;
      if (index === null) return;
      reportSurfaceLost(index);
    },
    [reportSurfaceLost],
  );
  const handleSurfaceLostA = useMemo(
    () => makeSurfaceLostHandler("a"),
    [makeSurfaceLostHandler],
  );
  const handleSurfaceLostB = useMemo(
    () => makeSurfaceLostHandler("b"),
    [makeSurfaceLostHandler],
  );

  const isSlotAActive = assignment.active === "a";
  const controllerA = useFeedPlaybackController({
    isPlayerEnabled: isScreenFocused,
    target: targetA,
    // The standby slot loads, buffers, and renders its first frame, but never
    // plays: promotion flips this gate, and that flip is the whole hand-off.
    isPlaybackAllowed: isSlotAActive && shouldPlay,
    muted: isSlotAActive ? intent.isMuted : true,
    maxResolution: policy.maxResolution,
    playerName: SHORTS_PLAYER_NAMES.a,
    sourceAttempt: shortsRetryNonceFor(intent, assignment.a),
    onSourceErrorReported: handleSourceError,
    onActiveSurfaceLost: handleSurfaceLostA,
    screen: "shorts",
  });
  const controllerB = useFeedPlaybackController({
    isPlayerEnabled: isScreenFocused,
    target: targetB,
    isPlaybackAllowed: !isSlotAActive && assignment.active === "b" && shouldPlay,
    muted: assignment.active === "b" ? intent.isMuted : true,
    maxResolution: policy.maxResolution,
    playerName: SHORTS_PLAYER_NAMES.b,
    sourceAttempt: shortsRetryNonceFor(intent, assignment.b),
    onSourceErrorReported: handleSourceError,
    onActiveSurfaceLost: handleSurfaceLostB,
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
   * Bounded direction-aware preload: thumbnails plus native media preload
   * (`preloadMuxVideo` from `@mux/mux-react-native-player@0.1.13`), suspended
   * during a fling, on blur, in low-data mode, and under memory pressure.
   *
   * With the two-slot player stack, the committed and standby assets are
   * already streaming through real players — the standby slot *is* their
   * preloader. Starting a native media preload for those same assets would
   * fetch every startup byte twice and contend with the slots for bandwidth,
   * so slot-bound assets are skipped here. The native preloader still covers
   * anything the policy window opens beyond the slots (a wider `preloadAhead`
   * on Wi-Fi, the behind-item when scrolling reverses), and on iOS a pool item
   * it warmed earlier is adopted outright by the slot view that binds the same
   * asset. Everything stays best-effort: without the native API (Expo Go, web)
   * the cells' poster-first fallback covers cold starts exactly as before.
   */
  const mediaPreloader = useMemo(() => {
    const preloader = createMuxMediaFeedPreloader("shorts");
    return {
      ...preloader,
      start(request) {
        const { a, b } = slotAssignmentRef.current;
        if (request.muxAssetId === a || request.muxAssetId === b) return;
        preloader.start(request);
      },
    } satisfies ReturnType<typeof createMuxMediaFeedPreloader>;
  }, []);
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
    preloader: mediaPreloader,
  });

  // Close the preload telemetry loop: a commit is the moment a preloaded
  // source is (or is not) consumed, which is what turns the preloader's
  // start/accept bookkeeping into cache-hit metrics.
  const committedPlaybackId = committedItem?.playbackId ?? null;
  useEffect(() => {
    if (committedPlaybackId === null) return;
    mediaPreloader.promoteToActive(
      feedPreloadCacheKey({
        playbackId: committedPlaybackId,
        maxResolution: policy.maxResolution,
      }),
    );
  }, [committedPlaybackId, mediaPreloader, policy.maxResolution]);

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
      isMuted: !intent.isMuted,
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
      retryAttempt: shortsRetryNonceFor(intent, committedMuxAssetId) + 1,
    });
  }, [committedMuxAssetId, focus.committedIndex, intent]);

  const getCellPlayback = useCallback(
    (item: FeedVideoItem): ShortsCellPlayback | undefined => {
      const slotId: ShortsSlotId | null =
        assignment.a === item.muxAssetId
          ? "a"
          : assignment.b === item.muxAssetId
            ? "b"
            : null;
      if (slotId === null) return undefined;
      const controller = slotId === "a" ? controllerA : controllerB;
      const isActive = slotId === assignment.active;
      // Guard against a slot mid-rebind: hand the player over only once the
      // controller's bound asset agrees with the assignment.
      const isBound = controller.activeMuxAssetId === item.muxAssetId;
      return {
        player: isBound ? controller.player : null,
        isActive,
        hasFirstFrame: isBound && controller.hasFirstFrame,
        isPlaying: isActive && isPlaying,
        isPaused: isActive && isPausedByViewer,
        // Interaction-state flags are scoped to the active cell. The
        // play/pause and retry controls act on the committed asset, so a
        // pre-rendered standby neighbour must not display them.
        hasError: isActive && intent.failedMuxAssetId === item.muxAssetId,
        isMuted: intent.isMuted,
        surface: controller.surface,
      };
    },
    [
      assignment,
      controllerA,
      controllerB,
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
    extraData: [
      assignment.a ?? "",
      assignment.b ?? "",
      assignment.active ?? "",
      controllerA.hasFirstFrame ? 1 : 0,
      controllerB.hasFirstFrame ? 1 : 0,
      isPlaying ? 1 : 0,
      isPausedByViewer ? 1 : 0,
      intent.isMuted ? 1 : 0,
      intent.failedMuxAssetId ?? "",
      thumbnailWidthPx,
    ].join("|"),
  };
}

/** Playback target for whatever asset a slot is bound to, or null when idle. */
function useSlotTarget(
  items: readonly FeedVideoItem[],
  muxAssetId: string | null,
): FeedPlaybackTarget | null {
  return useMemo(() => {
    if (muxAssetId === null) return null;
    const index = items.findIndex((item) => item.muxAssetId === muxAssetId);
    if (index < 0) return null;
    const item = items[index];
    if (!item.playbackId) return null;
    return {
      muxAssetId: item.muxAssetId,
      playbackId: item.playbackId,
      title: item.title,
      index,
    };
  }, [items, muxAssetId]);
}
