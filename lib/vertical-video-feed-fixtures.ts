/**
 * Deterministic fixtures for the 9:16 vertical feed, plus the reference
 * implementation of the eligibility contract they are checked against.
 *
 * Two things live here and it is worth being precise about which is which:
 *
 *   1. `normalizeAspectRatio` / `evaluateShortsVisibility` are a **fixture
 *      oracle**. They encode vertical-feed PRD sections 7.2 and 7.3 as
 *      executable rules so every fixture's expected placement is derived, not
 *      hand-typed. They are not the production classifier — that is Convex-side
 *      Phase 1 work. When it lands it must agree with this oracle on every
 *      fixture in `VERTICAL_FEED_FIXTURES`; `findFixtureOracleDisagreements`
 *      exists so the data lane can assert exactly that against its own
 *      implementation.
 *   2. `VERTICAL_FEED_FIXTURES` is the Phase 0 fixture set: hand-authored,
 *      order-stable, and free of any wall-clock or random input, so the same
 *      case list is available to a unit test, a seeded deployment, and a
 *      reviewer reading the table in the docs.
 *
 * Deliberate contract decisions, both biased toward the PRD rule that a missing
 * or invalid ratio is `unknown` and is never assumed to be 9:16:
 *
 *   - Whitespace is not tolerated anywhere in the ratio string. `" 9:16"` is
 *     `unknown`, not `vertical`. Mux does not emit padded values, so padding
 *     means something upstream reformatted the field, and downgrading to
 *     `unknown` keeps the asset on Home instead of guessing.
 *   - Integers outside the safe-integer range are `unknown`. Reducing them
 *     would run the GCD over values that have already lost precision.
 */

import type { FeedPlacement } from "./feed-performance-events";
import {
  createDeterministicFeed,
  type FeedCardContract,
} from "./feed-performance-test-feed";

export type { FeedPlacement };

export type AspectClassification = {
  /** Reduced `width:height`, for example "9:16". Null when unclassifiable. */
  aspectRatio: string | null;
  feedPlacement: FeedPlacement;
  /** Why the input produced `unknown`. Null for a successful classification. */
  unknownReason: AspectUnknownReason | null;
};

export const ASPECT_UNKNOWN_REASONS = [
  "missing",
  "not_a_string",
  "empty",
  "contains_whitespace",
  "malformed",
  "non_integer",
  "non_positive",
  "unsafe_integer",
] as const;
export type AspectUnknownReason = (typeof ASPECT_UNKNOWN_REASONS)[number];

/** The one ratio that qualifies for Shorts, after reduction. */
export const VERTICAL_ASPECT_RATIO = "9:16";

function greatestCommonDivisor(a: number, b: number): number {
  let left = a;
  let right = b;
  while (right !== 0) {
    const next = left % right;
    left = right;
    right = next;
  }
  return left;
}

function unknown(reason: AspectUnknownReason): AspectClassification {
  return { aspectRatio: null, feedPlacement: "unknown", unknownReason: reason };
}

/**
 * Vertical-feed PRD section 7.2: parse `width:height`, divide both sides by
 * their greatest common divisor, and return `vertical` only for an exact `9:16`
 * result.
 *
 * There is no tolerance band. `4:5`, `2:3`, and `10:16` are `standard`, which
 * is the point of the v1 decision: "approximately portrait" is not portrait.
 */
