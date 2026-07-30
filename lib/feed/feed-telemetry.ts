/**
 * Feed playback observability (PRD section 11).
 *
 * Development builds keep in-memory counters so mounted rows, attached
 * surfaces, live players, source replacements and preload activity are
 * observable without reading logs by hand. Release builds keep the event
 * vocabulary but drop to a no-op sink until a production telemetry transport is
 * wired up in Phase 6.
 *
 * Never log raw auth data, signed playback tokens, private playback URLs,
 * captions, transcripts, or user-provided AI metadata. Playback IDs are hashed
 * before they leave this module.
 */

export type FeedTelemetryEventName =
  | "feed_first_cards_rendered"
  | "feed_candidate_changed"
  | "feed_focus_committed"
  | "feed_player_created"
  | "feed_player_attached"
  | "feed_player_detached"
  | "feed_player_released"
  | "feed_source_replace_started"
  | "feed_playback_requested"
  | "feed_playback_paused"
  | "feed_source_ready"
  | "feed_first_frame"
  | "feed_buffering_started"
  | "feed_buffering_ended"
  | "feed_playback_error"
  | "feed_preload_started"
  | "feed_preload_completed"
  | "feed_preload_cancelled"
  | "feed_preload_cache_hit"
  | "feed_preload_promoted_to_active";

export type FeedTelemetryScreen = "home" | "search";

export type FeedTelemetryFields = {
  screen?: FeedTelemetryScreen;
  muxAssetId?: string;
  playbackIdHash?: string;
  feedIndex?: number;
  deviceClass?: string;
  networkClass?: string;
  cacheState?: "cold" | "warm" | "unknown";
  isPreloaded?: boolean;
  elapsedMs?: number;
  errorCode?: string;
};

export type FeedCounterName =
  | "mountedRows"
  | "attachedSurfaces"
  | "livePlayers"
  | "sourceReplacements"
  | "preloadStarts"
  | "preloadCancellations"
  | "preloadCacheHits"
  | "preloadPromotions"
  | "wastedPreloadBytes";

export type FeedCounters = Record<FeedCounterName, number>;

const counters: FeedCounters = {
  mountedRows: 0,
  attachedSurfaces: 0,
  livePlayers: 0,
  sourceReplacements: 0,
  preloadStarts: 0,
  preloadCancellations: 0,
  preloadCacheHits: 0,
  preloadPromotions: 0,
  wastedPreloadBytes: 0,
};

export type FeedTelemetryListener = (
  event: FeedTelemetryEventName,
  fields: FeedTelemetryFields,
) => void;

const listeners = new Set<FeedTelemetryListener>();

const isDevelopment = typeof __DEV__ !== "undefined" && __DEV__;

/** Non-cryptographic FNV-1a hash. Keeps playback IDs out of telemetry payloads. */
export function hashPlaybackId(playbackId: string | undefined | null): string | undefined {
  if (!playbackId) return undefined;
  let hash = 0x811c9dc5;
  for (let index = 0; index < playbackId.length; index += 1) {
    hash ^= playbackId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function trackFeedEvent(
  event: FeedTelemetryEventName,
  fields: FeedTelemetryFields = {},
): void {
  for (const listener of listeners) {
    listener(event, fields);
  }
}

export function addFeedTelemetryListener(
  listener: FeedTelemetryListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function bumpFeedCounter(name: FeedCounterName, delta = 1): void {
  if (!isDevelopment) return;
  counters[name] += delta;
  if (counters[name] < 0) counters[name] = 0;
}

/** Snapshot of the development-only counters. Empty object in release builds. */
export function readFeedCounters(): FeedCounters {
  return { ...counters };
}

export function resetFeedCounters(): void {
  for (const key of Object.keys(counters) as FeedCounterName[]) {
    counters[key] = 0;
  }
}
