import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useVideoPlayer, VideoView } from "expo-video";
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

export type FeedVideoItem = {
  muxAssetId: string;
  playbackId: string;
  playbackUrl: string;
  thumbnailUrl: string;
  title: string;
  channelName: string;
  durationSeconds: number | null;
  createdAtMs: number;
};

function formatDuration(durationSeconds: number | null) {
  if (!durationSeconds || Number.isNaN(durationSeconds)) return null;
  const rounded = Math.max(0, Math.floor(durationSeconds));
  const minutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatPublished(createdAtMs: number) {
  const diffMs = Date.now() - createdAtMs;
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (days < 1) return "Today";
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

export function FeedVideoCard({ item }: { item: FeedVideoItem }) {
  const [isPlaying, setIsPlaying] = useState(false);
  const player = useVideoPlayer(
    { uri: item.playbackUrl, contentType: "hls" },
    (videoPlayer) => {
      videoPlayer.loop = false;
    },
  );

  const durationLabel = useMemo(
    () => formatDuration(item.durationSeconds),
    [item.durationSeconds],
  );

  const togglePlayback = () => {
    if (isPlaying) {
      player.pause();
      setIsPlaying(false);
      return;
    }
    player.play();
    setIsPlaying(true);
  };

  return (
    <View style={styles.card}>
      <Pressable onPress={togglePlayback} style={styles.videoContainer}>
        <VideoView
          player={player}
          nativeControls={false}
          contentFit="cover"
          allowsVideoFrameAnalysis={false}
          style={styles.video}
        />
        {!isPlaying ? (
          <Image
            source={{ uri: item.thumbnailUrl }}
            contentFit="cover"
            style={styles.thumbnail}
          />
        ) : null}
        {!isPlaying ? (
          <View style={styles.playOverlay}>
            <Ionicons name="play-circle" size={56} color="#FFFFFFE6" />
          </View>
        ) : null}
        {durationLabel ? (
          <View style={styles.durationBadge}>
            <Text style={styles.durationText}>{durationLabel}</Text>
          </View>
        ) : null}
      </Pressable>

      <View style={styles.metaRow}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>
            {item.channelName.trim().charAt(0).toUpperCase() || "R"}
          </Text>
        </View>
        <View style={styles.metaTextWrap}>
          <Text numberOfLines={2} style={styles.title}>
            {item.title}
          </Text>
          <Text numberOfLines={1} style={styles.meta}>
            {item.channelName} · {formatPublished(item.createdAtMs)}
          </Text>
        </View>
        <Pressable hitSlop={8} style={styles.moreButton}>
          <Ionicons name="ellipsis-vertical" size={18} color="#4A4A4A" />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginBottom: 18,
  },
  videoContainer: {
    width: "100%",
    aspectRatio: 16 / 9,
    backgroundColor: "#111",
    position: "relative",
  },
  video: {
    width: "100%",
    height: "100%",
  },
  thumbnail: {
    ...StyleSheet.absoluteFillObject,
  },
  playOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  durationBadge: {
    position: "absolute",
    right: 8,
    bottom: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: "#000000CC",
  },
  durationText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "600",
  },
  metaRow: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 12,
    paddingTop: 10,
    alignItems: "flex-start",
  },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "#FF4FA7",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    color: "#fff",
    fontWeight: "700",
  },
  metaTextWrap: {
    flex: 1,
    gap: 2,
  },
  title: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: "600",
    color: "#101010",
  },
  meta: {
    fontSize: 13,
    color: "#666",
  },
  moreButton: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
});
