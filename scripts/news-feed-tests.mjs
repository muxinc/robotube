/**
 * Pure unit tests for the news-feed performance instrumentation and rollout
 * flags. No React Native runtime, no network, no device.
 *
 *   node scripts/news-feed-tests.mjs
 *
 * Robotube has no test runner in `package.json` and this work may not add one,
 * so the suite uses Node's built-in `node:test` and compiles the TypeScript
 * modules through `scripts/news-feed-load-lib.mjs`.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { loadFeedLib } from "./news-feed-load-lib.mjs";

const lib = await loadFeedLib();

const events = lib["feed-performance-events"];
const counters = lib["feed-performance-counters"];
const timeline = lib["feed-performance-timeline"];
const testFeed = lib["feed-performance-test-feed"];
const scenarios = lib["feed-performance-scenarios"];
const flags = lib["feed-feature-flags"];
const killSwitch = lib["feed-feature-kill-switch"];

/* ------------------------------------------------------------------ events */

// Copied verbatim from PRD section 11. If the PRD changes, this list changes
// first and the implementation follows.
const PRD_EVENT_NAMES = [
  "feed_query_started",
  "feed_query_received",
  "feed_first_cards_rendered",
  "feed_candidate_changed",
  "feed_focus_committed",
  "feed_player_created",
  "feed_player_attached",
  "feed_player_detached",
  "feed_source_replace_started",
  "feed_playback_requested",
  "feed_source_ready",
  "feed_first_frame",
  "feed_buffering_started",
  "feed_buffering_ended",
  "feed_playback_error",
  "feed_preload_started",
  "feed_preload_completed",
  "feed_preload_cancelled",
  "feed_preload_cache_hit",
  "feed_preload_promoted_to_active",
];

const PRD_COMMON_FIELDS = [
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
];

test("event vocabulary matches the PRD exactly", () => {
  assert.deepEqual([...events.FEED_PERFORMANCE_EVENT_NAMES].sort(), [...PRD_EVENT_NAMES].sort());
  assert.equal(events.FEED_PERFORMANCE_EVENT_NAMES.length, 20);
});

test("common field allowlist matches the PRD exactly", () => {
  assert.deepEqual([...events.FEED_EVENT_ALLOWED_FIELDS].sort(), [...PRD_COMMON_FIELDS].sort());
});

test("sanitizer drops keys outside the vocabulary", () => {
  const result = events.sanitizeFeedEventFields({
    session_id: "abc",
    transcript: "the whole transcript",
    user_email: "a@b.test",
  });
  assert.deepEqual(result.fields, { session_id: "abc" });
  assert.deepEqual(result.droppedKeys.sort(), ["transcript", "user_email"]);
});

test("sanitizer redacts URLs even under allowlisted keys", () => {
  for (const value of [
    "https://stream.mux.com/abc123.m3u8",
    "https://image.mux.com/abc/thumbnail.jpg?token=xyz",
    "robotube://video/abc",
  ]) {
    const result = events.sanitizeFeedEventFields({ mux_asset_id: value });
    assert.deepEqual(result.fields, {}, `expected ${value} to be redacted`);
    assert.deepEqual(result.redactedKeys, ["mux_asset_id"]);
  }
});

test("sanitizer redacts token, bearer, and JWT material", () => {
  const cases = [
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature",
    "Bearer sk-live-secret",
    "playback-token=abc123",
  ];
  for (const value of cases) {
    const result = events.sanitizeFeedEventFields({ session_id: value });
    assert.deepEqual(result.fields, {}, `expected ${value} to be redacted`);
  }
});

test("sanitizer drops long free text that could be a caption or transcript", () => {
  const longText = "a".repeat(201);
  const result = events.sanitizeFeedEventFields({ session_id: longText });
  assert.deepEqual(result.fields, {});
  assert.deepEqual(result.redactedKeys, ["session_id"]);
});

