/**
 * Pure unit tests for the 9:16 vertical-feed fixtures, eligibility oracle,
 * placement audits, Shorts telemetry vocabulary, rollout flags, cohort ladder,
 * rollback plan, and dashboard specifications.
 *
 *   node scripts/vertical-video-feed-tests.mjs
 *
 * No React Native runtime, no Convex deployment, no network, no device. These
 * tests can prove that the *rules* are right; they cannot prove anything about
 * a running app, and nothing here should be read as device evidence.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadVerticalLib } from "./vertical-video-feed-load-lib.mjs";

const lib = await loadVerticalLib();

const events = lib["feed-performance-events"];
const flags = lib["feed-feature-flags"];
const fixtures = lib["vertical-video-feed-fixtures"];
const audit = lib["vertical-video-feed-audit"];
const scenarios = lib["vertical-video-feed-scenarios"];
const rollout = lib["vertical-video-feed-rollout"];
const dashboards = lib["vertical-video-feed-dashboards"];
const barrel = lib["vertical-video-feed"];
const testFeed = lib["feed-performance-test-feed"];

/* ------------------------------------------------- aspect classification */

test("exact and reducible 9:16 inputs classify as vertical", () => {
  for (const input of [
    "9:16",
    "1080:1920",
    "720:1280",
    "1440:2560",
    "540:960",
    "2160:3840",
    "360:640",
    "1170:2080",
    "450:800",
    "4320:7680",
    "288:512",
    "1620:2880",
  ]) {
    const result = fixtures.normalizeAspectRatio(input);
    assert.equal(result.feedPlacement, "vertical", `${input} must be vertical`);
    assert.equal(result.aspectRatio, "9:16", `${input} must reduce to 9:16`);
    assert.equal(result.unknownReason, null);
  }
});

test("valid non-9:16 ratios classify as standard with their reduced form", () => {
  const cases = [
    ["16:9", "16:9"],
    ["1920:1080", "16:9"],
    ["4:5", "4:5"],
    ["2:3", "2:3"],
    ["10:16", "5:8"],
    ["1:1", "1:1"],
    ["21:9", "7:3"],
    ["3840:2160", "16:9"],
  ];

  for (const [input, expected] of cases) {
    const result = fixtures.normalizeAspectRatio(input);
    assert.equal(result.feedPlacement, "standard", `${input} must be standard`);
    assert.equal(result.aspectRatio, expected);
  }
});

test("near-portrait ratios are never rounded into eligibility", () => {
  // The v1 decision is exact-only: no tolerance band, however close.
  for (const input of ["4:5", "2:3", "10:16", "5:8", "1080:1919", "1081:1920"]) {
    assert.notEqual(
      fixtures.normalizeAspectRatio(input).feedPlacement,
      "vertical",
      `${input} must not qualify`,
    );
  }
});

test("missing, malformed, and out-of-domain input classifies as unknown", () => {
  const cases = [
    [undefined, "missing"],
    [null, "missing"],
    [123, "not_a_string"],
    [0.5625, "not_a_string"],
    ["", "empty"],
    [" 9:16", "contains_whitespace"],
    ["9:16 ", "contains_whitespace"],
    ["9 : 16", "contains_whitespace"],
    ["9x16", "malformed"],
    ["9:16:1", "malformed"],
    ["0.5625", "malformed"],
    ["9e0:16", "malformed"],
    [":16", "malformed"],
    ["9:", "malformed"],
    ["0:16", "non_positive"],
    ["9:0", "non_positive"],
    ["-9:16", "non_positive"],
    ["9:-16", "non_positive"],
    ["9.5:16", "non_integer"],
    ["9:16.5", "non_integer"],
    ["9007199254740993:16012798674205320", "unsafe_integer"],
  ];

  for (const [input, reason] of cases) {
    const result = fixtures.normalizeAspectRatio(input);
    assert.equal(
      result.feedPlacement,
      "unknown",
      `${String(input)} must be unknown, got ${result.feedPlacement}`,
    );
    assert.equal(result.aspectRatio, null);
    assert.equal(result.unknownReason, reason, `${String(input)} reason`);
  }
});

test("unknown is never assumed to be 9:16", () => {
  // PRD section 3 decision 7. Stated as its own test because it is the rule the
  // whole exclusivity model rests on.
  for (const input of [undefined, null, "", "garbage", "9:0"]) {
    assert.notEqual(fixtures.normalizeAspectRatio(input).feedPlacement, "vertical");
  }
});

test("normalization is a pure function of its input", () => {
  const first = fixtures.normalizeAspectRatio("1080:1920");
  const second = fixtures.normalizeAspectRatio("1080:1920");
  assert.deepEqual(first, second);
  assert.notEqual(first, second, "returns a fresh object, not a shared one");
});

/* ------------------------------------------------------------ visibility */

test("every section 7.3 condition can independently exclude an item", () => {
  const base = {
    status: "ready",
    isReady: true,
    isDeleted: false,
    feedPlacement: "vertical",
    playbackIds: ["pb-1"],
    feedVisible: true,
  };

  assert.equal(fixtures.evaluateShortsVisibility(base).eligible, true);

  const exclusions = [
    [{ status: "preparing" }, "status_not_ready"],
    [{ isReady: false }, "not_ready_flag"],
    [{ isDeleted: true }, "deleted"],
    [{ feedPlacement: "standard" }, "placement_not_vertical"],
    [{ feedPlacement: "unknown" }, "placement_not_vertical"],
    [{ playbackIds: [] }, "no_usable_playback_id"],
    [{ playbackIds: [""] }, "no_usable_playback_id"],
    [{ feedVisible: false }, "feed_visibility_denied"],
  ];

  for (const [override, reason] of exclusions) {
    const result = fixtures.evaluateShortsVisibility({ ...base, ...override });
    assert.equal(result.eligible, false, `${reason} must exclude`);
    assert.ok(result.reasons.includes(reason), `expected reason ${reason}`);
  }
});

test("visibility reports every failing condition, not just the first", () => {
  const result = fixtures.evaluateShortsVisibility({
    status: "errored",
    isReady: false,
    isDeleted: true,
    feedPlacement: "unknown",
    playbackIds: [],
    feedVisible: false,
  });

  assert.equal(result.eligible, false);
  assert.equal(result.reasons.length, 6);
});

/* --------------------------------------------------------------- fixtures */

test("the fixture set meets the Phase 0 size requirement", () => {
  const qualifying = fixtures.getVerticalFeedFixtures("qualifying");
  const nonqualifying = fixtures.getShortsIneligibleFixtures();

  assert.ok(
    qualifying.length >= 10,
    `expected at least 10 qualifying fixtures, found ${qualifying.length}`,
  );
  assert.ok(
    nonqualifying.length >= 10,
    `expected at least 10 non-qualifying fixtures, found ${nonqualifying.length}`,
  );

  // Each non-qualifying kind must actually be represented; a set of 20 that is
  // all malformed strings would satisfy a count check and prove nothing.
  assert.ok(fixtures.getVerticalFeedFixtures("nonqualifying_ratio").length >= 5);
  assert.ok(fixtures.getVerticalFeedFixtures("malformed_ratio").length >= 10);
  assert.ok(fixtures.getVerticalFeedFixtures("visibility_excluded").length >= 5);
});

test("every fixture's recorded expectation matches the oracle", () => {
  assert.deepEqual(fixtures.findFixtureOracleDisagreements(), []);
});

