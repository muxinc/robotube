import { FlashList, type ViewToken } from "@shopify/flash-list";
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "convex/react";
import { Image } from "expo-image";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  FeedVideoCard,
  type FeedVideoItem,
} from "@/components/feed-video-card";
import { api } from "@/convex/_generated/api";

export default function HomePage() {
  const insets = useSafeAreaInsets();
  const FEED_LIMIT = 200;
  const feedVideos = useQuery((api as any).feed.listFeedVideos, {
    limit: FEED_LIMIT,
  }) as FeedVideoItem[] | undefined;
  const feedDebugStats = useQuery((api as any).feed.getFeedVisibilityDebugStats, {
    scanLimit: FEED_LIMIT,
  }) as
    | {
        scanned: number;
        visible: number;
        hiddenNotReadyOrDeleted: number;
        hiddenNoPublicPlayback: number;
        hiddenPrivateVisibility: number;
        hiddenTotal: number;
      }
    | undefined;
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [isScrollSettling, setIsScrollSettling] = useState(false);
  const isScrollSettlingRef = useRef(false);
  const pendingFocusedIndexRef = useRef(0);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    isScrollSettlingRef.current = isScrollSettling;
  }, [isScrollSettling]);

  const clearSettleTimer = useCallback(() => {
    if (settleTimerRef.current) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }, []);

  const applyPendingFocus = useCallback(() => {
    const nextFocusedIndex = pendingFocusedIndexRef.current;
    setFocusedIndex((current) =>
      current === nextFocusedIndex ? current : nextFocusedIndex,
    );
  }, []);

  const scheduleFocusSettle = useCallback((delayMs: number) => {
    clearSettleTimer();
    settleTimerRef.current = setTimeout(() => {
      setIsScrollSettling(false);
      applyPendingFocus();
      settleTimerRef.current = null;
    }, delayMs);
  }, [applyPendingFocus, clearSettleTimer]);

  useEffect(
    () => () => {
      clearSettleTimer();
    },
    [clearSettleTimer],
  );

  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken<FeedVideoItem>[] }) => {
      const viewableIndexes = viewableItems
        .map((token) => token.index)
        .filter((index): index is number => index !== null)
        .sort((a, b) => a - b);

      if (viewableIndexes.length === 0) return;

      const nextFocusedIndex = viewableIndexes[0];
      pendingFocusedIndexRef.current = nextFocusedIndex;
      if (!isScrollSettlingRef.current) {
        setFocusedIndex((current) =>
          current === nextFocusedIndex ? current : nextFocusedIndex,
        );
      }
    },
  );

  const viewabilityConfig = useRef({
    itemVisiblePercentThreshold: 65,
    minimumViewTime: 100,
  });

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
            <Ionicons name="tv-outline" size={22} color="#111111" />
          </Pressable>
          <Pressable style={styles.iconButton}>
            <Ionicons name="notifications-outline" size={22} color="#111111" />
          </Pressable>
          <Pressable style={styles.iconButton}>
            <Ionicons name="search-outline" size={22} color="#111111" />
          </Pressable>
        </View>
      </View>

      <FlashList
        data={feedVideos ?? []}
        keyExtractor={(item) => item.muxAssetId}
        onViewableItemsChanged={onViewableItemsChanged.current}
        onScrollBeginDrag={() => {
          clearSettleTimer();
          setIsScrollSettling(true);
        }}
        onScrollEndDrag={() => {
          scheduleFocusSettle(140);
        }}
        onMomentumScrollBegin={() => {
          clearSettleTimer();
          setIsScrollSettling(true);
        }}
        onMomentumScrollEnd={() => {
          scheduleFocusSettle(80);
        }}
        viewabilityConfig={viewabilityConfig.current}
        renderItem={({ item, index, target }) => {
          const isCellTarget = target === "Cell";
          const isFocused = isCellTarget && !isScrollSettling && index === focusedIndex;
          const shouldPreload =
            isCellTarget && !isScrollSettling && Math.abs(index - focusedIndex) <= 1;

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
          feedDebugStats && feedDebugStats.hiddenTotal > 0 ? (
            <View style={styles.debugCard}>
              <Text style={styles.debugTitle}>Some videos are hidden from Home</Text>
              <Text style={styles.debugText}>
                Showing {feedDebugStats.visible} of {feedDebugStats.scanned} scanned.
              </Text>
              <Text style={styles.debugText}>
                Private: {feedDebugStats.hiddenPrivateVisibility} | Not ready/deleted: {" "}
                {feedDebugStats.hiddenNotReadyOrDeleted} | Missing playback: {" "}
                {feedDebugStats.hiddenNoPublicPlayback}
              </Text>
            </View>
          ) : null
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>
              {feedVideos === undefined ? "Loading feed..." : "No videos yet"}
            </Text>
            <Text style={styles.emptySubtitle}>
              Upload a few videos from the Upload tab and they will show here.
            </Text>
          </View>
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
    width: 150,
    height: 46,
    marginLeft: -16,
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
    paddingTop: 12,
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
});
