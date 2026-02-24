import { Image } from "expo-image";
import { useQuery } from "convex/react";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useMemo } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { type FeedVideoItem, formatPublished } from "@/components/feed-video-card";
import { ThemedView } from "@/components/themed-view";
import { api } from "@/convex/_generated/api";

// Aspect ratios measured from the cropped PNGs (width / height of the artwork canvas).
const CATEGORY_LOGOS: Record<string, { source: number; ratio: number }> = {
  action:     { source: require("@/assets/images/action-logo.png"),     ratio: 2.6854 },
  interviews: { source: require("@/assets/images/interviews-logo.png"), ratio: 3.5890 },
  music:      { source: require("@/assets/images/music-logo.png"),      ratio: 2.6632 },
  gaming:     { source: require("@/assets/images/gaming-logo.png"),     ratio: 2.8825 },
  comedy:     { source: require("@/assets/images/comedy-logo.png"),     ratio: 3.2632 },
  tech:       { source: require("@/assets/images/tech-logo.png"),       ratio: 2.2141 },
};

// Rendered height matches the explore-logo visual size (280 * 1.2 scale ≈ 106 * 1.2 ≈ 127dp tall).
// Width is computed per-logo from its cropped aspect ratio.
const LOGO_HEIGHT = 64;

function getSingleParam(value: string | string[] | undefined, fallback = "") {
  if (Array.isArray(value)) return value[0] ?? fallback;
  return value ?? fallback;
}