test("fixture ids are unique and stable", () => {
  const ids = fixtures.VERTICAL_FEED_FIXTURES.map((fixture) => fixture.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate fixture id");
  for (const fixture of fixtures.VERTICAL_FEED_FIXTURES) {
    assert.ok(fixture.intent.length > 0, `${fixture.id} needs an intent`);
  }
});

test("every eligible fixture is vertical and every ineligible one is not eligible", () => {
  for (const fixture of fixtures.getShortsEligibleFixtures()) {
    assert.equal(fixture.expectedPlacement, "vertical");
    assert.equal(fixtures.evaluateFixtureVisibility(fixture).eligible, true);
  }
  for (const fixture of fixtures.getShortsIneligibleFixtures()) {
    assert.equal(fixtures.evaluateFixtureVisibility(fixture).eligible, false);
  }
});

test("visibility-excluded fixtures still classify as vertical", () => {
  // Placement and eligibility are separate questions. A deleted 9:16 asset is
  // still a 9:16 asset, and conflating the two is how it ends up back in a feed.
  for (const fixture of fixtures.getVerticalFeedFixtures("visibility_excluded")) {
    assert.equal(fixtures.classifyFixture(fixture).feedPlacement, "vertical");
    assert.equal(fixture.expectedEligibleForShorts, false);
  }
});

test("a disagreeing classifier is reported per fixture and field", () => {
  // Stands in for the production Convex classifier once it exists.
  const tolerantClassifier = (input) =>
    typeof input === "string" && input.trim() === "4:5"
      ? { aspectRatio: "9:16", feedPlacement: "vertical" }
      : fixtures.normalizeAspectRatio(input);

  const disagreements = fixtures.findFixtureOracleDisagreements(tolerantClassifier);
  const fields = disagreements.map((entry) => entry.field);

  assert.ok(disagreements.length >= 3, "a 4:5 false positive must be caught");
  assert.ok(fields.includes("aspectRatio"));
  assert.ok(fields.includes("feedPlacement"));
  assert.ok(fields.includes("eligibleForShorts"));
  assert.ok(disagreements.every((entry) => entry.fixtureId === "portrait-4-5"));
});

test("the deterministic vertical feed is byte-identical for a given seed", () => {
  const first = fixtures.createDeterministicVerticalFeed({ count: 50, seed: 7 });
  const second = fixtures.createDeterministicVerticalFeed({ count: 50, seed: 7 });
  assert.equal(JSON.stringify(first), JSON.stringify(second));

  const other = fixtures.createDeterministicVerticalFeed({ count: 50, seed: 8 });
  assert.notEqual(JSON.stringify(first), JSON.stringify(other));
});

test("a 50-item vertical feed has unique ids, 9:16 thumbnails, and descending timestamps", () => {
  const feed = fixtures.createDeterministicVerticalFeed({
    count: fixtures.VERTICAL_STANDARD_SCENARIO_ITEM_COUNT,
  });

  assert.equal(feed.length, 50);
  assert.equal(new Set(feed.map((card) => card.muxAssetId)).size, 50);

  for (let index = 1; index < feed.length; index += 1) {
    assert.ok(
      feed[index].createdAtMs < feed[index - 1].createdAtMs,
      "createdAtMs must strictly descend so reordering is detectable",
    );
  }

  for (const card of feed) {
    assert.match(card.thumbnailUrl, /width=720&height=1280&fit_mode=smartcrop/);
  }
});

test("the vertical feed reuses the eight-field card contract", () => {
  const feed = fixtures.createDeterministicVerticalFeed({ count: 16 });
  assert.deepEqual(testFeed.findFeedCardContractViolations(feed), []);

  // Aspect ratio and placement are server-side selection inputs (section 10.3)
  // and must not be serialized into the card.
  for (const card of feed) {
    assert.equal("aspectRatio" in card, false);
    assert.equal("feedPlacement" in card, false);
  }
});

test("synthetic vertical playback ids are marked unplayable", () => {
  const feed = fixtures.createDeterministicVerticalFeed({ count: 3 });
  assert.ok(feed.every((card) => testFeed.isSyntheticPlaybackId(card.playbackId)));

  const real = fixtures.createDeterministicVerticalFeed({
    count: 3,
    playbackIds: ["real-one", "real-two"],
  });
  assert.ok(real.every((card) => !testFeed.isSyntheticPlaybackId(card.playbackId)));
});

/* ------------------------------------------------------------ placement audit */

function auditRow(id, feedPlacement, aspectRatio, overrides = {}) {
  return {
    muxAssetId: id,
    feedPlacement,
    aspectRatio,
    isReady: true,
    isDeleted: false,
    ...overrides,
  };
}

/**
 * The audit takes an injected classifier so it stays runtime-dependency-free
 * and so there is never a second production implementation of section 7.2. The
 * fixture oracle is what the unit suite injects; the Convex audit query will
 * inject the production classifier.
 */
const classify = (stored) => fixtures.normalizeAspectRatio(stored);

function distributionOf(rows) {
  return audit.summarizePlacementDistribution(rows, classify);
}

test("the audit module has no runtime imports", () => {
  // It claims to be safe to call from a Convex query. That claim is only true
  // if the compiled module pulls in nothing, so assert on the emitted output
  // rather than on the source.
  const source = readFileSync(
    new URL("../lib/vertical-video-feed-audit.ts", import.meta.url),
    "utf8",
  );
  const importLines = source
    .split("\n")
    .filter((line) => /^\s*import\s/.test(line));

  assert.equal(importLines.length, 1, "expected exactly one import");
  assert.match(
    importLines[0],
    /^import type /,
    "the only import must be type-only so it is erased at compile time",
  );
});

test("placement distribution counts only ready, non-deleted rows", () => {
  const distribution = distributionOf([
    auditRow("a", "vertical", "9:16"),
    auditRow("b", "standard", "16:9"),
    auditRow("c", "unknown", null),
    auditRow("d", "vertical", "9:16", { isDeleted: true }),
    auditRow("e", "unknown", null, { isReady: false }),
  ]);

  assert.equal(distribution.totalRows, 5);
  assert.equal(distribution.readyRows, 3);
  assert.deepEqual(distribution.readyByPlacement, {
    standard: 1,
    vertical: 1,
    unknown: 1,
  });
  assert.equal(distribution.readyUnknown, 1);
  assert.deepEqual(distribution.distinctAspectRatios, { "9:16": 1, "16:9": 1 });
});

test("a classified row with no stored ratio is an inconsistency, not a pass", () => {
  const distribution = distributionOf([auditRow("a", "vertical", null)]);
  assert.equal(distribution.readyClassifiedWithoutRatio, 1);
  assert.deepEqual(
    distribution.placementMismatches.map((mismatch) => mismatch.kind),
    ["placement_without_ratio"],
  );

  const gate = audit.evaluateClassificationCoverageGate(distribution);
  assert.equal(gate.status, "fail");
  assert.match(gate.detail, /placement re-derivation/);
});

test("stored placement is re-derived, not trusted", () => {
  // A classifier bug, a partial migration, or a hand-edited row must surface as
  // a mismatch rather than as a clean bill of health.
  const distribution = distributionOf([
    auditRow("wrong-way", "vertical", "16:9"),
    auditRow("also-wrong", "standard", "9:16"),
    auditRow("not-reduced", "vertical", "1080:1920"),
    auditRow("fine", "vertical", "9:16"),
  ]);

  const byId = Object.fromEntries(
    distribution.placementMismatches.map((mismatch) => [mismatch.muxAssetId, mismatch]),
  );

  assert.equal(distribution.placementMismatches.length, 3);
  assert.equal(byId["wrong-way"].kind, "placement_disagrees");
  assert.equal(byId["wrong-way"].derivedPlacement, "standard");
  assert.equal(byId["also-wrong"].kind, "placement_disagrees");
  assert.equal(byId["not-reduced"].kind, "ratio_not_reduced");
  assert.equal(byId["not-reduced"].derivedAspectRatio, "9:16");
  assert.equal("fine" in byId, false);

  assert.equal(
    audit.evaluateClassificationCoverageGate(distribution).status,
    "fail",
  );
});

test("an unparseable stored ratio fails even when the placement is unknown", () => {
  // Section 7.1 types the field as a *normalized* `string | null`. Storing the
  // junk that failed to parse violates that contract however honest the
  // placement is, so `unknown` must not launder it.
  const distribution = distributionOf([auditRow("junk", "unknown", "garbage")]);

  assert.deepEqual(
    distribution.placementMismatches.map((mismatch) => mismatch.kind),
    ["ratio_unparseable"],
  );

  const gate = audit.evaluateClassificationCoverageGate(distribution, [
    { muxAssetId: "junk", reason: "legacy row" },
  ]);
  assert.equal(
    gate.status,
    "fail",
    "a documented exception must not excuse a contract violation",
  );
  assert.match(gate.detail, /ratio_unparseable/);

  // The correct representation of the same asset passes.
  const nulled = distributionOf([auditRow("junk", "unknown", null)]);
  assert.deepEqual(nulled.placementMismatches, []);
  assert.equal(
    audit.evaluateClassificationCoverageGate(nulled, [
      { muxAssetId: "junk", reason: "Mux never returned a ratio for this legacy asset" },
    ]).status,
    "pass",
  );
});

test("duplicate ready asset ids fail the coverage gate", () => {
  const distribution = distributionOf([
    auditRow("a", "vertical", "9:16"),
    auditRow("a", "vertical", "9:16"),
    auditRow("b", "standard", "16:9"),
  ]);

  assert.deepEqual(distribution.duplicateAssetIds, ["a"]);
  const gate = audit.evaluateClassificationCoverageGate(distribution);
  assert.equal(gate.status, "fail");
  assert.match(gate.detail, /more than one ready row/);
});

test("an unscanned deployment reports unmeasured, never pass", () => {
  const gate = audit.evaluateClassificationCoverageGate(distributionOf([]));
  assert.equal(gate.status, "unmeasured");
  assert.notEqual(gate.status, "pass");
});

test("coverage passes at zero unknowns and fails on undocumented unknowns", () => {
  const clean = distributionOf([
    auditRow("a", "vertical", "9:16"),
    auditRow("b", "standard", "16:9"),
  ]);
  assert.equal(audit.evaluateClassificationCoverageGate(clean).status, "pass");

  const dirty = distributionOf([
    auditRow("a", "vertical", "9:16"),
    auditRow("b", "unknown", null),
  ]);
  assert.equal(audit.evaluateClassificationCoverageGate(dirty).status, "fail");

  const documented = audit.evaluateClassificationCoverageGate(dirty, [
    { muxAssetId: "b", reason: "Mux never returned an aspect ratio for this legacy asset" },
  ]);
  assert.equal(documented.status, "pass");
  assert.equal(documented.readyUnknown, 1);
  assert.deepEqual(documented.undocumentedUnknownAssetIds, []);
  assert.match(documented.detail, /still visible on legacy Home/);
});

test("exceptions must name the asset they excuse", () => {
  // Counting exceptions instead of matching them was the earlier bug: three
  // entries naming assets that do not exist would fully excuse three real
  // unknown rows nobody had looked at.
  const distribution = distributionOf([
    auditRow("real-unknown-1", "unknown", null),
    auditRow("real-unknown-2", "unknown", null),
  ]);

  const wrongIds = audit.evaluateClassificationCoverageGate(distribution, [
    { muxAssetId: "some-other-asset", reason: "checked, fine" },
    { muxAssetId: "another-ghost", reason: "checked, fine" },
  ]);

  assert.equal(wrongIds.status, "fail");
  assert.deepEqual(wrongIds.undocumentedUnknownAssetIds.sort(), [
    "real-unknown-1",
    "real-unknown-2",
  ]);
  assert.deepEqual(wrongIds.staleExceptionAssetIds.sort(), [
    "another-ghost",
    "some-other-asset",
  ]);
});

test("a duplicated exception id excuses one row, not two", () => {
  const distribution = distributionOf([
    auditRow("u1", "unknown", null),
    auditRow("u2", "unknown", null),
  ]);

  const gate = audit.evaluateClassificationCoverageGate(distribution, [
    { muxAssetId: "u1", reason: "legacy" },
    { muxAssetId: "u1", reason: "legacy again" },
  ]);

  assert.equal(gate.status, "fail");
  assert.deepEqual(gate.duplicateExceptionAssetIds, ["u1"]);
  assert.deepEqual(gate.undocumentedUnknownAssetIds, ["u2"]);
});

test("a stale exception is reported for pruning but does not fail the gate", () => {
  const distribution = distributionOf([
    auditRow("u1", "unknown", null),
    auditRow("now-classified", "vertical", "9:16"),
  ]);

  const gate = audit.evaluateClassificationCoverageGate(distribution, [
    { muxAssetId: "u1", reason: "legacy" },
    { muxAssetId: "now-classified", reason: "was unknown before the backfill" },
  ]);

  assert.equal(gate.status, "pass");
  assert.deepEqual(gate.staleExceptionAssetIds, ["now-classified"]);
  assert.match(gate.detail, /can be pruned/);
});

test("an empty exception reason does not document anything", () => {
  const dirty = distributionOf([auditRow("b", "unknown", null)]);

  for (const reason of ["", "   "]) {
    const gate = audit.evaluateClassificationCoverageGate(dirty, [
      { muxAssetId: "b", reason },
    ]);
    assert.equal(gate.status, "fail");
    assert.deepEqual(gate.undocumentedUnknownAssetIds, ["b"]);
  }
});

test("a feed returning the same asset twice fails, even without cross-feed overlap", () => {
  // Collapsing the inputs to Sets answers "is it in both feeds" but silently
  // erases "did one feed return it twice" — PRD section 12's duplicate/
  // cursor-lost metric, and the exact shape a paging bug takes.
  const result = audit.auditFeedExclusivity({
    homeAssetIds: ["a", "a", "b"],
    shortsAssetIds: ["c", "c"],
    eligibleAssetIds: ["a", "b", "c"],
    exclusivePlacementActive: true,
  });

  assert.equal(result.status, "fail");
  assert.deepEqual(result.repeatedWithinHome, ["a"]);
  assert.deepEqual(result.repeatedWithinShorts, ["c"]);
  assert.deepEqual(result.duplicated, [], "no asset is in both feeds");
  assert.match(result.detail, /more than once/);
});

test("a repeated eligible id makes the audit unsound and fails", () => {
  const result = audit.auditFeedExclusivity({
    homeAssetIds: ["a"],
    shortsAssetIds: [],
    eligibleAssetIds: ["a", "a"],
    exclusivePlacementActive: false,
  });

  assert.equal(result.status, "fail");
  assert.deepEqual(result.repeatedWithinEligible, ["a"]);
});

test("exclusivity tolerates migration duplicates but never an omission", () => {
  const duringMigration = audit.auditFeedExclusivity({
    homeAssetIds: ["a", "b"],
    shortsAssetIds: ["b"],
    eligibleAssetIds: ["a", "b"],
    exclusivePlacementActive: false,
  });
  assert.equal(duringMigration.status, "pass");
  assert.deepEqual(duringMigration.duplicated, ["b"]);

  const afterCutover = audit.auditFeedExclusivity({
    homeAssetIds: ["a", "b"],
    shortsAssetIds: ["b"],
    eligibleAssetIds: ["a", "b"],
    exclusivePlacementActive: true,
  });
  assert.equal(afterCutover.status, "fail");
  assert.match(afterCutover.detail, /both feeds/);

  const omitted = audit.auditFeedExclusivity({
    homeAssetIds: ["a"],
    shortsAssetIds: [],
    eligibleAssetIds: ["a", "b"],
    exclusivePlacementActive: false,
  });
  assert.equal(omitted.status, "fail");
  assert.deepEqual(omitted.omitted, ["b"]);
});

test("a feed returning an ineligible asset is a failure", () => {
  const result = audit.auditFeedExclusivity({
    homeAssetIds: ["a"],
    shortsAssetIds: ["ghost"],
    eligibleAssetIds: ["a"],
    exclusivePlacementActive: true,
  });
  assert.equal(result.status, "fail");
  assert.deepEqual(result.unexpected, ["ghost"]);
});

test("an exclusivity audit with no eligible assets is unmeasured", () => {
  const result = audit.auditFeedExclusivity({
    homeAssetIds: [],
    shortsAssetIds: [],
    eligibleAssetIds: [],
    exclusivePlacementActive: true,
  });
  assert.equal(result.status, "unmeasured");
});

test("backfill counters must account for every scanned row", () => {
  const balanced = audit.summarizeBackfillRun({
    scanned: 10,
    classified: 6,
    unknown: 2,
    unchanged: 1,
    failed: 1,
  });
  assert.equal(balanced.balanced, true);
  assert.equal(balanced.unaccounted, 0);

  const leaking = audit.summarizeBackfillRun({
    scanned: 10,
    classified: 4,
    unknown: 0,
    unchanged: 0,
    failed: 0,
  });
  assert.equal(leaking.balanced, false);
  assert.equal(leaking.unaccounted, 6);
});

test("a rerun over already-classified rows reports as idempotent", () => {
  const rerun = audit.summarizeBackfillRun({
    scanned: 10,
    classified: 0,
    unknown: 0,
    unchanged: 10,
    failed: 0,
  });
  assert.equal(rerun.idempotentRun, true);

  const firstRun = audit.summarizeBackfillRun({
    scanned: 10,
    classified: 10,
    unknown: 0,
    unchanged: 0,
    failed: 0,
  });
  assert.equal(firstRun.idempotentRun, false);
});

test("diagnostics combine distribution, coverage, exclusivity, and backfill", () => {
  const diagnostics = audit.buildPlacementDiagnostics({
    rows: [auditRow("a", "vertical", "9:16"), auditRow("b", "standard", "16:9")],
    classify,
    exclusivity: {
      homeAssetIds: ["b"],
      shortsAssetIds: ["a"],
      eligibleAssetIds: ["a", "b"],
      exclusivePlacementActive: true,
    },
    backfill: { scanned: 2, classified: 2, unknown: 0, unchanged: 0, failed: 0 },
  });

  assert.equal(diagnostics.coverage.status, "pass");
  assert.equal(diagnostics.exclusivity.status, "pass");
  assert.equal(diagnostics.backfill.balanced, true);

  const formatted = audit.formatPlacementDiagnostics(diagnostics);
  assert.match(formatted, /vertical=1/);
  assert.match(formatted, /coverage:  pass/);
  assert.match(formatted, /mismatches=0/);

  const unaudited = audit.buildPlacementDiagnostics({ rows: [], classify });
  assert.equal(unaudited.exclusivity, null);
  assert.match(audit.formatPlacementDiagnostics(unaudited), /backfill:  not run/);
});

test("the injected classifier is what the audit actually uses", () => {
  // Proves the audit is not quietly falling back to a classifier of its own.
  const alwaysVertical = () => ({ aspectRatio: "9:16", feedPlacement: "vertical" });
  const distribution = audit.summarizePlacementDistribution(
    [auditRow("a", "standard", "16:9")],
    alwaysVertical,
  );

  assert.deepEqual(
    distribution.placementMismatches.map((mismatch) => mismatch.kind),
    ["placement_disagrees"],
  );
  assert.equal(distribution.placementMismatches[0].derivedPlacement, "vertical");
});

/* --------------------------------------------------------------- telemetry */

const PRD_SHORTS_EVENTS = [
  "shorts_tab_opened",
  "shorts_page_impression",
  "shorts_manual_pause",
  "shorts_manual_resume",
  "shorts_muted",
  "shorts_unmuted",
  "shorts_retry_playback",
  "shorts_query_received",
  "shorts_empty_state_viewed",
];

test("the Shorts event vocabulary matches PRD section 13 exactly", () => {
  assert.deepEqual(
    [...events.SHORTS_PERFORMANCE_EVENT_NAMES].sort(),
    [...PRD_SHORTS_EVENTS].sort(),
  );
});

test("Shorts events extend the Home vocabulary without changing it", () => {
  // The Home contract is frozen at 20 events; Shorts adds 9 and the runtime
  // lifecycle pair adds 2, all alongside it.
  assert.equal(events.FEED_PERFORMANCE_EVENT_NAMES.length, 20);
  assert.equal(events.SHORTS_PERFORMANCE_EVENT_NAMES.length, 9);
  assert.equal(events.FEED_RUNTIME_EVENT_NAMES.length, 2);
  assert.equal(events.ALL_FEED_PERFORMANCE_EVENT_NAMES.length, 31);

  for (const name of events.FEED_PERFORMANCE_EVENT_NAMES) {
    assert.ok(events.ALL_FEED_PERFORMANCE_EVENT_NAMES.includes(name));
    assert.equal(events.isShortsPerformanceEventName(name), false);
  }
  for (const name of events.SHORTS_PERFORMANCE_EVENT_NAMES) {
    assert.equal(events.isFeedPerformanceEventName(name), true);
    assert.equal(events.isShortsPerformanceEventName(name), true);
  }

  assert.equal(
    new Set(events.ALL_FEED_PERFORMANCE_EVENT_NAMES).size,
    events.ALL_FEED_PERFORMANCE_EVENT_NAMES.length,
    "no event name is declared twice",
  );
  assert.equal(events.isFeedPerformanceEventName("shorts_not_a_real_event"), false);
});

test("lifecycle pause and player release actually reach the sink", () => {
  // `lib/feed/feed-telemetry.ts` has emitted these two names all along, but
  // `trackFeedEvent` only forwards an event that `isFeedPerformanceEventName`
  // recognizes — so both were being silently dropped, and the lifecycle and
  // release signals both PRDs promise to reuse never arrived.
  for (const name of ["feed_playback_paused", "feed_player_released"]) {
    assert.equal(
      events.isFeedPerformanceEventName(name),
      true,
      `${name} must be recognized or it is dropped before the sink`,
    );
    assert.ok(events.ALL_FEED_PERFORMANCE_EVENT_NAMES.includes(name));
    assert.equal(events.isShortsPerformanceEventName(name), false);
  }

  const seen = [];
  events.setFeedPerformanceSink((event) => seen.push(event));

  events.emitFeedPerformanceEvent(events.FEED_RUNTIME_EVENTS.feedPlaybackPaused, {
    screen: "shorts",
    mux_asset_id: "asset-1",
  });
  events.emitFeedPerformanceEvent(events.FEED_RUNTIME_EVENTS.feedPlayerReleased, {
    screen: "home_feed",
  });

  assert.deepEqual(seen, [
    { name: "feed_playback_paused", fields: { screen: "shorts", mux_asset_id: "asset-1" } },
    { name: "feed_player_released", fields: { screen: "home_feed" } },
  ]);

  events.setFeedPerformanceSink(null);
});

test("the runtime telemetry layer's event names are all recognized", () => {
  // Guards against the same gap reopening: every name the runtime layer can
  // emit must survive the isFeedPerformanceEventName filter.
  const runtimeSource = readFileSync(
    new URL("../lib/feed/feed-telemetry.ts", import.meta.url),
    "utf8",
  );
  const declaration = runtimeSource.slice(
    runtimeSource.indexOf("export type FeedTelemetryEventName"),
    runtimeSource.indexOf(";", runtimeSource.indexOf("export type FeedTelemetryEventName")),
  );
  const names = [...declaration.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);

  assert.ok(names.length >= 22, `expected the full runtime union, parsed ${names.length}`);
  const unrecognized = names.filter((name) => !events.isFeedPerformanceEventName(name));
  assert.deepEqual(
    unrecognized,
    [],
    "these runtime events would be dropped before reaching the sink",
  );
});

test("shorts is a recognized screen and Home screens still resolve", () => {
  assert.ok(events.FEED_SCREENS.includes("shorts"));
  for (const screen of ["home_feed", "shorts", "search_results", "profile", "video_detail"]) {
    assert.equal(
      events.sanitizeFeedEventFields({ screen }).fields.screen,
      screen,
      `${screen} must survive sanitization`,
    );
  }
  assert.equal(
    "screen" in events.sanitizeFeedEventFields({ screen: "shorts_feed" }).fields,
    false,
  );
});

test("Shorts extension fields are accepted with the right shapes", () => {
  const result = events.sanitizeFeedEventFields({
    screen: "shorts",
    feed_placement: "vertical",
    item_count: 16,
    is_muted: true,
    retry_attempt: 2,
    empty_reason: "no_vertical_assets",
    page_height_dp: 812.4,
    query_outcome: "error",
  });

  assert.deepEqual(result.fields, {
    screen: "shorts",
    feed_placement: "vertical",
    item_count: 16,
    is_muted: true,
    retry_attempt: 2,
    empty_reason: "no_vertical_assets",
    page_height_dp: 812,
    query_outcome: "error",
  });
  assert.deepEqual(result.droppedKeys, []);
  assert.deepEqual(result.redactedKeys, []);
});

test("Shorts extension fields reject out-of-domain values", () => {
  const rejected = events.sanitizeFeedEventFields({
    feed_placement: "portrait",
    empty_reason: "because",
    item_count: -1,
    retry_attempt: 1.5,
    page_height_dp: 99999,
    is_muted: "yes",
    query_outcome: "failed",
  });

  assert.deepEqual(rejected.fields, {});
  assert.equal(rejected.redactedKeys.length, 7);
});

test("a query failure is reported on the query event, not as a playback error", () => {
  const seen = [];
  events.setFeedPerformanceSink((event) => seen.push(event));

  events.emitFeedPerformanceEvent(events.SHORTS_PERFORMANCE_EVENTS.shortsQueryReceived, {
    screen: "shorts",
    query_outcome: "error",
    error_code: "CONVEX_QUERY_TIMEOUT",
    item_count: 0,
  });

  assert.deepEqual(seen, [
    {
      name: "shorts_query_received",
      fields: {
        screen: "shorts",
        query_outcome: "error",
        error_code: "CONVEX_QUERY_TIMEOUT",
        item_count: 0,
      },
    },
  ]);

  events.setFeedPerformanceSink(null);
  assert.deepEqual([...events.SHORTS_QUERY_OUTCOMES], ["success", "error"]);
});

test("the Shorts vocabulary adds no new privacy surface", () => {
  // Same forbidden material, now arriving under Shorts field names.
  const result = events.sanitizeFeedEventFields({
    empty_reason: "https://stream.mux.com/abc.m3u8",
    feed_placement: "Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
    item_count: "the full transcript of the video",
    shorts_playback_url: "https://stream.mux.com/abc.m3u8",
    shorts_title: "a user-provided title",
  });

  assert.deepEqual(result.fields, {});
  assert.deepEqual(result.droppedKeys.sort(), ["shorts_playback_url", "shorts_title"]);
});

test("Shorts events emit through the shared sanitized sink", () => {
  const seen = [];
  events.setFeedPerformanceSink((event) => seen.push(event));

  events.emitFeedPerformanceEvent(events.SHORTS_PERFORMANCE_EVENTS.shortsQueryReceived, {
    screen: "shorts",
    item_count: 16,
    elapsed_ms: 120.6,
    playback_url: "https://stream.mux.com/abc.m3u8",
  });

  assert.deepEqual(seen, [
    {
      name: "shorts_query_received",
      fields: { screen: "shorts", item_count: 16, elapsed_ms: 121 },
    },
  ]);

  events.setFeedPerformanceSink(null);
});

test("the allowlist is the union of the Home and Shorts field sets", () => {
  assert.deepEqual(
    [...events.ALL_FEED_EVENT_ALLOWED_FIELDS].sort(),
    [...events.FEED_EVENT_ALLOWED_FIELDS, ...events.SHORTS_EVENT_ALLOWED_FIELDS].sort(),
  );
  assert.equal(
    new Set(events.ALL_FEED_EVENT_ALLOWED_FIELDS).size,
    events.ALL_FEED_EVENT_ALLOWED_FIELDS.length,
    "no field is declared in both sets",
  );
});

/* ------------------------------------------------------------------- flags */

const IOS = { platform: "ios", preloadKillSwitchEngaged: false };

test("both vertical flags exist, default off, and document their rollout metadata", () => {
  const resolved = flags.resolveFeedFeatureFlags(IOS);

  for (const key of ["shortsTabEnabled", "exclusiveFeedPlacementEnabled"]) {
    assert.ok(flags.isFeedFeatureFlagKey(key));
    assert.equal(resolved[key].enabled, false, `${key} must default off`);
    assert.equal(resolved[key].source, "default");

    const definition = flags.FEED_FEATURE_FLAGS[key];
    assert.ok(definition.owner.length > 0, `${key} needs an owner`);
    assert.match(definition.removalDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(definition.rollbackNote.length > 0, `${key} needs a rollback note`);
    assert.match(definition.phase, /Phase 7/);
  }
});

test("adding the vertical flags did not disturb the news-feed flags", () => {
  const resolved = flags.resolveFeedFeatureFlags(IOS);
  for (const key of flags.FEED_FEATURE_FLAG_KEYS) {
    assert.equal(resolved[key].enabled, false, `${key} must default off`);
  }
  assert.equal(flags.FEED_FEATURE_FLAG_KEYS.length, 6);
  assert.deepEqual(flags.findExpiredFeedFeatureFlags("2026-01-01"), []);
});

test("the Shorts tab honors the Android physical-validation gate", () => {
  const android = {
    platform: "android",
    preloadKillSwitchEngaged: false,
    remote: { shortsTabEnabled: true, exclusiveFeedPlacementEnabled: true },
  };

  const gated = flags.resolveFeedFeatureFlags(android);
  assert.equal(gated.shortsTabEnabled.enabled, false);
  assert.equal(gated.shortsTabEnabled.source, "android_validation_gate");

  // The Android gate turns the tab off *after* exclusive placement has already
  // resolved on. Without the dependency gate this is precisely the state that
  // hides exact 9:16 assets from both feeds on every Android install.
  assert.equal(
    gated.exclusiveFeedPlacementEnabled.enabled,
    false,
    "exclusive placement cannot survive the tab being gated off",
  );
  assert.equal(gated.exclusiveFeedPlacementEnabled.source, "dependency_gate");

  const validated = flags.resolveFeedFeatureFlags({
    ...android,
    androidPhysicalValidationCompleted: true,
  });
  assert.equal(validated.shortsTabEnabled.enabled, true);
  assert.equal(validated.exclusiveFeedPlacementEnabled.enabled, true);

  const ios = flags.resolveFeedFeatureFlags({
    ...IOS,
    remote: { shortsTabEnabled: true },
  });
  assert.equal(ios.shortsTabEnabled.enabled, true, "iOS ramps independently");
});

test("exclusive placement resolves false whenever the Shorts tab is off", () => {
  // Every route to "tab off" must drag exclusive placement off with it, no
  // matter which resolution step turned the tab off or how strong the lever
  // that turned exclusive placement on was.
  const cases = [
    ["tab never enabled", { ...IOS, remote: { exclusiveFeedPlacementEnabled: true } }],
    [
      "tab disabled remotely",
      {
        ...IOS,
        remote: { shortsTabEnabled: false, exclusiveFeedPlacementEnabled: true },
      },
    ],
    [
      "tab overridden off locally",
      {
        ...IOS,
        remote: { shortsTabEnabled: true, exclusiveFeedPlacementEnabled: true },
        overrides: { shortsTabEnabled: false },
      },
    ],
    [
      "exclusive forced on by a local override",
      { ...IOS, overrides: { exclusiveFeedPlacementEnabled: true } },
    ],
    [
      "tab rollout resolves off for lack of a stable id",
      {
        ...IOS,
        rollout: { shortsTabEnabled: { ios: { percent: 100 } } },
        remote: { exclusiveFeedPlacementEnabled: true },
      },
    ],
    [
      // A developer override would legitimately outrank the Android gate, so
      // this case has to come through remote config to exercise the gate.
      "tab gated off on Android",
      {
        platform: "android",
        preloadKillSwitchEngaged: false,
        remote: { shortsTabEnabled: true, exclusiveFeedPlacementEnabled: true },
      },
    ],
    [
      "exclusive overridden on while the tab is gated off on Android",
      {
        platform: "android",
        preloadKillSwitchEngaged: false,
        remote: { shortsTabEnabled: true },
        overrides: { exclusiveFeedPlacementEnabled: true },
      },
    ],
  ];

  for (const [label, context] of cases) {
    const resolved = flags.resolveFeedFeatureFlags(context);
    assert.equal(resolved.shortsTabEnabled.enabled, false, `${label}: tab should be off`);
    assert.equal(
      resolved.exclusiveFeedPlacementEnabled.enabled,
      false,
      `${label}: exclusive placement must follow the tab off`,
    );
    assert.equal(
      flags.isFeedFeatureEnabled("exclusiveFeedPlacementEnabled", context),
      false,
      `${label}: the convenience reader must agree`,
    );
    assert.deepEqual(
      flags.findFlagCombinationViolations(resolved),
      [],
      `${label}: the resolver already made the illegal state unreachable`,
    );
  }
});

test("the dependency gate is declared as data, not hardcoded in one branch", () => {
  assert.equal(
    flags.FEED_FLAG_DEPENDENCIES.exclusiveFeedPlacementEnabled.requires,
    "shortsTabEnabled",
  );
  assert.match(
    flags.FEED_FLAG_DEPENDENCIES.exclusiveFeedPlacementEnabled.because,
    /neither feed/,
  );
});

test("the combination check still names a hand-built illegal state", () => {
  // resolveFeedFeatureFlags can no longer produce this, but a config preview
  // screen or a test fixture can, so the invariant stays named.
  const handBuilt = {
    ...flags.resolveFeedFeatureFlags(IOS),
    exclusiveFeedPlacementEnabled: {
      key: "exclusiveFeedPlacementEnabled",
      enabled: true,
      source: "override",
      reason: "hand-built",
    },
  };

  const violations = flags.findFlagCombinationViolations(handBuilt);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /requires shortsTabEnabled/);
  assert.match(violations[0], /neither feed/);
});

test("a remote false outranks a percentage rollout that is still configured", () => {
  // The dangerous shape: an operator switches something off remotely while a
  // stale rollout percentage sits in config. Rollout used to run after remote
  // and would quietly switch it back on.
  const resolved = flags.resolveFeedFeatureFlags({
    ...IOS,
    stableId: "install-1",
    remote: { shortsTabEnabled: false },
    rollout: { shortsTabEnabled: { ios: { percent: 100 } } },
  });

  assert.equal(resolved.shortsTabEnabled.enabled, false);
  assert.equal(resolved.shortsTabEnabled.source, "remote");
  assert.match(resolved.shortsTabEnabled.reason, /rollout ignored/);
});

test("remote false is authoritative for every flag, not just the vertical ones", () => {
  for (const key of flags.FEED_FEATURE_FLAG_KEYS) {
    const resolved = flags.resolveFeedFeatureFlags({
      ...IOS,
      stableId: "install-1",
      remote: { [key]: false },
      rollout: { [key]: { ios: { percent: 100 } } },
    });
    assert.equal(resolved[key].enabled, false, `${key} must stay off`);
    assert.equal(resolved[key].source, "remote");
  }
});

test("remote true still lets a percentage rollout narrow exposure", () => {
  const resolved = flags.resolveFeedFeatureFlags({
    ...IOS,
    stableId: "install-1",
    remote: { shortsTabEnabled: true },
    rollout: { shortsTabEnabled: { ios: { percent: 0 } } },
  });

  assert.equal(resolved.shortsTabEnabled.enabled, false);
  assert.equal(resolved.shortsTabEnabled.source, "rollout");
});

test("the preload kill switch does not take away the Shorts tab", () => {
  const resolved = flags.resolveFeedFeatureFlags({
    platform: "ios",
    remote: { shortsTabEnabled: true },
    preloadKillSwitchEngaged: true,
  });
  assert.equal(
    resolved.shortsTabEnabled.enabled,
    true,
    "relieving preload pressure is not a reason to remove a tab",
  );
});

test("Shorts cohort bucketing is stable and independent of the other flags", () => {
  assert.equal(
    flags.rolloutBucket("shortsTabEnabled", "install-1"),
    flags.rolloutBucket("shortsTabEnabled", "install-1"),
  );
  assert.notEqual(
    flags.rolloutBucket("shortsTabEnabled", "install-1"),
    flags.rolloutBucket("exclusiveFeedPlacementEnabled", "install-1"),
  );

  const resolved = flags.resolveFeedFeatureFlags({
    ...IOS,
    stableId: "install-1",
    rollout: { shortsTabEnabled: { ios: { percent: 100 } } },
  });
  assert.equal(resolved.shortsTabEnabled.enabled, true);
  assert.equal(resolved.shortsTabEnabled.source, "rollout");

  const noStableId = flags.resolveFeedFeatureFlags({
    ...IOS,
    rollout: { shortsTabEnabled: { ios: { percent: 100 } } },
  });
  assert.equal(noStableId.shortsTabEnabled.enabled, false);
});

test("legal vertical-flag combinations report no violation", () => {
  const both = flags.resolveFeedFeatureFlags({
    ...IOS,
    overrides: { shortsTabEnabled: true, exclusiveFeedPlacementEnabled: true },
  });
  assert.equal(both.exclusiveFeedPlacementEnabled.enabled, true);
  assert.deepEqual(flags.findFlagCombinationViolations(both), []);

  const shortsOnly = flags.resolveFeedFeatureFlags({
    ...IOS,
    overrides: { shortsTabEnabled: true },
  });
  assert.deepEqual(flags.findFlagCombinationViolations(shortsOnly), []);
});

/* ----------------------------------------------------------------- rollout */

test("the cohort ladder matches the PRD order and is fully linked", () => {
  assert.deepEqual(
    rollout.SHORTS_COHORT_STAGES.map((stage) => stage.id),
    ["team", "internal-beta", "production-small", "staged-increase", "full"],
  );

  let stage = rollout.getShortsCohortStage("team");
  const walked = [];
  while (stage) {
    walked.push(stage.id);
    assert.ok(stage.minObservationHours > 0, `${stage.id} needs an observation window`);
    assert.ok(stage.exitCriteria.length > 0, `${stage.id} needs exit criteria`);
    stage = rollout.getNextShortsCohortStage(stage.id);
  }

  assert.equal(walked.length, 5, "every stage is reachable from the first");
  assert.equal(rollout.getShortsCohortStage("full").nextStageId, null);
  assert.equal(rollout.getNextShortsCohortStage("full"), undefined);
});

test("percentage stages only increase", () => {
  const percents = rollout.SHORTS_COHORT_STAGES.map((stage) => stage.percent).filter(
    (percent) => percent !== null,
  );
  const sorted = [...percents].sort((a, b) => a - b);
  assert.deepEqual(percents, sorted);
  assert.equal(percents[percents.length - 1], 100);
});

test("rollback disables the tab first and leaves no unreachable window", () => {
  const both = flags.resolveFeedFeatureFlags({
    ...IOS,
    overrides: { shortsTabEnabled: true, exclusiveFeedPlacementEnabled: true },
  });

  const plan = rollout.buildShortsRollbackPlan(both);
  assert.deepEqual(
    plan.steps.map((step) => step.flagKey),
    ["shortsTabEnabled", "exclusiveFeedPlacementEnabled"],
  );
  assert.deepEqual(plan.steps.map((step) => step.order), [1, 2]);

  // Home is permanently standard-only, so the tab kill switch has an explicit
  // availability cost even though the legacy dependency gate also resolves the
  // exclusive-placement flag off.
  assert.equal(plan.hasUnreachableWindow, true);
  assert.ok(plan.steps.every((step) => step.leavesVerticalAssetsUnreachable));

  const afterStepOne = flags.resolveFeedFeatureFlags({
    ...IOS,
    overrides: { shortsTabEnabled: false, exclusiveFeedPlacementEnabled: true },
  });
  assert.equal(afterStepOne.exclusiveFeedPlacementEnabled.enabled, false);
  assert.match(plan.summary, /temporary 9:16 unavailability/);
});

test("rolling back the tab alone makes Shorts-only assets unavailable", () => {
  const shortsOnly = flags.resolveFeedFeatureFlags({
    ...IOS,
    overrides: { shortsTabEnabled: true },
  });

  const plan = rollout.buildShortsRollbackPlan(shortsOnly);
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.hasUnreachableWindow, true);
  assert.equal(plan.steps[0].leavesVerticalAssetsUnreachable, true);
});

