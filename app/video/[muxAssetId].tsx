import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "convex/react";
import { StatusBar } from "expo-status-bar";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useVideoPlayer, VideoView } from "expo-video";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
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
  const insets = useSafeAreaInsets();
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
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
  const tags = useMemo(() => selectedVideo?.tags ?? [], [selectedVideo?.tags]);
  const previewTags = useMemo(() => tags.slice(0, 3), [tags]);
  const chapters = useMemo(() => selectedVideo?.chapters ?? [], [selectedVideo?.chapters]);
  const [seekToSeconds, setSeekToSeconds] = useState<number | null>(null);
  const [currentTimeSeconds, setCurrentTimeSeconds] = useState(0);
  const [isDetailsSheetVisible, setIsDetailsSheetVisible] = useState(false);
  const [isChaptersSheetVisible, setIsChaptersSheetVisible] = useState(false);
  const summaryPreview = useMemo(
    () => summary ?? "AI summary is being generated for this video.",
    [summary],
  );
  const playerSectionHeight = useMemo(
    () => insets.top + (windowWidth * 9) / 16,
    [insets.top, windowWidth],
  );
  const sheetHeight = useMemo(
    () => Math.max(windowHeight - playerSectionHeight, 240),
    [playerSectionHeight, windowHeight],
  );

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

  useEffect(() => {
    setIsDetailsSheetVisible(false);
    setIsChaptersSheetVisible(false);
  }, [selectedVideo?.muxAssetId]);

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
      </View>

      <View
        style={[
          styles.mainSheet,
          {
            height: sheetHeight,
            paddingBottom: Math.max(insets.bottom, 18),
          },
        ]}
      >
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
              <View style={styles.metaWrap}>
                <View style={styles.titleRow}>
                  <Text style={styles.title}>{selectedVideo.title}</Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Open video chapters"
                    disabled={chapters.length === 0}
                    onPress={() => {
                      setIsDetailsSheetVisible(false);
                      setIsChaptersSheetVisible(true);
                    }}
                    style={({ pressed }) => [
                      styles.chaptersButton,
                      chapters.length === 0 && styles.chaptersButtonDisabled,
                      pressed && chapters.length > 0 && styles.chaptersButtonPressed,
                    ]}
                  >
                    <Ionicons name="book-outline" size={18} color="#1A2332" />
                  </Pressable>
                </View>
                <Text style={styles.meta}>
                  {selectedVideo.channelName} ·{" "}
                  {formatPublished(selectedVideo.createdAtMs)}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Open video details"
                  onPress={() => {
                    setIsChaptersSheetVisible(false);
                    setIsDetailsSheetVisible(true);
                  }}
                  style={({ pressed }) => [
                    styles.detailsCard,
                    pressed && styles.detailsCardPressed,
                  ]}
                >
                  <View style={styles.detailsCardHeader}>
                    <Text style={styles.detailsCardTitle}>Description</Text>
                    <Text style={styles.detailsCardMore}>more</Text>
                  </View>
                  <Text numberOfLines={2} style={summary ? styles.summary : styles.summaryPending}>
                    {summaryPreview}
                  </Text>
                  {previewTags.length > 0 ? (
                    <View style={styles.tagsWrap}>
                      {previewTags.map((tag) => (
                        <View key={`${selectedVideo.muxAssetId}-${tag}`} style={styles.tagPill}>
                          <Text style={styles.tagText}>#{tag}</Text>
                        </View>
                      ))}
                    </View>
                  ) : null}
                </Pressable>
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
          contentContainerStyle={styles.mainSheetContent}
        />
      </View>

      <Modal
        transparent
        animationType="slide"
        presentationStyle="overFullScreen"
        statusBarTranslucent
        visible={isDetailsSheetVisible}
        onRequestClose={() => setIsDetailsSheetVisible(false)}
      >
        <View style={styles.sheetOverlay}>
          <Pressable
            style={[styles.sheetBackdrop, { height: playerSectionHeight }]}
            onPress={() => setIsDetailsSheetVisible(false)}
          />
          <View
            style={[
              styles.sheetCard,
              {
                height: sheetHeight,
                paddingBottom: Math.max(insets.bottom, 18),
              },
            ]}
          >
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <View style={styles.sheetHeadingBlock}>
                <Text style={styles.sheetTitle}>Description</Text>
                <Text style={styles.sheetVideoTitle}>{selectedVideo.title}</Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close video details"
                onPress={() => setIsDetailsSheetVisible(false)}
                style={({ pressed }) => [
                  styles.sheetCloseButton,
                  pressed && styles.sheetCloseButtonPressed,
                ]}
              >
                <Ionicons name="close" size={20} color="#162033" />
              </Pressable>
            </View>

            <ScrollView
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.sheetContent}
            >
              <Text style={styles.sheetMeta}>
                {selectedVideo.channelName} · {formatPublished(selectedVideo.createdAtMs)}
              </Text>
              <Text style={summary ? styles.sheetSummary : styles.summaryPending}>
                {summaryPreview}
              </Text>

              {tags.length > 0 ? (
                <View style={styles.sheetSection}>
                  <Text style={styles.sheetSectionTitle}>Tags</Text>
                  <View style={styles.tagsWrap}>
                    {tags.map((tag) => (
                      <View key={`${selectedVideo.muxAssetId}-${tag}`} style={styles.tagPill}>
                        <Text style={styles.tagText}>#{tag}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              ) : null}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal
        transparent
        animationType="slide"
        presentationStyle="overFullScreen"
        statusBarTranslucent
        visible={isChaptersSheetVisible}
        onRequestClose={() => setIsChaptersSheetVisible(false)}
      >
        <View style={styles.sheetOverlay}>
          <Pressable
            style={[styles.sheetBackdrop, { height: playerSectionHeight }]}
            onPress={() => setIsChaptersSheetVisible(false)}
          />
          <View
            style={[
              styles.sheetCard,
              {
                height: sheetHeight,
                paddingBottom: Math.max(insets.bottom, 18),
              },
            ]}
          >
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <View style={styles.sheetHeadingBlock}>
                <Text style={styles.sheetTitle}>Chapters</Text>
                <Text style={styles.sheetVideoTitle}>{selectedVideo.title}</Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close video chapters"
                onPress={() => setIsChaptersSheetVisible(false)}
                style={({ pressed }) => [
                  styles.sheetCloseButton,
                  pressed && styles.sheetCloseButtonPressed,
                ]}
              >
                <Ionicons name="close" size={20} color="#162033" />
              </Pressable>
            </View>

            <View style={styles.chapterSheetBody}>
              {chapters.length > 0 ? (
                <View style={styles.chapterSheetCard}>
                  <ScrollView
                    showsVerticalScrollIndicator={false}
                    contentContainerStyle={styles.chapterSheetScrollContent}
                  >
                    {chapters.map((chapter) => {
                      const isActive = activeChapterStartTime === chapter.startTime;
                      const timeLabel = formatDuration(chapter.startTime) ?? "0:00";

                      return (
                        <Pressable
                          key={`${selectedVideo.muxAssetId}-${chapter.startTime}-${chapter.title}`}
                          onPress={() => {
                            setSeekToSeconds(chapter.startTime);
                            setIsChaptersSheetVisible(false);
                          }}
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
                  </ScrollView>
                </View>
              ) : (
                <View style={styles.chapterSheetEmptyState}>
                  <Text style={styles.summaryPending}>
                    Chapters are still being generated for this video.
                  </Text>
                </View>
              )}
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#FFFFFF",
  },
  mainSheet: {
    flexShrink: 0,
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 10,
  },
  mainSheetContent: {
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
  metaWrap: {
    paddingHorizontal: 14,
    paddingTop: 12,
    gap: 10,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
  },
  title: {
    flex: 1,
    fontSize: 18,
    lineHeight: 24,
    fontWeight: "700",
    color: "#111111",
  },
  chaptersButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#F3F6FB",
  },
  chaptersButtonDisabled: {
    opacity: 0.45,
  },
  chaptersButtonPressed: {
    opacity: 0.8,
  },
  meta: {
    fontSize: 14,
    color: "#606060",
  },
  summary: {
    fontSize: 14,
    lineHeight: 20,
    color: "#232323",
  },
  summaryPending: {
    fontSize: 13,
    lineHeight: 18,
    color: "#7D7D7D",
  },
  detailsCard: {
    backgroundColor: "#F5F7FB",
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 8,
  },
  detailsCardPressed: {
    opacity: 0.86,
  },
  detailsCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  detailsCardTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#202B3D",
  },
  detailsCardMore: {
    fontSize: 13,
    fontWeight: "700",
    color: "#202B3D",
    textTransform: "lowercase",
  },
  tagsWrap: {
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
  sheetOverlay: {
    flex: 1,
    justifyContent: "flex-start",
  },
  sheetBackdrop: {
    backgroundColor: "transparent",
  },
  sheetCard: {
    flexShrink: 0,
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 10,
  },
  sheetHandle: {
    width: 42,
    height: 5,
    borderRadius: 999,
    backgroundColor: "#D6DDE8",
    alignSelf: "center",
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 10,
  },
  sheetHeadingBlock: {
    flex: 1,
    paddingRight: 12,
    gap: 4,
  },
  sheetTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: "#121A2A",
  },
  sheetVideoTitle: {
    fontSize: 15,
    lineHeight: 21,
    fontWeight: "600",
    color: "#1A2332",
  },
  sheetCloseButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#F3F6FB",
  },
  sheetCloseButtonPressed: {
    opacity: 0.8,
  },
  sheetContent: {
    paddingHorizontal: 16,
    paddingTop: 4,
    gap: 14,
  },
  sheetMeta: {
    fontSize: 13,
    color: "#5A6475",
  },
  sheetSummary: {
    fontSize: 15,
    lineHeight: 22,
    color: "#1A2332",
  },
  sheetSection: {
    gap: 10,
  },
  sheetSectionTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#344055",
  },
  chapterSheetBody: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 6,
  },
  chapterSheetCard: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#E5EAF2",
    borderRadius: 16,
    backgroundColor: "#FFFFFF",
    overflow: "hidden",
  },
  chapterSheetScrollContent: {
    paddingBottom: 12,
  },
  chapterSheetEmptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
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