function normalizeCategoryKey(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

export default function CategoryExplorePage() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ category?: string; label?: string; query?: string; color?: string }>();
  const categoryLabel = getSingleParam(params.label, "Category");
  const queryText = getSingleParam(params.query, getSingleParam(params.category, "")).trim();
  const accentColor = getSingleParam(params.color, "#3D66D5");
  const categoryKey =
    normalizeCategoryKey(getSingleParam(params.category)) || normalizeCategoryKey(categoryLabel);
  const categoryLogo = CATEGORY_LOGOS[categoryKey] ?? null;
  const logoWidth = categoryLogo ? Math.round(LOGO_HEIGHT * categoryLogo.ratio) : 0;

  const results = useQuery(
    (api as any).searchFast.searchVideosFast,
    queryText.length >= 2
      ? {
          queryText,
          limit: 28,
        }
      : "skip",
  ) as FeedVideoItem[] | undefined;
  const isLoading = queryText.length >= 2 && results === undefined;
  const items = useMemo(() => results ?? [], [results]);

  const carouselItems = useMemo(() => items.slice(0, 8), [items]);
  const listItems = useMemo(() => items.slice(8), [items]);

  return (
    <ThemedView style={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: insets.top + 12,
            paddingBottom: insets.bottom + 120,
          },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.headerWrap}>
          <Text style={styles.kicker}>Browse</Text>
          {categoryLogo ? (
            <Image
              source={categoryLogo.source}
              contentFit="contain"
              contentPosition="left"
              style={[styles.categoryLogo, { width: logoWidth, height: LOGO_HEIGHT }]}
            />
          ) : (
            <Text style={styles.title}>{categoryLabel}</Text>
          )}
          <Text style={styles.subtitle}>Swipe top picks, then explore more videos below.</Text>
        </View>

        {isLoading ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator size="large" color={accentColor} />
            <Text style={styles.loadingText}>Loading {categoryLabel} videos...</Text>
          </View>
        ) : items.length === 0 ? (
          <Text style={styles.helper}>No videos found in this category yet.</Text>
        ) : (
          <>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.carouselContent}
              snapToInterval={308}
              decelerationRate="fast"
            >
              {carouselItems.map((item) => (
                <Pressable
                  key={item.muxAssetId}
                  style={styles.heroCard}
                  onPress={() => {
                    router.push({
                      pathname: "/video/[muxAssetId]",
                      params: { muxAssetId: item.muxAssetId },
                    });
                  }}
                >
                  <Image source={{ uri: item.thumbnailUrl }} contentFit="cover" style={styles.heroImage} />
                  <View style={styles.heroShade} />
                  <View style={styles.heroMeta}>
                    <View style={[styles.heroBadge, { backgroundColor: `${accentColor}EE` }]}>
                      <Text style={styles.heroBadgeText}>Top Pick</Text>
                    </View>
                    <Text style={styles.heroTitle} numberOfLines={2}>
                      {item.title}
                    </Text>
                    <Text style={styles.heroSub} numberOfLines={1}>
                      {item.channelName} · {formatPublished(item.createdAtMs)}
                    </Text>
                  </View>
                </Pressable>
              ))}
            </ScrollView>

            <View style={styles.listSection}>
              <Text style={styles.listTitle}>More in {categoryLabel}</Text>

              {(listItems.length > 0 ? listItems : items).map((item) => (
                <Pressable
                  key={`${item.muxAssetId}-row`}
                  style={styles.rowCard}
                  onPress={() => {
                    router.push({
                      pathname: "/video/[muxAssetId]",
                      params: { muxAssetId: item.muxAssetId },
                    });
                  }}
                >
                  <Image source={{ uri: item.thumbnailUrl }} contentFit="cover" style={styles.rowImage} />
                  <View style={styles.rowTextWrap}>
                    <Text style={styles.rowTitle} numberOfLines={2}>
                      {item.title}
                    </Text>
                    <Text style={styles.rowMeta} numberOfLines={1}>
                      {item.channelName} · {formatPublished(item.createdAtMs)}
                    </Text>
                  </View>
                </Pressable>
              ))}
            </View>
          </>
        )}
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#F5F7FB",
  },
  content: {
    paddingHorizontal: 16,
    gap: 14,
  },
  headerWrap: {
    gap: 4,
  },
  kicker: {
    fontSize: 12,
    letterSpacing: 1,
    textTransform: "uppercase",
    color: "#5C6A80",
    fontWeight: "700",
  },
  title: {
    fontSize: 34,
    lineHeight: 38,
    color: "#121A28",
    fontWeight: "800",
  },
  categoryLogo: {
    marginLeft: 0,
  },
  subtitle: {
    fontSize: 14,
    color: "#4F5E76",
  },
  carouselContent: {
    paddingHorizontal: 2,
    gap: 12,
  },
  heroCard: {
    width: 296,
    height: 214,
    borderRadius: 18,
    overflow: "hidden",
    backgroundColor: "#111",
  },
  heroImage: {
    ...StyleSheet.absoluteFillObject,
  },
  heroShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  heroMeta: {
    flex: 1,
    justifyContent: "flex-end",
    padding: 14,
    gap: 6,
  },
  heroBadge: {
    alignSelf: "flex-start",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  heroBadgeText: {
    color: "#FFFFFF",
    fontSize: 11,
    fontWeight: "700",
  },
  heroTitle: {
    color: "#FFFFFF",
    fontSize: 20,
    lineHeight: 24,
    fontWeight: "800",
  },
  heroSub: {
    color: "#F2F5FF",
    fontSize: 13,
    fontWeight: "500",
  },
  listSection: {
    marginTop: 4,
    gap: 10,
  },
  listTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: "#192334",
  },
  helper: {
    fontSize: 14,
    color: "#5B6678",
    marginTop: 4,
  },
  loadingWrap: {
    marginTop: 20,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  loadingText: {
    fontSize: 14,
    color: "#5B6678",
    fontWeight: "600",
  },
  rowCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#FFFFFF",
    borderRadius: 14,
    padding: 8,
    borderWidth: 1,
    borderColor: "#E6EBF4",
  },
  rowImage: {
    width: 128,
    height: 72,
    borderRadius: 10,
    backgroundColor: "#111",
  },
  rowTextWrap: {
    flex: 1,
    gap: 6,
    paddingRight: 6,
  },
  rowTitle: {
    fontSize: 15,
    lineHeight: 20,
    color: "#151F2F",
    fontWeight: "700",
  },
  rowMeta: {
    fontSize: 12,
    color: "#63718A",
    fontWeight: "500",
  },
});
