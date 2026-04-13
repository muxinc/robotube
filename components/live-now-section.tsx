import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { useQuery } from "convex/react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { ThemedText } from "@/components/themed-text";
import { api } from "@/convex/_generated/api";

type LiveStreamItem = {
  _id: string;
  title: string;
  muxLiveStreamId: string;
  playbackId: string | null;
  thumbnailUrl: string | null;
  status: string;
  channelName: string;
  channelAvatarUrl: string | null;
  createdAtMs: number;
};

export function LiveNowSection() {
  const router = useRouter();
  const streams = useQuery(
    (api as any).liveStreamQueries.listActiveLiveStreams,
  ) as LiveStreamItem[] | undefined;

  if (!streams || streams.length === 0) return null;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={styles.liveDot} />
          <ThemedText style={styles.heading}>Live Now</ThemedText>
        </View>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {streams.map((stream) => (
          <Pressable
            key={stream._id}
            style={styles.card}
            onPress={() => {
              router.push({
                pathname: "/live/watch/[muxLiveStreamId]",
                params: { muxLiveStreamId: stream.muxLiveStreamId },
              } as never);
            }}
          >
            <View style={styles.thumbnail}>
              {stream.thumbnailUrl ? (
                <Image
                  source={{ uri: stream.thumbnailUrl }}
                  style={StyleSheet.absoluteFill}
                  contentFit="cover"
                />
              ) : (
                <View style={styles.thumbnailPlaceholder}>
                  <ThemedText style={styles.thumbnailPlaceholderText}>
                    LIVE
                  </ThemedText>
                </View>
              )}
              <View style={styles.liveBadge}>
                <View style={styles.liveBadgeDot} />
                <ThemedText style={styles.liveBadgeText}>LIVE</ThemedText>
              </View>
            </View>
            <View style={styles.cardInfo}>
              <View style={styles.avatar}>
                <ThemedText style={styles.avatarText}>
                  {stream.channelName?.charAt(0).toUpperCase() ?? "?"}
                </ThemedText>
              </View>
              <View style={styles.cardText}>
                <ThemedText style={styles.cardTitle} numberOfLines={1}>
                  {stream.title}
                </ThemedText>
                <ThemedText style={styles.cardChannel} numberOfLines={1}>
                  {stream.channelName}
                </ThemedText>
              </View>
            </View>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingTop: 8,
    paddingBottom: 12,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    marginBottom: 10,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  liveDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#E91E63",
  },
  heading: {
    fontSize: 17,
    fontWeight: "800",
    color: "#1a1a1a",
  },
  scrollContent: {
    paddingHorizontal: 16,
    gap: 12,
  },
  card: {
    width: 220,
    borderRadius: 12,
    backgroundColor: "#f5f5f5",
    overflow: "hidden",
  },
  thumbnail: {
    width: "100%",
    height: 124,
    backgroundColor: "#222",
  },
  thumbnailPlaceholder: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#1a1a1a",
  },
  thumbnailPlaceholderText: {
    color: "#555",
    fontWeight: "700",
    fontSize: 14,
  },
  liveBadge: {
    position: "absolute",
    top: 8,
    left: 8,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#E91E63",
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 4,
    gap: 5,
  },
  liveBadgeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#fff",
  },
  liveBadgeText: {
    color: "#fff",
    fontWeight: "800",
    fontSize: 11,
    letterSpacing: 0.5,
  },
  cardInfo: {
    flexDirection: "row",
    alignItems: "center",
    padding: 10,
    gap: 8,
  },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "#E91E63",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 12,
  },
  cardText: {
    flex: 1,
    gap: 1,
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#1a1a1a",
  },
  cardChannel: {
    fontSize: 11,
    color: "#666",
  },
});
