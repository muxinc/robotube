/**
 * Aspect-ratio parsing, GCD normalization, and placement tests.
 *
 * The repository has no test runner dependency, so these run on the Node
 * built-in runner with type stripping:
 *
 *   node --experimental-strip-types --test tests/aspect-classification.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type FeedPlacement,
  MAX_RATIO_COMPONENT_DIGITS,
  UNKNOWN_ASPECT_CLASSIFICATION,
  VERTICAL_ASPECT_RATIO,
  buildAspectClassificationPatch,
  classifyAspectRatio,
  classifyMuxAssetPayloadAspect,
  greatestCommonDivisor,
  isFeedPlacement,
  isStoredAspectClassificationConsistent,
  normalizeAspectRatio,
  parseExactIntegerRatio,
  readMuxAspectRatioInput,
  reduceIntegerRatio,
  resolveAspectClassificationForUpsert,
} from "../convex/aspectClassification.ts";
import {
  NON_QUALIFYING_SOURCE_RATIOS,
  UNKNOWN_SOURCE_RATIOS,
  VERTICAL_SOURCE_RATIOS,
} from "./vertical-feed-data-fixtures.ts";

/** The read-model fields a classification write must never touch. */
const FEED_READ_MODEL_FIELDS = [
  "feedTitle",
  "feedChannelName",
  "feedUploaderUserId",
  "feedReadModelUpdatedAtMs",
];

function placementOf(value: unknown): FeedPlacement {
  return classifyAspectRatio(value).feedPlacement;
}

/* ------------------------------------------------------------------ *
 * Exact and reducible qualifying ratios
 * ------------------------------------------------------------------ */

test("the PRD normalization table classifies exactly as specified", () => {
  const table: [string, string | null, FeedPlacement][] = [
    ["9:16", "9:16", "vertical"],
    ["1080:1920", "9:16", "vertical"],
    ["720:1280", "9:16", "vertical"],
    ["16:9", "16:9", "standard"],
    ["4:5", "4:5", "standard"],
    ["1:1", "1:1", "standard"],
  ];

  for (const [source, expectedRatio, expectedPlacement] of table) {
    assert.deepEqual(
      classifyAspectRatio(source),
      { aspectRatio: expectedRatio, feedPlacement: expectedPlacement },
      `classification of ${source}`,
    );
  }
});

test("every reducible 9:16 fixture normalizes to 9:16 and qualifies", () => {
  assert.ok(VERTICAL_SOURCE_RATIOS.length >= 10);

  for (const source of VERTICAL_SOURCE_RATIOS) {
    assert.deepEqual(
      classifyAspectRatio(source),
      { aspectRatio: VERTICAL_ASPECT_RATIO, feedPlacement: "vertical" },
      `${source} must reduce to ${VERTICAL_ASPECT_RATIO}`,
    );
  }
});

test("every non-qualifying fixture is standard, never vertical", () => {
  assert.ok(NON_QUALIFYING_SOURCE_RATIOS.length >= 10);

  for (const source of NON_QUALIFYING_SOURCE_RATIOS) {
    const classification = classifyAspectRatio(source);
    assert.equal(classification.feedPlacement, "standard", `${source} placement`);
    assert.notEqual(classification.aspectRatio, VERTICAL_ASPECT_RATIO);
  }
});

test("nothing but an exact reduced 9:16 qualifies across a full sweep", () => {
  let verticalCount = 0;

  for (let width = 1; width <= 64; width += 1) {
    for (let height = 1; height <= 64; height += 1) {
      const source = `${width}:${height}`;
      const classification = classifyAspectRatio(source);
      const reduced = reduceIntegerRatio({ width, height });
      const isExactVertical = reduced.width === 9 && reduced.height === 16;

      assert.equal(
        classification.feedPlacement,
        isExactVertical ? "vertical" : "standard",
        `${source} reduced to ${reduced.width}:${reduced.height}`,
      );
      if (isExactVertical) verticalCount += 1;
    }
  }

  // 9:16, 18:32, 27:48, 36:64 within the sweep bounds.
  assert.equal(verticalCount, 4);
});

test("nearly-portrait ratios stay on the standard feed", () => {
  for (const source of ["4:5", "2:3", "10:16", "9:17", "8:15", "1080:1921"]) {
    assert.equal(placementOf(source), "standard", source);
  }
});

