/**
 * News-feed performance event vocabulary.
 *
 * This module is intentionally dependency-free and side-effect-free apart from
 * the module-level sink, so it can be unit tested with plain Node:
 *
 *   node --experimental-strip-types scripts/news-feed-tests.mjs
 *
 * Privacy contract: the feed telemetry path never carries authentication data,
 * signed playback tokens, private playback URLs, captions, transcripts, or
 * user-provided AI metadata. `sanitizeFeedEventFields` enforces that with an
 * allowlist plus value-shape checks rather than relying on call-site
 * discipline.
 */

export const FEED_PERFORMANCE_EVENTS = {
  feedQueryStarted: "feed_query_started",
  feedQueryReceived: "feed_query_received",
  feedFirstCardsRendered: "feed_first_cards_rendered",
  feedCandidateChanged: "feed_candidate_changed",
  feedFocusCommitted: "feed_focus_committed",
  feedPlayerCreated: "feed_player_created",
  feedPlayerAttached: "feed_player_attached",
  feedPlayerDetached: "feed_player_detached",
  feedSourceReplaceStarted: "feed_source_replace_started",
  feedPlaybackRequested: "feed_playback_requested",
  feedSourceReady: "feed_source_ready",
  feedFirstFrame: "feed_first_frame",
  feedBufferingStarted: "feed_buffering_started",
  feedBufferingEnded: "feed_buffering_ended",
  feedPlaybackError: "feed_playback_error",
  feedPreloadStarted: "feed_preload_started",
  feedPreloadCompleted: "feed_preload_completed",
  feedPreloadCancelled: "feed_preload_cancelled",
  feedPreloadCacheHit: "feed_preload_cache_hit",
  feedPreloadPromotedToActive: "feed_preload_promoted_to_active",
} as const;

export type FeedPerformanceEventName =
  (typeof FEED_PERFORMANCE_EVENTS)[keyof typeof FEED_PERFORMANCE_EVENTS];

export const FEED_PERFORMANCE_EVENT_NAMES: readonly FeedPerformanceEventName[] =
  Object.values(FEED_PERFORMANCE_EVENTS);

export const FEED_DEVICE_CLASSES = ["low", "standard", "high", "unknown"] as const;
export type FeedDeviceClass = (typeof FEED_DEVICE_CLASSES)[number];

export const FEED_PLATFORMS = ["ios", "android", "web", "unknown"] as const;
export type FeedPlatform = (typeof FEED_PLATFORMS)[number];

export const FEED_NETWORK_CLASSES = [
  "wifi",
  "cellular",
  "constrained",
  "offline",
  "unknown",
] as const;
export type FeedNetworkClass = (typeof FEED_NETWORK_CLASSES)[number];

export const FEED_CACHE_STATES = ["cold", "warm", "unknown"] as const;
export type FeedCacheState = (typeof FEED_CACHE_STATES)[number];

export const FEED_SCREENS = ["home_feed", "search_results", "profile", "video_detail"] as const;
export type FeedScreen = (typeof FEED_SCREENS)[number];

/** Common fields accepted by the emit allowlist. */
export type FeedPerformanceEventFields = {
  session_id?: string;
  screen?: FeedScreen;
  mux_asset_id?: string;
  playback_id_hash?: string;
  feed_index?: number;
  device_class?: FeedDeviceClass;
  platform?: FeedPlatform;
  network_class?: FeedNetworkClass;
  cache_state?: FeedCacheState;
  is_preloaded?: boolean;
  elapsed_ms?: number;
  error_code?: string;
};

export type FeedPerformanceEvent = {
  name: FeedPerformanceEventName;
  fields: FeedPerformanceEventFields;
};

export type FeedEventSanitizeResult = {
  fields: FeedPerformanceEventFields;
  /** Keys removed because they are not on the allowlist. */
  droppedKeys: string[];
  /** Allowlisted keys removed because the value failed a privacy or shape check. */
  redactedKeys: string[];
};

export const FEED_EVENT_ALLOWED_FIELDS = [
  "session_id",
  "screen",
  "mux_asset_id",
  "playback_id_hash",
  "feed_index",
  "device_class",
  "platform",
  "network_class",
  "cache_state",
  "is_preloaded",
  "elapsed_ms",
  "error_code",
] as const;

const ALLOWED_FIELD_SET = new Set<string>(FEED_EVENT_ALLOWED_FIELDS);

/**
 * Values that must never reach a telemetry sink even when they arrive under an
 * allowlisted key. These target signed URLs, bearer/JWT material, manifest and
 * segment URLs, and free-text that could be transcript or caption content.
 */
