import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "convex/react";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useVideoPlayer, VideoView } from "expo-video";
import { useCallback } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ThemedText } from "@/components/themed-text";
import { api } from "@/convex/_generated/api";

export default function WatchLiveStreamScreen() {
  const { muxLiveStreamId } = useLocalSearchParams<{
    muxLiveStreamId: string;
  }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const stream = useQuery(
    (api as any).liveStreamQueries.getLiveStreamByMuxId,
    muxLiveStreamId ? { muxLiveStreamId } : "skip",
  );

  const playbackUrl = stream?.playbackUrl ?? null;

  const player = useVideoPlayer(
    playbackUrl ? { uri: playbackUrl, contentType: "hls" } : null,
    (videoPlayer) => {
      videoPlayer.loop = false;
      videoPlayer.play();
    },
  );

  const handleBack = useCallback(() => {
    router.back();
  }, [router]);

  const isStreamEnded = stream?.status === "idle" && stream?.endedAtMs;

  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          headerShown: true,
          headerTitle: "",
          headerTransparent: true,
          headerLeft: () => (
            <Pressable onPress={handleBack} hitSlop={12}>
              <Ionicons name="chevron-back" size={28} color="#fff" />
            </Pressable>
          ),
        }}
      />

      {/* Video player */}
      <View style={styles.playerContainer}>
        {playbackUrl && player ? (
          <VideoView
            player={player}
            style={StyleSheet.absoluteFill}
            contentFit="contain"
            nativeControls={false}
          />
        ) : (
          <View style={styles.playerPlaceholder}>
            <ThemedText style={styles.placeholderText}>
              {stream === undefined
                ? "Loading..."
                : "Stream not available"}
            </ThemedText>
          </View>
        )}

        {/* LIVE badge overlay */}
        {stream?.status === "active" ? (
          <View style={[styles.liveBadge, { top: insets.top + 48 }]}>
            <View style={styles.liveDot} />
            <ThemedText style={styles.liveBadgeText}>LIVE</ThemedText>
          </View>
        ) : null}

        {/* Stream ended overlay */}
        {isStreamEnded ? (
          <View style={styles.endedOverlay}>
            <Ionicons name="videocam-off-outline" size={40} color="#fff" />
            <ThemedText style={styles.endedText}>
              This live stream has ended
            </ThemedText>
          </View>
        ) : null}
      </View>

      {/* Stream info */}
      <View style={[styles.infoBar, { paddingBottom: insets.bottom + 16 }]}>
        <View style={styles.channelRow}>
          {stream?.channelAvatarUrl ? (
            <View style={styles.avatarContainer}>
              <View style={styles.avatar}>
                <ThemedText style={styles.avatarText}>
                  {stream.channelName?.charAt(0).toUpperCase() ?? "?"}
                </ThemedText>
              </View>
            </View>
          ) : (
            <View style={styles.avatar}>
              <ThemedText style={styles.avatarText}>
                {stream?.channelName?.charAt(0).toUpperCase() ?? "?"}
              </ThemedText>
            </View>
          )}
          <View style={styles.channelInfo}>
            <ThemedText style={styles.streamTitle} numberOfLines={2}>
              {stream?.title ?? "Live Stream"}
            </ThemedText>
            <ThemedText style={styles.channelName}>
              {stream?.channelName ?? "Unknown"}
            </ThemedText>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#000",
  },
  playerContainer: {
    flex: 1,
    backgroundColor: "#000",
  },
  playerPlaceholder: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  placeholderText: {
    color: "#888",
    fontSize: 16,
  },
  liveBadge: {
    position: "absolute",
    left: 16,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#E91E63",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 4,
    gap: 6,
    zIndex: 10,
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#fff",
  },
  liveBadgeText: {
    color: "#fff",
    fontWeight: "800",
    fontSize: 13,
    letterSpacing: 1,
  },
  endedOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.7)",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  endedText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  infoBar: {
    backgroundColor: "#111",
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  channelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  avatarContainer: {},
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#E91E63",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 16,
  },
  channelInfo: {
    flex: 1,
    gap: 2,
  },
  streamTitle: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
    lineHeight: 22,
  },
  channelName: {
    color: "#aaa",
    fontSize: 13,
  },
});
