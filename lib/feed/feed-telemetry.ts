/**
 * Converts runtime telemetry into sanitized events, development counters, and
 * bounded in-memory timing tracks.
 */

import {
  emitFeedPerformanceEvent,
  hashPlaybackId as hashPerformancePlaybackId,
  isFeedPerformanceEventName,
  type FeedPerformanceEventFields,
} from "@/lib/feed-performance-events";
import {
  feedPerformanceCounters,
  type FeedCounterKey,
  type FeedGaugeKey,
} from "@/lib/feed-performance-counters";
import {
  FeedTimelineRecorder,
  type FeedTimelineMark,
} from "@/lib/feed-performance-timeline";

export type FeedTelemetryEventName =
  | "feed_query_started"
  | "feed_query_received"
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
  | "feed_preload_promoted_to_active"
  // Card-feed preview sound toggle (Home/search autoplay previews).
  | "feed_preview_muted"
  | "feed_preview_unmuted"
  // Shorts-specific vocabulary. These describe interactions the card feed has
  // no equivalent for, so they are additive rather than reusing a feed_* name.
  // They flow through the same privacy sanitizer and performance sink.
  | "shorts_tab_opened"
  | "shorts_page_impression"
  | "shorts_manual_pause"
  | "shorts_manual_resume"
  | "shorts_muted"
  | "shorts_unmuted"
  | "shorts_retry_playback"
  | "shorts_query_received"
  | "shorts_empty_state_viewed";

export type FeedTelemetryScreen = "home" | "search" | "shorts";

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
  feedPlacement?: FeedPerformanceEventFields["feed_placement"];
  itemCount?: number;
  isMuted?: boolean;
  retryAttempt?: number;
  emptyReason?: FeedPerformanceEventFields["empty_reason"];
  pageHeightDp?: number;
  queryOutcome?: FeedPerformanceEventFields["query_outcome"];
};

export type FeedCounterName =
  | "mountedRows"
  | "attachedSurfaces"
  | "livePlayers"
  | "playingVideos"
  | "sourceReplacements"
  | "preloadStarts"
  | "preloadCancellations"
  | "preloadCacheHits"
  | "preloadPromotions"
  | "wastedPreloadBytes";

export type FeedCounters = Record<FeedCounterName, number>;
export type FeedTelemetryListener = (
  event: FeedTelemetryEventName,
  fields: FeedTelemetryFields,
) => void;

const listeners = new Set<FeedTelemetryListener>();
export const feedTimelineRecorder = new FeedTimelineRecorder({ maxTracks: 64 });

const GAUGE_BY_COUNTER: Partial<Record<FeedCounterName, FeedGaugeKey>> = {
  mountedRows: "mountedFeedRows",
  attachedSurfaces: "attachedPlayerSurfaces",
  livePlayers: "livePlayerInstances",
  playingVideos: "playingFeedVideos",
};

const TOTAL_BY_COUNTER: Partial<
  Record<FeedCounterName, { positive: FeedCounterKey; negative?: FeedCounterKey }>
> = {
  mountedRows: { positive: "rowMounts", negative: "rowUnmounts" },
  attachedSurfaces: {
    positive: "surfaceAttachments",
    negative: "surfaceDetachments",
  },
  livePlayers: { positive: "playerCreations", negative: "playerReleases" },
  sourceReplacements: { positive: "sourceReplacements" },
  preloadStarts: { positive: "preloadStarts" },
  preloadCancellations: { positive: "preloadCancellations" },
  preloadCacheHits: { positive: "preloadCacheHits" },
  preloadPromotions: { positive: "preloadPromotions" },
};

const TIMELINE_MARK_BY_EVENT: Partial<
  Record<FeedTelemetryEventName, FeedTimelineMark>
> = {
  feed_candidate_changed: "candidate_changed",
  feed_focus_committed: "focus_committed",
  feed_source_replace_started: "source_replace_started",
  feed_playback_requested: "playback_requested",
  feed_source_ready: "source_ready",
  feed_first_frame: "first_frame",
  feed_buffering_started: "buffering_started",
  feed_buffering_ended: "buffering_ended",
  feed_playback_error: "playback_error",
  feed_preload_started: "preload_started",
  feed_preload_completed: "preload_completed",
  feed_preload_cancelled: "preload_cancelled",
};

export function hashPlaybackId(
  playbackId: string | undefined | null,
): string | undefined {
  return playbackId ? hashPerformancePlaybackId(playbackId) : undefined;
}