test("sanitizer enforces enum membership and numeric shape", () => {
  const result = events.sanitizeFeedEventFields({
    screen: "home_feed",
    platform: "ios",
    network_class: "satellite",
    cache_state: "warm",
    device_class: "high",
    feed_index: 3,
    is_preloaded: true,
    elapsed_ms: 12.6,
  });

  assert.equal(result.fields.screen, "home_feed");
  assert.equal(result.fields.platform, "ios");
  assert.equal(result.fields.cache_state, "warm");
  assert.equal(result.fields.device_class, "high");
  assert.equal(result.fields.feed_index, 3);
  assert.equal(result.fields.is_preloaded, true);
  assert.equal(result.fields.elapsed_ms, 13, "elapsed_ms is rounded");
  assert.equal("network_class" in result.fields, false, "satellite is not a known class");
});

test("sanitizer rejects negative, non-integer, and non-finite numerics", () => {
  assert.deepEqual(events.sanitizeFeedEventFields({ elapsed_ms: -1 }).fields, {});
  assert.deepEqual(events.sanitizeFeedEventFields({ elapsed_ms: Number.NaN }).fields, {});
  assert.deepEqual(events.sanitizeFeedEventFields({ feed_index: 1.5 }).fields, {});
  assert.deepEqual(events.sanitizeFeedEventFields({ feed_index: -2 }).fields, {});
});

test("error_code accepts short codes and rejects free text", () => {
  assert.equal(
    events.sanitizeFeedEventFields({ error_code: "MEDIA_DECODE_FAILED" }).fields.error_code,
    "MEDIA_DECODE_FAILED",
  );
  assert.deepEqual(
    events.sanitizeFeedEventFields({ error_code: "failed to load https://x.test/a.m3u8" }).fields,
    {},
  );
  assert.deepEqual(events.sanitizeFeedEventFields({ error_code: "x".repeat(65) }).fields, {});
});

test("hashPlaybackId is deterministic and never leaks the input", () => {
  const playbackId = "kf9NnkkPQhLZ4E01xrRJvbEHIQNGKlOWvGpNlL9lRNJs";
  const hash = events.hashPlaybackId(playbackId);

  assert.equal(hash, events.hashPlaybackId(playbackId), "same input, same hash");
  assert.match(hash, /^[0-9a-f]{8}$/);
  assert.equal(hash.includes(playbackId), false);
  assert.notEqual(hash, events.hashPlaybackId(`${playbackId}x`));
  assert.notEqual(hash, events.hashPlaybackId(playbackId, "other-salt"));
});

test("emit sanitizes before the sink sees the event and survives a throwing sink", () => {
  const seen = [];
  events.setFeedPerformanceSink((event) => {
    seen.push(event);
  });
  events.emitFeedPerformanceEvent(events.FEED_PERFORMANCE_EVENTS.feedFirstFrame, {
    mux_asset_id: "asset-1",
    playback_url: "https://stream.mux.com/abc.m3u8",
    elapsed_ms: 210,
  });

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], {
    name: "feed_first_frame",
    fields: { mux_asset_id: "asset-1", elapsed_ms: 210 },
  });

  events.setFeedPerformanceSink(() => {
    throw new Error("sink exploded");
  });
  assert.doesNotThrow(() =>
    events.emitFeedPerformanceEvent(events.FEED_PERFORMANCE_EVENTS.feedPlaybackError, {
      error_code: "E_TEST",
    }),
  );

  events.setFeedPerformanceSink(null);
});

/* ---------------------------------------------------------------- counters */

function newCounters(options) {
  return new counters.FeedPerformanceCounters({ enabled: true, ...options });
}

test("gauges clamp at zero and retain peaks", () => {
  const registry = newCounters();
  registry.adjustGauge("mountedFeedRows", 5);
  registry.adjustGauge("mountedFeedRows", -2);
  assert.equal(registry.getGauge("mountedFeedRows"), 3);
  assert.equal(registry.getPeak("mountedFeedRows"), 5);

  registry.adjustGauge("mountedFeedRows", -99);
  assert.equal(registry.getGauge("mountedFeedRows"), 0, "never negative");
  assert.equal(registry.getPeak("mountedFeedRows"), 5, "peak survives");
});