test("leading zeros are exact, not oversized", () => {
  assert.equal(normalizeAspectRatio("009:016"), "9:16");
  assert.equal(placementOf("0000000000000000009:0016"), "vertical");
  assert.equal(normalizeAspectRatio("0:0016"), null);
});

/* ------------------------------------------------------------------ *
 * Missing, malformed, zero, negative, non-integer, oversized
 * ------------------------------------------------------------------ */

test("missing ratio data is unknown, never assumed vertical", () => {
  for (const value of [undefined, null, "", "   ", 0.5625, 9, true, [], {}, ["9:16"]]) {
    assert.deepEqual(
      classifyAspectRatio(value),
      UNKNOWN_ASPECT_CLASSIFICATION,
      `${JSON.stringify(value) ?? "undefined"} must be unknown`,
    );
  }
});

test("every unknown fixture classifies as unknown with a null ratio", () => {
  for (const source of UNKNOWN_SOURCE_RATIOS) {
    assert.deepEqual(
      classifyAspectRatio(source),
      UNKNOWN_ASPECT_CLASSIFICATION,
      `${JSON.stringify(source)} must be unknown`,
    );
    assert.equal(parseExactIntegerRatio(source), null);
  }
});

test("malformed separators and shapes are unknown", () => {
  for (const source of [
    "9x16",
    "9/16",
    "9-16",
    "9 16",
    "9:16:9",
    "9::16",
    ":",
    "::",
    "abc:def",
    "9:sixteen",
    "9:",
    ":16",
    "9",
  ]) {
    assert.equal(placementOf(source), "unknown", JSON.stringify(source));
  }
});

test("whitespace anywhere in the value is malformed, never trimmed", () => {
  // The grammar is exactly `<digits>:<digits>`; the parser does not repair input.
  for (const source of [
    " 9:16",
    "9:16 ",
    " 9:16 ",
    "9 :16",
    "9: 16",
    "9 : 16",
    "\t9:16",
    "9:16\n",
    "16:9 ",
    "1 9:16",
    "9:1 6",
    " 9:16",
  ]) {
    assert.equal(placementOf(source), "unknown", JSON.stringify(source));
    assert.equal(normalizeAspectRatio(source), null, JSON.stringify(source));
  }

  assert.equal(placementOf("9:16"), "vertical");
});

test("zero components are unknown", () => {
  for (const source of ["0:16", "9:0", "0:0", "000:16", "9:000", "0:0000"]) {
    assert.deepEqual(classifyAspectRatio(source), UNKNOWN_ASPECT_CLASSIFICATION, source);
  }
});

test("negative components are unknown", () => {
  for (const source of ["-9:16", "9:-16", "-9:-16", "-0:16", "- 9:16"]) {
    assert.deepEqual(classifyAspectRatio(source), UNKNOWN_ASPECT_CLASSIFICATION, source);
  }
});

test("non-integer components are unknown", () => {
  for (const source of [
    "9.0:16",
    "9:16.0",
    "1.5:2",
    "0.5625",
    "9,0:16",
    "1e3:16",
    "9e0:16",
    "0x9:0x10",
    "9_000:16_000",
    "Infinity:16",
    "NaN:16",
    "١٦:٩",
    "٩:١٦",
  ]) {
    assert.deepEqual(classifyAspectRatio(source), UNKNOWN_ASPECT_CLASSIFICATION, source);
  }
});

test("oversized components are unknown rather than reduced with float error", () => {
  const maxSafeDigits = "9".repeat(MAX_RATIO_COMPONENT_DIGITS);
  const oneDigitTooMany = "9".repeat(MAX_RATIO_COMPONENT_DIGITS + 1);

  // The largest accepted size still normalizes exactly.
  assert.equal(normalizeAspectRatio(`${maxSafeDigits}:${maxSafeDigits}`), "1:1");
  assert.equal(Number.isSafeInteger(Number(maxSafeDigits)), true);

  for (const source of [
    `${oneDigitTooMany}:16`,
    `9:${oneDigitTooMany}`,
    "9007199254740993:16",
    "10000000000000000:17777777777777778",
    `${"1".repeat(40)}:${"2".repeat(40)}`,
  ]) {
    assert.deepEqual(classifyAspectRatio(source), UNKNOWN_ASPECT_CLASSIFICATION, source);
  }
});

test("large in-range ratios still reduce exactly", () => {
  // Both components sit at or under the accepted digit bound.
  assert.equal(normalizeAspectRatio("90000000000000:160000000000000"), "9:16");
  assert.equal(placementOf("90000000000000:160000000000000"), "vertical");
  assert.equal(normalizeAspectRatio("999999999999999:999999999999999"), "1:1");
});

