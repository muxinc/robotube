import { Ionicons } from "@expo/vector-icons";
import { useIsFocused } from "@react-navigation/native";
import { Stack, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";

import { TabPageLogoHeader } from "@/components/tab-page-logo-header";
import { TabPageScrollLayout } from "@/components/tab-page-scroll-layout";
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

export default function SearchScreen() {
  const isFocused = useIsFocused();
  const router = useRouter();
  const searchInputRef = useRef<TextInput | null>(null);
  const [queryText, setQueryText] = useState("");

  useEffect(() => {
    if (!isFocused) return;

    const timeoutId = setTimeout(() => {
      searchInputRef.current?.focus();
    }, 100);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [isFocused]);

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
      <Stack.Screen options={{ headerShown: false }} />

      <TabPageLogoHeader
        source={require("@/assets/images/search-logo.png")}
        width={250}
        height={75}
      />

      <TabPageScrollLayout
        contentInsetAdjustmentBehavior="never"
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        includeTopInset={false}
        containerStyle={styles.container}
        topPaddingOffset={18}
      >
        <View style={styles.searchWrap}>
          <Pressable onPress={() => submitSearch(queryText)} hitSlop={8}>
            <Ionicons name="search" size={18} color="#7A7A7A" />
          </Pressable>
          <TextInput
            ref={searchInputRef}
            placeholder="Search videos, tags, or topics"
            placeholderTextColor="#8F95A1"
            returnKeyType="search"
            value={queryText}
            onChangeText={setQueryText}
            onSubmitEditing={() => submitSearch(queryText)}
            style={styles.searchInput}
          />
        </View>

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
                      pathname: "/search/category/[category]",
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
      </TabPageScrollLayout>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  container: {
    gap: 14,
  },
  searchWrap: {
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
  categoriesWrap: {
    marginTop: 0,
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
