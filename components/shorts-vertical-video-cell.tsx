import { MuxVideoView } from "@mux/mux-react-native-player";
import { Image } from "expo-image";
import { memo, useCallback, useEffect } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import type { FeedVideoItem } from "@/components/feed-video-card";
import { ShortsVerticalVideoOverlay } from "@/components/shorts-vertical-video-overlay";
import type { ShortsCellPlayback } from "@/hooks/use-shorts-screen-playback";
import { bumpFeedCounter } from "@/lib/feed/feed-telemetry";
import {
  buildShortsVideoAccessibilityHint,
  buildShortsVideoAccessibilityLabel,
} from "@/lib/shorts/shorts-accessibility";
import type { ShortsOverlayInsets } from "@/lib/shorts/shorts-viewport";

export type ShortsVerticalVideoCellProps = {
  item: FeedVideoItem;
  /** Measured content viewport. One cell occupies exactly one page. */
  pageHeight: number;
  /** Width-resolved thumbnail from the adaptive policy. */
  thumbnailUrl: string;
  index: number;
  itemCount: number;
  overlayInsets: ShortsOverlayInsets;
  isFeedExhausted: boolean;
  /**
   * Playback wiring, or undefined for a measurement/recycling pass. A cell that
   * is not rendering into the viewport must never own the player surface.
   */
  playback?: ShortsCellPlayback;
  onTogglePlayback: () => void;
  onToggleMute: () => void;
  onRetry: () => void;
  onOpenDetail: (item: FeedVideoItem) => void;
};

/**
 * One full-viewport 9:16 page.
 *
 * The cell is thumbnail-first by construction: the Mux thumbnail is mounted
 * above the native surface and only becomes transparent once the committed
 * source reports a real frame, so a recycled cell, a loading source, an offline
 * viewer, and a playback error all show a poster rather than a black rectangle.
 * `recyclingKey` ties the decoded image to the asset, which is what stops a
 * reused cell from painting the previous video's frame during a fast fling.
 */
