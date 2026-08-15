/**
 * `FeedPreloader` interface, the disabled fallback implementation, and the
 * media-preload switch.
 *
 * As of `@mux/mux-react-native-player@0.1.13` the package exposes a
 * module-level, data-only preload API (`preloadMuxVideo`,
 * `cancelMuxVideoPreload`, `cancelAllMuxVideoPreloads`) that downloads startup
 * bytes without a mounted player surface: Android warms the shared on-disk
 * smart cache through a headless paused player, and iOS buffers a detached
 * `AVPlayerItem` that the next `MuxVideoView` with matching playback
 * parameters adopts outright. `lib/feed/mux-media-preloader.ts` implements
 * this interface against that API and is what Shorts passes to
 * `useFeedPreloader`.
 *
 * The disabled implementation below remains the default for surfaces that do
 * not inject a preloader (Home) and for binaries without the native module
 * (Expo Go, web): it records what *would* have been preloaded so the
 * preload-window policy stays observable and testable, holds no resources, and
 * creates no surfaces.
 *
 * Historical context: package versions <= 0.1.11 declared every playback
 * function inside `View(MuxVideoView)`, so no bytes could move without a
 * mounted surface and this file shipped as a no-op recorder by design.
 */

import {
  bumpFeedCounter,
  hashPlaybackId,
  trackFeedEvent,
  type FeedTelemetryScreen,
} from "./feed-telemetry";

export type FeedPreloadRequest = {
  /** Bounded cache key from `feedPreloadCacheKey`. */
  cacheKey: string;
  muxAssetId: string;
  playbackId: string;
  feedIndex: number;
  maxResolution?: string;
};

export type FeedPreloaderCapabilities = {
  /**
   * True only when preloaded bytes are demonstrably consumed by the active
   * player instead of being downloaded twice.
   */
  reusableByActivePlayer: boolean;
  /** Number of extra attached native surfaces this implementation creates. */
  extraAttachedSurfaces: number;
  /** Human-readable reason surfaced in dev tooling and telemetry. */
  reason: string;
};

export type FeedPreloader = {
  readonly name: string;
  readonly capabilities: FeedPreloaderCapabilities;
  /** True when the implementation can do useful work on this platform. */
  isEnabled(): boolean;
  /** Begin (or re-prioritise) preload work. Must never block active playback. */
  start(request: FeedPreloadRequest): void;
  /** Cancel work and release resources for a key that left the window. */
  cancel(cacheKey: string): void;
  /** Cancel everything — used on background, blur, and unmount. */
  cancelAll(): void;
  /** Report that a key became the active source, for conversion metrics. */
  promoteToActive(cacheKey: string): void;
  /** Keys currently holding preload resources. */
  retainedKeys(): string[];
};

/**
 * The shipped default. Records what *would* have been preloaded so the
 * preload-window policy stays observable and testable, holds no resources, and
 * creates no surfaces.
 */
export function createDisabledFeedPreloader(
  screen: FeedTelemetryScreen = "home",
  reason = "Media preloader not injected; recording preload-window decisions only",
): FeedPreloader {
  const observed = new Set<string>();

  return {
    name: "disabled",
    capabilities: {
      reusableByActivePlayer: false,
      extraAttachedSurfaces: 0,
      reason,
    },
    isEnabled: () => false,
    start(request) {
      if (observed.has(request.cacheKey)) return;
      observed.add(request.cacheKey);
      bumpFeedCounter("preloadStarts");
      trackFeedEvent("feed_preload_started", {
        screen,
        muxAssetId: request.muxAssetId,
        playbackIdHash: hashPlaybackId(request.playbackId),
        feedIndex: request.feedIndex,
        isPreloaded: false,
        cacheState: "cold",
      });
    },
    cancel(cacheKey) {
      if (!observed.delete(cacheKey)) return;
      bumpFeedCounter("preloadCancellations");
      trackFeedEvent("feed_preload_cancelled", { screen });
    },
    cancelAll() {
      for (const key of [...observed]) this.cancel(key);
    },
    promoteToActive(cacheKey) {
      if (!observed.has(cacheKey)) return;
      bumpFeedCounter("preloadPromotions");
      trackFeedEvent("feed_preload_promoted_to_active", {
        screen,
        isPreloaded: false,
        cacheState: "cold",
      });
    },
    retainedKeys: () => [...observed],
  };
}

/**
 * Media preloading is on: `mux-media-preloader.ts` provides a reusable
 * implementation. Surfaces still opt in by passing a `preloader` to
 * `useFeedPreloader`; without one, only the observability recorder runs.
 */
export const FEED_MEDIA_PRELOAD_ENABLED = true;