const FORBIDDEN_VALUE_PATTERNS: readonly RegExp[] = [
  /^[a-z][a-z0-9+.-]*:\/\//i, // any URL scheme, including https and custom app schemes
  /\b(?:token|signature|policy|key-pair-id|expires)\s*=/i,
  /\bbearer\s+\S/i,
  /^ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./, // JWT
  /\.(?:m3u8|mpd|mp4|ts|m4s)\b/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** Anything longer than this is assumed to be free text (caption/transcript/AI copy). */
const MAX_FIELD_STRING_LENGTH = 200;
const MAX_ERROR_CODE_LENGTH = 64;
const ERROR_CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

function isForbiddenValue(value: string): boolean {
  if (value.length > MAX_FIELD_STRING_LENGTH) return true;
  return FORBIDDEN_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function isNonEmptySafeString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !isForbiddenValue(value);
}

function isMemberOf<T extends string>(
  candidates: readonly T[],
  value: unknown,
): value is T {
  return typeof value === "string" && (candidates as readonly string[]).includes(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Drops every key that is not part of the documented vocabulary, then drops
 * allowlisted keys whose values fail a type or privacy check.
 *
 * The function never throws and never mutates its input: an unsafe event
 * degrades into a smaller event rather than into a dropped event, so a
 * mistake at a call site costs a field, not a metric.
 */
export function sanitizeFeedEventFields(
  input: Readonly<Record<string, unknown>> | undefined,
): FeedEventSanitizeResult {
  const fields: Record<string, unknown> = {};
  const droppedKeys: string[] = [];
  const redactedKeys: string[] = [];

  if (!input) {
    return { fields, droppedKeys, redactedKeys };
  }

  for (const key of Object.keys(input)) {
    const value = input[key];

    if (!ALLOWED_FIELD_SET.has(key)) {
      droppedKeys.push(key);
      continue;
    }

    if (value === undefined || value === null) {
      redactedKeys.push(key);
      continue;
    }

    let accepted: unknown;

    switch (key) {
      case "session_id":
      case "mux_asset_id":
      case "playback_id_hash":
        accepted = isNonEmptySafeString(value) ? value : undefined;
        break;
      case "screen":
        accepted = isMemberOf(FEED_SCREENS, value) ? value : undefined;
        break;
      case "device_class":
        accepted = isMemberOf(FEED_DEVICE_CLASSES, value) ? value : undefined;
        break;
      case "platform":
        accepted = isMemberOf(FEED_PLATFORMS, value) ? value : undefined;
        break;
      case "network_class":
        accepted = isMemberOf(FEED_NETWORK_CLASSES, value) ? value : undefined;
        break;
      case "cache_state":
        accepted = isMemberOf(FEED_CACHE_STATES, value) ? value : undefined;
        break;
      case "feed_index":
        accepted = isNonNegativeInteger(value) ? value : undefined;
        break;
      case "is_preloaded":
        accepted = typeof value === "boolean" ? value : undefined;
        break;
      case "elapsed_ms":
        accepted = isNonNegativeFinite(value) ? Math.round(value) : undefined;
        break;
      case "error_code":
        accepted =
          typeof value === "string" &&
          value.length <= MAX_ERROR_CODE_LENGTH &&
          ERROR_CODE_PATTERN.test(value) &&
          !isForbiddenValue(value)
            ? value
            : undefined;
        break;
      default:
        accepted = undefined;
        break;
    }

    if (accepted === undefined) {
      redactedKeys.push(key);
      continue;
    }

    fields[key] = accepted;
  }

  return { fields: fields as FeedPerformanceEventFields, droppedKeys, redactedKeys };
}

/**
 * Stable 32-bit FNV-1a digest of a playback ID, rendered as 8 lowercase hex
 * characters.
 *
 * This is pseudonymization, not anonymization. Its job is to keep raw playback
 * IDs — which can be turned into public playback URLs — out of telemetry while
 * still allowing two events to be correlated to the same media. Do not treat
 * it as a security primitive and do not use it for access control.
 */
export function hashPlaybackId(playbackId: string, salt = "robotube-feed"): string {
  const input = `${salt}:${playbackId}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function isFeedPerformanceEventName(
  value: unknown,
): value is FeedPerformanceEventName {
  return (
    typeof value === "string" &&
    (FEED_PERFORMANCE_EVENT_NAMES as readonly string[]).includes(value)
  );
}

export function createFeedPerformanceEvent(
  name: FeedPerformanceEventName,
  fields?: Readonly<Record<string, unknown>>,
): FeedPerformanceEvent {
  return { name, fields: sanitizeFeedEventFields(fields).fields };
}

export type FeedPerformanceSink = (event: FeedPerformanceEvent) => void;

let activeSink: FeedPerformanceSink | null = null;

/** Installs the telemetry sink. Pass `null` to detach (the default state). */
export function setFeedPerformanceSink(sink: FeedPerformanceSink | null): void {
  activeSink = sink;
}

export function getFeedPerformanceSink(): FeedPerformanceSink | null {
  return activeSink;
}

/**
 * Sanitizes and forwards an event. Sink failures are swallowed on purpose:
 * telemetry must never take down feed playback.
 */
export function emitFeedPerformanceEvent(
  name: FeedPerformanceEventName,
  fields?: Readonly<Record<string, unknown>>,
): FeedPerformanceEvent {
  const event = createFeedPerformanceEvent(name, fields);
  const sink = activeSink;
  if (sink) {
    try {
      sink(event);
    } catch {
      // Intentionally ignored.
    }
  }
  return event;
}