/* ------------------------------------------------------------------ *
 * Parsing and GCD primitives
 * ------------------------------------------------------------------ */

test("the parser returns exact positive integers", () => {
  assert.deepEqual(parseExactIntegerRatio("1080:1920"), { width: 1080, height: 1920 });
  assert.deepEqual(parseExactIntegerRatio("09:16"), { width: 9, height: 16 });
  assert.equal(parseExactIntegerRatio(" 9 : 16 "), null);
  assert.equal(parseExactIntegerRatio(1080), null);
});

test("gcd reduction is exact", () => {
  assert.equal(greatestCommonDivisor(1080, 1920), 120);
  assert.equal(greatestCommonDivisor(9, 16), 1);
  assert.equal(greatestCommonDivisor(16, 9), 1);
  assert.equal(greatestCommonDivisor(0, 5), 5);
  assert.equal(greatestCommonDivisor(5, 0), 5);
  assert.equal(greatestCommonDivisor(0, 0), 0);
  assert.equal(greatestCommonDivisor(2160, 3840), 240);

  assert.deepEqual(reduceIntegerRatio({ width: 2160, height: 3840 }), {
    width: 9,
    height: 16,
  });
  assert.deepEqual(reduceIntegerRatio({ width: 7, height: 11 }), {
    width: 7,
    height: 11,
  });
});

test("normalization is idempotent", () => {
  for (const source of [
    ...VERTICAL_SOURCE_RATIOS,
    ...NON_QUALIFYING_SOURCE_RATIOS,
  ]) {
    const once = normalizeAspectRatio(source);
    assert.notEqual(once, null);
    assert.equal(normalizeAspectRatio(once), once, source);
    assert.deepEqual(classifyAspectRatio(once), classifyAspectRatio(source), source);
  }
});

test("placement values are validated, not trusted", () => {
  assert.equal(isFeedPlacement("vertical"), true);
  assert.equal(isFeedPlacement("standard"), true);
  assert.equal(isFeedPlacement("unknown"), true);
  for (const value of ["Vertical", "shorts", "", null, undefined, 1, {}]) {
    assert.equal(isFeedPlacement(value), false, JSON.stringify(value) ?? "undefined");
  }
});

/* ------------------------------------------------------------------ *
 * Mux payload shapes: snake_case, camelCase, nested raw
 * ------------------------------------------------------------------ */

test("snake_case webhook payloads are classified", () => {
  const classification = classifyMuxAssetPayloadAspect({
    id: "asset_1",
    status: "ready",
    aspect_ratio: "1080:1920",
  });

  assert.deepEqual(classification, {
    aspectRatio: "9:16",
    feedPlacement: "vertical",
    provided: true,
    sourceKey: "aspect_ratio",
  });
});

test("camelCase component rows are classified", () => {
  const classification = classifyMuxAssetPayloadAspect({
    muxAssetId: "asset_2",
    aspectRatio: "16:9",
  });

  assert.deepEqual(classification, {
    aspectRatio: "16:9",
    feedPlacement: "standard",
    provided: true,
    sourceKey: "aspectRatio",
  });
});

test("a nested raw payload is the last resort", () => {
  const classification = classifyMuxAssetPayloadAspect({
    muxAssetId: "asset_3",
    raw: { id: "asset_3", aspect_ratio: "720:1280" },
  });

  assert.deepEqual(classification, {
    aspectRatio: "9:16",
    feedPlacement: "vertical",
    provided: true,
    sourceKey: "raw.aspect_ratio",
  });
});

test("snake_case wins when a payload carries both spellings", () => {
  assert.equal(
    readMuxAspectRatioInput({ aspect_ratio: "9:16", aspectRatio: "16:9" }).sourceKey,
    "aspect_ratio",
  );
});

test("absent, null, and empty ratio fields all read as not provided", () => {
  for (const payload of [
    {},
    { id: "a" },
    { aspect_ratio: undefined },
    { aspect_ratio: null },
    { aspect_ratio: "" },
    { aspect_ratio: "   " },
    { aspectRatio: null },
    { raw: {} },
    { raw: null },
    null,
    undefined,
    "9:16",
    ["9:16"],
  ]) {
    const input = readMuxAspectRatioInput(payload);
    assert.equal(input.provided, false, JSON.stringify(payload) ?? "undefined");
    assert.equal(input.sourceKey, null);
  }
});

