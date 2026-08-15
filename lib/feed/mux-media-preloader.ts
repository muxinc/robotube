/**
 * The real media `FeedPreloader`, backed by the data-only preload API added to
 * `@mux/mux-react-native-player@0.1.13` (`preloadMuxVideo` and friends).
 *
 * What "preloaded" means per platform:
 *
 *  - Android: a headless, paused player warms the same on-disk smart cache the
 *    active player reads, so startup bytes come from disk instead of the
 *    network.
 *  - iOS: a detached `AVPlayerItem` buffers on a paused pooled player; when the
 *    committed cell's `MuxVideoView` receives the same playback parameters it
 *    adopts the warmed item and its buffer directly.
 *
 * Both are data-only: no extra surface is attached, and preloaded bytes are
 * demonstrably consumed by the active player rather than downloaded twice,
 * which is the bar `FeedPreloaderCapabilities.reusableByActivePlayer` asks for.
 *
 * The native side is best-effort throughout — a failed or unsupported preload
 * (Expo Go, web) degrades to the poster-first cold start the feed already
 * handles.
 */

import {
  cancelMuxVideoPreload,
  isMuxVideoPreloadSupported,
  preloadMuxVideo,
  type MuxMaxResolution,
} from "@mux/mux-react-native-player";

import type { FeedPreloader } from "./feed-preloader";
import {
  bumpFeedCounter,
  hashPlaybackId,
  trackFeedEvent,
  type FeedTelemetryScreen,
} from "./feed-telemetry";

/** Seconds of media buffered ahead for a preloaded neighbour. */
const PRELOAD_BUFFER_AHEAD_SECONDS = 5;

export function createMuxMediaFeedPreloader(
  screen: FeedTelemetryScreen = "shorts",
): FeedPreloader {
  type RetainedPreload = {
    playbackId: string;
    muxAssetId: string;
    playbackIdHash: string | undefined;
    feedIndex: number;
    startedAtMs: number;
    accepted: boolean;
    promoted: boolean;
  };

  /** cacheKey → native request state, mirroring the preload-window policy. */
  const retained = new Map<string, RetainedPreload>();

  return {
    name: "mux-native",
    capabilities: {
      reusableByActivePlayer: true,
      extraAttachedSurfaces: 0,
      reason:
        "Data-only preload API in @mux/mux-react-native-player (Android smart cache; iOS warmed AVPlayerItem adoption)",
    },
    isEnabled: () => isMuxVideoPreloadSupported(),
    start(request) {
      if (retained.has(request.cacheKey)) return;
      const entry: RetainedPreload = {
        playbackId: request.playbackId,
        muxAssetId: request.muxAssetId,
        playbackIdHash: hashPlaybackId(request.playbackId),
        feedIndex: request.feedIndex,
        startedAtMs: Date.now(),
        accepted: false,
        promoted: false,
      };
      retained.set(request.cacheKey, entry);
      bumpFeedCounter("preloadStarts");
      trackFeedEvent("feed_preload_started", {
        screen,
        muxAssetId: request.muxAssetId,
        playbackIdHash: entry.playbackIdHash,
        feedIndex: request.feedIndex,
        // The API has accepted no work yet, so do not call this warm.
        isPreloaded: false,
        cacheState: "unknown",
      });
      void preloadMuxVideo(
        {
          playbackId: request.playbackId,
          maxResolution: request.maxResolution as MuxMaxResolution | undefined,
        },
        { bufferAheadSeconds: PRELOAD_BUFFER_AHEAD_SECONDS },
      ).then(() => {
        // `preloadMuxVideo` resolves when native accepts the request, not when
        // the target buffer is full. Record that distinction internally and
        // wait until an exact source promotion before reporting a cache hit.
        const current = retained.get(request.cacheKey);
        if (current !== entry || current.promoted) return;
        current.accepted = true;
      });
    },
    cancel(cacheKey) {
      const entry = retained.get(cacheKey);
      if (entry === undefined) return;
      retained.delete(cacheKey);
      // A promoted request has already been consumed by the active player; its
      // later removal from the logical window is not a preload cancellation.
      if (entry.promoted) return;
      bumpFeedCounter("preloadCancellations");
      trackFeedEvent("feed_preload_cancelled", { screen });
      void cancelMuxVideoPreload(entry.playbackId);
    },
    cancelAll() {
      for (const cacheKey of [...retained.keys()]) this.cancel(cacheKey);
    },
    promoteToActive(cacheKey) {
      const entry = retained.get(cacheKey);
      if (!entry || entry.promoted) return;
      entry.promoted = true;
      bumpFeedCounter("preloadPromotions");
      trackFeedEvent("feed_preload_promoted_to_active", {
        screen,
        muxAssetId: entry.muxAssetId,
        playbackIdHash: entry.playbackIdHash,
        feedIndex: entry.feedIndex,
        isPreloaded: entry.accepted,
        cacheState: entry.accepted ? "warm" : "unknown",
        elapsedMs: Date.now() - entry.startedAtMs,
      });
      if (!entry.accepted) {
        // The active source won the race. Stop any late headless request and do
        // not count it as a hit; playback correctly falls back to the cold path.
        void cancelMuxVideoPreload(entry.playbackId);
        return;
      }
      bumpFeedCounter("preloadCacheHits");
      trackFeedEvent("feed_preload_cache_hit", {
        screen,
        muxAssetId: entry.muxAssetId,
        playbackIdHash: entry.playbackIdHash,
        feedIndex: entry.feedIndex,
        isPreloaded: true,
        cacheState: "warm",
        elapsedMs: Date.now() - entry.startedAtMs,
      });
    },
    retainedKeys: () => [...retained.keys()],
  };
}