export function normalizeAspectRatio(input: unknown): AspectClassification {
  if (input === undefined || input === null) return unknown("missing");
  if (typeof input !== "string") return unknown("not_a_string");
  if (input.length === 0) return unknown("empty");
  if (/\s/.test(input)) return unknown("contains_whitespace");

  const parts = input.split(":");
  if (parts.length !== 2) return unknown("malformed");

  const [rawWidth, rawHeight] = parts;

  // Reject anything that is not a plain run of digits before Number() gets a
  // chance to be generous about "1e3", "0x10", "+9", or "". The two narrower
  // patterns run first only so the reason is specific enough to be actionable.
  const isDigits = (value: string) => /^\d+$/.test(value);
  const isDecimal = (value: string) => /^-?\d*\.\d+$/.test(value);
  const isNegativeInteger = (value: string) => /^-\d+$/.test(value);

  if (!isDigits(rawWidth) || !isDigits(rawHeight)) {
    if (isDecimal(rawWidth) || isDecimal(rawHeight)) return unknown("non_integer");
    if (isNegativeInteger(rawWidth) || isNegativeInteger(rawHeight)) {
      return unknown("non_positive");
    }
    return unknown("malformed");
  }

  const width = Number(rawWidth);
  const height = Number(rawHeight);

  if (width === 0 || height === 0) return unknown("non_positive");
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    return unknown("unsafe_integer");
  }

  const divisor = greatestCommonDivisor(width, height);
  const aspectRatio = `${width / divisor}:${height / divisor}`;

  return {
    aspectRatio,
    feedPlacement: aspectRatio === VERTICAL_ASPECT_RATIO ? "vertical" : "standard",
    unknownReason: null,
  };
}

/** The visibility inputs vertical-feed PRD section 7.3 reads. */
export type ShortsVisibilityInput = {
  status: string;
  isReady: boolean;
  isDeleted: boolean;
  feedPlacement: FeedPlacement;
  playbackIds: readonly string[];
  /** The existing feed visibility rules' verdict for this card. */
  feedVisible: boolean;
};

export const SHORTS_INELIGIBILITY_REASONS = [
  "status_not_ready",
  "not_ready_flag",
  "deleted",
  "placement_not_vertical",
  "no_usable_playback_id",
  "feed_visibility_denied",
] as const;
export type ShortsIneligibilityReason = (typeof SHORTS_INELIGIBILITY_REASONS)[number];

export type ShortsVisibilityResult = {
  eligible: boolean;
  /** Every failing condition, not just the first, so a fixture explains itself. */
  reasons: ShortsIneligibilityReason[];
};

/**
 * Evaluates every section 7.3 condition. All conditions are checked even after
 * one fails: a fixture that is both deleted and non-vertical should say so,
 * because "why is this not in Shorts" is the question this answers.
 */
export function evaluateShortsVisibility(
  input: ShortsVisibilityInput,
): ShortsVisibilityResult {
  const reasons: ShortsIneligibilityReason[] = [];

  if (input.status !== "ready") reasons.push("status_not_ready");
  if (!input.isReady) reasons.push("not_ready_flag");
  if (input.isDeleted) reasons.push("deleted");
  if (input.feedPlacement !== "vertical") reasons.push("placement_not_vertical");
  if (!input.playbackIds.some((id) => typeof id === "string" && id.length > 0)) {
    reasons.push("no_usable_playback_id");
  }
  if (!input.feedVisible) reasons.push("feed_visibility_denied");

  return { eligible: reasons.length === 0, reasons };
}

export type VerticalFixtureGroup =
  /** Exactly or reducibly 9:16 and eligible for Shorts. */
  | "qualifying"
  /** A valid ratio that is not 9:16. */
  | "nonqualifying_ratio"
  /** Missing, malformed, zero, negative, non-integer, or oversized input. */
  | "malformed_ratio"
  /** Ratio qualifies but a section 7.3 visibility rule excludes the asset. */
  | "visibility_excluded";

export type VerticalFeedFixture = {
  id: string;
  group: VerticalFixtureGroup;
  /** What this case is here to prove. */
  intent: string;
  /** Raw `aspect_ratio` exactly as a Mux payload would carry it. */
  sourceAspectRatio: unknown;
  status: string;
  isReady: boolean;
  isDeleted: boolean;
  playbackIds: readonly string[];
  feedVisible: boolean;
  /** Reduced ratio the oracle must produce. */
  expectedAspectRatio: string | null;
  expectedPlacement: FeedPlacement;
  expectedEligibleForShorts: boolean;
};

/**
 * Fixed epoch shared with the news-feed fixtures so both generators produce
 * comparable timestamps. 2026-01-01T00:00:00.000Z.
 */
export const VERTICAL_FIXTURE_BASE_CREATED_AT_MS = 1767225600000;

