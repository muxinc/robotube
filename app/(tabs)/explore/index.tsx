import { Image } from "expo-image";
import { Stack, useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";

const SEARCH_CATEGORIES = [
  { label: "Action", query: "action", color: "#F05B4A" },
  { label: "Interviews", query: "interview", color: "#3D66D5" },
  { label: "Music", query: "music", color: "#D94D8E" },
  { label: "Gaming", query: "gaming", color: "#6E44C7" },
  { label: "Comedy", query: "comedy", color: "#D88927" },
  { label: "Tech", query: "technology", color: "#178A7E" },
];

export default function ExploreScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [queryText, setQueryText] = useState("");

  const submitSearch = (rawText: string) => {
    const trimmed = rawText.trim();
    if (trimmed.length < 2) return;

    router.push({
      pathname: "/search/[query]" as never,
      params: {
        query: trimmed,
      },
    });
  };

  return (
    <ThemedView style={styles.screen}>
      <Stack.Screen options={{ title: "Search" }} />
      <Stack.SearchBar
        placement="automatic"
        placeholder="Search videos, tags, or topics"
        onChangeText={(event) => {
          setQueryText(event.nativeEvent.text);
        }}
        onSearchButtonPress={(event) => {
          submitSearch(event.nativeEvent.text || queryText);
        }}
      />

      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          {
            paddingTop: 10,
            paddingBottom: insets.bottom + 110,
          },
        ]}
      >
        <ThemedView style={styles.container}>
          <Image
            source={require("@/assets/images/explore-logo.png")}
            contentFit="contain"
            style={styles.exploreLogo}
          />

          <View style={styles.categoriesWrap}>
            <ThemedText style={styles.categoriesHeading}>Browse categories</ThemedText>
            <View style={styles.categoriesGrid}>
              {SEARCH_CATEGORIES.map((category) => {
                return (
                  <Pressable
                    key={category.label}
                    style={[styles.categoryCard, { backgroundColor: category.color }]}
                    onPress={() => {
                      router.push({
                        pathname: "/category/[category]",
                        params: {
                          category: category.label.toLowerCase(),
                          label: category.label,
                          query: category.query,
                          color: category.color,
                        },
                      });
                    }}
                  >
                    <ThemedText style={styles.categoryLabel}>{category.label}</ThemedText>
                  </Pressable>
                );
              })}
            </View>
          </View>
        </ThemedView>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 20,
  },
  container: {
    gap: 14,
    width: "100%",
    maxWidth: 760,
    alignSelf: "center",
  },
  exploreLogo: {
    width: 280,
    height: 106,
    alignSelf: "flex-start",
    marginLeft: -92,
    transform: [{ scale: 1.2 }],
  },
  categoriesWrap: {
    marginTop: 6,
    gap: 10,
  },
  categoriesHeading: {
    fontSize: 16,
    fontWeight: "700",
    color: "#202630",
  },
  categoriesGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    gap: 10,
  },
  categoryCard: {
    width: "48%",
    minHeight: 92,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    justifyContent: "flex-end",
  },
  categoryLabel: {
    fontSize: 18,
    lineHeight: 22,
    fontWeight: "800",
    color: "#FFFFFF",
  },
});
