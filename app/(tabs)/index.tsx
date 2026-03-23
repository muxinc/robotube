import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { useIsFocused, useScrollToTop } from "@react-navigation/native";
import { usePaginatedQuery } from "convex/react";
import { useRef } from "react";
import { StyleSheet, Text, View } from "react-native";

import {
  FeedVideoCard,
  type FeedVideoItem,
} from "@/components/feed-video-card";
import { TabPageLogoHeader } from "@/components/tab-page-logo-header";
import { api } from "@/convex/_generated/api";
import { useFeedFocusController } from "@/hooks/use-feed-focus-controller";

const INITIAL_FEED_PAGE_SIZE = 16;
const FEED_LOAD_MORE_COUNT = 12;

export default function HomePage() {
  const isTabFocused = useIsFocused();
  const feedListRef = useRef<FlashListRef<FeedVideoItem> | null>(null);
  const {
    results: feedVideos,
    status: feedStatus,
    loadMore,
  } = usePaginatedQuery(
    (api as any).feed.listFeedVideosPaginated,
    {},
    { initialNumItems: INITIAL_FEED_PAGE_SIZE },
  ) as {
    results: FeedVideoItem[];
    status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";
    loadMore: (numItems: number) => void;
  };
  const {
    focusedIndex,
    isScrollSettling,
    onViewableItemsChanged,
    viewabilityConfig,
    onScrollBeginDrag,
    onScrollEndDrag,
    onMomentumScrollBegin,
    onMomentumScrollEnd,
    onScroll,
  } = useFeedFocusController<FeedVideoItem>();
  const isFeedLoading = feedStatus === "LoadingFirstPage";
  const isLoadingMore = feedStatus === "LoadingMore";

  useScrollToTop(feedListRef);

  return (
    <View style={styles.container}>
      <TabPageLogoHeader
        source={require("../../assets/images/robotube-logo.png")}
        width={250}
        height={75}
      />

      <FlashList
        ref={feedListRef}
        data={feedVideos}
        keyExtractor={(item) => item.muxAssetId}
        onViewableItemsChanged={onViewableItemsChanged}
        onScrollBeginDrag={onScrollBeginDrag}
        onScrollEndDrag={onScrollEndDrag}
        onMomentumScrollBegin={onMomentumScrollBegin}
        onMomentumScrollEnd={onMomentumScrollEnd}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onEndReached={() => {
          if (feedStatus === "CanLoadMore") {
            loadMore(FEED_LOAD_MORE_COUNT);
          }
        }}
        onEndReachedThreshold={0.6}
        viewabilityConfig={viewabilityConfig}
        renderItem={({ item, index, target }) => {
          const isCellTarget = target === "Cell";
          const isFocused =
            isCellTarget && isTabFocused && !isScrollSettling && index === focusedIndex;
          const shouldPreload =
            isCellTarget &&
            isTabFocused &&
            !isScrollSettling &&
            Math.abs(index - focusedIndex) <= 1;

          return (
            <FeedVideoCard
              item={item}
              showPlayIcon={false}
              isFocused={isFocused}
              shouldPreload={shouldPreload}
            />
          );
        }}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.feedContent}
        ListHeaderComponent={
          // Debug visibility card (kept for future troubleshooting)
          // feedDebugStats && feedDebugStats.hiddenTotal > 0 ? (
          //   <View style={styles.debugCard}>
          //     <Text style={styles.debugTitle}>Some videos are hidden from Home</Text>
          //     <Text style={styles.debugText}>
          //       Showing {feedDebugStats.visible} of {feedDebugStats.scanned} scanned.
          //     </Text>
          //     <Text style={styles.debugText}>
          //       Private: {feedDebugStats.hiddenPrivateVisibility} | Not ready/deleted: {" "}
          //       {feedDebugStats.hiddenNotReadyOrDeleted} | Missing playback: {" "}
          //       {feedDebugStats.hiddenNoPublicPlayback}
          //     </Text>
          //   </View>
          // ) : null
          null
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>
              {isFeedLoading ? "Loading feed..." : "No videos yet"}
            </Text>
            <Text style={styles.emptySubtitle}>
              Upload a few videos from the Upload tab and they will show here.
            </Text>
          </View>
        }
        ListFooterComponent={
          isLoadingMore ? (
            <View style={styles.footerState}>
              <Text style={styles.footerText}>Loading more videos...</Text>
            </View>
          ) : feedVideos.length > 0 && feedStatus === "Exhausted" ? (
            <View style={styles.footerState}>
              <Text style={styles.footerText}>You&apos;re all caught up.</Text>
            </View>
          ) : null
        }
      />
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
  debugCard: {
    marginHorizontal: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#E0E7F2",
    backgroundColor: "#F7FAFF",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4,
  },
  debugTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#294A73",
  },
  debugText: {
    fontSize: 12,
    color: "#3F566F",
    lineHeight: 18,
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