function qualifying(
  id: string,
  sourceAspectRatio: string,
  intent: string,
): VerticalFeedFixture {
  return {
    id,
    group: "qualifying",
    intent,
    sourceAspectRatio,
    status: "ready",
    isReady: true,
    isDeleted: false,
    playbackIds: [`pb-${id}`],
    feedVisible: true,
    expectedAspectRatio: VERTICAL_ASPECT_RATIO,
    expectedPlacement: "vertical",
    expectedEligibleForShorts: true,
  };
}

function nonqualifyingRatio(
  id: string,
  sourceAspectRatio: string,
  expectedAspectRatio: string,
  intent: string,
): VerticalFeedFixture {
  return {
    id,
    group: "nonqualifying_ratio",
    intent,
    sourceAspectRatio,
    status: "ready",
    isReady: true,
    isDeleted: false,
    playbackIds: [`pb-${id}`],
    feedVisible: true,
    expectedAspectRatio,
    expectedPlacement: "standard",
    expectedEligibleForShorts: false,
  };
}

function malformedRatio(
  id: string,
  sourceAspectRatio: unknown,
  intent: string,
): VerticalFeedFixture {
  return {
    id,
    group: "malformed_ratio",
    intent,
    sourceAspectRatio,
    status: "ready",
    isReady: true,
    isDeleted: false,
    playbackIds: [`pb-${id}`],
    feedVisible: true,
    expectedAspectRatio: null,
    expectedPlacement: "unknown",
    expectedEligibleForShorts: false,
  };
}

function visibilityExcluded(
  id: string,
  intent: string,
  overrides: Partial<
    Pick<
      VerticalFeedFixture,
      "status" | "isReady" | "isDeleted" | "playbackIds" | "feedVisible"
    >
  >,
): VerticalFeedFixture {
  return {
    id,
    group: "visibility_excluded",
    intent,
    sourceAspectRatio: VERTICAL_ASPECT_RATIO,
    status: "ready",
    isReady: true,
    isDeleted: false,
    playbackIds: [`pb-${id}`],
    feedVisible: true,
    ...overrides,
    expectedAspectRatio: VERTICAL_ASPECT_RATIO,
    // The ratio still classifies as vertical. Placement and eligibility are
    // separate questions, and conflating them is how a deleted asset ends up
    // in a feed.
    expectedPlacement: "vertical",
    expectedEligibleForShorts: false,
  };
}

/**
 * The Phase 0 fixture set: 12 qualifying cases and 22 non-qualifying,
 * malformed, or visibility-excluded cases.
 *
 * Every entry states its own intent so a reviewer can tell a deliberate trap
 * (`4:5`, `10:16`) from a routine case.
 */