export function trackFeedEvent(
  event: FeedTelemetryEventName,
  fields: FeedTelemetryFields = {},
): void {
  if (isFeedPerformanceEventName(event)) {
    emitFeedPerformanceEvent(event, toPerformanceFields(fields));
  }

  const mark = TIMELINE_MARK_BY_EVENT[event];
  if (mark) {
    feedTimelineRecorder.mark(timelineKey(fields), mark);
  }

  // Listeners receive the same normalized error code the sanitized performance
  // sink gets. Call sites pass through raw player and query error text, which is
  // exactly the free-form payload the privacy contract excludes, so normalizing
  // here rather than at each call site means one path cannot be forgotten.
  const listenerFields: FeedTelemetryFields =
    fields.errorCode === undefined
      ? fields
      : { ...fields, errorCode: normalizeErrorCode(fields.errorCode) };

  for (const listener of listeners) {
    try {
      listener(event, listenerFields);
    } catch {
      // Observability must never interrupt playback.
    }
  }
}

export function addFeedTelemetryListener(
  listener: FeedTelemetryListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function bumpFeedCounter(name: FeedCounterName, delta = 1): void {
  const gauge = GAUGE_BY_COUNTER[name];
  if (gauge) feedPerformanceCounters.adjustGauge(gauge, delta);

  const totals = TOTAL_BY_COUNTER[name];
  if (!totals || delta === 0) return;
  const total = delta > 0 ? totals.positive : totals.negative;
  if (total) feedPerformanceCounters.increment(total, Math.abs(delta));
}

export function readFeedCounters(): FeedCounters {
  const snapshot = feedPerformanceCounters.snapshot();
  return {
    mountedRows: snapshot.gauges.mountedFeedRows,
    attachedSurfaces: snapshot.gauges.attachedPlayerSurfaces,
    livePlayers: snapshot.gauges.livePlayerInstances,
    playingVideos: snapshot.gauges.playingFeedVideos,
    sourceReplacements: snapshot.counters.sourceReplacements,
    preloadStarts: snapshot.counters.preloadStarts,
    preloadCancellations: snapshot.counters.preloadCancellations,
    preloadCacheHits: snapshot.counters.preloadCacheHits,
    preloadPromotions: snapshot.counters.preloadPromotions,
    wastedPreloadBytes: 0,
  };
}

export function resetFeedCounters(): void {
  feedPerformanceCounters.reset();
  feedTimelineRecorder.reset();
}

function toPerformanceFields(
  fields: FeedTelemetryFields,
): FeedPerformanceEventFields {
  return {
    screen: toPerformanceScreen(fields.screen),
    mux_asset_id: fields.muxAssetId,
    playback_id_hash: fields.playbackIdHash,
    feed_index: fields.feedIndex,
    device_class:
      fields.deviceClass === "low" ||
      fields.deviceClass === "standard" ||
      fields.deviceClass === "high" ||
      fields.deviceClass === "unknown"
        ? fields.deviceClass
        : undefined,
    network_class:
      fields.networkClass === "wifi" ||
      fields.networkClass === "cellular" ||
      fields.networkClass === "constrained" ||
      fields.networkClass === "offline" ||
      fields.networkClass === "unknown"
        ? fields.networkClass
        : undefined,
    cache_state: fields.cacheState,
    is_preloaded: fields.isPreloaded,
    elapsed_ms: fields.elapsedMs,
    error_code: normalizeErrorCode(fields.errorCode),
    feed_placement: fields.feedPlacement,
    item_count: fields.itemCount,
    is_muted: fields.isMuted,
    retry_attempt: fields.retryAttempt,
    empty_reason: fields.emptyReason,
    page_height_dp: fields.pageHeightDp,
    query_outcome: fields.queryOutcome,
  };
}

/**
 * Maps a runtime screen onto the sanitized performance-event vocabulary.
 *
 * Values here must be members of `FEED_SCREENS`; the sanitizer drops unknown
 * dimensions while preserving the rest of the event.
 */
function toPerformanceScreen(
  screen: FeedTelemetryScreen | undefined,
): FeedPerformanceEventFields["screen"] {
  switch (screen) {
    case "home":
      return "home_feed";
    case "search":
      return "search_results";
    case "shorts":
      return "shorts";
    default:
      return undefined;
  }
}

function normalizeErrorCode(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/g, "_")
    .slice(0, 64);
  return normalized || "unknown";
}

function timelineKey(fields: FeedTelemetryFields): string {
  if (fields.muxAssetId) return fields.muxAssetId;
  return `${fields.screen ?? "feed"}:${fields.feedIndex ?? "none"}`;
}