function ShortsVerticalVideoCellComponent({
  item,
  pageHeight,
  thumbnailUrl,
  index,
  itemCount,
  overlayInsets,
  isFeedExhausted,
  playback,
  onTogglePlayback,
  onToggleMute,
  onRetry,
  onOpenDetail,
}: ShortsVerticalVideoCellProps) {
  const { muxAssetId } = item;
  const isActive = playback?.isActive ?? false;
  const hasFirstFrame = playback?.hasFirstFrame ?? false;
  const isPlaying = playback?.isPlaying ?? false;
  const isPaused = playback?.isPaused ?? false;
  const hasError = playback?.hasError ?? false;
  const isMuted = playback?.isMuted ?? true;

  useEffect(() => {
    bumpFeedCounter("mountedRows");
    return () => bumpFeedCounter("mountedRows", -1);
  }, []);

  // Attach/detach is scoped to this cell's asset id, so a recycled cell that
  // rebinds to different content detaches before the new content binds.
  const surface = playback?.surface;
  useEffect(() => {
    if (!isActive || !surface) return;
    surface.onSurfaceAttached(muxAssetId);
    return () => surface.onSurfaceDetached(muxAssetId);
  }, [isActive, muxAssetId, surface]);

  // Bound here rather than inline in JSX so the memoized overlay is not
  // invalidated by a fresh closure on every scroll-driven re-render.
  const handleOpenDetail = useCallback(
    () => onOpenDetail(item),
    [item, onOpenDetail],
  );

  const accessibilityLabel = buildShortsVideoAccessibilityLabel({
    title: item.title,
    channelName: item.channelName,
    index,
    itemCount,
    isPlaying,
    isMuted,
    hasError,
  });

  return (
    <View style={[styles.page, { height: pageHeight }]}>
      {/*
        Tap-to-pause lives on the media layer only. It is a plain Pressable, so
        it never claims the vertical pan the list needs for paging: a swipe
        cancels the press instead of firing it.

        Only the active page is pressable. Pause and retry act on the committed
        asset, so a tap that lands on a pre-rendered neighbour mid-swipe would
        otherwise pause a different video than the one under the finger.
      */}
      <Pressable
        onPress={isActive ? (hasError ? onRetry : onTogglePlayback) : undefined}
        disabled={!isActive}
        accessibilityElementsHidden={!isActive}
        importantForAccessibility={isActive ? "yes" : "no-hide-descendants"}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={buildShortsVideoAccessibilityHint({ isPlaying, hasError })}
        accessibilityState={{ selected: isActive, busy: isActive && !hasFirstFrame }}
        style={styles.mediaLayer}
      >
        {isActive && playback ? (
          <View style={styles.previewLayer} pointerEvents="none">
            <MuxVideoView
              player={playback.player}
              style={styles.video}
              // Immersive full-viewport presentation. The source is already an
              // exact 9:16 asset, so cover crops nothing on a portrait page.
              contentFit="cover"
              controls="none"
              nativeControls={false}
              allowsFullscreen={false}
              // The <Image> below is the poster; a second one inside the native
              // view would fetch and decode the same frame again.
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

        <Image
          source={{ uri: thumbnailUrl }}
          recyclingKey={muxAssetId}
          contentFit="cover"
          cachePolicy="memory-disk"
          transition={0}
          style={[
            styles.thumbnail,
            isActive && hasFirstFrame && styles.thumbnailHidden,
          ]}
        />
      </Pressable>

      <ShortsVerticalVideoOverlay
        item={item}
        insets={overlayInsets}
        isActive={isActive}
        isMuted={isMuted}
        isPlaying={isPlaying}
        isPaused={isPaused}
        hasError={hasError}
        isFeedExhausted={isFeedExhausted}
        onToggleMute={onToggleMute}
        onTogglePlayback={onTogglePlayback}
        onRetry={onRetry}
        onOpenDetail={handleOpenDetail}
      />
    </View>
  );
}

/**
 * Recycled cells re-render on every scroll tick, so the comparison is limited
 * to the cell's own data and its own playback state.
 *
 * `player` and `surface` are stable for the life of the screen. `hasFirstFrame`,
 * `isPlaying`, and `isPaused` describe the *committed* video, so they are only
 * compared for a cell that is active: otherwise every inactive page would
 * re-render each time the active page reached its first frame.
 */
function areShortsCellPropsEqual(
  previous: ShortsVerticalVideoCellProps,
  next: ShortsVerticalVideoCellProps,
): boolean {
  if (
    previous.item !== next.item ||
    previous.pageHeight !== next.pageHeight ||
    previous.thumbnailUrl !== next.thumbnailUrl ||
    previous.index !== next.index ||
    previous.itemCount !== next.itemCount ||
    previous.overlayInsets !== next.overlayInsets ||
    previous.isFeedExhausted !== next.isFeedExhausted ||
    previous.onTogglePlayback !== next.onTogglePlayback ||
    previous.onToggleMute !== next.onToggleMute ||
    previous.onRetry !== next.onRetry ||
    previous.onOpenDetail !== next.onOpenDetail
  ) {
    return false;
  }

  if (
    previous.playback?.player !== next.playback?.player ||
    previous.playback?.surface !== next.playback?.surface
  ) {
    return false;
  }

  const wasActive = previous.playback?.isActive ?? false;
  const isActive = next.playback?.isActive ?? false;
  if (wasActive !== isActive) return false;

  // Sound state is shown on every page's control column, active or not.
  if ((previous.playback?.isMuted ?? true) !== (next.playback?.isMuted ?? true)) {
    return false;
  }
  if (
    (previous.playback?.hasError ?? false) !== (next.playback?.hasError ?? false)
  ) {
    return false;
  }

  if (!isActive) return true;

  return (
    (previous.playback?.hasFirstFrame ?? false) ===
      (next.playback?.hasFirstFrame ?? false) &&
    (previous.playback?.isPlaying ?? false) === (next.playback?.isPlaying ?? false) &&
    (previous.playback?.isPaused ?? false) === (next.playback?.isPaused ?? false)
  );
}

export const ShortsVerticalVideoCell = memo(
  ShortsVerticalVideoCellComponent,
  areShortsCellPropsEqual,
);

ShortsVerticalVideoCell.displayName = "ShortsVerticalVideoCell";

const styles = StyleSheet.create({
  page: {
    width: "100%",
    // Black behind the media so letterboxing, loading, and errors never flash
    // a light surface on an immersive feed.
    backgroundColor: "#000000",
    position: "relative",
    overflow: "hidden",
  },
  mediaLayer: {
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
  thumbnail: {
    ...StyleSheet.absoluteFillObject,
  },
  thumbnailHidden: {
    opacity: 0,
  },
});