test("a fully rolled-back state has an empty plan", () => {
  const plan = rollout.buildShortsRollbackPlan(flags.resolveFeedFeatureFlags(IOS));
  assert.deepEqual(plan.steps, []);
  assert.equal(plan.hasUnreachableWindow, false);
  assert.match(plan.summary, /nothing to roll back/);
});

const HEALTHY_METRICS = {
  emptyStateRateRatio: 0.05,
  queryErrorRateRatio: 0.001,
  classificationUnknownCount: 0,
  playerInvariantViolationCount: 0,
  feedOmissionCount: 0,
};

test("rollout guards report unmeasured rather than passing on no data", () => {
  const nothing = rollout.evaluateShortsRolloutGuards({});
  assert.equal(nothing.status, "unmeasured");
  assert.equal(nothing.shouldPauseRollout, false);
  assert.equal(nothing.unmeasuredMetrics.length, 5);

  const healthy = rollout.evaluateShortsRolloutGuards(HEALTHY_METRICS);
  assert.equal(healthy.status, "pass");
  assert.deepEqual(healthy.unmeasuredMetrics, []);
  assert.deepEqual(healthy.invalidMetrics, []);
  assert.deepEqual(healthy.invalidThresholds, []);
});

test("unusable metric values fail rather than quietly reading as unmeasured", () => {
  const cases = [
    ["emptyStateRateRatio", Number.NaN],
    ["emptyStateRateRatio", Number.POSITIVE_INFINITY],
    ["emptyStateRateRatio", -0.1],
    ["emptyStateRateRatio", 1.5],
    ["queryErrorRateRatio", Number.NaN],
    ["feedOmissionCount", -1],
    ["feedOmissionCount", Number.NaN],
    ["feedOmissionCount", 1.5],
    ["playerInvariantViolationCount", Number.NEGATIVE_INFINITY],
    ["classificationUnknownCount", Number.NaN],
  ];

  for (const [key, value] of cases) {
    const decision = rollout.evaluateShortsRolloutGuards({
      ...HEALTHY_METRICS,
      [key]: value,
    });
    assert.equal(decision.status, "fail", `${key}=${value} must fail`);
    assert.equal(decision.shouldPauseRollout, true, `${key}=${value} must pause`);
    assert.equal(decision.invalidMetrics.length, 1, `${key}=${value} invalid list`);
    assert.equal(
      decision.shouldRollBackImmediately,
      false,
      "garbage input is a reason to stop and look, not a confirmed catastrophe",
    );
  }
});