test("present-but-unusable ratio data is authoritative and unknown", () => {
  const classification = classifyMuxAssetPayloadAspect({ aspect_ratio: "9:0" });

  assert.equal(classification.provided, true);
  assert.equal(classification.feedPlacement, "unknown");
  assert.equal(classification.aspectRatio, null);
});

test("a non-string ratio value is provided but unusable", () => {
  const classification = classifyMuxAssetPayloadAspect({ aspect_ratio: 0.5625 });

  assert.equal(classification.provided, true);
  assert.equal(classification.feedPlacement, "unknown");
});

/* ------------------------------------------------------------------ *
 * Upsert resolution: refresh, preserve, and idempotence
 * ------------------------------------------------------------------ */

function resolveFromPayload(
  existing: { aspectRatio?: string; feedPlacement?: FeedPlacement } | null,
  payload: unknown,
) {
  const classification = classifyMuxAssetPayloadAspect(payload);
  return resolveAspectClassificationForUpsert({
    existing,
    incoming: {
      aspectRatio: classification.aspectRatio,
      feedPlacement: classification.provided
        ? classification.feedPlacement
        : undefined,
    },
  });
}

test("a first ready event classifies an unclassified row", () => {
  assert.deepEqual(resolveFromPayload(null, { aspect_ratio: "1080:1920" }), {
    aspectRatio: "9:16",
    feedPlacement: "vertical",
    changed: true,
  });
});

test("a row with no ratio data becomes explicitly unknown", () => {
  assert.deepEqual(resolveFromPayload(null, { id: "asset_1" }), {
    aspectRatio: undefined,
    feedPlacement: "unknown",
    changed: true,
  });
});

test("a payload without ratio data preserves a known classification", () => {
  const existing = { aspectRatio: "9:16", feedPlacement: "vertical" as FeedPlacement };

  for (const payload of [
    { id: "asset_1", status: "preparing" },
    { id: "asset_1", aspect_ratio: null },
    { id: "asset_1", aspect_ratio: "" },
  ]) {
    assert.deepEqual(
      resolveFromPayload(existing, payload),
      { aspectRatio: "9:16", feedPlacement: "vertical", changed: false },
      JSON.stringify(payload),
    );
  }
});

test("a later asset update refreshes the classification", () => {
  assert.deepEqual(
    resolveFromPayload(
      { aspectRatio: "9:16", feedPlacement: "vertical" },
      { aspect_ratio: "16:9" },
    ),
    { aspectRatio: "16:9", feedPlacement: "standard", changed: true },
  );

  assert.deepEqual(
    resolveFromPayload(
      { aspectRatio: "16:9", feedPlacement: "standard" },
      { aspect_ratio: "720:1280" },
    ),
    { aspectRatio: "9:16", feedPlacement: "vertical", changed: true },
  );

  assert.deepEqual(
    resolveFromPayload({ feedPlacement: "unknown" }, { aspect_ratio: "9:16" }),
    { aspectRatio: "9:16", feedPlacement: "vertical", changed: true },
  );
});

test("a ratio that stops parsing clears the stored ratio and demotes the row", () => {
  assert.deepEqual(
    resolveFromPayload(
      { aspectRatio: "9:16", feedPlacement: "vertical" },
      { aspect_ratio: "9:0" },
    ),
    { aspectRatio: undefined, feedPlacement: "unknown", changed: true },
  );
});

test("re-applying the same payload is a no-op", () => {
  const payload = { id: "asset_1", aspect_ratio: "1080:1920" };
  const first = resolveFromPayload(null, payload);
  const second = resolveFromPayload(
    { aspectRatio: first.aspectRatio, feedPlacement: first.feedPlacement },
    payload,
  );

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(second.feedPlacement, "vertical");
});

test("an unrecognized stored placement is repaired, not trusted", () => {
  const resolved = resolveAspectClassificationForUpsert({
    existing: { aspectRatio: "9:16", feedPlacement: "shorts" },
    incoming: { aspectRatio: null, feedPlacement: undefined },
  });

  assert.deepEqual(resolved, {
    aspectRatio: "9:16",
    feedPlacement: "unknown",
    changed: true,
  });
});

/* ------------------------------------------------------------------ *
 * The classification patch
 * ------------------------------------------------------------------ */

