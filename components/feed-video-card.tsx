import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { Activity, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { InlineVideoPlayer } from "@/components/inline-video-player";

export type FeedVideoItem = {
  muxAssetId: string;
  playbackId: string;
  playbackUrl: string;
  thumbnailUrl: string;
  title: string;
  summary: string | null;
  tags: string[];
  chapters: { title: string; startTime: number }[];
  keyMoments: FeedVideoKeyMoment[];
  keyMomentsGeneratedAtMs: number | null;
  keyMomentsUnavailableReason: string | null;
  channelName: string;
  channelAvatarUrl: string | null;
  durationSeconds: number | null;
  createdAtMs: number;
};

export type FeedVideoKeyMomentCue = {
  startMs: number;
  endMs: number;
  text: string;
};

export type FeedVideoKeyMomentVisualConcept = {
  concept: string;
  score: number;
  rationale: string;
};

export type FeedVideoKeyMoment = {
  startMs: number;
  endMs: number;
  cues: FeedVideoKeyMomentCue[];
  overallScore: number | null;
  title: string | null;
  audibleNarrative: string | null;
  notableAudibleConcepts: string[];
  visualNarrative: string | null;
  notableVisualConcepts: FeedVideoKeyMomentVisualConcept[];
};

export function formatDuration(durationSeconds: number | null) {
  if (!durationSeconds || Number.isNaN(durationSeconds)) return null;
  const rounded = Math.max(0, Math.floor(durationSeconds));
  const minutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function formatPublished(createdAtMs: number) {
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

type FeedVideoCardProps = {
  item: FeedVideoItem;
  onPress?: (item: FeedVideoItem, startAtSeconds?: number) => void;
  showPlayIcon?: boolean;
  isFocused?: boolean;
  shouldPreload?: boolean;
  onMeasured?: (layout: { y: number; height: number }) => void;
};

export function FeedVideoCard({
  item,
  onPress,
  showPlayIcon = true,
  isFocused = false,
  shouldPreload = false,
  onMeasured,
}: FeedVideoCardProps) {
  const router = useRouter();
  const [previewPositionSeconds, setPreviewPositionSeconds] = useState(0);

  const durationLabel = useMemo(
    () => formatDuration(item.durationSeconds),
    [item.durationSeconds],
  );

  const shouldRenderPlayer = shouldPreload || isFocused;
  const showPreview = isFocused;

  const handlePress = () => {
    if (onPress) {
      onPress(item, previewPositionSeconds);
      return;
    }

    router.push({
      pathname: "/video/[muxAssetId]",
      params: {
        muxAssetId: item.muxAssetId,
        startAt: String(previewPositionSeconds),
      },
    });
  };

  return (
    <Pressable
      onPress={handlePress}
      onLayout={(event) => {
        onMeasured?.({
          y: event.nativeEvent.layout.y,
          height: event.nativeEvent.layout.height,
        });
      }}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
    >
      <View style={styles.videoContainer}>
        <Image
          source={{ uri: item.thumbnailUrl }}
          contentFit="cover"
          style={styles.thumbnail}
        />
        {shouldRenderPlayer ? (
          <Activity mode="visible" name={`feed-preview-${item.muxAssetId}`}>
            <View
              style={[styles.previewLayer, !showPreview && styles.previewHidden]}
            >
              <InlineVideoPlayer
                playbackUrl={item.playbackUrl}
                isFocused={isFocused}
                startAtSeconds={previewPositionSeconds}
                onTimeUpdate={setPreviewPositionSeconds}
              />
            </View>
          </Activity>
        ) : null}
        {showPlayIcon ? (
          <View style={styles.playOverlay}>
            <Ionicons name="play-circle" size={56} color="#FFFFFFE6" />
          </View>
        ) : null}
        {durationLabel ? (
          <View style={styles.durationBadge}>
            <Text style={styles.durationText}>{durationLabel}</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.metaRow}>
        <View style={styles.avatar}>
          {item.channelAvatarUrl ? (
            <Image
              source={{ uri: item.channelAvatarUrl }}
              contentFit="cover"
              style={styles.avatarImage}
            />
          ) : (
            <Text style={styles.avatarText}>
              {item.channelName.trim().charAt(0).toUpperCase() || "R"}
            </Text>
          )}
        </View>
        <View style={styles.metaTextWrap}>
          <Text numberOfLines={2} style={styles.title}>
            {item.title}
          </Text>
          <Text numberOfLines={1} style={styles.meta}>
            {item.channelName} · {formatPublished(item.createdAtMs)}
          </Text>
        </View>
        <View style={styles.moreButton}>
          <Ionicons name="ellipsis-vertical" size={18} color="#4A4A4A" />
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    marginBottom: 20,
  },
  cardPressed: {
    opacity: 0.9,
  },
  videoContainer: {
    width: "100%",
    aspectRatio: 16 / 9,
    backgroundColor: "#111",
    position: "relative",
  },
  thumbnail: {
    ...StyleSheet.absoluteFillObject,
  },
  playOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  previewLayer: {
    ...StyleSheet.absoluteFillObject,
  },
  previewHidden: {
    opacity: 0,
  },
  durationBadge: {
    position: "absolute",
    right: 12,
    bottom: 12,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    backgroundColor: "#000000CC",
  },
  durationText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "600",
  },
  metaRow: {
    flexDirection: "row",
    gap: 14,
    paddingHorizontal: 12,
    paddingTop: 14,
    alignItems: "flex-start",
  },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: "#FF4FA7",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  avatarImage: {
    width: "100%",
    height: "100%",
  },
  avatarText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 18,
  },
  metaTextWrap: {
    flex: 1,
    gap: 4,
  },
  title: {
    fontSize: 18,
    lineHeight: 24,
    fontWeight: "600",
    color: "#101010",
  },
  meta: {
    fontSize: 14,
    color: "#666",
    lineHeight: 20,
  },
  moreButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
});
