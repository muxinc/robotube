import {
  createMuxVideoPlayer,
  type MuxMaxResolution,
  type MuxVideoPlayer,
  type MuxVideoSourceObject,
} from "@mux/mux-react-native-player";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  bumpFeedCounter,
  hashPlaybackId,
  trackFeedEvent,
  type FeedTelemetryScreen,
} from "@/lib/feed/feed-telemetry";
import { runMuxPlayerCommand } from "@/lib/mux-player-command";

/**
 * Owns one `MuxVideoPlayer` for the feed. Committing a different card replaces
 * its source while preserving a single native surface and player instance.
 */

export type FeedPlaybackTarget = {
  muxAssetId: string;
  playbackId: string;
  title: string;
  /** Feed index, for telemetry only. */
  index: number;
};

export type UseFeedPlaybackControllerOptions = {
  /** The committed card, or null when nothing may play. */
  target: FeedPlaybackTarget | null;
  /** False pauses immediately while keeping the surface attached. */
  isPlaybackAllowed: boolean;
  /** Feed previews are always muted; exposed for future unmute affordances. */
  muted?: boolean;
  /** Rendition cap from the adaptive policy. */
  maxResolution?: MuxMaxResolution;
  screen?: FeedTelemetryScreen;
};

export type FeedPlaybackController = {
  player: MuxVideoPlayer;
  /** muxAssetId whose card should render the single surface, or null. */
  activeMuxAssetId: string | null;
  /** True once the active source has produced its first frame. */
  hasFirstFrame: boolean;
  /** Latest preview position, handed to the detail screen on navigation. */
  getPreviewPositionSeconds: (muxAssetId: string) => number;
  /** Card callbacks for the single `MuxVideoView`. */
  surface: FeedPlaybackSurfaceCallbacks;
};

export type FeedPlaybackSurfaceCallbacks = {
  onSurfaceAttached: (muxAssetId: string) => void;
  onSurfaceDetached: (muxAssetId: string) => void;
  onSourceLoad: (muxAssetId: string) => void;
  onStatusChange: (muxAssetId: string, status: string) => void;
  onTimeUpdate: (muxAssetId: string, currentTime: number) => void;
  onSourceError: (muxAssetId: string, message: string) => void;
};

const FEED_PLAYER_NAME = "Robotube feed preview";

