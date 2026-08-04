import { MuxVideoView } from "@mux/mux-react-native-player";
import { Image } from "expo-image";
import { memo, useEffect } from "react";
import { StyleSheet, View } from "react-native";

import type { FeedVideoItem } from "@/components/feed-video-card";
import { ShortsVerticalVideoOverlay } from "@/components/shorts-vertical-video-overlay";
import type { ShortsCellPlayback } from "@/hooks/use-shorts-screen-playback";
import { bumpFeedCounter } from "@/lib/feed/feed-telemetry";
import type { ShortsOverlayInsets } from "@/lib/shorts/shorts-viewport";

export type ShortsVerticalVideoCellProps = {
  item: FeedVideoItem;
  /** Measured content viewport. One cell occupies exactly one page. */
  pageHeight: number;
  /** Width-resolved thumbnail from the adaptive policy. */
  thumbnailUrl: string;
  overlayInsets: ShortsOverlayInsets;
  isFeedExhausted: boolean;
  /**
   * Playback wiring, or undefined for a measurement/recycling pass. A cell that
   * is not rendering into the viewport must never own the player surface.
   */
  playback?: ShortsCellPlayback;
  onToggleMute: () => void;
  onRetry: () => void;
};

/**
 * One full-viewport 9:16 page.
 *
 * A cell renders a player surface whenever a slot is bound to it — the
 * committed page (playing) or the standby page (paused, muted, pre-rendered).
 * The Mux thumbnail is mounted above the surface and becomes transparent the
 * moment that slot's source reports a real frame; because the standby page
 * reaches its first frame off-screen, a normal swipe never shows the
 * thumbnail at all. It remains the fail-safe for cold pages (long flings), a
 * loading source, an offline viewer, and playback errors. `recyclingKey` ties
 * the decoded image to the asset, which is what stops a reused cell from
 * painting the previous video's frame during a fast fling.
 */
function ShortsVerticalVideoCellComponent({
  item,
  pageHeight,
  thumbnailUrl,
  overlayInsets,
  isFeedExhausted,
  playback,
  onToggleMute,
  onRetry,
}: ShortsVerticalVideoCellProps) {
  const { muxAssetId } = item;
  const isActive = playback?.isActive ?? false;
  const hasFirstFrame = playback?.hasFirstFrame ?? false;
  const hasError = playback?.hasError ?? false;
  const isMuted = playback?.isMuted ?? true;

  useEffect(() => {
    bumpFeedCounter("mountedRows");
    return () => bumpFeedCounter("mountedRows", -1);
  }, []);

  // Attach/detach is scoped to this cell's asset id, so a recycled cell that
  // rebinds to different content detaches before the new content binds. Both
  // slot surfaces (committed and standby) report their lifecycle.
  const surface = playback?.surface;
  const hasPlayer = (playback?.player ?? null) !== null;
  useEffect(() => {
    if (!hasPlayer || !surface) return;
    surface.onSurfaceAttached(muxAssetId);
    return () => surface.onSurfaceDetached(muxAssetId);
  }, [hasPlayer, muxAssetId, surface]);

  return (
    <View style={[styles.page, { height: pageHeight }]}>
      {/*
        The Mux custom controls own media interaction. Keeping this as a View
        rather than a parent Pressable lets Mux receive its background taps,
        play/pause presses, scrubbing, settings, and accessibility actions
        without a second gesture target competing with it.
      */}
      <View
        accessibilityElementsHidden={!isActive}
        importantForAccessibility={isActive ? "yes" : "no-hide-descendants"}
        style={styles.mediaLayer}
      >
        {playback?.player ? (
          <View style={styles.previewLayer}>
            <MuxVideoView
              player={playback.player}
              style={styles.video}
              // Immersive full-viewport presentation. The source is already an
              // exact 9:16 asset, so cover crops nothing on a portrait page.
              contentFit="cover"
              // Use Mux's shared React Native player UI on the committed page.
              // The standby page renders bare video: its chrome would slide in
              // with the swipe. Both values share the managed render path, so
              // flipping on promote never remounts the native view.
              controls={isActive ? "custom" : "none"}
              allowsFullscreen={false}
              // The <Image> below is the poster; a second one inside the native
              // view would fetch and decode the same frame again.
              poster={false}
              timeUpdateEventInterval={0.25}
              // 0.5s keeps Android at its default start threshold while
              // shrinking iOS's forward-buffer requirement, so playback (and
              // the first frame) begins as soon as a warm start allows.
              startupBufferDuration={0.5}
              onStatusChange={(event) =>
                playback.surface.onStatusChange(muxAssetId, event.status)
              }
              onSourceLoad={() => playback.surface.onSourceLoad(muxAssetId)}
              onTimeUpdate={(event) =>
                playback.surface.onTimeUpdate(muxAssetId, event.currentTime)
              }
              // The native first-frame signal is what lets the poster above
              // fade the instant real pixels exist — no polling latency.
              onFirstFrame={() => playback.surface.onFirstFrame(muxAssetId)}
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
          pointerEvents="none"
          style={[
            styles.thumbnail,
            // Per-slot signal: the standby page drops its poster off-screen,
            // which is why a swipe lands on video rather than a thumbnail.
            hasFirstFrame && styles.thumbnailHidden,
          ]}
        />
      </View>

      <ShortsVerticalVideoOverlay
        item={item}
        insets={overlayInsets}
        isMuted={isMuted}
        hasError={hasError}
        isFeedExhausted={isFeedExhausted}
        onToggleMute={onToggleMute}
        onRetry={onRetry}
      />
    </View>
  );
}

/**
 * Recycled cells re-render on every scroll tick, so the comparison is limited
 * to the cell's own data and its own playback state.
 *
 * `player` and `surface` are stable per slot for the life of the screen, and
 * playback flags are already slot-scoped by `getCellPlayback` — including
 * `hasFirstFrame`, which the standby cell needs so its poster can drop
 * off-screen. Cells without a slot always compare equal on playback.
 */
function areShortsCellPropsEqual(
  previous: ShortsVerticalVideoCellProps,
  next: ShortsVerticalVideoCellProps,
): boolean {
  if (
    previous.item !== next.item ||
    previous.pageHeight !== next.pageHeight ||
    previous.thumbnailUrl !== next.thumbnailUrl ||
    previous.overlayInsets !== next.overlayInsets ||
    previous.isFeedExhausted !== next.isFeedExhausted ||
    previous.onToggleMute !== next.onToggleMute ||
    previous.onRetry !== next.onRetry
  ) {
    return false;
  }

  return (
    previous.playback?.player === next.playback?.player &&
    previous.playback?.surface === next.playback?.surface &&
    (previous.playback?.isActive ?? false) === (next.playback?.isActive ?? false) &&
    (previous.playback?.hasFirstFrame ?? false) ===
      (next.playback?.hasFirstFrame ?? false) &&
    (previous.playback?.isPlaying ?? false) === (next.playback?.isPlaying ?? false) &&
    (previous.playback?.isPaused ?? false) === (next.playback?.isPaused ?? false) &&
    (previous.playback?.isMuted ?? true) === (next.playback?.isMuted ?? true) &&
    (previous.playback?.hasError ?? false) === (next.playback?.hasError ?? false)
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
