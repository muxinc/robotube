import { HeaderSearchBarRef } from "@react-navigation/elements";
import { useIsFocused } from "@react-navigation/native";
import { Stack, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  View,
} from "react-native";

import { TabPageLogo } from "@/components/tab-page-logo";
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
  const searchBarRef = useRef<HeaderSearchBarRef>(null);
  const [queryText, setQueryText] = useState("");

  useEffect(() => {
    if (!isFocused) return;

    const timeoutId = setTimeout(() => {
      searchBarRef.current?.focus();
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
      <Stack.Screen
        options={{
          title: "",
          headerShadowVisible: false,
        }}
      />
      <Stack.SearchBar
        ref={searchBarRef}
        autoFocus
        placement={Platform.OS === "ios" ? "integrated" : "automatic"}
        placeholder="Search videos, tags, or topics"
        hideNavigationBar={false}
        allowToolbarIntegration={Platform.OS === "ios"}
        onChangeText={(event) => {
          setQueryText(event.nativeEvent.text);
        }}
        onSearchButtonPress={(event) => {
          submitSearch(event.nativeEvent.text || queryText);
        }}
      />

      <TabPageScrollLayout
        contentInsetAdjustmentBehavior="never"
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        containerStyle={styles.container}
      >
        <TabPageLogo
          source={require("@/assets/images/search-logo.png")}
          width={276}
          height={102}
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