test("an unusable threshold cannot hide a real breach", () => {
  // `anything > NaN` is false, so a NaN limit would make its metric incapable
  // of ever breaching. That must fail loudly rather than report a pass.
  const decision = rollout.evaluateShortsRolloutGuards(
    { ...HEALTHY_METRICS, feedOmissionCount: 500 },
    { ...rollout.DEFAULT_SHORTS_ROLLOUT_THRESHOLDS, maxFeedOmissionCount: Number.NaN },
  );

  assert.equal(decision.status, "fail");
  assert.equal(decision.shouldPauseRollout, true);
  assert.deepEqual(decision.invalidThresholds, ["feed_omissions"]);
  assert.deepEqual(
    decision.breachedMetrics,
    [],
    "the metric was never judged, so it is not reported as a breach",
  );
});

test("thresholds are range- and shape-checked per metric kind", () => {
  const bad = [
    ["maxEmptyStateRateRatio", 1.5, "empty_state_rate"],
    ["maxQueryErrorRateRatio", -0.1, "query_error_rate"],
    ["maxQueryErrorRateRatio", Number.POSITIVE_INFINITY, "query_error_rate"],
    ["maxFeedOmissionCount", 0.5, "feed_omissions"],
    ["maxClassificationUnknownCount", -1, "classification_unknown"],
    ["maxPlayerInvariantViolationCount", Number.NaN, "player_invariant_violations"],
  ];

  for (const [thresholdKey, value, metricName] of bad) {
    const decision = rollout.evaluateShortsRolloutGuards(HEALTHY_METRICS, {
      ...rollout.DEFAULT_SHORTS_ROLLOUT_THRESHOLDS,
      [thresholdKey]: value,
    });
    assert.deepEqual(
      decision.invalidThresholds,
      [metricName],
      `${thresholdKey}=${value} must be rejected`,
    );
    assert.equal(decision.status, "fail");
  }
});

