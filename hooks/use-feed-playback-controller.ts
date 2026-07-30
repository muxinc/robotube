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
  /**
   * Own a native player only while this screen is focused. Native tabs retain
   * inactive routes, so lifecycle gating must cover allocation as well as play.
   */
  isPlayerEnabled?: boolean;
  /** The committed card, or null when nothing may play. */
  target: FeedPlaybackTarget | null;
  /** False pauses immediately while keeping the surface attached. */
  isPlaybackAllowed: boolean;
  /**
   * Home previews are always muted. Shorts owns a session-scoped sound control,
   * so this is applied to the live player whenever it changes.
   */
  muted?: boolean;
  /** Rendition cap from the adaptive policy. */
  maxResolution?: MuxMaxResolution;
  /** Player name reported to Mux Data. Identifies the surface, not the video. */
  playerName?: string;
  /**
   * Bump to re-load the committed source the controller already considers
   * loaded. Used by a retry affordance after a recoverable playback error.
   */
  sourceAttempt?: number;
  /**
   * Called when the committed source reports an error. Lets a screen offer a
   * retry affordance; the controller itself never auto-retries.
   */
  onSourceErrorReported?: (muxAssetId: string, message: string) => void;
  /**
   * Called when the *committed* card's surface goes away underneath the player
   * (recycling or unmount), not on a normal commit hand-off.
   */
  onActiveSurfaceLost?: (muxAssetId: string) => void;
  screen?: FeedTelemetryScreen;
};