test("more than one attached surface or playing video is an invariant violation", () => {
  const registry = newCounters();
  assert.deepEqual(registry.getInvariantViolations(), []);

  registry.setGauge("attachedPlayerSurfaces", 2);
  registry.setGauge("playingFeedVideos", 2);
  const violations = registry.getInvariantViolations().map((v) => v.invariant);
  assert.deepEqual(violations.sort(), [
    "at_most_one_attached_surface",
    "at_most_one_playing_video",
  ]);
});

test("the standby-player fallback raises the live-player limit without loosening the others", () => {
  const registry = newCounters();
  registry.setGauge("livePlayerInstances", 2);
  assert.equal(registry.getInvariantViolations().length, 1);

  registry.setLimits({ maxLivePlayerInstances: 2 });
  assert.deepEqual(registry.getInvariantViolations(), []);

  registry.setGauge("attachedPlayerSurfaces", 2);
  assert.equal(
    registry.getInvariantViolations()[0].invariant,
    "at_most_one_attached_surface",
    "the one-surface guarantee is not configurable",
  );
});

test("the preload window is bounded to the current item plus one", () => {
  const registry = newCounters();
  registry.setGauge("preloadedItemsRetained", 2);
  assert.deepEqual(registry.getInvariantViolations(), []);
  registry.setGauge("preloadedItemsRetained", 3);
  assert.equal(registry.getInvariantViolations()[0].invariant, "bounded_preload_window");
});

test("disabled counters are inert", () => {
  const registry = new counters.FeedPerformanceCounters({ enabled: false });
  registry.adjustGauge("mountedFeedRows", 10);
  registry.increment("preloadStarts", 5);
  assert.equal(registry.getGauge("mountedFeedRows"), 0);
  assert.equal(registry.getCounter("preloadStarts"), 0);
  assert.equal(registry.snapshot().enabled, false);
});

test("subscribers see snapshots and can unsubscribe", () => {
  const registry = newCounters();
  const seen = [];
  const unsubscribe = registry.subscribe((snapshot) => seen.push(snapshot.counters.preloadStarts));

  registry.increment("preloadStarts");
  registry.increment("preloadStarts");
  unsubscribe();
  registry.increment("preloadStarts");

  assert.deepEqual(seen, [1, 2]);
  assert.equal(registry.getCounter("preloadStarts"), 3);
});

test("reset clears gauges, peaks, and totals between runs", () => {
  const registry = newCounters();
  registry.setGauge("livePlayerInstances", 1);
  registry.increment("sourceReplacements", 4);
  registry.reset();

  const snapshot = registry.snapshot();
  assert.equal(snapshot.gauges.livePlayerInstances, 0);
  assert.equal(snapshot.peaks.livePlayerInstances, 0);
  assert.equal(snapshot.counters.sourceReplacements, 0);
  assert.deepEqual(snapshot.invariantViolations, []);
});

/* ---------------------------------------------------------------- timeline */

test("percentile uses nearest rank and never invents a value", () => {
  const sorted = [100, 200];
  assert.equal(timeline.percentile(sorted, 50), 100);
  assert.equal(timeline.percentile(sorted, 75), 200);
  assert.equal(timeline.percentile([10, 20, 30, 40], 75), 30);
  assert.ok(Number.isNaN(timeline.percentile([], 75)));
});

test("summarizeDurations reports count, p75, and mean", () => {
  const summary = timeline.summarizeDurations([100, 150, 200, 900]);
  assert.equal(summary.count, 4);
  assert.equal(summary.min, 100);
  assert.equal(summary.max, 900);
  assert.equal(summary.p75, 200);
  assert.equal(summary.mean, 337.5);

  const empty = timeline.summarizeDurations([]);
  assert.equal(empty.count, 0);
  assert.ok(Number.isNaN(empty.p75));
});