test("the shipped default thresholds are themselves usable", () => {
  const decision = rollout.evaluateShortsRolloutGuards(HEALTHY_METRICS);
  assert.deepEqual(decision.invalidThresholds, []);
  assert.equal(decision.status, "pass");
});

test("cohort exit criteria are structured objects, not free strings", () => {
  for (const stage of rollout.SHORTS_COHORT_STAGES) {
    for (const criterion of stage.exitCriteria) {
      assert.equal(typeof criterion, "object");
      assert.equal(typeof criterion.id, "string");
    }
  }
});

test("omissions and invariant breaches escalate past pause to rollback", () => {
  const omission = rollout.evaluateShortsRolloutGuards({ feedOmissionCount: 1 });
  assert.equal(omission.shouldPauseRollout, true);
  assert.equal(omission.shouldRollBackImmediately, true);

  const invariant = rollout.evaluateShortsRolloutGuards({
    playerInvariantViolationCount: 1,
  });
  assert.equal(invariant.shouldRollBackImmediately, true);

  const empties = rollout.evaluateShortsRolloutGuards({ emptyStateRateRatio: 0.9 });
  assert.equal(empties.shouldPauseRollout, true);
  assert.equal(
    empties.shouldRollBackImmediately,
    false,
    "an empty feed is a pause, not an emergency",
  );
});

