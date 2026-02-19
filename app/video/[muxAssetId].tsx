import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "convex/react";
import { StatusBar } from "expo-status-bar";
import { Stack, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useVideoPlayer, VideoView } from "expo-video";
import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  FeedVideoCard,
  type FeedVideoItem,
  formatDuration,
  formatPublished,
} from "@/components/feed-video-card";
import { api } from "@/convex/_generated/api";

function FullVideoPlayer({
  playbackUrl,
  startAtSeconds,
  seekToSeconds,
  onSeekHandled,
  onTimeUpdate,
}: {
  playbackUrl: string;
  startAtSeconds?: number;
  seekToSeconds?: number | null;
  onSeekHandled?: () => void;
  onTimeUpdate?: (seconds: number) => void;
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

  useEffect(() => {
    if (seekToSeconds === undefined || seekToSeconds === null || Number.isNaN(seekToSeconds)) {
      return;
    }

    player.currentTime = Math.max(0, seekToSeconds);
    onSeekHandled?.();
  }, [onSeekHandled, player, seekToSeconds]);

  useEffect(() => {
    const subscription = player.addListener("timeUpdate", (event) => {
      onTimeUpdate?.(event.currentTime);
    });

    return () => {
      subscription.remove();
    };
  }, [onTimeUpdate, player]);

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
  const summary = selectedVideo?.summary ?? null;
  const tags = selectedVideo?.tags ?? [];
  const chapters = useMemo(() => selectedVideo?.chapters ?? [], [selectedVideo?.chapters]);
  const [seekToSeconds, setSeekToSeconds] = useState<number | null>(null);
  const [currentTimeSeconds, setCurrentTimeSeconds] = useState(0);

  const activeChapterStartTime = useMemo(() => {
    if (chapters.length === 0) return null;
    let active = chapters[0]?.startTime ?? 0;
    for (const chapter of chapters) {
      if (chapter.startTime <= currentTimeSeconds) {
        active = chapter.startTime;
      } else {
        break;
      }
    }
    return active;
  }, [chapters, currentTimeSeconds]);

  useEffect(() => {
    setCurrentTimeSeconds(startAtSeconds ?? 0);
    setSeekToSeconds(null);
  }, [selectedVideo?.muxAssetId, startAtSeconds]);

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
                seekToSeconds={seekToSeconds}
                onSeekHandled={() => setSeekToSeconds(null)}
                onTimeUpdate={setCurrentTimeSeconds}
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
              {summary ? (
                <Text style={styles.summary}>{summary}</Text>
              ) : (
                <Text style={styles.summaryPending}>
                  AI summary is being generated for this video.
                </Text>
              )}
              {tags.length > 0 ? (
                <View style={styles.tagsWrap}>
                  {tags.map((tag) => (
                    <View key={`${selectedVideo.muxAssetId}-${tag}`} style={styles.tagPill}>
                      <Text style={styles.tagText}>#{tag}</Text>
                    </View>
                  ))}
                </View>
              ) : null}

              {chapters.length > 0 ? (
                <View style={styles.chaptersWrap}>
                  <Text style={styles.chaptersTitle}>Chapters</Text>
                  {chapters.map((chapter) => {
                    const isActive = activeChapterStartTime === chapter.startTime;
                    const timeLabel = formatDuration(chapter.startTime) ?? "0:00";

                    return (
                      <Pressable
                        key={`${selectedVideo.muxAssetId}-${chapter.startTime}-${chapter.title}`}
                        onPress={() => setSeekToSeconds(chapter.startTime)}
                        style={({ pressed }) => [
                          styles.chapterRow,
                          isActive && styles.chapterRowActive,
                          pressed && styles.chapterRowPressed,
                        ]}
                      >
                        <Text style={styles.chapterTime}>{timeLabel}</Text>
                        <Text style={styles.chapterLabel}>{chapter.title}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              ) : null}
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
  summary: {
    marginTop: 2,
    fontSize: 14,
    lineHeight: 20,
    color: "#232323",
  },
  summaryPending: {
    marginTop: 2,
    fontSize: 13,
    lineHeight: 18,
    color: "#7D7D7D",
  },
  tagsWrap: {
    marginTop: 2,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  tagPill: {
    borderRadius: 999,
    backgroundColor: "#EEF4FF",
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  tagText: {
    fontSize: 12,
    lineHeight: 16,
    color: "#2558A8",
    fontWeight: "600",
  },
  upNextTitle: {
    marginTop: 18,
    marginBottom: 8,
    paddingHorizontal: 14,
    fontSize: 16,
    fontWeight: "700",
    color: "#151515",
  },
  chaptersWrap: {
    marginTop: 10,
    borderWidth: 1,
    borderColor: "#E5EAF2",
    borderRadius: 12,
    overflow: "hidden",
  },
  chaptersTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#344055",
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 8,
    backgroundColor: "#F7FAFF",
  },
  chapterRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#E5EAF2",
    backgroundColor: "#FFFFFF",
  },
  chapterRowActive: {
    backgroundColor: "#EEF4FF",
  },
  chapterRowPressed: {
    opacity: 0.8,
  },
  chapterTime: {
    width: 46,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "700",
    color: "#3966A8",
  },
  chapterLabel: {
    flex: 1,
    fontSize: 14,
    lineHeight: 18,
    color: "#1A2332",
    fontWeight: "600",
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
