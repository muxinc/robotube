import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "convex/react";
import { StatusBar } from "expo-status-bar";
import { Stack, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useVideoPlayer, VideoView } from "expo-video";
import { useEffect, useMemo, useRef } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  FeedVideoCard,
  type FeedVideoItem,
  formatPublished,
} from "@/components/feed-video-card";
import { api } from "@/convex/_generated/api";

function FullVideoPlayer({
  playbackUrl,
  startAtSeconds,
}: {
  playbackUrl: string;
  startAtSeconds?: number;
}) {
  const didSeekToStartRef = useRef(false);

  const player = useVideoPlayer(
    { uri: playbackUrl, contentType: "hls" },
    (videoPlayer) => {
      videoPlayer.loop = false;
      videoPlayer.play();
    },
  );

  useEffect(() => {
    if (didSeekToStartRef.current) return;
    if (startAtSeconds === undefined || Number.isNaN(startAtSeconds)) return;

    player.currentTime = Math.max(0, startAtSeconds);
    didSeekToStartRef.current = true;
  }, [player, startAtSeconds]);

  return (
    <VideoView
      player={player}
      nativeControls
      contentFit="contain"
      allowsVideoFrameAnalysis={false}
      style={styles.video}
    />
  );
}

export default function VideoDetailPage() {
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { muxAssetId: rawMuxAssetId, startAt: rawStartAt } =
    useLocalSearchParams<{
      muxAssetId?: string | string[];
      startAt?: string | string[];
    }>();

  const muxAssetId = Array.isArray(rawMuxAssetId)
    ? rawMuxAssetId[0]
    : rawMuxAssetId;
  const startAtParam = Array.isArray(rawStartAt) ? rawStartAt[0] : rawStartAt;
  const startAtSeconds = startAtParam ? Number(startAtParam) : undefined;

  const selectedVideo = useQuery(
    (api as any).feed.getFeedVideoByMuxAssetId,
    muxAssetId ? { muxAssetId } : "skip",
  ) as FeedVideoItem | null | undefined;

  const feedVideos = useQuery((api as any).feed.listFeedVideos, {
    limit: 20,
  }) as FeedVideoItem[] | undefined;

  const relatedVideos = useMemo(
    () =>
      (feedVideos ?? []).filter((video) => video.muxAssetId !== muxAssetId),
    [feedVideos, muxAssetId],
  );

  const handleBack = () => {
    if (navigation.canGoBack()) {
      router.back();
      return;
    }
    router.replace("/");
  };

  if (!muxAssetId) {
    return (
      <View style={styles.stateContainer}>
        <Stack.Screen options={{ headerShown: false }} />
        <Text style={styles.stateTitle}>Invalid video link</Text>
      </View>
    );
  }

  if (selectedVideo === undefined) {
    return (
      <View style={styles.stateContainer}>
        <Stack.Screen options={{ headerShown: false }} />
        <Text style={styles.stateTitle}>Loading video...</Text>
      </View>
    );
  }

  if (!selectedVideo) {
    return (
      <View style={styles.stateContainer}>
        <Stack.Screen options={{ headerShown: false }} />
        <Text style={styles.stateTitle}>Video not found</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <StatusBar style="light" backgroundColor="#000000" translucent={false} />
      <Stack.Screen options={{ headerShown: false }} />
      <FlatList
        data={relatedVideos}
        keyExtractor={(item) => item.muxAssetId}
        renderItem={({ item }) => (
          <FeedVideoCard
            item={item}
            onPress={(video, startAt) =>
              router.replace({
                pathname: "/video/[muxAssetId]",
                params: {
                  muxAssetId: video.muxAssetId,
                  startAt: String(startAt ?? 0),
                },
              })
            }
          />
        )}
        ListHeaderComponent={
          <View>
            <View style={{ height: insets.top, backgroundColor: "#000" }} />
            <View style={styles.videoWrap}>
              <FullVideoPlayer
                key={selectedVideo.muxAssetId}
                playbackUrl={selectedVideo.playbackUrl}
                startAtSeconds={startAtSeconds}
              />
              <Pressable
                style={[styles.backButton, { top: 8 }]}
                onPress={handleBack}
              >
                <Ionicons name="arrow-back" size={22} color="#FFFFFF" />
              </Pressable>
            </View>
            <View style={styles.metaWrap}>
              <Text style={styles.title}>{selectedVideo.title}</Text>
              <Text style={styles.meta}>
                {selectedVideo.channelName} ·{" "}
                {formatPublished(selectedVideo.createdAtMs)}
              </Text>
            </View>
            <Text style={styles.upNextTitle}>Up next</Text>
          </View>
        }
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Text style={styles.emptyText}>
              {feedVideos === undefined
                ? "Loading recommendations..."
                : "No more videos right now"}
            </Text>
          </View>
        }
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + 90 },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#FFFFFF",
  },
  content: {
    paddingBottom: 24,
  },
  videoWrap: {
    width: "100%",
    aspectRatio: 16 / 9,
    backgroundColor: "#000",
    position: "relative",
  },
  video: {
    width: "100%",
    height: "100%",
  },
  backButton: {
    position: "absolute",
    left: 12,
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#00000099",
  },
  metaWrap: {
    paddingHorizontal: 14,
    paddingTop: 12,
    gap: 6,
  },
  title: {
    fontSize: 18,
    lineHeight: 24,
    fontWeight: "700",
    color: "#111111",
  },
  meta: {
    fontSize: 14,
    color: "#606060",
  },
  upNextTitle: {
    marginTop: 18,
    marginBottom: 8,
    paddingHorizontal: 14,
    fontSize: 16,
    fontWeight: "700",
    color: "#151515",
  },
  emptyWrap: {
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  emptyText: {
    fontSize: 14,
    color: "#666",
  },
  stateContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff",
    paddingHorizontal: 20,
  },
  stateTitle: {
    fontSize: 18,
    fontWeight: "600",
    color: "#161616",
    textAlign: "center",
  },
});