/** Every exit criterion for a stage, attested met with an evidence note. */
function attestAll(stageId, overrides = {}) {
  const stage = rollout.getShortsCohortStage(stageId);
  const attestations = {};
  for (const criterion of stage.exitCriteria) {
    attestations[criterion.id] = { met: true, note: `evidence for ${criterion.id}` };
  }
  return { ...attestations, ...overrides };
}

test("cohort readiness needs a served window, measured metrics, and attested criteria", () => {
  const ready = rollout.evaluateCohortReadiness({
    stageId: "production-small",
    observedHours: 48,
    metrics: HEALTHY_METRICS,
    criterionAttestations: attestAll("production-small"),
  });
  assert.equal(ready.status, "ready");
  assert.equal(ready.nextStageId, "staged-increase");
  assert.deepEqual(ready.failedCriteria, []);
  assert.deepEqual(ready.unattestedCriteria, []);

  const tooSoon = rollout.evaluateCohortReadiness({
    stageId: "production-small",
    observedHours: 4,
    metrics: HEALTHY_METRICS,
    criterionAttestations: attestAll("production-small"),
  });
  assert.equal(tooSoon.status, "blocked");
  assert.match(tooSoon.reasons.join(" "), /Observed 4h/);

  const unmonitored = rollout.evaluateCohortReadiness({
    stageId: "production-small",
    observedHours: 48,
    criterionAttestations: attestAll("production-small"),
  });
  assert.equal(unmonitored.status, "unmeasured");

  const partial = rollout.evaluateCohortReadiness({
    stageId: "production-small",
    observedHours: 48,
    metrics: { feedOmissionCount: 0 },
    criterionAttestations: attestAll("production-small"),
  });
  assert.equal(partial.status, "unmeasured");

  assert.equal(rollout.evaluateCohortReadiness({ stageId: "nope" }).status, "blocked");
});