test("timeline derives spans and refuses incomplete or reversed sequences", () => {
  const recorder = new timeline.FeedTimelineRecorder();
  recorder.mark("asset-a", "focus_committed", 1000);
  recorder.mark("asset-a", "playback_requested", 1010);
  recorder.mark("asset-a", "source_ready", 1120);
  recorder.mark("asset-a", "first_frame", 1180);

  assert.equal(recorder.spanDuration("asset-a", "playbackRequestToFirstFrame"), 170);
  assert.equal(recorder.spanDuration("asset-a", "sourceReadyToFirstFrame"), 60);
  assert.equal(recorder.spanDuration("asset-a", "commitToFirstFrame"), 180);
  assert.equal(recorder.spanDuration("asset-a", "candidateToCommit"), null, "mark missing");

  const reversed = new timeline.FeedTimelineRecorder();
  reversed.mark("asset-b", "first_frame", 500);
  reversed.mark("asset-b", "playback_requested", 900);
  assert.equal(
    reversed.spanDuration("asset-b", "playbackRequestToFirstFrame"),
    null,
    "a first frame before the request is not a zero-length span",
  );
});

test("buffering time sums every start/end pair", () => {
  const recorder = new timeline.FeedTimelineRecorder();
  recorder.mark("asset-a", "buffering_started", 0);
  recorder.mark("asset-a", "buffering_ended", 120);
  recorder.mark("asset-a", "buffering_started", 500);
  recorder.mark("asset-a", "buffering_ended", 560);
  recorder.mark("asset-a", "buffering_started", 900); // still open

  assert.equal(recorder.totalBufferingMs("asset-a"), 180);
  assert.equal(recorder.totalBufferingMs("unknown"), 0);
});

test("recorder track count stays bounded during a long scroll", () => {
  const recorder = new timeline.FeedTimelineRecorder({ maxTracks: 8 });
  for (let index = 0; index < 200; index += 1) {
    recorder.mark(`asset-${index}`, "focus_committed", index);
  }
  assert.equal(recorder.trackCount(), 8);
});

test("first-frame gate reports null when a scenario was never run", () => {
  const unrun = timeline.evaluateFirstFrameGate({ warmSamples: [], coldSamples: [] });
  assert.equal(unrun.warmPasses, null, "no samples is not a pass");
  assert.equal(unrun.coldPasses, null);

  const measured = timeline.evaluateFirstFrameGate({
    warmSamples: [180, 220, 260, 290],
    coldSamples: [800, 900, 1300, 1500],
  });
  assert.equal(measured.warmP75TargetMs, 300);
  assert.equal(measured.coldP75TargetMs, 1200);
  assert.equal(measured.warmPasses, true);
  assert.equal(measured.cold.p75, 1300);
  assert.equal(measured.coldPasses, false, "p75 of 1300 ms exceeds the 1.2 s target");
});

/* --------------------------------------------------------------- test feed */

test("the deterministic feed is byte-identical for a given seed", () => {
  const a = testFeed.createDeterministicFeed({ count: 50, seed: 7 });
  const b = testFeed.createDeterministicFeed({ count: 50, seed: 7 });
  const c = testFeed.createDeterministicFeed({ count: 50, seed: 8 });

  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.notEqual(JSON.stringify(a), JSON.stringify(c));
});

test("a 50-item feed has unique ids and strictly descending timestamps", () => {
  const feed = testFeed.createDeterministicFeed({ count: 50 });
  assert.equal(feed.length, 50);

  const ids = new Set(feed.map((card) => card.muxAssetId));
  assert.equal(ids.size, 50, "no duplicate cards");

  for (let index = 1; index < feed.length; index += 1) {
    assert.ok(
      feed[index].createdAtMs < feed[index - 1].createdAtMs,
      `card ${index} is not older than card ${index - 1}`,
    );
  }
});

test("generated cards satisfy the section 7.4 contract", () => {
  const feed = testFeed.createDeterministicFeed({ count: 16 });
  assert.deepEqual(testFeed.findFeedCardContractViolations(feed), []);
  assert.equal(testFeed.isFeedCardContractPage(feed), true);
});

