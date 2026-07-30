import { Ionicons } from "@expo/vector-icons";
import { MuxVideoView, type MuxVideoPlayer } from "@mux/mux-react-native-player";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { memo, useCallback, useEffect, useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import type { FeedPlaybackSurfaceCallbacks } from "@/hooks/use-feed-playback-controller";
import { bumpFeedCounter } from "@/lib/feed/feed-telemetry";

export type FeedVideoItem = {
  muxAssetId: string;
  playbackId: string;
  thumbnailUrl: string;
  title: string;
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

/** Rich video-detail data. This must never be returned by the card feed query. */
export type FeedVideoDetailItem = FeedVideoItem & {
  playbackUrl: string;
  summary: string | null;
  tags: string[];
  chapters: { title: string; startTime: number }[];
  keyMoments: FeedVideoKeyMoment[];
  keyMomentsGeneratedAtMs: number | null;
  keyMomentsUnavailableReason: string | null;
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

/**
 * Everything the card needs to host the feed's single player surface. Passing
 * `undefined` (the profile screen, related-video lists) keeps the card strictly
 * thumbnail-only, which is the documented default.
 */
export type FeedVideoCardPlayback = {
  player: MuxVideoPlayer | null;
  /** True only for the committed card. At most one card may receive true. */
  isActive: boolean;
  /** Hides the thumbnail once the active source has produced a frame. */
  hasFirstFrame: boolean;
  surface: FeedPlaybackSurfaceCallbacks;
  /** Preview position handed to the detail screen on navigation. */
  getPreviewPositionSeconds: (muxAssetId: string) => number;
};

type FeedVideoCardProps = {
  item: FeedVideoItem;
  /** Width-resolved thumbnail from the adaptive policy. Defaults to the item's. */
  thumbnailUrl?: string;
  onPress?: (item: FeedVideoItem, startAtSeconds?: number) => void;
  showPlayIcon?: boolean;
  playback?: FeedVideoCardPlayback;
  onMeasured?: (layout: { y: number; height: number }) => void;
};

function FeedVideoCardComponent({
  item,
  thumbnailUrl,
  onPress,
  showPlayIcon = true,
  playback,
  onMeasured,
}: FeedVideoCardProps) {
  const router = useRouter();
  const { muxAssetId } = item;
  const isActive = playback?.isActive ?? false;
  const hasFirstFrame = playback?.hasFirstFrame ?? false;

  const durationLabel = useMemo(
    () => formatDuration(item.durationSeconds),
    [item.durationSeconds],
  );

  useEffect(() => {
    bumpFeedCounter("mountedRows");
    return () => bumpFeedCounter("mountedRows", -1);
  }, []);

  // Attach/detach reporting is scoped to this card's asset id, so a recycled row
  // that rebinds to different content detaches before the new content binds.
  const surface = playback?.surface;
  useEffect(() => {
    if (!isActive || !surface) return;
    surface.onSurfaceAttached(muxAssetId);
    return () => surface.onSurfaceDetached(muxAssetId);
  }, [isActive, muxAssetId, surface]);

  const handlePress = useCallback(() => {
    const startAtSeconds = playback?.getPreviewPositionSeconds(muxAssetId) ?? 0;
    if (onPress) {
      onPress(item, startAtSeconds);
      return;
    }

    router.push({
      pathname: "/video/[muxAssetId]",
      params: {
        muxAssetId,
        startAt: String(startAtSeconds),
      },
    });
  }, [item, muxAssetId, onPress, playback, router]);

  const handleLayout = useCallback(
    (event: { nativeEvent: { layout: { y: number; height: number } } }) => {
      onMeasured?.({
        y: event.nativeEvent.layout.y,
        height: event.nativeEvent.layout.height,
      });
    },
    [onMeasured],
  );

  return (
    <Pressable
      onPress={handlePress}
      onLayout={onMeasured ? handleLayout : undefined}
      style={pressableStyle}
    >
      <View style={styles.videoContainer}>
        {isActive && playback?.player ? (
          <View style={styles.previewLayer} pointerEvents="none">
            <MuxVideoView
              player={playback.player}
              style={styles.video}
              contentFit="cover"
              controls="none"
              nativeControls={false}
              allowsFullscreen={false}
              /*
                The Expo <Image> above already supplies the placeholder; a second
                poster inside MuxVideoView would fetch and decode the same frame
                a second time.
              */
              poster={false}
              timeUpdateEventInterval={0.25}
              onStatusChange={(event) =>
                playback.surface.onStatusChange(muxAssetId, event.status)
              }
              onSourceLoad={() => playback.surface.onSourceLoad(muxAssetId)}
              onTimeUpdate={(event) =>
                playback.surface.onTimeUpdate(muxAssetId, event.currentTime)
              }
              onSourceError={(event) =>
                playback.surface.onSourceError(muxAssetId, event.message)
              }
            />
          </View>
        ) : null}
        {/*
          Keep the thumbnail mounted above the native surface while the source
          loads. It becomes transparent only after the active player reports a
          real frame, preventing the native view's black loading state from
          showing through. The recycling key prevents reused cells from painting
          the previous card's image.
        */}
        <Image
          source={{ uri: thumbnailUrl ?? item.thumbnailUrl }}
          recyclingKey={muxAssetId}
          contentFit="cover"
          cachePolicy="memory-disk"
          transition={0}
          style={[styles.thumbnail, isActive && hasFirstFrame && styles.thumbnailHidden]}
        />
        {showPlayIcon ? (
          <View style={styles.playOverlay} pointerEvents="none">
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
              recyclingKey={muxAssetId}
              contentFit="cover"
              cachePolicy="memory-disk"
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

const pressableStyle = ({ pressed }: { pressed: boolean }) => [
  styles.card,
  pressed && styles.cardPressed,
];

/**
 * Recycled rows re-render constantly, so the comparison is limited to card data
 * plus this card's own active/player state. `playback.player` and
 * `playback.surface` are stable for the life of the screen; `isActive` and
 * `hasFirstFrame` are the only playback fields that can change a card's output.
 */
export const FeedVideoCard = memo(
  FeedVideoCardComponent,
  (previous, next) =>
    previous.item === next.item &&
    previous.thumbnailUrl === next.thumbnailUrl &&
    previous.showPlayIcon === next.showPlayIcon &&
    previous.onPress === next.onPress &&
    previous.onMeasured === next.onMeasured &&
    previous.playback?.player === next.playback?.player &&
    previous.playback?.surface === next.playback?.surface &&
    previous.playback?.getPreviewPositionSeconds ===
      next.playback?.getPreviewPositionSeconds &&
    (previous.playback?.isActive ?? false) === (next.playback?.isActive ?? false) &&
    // hasFirstFrame only affects a card that is currently active.
    ((previous.playback?.isActive ?? false) === false ||
      (previous.playback?.hasFirstFrame ?? false) ===
        (next.playback?.hasFirstFrame ?? false)),
);

FeedVideoCard.displayName = "FeedVideoCard";

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
  thumbnailHidden: {
    opacity: 0,
  },
  playOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  previewLayer: {
    ...StyleSheet.absoluteFillObject,
  },
  video: {
    flex: 1,
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
