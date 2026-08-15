import { useIsFocused } from "@react-navigation/native";
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { usePaginatedQuery } from "convex/react";
import { Redirect, useRouter } from "expo-router";
import { setStatusBarStyle } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Platform,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { FeedVideoItem } from "@/components/feed-video-card";
import { FeedPerformanceDebugOverlay } from "@/components/feed-performance-debug-overlay";
import {
  ShortsEmptyState,
  ShortsErrorState,
  ShortsLoadingState,
  ShortsQueryErrorBoundary,
} from "@/components/shorts-feed-states";
import { ShortsVerticalVideoCell } from "@/components/shorts-vertical-video-cell";
import { api } from "@/convex/_generated/api";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useFeedFeatureFlags } from "@/hooks/use-feed-feature-flags";
import { useShortsScreenPlayback } from "@/hooks/use-shorts-screen-playback";
import { trackFeedEvent } from "@/lib/feed/feed-telemetry";
import {
  resolveShortsAnchorIndex,
  resolveShortsListState,
  shouldLoadMoreShorts,
  shouldShowShortsExhaustedNotice,
  type ShortsFeedStatus,
} from "@/lib/shorts/shorts-paging";
import {
  resolveShortsDrawDistance,
  resolveShortsOverlayInsets,
  resolveShortsPageHeight,
  resolveShortsSnapProps,
} from "@/lib/shorts/shorts-viewport";

const INITIAL_SHORTS_PAGE_SIZE = 8;
const SHORTS_LOAD_MORE_COUNT = 8;
const isDevelopment = typeof __DEV__ !== "undefined" && __DEV__;

const keyExtractor = (item: FeedVideoItem) => item.muxAssetId;

/**
 * Shorts: the full-viewport, vertically paged 9:16 feed.
 *
 * The screen is split in two so a query failure cannot take the tab down with
 * it: this component owns only the viewport measurement, the black surface, and
 * the error boundary, while `ShortsFeed` owns the query, the list, and playback.
 *
 * The outer route is deliberately separate from this enabled screen. That
 * keeps every query, player, preloader, and viewport hook unmounted while the
 * remote kill switch is off, including for a direct/deep link.
 */
export default function ShortsScreen() {
  const { shortsTabEnabled } = useFeedFeatureFlags();
  if (!shortsTabEnabled) return <Redirect href="/" />;
  return <EnabledShortsScreen />;
}

function EnabledShortsScreen() {
  const insets = useSafeAreaInsets();
  const isScreenFocused = useIsFocused();
  const colorScheme = useColorScheme();
  const { height: windowHeight } = useWindowDimensions();
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);
  const [queryAttempt, setQueryAttempt] = useState(0);

  /**
   * The page height is the *measured* content viewport, never a module-level
   * `Dimensions.get("window").height`: a cached window height disagrees with the
   * native tab bar and is captured once for the life of the JS bundle. Layout
   * fires again on rotation and on safe-area changes, so this re-derives itself.
   */
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { height, width } = event.nativeEvent.layout;
    setMeasuredHeight((current) => (current === height ? current : height));
    setMeasuredWidth((current) => (current === width ? current : width));
  }, []);

  const pageHeight = resolveShortsPageHeight({
    measuredHeight,
    windowHeight,
    topInset: insets.top,
    bottomInset: insets.bottom,
  });

  const overlayInsets = useMemo(
    () =>
      resolveShortsOverlayInsets({
        pageHeight,
        windowHeight,
        topInset: insets.top,
        bottomInset: insets.bottom,
      }),
    [insets.bottom, insets.top, pageHeight, windowHeight],
  );

  const handleRetryQuery = useCallback(() => {
    setQueryAttempt((value) => value + 1);
  }, []);

  const handleQueryError = useCallback(
    (message: string) => {
      trackFeedEvent("shorts_query_received", {
        screen: "shorts",
        errorCode: message,
        queryOutcome: "error",
        itemCount: 0,
        pageHeightDp: pageHeight,
      });
      trackFeedEvent("shorts_empty_state_viewed", {
        screen: "shorts",
        emptyReason: "query_error",
        itemCount: 0,
        pageHeightDp: pageHeight,
      });
    },
    [pageHeight],
  );

  // Once per visit, not once per mount: native tabs keep this screen mounted, so
  // a mount-only event would count the first visit and nothing after it.
  useEffect(() => {
    if (!isScreenFocused) return;
    trackFeedEvent("shorts_tab_opened", { screen: "shorts" });
  }, [isScreenFocused]);

  /**
   * Light status-bar content while Shorts is showing, restored on blur.
   *
   * `expo-status-bar`'s component form does not restore a previous style when it
   * unmounts, and native tabs keep this screen mounted after a tab switch, so a
   * declarative `<StatusBar style="light" />` here would leak a light bar onto
   * Home's white feed. Setting it imperatively on focus and putting back the
   * scheme-appropriate style on blur keeps both screens legible.
   */
  useEffect(() => {
    if (!isScreenFocused) return;
    setStatusBarStyle("light", true);
    return () => {
      setStatusBarStyle(colorScheme === "dark" ? "light" : "dark", true);
    };
  }, [colorScheme, isScreenFocused]);

  return (
    <View style={styles.root} onLayout={handleLayout}>
      <ShortsQueryErrorBoundary
        resetKey={queryAttempt}
        onError={handleQueryError}
        fallback={
          <ShortsErrorState insets={overlayInsets} onRetry={handleRetryQuery} />
        }
      >
        <ShortsFeed
          key={queryAttempt}
          pageHeight={pageHeight}
          pageWidth={measuredWidth}
          overlayInsets={overlayInsets}
          hasMeasuredViewport={measuredHeight !== null}
        />
      </ShortsQueryErrorBoundary>
      <FeedPerformanceDebugOverlay />
    </View>
  );
}