test("rich metadata in a feed response is reported as a forbidden field", () => {
  const [card] = testFeed.createDeterministicFeed({ count: 1 });
  const heavy = testFeed.withSyntheticRichMetadata(card);
  const violations = testFeed.findFeedCardContractViolations([heavy]);

  assert.ok(violations.length > 0);
  const forbidden = violations.filter((v) => v.kind === "forbidden_field").map((v) => v.field);
  for (const field of ["summary", "tags", "chapters", "keyMoments", "playbackUrl"]) {
    assert.ok(forbidden.includes(field), `${field} should be flagged`);
  }
});

test("contract check catches missing fields and wrong types", () => {
  const violations = testFeed.findFeedCardContractViolations([
    { muxAssetId: "a", playbackId: "b", thumbnailUrl: "c", title: "d", channelName: "e" },
    { ...testFeed.createDeterministicFeed({ count: 1 })[0], durationSeconds: "60" },
  ]);

  const missing = violations.filter((v) => v.kind === "missing_field").map((v) => v.field);
  assert.deepEqual(missing.sort(), ["channelAvatarUrl", "createdAtMs", "durationSeconds"]);
  assert.ok(violations.some((v) => v.kind === "wrong_type" && v.field === "durationSeconds"));
});

test("projectFeedCard strips everything outside the contract", () => {
  const [card] = testFeed.createDeterministicFeed({ count: 1 });
  const projected = testFeed.projectFeedCard(testFeed.withSyntheticRichMetadata(card));
  assert.deepEqual(Object.keys(projected).sort(), [...testFeed.FEED_CARD_CONTRACT_FIELDS].sort());
  assert.deepEqual(testFeed.findFeedCardContractViolations([projected]), []);
});

test("response size scales the 15 KB / 16-card budget by card count", () => {
  const cards = testFeed.createDeterministicFeed({ count: 16 });
  const report = testFeed.measureFeedResponseSize(cards);

  assert.equal(report.cardCount, 16);
  assert.equal(report.budgetBytes, 15 * 1024);
  assert.equal(report.bytes, testFeed.serializedByteLength(cards));
  assert.equal(report.withinBudget, report.bytes <= 15 * 1024);

  const page48 = testFeed.measureFeedResponseSize(testFeed.createDeterministicFeed({ count: 48 }));
  assert.equal(page48.budgetBytes, 3 * 15 * 1024);
});

test("synthetic playback ids are marked as not playable", () => {
  const [synthetic] = testFeed.createDeterministicFeed({ count: 1 });
  assert.equal(testFeed.isSyntheticPlaybackId(synthetic.playbackId), true);

  const [real] = testFeed.createDeterministicFeed({ count: 1, playbackIds: ["abc123"] });
  assert.equal(real.playbackId, "abc123");
  assert.equal(testFeed.isSyntheticPlaybackId(real.playbackId), false);
});

/* --------------------------------------------------------------- scenarios */

test("every Phase 0 scenario is defined", () => {
  const expected = [
    "cold-launch",
    "warm-launch",
    "slow-scroll",
    "fast-fling",
    "reverse-scroll",
    "pagination",
    "tab-switch",
    "background-foreground",
    "open-detail-back",
  ];
  assert.deepEqual(scenarios.FEED_SCENARIOS.map((s) => s.id), expected);
  for (const scenario of scenarios.FEED_SCENARIOS) {
    assert.ok(scenario.steps.length > 0, `${scenario.id} needs steps`);
    assert.ok(scenario.captures.length > 0, `${scenario.id} needs captures`);
  }
});

test("no simulator or emulator profile counts as a performance measurement", () => {
  for (const profile of scenarios.FEED_DEVICE_PROFILES) {
    if (profile.kind === "simulator" || profile.kind === "emulator") {
      assert.equal(
        profile.measurementValidity,
        "functional-only",
        `${profile.id} must not be treated as a performance reference`,
      );
    }
  }
});