test("the patch stamps a timestamp only when the classification changed", () => {
  const changed = buildAspectClassificationPatch(
    { aspectRatio: "9:16", feedPlacement: "vertical", changed: true },
    1_700_000_000_500,
  );
  assert.deepEqual(changed, {
    aspectRatio: "9:16",
    feedPlacement: "vertical",
    aspectRatioUpdatedAtMs: 1_700_000_000_500,
  });

  const unchanged = buildAspectClassificationPatch(
    { aspectRatio: "9:16", feedPlacement: "vertical", changed: false },
    1_700_000_000_500,
  );
  assert.deepEqual(unchanged, { aspectRatio: "9:16", feedPlacement: "vertical" });
  assert.equal(Object.hasOwn(unchanged, "aspectRatioUpdatedAtMs"), false);
});

test("the patch clears a stale ratio with undefined", () => {
  const patch = buildAspectClassificationPatch(
    { aspectRatio: undefined, feedPlacement: "unknown", changed: true },
    7,
  );

  assert.equal(Object.hasOwn(patch, "aspectRatio"), true);
  assert.equal(patch.aspectRatio, undefined);
  assert.equal(patch.feedPlacement, "unknown");
});

/* ------------------------------------------------------------------ *
 * Stored-classification integrity
 * ------------------------------------------------------------------ */

test("a stored ratio and placement that agree are consistent", () => {
  for (const stored of [
    { aspectRatio: "9:16", feedPlacement: "vertical" },
    { aspectRatio: "16:9", feedPlacement: "standard" },
    { aspectRatio: "1:1", feedPlacement: "standard" },
    { feedPlacement: "unknown" },
    { aspectRatio: undefined, feedPlacement: "unknown" },
    // A row that predates classification carries neither field.
    {},
  ]) {
    assert.equal(
      isStoredAspectClassificationConsistent(stored),
      true,
      JSON.stringify(stored),
    );
  }
});

test("a stored 9:16 marked standard is reported as inconsistent", () => {
  assert.equal(
    isStoredAspectClassificationConsistent({
      aspectRatio: "9:16",
      feedPlacement: "standard",
    }),
    false,
  );
  assert.equal(
    isStoredAspectClassificationConsistent({
      aspectRatio: "16:9",
      feedPlacement: "vertical",
    }),
    false,
  );
});

test("every other cross-field mismatch is reported too", () => {
  for (const stored of [
    // Unnormalized: the stored ratio should have been reduced to 9:16.
    { aspectRatio: "1080:1920", feedPlacement: "vertical" },
    { aspectRatio: "1080:1920", feedPlacement: "standard" },
    // A ratio that no longer parses cannot support any placement.
    { aspectRatio: "9:0", feedPlacement: "vertical" },
    { aspectRatio: "9:0", feedPlacement: "unknown" },
    { aspectRatio: " 9:16", feedPlacement: "vertical" },
    // A placement with no ratio, and a ratio with no placement.
    { feedPlacement: "vertical" },
    { feedPlacement: "standard" },
    { aspectRatio: "9:16" },
    // An unrecognized placement string.
    { aspectRatio: "9:16", feedPlacement: "shorts" },
  ]) {
    assert.equal(
      isStoredAspectClassificationConsistent(stored),
      false,
      JSON.stringify(stored),
    );
  }
});

test("everything the upsert resolver writes is self-consistent", () => {
  const payloads = [
    { aspect_ratio: "9:16" },
    { aspect_ratio: "1080:1920" },
    { aspect_ratio: "16:9" },
    { aspect_ratio: "9:0" },
    { aspect_ratio: " 9:16" },
    { aspect_ratio: "" },
    { id: "no-ratio" },
  ];

  for (const payload of payloads) {
    const resolved = resolveFromPayload(null, payload);
    assert.equal(
      isStoredAspectClassificationConsistent({
        aspectRatio: resolved.aspectRatio,
        feedPlacement: resolved.feedPlacement,
      }),
      true,
      JSON.stringify(payload),
    );
  }
});

test("a classification patch never touches the feed read model", () => {
  const patch = buildAspectClassificationPatch(
    { aspectRatio: "9:16", feedPlacement: "vertical", changed: true },
    1,
  );

  for (const field of FEED_READ_MODEL_FIELDS) {
    assert.equal(
      Object.hasOwn(patch, field),
      false,
      `classification patch must not write "${field}"`,
    );
  }

  assert.deepEqual(Object.keys(patch).sort(), [
    "aspectRatio",
    "aspectRatioUpdatedAtMs",
    "feedPlacement",
  ]);
});
