import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { useAction } from "convex/react";
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { FeedVideoCard, type FeedVideoItem } from "@/components/feed-video-card";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { api } from "@/convex/_generated/api";

export default function TabTwoScreen() {
  const insets = useSafeAreaInsets();
  const searchVideos = useAction((api as any).search.searchVideos);
  const [queryText, setQueryText] = useState("");
  const [results, setResults] = useState<FeedVideoItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  useEffect(() => {
    const trimmed = queryText.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setIsSearching(false);
      return;
    }

    let isCancelled = false;
    setIsSearching(true);

    const timer = setTimeout(async () => {
      try {
        const nextResults = (await searchVideos({
          queryText: trimmed,
          limit: 12,
        })) as FeedVideoItem[];

        if (!isCancelled) {
          setResults(nextResults);
        }
      } catch {
        if (!isCancelled) {
          setResults([]);
        }
      } finally {
        if (!isCancelled) {
          setIsSearching(false);
        }
      }
    }, 250);

    return () => {
      isCancelled = true;
      clearTimeout(timer);
    };
  }, [queryText, searchVideos]);

  return (
    <ThemedView style={styles.screen}>
      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          {
            paddingTop: insets.top + 10,
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

          <View style={styles.searchWrap}>
            <Ionicons name="search" size={18} color="#7A7A7A" />
            <TextInput
              placeholder="Search videos, tags, or topics"
              placeholderTextColor="#8F95A1"
              returnKeyType="search"
              value={queryText}
              onChangeText={setQueryText}
              style={styles.searchInput}
            />
          </View>

          <View style={styles.resultsWrap}>
            {queryText.trim().length < 2 ? (
              <ThemedText style={styles.helperText}>
                Start typing to find videos by meaning, summary, and tags.
              </ThemedText>
            ) : isSearching ? 
              <ThemedText style={styles.helperText}>Searching...</ThemedText>
            ) : results.length === 0 ? (
              <ThemedText style={styles.helperText}>No videos found yet.</ThemedText>
            ) : (
              results.map((item) => <FeedVideoCard key={item.muxAssetId} item={item} />)
            )}
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
    width: 240,
    height: 88,
    alignSelf: "center",
    transform: [{ scale: 1.15 }],
  },
  searchWrap: {
    marginTop: 4,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: "#D5DDE8",
    backgroundColor: "#FFFFFF",
    borderRadius: 999,
    paddingHorizontal: 14,
    height: 46,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: "#1E1E1E",
    paddingVertical: 0,
  },
  resultsWrap: {
    marginTop: 6,
  },
  helperText: {
    fontSize: 14,
    color: "#5F6775",
    marginTop: 8,
    marginBottom: 6,
  },
});
