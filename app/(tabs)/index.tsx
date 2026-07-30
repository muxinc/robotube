import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { useIsFocused, useScrollToTop } from "@react-navigation/native";
import { usePaginatedQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";

import {
  FeedVideoCard,
  type FeedVideoItem,
} from "@/components/feed-video-card";
import { FeedPerformanceDebugOverlay } from "@/components/feed-performance-debug-overlay";
import { LiveNowSection } from "@/components/live-now-section";
import { TabPageLogoHeader } from "@/components/tab-page-logo-header";
import { api } from "@/convex/_generated/api";
import { useFeedFeatureFlags } from "@/hooks/use-feed-feature-flags";
import { useFeedScreenPlayback } from "@/hooks/use-feed-screen-playback";
import { trackFeedEvent } from "@/lib/feed/feed-telemetry";

const INITIAL_FEED_PAGE_SIZE = 16;
const FEED_LOAD_MORE_COUNT = 12;

const keyExtractor = (item: FeedVideoItem) => item.muxAssetId;

export default function HomePage() {
  const router = useRouter();
  const isTabFocused = useIsFocused();
  const { exclusiveFeedPlacementEnabled } = useFeedFeatureFlags();
  const feedListRef = useRef<FlashListRef<FeedVideoItem> | null>(null);
  const queryStartedAtRef = useRef(Date.now());
  const didRecordQueryRef = useRef(false);
  const didRecordFirstCardsRef = useRef(false);
  const {
    results: feedVideos,
    status: feedStatus,
    loadMore,
  } = usePaginatedQuery(
    exclusiveFeedPlacementEnabled
      ? (api as any).feed.listStandardFeedVideosPaginated
      : (api as any).feed.listFeedVideosPaginated,
    {},
    { initialNumItems: INITIAL_FEED_PAGE_SIZE },
  ) as {
    results: FeedVideoItem[];
    status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";
    loadMore: (numItems: number) => void;
  };
  const { listProps, getCardPlayback, getThumbnailUrl, extraData } =
    useFeedScreenPlayback({
      items: feedVideos,
      isScreenFocused: isTabFocused,
      screen: "home",
    });
  const isFeedLoading = feedStatus === "LoadingFirstPage";
  const isLoadingMore = feedStatus === "LoadingMore";

  useScrollToTop(feedListRef);

  useEffect(() => {
    trackFeedEvent("feed_query_started", { screen: "home" });
  }, []);

  useEffect(() => {
    if (
      didRecordQueryRef.current ||
      feedStatus === "LoadingFirstPage"
    ) {
      return;
    }
    didRecordQueryRef.current = true;
    trackFeedEvent("feed_query_received", {
      screen: "home",
      elapsedMs: Date.now() - queryStartedAtRef.current,
    });
  }, [feedStatus]);

  useEffect(() => {
    if (didRecordFirstCardsRef.current || feedVideos.length === 0) return;
    didRecordFirstCardsRef.current = true;
    trackFeedEvent("feed_first_cards_rendered", {
      screen: "home",
      elapsedMs: Date.now() - queryStartedAtRef.current,
    });
  }, [feedVideos.length]);

  const handleEndReached = useCallback(() => {
    if (feedStatus === "CanLoadMore") {
      loadMore(FEED_LOAD_MORE_COUNT);
    }
  }, [feedStatus, loadMore]);

  const renderItem = useCallback(
    ({ item, target }: { item: FeedVideoItem; target: string }) => (
      <FeedVideoCard
        item={item}
        thumbnailUrl={getThumbnailUrl(item)}
        showPlayIcon={false}
        // Recycled measurement passes must never own the player surface.
        playback={target === "Cell" ? getCardPlayback(item) : undefined}
      />
    ),
    [getCardPlayback, getThumbnailUrl],
  );

  const listHeader = useMemo(() => <LiveNowSection />, []);

  const listEmpty = useMemo(
    () => (
      <View style={styles.emptyState}>
        <Text style={styles.emptyTitle}>
          {isFeedLoading ? "Loading feed..." : "No videos yet"}
        </Text>
        <Text style={styles.emptySubtitle}>
          Upload a few videos from the Upload tab and they will show here.
        </Text>
      </View>
    ),
    [isFeedLoading],
  );

  const listFooter = useMemo(() => {
    if (isLoadingMore) {
      return (
        <View style={styles.footerState}>
          <Text style={styles.footerText}>Loading more videos...</Text>
        </View>
      );
    }
    if (feedVideos.length > 0 && feedStatus === "Exhausted") {
      return (
        <View style={styles.footerState}>
          <Text style={styles.footerText}>You&apos;re all caught up.</Text>
        </View>
      );
    }
    return null;
  }, [feedStatus, feedVideos.length, isLoadingMore]);

  return (
    <View style={styles.container}>
      <TabPageLogoHeader
        source={require("../../assets/images/robotube-logo.png")}
        width={250}
        height={75}
        transparentOnIOS
        onIconPress={() => router.push("/live/go-live" as never)}
      />

      <FlashList
        ref={feedListRef}
        data={feedVideos}
        extraData={extraData}
        keyExtractor={keyExtractor}
        {...listProps}
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.6}
        renderItem={renderItem}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.feedContent}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={listEmpty}
        ListFooterComponent={listFooter}
      />
      <FeedPerformanceDebugOverlay />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#ffffff",
  },
  feedContent: {
    paddingTop: 0,
    paddingBottom: 100,
  },
  emptyState: {
    paddingTop: 40,
    paddingHorizontal: 20,
    alignItems: "center",
    gap: 8,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#1a1a1a",
  },
  emptySubtitle: {
    textAlign: "center",
    fontSize: 14,
    color: "#666666",
  },
  footerState: {
    paddingVertical: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  footerText: {
    fontSize: 13,
    color: "#6B7280",
  },
});
