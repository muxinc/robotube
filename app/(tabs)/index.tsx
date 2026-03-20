import { FlashList } from "@shopify/flash-list";
import {Bot} from "lucide-react-native";
import { useIsFocused } from "@react-navigation/native";
import { usePaginatedQuery } from "convex/react";
import { Image } from "expo-image";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  FeedVideoCard,
  type FeedVideoItem,
} from "@/components/feed-video-card";
import { api } from "@/convex/_generated/api";
import { useFeedFocusController } from "@/hooks/use-feed-focus-controller";

const INITIAL_FEED_PAGE_SIZE = 16;
const FEED_LOAD_MORE_COUNT = 12;

export default function HomePage() {
  const insets = useSafeAreaInsets();
  const isTabFocused = useIsFocused();
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

  return (
    <View style={styles.container}>
      <View
        style={[
          styles.navbar,
          {
            height: 62 + insets.top,
            paddingTop: insets.top + 6,
          },
        ]}
      >
        <View style={{ flex: 1 }}>
          <Image
            source={require("../../assets/images/robotube-logo.png")}
            contentFit="contain"
            style={styles.logo}
          />
        </View>
        <View style={styles.actions}>
          <Pressable style={styles.iconButton}>
            <Bot size={22} color="#111111" />
          </Pressable>
        </View>
      </View>

      <FlashList
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
  navbar: {
    paddingLeft: 0,
    paddingRight: 12,
    paddingBottom: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e5e5e5",
  },
  logo: {
    width: 250,
    height: 75,
    marginLeft: -60,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  iconButton: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 18,
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