type ShortsFeedProps = {
  pageHeight: number;
  pageWidth: number | null;
  overlayInsets: ReturnType<typeof resolveShortsOverlayInsets>;
  /** False until the first layout pass, so paging waits for a real height. */
  hasMeasuredViewport: boolean;
};

function ShortsFeed({
  pageHeight,
  pageWidth,
  overlayInsets,
  hasMeasuredViewport,
}: ShortsFeedProps) {
  const router = useRouter();
  const isTabFocused = useIsFocused();
  const listRef = useRef<FlashListRef<FeedVideoItem> | null>(null);
  const queryStartedAtMsRef = useRef(Date.now());
  const didRecordQueryRef = useRef(false);
  const didRecordEmptyRef = useRef(false);
  const lastImpressionKeyRef = useRef<string | null>(null);

  /**
   * The generated API is cast at this call site to match the repository's feed
   * query convention while preserving the shared FeedVideoItem view contract.
   * The surrounding boundary keeps a transient query failure recoverable.
   */
  const {
    results: shorts,
    status,
    loadMore,
  } = usePaginatedQuery(
    (api as any).feed.listVerticalFeedVideosPaginated,
    {},
    { initialNumItems: INITIAL_SHORTS_PAGE_SIZE },
  ) as {
    results: FeedVideoItem[];
    status: ShortsFeedStatus;
    loadMore: (numItems: number) => void;
  };

  const playback = useShortsScreenPlayback({
    items: shorts,
    isScreenFocused: isTabFocused,
    pageWidth: pageWidth ?? undefined,
  });

  const {
    candidateIndex,
    committedIndex,
    committedMuxAssetId,
    extraData,
    getCellPlayback,
    getThumbnailUrl,
    isMuted,
    listProps,
    retryPlayback,
    toggleMute,
  } = playback;

  const itemCount = shorts.length;
  /**
   * Candidate focus is published on scroll begin/end rather than on every
   * viewability tick, so at the moment a scroll settles it is the freshest
   * index available — ahead of committed focus, which still owes its dwell. That
   * makes it the right input for pagination and diagnostics. A fling that never
   * settles is covered by `onEndReached`.
   */
  const activeIndex = candidateIndex ?? committedIndex;
  const listState = resolveShortsListState({ status, itemCount });

  useEffect(() => {
    trackFeedEvent("feed_query_started", { screen: "shorts" });
  }, []);

  useEffect(() => {
    if (didRecordQueryRef.current || status === "LoadingFirstPage") return;
    didRecordQueryRef.current = true;
    trackFeedEvent("shorts_query_received", {
      screen: "shorts",
      elapsedMs: Date.now() - queryStartedAtMsRef.current,
      queryOutcome: "success",
      itemCount,
      pageHeightDp: pageHeight,
    });
  }, [itemCount, pageHeight, status]);

  useEffect(() => {
    if (didRecordEmptyRef.current || listState !== "empty") return;
    didRecordEmptyRef.current = true;
    trackFeedEvent("shorts_empty_state_viewed", {
      screen: "shorts",
      emptyReason: "no_vertical_assets",
      itemCount,
      pageHeightDp: pageHeight,
    });
  }, [itemCount, listState, pageHeight]);

  // One impression per committed page.
  useEffect(() => {
    if (committedMuxAssetId === null) {
      lastImpressionKeyRef.current = null;
      return;
    }
    const impressionKey = `${committedIndex ?? "none"}:${committedMuxAssetId}`;
    if (lastImpressionKeyRef.current === impressionKey) return;
    lastImpressionKeyRef.current = impressionKey;
    trackFeedEvent("shorts_page_impression", {
      screen: "shorts",
      muxAssetId: committedMuxAssetId,
      feedIndex: committedIndex ?? undefined,
      feedPlacement: "vertical",
      itemCount,
      isMuted,
      pageHeightDp: pageHeight,
    });
  }, [
    committedIndex,
    committedMuxAssetId,
    isMuted,
    itemCount,
    pageHeight,
  ]);

  // Pagination starts a few pages before the end and never blocks paging: it
  // requests the next page and nothing in the render path waits on it.
  useEffect(() => {
    if (!shouldLoadMoreShorts({ status, activeIndex, itemCount })) return;
    loadMore(SHORTS_LOAD_MORE_COUNT);
  }, [activeIndex, itemCount, loadMore, status]);

  const handleEndReached = useCallback(() => {
    if (status !== "CanLoadMore") return;
    loadMore(SHORTS_LOAD_MORE_COUNT);
  }, [loadMore, status]);

  /**
   * Keep the *asset* across a viewport-size or orientation change, not the
   * scroll offset. Every cached item layout is keyed to the old page height, so
   * without this a rotation leaves the list resting between two pages.
   */
  const anchorMuxAssetIdRef = useRef<string | null>(null);
  if (committedMuxAssetId !== null) {
    anchorMuxAssetIdRef.current = committedMuxAssetId;
  }
  const renderedPageHeightRef = useRef(pageHeight);
  const didPageHeightChange = renderedPageHeightRef.current !== pageHeight;
  renderedPageHeightRef.current = pageHeight;
  if (didPageHeightChange) {
    /*
      FlashList's documented contract for this API is "call this before the render
      and not in an effect" — it sets a flag the next layout pass consumes, so
      calling it from an effect would clear the cache one pass too late and the
      list would lay the new page height out against stale offsets. The
      accompanying scrollToIndex belongs in the effect, after that layout.
    */
    listRef.current?.clearLayoutCacheOnUpdate();
  }
  useEffect(() => {
    if (!didPageHeightChange) return;
    const index = resolveShortsAnchorIndex(
      shorts,
      anchorMuxAssetIdRef.current,
      committedIndex,
    );
    if (index === null) return;
    void listRef.current?.scrollToIndex({ index, animated: false });
  }, [committedIndex, didPageHeightChange, shorts]);

  const handleOpenUpload = useCallback(() => {
    router.push("/upload" as never);
  }, [router]);

  const isFeedExhausted = shouldShowShortsExhaustedNotice({
    status,
    activeIndex,
    itemCount,
  });

  const renderItem = useCallback(
    ({
      item,
      index,
      target,
    }: {
      item: FeedVideoItem;
      index: number;
      target: string;
    }) => (
      <ShortsVerticalVideoCell
        item={item}
        pageHeight={pageHeight}
        thumbnailUrl={getThumbnailUrl(item)}
        overlayInsets={overlayInsets}
        isFeedExhausted={isFeedExhausted && index === itemCount - 1}
        // A measurement pass must never own the player surface.
        playback={target === "Cell" ? getCellPlayback(item) : undefined}
        onToggleMute={toggleMute}
        onRetry={retryPlayback}
      />
    ),
    [
      getCellPlayback,
      getThumbnailUrl,
      isFeedExhausted,
      itemCount,
      overlayInsets,
      pageHeight,
      retryPlayback,
      toggleMute,
    ],
  );

  const snapProps = useMemo(
    () => resolveShortsSnapProps(pageHeight, Platform.OS),
    [pageHeight],
  );

  if (listState === "loading" || !hasMeasuredViewport) {
    return <ShortsLoadingState insets={overlayInsets} />;
  }
  if (listState === "empty") {
    return (
      <ShortsEmptyState insets={overlayInsets} onOpenUpload={handleOpenUpload} />
    );
  }

  return (
    <View style={styles.listHost}>
      <FlashList
        ref={listRef}
        data={shorts}
        extraData={extraData}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        {...listProps}
        {...snapProps}
        // Every page is the same height and there is one item type, so the list
        // never has to measure a cell to know where the next one starts.
        drawDistance={resolveShortsDrawDistance(pageHeight)}
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.5}
        showsVerticalScrollIndicator={false}
        // No ListFooterComponent on purpose: a viewport-tall footer would become
        // an extra snap page with no video in it. End-of-feed is an overlay on
        // the last page instead.
        contentContainerStyle={styles.listContent}
        style={styles.list}
      />
      {isDevelopment ? (
        <View style={styles.diagnostics} pointerEvents="none">
          <Text style={styles.diagnosticsText}>
            shorts · active {activeIndex ?? "-"} · committed{" "}
            {committedIndex ?? "-"} · items {itemCount}
          </Text>
          <Text style={styles.diagnosticsText}>
            page {pageHeight}px · {status} · {isMuted ? "muted" : "sound"} ·{" "}
            {Platform.OS === "ios" ? "paging" : "snap"}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#000000",
  },
  listHost: {
    flex: 1,
    backgroundColor: "#000000",
  },
  list: {
    backgroundColor: "#000000",
  },
  listContent: {
    backgroundColor: "#000000",
  },
  diagnostics: {
    position: "absolute",
    top: 8,
    left: 8,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
    backgroundColor: "#000000C8",
  },
  diagnosticsText: {
    color: "#9BE7FF",
    fontSize: 10,
    lineHeight: 14,
  },
});