test("only observed physical hardware is performance-grade", () => {
  const performanceGrade = scenarios.getPerformanceGradeProfiles();
  assert.ok(performanceGrade.length > 0, "at least the reference iPhone is available");
  for (const profile of performanceGrade) {
    assert.equal(profile.kind, "physical");
    assert.equal(profile.availability, "observed");
  }
  assert.equal(
    performanceGrade.some((p) => p.platform === "android"),
    false,
    "no physical Android device has been observed",
  );
});

test("the run matrix carries measurement validity into every cell", () => {
  const cells = scenarios.buildRunMatrix(["ios-physical-reference", "ios-simulator-functional"]);
  assert.equal(cells.length, 9 * 2 * 2);
  assert.ok(
    cells
      .filter((cell) => cell.profileId === "ios-simulator-functional")
      .every((cell) => cell.measurementValidity === "functional-only"),
  );
  assert.deepEqual(scenarios.buildRunMatrix(["does-not-exist"]), []);
});

/* ------------------------------------------------------------------- flags */

const IOS = { platform: "ios", preloadKillSwitchEngaged: false };

test("every flag is off by default and documents an owner and removal date", () => {
  const resolved = flags.resolveFeedFeatureFlags(IOS);
  for (const key of flags.FEED_FEATURE_FLAG_KEYS) {
    assert.equal(resolved[key].enabled, false, `${key} must default off`);
    assert.equal(resolved[key].source, "default");

    const definition = flags.FEED_FEATURE_FLAGS[key];
    assert.ok(definition.owner.length > 0, `${key} needs an owner`);
    assert.match(definition.removalDate, /^\d{4}-\d{2}-\d{2}$/, `${key} needs a removal date`);
    assert.ok(definition.rollbackNote.length > 0, `${key} needs a rollback note`);
  }
});

test("expired flags are reported against a given date", () => {
  assert.deepEqual(flags.findExpiredFeedFeatureFlags("2026-01-01"), []);
  const expired = flags.findExpiredFeedFeatureFlags("2027-01-01").map((d) => d.key);
  assert.deepEqual(expired.sort(), [...flags.FEED_FEATURE_FLAG_KEYS].sort());
});

test("remote config enables a flag and a local override outranks it", () => {
  const remoteOn = flags.resolveFeedFeatureFlags({
    ...IOS,
    remote: { feedSharedPlayer: true },
  });
  assert.equal(remoteOn.feedSharedPlayer.enabled, true);
  assert.equal(remoteOn.feedSharedPlayer.source, "remote");

  const overridden = flags.resolveFeedFeatureFlags({
    ...IOS,
    remote: { feedSharedPlayer: true },
    overrides: { feedSharedPlayer: false },
  });
  assert.equal(overridden.feedSharedPlayer.enabled, false);
  assert.equal(overridden.feedSharedPlayer.source, "override");
});

test("cohort bucketing is stable per user and independent per flag", () => {
  assert.equal(flags.rolloutBucket("feedSharedPlayer", "user-1"), flags.rolloutBucket("feedSharedPlayer", "user-1"));
  assert.notEqual(
    flags.rolloutBucket("feedSharedPlayer", "user-1"),
    flags.rolloutBucket("feedPredictivePreload", "user-1"),
  );

  for (let index = 0; index < 200; index += 1) {
    const bucket = flags.rolloutBucket("feedSharedPlayer", `user-${index}`);
    assert.ok(Number.isInteger(bucket) && bucket >= 0 && bucket < 100);
  }

  assert.equal(flags.isInRolloutCohort("feedSharedPlayer", "user-1", 0), false);
  assert.equal(flags.isInRolloutCohort("feedSharedPlayer", "user-1", 100), true);
});

