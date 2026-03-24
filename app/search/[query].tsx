import { FlashList } from "@shopify/flash-list";
import { Ionicons } from "@expo/vector-icons";
import { useIsFocused } from "@react-navigation/native";
import { useQuery } from "convex/react";
import { Stack, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { FeedVideoCard, type FeedVideoItem } from "@/components/feed-video-card";
import { api } from "@/convex/_generated/api";
import { useFeedFocusController } from "@/hooks/use-feed-focus-controller";
import { useNativeSearch } from "@/hooks/use-native-search";

const INITIAL_SEARCH_LIMIT = 16;
const SEARCH_LOAD_MORE_COUNT = 12;

function getSingleParam(value: string | string[] | undefined, fallback = "") {
  if (Array.isArray(value)) return value[0] ?? fallback;
  return value ?? fallback;
}

export default function SearchResultsPage() {
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const isIOS = Platform.OS === "ios";
  const isTabFocused = useIsFocused();
  const params = useLocalSearchParams<{ query?: string }>();
  const routeQuery = useMemo(() => getSingleParam(params.query).trim(), [params.query]);
  const [inputText, setInputText] = useState(routeQuery);
  const [resultLimit, setResultLimit] = useState(INITIAL_SEARCH_LIMIT);

  const hasSearchQuery = routeQuery.length >= 2;

  const results = useQuery(
    (api as any).searchFast.searchVideosFast,
    hasSearchQuery
      ? {
          queryText: routeQuery,
          limit: resultLimit,
        }
      : "skip",
  ) as FeedVideoItem[] | undefined;
  const isSearching = hasSearchQuery && results === undefined;
  const items = results ?? [];
  const isLoadingMore = isSearching && resultLimit > INITIAL_SEARCH_LIMIT;
  const canLoadMore = hasSearchQuery && !isSearching && items.length >= resultLimit;

  const {
    focusedIndex,
    isScrollSettling,
    onViewableItemsChanged,
    viewabilityConfig,
    onScrollBeginDrag,
    onScrollEndDrag,
    onMomentumScrollBegin,
    onMomentumScrollEnd,
  } = useFeedFocusController<FeedVideoItem>();

  useEffect(() => {
    setInputText(routeQuery);
  }, [routeQuery]);

  useEffect(() => {
    setResultLimit(INITIAL_SEARCH_LIMIT);
  }, [routeQuery]);

  const handleSubmitSearch = () => {
    const trimmed = inputText.trim();
    if (trimmed.length < 2) return;
    router.replace({
      pathname: "/search/[query]" as never,
      params: { query: trimmed },
    });
  };

  const handleBack = useCallback(() => {
    if (navigation.canGoBack()) {
      router.back();
      return;
    }

    router.replace("/search");
  }, [navigation, router]);

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <View
        style={[
          styles.searchHeader,
          isIOS ? styles.searchHeaderIOS : null,
          {
            paddingTop: insets.top + 8,
          },
        ]}
      >
        <Pressable style={styles.backButton} onPress={handleBack}>
          <Ionicons name="chevron-back" size={22} color="#1A1A1A" />
        </Pressable>

        <View style={styles.searchWrap}>
          <Pressable onPress={handleSubmitSearch} hitSlop={8}>
            <Ionicons name="search" size={18} color="#7A7A7A" />
          </Pressable>
          <TextInput
            placeholder="Search videos, tags, or topics"
            placeholderTextColor="#8F95A1"
            returnKeyType="search"
            value={inputText}
            onChangeText={setInputText}
            onSubmitEditing={handleSubmitSearch}
            style={styles.searchInput}
          />
        </View>
      </View>

      <FlashList
        data={items}
        keyExtractor={(item) => item.muxAssetId}
        onViewableItemsChanged={onViewableItemsChanged}
        onScrollBeginDrag={onScrollBeginDrag}
        onScrollEndDrag={onScrollEndDrag}
        onMomentumScrollBegin={onMomentumScrollBegin}
        onMomentumScrollEnd={onMomentumScrollEnd}
        viewabilityConfig={viewabilityConfig}
        onEndReached={() => {
          if (canLoadMore) {
            setResultLimit((current) => current + SEARCH_LOAD_MORE_COUNT);
          }
        }}
        onEndReachedThreshold={0.6}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: 8,
          paddingBottom: insets.bottom + 120,
        }}
        ListHeaderComponent={
          <View style={styles.resultsHeader}>
            <Text style={styles.resultsTitle}>Results for: {routeQuery}</Text>
            {!isSearching && items.length > 0 ? (
              <Text style={styles.resultsCount}>{items.length} videos shown</Text>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>
              {routeQuery.length < 2
                ? "Type at least 2 characters"
                : isSearching
                  ? "Searching..."
                  : "No videos found"}
            </Text>
            <Text style={styles.emptySubtitle}>
              {routeQuery.length < 2
                ? "Try a broader topic like action, music, or interview."
                : "Try a different keyword or browse categories in Search."}
            </Text>
          </View>
        }
        ListFooterComponent={
          isLoadingMore ? (
            <View style={styles.footerState}>
              <Text style={styles.footerText}>Loading more results...</Text>
            </View>
          ) : items.length > 0 && !canLoadMore && !isSearching ? (
            <View style={styles.footerState}>
              <Text style={styles.footerText}>End of results.</Text>
            </View>
          ) : null
        }
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
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#FFFFFF",
  },
  searchHeader: {
    paddingHorizontal: 14,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#E2E8F2",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  searchHeaderIOS: {
    borderBottomWidth: 0,
    backgroundColor: "transparent",
  },
  backButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  searchWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: "#D5DDE8",
    backgroundColor: "#FFFFFF",
    borderRadius: 999,
    paddingHorizontal: 14,
    height: 44,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: "#1E1E1E",
    paddingVertical: 0,
  },
  resultsHeader: {
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 10,
    gap: 2,
  },
  resultsTitle: {
    fontSize: 20,
    fontWeight: "800",
    color: "#182133",
  },
  resultsCount: {
    fontSize: 13,
    color: "#5B6578",
  },
  emptyState: {
    paddingTop: 50,
    paddingHorizontal: 20,
    alignItems: "center",
    gap: 8,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#1a1a1a",
    textAlign: "center",
  },
  emptySubtitle: {
    textAlign: "center",
    fontSize: 14,
    color: "#666666",
    lineHeight: 20,
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