export const VERTICAL_FEED_FIXTURES: readonly VerticalFeedFixture[] = [
  /* --- qualifying: exact and reducible 9:16 --- */
  qualifying("exact-9-16", "9:16", "Already reduced; the canonical case."),
  qualifying("hd-1080-1920", "1080:1920", "Standard phone portrait upload."),
  qualifying("hd-720-1280", "720:1280", "720p portrait."),
  qualifying("qhd-1440-2560", "1440:2560", "QHD portrait."),
  qualifying("sd-540-960", "540:960", "Half-HD portrait."),
  qualifying("uhd-2160-3840", "2160:3840", "4K portrait."),
  qualifying("low-360-640", "360:640", "Low-resolution portrait."),
  qualifying("odd-1170-2080", "1170:2080", "Reduces only via a GCD of 130."),
  qualifying("odd-450-800", "450:800", "Reduces via a GCD of 50."),
  qualifying("uhd-4320-7680", "4320:7680", "8K portrait; largest realistic case."),
  qualifying("small-288-512", "288:512", "Reduces via a GCD of 32."),
  qualifying("odd-1620-2880", "1620:2880", "Reduces via a GCD of 180."),

  /* --- non-qualifying: valid ratios that are not 9:16 --- */
  nonqualifyingRatio("landscape-16-9", "16:9", "16:9", "The Home default."),
  nonqualifyingRatio(
    "landscape-1920-1080",
    "1920:1080",
    "16:9",
    "Reducible landscape must not be mistaken for a portrait GCD case.",
  ),
  nonqualifyingRatio(
    "portrait-4-5",
    "4:5",
    "4:5",
    "Near-portrait trap. Explicitly excluded by the v1 exact-ratio decision.",
  ),
  nonqualifyingRatio(
    "portrait-2-3",
    "2:3",
    "2:3",
    "Near-portrait trap; closer to 9:16 than 4:5 and still excluded.",
  ),
  nonqualifyingRatio(
    "portrait-10-16",
    "10:16",
    "5:8",
    "Near-portrait trap that reduces to 5:8, one step from 9:16.",
  ),
  nonqualifyingRatio("square-1-1", "1:1", "1:1", "Square."),
  nonqualifyingRatio(
    "ultrawide-21-9",
    "21:9",
    "7:3",
    "Cinematic ultrawide; reduces to 7:3.",
  ),
  nonqualifyingRatio(
    "duplicate-16-9",
    "16:9",
    "16:9",
    "Second asset with an identical ratio: two rows may share a ratio.",
  ),

  /* --- malformed, missing, and out-of-domain input --- */
  malformedRatio("missing-undefined", undefined, "Field absent from the payload."),
  malformedRatio("missing-null", null, "Field present but null."),
  malformedRatio("empty-string", "", "Empty string."),
  malformedRatio("zero-width", "0:16", "Zero width."),
  malformedRatio("zero-height", "9:0", "Zero height; would divide by zero."),
  malformedRatio("negative-width", "-9:16", "Negative width."),
  malformedRatio("negative-height", "9:-16", "Negative height."),
  malformedRatio("non-integer", "9.5:16", "Fractional width."),
  malformedRatio("decimal-ratio", "0.5625", "A decimal ratio with no separator."),
  malformedRatio("wrong-separator", "9x16", "Separator is not a colon."),
  malformedRatio("three-parts", "9:16:1", "Three components."),
  malformedRatio("leading-space", " 9:16", "Padded value; not silently trimmed."),
  malformedRatio("internal-space", "9 : 16", "Spaces around the separator."),
  malformedRatio("exponent-notation", "9e0:16", "Exponent notation."),
  malformedRatio(
    "unsafe-integer",
    "9007199254740993:16012798674205320",
    "Beyond Number.MAX_SAFE_INTEGER; precision is already lost.",
  ),
  malformedRatio("numeric-type", 0.5625, "Payload sent a number, not a string."),

  /* --- vertical ratio, excluded by a section 7.3 visibility rule --- */
  visibilityExcluded("vertical-not-ready-status", "Still preparing at Mux.", {
    status: "preparing",
    isReady: false,
  }),
  visibilityExcluded("vertical-ready-flag-false", "Status says ready, flag disagrees.", {
    isReady: false,
  }),
  visibilityExcluded("vertical-deleted", "Soft-deleted asset.", { isDeleted: true }),
  visibilityExcluded("vertical-no-playback-id", "No playback ID was ever issued.", {
    playbackIds: [],
  }),
  visibilityExcluded("vertical-empty-playback-id", "Playback ID present but empty.", {
    playbackIds: [""],
  }),
  visibilityExcluded(
    "vertical-feed-hidden",
    "Existing feed visibility rules exclude the card, for example a private upload.",
    { feedVisible: false },
  ),
];

export function getVerticalFeedFixtures(
  group: VerticalFixtureGroup,
): VerticalFeedFixture[] {
  return VERTICAL_FEED_FIXTURES.filter((fixture) => fixture.group === group);
}

/** Fixtures that must appear in Shorts. */
export function getShortsEligibleFixtures(): VerticalFeedFixture[] {
  return VERTICAL_FEED_FIXTURES.filter((fixture) => fixture.expectedEligibleForShorts);
}

/** Fixtures that must never appear in Shorts, for any reason. */
export function getShortsIneligibleFixtures(): VerticalFeedFixture[] {
  return VERTICAL_FEED_FIXTURES.filter((fixture) => !fixture.expectedEligibleForShorts);
}

export function classifyFixture(fixture: VerticalFeedFixture): AspectClassification {
  return normalizeAspectRatio(fixture.sourceAspectRatio);
}

