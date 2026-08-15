import { type ViewToken } from "@shopify/flash-list";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";

import {
  DEFAULT_FEED_FOCUS_TIMINGS,
  createFeedFocusState,
  feedFocusReducer,
  isPlaybackAllowed,
  isScrollActive,
  type FeedFocusEvent,
  type FeedFocusState,
  type FeedFocusTimings,
  type FeedScrollDirection,
} from "@/lib/feed/feed-focus-machine";
import {
  trackFeedEvent,
  type FeedTelemetryScreen,
} from "@/lib/feed/feed-telemetry";

export type FeedViewabilityConfig = {
  itemVisiblePercentThreshold: number;
  minimumViewTime: number;
};

export type UseFeedFocusControllerOptions = {
  /** Number of rows currently in the list. Used to invalidate stale focus. */
  itemCount: number;
  /** Whether the hosting screen/tab is focused. */
  isScreenFocused: boolean;
  /** Policy-level autoplay switch (reduced motion, low data, low-tier device). */
  isAutoplayAllowed?: boolean;
  timings?: FeedFocusTimings;
  /**
   * Viewability thresholds for this list's item geometry. Full-viewport pages
   * need a higher visible percentage than Home's 16:9 cards, where several rows
   * legitimately share the viewport.
   *
   * Captured once on mount: FlashList does not support changing
   * `viewabilityConfig` on the fly, so a later value is ignored on purpose
   * rather than silently producing a list that disagrees with its own config.
   */
  viewabilityConfig?: FeedViewabilityConfig;
  screen?: FeedTelemetryScreen;
};

export type FeedFocusController<T> = {
  /** Cheap value that tracks the viewport during scroll. Never drives playback. */
  candidateIndex: number | null;
  /** The only index allowed to own a player surface. */
  committedIndex: number | null;
  /** True when the list is dragging, in momentum, or waiting to settle. */
  isScrolling: boolean;
  /** True when focus, app state and policy all permit playback. */
  isPlaybackAllowed: boolean;
  direction: FeedScrollDirection;
  onViewableItemsChanged: (info: { viewableItems: ViewToken<T>[] }) => void;
  viewabilityConfig: FeedViewabilityConfig;
  onScrollBeginDrag: () => void;
  onScrollEndDrag: () => void;
  onMomentumScrollBegin: () => void;
  onMomentumScrollEnd: () => void;
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  /** Called by a card when its surface is torn down by recycling/unmount. */
  reportSurfaceLost: (index: number) => void;
};

/** Home's card geometry: several 16:9 rows can share the viewport. */
const VIEWABILITY_CONFIG: FeedViewabilityConfig = {
  itemVisiblePercentThreshold: 65,
  minimumViewTime: 100,
};

/**
 * Owns candidate focus and committed focus for a feed list.
 *
 * Everything on the scroll-critical path (viewability, scroll offsets, drag and
 * momentum callbacks) mutates a ref-held state object and never re-renders the
 * list. Only a committed-focus change publishes new React state, so a fast fling
 * produces zero player creation, release, attach or source replacement.
 */