export function useFeedPlaybackController({
  target,
  isPlaybackAllowed,
  muted = true,
  maxResolution,
  screen = "home",
}: UseFeedPlaybackControllerOptions): FeedPlaybackController {
  const playerRef = useRef<MuxVideoPlayer | null>(null);
  if (playerRef.current === null) {
    playerRef.current = createMuxVideoPlayer();
  }
  const player = playerRef.current;

  const activeMuxAssetId = target?.muxAssetId ?? null;
  const [firstFrameMuxAssetId, setFirstFrameMuxAssetId] = useState<string | null>(
    null,
  );
  const firstFrameMuxAssetIdRef = useRef<string | null>(null);
  const updateFirstFrameMuxAssetId = useCallback(
    (muxAssetId: string | null) => {
      firstFrameMuxAssetIdRef.current = muxAssetId;
      setFirstFrameMuxAssetId(muxAssetId);
    },
    [],
  );
  const attachedMuxAssetIdRef = useRef<string | null>(null);
  // Updated during render so surface callbacks (which fire in child effects,
  // before this hook's own effects) can see the *intended* target.
  const targetMuxAssetIdRef = useRef<string | null>(activeMuxAssetId);
  targetMuxAssetIdRef.current = activeMuxAssetId;
  const isPlaybackAllowedRef = useRef(isPlaybackAllowed);
  isPlaybackAllowedRef.current = isPlaybackAllowed;
  const loadedMuxAssetIdRef = useRef<string | null>(null);
  // A source replacement can briefly deliver a final time event from the old
  // native item. Do not reveal the surface until the new item has emitted its
  // own source-load event.
  const sourceReadyMuxAssetIdRef = useRef<string | null>(null);
  const sourceRequestedAtMsRef = useRef<number | null>(null);
  const isBufferingRef = useRef(false);
  const isPlayingRef = useRef(false);
  /** Preview position per asset, so returning to a card resumes where it was. */
  const positionsRef = useRef(new Map<string, number>());

  // Observe and release the single player with the feed screen lifecycle.
  // Counter notifications belong in an effect: emitting them during render
  // would synchronously update the development overlay while Home is rendering.
  useEffect(() => {
    bumpFeedCounter("livePlayers");
    trackFeedEvent("feed_player_created", { screen });

    return () => {
      if (isPlayingRef.current) {
        isPlayingRef.current = false;
        bumpFeedCounter("playingVideos", -1);
      }
      runMuxPlayerCommand(player.release());
      bumpFeedCounter("livePlayers", -1);
      trackFeedEvent("feed_player_released", { screen });
    };
  }, [player, screen]);

  useEffect(() => {
    runMuxPlayerCommand(player.setMuted(muted));
    runMuxPlayerCommand(player.setLoop(true));
    runMuxPlayerCommand(player.setPlaybackRate(1));
  }, [muted, player]);

  // Replace the active source only after focus is committed.
  useEffect(() => {
    if (target === null) {
      updateFirstFrameMuxAssetId(null);
      loadedMuxAssetIdRef.current = null;
      sourceReadyMuxAssetIdRef.current = null;
      if (isPlayingRef.current) {
        isPlayingRef.current = false;
        bumpFeedCounter("playingVideos", -1);
      }
      runMuxPlayerCommand(player.pause());
      return;
    }
    if (loadedMuxAssetIdRef.current === target.muxAssetId) return;

    updateFirstFrameMuxAssetId(null);
    loadedMuxAssetIdRef.current = target.muxAssetId;
    sourceReadyMuxAssetIdRef.current = null;
    if (isPlayingRef.current) {
      isPlayingRef.current = false;
      bumpFeedCounter("playingVideos", -1);
    }
    sourceRequestedAtMsRef.current = Date.now();
    isBufferingRef.current = false;

    const source: MuxVideoSourceObject = {
      playbackId: target.playbackId,
      assetId: target.muxAssetId,
      maxResolution,
      metadata: {
        playerName: FEED_PLAYER_NAME,
        videoId: target.muxAssetId,
        videoTitle: target.title,
      },
    };

    bumpFeedCounter("sourceReplacements");
    trackFeedEvent("feed_source_replace_started", {
      screen,
      muxAssetId: target.muxAssetId,
      playbackIdHash: hashPlaybackId(target.playbackId),
      feedIndex: target.index,
    });
    player.replace(source);
    runMuxPlayerCommand(player.setMuted(muted));
    runMuxPlayerCommand(player.setLoop(true));
  }, [
    maxResolution,
    muted,
    player,
    screen,
    target,
    updateFirstFrameMuxAssetId,
  ]);

  // Play/pause is driven purely by committed focus + lifecycle gating.
  useEffect(() => {
    if (target !== null && isPlaybackAllowed) {
      trackFeedEvent("feed_playback_requested", {
        screen,
        muxAssetId: target.muxAssetId,
        feedIndex: target.index,
      });
      runMuxPlayerCommand(player.play());
      return;
    }
    trackFeedEvent("feed_playback_paused", {
      screen,
      muxAssetId: target?.muxAssetId,
    });
    if (isPlayingRef.current) {
      isPlayingRef.current = false;
      bumpFeedCounter("playingVideos", -1);
    }
    runMuxPlayerCommand(player.pause());
  }, [isPlaybackAllowed, player, screen, target]);

  const onSurfaceAttached = useCallback(
    (muxAssetId: string) => {
      attachedMuxAssetIdRef.current = muxAssetId;
      bumpFeedCounter("attachedSurfaces");
      trackFeedEvent("feed_player_attached", { screen, muxAssetId });
    },
    [screen],
  );

  const onSurfaceDetached = useCallback(
    (muxAssetId: string) => {
      if (attachedMuxAssetIdRef.current === muxAssetId) {
        attachedMuxAssetIdRef.current = null;
      }
      bumpFeedCounter("attachedSurfaces", -1);
      trackFeedEvent("feed_player_detached", { screen, muxAssetId });

      // A normal commit hand-off detaches the old card while the new target is
      // already set, so this only fires when the committed row was recycled or
      // unmounted out from under the player. Stop and fall back to thumbnails.
      if (targetMuxAssetIdRef.current !== muxAssetId) return;
      runMuxPlayerCommand(player.pause());
      updateFirstFrameMuxAssetId(null);
    },
    [player, screen, updateFirstFrameMuxAssetId],
  );

  const onSourceLoad = useCallback(
    (muxAssetId: string) => {
      if (loadedMuxAssetIdRef.current !== muxAssetId) return;
      sourceReadyMuxAssetIdRef.current = muxAssetId;
      trackFeedEvent("feed_source_ready", {
        screen,
        muxAssetId,
        elapsedMs: elapsedSince(sourceRequestedAtMsRef.current),
      });

      // A newly mounted native view may emit its initial `idle` status after
      // the controller's first play request. Mux treats that status as a reason
      // to clear `shouldPlay`, leaving a successfully loaded source paused at
      // time zero. Reassert play only after this exact source is ready and
      // remains the committed, lifecycle-eligible target.
      if (
        targetMuxAssetIdRef.current === muxAssetId &&
        isPlaybackAllowedRef.current
      ) {
        runMuxPlayerCommand(player.play());
      }
    },
    [player, screen],
  );

  const onStatusChange = useCallback(
    (muxAssetId: string, status: string) => {
      if (loadedMuxAssetIdRef.current !== muxAssetId) return;
      const isPlaying = status === "playing";
      if (isPlaying !== isPlayingRef.current) {
        isPlayingRef.current = isPlaying;
        bumpFeedCounter("playingVideos", isPlaying ? 1 : -1);
      }
      if (status === "buffering" && !isBufferingRef.current) {
        isBufferingRef.current = true;
        trackFeedEvent("feed_buffering_started", { screen, muxAssetId });
        return;
      }
      if (status !== "buffering" && isBufferingRef.current) {
        isBufferingRef.current = false;
        trackFeedEvent("feed_buffering_ended", { screen, muxAssetId });
      }
    },
    [screen],
  );

  const onTimeUpdate = useCallback(
    (muxAssetId: string, currentTime: number) => {
      if (!Number.isFinite(currentTime) || currentTime < 0) return;
      positionsRef.current.set(muxAssetId, currentTime);
      if (loadedMuxAssetIdRef.current !== muxAssetId) return;
      if (sourceReadyMuxAssetIdRef.current !== muxAssetId) return;
      if (
        currentTime > 0 &&
        firstFrameMuxAssetIdRef.current !== muxAssetId
      ) {
        updateFirstFrameMuxAssetId(muxAssetId);
        trackFeedEvent("feed_first_frame", {
          screen,
          muxAssetId,
          elapsedMs: elapsedSince(sourceRequestedAtMsRef.current),
        });
      }
    },
    [screen, updateFirstFrameMuxAssetId],
  );

  const onSourceError = useCallback(
    (muxAssetId: string, message: string) => {
      trackFeedEvent("feed_playback_error", { screen, muxAssetId, errorCode: message });
      // Fall back to the thumbnail rather than holding a black surface.
      sourceReadyMuxAssetIdRef.current = null;
      updateFirstFrameMuxAssetId(null);
    },
    [screen, updateFirstFrameMuxAssetId],
  );

  const getPreviewPositionSeconds = useCallback(
    (muxAssetId: string) => positionsRef.current.get(muxAssetId) ?? 0,
    [],
  );

  const surface = useMemo<FeedPlaybackSurfaceCallbacks>(
    () => ({
      onSurfaceAttached,
      onSurfaceDetached,
      onSourceLoad,
      onStatusChange,
      onTimeUpdate,
      onSourceError,
    }),
    [
      onSourceError,
      onSourceLoad,
      onStatusChange,
      onSurfaceAttached,
      onSurfaceDetached,
      onTimeUpdate,
    ],
  );

  return useMemo(
    () => ({
      player,
      activeMuxAssetId,
      hasFirstFrame: firstFrameMuxAssetId === activeMuxAssetId,
      getPreviewPositionSeconds,
      surface,
    }),
    [
      activeMuxAssetId,
      firstFrameMuxAssetId,
      getPreviewPositionSeconds,
      player,
      surface,
    ],
  );
}

function elapsedSince(startedAtMs: number | null): number | undefined {
  if (startedAtMs === null) return undefined;
  return Date.now() - startedAtMs;
}
