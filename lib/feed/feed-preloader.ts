/**
 * Phase 3: the `FeedPreloader` interface, and the default implementation.
 *
 * ## Spike result for @mux/mux-react-native-player@0.1.10
 *
 * Data-only media preloading is **not available** in the installed package, and
 * the shipped "feed" helper does not preload bytes either. Evidence:
 *
 *  1. `MuxReactNativePlayerModule` (both `ios/MuxReactNativePlayerModule.swift`
 *     and `android/.../MuxReactNativePlayerModule.kt`) declares exactly two
 *     module-level `AsyncFunction`s — `lockFullscreenLandscape` and
 *     `unlockFullscreenOrientation`. Every other native function is declared
 *     inside `View(MuxVideoView)`, so it can only be called against a mounted
 *     native view. There is no `preload`, `prepare`, `warm`, or cache function
 *     reachable from JS without rendering a player surface.
 *  2. `MuxVideoPlayer` (JS) holds the source and *queues* commands until
 *     `_attachNativeRef` is called by a mounted `MuxVideoView`; the source only
 *     reaches native through that view's `source` prop. An unattached player
 *     therefore downloads zero bytes. `useMuxVideoFeed`'s `preloadAhead` /
 *     `preloadBehind` allocate extra `MuxVideoPlayer` objects that do nothing
 *     unless each one is attached to its own visible surface — which is the
 *     multi-surface architecture this PRD removes.
 *  3. Neither native view builds a shareable media cache the app can populate
 *     out of band. Android does construct its `MuxPlayer` with
 *     `enableSmartCache(true)`, so bytes fetched by one player *are* reusable by
 *     a later one; iOS uses a plain `AVPlayer` with only
 *     `preferredForwardBufferDuration` set and no cross-item cache.
 *
 * Per PRD section 7.3 ("A preload implementation that downloads data but cannot
 * be reused by the active player does not satisfy this PRD") and Phase 3
 * ("Disable preloading rather than ship a fallback that regresses scrolling or
 * memory"), the default preloader is a **no-op** that still records the policy
 * decisions and metrics. The one-standby-player fallback is deliberately NOT
 * enabled: it is only defensible on Android (smart cache) and is unverifiable on
 * iOS, and enabling it would re-introduce a second attached surface — which
 * Phase 3's own exit gate forbids ("Preloading does not create additional
 * attached visible surfaces").
 *
 * To enable real preloading later, implement this interface against either an
 * upgraded Mux package that exposes a module-level preload API, or a small
 * native adapter (Android Media3 `PreloadMediaSource` / `DefaultPreloadManager`
 * feeding the same smart cache; iOS `AVAssetResourceLoader` or
 * `AVPlayerItem.preferredForwardBufferDuration` on a detached item), then pass
 * it to `useFeedPreloader`. Nothing above this interface needs to change.
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
  reason = "No data-only preload API in @mux/mux-react-native-player@0.1.10",
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
 * Remote kill switch hook-up point (PRD section 13). Preloading ships off; a
 * Phase 6 flag provider can flip this once a real implementation exists.
 */
export const FEED_MEDIA_PRELOAD_ENABLED = false;