test("no stage reports ready without evidence for every exit criterion", () => {
  // Metrics cover first frame, buffering, errors, unknowns, and omissions —
  // but not "the Home regression checklist passed" or "migration code has a
  // removal owner". Those need an attestation or the stage cannot advance.
  for (const stage of rollout.SHORTS_COHORT_STAGES) {
    const base = {
      stageId: stage.id,
      observedHours: stage.minObservationHours,
      metrics: HEALTHY_METRICS,
    };

    assert.equal(
      rollout.evaluateCohortReadiness(base).status,
      "unmeasured",
      `${stage.id} must not be ready with no attestations`,
    );

    assert.equal(
      rollout.evaluateCohortReadiness({
        ...base,
        criterionAttestations: attestAll(stage.id),
      }).status,
      "ready",
      `${stage.id} should be ready once everything is attested`,
    );

    for (const criterion of stage.exitCriteria) {
      const missing = rollout.evaluateCohortReadiness({
        ...base,
        criterionAttestations: Object.fromEntries(
          Object.entries(attestAll(stage.id)).filter(([id]) => id !== criterion.id),
        ),
      });
      assert.equal(
        missing.status,
        "unmeasured",
        `${stage.id} must not be ready without ${criterion.id}`,
      );
      assert.deepEqual(missing.unattestedCriteria, [criterion.id]);

      const notMet = rollout.evaluateCohortReadiness({
        ...base,
        criterionAttestations: attestAll(stage.id, {
          [criterion.id]: { met: false, note: "checklist failed" },
        }),
      });
      assert.equal(notMet.status, "blocked", `${criterion.id} attested false blocks`);
      assert.deepEqual(notMet.failedCriteria, [criterion.id]);
    }
  }
});

test("an attestation with no evidence note is not evidence", () => {
  for (const note of [undefined, "", "   "]) {
    const readiness = rollout.evaluateCohortReadiness({
      stageId: "team",
      observedHours: 24,
      metrics: HEALTHY_METRICS,
      criterionAttestations: attestAll("team", {
        "team-acceptance": { met: true, note },
      }),
    });
    assert.equal(readiness.status, "unmeasured");
    assert.deepEqual(readiness.unattestedCriteria, ["team-acceptance"]);
  }
});

test("missing observation time is unmeasured; an unusable one is blocked", () => {
  const attested = attestAll("team");

  const missing = rollout.evaluateCohortReadiness({
    stageId: "team",
    metrics: HEALTHY_METRICS,
    criterionAttestations: attested,
  });
  assert.equal(missing.status, "unmeasured", "absent evidence is not a refusal");
  assert.match(missing.reasons.join(" "), /Observation time was not supplied/);

  for (const observedHours of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    const unusable = rollout.evaluateCohortReadiness({
      stageId: "team",
      observedHours,
      metrics: HEALTHY_METRICS,
      criterionAttestations: attested,
    });
    assert.equal(unusable.status, "blocked", `${observedHours} must block`);
    assert.match(unusable.reasons.join(" "), /not a usable duration/);
  }
});

test("readiness is fail-closed: it never reports ready on partial evidence", () => {
  const partialInputs = [
    {},
    { observedHours: 48 },
    { metrics: HEALTHY_METRICS },
    { criterionAttestations: attestAll("production-small") },
    { observedHours: 48, metrics: HEALTHY_METRICS },
    { observedHours: 48, criterionAttestations: attestAll("production-small") },
    { metrics: HEALTHY_METRICS, criterionAttestations: attestAll("production-small") },
  ];

  for (const input of partialInputs) {
    const readiness = rollout.evaluateCohortReadiness({
      stageId: "production-small",
      ...input,
    });
    assert.notEqual(
      readiness.status,
      "ready",
      `partial input ${JSON.stringify(Object.keys(input))} must not be ready`,
    );
  }
});

test("an unusable threshold blocks a cohort that would otherwise be ready", () => {
  const readiness = rollout.evaluateCohortReadiness({
    stageId: "production-small",
    observedHours: 48,
    metrics: HEALTHY_METRICS,
    criterionAttestations: attestAll("production-small"),
    thresholds: {
      ...rollout.DEFAULT_SHORTS_ROLLOUT_THRESHOLDS,
      maxQueryErrorRateRatio: Number.NaN,
    },
  });

  assert.equal(readiness.status, "blocked");
  assert.match(readiness.reasons.join(" "), /Unusable threshold/);
});