export function evaluateFixtureVisibility(
  fixture: VerticalFeedFixture,
): ShortsVisibilityResult {
  return evaluateShortsVisibility({
    status: fixture.status,
    isReady: fixture.isReady,
    isDeleted: fixture.isDeleted,
    feedPlacement: classifyFixture(fixture).feedPlacement,
    playbackIds: fixture.playbackIds,
    feedVisible: fixture.feedVisible,
  });
}

export type FixtureDisagreement = {
  fixtureId: string;
  field: "aspectRatio" | "feedPlacement" | "eligibleForShorts";
  expected: string | boolean | null;
  actual: string | boolean | null;
};

export type FixtureClassifier = (sourceAspectRatio: unknown) => {
  aspectRatio: string | null;
  feedPlacement: FeedPlacement;
};

/**
 * Runs a candidate classifier — the production Convex one, once it exists —
 * over every fixture and reports where it disagrees with the recorded
 * expectations.
 *
 * Passing no classifier checks the built-in oracle against the hand-authored
 * expectations, which is what the unit suite does. Passing the real classifier
 * is how the data lane proves the two agree without importing this module into
 * Convex.
 */
export function findFixtureOracleDisagreements(
  classifier: FixtureClassifier = normalizeAspectRatio,
): FixtureDisagreement[] {
  const disagreements: FixtureDisagreement[] = [];

  for (const fixture of VERTICAL_FEED_FIXTURES) {
    const classification = classifier(fixture.sourceAspectRatio);

    if (classification.aspectRatio !== fixture.expectedAspectRatio) {
      disagreements.push({
        fixtureId: fixture.id,
        field: "aspectRatio",
        expected: fixture.expectedAspectRatio,
        actual: classification.aspectRatio,
      });
    }

    if (classification.feedPlacement !== fixture.expectedPlacement) {
      disagreements.push({
        fixtureId: fixture.id,
        field: "feedPlacement",
        expected: fixture.expectedPlacement,
        actual: classification.feedPlacement,
      });
    }

    const eligible = evaluateShortsVisibility({
      status: fixture.status,
      isReady: fixture.isReady,
      isDeleted: fixture.isDeleted,
      feedPlacement: classification.feedPlacement,
      playbackIds: fixture.playbackIds,
      feedVisible: fixture.feedVisible,
    }).eligible;

    if (eligible !== fixture.expectedEligibleForShorts) {
      disagreements.push({
        fixtureId: fixture.id,
        field: "eligibleForShorts",
        expected: fixture.expectedEligibleForShorts,
        actual: eligible,
      });
    }
  }

  return disagreements;
}

/** Requested thumbnail geometry for a vertical cell. */
export const VERTICAL_THUMBNAIL_WIDTH = 720;
export const VERTICAL_THUMBNAIL_HEIGHT = 1280;

export type DeterministicVerticalFeedOptions = {
  count: number;
  seed?: number;
  /**
   * Real Mux playback IDs of **exact 9:16 assets**. Without them the generator
   * emits `synthetic-not-playable-` IDs that will not resolve against Mux, so
   * the 50-item scroll and memory scenarios need real IDs supplied here.
   */
  playbackIds?: readonly string[];
  baseCreatedAtMs?: number;
};

/**
 * A deterministic page of Shorts cards.
 *
 * Delegates to the news-feed generator so both feeds share one card contract
 * and one seeding scheme, then rewrites the thumbnail to a 9:16 smart crop.
 * Same seed and count always produce byte-identical JSON.
 */
export function createDeterministicVerticalFeed(
  options: DeterministicVerticalFeedOptions,
): FeedCardContract[] {
  const cards = createDeterministicFeed({
    count: options.count,
    seed: options.seed,
    playbackIds: options.playbackIds,
    baseCreatedAtMs: options.baseCreatedAtMs ?? VERTICAL_FIXTURE_BASE_CREATED_AT_MS,
  });

  return cards.map((card) => ({
    ...card,
    thumbnailUrl:
      `https://image.mux.com/${card.playbackId}/thumbnail.jpg` +
      `?width=${VERTICAL_THUMBNAIL_WIDTH}&height=${VERTICAL_THUMBNAIL_HEIGHT}&fit_mode=smartcrop`,
  }));
}

/** The scroll/memory scenario length both PRDs standardize on. */
export const VERTICAL_STANDARD_SCENARIO_ITEM_COUNT = 50;