test("a 10% ramp exposes roughly a tenth of stable ids", () => {
  let exposed = 0;
  for (let index = 0; index < 2000; index += 1) {
    if (flags.isInRolloutCohort("feedSharedPlayer", `install-${index}`, 10)) exposed += 1;
  }
  assert.ok(exposed > 120 && exposed < 280, `expected roughly 200 of 2000, got ${exposed}`);
});

test("a configured rollout without a stable id resolves off", () => {
  const resolved = flags.resolveFeedFeatureFlags({
    ...IOS,
    rollout: { feedSharedPlayer: { ios: { percent: 100 } } },
  });
  assert.equal(resolved.feedSharedPlayer.enabled, false);
  assert.match(resolved.feedSharedPlayer.reason, /no stableId/);
});

test("Android exposure stays off until physical validation is recorded", () => {
  const androidContext = {
    platform: "android",
    preloadKillSwitchEngaged: false,
    remote: { feedSharedPlayer: true, feedPredictivePreload: true, feedLightweightQuery: true },
  };

  const gated = flags.resolveFeedFeatureFlags(androidContext);
  assert.equal(gated.feedSharedPlayer.enabled, false);
  assert.equal(gated.feedSharedPlayer.source, "android_validation_gate");
  assert.equal(gated.feedPredictivePreload.enabled, false);
  assert.equal(
    gated.feedLightweightQuery.enabled,
    true,
    "the data-only query does not depend on Android hardware validation",
  );

  const validated = flags.resolveFeedFeatureFlags({
    ...androidContext,
    androidPhysicalValidationCompleted: true,
  });
  assert.equal(validated.feedSharedPlayer.enabled, true);

  const ios = flags.resolveFeedFeatureFlags({ ...IOS, remote: { feedSharedPlayer: true } });
  assert.equal(ios.feedSharedPlayer.enabled, true, "iOS rollout proceeds independently");
});

test("the kill switch outranks remote config and local overrides", () => {
  const resolved = flags.resolveFeedFeatureFlags({
    platform: "ios",
    remote: { feedPredictivePreload: true, feedSharedPlayer: true },
    overrides: { feedPredictivePreload: true, feedStandbyPlayerFallback: true },
    preloadKillSwitchEngaged: true,
  });

  assert.equal(resolved.feedPredictivePreload.enabled, false);
  assert.equal(resolved.feedPredictivePreload.source, "kill_switch");
  assert.equal(resolved.feedStandbyPlayerFallback.enabled, false);
  assert.equal(
    resolved.feedSharedPlayer.enabled,
    true,
    "killing preload must not revert shared-player playback",
  );
});

test("the resolver reads the live kill switch when the context omits it", () => {
  killSwitch.preloadKillSwitch.reset();
  const before = flags.resolveFeedFeatureFlags({
    platform: "ios",
    remote: { feedSharedPlayer: true, feedPredictivePreload: true },
  });
  assert.equal(before.feedPredictivePreload.enabled, true);

  killSwitch.engagePreloadKillSwitch("test");
  const after = flags.resolveFeedFeatureFlags({
    platform: "ios",
    remote: { feedSharedPlayer: true, feedPredictivePreload: true },
  });
  assert.equal(after.feedPredictivePreload.enabled, false);
  assert.equal(after.feedSharedPlayer.enabled, true);

  killSwitch.preloadKillSwitch.reset();
});

test("illegal flag combinations are named", () => {
  const both = flags.resolveFeedFeatureFlags({
    platform: "ios",
    preloadKillSwitchEngaged: false,
    overrides: {
      feedSharedPlayer: true,
      feedPredictivePreload: true,
      feedStandbyPlayerFallback: true,
    },
  });
  assert.match(flags.findFlagCombinationViolations(both)[0], /at most one/);

  const preloadWithoutPlayer = flags.resolveFeedFeatureFlags({
    platform: "ios",
    preloadKillSwitchEngaged: false,
    overrides: { feedPredictivePreload: true },
  });
  assert.match(
    flags.findFlagCombinationViolations(preloadWithoutPlayer)[0],
    /requires feedSharedPlayer/,
  );

  const valid = flags.resolveFeedFeatureFlags({
    platform: "ios",
    preloadKillSwitchEngaged: false,
    overrides: { feedSharedPlayer: true, feedPredictivePreload: true },
  });
  assert.deepEqual(flags.findFlagCombinationViolations(valid), []);
});