test("every exit criterion has a unique id and a judgeable evidence kind", () => {
  const ids = rollout.SHORTS_COHORT_STAGES.flatMap((stage) =>
    stage.exitCriteria.map((criterion) => criterion.id),
  );
  assert.equal(new Set(ids).size, ids.length, "duplicate exit-criterion id");

  for (const stage of rollout.SHORTS_COHORT_STAGES) {
    for (const criterion of stage.exitCriteria) {
      assert.ok(criterion.statement.length > 0, `${criterion.id} needs a statement`);
      assert.ok(["instrumented", "observed", "automated"].includes(criterion.evidence));
    }
  }

  // The gates the review called out explicitly must actually be present.
  const statements = rollout.SHORTS_COHORT_STAGES.flatMap((stage) =>
    stage.exitCriteria.map((criterion) => criterion.statement.toLowerCase()),
  ).join(" | ");
  for (const topic of [
    "first-frame",
    "buffering",
    "playback error",
    "home regression",
    "exclusivity audit",
    "removal date",
  ]) {
    assert.ok(statements.includes(topic), `no exit criterion covers "${topic}"`);
  }
});

test("exclusive placement is gated on the final Shorts stage", () => {
  assert.equal(rollout.EXCLUSIVE_PLACEMENT_PREREQUISITE_STAGE_ID, "full");
  assert.ok(
    rollout.getShortsCohortStage(rollout.EXCLUSIVE_PLACEMENT_PREREQUISITE_STAGE_ID),
  );
});

/* -------------------------------------------------------------- scenarios */

test("every PRD Phase 6 scenario is defined", () => {
  const required = [
    "shorts-cold-launch",
    "shorts-warm-launch",
    "shorts-slow-swipe",
    "shorts-fast-fling",
    "shorts-reverse-fling",
    "shorts-pagination",
    "shorts-tab-switch",
    "shorts-lifecycle",
    "shorts-rotation",
    "shorts-offline",
    "shorts-recovery",
    "shorts-50-item-memory",
  ];

  assert.deepEqual(
    scenarios.SHORTS_SCENARIOS.map((scenario) => scenario.id),
    required,
  );

  for (const scenario of scenarios.SHORTS_SCENARIOS) {
    assert.ok(scenario.steps.length > 0, `${scenario.id} needs steps`);
    assert.ok(scenario.gates.length > 0, `${scenario.id} needs a gate`);
    assert.ok(scenario.observations.length > 0, `${scenario.id} needs observations`);
    assert.ok(scenario.prdReference.length > 0, `${scenario.id} needs a PRD reference`);
  }
});

test("the memory scenario uses the standard 50-item length", () => {
  const memory = scenarios.getShortsScenario("shorts-50-item-memory");
  assert.equal(scenarios.VERTICAL_STANDARD_SCENARIO_ITEM_COUNT, 50);
  assert.match(memory.label, /50-item/);
  assert.ok(memory.captures.includes("memory"));
});

test("no simulator or emulator cell claims a performance measurement", () => {
  const cells = scenarios.buildShortsRunMatrix(
    scenarios.FEED_DEVICE_PROFILES.map((profile) => profile.id),
  );

  assert.ok(cells.length > 0);
  for (const cell of cells) {
    const profile = scenarios.getDeviceProfile(cell.profileId);
    if (profile.kind !== "physical") {
      assert.equal(
        cell.functionalOnly,
        true,
        `${cell.scenarioId} on ${cell.profileId} must be functional-only`,
      );
    }
  }

  assert.deepEqual(scenarios.buildShortsRunMatrix(["does-not-exist"]), []);
});

test("a physical-only scenario on a simulator is marked functional-only", () => {
  const cells = scenarios.buildShortsRunMatrix(
    ["ios-simulator-functional"],
    ["shorts-50-item-memory"],
    ["warm-cache"],
  );
  assert.equal(cells.length, 1);
  assert.equal(cells[0].functionalOnly, true);
});

test("the checklists cover acceptance, Home regression, and accessibility", () => {
  assert.ok(scenarios.SHORTS_ACCEPTANCE_CHECKLIST.length >= 9);
  assert.ok(scenarios.HOME_REGRESSION_CHECKLIST.length >= 8);
  assert.ok(scenarios.SHORTS_ACCESSIBILITY_CHECKLIST.length >= 5);

  const all = [
    ...scenarios.SHORTS_ACCEPTANCE_CHECKLIST,
    ...scenarios.HOME_REGRESSION_CHECKLIST,
    ...scenarios.SHORTS_ACCESSIBILITY_CHECKLIST,
  ];
  assert.equal(new Set(all.map((item) => item.id)).size, all.length, "duplicate id");

  for (const item of all) {
    assert.ok(item.statement.length > 0);
    assert.ok(item.prdReference.length > 0);
    assert.ok(["instrumented", "observed", "automated"].includes(item.evidence));
  }
});

/* ------------------------------------------------------------- dashboards */

test("every PRD Phase 7 dashboard subject has a panel", () => {
  const required = [
    "shorts-tab-opens",
    "shorts-query-errors",
    "shorts-empty-rate",
    "shorts-first-frame",
    "shorts-buffering",
    "shorts-playback-errors",
    "shorts-classification-unknowns",
    "shorts-player-invariants",
  ];

  for (const id of required) {
    assert.ok(dashboards.getShortsDashboardPanel(id), `missing panel ${id}`);
  }
});

test("no panel references an event or field the pipeline would drop", () => {
  assert.deepEqual(dashboards.findDashboardSpecViolations(), []);
  assert.deepEqual(dashboards.findUnsanitizableProbeFields(), []);
});

test("the query-error panel does not count playback errors as query failures", () => {
  // A page that failed to load and a video that failed to decode are different
  // incidents with different owners. Reading feed_playback_error here would
  // inflate the query-error rate and hide the real one.
  const panel = dashboards.getShortsDashboardPanel("shorts-query-errors");

  assert.equal(panel.events.includes("feed_playback_error"), false);
  assert.deepEqual([...panel.events], ["shorts_query_received"]);
  assert.ok(panel.fields.includes("query_outcome"));
  assert.ok(panel.fields.includes("error_code"));
  assert.match(panel.alert.condition, /query_outcome == "error"/);

  // The playback-error panel is where decode failures belong.
  const playback = dashboards.getShortsDashboardPanel("shorts-playback-errors");
  assert.ok(playback.events.includes("feed_playback_error"));
  assert.equal(playback.events.includes("shorts_query_received"), false);
});

test("the spec validator catches a panel that reads a stripped field", () => {
  const violations = dashboards.findDashboardSpecViolations([
    {
      id: "bad-panel",
      title: "Bad",
      question: "?",
      kind: "count",
      events: ["shorts_not_real"],
      fields: ["video_title"],
      externalSources: [],
      owner: "",
      prdReference: "",
      alert: null,
    },
    {
      id: "bad-panel",
      title: "Duplicate",
      question: "?",
      kind: "count",
      events: [],
      fields: [],
      externalSources: [],
      owner: "someone",
      prdReference: "",
      alert: null,
    },
  ]);

  const kinds = violations.map((violation) => violation.kind).sort();
  assert.deepEqual(kinds, [
    "duplicate_panel_id",
    "missing_owner",
    "no_source",
    "unknown_event",
    "unstripped_field",
  ]);
});

test("provisional alert thresholds are declared as provisional", () => {
  const provisional = dashboards.SHORTS_DASHBOARD_PANELS.filter(
    (panel) => panel.alert?.provisional,
  ).map((panel) => panel.id);

  // These four are ratios against a production baseline that does not exist
  // yet. Saying so in the data is what keeps them from being read as agreed.
  assert.deepEqual(provisional.sort(), [
    "shorts-buffering",
    "shorts-empty-rate",
    "shorts-playback-errors",
    "shorts-query-errors",
  ]);

  for (const panel of dashboards.SHORTS_DASHBOARD_PANELS) {
    if (!panel.alert) continue;
    assert.ok(panel.alert.condition.length > 0, `${panel.id} alert needs a condition`);
    assert.ok(["page", "ticket", "watch"].includes(panel.alert.severity));
  }
});

/* ----------------------------------------------------------------- barrel */

test("the barrel re-exports the public surface without duplicating telemetry", () => {
  for (const name of [
    "normalizeAspectRatio",
    "VERTICAL_FEED_FIXTURES",
    "auditFeedExclusivity",
    "SHORTS_SCENARIOS",
    "buildShortsRollbackPlan",
    "SHORTS_DASHBOARD_PANELS",
  ]) {
    assert.ok(name in barrel, `barrel must export ${name}`);
  }

  // Telemetry and flags stay on their own import paths so there is exactly one
  // emitter and one flag registry.
  assert.equal("emitFeedPerformanceEvent" in barrel, false);
  assert.equal("FEED_FEATURE_FLAGS" in barrel, false);
});