export type FeedPlaybackController = {
  player: MuxVideoPlayer | null;
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
  isPlayerEnabled = true,
  target,
  isPlaybackAllowed,
  muted = true,
  maxResolution,
  playerName = FEED_PLAYER_NAME,
  sourceAttempt = 0,
  onSourceErrorReported,
  onActiveSurfaceLost,
  screen = "home",
}: UseFeedPlaybackControllerOptions): FeedPlaybackController {
  // Held in refs so a caller can pass inline callbacks without invalidating the
  // memoized surface object that every recycled row compares against.
  const onSourceErrorReportedRef = useRef(onSourceErrorReported);
  onSourceErrorReportedRef.current = onSourceErrorReported;
  const onActiveSurfaceLostRef = useRef(onActiveSurfaceLost);
  onActiveSurfaceLostRef.current = onActiveSurfaceLost;
  const [ownedPlayer, setOwnedPlayer] = useState<MuxVideoPlayer | null>(null);
  const player = isPlayerEnabled ? ownedPlayer : null;
  const activeMuxAssetId = player ? (target?.muxAssetId ?? null) : null;
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
  // `muxAssetId|sourceAttempt`. Distinguishing the attempt is what lets a retry
  // re-load the asset the controller already has loaded.
  const loadedSourceKeyRef = useRef<string | null>(null);
  // A source replacement can briefly deliver a final time event from the old
  // native item. Do not reveal the surface until the new item has emitted its
  // own source-load event.
  const sourceReadyMuxAssetIdRef = useRef<string | null>(null);
  const sourceRequestedAtMsRef = useRef<number | null>(null);
  const isBufferingRef = useRef(false);
  const isPlayingRef = useRef(false);
  /** Preview position per asset, so returning to a card resumes where it was. */
  const positionsRef = useRef(new Map<string, number>());

  // Allocate only for the focused route. React runs passive-effect cleanups
  // before setups, so a tab switch releases the old route's player before the
  // newly focused route creates its own. Native tabs retain inactive screens;
  // tying allocation only to component mount would leave one player per tab.
  useEffect(() => {
    if (!isPlayerEnabled) {
      setOwnedPlayer(null);
      return;
    }

    const nextPlayer = createMuxVideoPlayer();
    setOwnedPlayer(nextPlayer);
    bumpFeedCounter("livePlayers");
    trackFeedEvent("feed_player_created", { screen });

    return () => {
      if (isPlayingRef.current) {
        isPlayingRef.current = false;
        bumpFeedCounter("playingVideos", -1);
      }
      runMuxPlayerCommand(nextPlayer.release());
      bumpFeedCounter("livePlayers", -1);
      trackFeedEvent("feed_player_released", { screen });
    };
  }, [isPlayerEnabled, screen]);

  useEffect(() => {
    if (!player) return;
    runMuxPlayerCommand(player.setMuted(muted));
    runMuxPlayerCommand(player.setLoop(true));
    runMuxPlayerCommand(player.setPlaybackRate(1));
  }, [muted, player]);

  // Replace the active source only after focus is committed.
  useEffect(() => {
    if (!player) {
      updateFirstFrameMuxAssetId(null);
      loadedMuxAssetIdRef.current = null;
      loadedSourceKeyRef.current = null;
      sourceReadyMuxAssetIdRef.current = null;
      return;
    }
    if (target === null) {
      updateFirstFrameMuxAssetId(null);
      loadedMuxAssetIdRef.current = null;
      loadedSourceKeyRef.current = null;
      sourceReadyMuxAssetIdRef.current = null;
      if (isPlayingRef.current) {
        isPlayingRef.current = false;
        bumpFeedCounter("playingVideos", -1);
      }
      if (player) runMuxPlayerCommand(player.pause());
      return;
    }
    const sourceKey = `${target.muxAssetId}|${sourceAttempt}`;
    if (loadedSourceKeyRef.current === sourceKey) return;

    // A retry re-submits the *same* asset. Both native views short-circuit a
    // `setSource` whose fingerprint matches what they already hold
    // (`ios/MuxVideoView.swift` `setSource`, `MuxVideoView.kt` `setSource`), and
    // that fingerprint covers only playbackId, tokens, domain, resolution
    // window, rendition order, clipping, and Mux Data metadata — every field an
    // identical retry reproduces exactly. So `replace()` alone is a no-op on
    // device for a reload, and the broken item would never recover.
    const isReloadOfSameAsset =
      loadedMuxAssetIdRef.current === target.muxAssetId &&
      loadedSourceKeyRef.current !== null;

    updateFirstFrameMuxAssetId(null);
    loadedMuxAssetIdRef.current = target.muxAssetId;
    loadedSourceKeyRef.current = sourceKey;
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
        playerName,
        videoId: target.muxAssetId,
        videoTitle: target.title,
      },
    };

    let isCancelled = false;
    let didApplySource = false;
    const applySource = () => {
      didApplySource = true;
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
      // `release()` clears `shouldPlay`; `onSourceLoad` re-asserts play once this
      // exact source is ready and still the committed, eligible target.
    };

    if (!isReloadOfSameAsset) {
      applySource();
      return;
    }

    // Release first: `release()` clears the stored fingerprint on both platforms,
    // so the identical source is accepted afterwards. It has to be awaited rather
    // than called back-to-back, because a release and a replace inside one commit
    // collapse into a single native `source` prop update and the clear is lost.
    // The promise resolves immediately when no surface is attached, so this can
    // never strand a pending reload.
    player
      .release()
      .catch(() => {
        // A failed release still cleared the JS-side source; try the reload.
      })
      .then(() => {
        if (isCancelled) return;
        applySource();
      });

    return () => {
      isCancelled = true;
      // A dependency change during the release (a mute toggle, a re-published
      // committed index) re-runs this effect. The source key was claimed up
      // front, so without releasing the claim the re-run would early-return and
      // the reload would be dropped, leaving the retried page dead. The release
      // has already cleared the native fingerprint by this point, so the re-run
      // correctly replaces without releasing again.
      if (!didApplySource) {
        loadedSourceKeyRef.current = null;
      }
    };
  }, [
    maxResolution,
    muted,
    player,
    playerName,
    screen,
    sourceAttempt,
    target,
    updateFirstFrameMuxAssetId,
  ]);

  // Play/pause is driven purely by committed focus + lifecycle gating.
  useEffect(() => {
    if (!player) return;
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
      if (player) runMuxPlayerCommand(player.pause());
      updateFirstFrameMuxAssetId(null);
      onActiveSurfaceLostRef.current?.(muxAssetId);
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
        if (player) runMuxPlayerCommand(player.play());
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
      // Reported, never auto-retried: a dead source would otherwise reload in a
      // loop while the viewer is offline.
      onSourceErrorReportedRef.current?.(muxAssetId, message);
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