export function useFeedFocusController<T>({
  itemCount,
  isScreenFocused,
  isAutoplayAllowed = true,
  timings = DEFAULT_FEED_FOCUS_TIMINGS,
  viewabilityConfig,
  screen = "home",
}: UseFeedFocusControllerOptions): FeedFocusController<T> {
  // Frozen for the life of the list, alongside `onViewableItemsChanged`.
  const viewabilityConfigRef = useRef(viewabilityConfig ?? VIEWABILITY_CONFIG);
  const stateRef = useRef<FeedFocusState>(
    createFeedFocusState({
      itemCount,
      isScreenFocused,
      isAutoplayAllowed,
      isAppActive: AppState.currentState === "active",
      idleSinceMs: Date.now(),
    }),
  );
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [publishedState, setPublishedState] = useState(() => ({
    committedIndex: stateRef.current.committedIndex,
    isPlaybackAllowed: isPlaybackAllowed(stateRef.current),
    isScrolling: isScrollActive(stateRef.current),
  }));

  const clearSettleTimer = useCallback(() => {
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }, []);

  /**
   * Applies one event and republishes React state only when something the UI
   * renders actually changed.
   */
  const dispatch = useCallback(
    (event: FeedFocusEvent) => {
      const previous = stateRef.current;
      const { state, scheduleSettleInMs } = feedFocusReducer(previous, event, timings);
      stateRef.current = state;

      if (state.candidateIndex !== previous.candidateIndex) {
        trackFeedEvent("feed_candidate_changed", {
          screen,
          feedIndex: state.candidateIndex ?? undefined,
        });
      }
      if (state.committedIndex !== previous.committedIndex) {
        trackFeedEvent("feed_focus_committed", {
          screen,
          feedIndex: state.committedIndex ?? undefined,
        });
      }

      if (scheduleSettleInMs !== null) {
        clearSettleTimer();
        settleTimerRef.current = setTimeout(() => {
          settleTimerRef.current = null;
          dispatch({ type: "settleElapsed", nowMs: Date.now() });
        }, scheduleSettleInMs);
      } else if (event.type === "dragBegin" || event.type === "momentumBegin") {
        clearSettleTimer();
      }

      const nextPublished = {
        committedIndex: state.committedIndex,
        isPlaybackAllowed: isPlaybackAllowed(state),
        isScrolling: isScrollActive(state),
      };
      setPublishedState((current) =>
        current.committedIndex === nextPublished.committedIndex &&
        current.isPlaybackAllowed === nextPublished.isPlaybackAllowed &&
        current.isScrolling === nextPublished.isScrolling
          ? current
          : nextPublished,
      );
    },
    [clearSettleTimer, screen, timings],
  );

  useEffect(() => {
    dispatch({ type: "itemCountChange", itemCount, nowMs: Date.now() });
  }, [dispatch, itemCount]);

  useEffect(() => {
    dispatch({ type: "screenFocusChange", isFocused: isScreenFocused, nowMs: Date.now() });
  }, [dispatch, isScreenFocused]);

  useEffect(() => {
    dispatch({
      type: "autoplayPolicyChange",
      isAllowed: isAutoplayAllowed,
      nowMs: Date.now(),
    });
  }, [dispatch, isAutoplayAllowed]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextAppState) => {
      dispatch({
        type: "appStateChange",
        isActive: nextAppState === "active",
        nowMs: Date.now(),
      });
    });
    return () => subscription.remove();
  }, [dispatch]);

  useEffect(() => clearSettleTimer, [clearSettleTimer]);

  // `onViewableItemsChanged` must keep a stable identity for the lifetime of the
  // list: FlashList/VirtualizedList reject a changing callback identity.
  const dispatchRef = useRef(dispatch);
  useEffect(() => {
    dispatchRef.current = dispatch;
  }, [dispatch]);

  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken<T>[] }) => {
      const indexes: number[] = [];
      for (const token of viewableItems) {
        if (token.index !== null && token.index !== undefined) indexes.push(token.index);
      }
      if (indexes.length === 0) return;
      dispatchRef.current({ type: "viewable", indexes, nowMs: Date.now() });
    },
  ).current;

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      dispatch({ type: "scroll", offsetY: event.nativeEvent.contentOffset.y });
    },
    [dispatch],
  );

  const onScrollBeginDrag = useCallback(() => dispatch({ type: "dragBegin" }), [dispatch]);
  const onScrollEndDrag = useCallback(
    () => dispatch({ type: "dragEnd", nowMs: Date.now() }),
    [dispatch],
  );
  const onMomentumScrollBegin = useCallback(
    () => dispatch({ type: "momentumBegin" }),
    [dispatch],
  );
  const onMomentumScrollEnd = useCallback(
    () => dispatch({ type: "momentumEnd", nowMs: Date.now() }),
    [dispatch],
  );
  const reportSurfaceLost = useCallback(
    (index: number) => dispatch({ type: "surfaceLost", index, nowMs: Date.now() }),
    [dispatch],
  );

  return useMemo(
    () => ({
      candidateIndex: stateRef.current.candidateIndex,
      committedIndex: publishedState.committedIndex,
      isScrolling: publishedState.isScrolling,
      isPlaybackAllowed: publishedState.isPlaybackAllowed,
      direction: stateRef.current.direction,
      onViewableItemsChanged,
      viewabilityConfig: viewabilityConfigRef.current,
      onScrollBeginDrag,
      onScrollEndDrag,
      onMomentumScrollBegin,
      onMomentumScrollEnd,
      onScroll,
      reportSurfaceLost,
    }),
    [
      onMomentumScrollBegin,
      onMomentumScrollEnd,
      onScroll,
      onScrollBeginDrag,
      onScrollEndDrag,
      onViewableItemsChanged,
      publishedState,
      reportSurfaceLost,
    ],
  );
}
