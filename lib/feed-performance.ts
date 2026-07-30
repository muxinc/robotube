/**
 * Entry point for the news-feed performance instrumentation.
 *
 * Import from `@/lib/feed-performance` rather than reaching into the
 * individual modules, so Phase 6's "remove temporary counters and retain
 * production-safe performance telemetry" is a change in one place.
 *
 * What is production-safe and what is temporary:
 *
 *   feed-performance-events     production-safe (sanitized, allowlisted)
 *   feed-performance-timeline   production-safe (derives the PRD's latency gates)
 *   feed-performance-counters   TEMPORARY, development-only; removed in Phase 6
 *   feed-performance-test-feed  test/fixture tooling; never shipped in a UI path
 *   feed-performance-scenarios  documentation data for run sheets
 */

export {
  FEED_CACHE_STATES,
  FEED_DEVICE_CLASSES,
  FEED_EVENT_ALLOWED_FIELDS,
  FEED_NETWORK_CLASSES,
  FEED_PERFORMANCE_EVENT_NAMES,
  FEED_PERFORMANCE_EVENTS,
  FEED_PLATFORMS,
  FEED_SCREENS,
  createFeedPerformanceEvent,
  emitFeedPerformanceEvent,
  getFeedPerformanceSink,
  hashPlaybackId,
  isFeedPerformanceEventName,
  sanitizeFeedEventFields,
  setFeedPerformanceSink,
  type FeedCacheState,
  type FeedDeviceClass,
  type FeedEventSanitizeResult,
  type FeedNetworkClass,
  type FeedPerformanceEvent,
  type FeedPerformanceEventFields,
  type FeedPerformanceEventName,
  type FeedPerformanceSink,
  type FeedPlatform,
  type FeedScreen,
} from "./feed-performance-events";

export {
  DEFAULT_FEED_INVARIANT_LIMITS,
  FEED_COUNTER_KEYS,
  FEED_GAUGE_KEYS,
  FEED_INVARIANTS,
  FeedPerformanceCounters,
  feedPerformanceCounters,
  formatFeedCountersSnapshot,
  type FeedCounterKey,
  type FeedCountersListener,
  type FeedCountersSnapshot,
  type FeedGaugeKey,
  type FeedInvariantLimits,
  type FeedInvariantName,
  type FeedInvariantViolation,
} from "./feed-performance-counters";

export {
  COLD_FIRST_FRAME_P75_TARGET_MS,
  FEED_TIMELINE_MARKS,
  FEED_TIMELINE_SPANS,
  FeedTimelineRecorder,
  WARM_FIRST_FRAME_P75_TARGET_MS,
  evaluateFirstFrameGate,
  percentile,
  summarizeDurations,
  type FeedDurationSummary,
  type FeedFirstFrameGateInput,
  type FeedFirstFrameGateResult,
  type FeedTimelineEntry,
  type FeedTimelineMark,
  type FeedTimelineSpanName,
  type FeedTimelineTrack,
} from "./feed-performance-timeline";

export {
  DEFAULT_FIXTURE_BASE_CREATED_AT_MS,
  DEFAULT_FIXTURE_SEED,
  FEED_CARD_CONTRACT_FIELDS,
  FEED_CARD_FORBIDDEN_FIELDS,
  FEED_RESPONSE_SIZE_BUDGET_BYTES,
  FEED_RESPONSE_SIZE_BUDGET_CARD_COUNT,
  SYNTHETIC_PLAYBACK_ID_PREFIX,
  createDeterministicFeed,
  findFeedCardContractViolations,
  isFeedCardContractPage,
  isSyntheticPlaybackId,
  measureFeedResponseSize,
  projectFeedCard,
  serializedByteLength,
  withSyntheticRichMetadata,
  type DeterministicFeedOptions,
  type FeedCardContract,
  type FeedCardContractField,
  type FeedCardContractViolation,
  type FeedResponseSizeReport,
} from "./feed-performance-test-feed";

export {
  FEED_DEVICE_PROFILES,
  FEED_NETWORK_STATES,
  FEED_SCENARIOS,
  STANDARD_SCENARIO_ITEM_COUNT,
  buildRunMatrix,
  getDeviceProfile,
  getPerformanceGradeProfiles,
  getScenario,
  type FeedDeviceProfile,
  type FeedNetworkState,
  type FeedScenario,
  type FeedScenarioCapture,
  type MeasurementValidity,
  type ProfileAvailability,
  type ScenarioRunCell,
} from "./feed-performance-scenarios";
