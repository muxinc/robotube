import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "convex/react";
import { Image } from "expo-image";
import { useRef, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View, type ViewToken } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  FeedVideoCard,
  type FeedVideoItem,
} from "@/components/feed-video-card";
import { api } from "@/convex/_generated/api";

export default function HomePage() {
  const insets = useSafeAreaInsets();
  const feedVideos = useQuery((api as any).feed.listFeedVideos, {
    limit: 20,
  }) as FeedVideoItem[] | undefined;
  const [focusedIndex, setFocusedIndex] = useState(0);
  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken<FeedVideoItem>[] }) => {
      const viewableIndexes = viewableItems
        .map((token) => token.index)
        .filter((index): index is number => index !== null)
        .sort((a, b) => a - b);

      if (viewableIndexes.length === 0) return;

      const nextFocusedIndex = viewableIndexes[0];

      setFocusedIndex((current) =>
        current === nextFocusedIndex ? current : nextFocusedIndex,
      );
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
        <View style={{ flex: 1, justifyContent: "center" }}>
          <Image
            source={require("../../assets/images/robotube-logo.png")}
            contentFit="contain"
            style={[styles.logo, { marginLeft: 0 }]}
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

      <FlatList
        data={feedVideos ?? []}
        keyExtractor={(item) => item.muxAssetId}
        onViewableItemsChanged={onViewableItemsChanged.current}
        viewabilityConfig={viewabilityConfig.current}
        renderItem={({ item, index }) => {
          const shouldPreload = Math.abs(index - focusedIndex) <= 1;
          return (
            <FeedVideoCard
              item={item}
              showPlayIcon={false}
              isFocused={index === focusedIndex}
              shouldPreload={shouldPreload}
            />
          );
        }}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.feedContent}
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
    paddingHorizontal: 12,
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
    marginLeft: -40,
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