/* ------------------------------------------------------------- kill switch */

test("engaging notifies subscribers synchronously", () => {
  const instance = new killSwitch.PreloadKillSwitch();
  const seen = [];
  instance.subscribe((state) => seen.push(state.engaged));

  instance.engage("memory pressure", { atMs: 10 });

  assert.deepEqual(seen, [true], "the listener ran before engage() returned");
  assert.equal(instance.isEngaged(), true);
  assert.equal(instance.getState().reason, "memory pressure");
});

test("a malformed remote payload fails closed", () => {
  for (const payload of [null, undefined, "disabled", [], {}, { preloadDisabled: "yes" }]) {
    const instance = new killSwitch.PreloadKillSwitch();
    const state = instance.applyRemotePayload(payload);
    assert.equal(state.engaged, true, `payload ${JSON.stringify(payload)} should fail closed`);
    assert.equal(state.source, "malformed_remote_payload");
  }
});

test("a stale remote payload cannot resurrect preloading", () => {
  const instance = new killSwitch.PreloadKillSwitch();
  instance.applyRemotePayload({ preloadDisabled: true, reason: "incident", updatedAtMs: 500 });
  assert.equal(instance.isEngaged(), true);

  instance.applyRemotePayload({ preloadDisabled: false, updatedAtMs: 400 });
  assert.equal(instance.isEngaged(), true, "older payload ignored");

  instance.applyRemotePayload({ preloadDisabled: false, updatedAtMs: 600 });
  assert.equal(instance.isEngaged(), false, "newer payload applies");
  assert.equal(instance.getState().reason, null);
});

test("one throwing subscriber does not starve the others", () => {
  const instance = new killSwitch.PreloadKillSwitch();
  let reached = false;
  instance.subscribe(() => {
    throw new Error("bad subscriber");
  });
  instance.subscribe(() => {
    reached = true;
  });

  assert.doesNotThrow(() => instance.engage("incident"));
  assert.equal(reached, true);
});

test("unsubscribed listeners stop hearing changes", () => {
  const instance = new killSwitch.PreloadKillSwitch();
  let calls = 0;
  const unsubscribe = instance.subscribe(() => {
    calls += 1;
  });

  instance.engage("first", { atMs: 1 });
  unsubscribe();
  instance.release({ atMs: 2 });

  assert.equal(calls, 1);
});

test("rollout guards ignore unmeasured metrics and pause on breaches", () => {
  const unmeasured = killSwitch.evaluateRolloutGuards({});
  assert.equal(unmeasured.shouldPauseRollout, false);
  assert.deepEqual(unmeasured.breachedMetrics, []);

  const healthy = killSwitch.evaluateRolloutGuards({
    crashRateRatioToBaseline: 1.0,
    memoryWarningRateRatioToBaseline: 1.1,
    playbackErrorRateRatioToBaseline: 1.0,
    wrongVideoIncidentCount: 0,
  });
  assert.equal(healthy.shouldPauseRollout, false);

  const crashing = killSwitch.evaluateRolloutGuards({ crashRateRatioToBaseline: 1.5 });
  assert.equal(crashing.shouldPauseRollout, true);
  assert.deepEqual(crashing.breachedMetrics, ["crash_rate"]);
  assert.equal(
    crashing.shouldEngagePreloadKillSwitch,
    false,
    "disabling preload does not fix a crash regression",
  );

  const memory = killSwitch.evaluateRolloutGuards({ memoryWarningRateRatioToBaseline: 2 });
  assert.equal(memory.shouldEngagePreloadKillSwitch, true);

  const wrongVideo = killSwitch.evaluateRolloutGuards({ wrongVideoIncidentCount: 1 });
  assert.equal(wrongVideo.shouldPauseRollout, true);
});
