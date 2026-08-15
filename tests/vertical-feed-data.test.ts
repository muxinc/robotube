/**
 * Vertical (Shorts) feed data tests: index contract, visibility, cursor
 * stability, exclusivity audit, and response size.
 *
 * The repository has no test runner dependency, so these run on the Node
 * built-in runner with type stripping:
 *
 *   node --experimental-strip-types --test tests/vertical-feed-data.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  type FeedPlacement,
  isStoredAspectClassificationConsistent,
} from "../convex/aspectClassification.ts";
import {
  type FeedPlacementAuditSummary,
  type FeedVideoCardItem,
  type PlacementFeedAsset,
  FEED_PLACEMENT_INDEX_FIELDS,
  FEED_PLACEMENT_INDEX_NAME,
  FEED_PLACEMENT_MAX_PAGE_SIZE,
  STANDARD_FEED_PLACEMENT,
  VERTICAL_FEED_PLACEMENT,
  applyPlacementIndexRange,
  buildDuplicateMuxAssetIdPredicate,
  buildFeedVideoCard,
  buildFeedVideoCardPage,
  buildFeedVideoCardPageResult,
  clampFeedPageSize,
  collectDistinctUploaderUserIds,
  emptyFeedPlacementAuditSummary,
  feedPlacementBucketOf,
  isExclusiveHomeFeedEligible,
  isFeedVisibilityPermitted,
  isLegacyHomeFeedEligible,
  isVerticalFeedEligible,
  mergeFeedPlacementAuditSummaries,
  selectPlacementFeedRows,
  summarizeFeedPlacements,
} from "../convex/feedContracts.ts";
import {
  FIXTURE_CHANNELS,
  buildDuplicateRowFixtureTable,
  buildFixtureAssetRow,
  buildMixedFixtureTable,
  expectedVerticalFeedIds,
} from "./vertical-feed-data-fixtures.ts";

/**
 * A complete audit over a fully materialized table, wired the way
 * `feedPlacement.getFeedPlacementAuditPage` wires it: the production consistency
 * predicate, and a duplicate check over every row rather than one page.
 */
function auditRows(
  rows: readonly PlacementFeedAsset[],
): FeedPlacementAuditSummary {
  return summarizeFeedPlacements(rows, {
    scanComplete: true,
    isClassificationConsistent: isStoredAspectClassificationConsistent,
    hasDuplicateMuxAssetId: buildDuplicateMuxAssetIdPredicate(rows),
  });
}

const CONVEX_DIR = join(dirname(fileURLToPath(import.meta.url)), "../convex");
const FEED_SOURCE = readFileSync(join(CONVEX_DIR, "feed.ts"), "utf8");
const SCHEMA_SOURCE = readFileSync(join(CONVEX_DIR, "schema.ts"), "utf8");

const { rows: MIXED_ROWS, specs: MIXED_SPECS } = buildMixedFixtureTable();

/** Hidden fixtures are named so expectations can be derived without the code. */
const HIDDEN_SPECS = MIXED_SPECS.filter((spec) =>
  spec.muxAssetId.startsWith("hidden_"),
);
const PLAYABLE_SPECS = MIXED_SPECS.filter(
  (spec) => !spec.muxAssetId.startsWith("hidden_"),
);

/* ------------------------------------------------------------------ *
 * A minimal stand-in for Convex pagination over the placement index
 * ------------------------------------------------------------------ */

type FakePaginatedRows<TAsset> = {
  page: TAsset[];
  isDone: boolean;
  continueCursor: string;
};

/**
 * Applies the index range first, newest-first, and only then the cursor, which
 * is the ordering Convex uses. Filtering after pagination is modeled separately
 * below so the two behaviors can be compared.
 */
function paginateThroughPlacementIndex<TAsset extends PlacementFeedAsset>(
  rows: readonly TAsset[],
  placement: FeedPlacement,
  opts: { cursor: string | null; numItems: number },
): FakePaginatedRows<TAsset> {
  const ordered = selectPlacementFeedRows(rows, placement);
  const offset = opts.cursor === null ? 0 : Number.parseInt(opts.cursor, 10);
  const page = ordered.slice(offset, offset + clampFeedPageSize(opts.numItems));
  const nextOffset = offset + page.length;

  return {
    page,
    isDone: nextOffset >= ordered.length,
    continueCursor: String(nextOffset),
  };
}

/** The mistake the placement index exists to prevent. */
function paginateThenFilter<TAsset extends PlacementFeedAsset>(
  rows: readonly TAsset[],
  placement: FeedPlacement,
  opts: { cursor: string | null; numItems: number },
): FakePaginatedRows<TAsset> {
  const ordered = rows
    .filter((row) => row.isReady === true && row.isDeleted === false)
    .slice()
    .sort((left, right) => (right.createdAtMs ?? 0) - (left.createdAtMs ?? 0));
  const offset = opts.cursor === null ? 0 : Number.parseInt(opts.cursor, 10);
  const window = ordered.slice(offset, offset + clampFeedPageSize(opts.numItems));
  const nextOffset = offset + window.length;

  return {
    page: window.filter((row) => row.feedPlacement === placement),
    isDone: nextOffset >= ordered.length,
    continueCursor: String(nextOffset),
  };
}

type PlacementPaginator = (
  rows: readonly PlacementFeedAsset[],
  placement: FeedPlacement,
  opts: { cursor: string | null; numItems: number },
) => FakePaginatedRows<PlacementFeedAsset>;

function walkVerticalFeed(
  rows: readonly PlacementFeedAsset[],
  pageSize: number,
  paginate: PlacementPaginator = paginateThroughPlacementIndex,
): { pages: FeedVideoCardItem[][]; cards: FeedVideoCardItem[] } {
  const pages: FeedVideoCardItem[][] = [];
  let cursor: string | null = null;

  for (let guard = 0; guard < 1000; guard += 1) {
    const paginated = paginate(rows, VERTICAL_FEED_PLACEMENT, {
      cursor,
      numItems: pageSize,
    });
    const result = buildFeedVideoCardPageResult(paginated, FIXTURE_CHANNELS);
    pages.push(result.page);

    if (result.isDone) break;
    cursor = result.continueCursor;
  }

  return { pages, cards: pages.flat() };
}

/* ------------------------------------------------------------------ *
 * Index contract
 * ------------------------------------------------------------------ */

test("the placement index is declared with placement first", () => {
  assert.deepEqual([...FEED_PLACEMENT_INDEX_FIELDS], [
    "feedPlacement",
    "isReady",
    "isDeleted",
    "createdAtMs",
  ]);

  const declaration = SCHEMA_SOURCE.slice(
    SCHEMA_SOURCE.indexOf(`.index("${FEED_PLACEMENT_INDEX_NAME}"`),
  ).slice(0, 220);

  assert.notEqual(
    SCHEMA_SOURCE.indexOf(`.index("${FEED_PLACEMENT_INDEX_NAME}"`),
    -1,
    "schema must declare the placement index",
  );
  for (const field of FEED_PLACEMENT_INDEX_FIELDS) {
    assert.ok(
      declaration.includes(`"${field}"`),
      `index declaration must include ${field}`,
    );
  }
  // Field order matters: the cursor is applied after the index range.
  const positions = FEED_PLACEMENT_INDEX_FIELDS.map((field) =>
    declaration.indexOf(`"${field}"`),
  );
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
});

test("the index range pins placement, readiness, and deletion in order", () => {
  const calls: [string, unknown][] = [];
  const recorder = {
    eq(field: string, value: unknown) {
      calls.push([field, value]);
      return recorder;
    },
  };

  applyPlacementIndexRange(recorder, VERTICAL_FEED_PLACEMENT);

  assert.deepEqual(calls, [
    ["feedPlacement", "vertical"],
    ["isReady", true],
    ["isDeleted", false],
  ]);

  calls.length = 0;
  applyPlacementIndexRange(recorder, STANDARD_FEED_PLACEMENT);
  assert.deepEqual(calls[0], ["feedPlacement", "standard"]);
});

test("page size is clamped to the shared card-feed budget", () => {
  assert.equal(clampFeedPageSize(8), 8);
  assert.equal(clampFeedPageSize(FEED_PLACEMENT_MAX_PAGE_SIZE), 24);
  assert.equal(clampFeedPageSize(1000), FEED_PLACEMENT_MAX_PAGE_SIZE);
  assert.equal(clampFeedPageSize(0), 1);
  assert.equal(clampFeedPageSize(-5), 1);
  assert.equal(clampFeedPageSize(3.7), 3);
  assert.equal(clampFeedPageSize(Number.NaN), 1);
});

/* ------------------------------------------------------------------ *
 * The shipped query: index-only selection, no Mux reads
 * ------------------------------------------------------------------ */

function extractSourceBlock(header: string, terminator: string) {
  const start = FEED_SOURCE.indexOf(header);
  assert.notEqual(start, -1, `convex/feed.ts must define ${header}`);
  const end = FEED_SOURCE.indexOf(terminator, start);
  assert.notEqual(end, -1, `${header} must be terminated by ${terminator}`);
  return FEED_SOURCE.slice(start, end);
}

test("the placement page helper selects through the index and nothing else", () => {
  const helper = extractSourceBlock(
    "async function paginatePlacementFeedCards(",
    "\n}",
  );

  for (const expected of [
    "FEED_PLACEMENT_INDEX_NAME",
    "applyPlacementIndexRange",
    'order("desc")',
    ".paginate(",
    "clampFeedPageSize",
    "collectDistinctUploaderUserIds",
    "buildFeedVideoCardPageResult",
  ]) {
    assert.ok(helper.includes(expected), `helper must use ${expected}`);
  }

  // The hot path performs no per-video Mux component read, and never filters a
  // page after pagination.
  for (const forbidden of ["components.mux", "runQuery", ".filter("]) {
    assert.equal(helper.includes(forbidden), false, `helper must not use ${forbidden}`);
  }
});

test("both placement queries go through the shared helper", () => {
  const vertical = extractSourceBlock(
    "export const listVerticalFeedVideosPaginated = query({",
    "\n});",
  );
  const standard = extractSourceBlock(
    "export const listStandardFeedVideosPaginated = query({",
    "\n});",
  );

  assert.ok(vertical.includes("paginatePlacementFeedCards"));
  assert.ok(vertical.includes("VERTICAL_FEED_PLACEMENT"));
  assert.ok(vertical.includes("paginationOptsValidator"));
  assert.equal(vertical.includes("components.mux"), false);
  assert.equal(vertical.includes("runQuery"), false);

  assert.ok(standard.includes("paginatePlacementFeedCards"));
  assert.ok(standard.includes("STANDARD_FEED_PLACEMENT"));
  assert.equal(standard.includes("components.mux"), false);
});

test("Home still reads the unfiltered ready index before the cutover", () => {
  const home = extractSourceBlock(
    "export const listFeedVideosPaginated = query({",
    "\n});",
  );

  assert.ok(home.includes('withIndex("by_ready_deleted_created"'));
  assert.equal(home.includes("feedPlacement"), false);
  assert.equal(home.includes(FEED_PLACEMENT_INDEX_NAME), false);
});

/* ------------------------------------------------------------------ *
 * Visibility: inclusion, exclusion, and parity with Home's card rules
 * ------------------------------------------------------------------ */

test("every exact 9:16 asset is returned", () => {
  const { cards } = walkVerticalFeed(MIXED_ROWS, 6);
  const expected = expectedVerticalFeedIds(MIXED_SPECS);

  assert.ok(expected.length >= 10, "fixture must cover at least ten 9:16 assets");
  assert.deepEqual(
    cards.map((card) => card.muxAssetId),
    expected,
  );
});

test("16:9, 4:5, 1:1, unknown, and unclassified assets are excluded", () => {
  const { cards } = walkVerticalFeed(MIXED_ROWS, 6);
  const returned = new Set(cards.map((card) => card.muxAssetId));

  for (const spec of MIXED_SPECS) {
    if (spec.expectedPlacement === "vertical") continue;
    assert.equal(
      returned.has(spec.muxAssetId),
      false,
      `${spec.note} must not appear in the vertical feed`,
    );
  }

  // Named coverage for the ratios the PRD calls out explicitly.
  for (const source of ["16:9", "4:5", "1:1", "2:3", "10:16"]) {
    const row = buildFixtureAssetRow({
      muxAssetId: `ratio_${source}`,
      sourceAspectRatio: source,
    });
    assert.equal(isVerticalFeedEligible(row), false, source);
    assert.equal(isExclusiveHomeFeedEligible(row), true, source);
  }
});

test("deleted, not-ready, and playback-less 9:16 assets are excluded", () => {
  const { cards } = walkVerticalFeed(MIXED_ROWS, 24);
  const returned = new Set(cards.map((card) => card.muxAssetId));

  assert.ok(HIDDEN_SPECS.length >= 5, "fixture must cover the hidden cases");
  for (const spec of HIDDEN_SPECS) {
    assert.equal(returned.has(spec.muxAssetId), false, spec.note);
  }
});

test("a signed-only playback ID stays visible, matching Home", () => {
  const row = buildFixtureAssetRow({
    muxAssetId: "signed_only",
    sourceAspectRatio: "9:16",
    overrides: { playbackIds: [{ id: "pb-signed", policy: "signed" }] },
  });

  assert.equal(isVerticalFeedEligible(row), true);
  assert.equal(buildFeedVideoCard(row, FIXTURE_CHANNELS).card?.playbackId, "pb-signed");
});

test("vertical eligibility agrees with the Home card builder row by row", () => {
  for (const row of MIXED_ROWS) {
    const inIndexRange =
      row.feedPlacement === VERTICAL_FEED_PLACEMENT &&
      row.isReady === true &&
      row.isDeleted === false;
    const card = buildFeedVideoCard(row, FIXTURE_CHANNELS).card;

    assert.equal(
      isVerticalFeedEligible(row),
      inIndexRange && card !== null,
      `${row.muxAssetId} must apply the same readiness/deletion/playback rules as Home`,
    );
  }
});

test("the returned page is the card contract, with no placement leakage", () => {
  const { cards } = walkVerticalFeed(MIXED_ROWS, 8);

  for (const card of cards.slice(0, 5)) {
    assert.deepEqual(Object.keys(card).sort(), [
      "channelAvatarUrl",
      "channelName",
      "createdAtMs",
      "durationSeconds",
      "muxAssetId",
      "playbackId",
      "thumbnailUrl",
      "title",
    ]);
    assert.equal(Object.hasOwn(card, "aspectRatio"), false);
    assert.equal(Object.hasOwn(card, "feedPlacement"), false);
  }
});

/* ------------------------------------------------------------------ *
 * Cursor behavior across multiple pages
 * ------------------------------------------------------------------ */

test("a multi-page walk returns every card exactly once, newest first", () => {
  const expected = expectedVerticalFeedIds(MIXED_SPECS);

  for (const pageSize of [1, 2, 3, 5, 24]) {
    const { cards } = walkVerticalFeed(MIXED_ROWS, pageSize);
    const ids = cards.map((card) => card.muxAssetId);

    assert.deepEqual(ids, expected, `page size ${pageSize}`);
    assert.equal(new Set(ids).size, ids.length, `page size ${pageSize} duplicates`);

    const timestamps = cards.map((card) => card.createdAtMs);
    assert.deepEqual(
      timestamps,
      [...timestamps].sort((left, right) => right - left),
      `page size ${pageSize} ordering`,
    );
  }
});

test("assets sharing a creation timestamp are each returned once", () => {
  const tied = MIXED_SPECS.filter((spec) =>
    spec.muxAssetId.startsWith("vertical_same_timestamp_"),
  ).map((spec) => spec.muxAssetId);
  assert.equal(tied.length, 2);

  const { cards } = walkVerticalFeed(MIXED_ROWS, 1);
  const ids = cards.map((card) => card.muxAssetId);

  for (const muxAssetId of tied) {
    assert.equal(
      ids.filter((id) => id === muxAssetId).length,
      1,
      `${muxAssetId} must appear exactly once`,
    );
  }
});

test("index-filtered row pages stay full while post-filtered pages go short", () => {
  const pageSize = 6;

  const rowPageSizes = (paginate: PlacementPaginator) => {
    const sizes: number[] = [];
    let cursor: string | null = null;

    for (let guard = 0; guard < 1000; guard += 1) {
      const paginated = paginate(MIXED_ROWS, VERTICAL_FEED_PLACEMENT, {
        cursor,
        numItems: pageSize,
      });
      sizes.push(paginated.page.length);
      if (paginated.isDone) break;
      cursor = paginated.continueCursor;
    }

    return sizes;
  };

  const indexed = rowPageSizes(paginateThroughPlacementIndex);
  const postFiltered = rowPageSizes(paginateThenFilter);

  for (const size of indexed.slice(0, -1)) {
    assert.equal(size, pageSize, "indexed row pages must not be short");
  }
  assert.ok(
    postFiltered.some((size) => size < pageSize),
    "post-pagination filtering is expected to produce short pages",
  );

  // Both eventually surface the same cards; only the page shapes differ. This is
  // why placement leads the index rather than being filtered afterwards.
  assert.deepEqual(
    walkVerticalFeed(MIXED_ROWS, pageSize, paginateThenFilter).cards.map(
      (card) => card.muxAssetId,
    ),
    walkVerticalFeed(MIXED_ROWS, pageSize).cards.map((card) => card.muxAssetId),
  );
});

test("visibility and playback hiding shrink a card page without losing cards", () => {
  const pageSize = 4;
  const rows = [
    buildFixtureAssetRow({ muxAssetId: "keep_1", sourceAspectRatio: "9:16", createdAtMs: 90 }),
    buildFixtureAssetRow({
      muxAssetId: "drop_private",
      sourceAspectRatio: "9:16",
      createdAtMs: 80,
      overrides: { feedVisibility: "private" },
    }),
    buildFixtureAssetRow({
      muxAssetId: "drop_no_playback",
      sourceAspectRatio: "9:16",
      createdAtMs: 70,
      overrides: { playbackIds: [] },
    }),
    buildFixtureAssetRow({ muxAssetId: "keep_2", sourceAspectRatio: "9:16", createdAtMs: 60 }),
    buildFixtureAssetRow({ muxAssetId: "keep_3", sourceAspectRatio: "9:16", createdAtMs: 50 }),
  ];

  const { pages, cards } = walkVerticalFeed(rows, pageSize);

  // The first page is short because two of its rows are withheld, and no card is
  // pushed past the cursor where it would be lost.
  assert.deepEqual(pages[0]?.map((card) => card.muxAssetId), ["keep_1", "keep_2"]);
  assert.deepEqual(cards.map((card) => card.muxAssetId), [
    "keep_1",
    "keep_2",
    "keep_3",
  ]);
});

test("interleaved standard and vertical creation times do not disturb paging", () => {
  const rows: PlacementFeedAsset[] = [];
  for (let index = 0; index < 60; index += 1) {
    rows.push(
      buildFixtureAssetRow({
        muxAssetId: `interleaved_${String(index).padStart(2, "0")}`,
        sourceAspectRatio: index % 3 === 0 ? "1080:1920" : "1920:1080",
        createdAtMs: 1_800_000_000_000 - index * 60_000,
      }),
    );
  }

  const { cards } = walkVerticalFeed(rows, 4);
  const expected = rows
    .filter((row) => row.feedPlacement === VERTICAL_FEED_PLACEMENT)
    .map((row) => row.muxAssetId);

  assert.equal(expected.length, 20);
  assert.deepEqual(cards.map((card) => card.muxAssetId), expected);
});

test("an empty vertical feed returns one finished empty page", () => {
  const standardOnly = [
    buildFixtureAssetRow({ muxAssetId: "s1", sourceAspectRatio: "16:9" }),
    buildFixtureAssetRow({ muxAssetId: "s2", sourceAspectRatio: "4:5" }),
  ];

  const { pages, cards } = walkVerticalFeed(standardOnly, 12);

  assert.equal(cards.length, 0);
  assert.deepEqual(pages, [[]]);
});

/* ------------------------------------------------------------------ *
 * Channel resolution
 * ------------------------------------------------------------------ */

test("each uploader is resolved at most once per page", () => {
  const rows = Array.from({ length: FEED_PLACEMENT_MAX_PAGE_SIZE }, (_, index) =>
    buildFixtureAssetRow({
      muxAssetId: `page_${index}`,
      sourceAspectRatio: "9:16",
      uploaderUserId: ["user_a", "user_b", "user_c"][index % 3],
      createdAtMs: 1_800_000_000_000 - index,
    }),
  );

  const paginated = paginateThroughPlacementIndex(rows, VERTICAL_FEED_PLACEMENT, {
    cursor: null,
    numItems: FEED_PLACEMENT_MAX_PAGE_SIZE,
  });

  assert.equal(paginated.page.length, FEED_PLACEMENT_MAX_PAGE_SIZE);
  assert.deepEqual(collectDistinctUploaderUserIds(paginated.page), [
    "user_a",
    "user_b",
    "user_c",
  ]);
});

test("an uploader carried only in the passthrough still resolves", () => {
  const row = buildFixtureAssetRow({
    muxAssetId: "passthrough_only",
    sourceAspectRatio: "9:16",
    overrides: {
      feedUploaderUserId: undefined,
      passthrough: JSON.stringify({ userId: "user_b" }),
    },
  });

  const card = buildFeedVideoCard(row, FIXTURE_CHANNELS).card;
  assert.equal(card?.channelName, "Grace H");
});

/* ------------------------------------------------------------------ *
 * Response size and query cost
 * ------------------------------------------------------------------ */

function buildSizedVerticalPage(count: number) {
  const rows = Array.from({ length: count }, (_, index) =>
    buildFixtureAssetRow({
      muxAssetId: `01a2b3c4d5e6f70000000000${String(index).padStart(2, "0")}`,
      sourceAspectRatio: "1080:1920",
      uploaderUserId: index % 2 === 0 ? "user_a" : "user_b",
      createdAtMs: 1_800_000_000_000 - index * 1000,
      overrides: {
        feedTitle:
          "A representative vertical video title that runs about sixty characters",
      },
    }),
  );

  return buildFeedVideoCardPage(
    selectPlacementFeedRows(rows, VERTICAL_FEED_PLACEMENT),
    FIXTURE_CHANNELS,
  );
}

test("16 and 48 vertical cards stay inside the card-feed size budget", (t) => {
  for (const [count, budget] of [
    [16, 15_000],
    [48, 45_000],
  ] as const) {
    const page = buildSizedVerticalPage(count);
    const bytes = Buffer.byteLength(JSON.stringify(page), "utf8");

    t.diagnostic(
      `${count} vertical cards: ${bytes} bytes (${Math.round(bytes / count)} bytes/card)`,
    );
    assert.equal(page.length, count);
    assert.ok(
      bytes <= budget,
      `${count}-card response was ${bytes} bytes, expected <= ${budget}`,
    );
  }
});

test("card size does not grow with the number of pages walked", (t) => {
  const single = Buffer.byteLength(JSON.stringify(buildSizedVerticalPage(16)));
  const triple = Buffer.byteLength(JSON.stringify(buildSizedVerticalPage(48)));

  t.diagnostic(`16 cards ${single} bytes, 48 cards ${triple} bytes`);
  // Three pages of the same cards must cost about three pages, not more.
  assert.ok(triple <= single * 3.2);
});

/* ------------------------------------------------------------------ *
 * Placement audit and feed exclusivity
 * ------------------------------------------------------------------ */

test("the audit counts placements, overlap, and omissions", () => {
  const summary = auditRows(MIXED_ROWS);

  const expectedVertical = MIXED_SPECS.filter((spec) => spec.expectedEligible).length;
  const expectedStandard = PLAYABLE_SPECS.filter(
    (spec) => spec.expectedPlacement === "standard",
  ).length;
  const expectedOmitted = PLAYABLE_SPECS.filter(
    (spec) =>
      spec.expectedPlacement === "unknown" ||
      spec.expectedPlacement === "unclassified",
  ).length;

  assert.equal(summary.scanned, MIXED_ROWS.length);
  assert.equal(summary.playable, PLAYABLE_SPECS.length);
  assert.equal(summary.verticalFeedEligible, expectedVertical);
  assert.equal(summary.exclusiveHomeEligible, expectedStandard);
  assert.equal(summary.legacyHomeEligible, PLAYABLE_SPECS.length);

  // Nothing can be in both feeds after the cutover.
  assert.equal(summary.overlapExclusive, 0);
  // Legacy Home intentionally still shows vertical assets during migration.
  assert.equal(summary.overlapLegacyMigration, expectedVertical);
  assert.equal(summary.omittedAfterCutover, expectedOmitted);
  assert.ok(expectedOmitted > 0, "fixture must exercise a failing coverage gate");
  assert.equal(summary.coverageGatePassed, false);
  assert.equal(summary.playableUnknownRatio, expectedOmitted);
  assert.equal(summary.inconsistentClassification, 0);
  assert.equal(summary.duplicateIdRows, 0);
  assert.equal(summary.hiddenByVisibility, 1);

  assert.equal(
    summary.byPlacement.standard +
      summary.byPlacement.vertical +
      summary.byPlacement.unknown +
      summary.byPlacement.unclassified,
    MIXED_ROWS.length,
  );
});

test("every playable known asset lands in exactly one feed", () => {
  for (const row of MIXED_ROWS) {
    const feeds = [
      isVerticalFeedEligible(row),
      isExclusiveHomeFeedEligible(row),
    ].filter(Boolean).length;
    const bucket = feedPlacementBucketOf(row);
    const playable = isLegacyHomeFeedEligible(row);

    if (!playable) {
      assert.equal(feeds, 0, `${row.muxAssetId} is hidden from both feeds`);
      continue;
    }

    if (bucket === "vertical" || bucket === "standard") {
      assert.equal(feeds, 1, `${row.muxAssetId} must appear in exactly one feed`);
    } else {
      // Unknown rows stay on the legacy Home path until they are classified.
      assert.equal(feeds, 0, `${row.muxAssetId} is unclassified`);
      assert.equal(isLegacyHomeFeedEligible(row), true);
    }
  }
});

test("the coverage gate passes once every playable row is classified", () => {
  const backfilled = MIXED_ROWS.map((row) => {
    const bucket = feedPlacementBucketOf(row);
    if (bucket === "vertical" || bucket === "standard") return row;

    // Simulates the backfill resolving a ratio for a legacy row.
    return buildFixtureAssetRow({
      muxAssetId: row.muxAssetId,
      sourceAspectRatio: "1920:1080",
      createdAtMs: row.createdAtMs ?? 0,
      overrides: { playbackIds: row.playbackIds, isDeleted: row.isDeleted ?? false },
    });
  });

  const summary = auditRows(backfilled);

  assert.equal(summary.omittedAfterCutover, 0);
  assert.equal(summary.overlapExclusive, 0);
  assert.equal(summary.coverageGatePassed, true);
  assert.equal(
    summary.verticalFeedEligible + summary.exclusiveHomeEligible,
    summary.playable,
  );
});

test("an unrecognized stored placement counts as unclassified, not vertical", () => {
  const summary = auditRows([
    buildFixtureAssetRow({
      muxAssetId: "bogus_placement",
      sourceAspectRatio: "9:16",
      overrides: { feedPlacement: "shorts" },
    }),
    buildFixtureAssetRow({ muxAssetId: "fine", sourceAspectRatio: "9:16" }),
  ]);

  assert.equal(summary.byPlacement.unclassified, 1);
  assert.equal(summary.verticalFeedEligible, 1);
  assert.equal(summary.omittedAfterCutover, 1);
  assert.equal(summary.coverageGatePassed, false);
});

test("paged audit summaries merge into the whole-table summary", () => {
  const whole = auditRows(MIXED_ROWS);
  const hasDuplicateMuxAssetId = buildDuplicateMuxAssetIdPredicate(MIXED_ROWS);
  const pageSize = 7;
  const pages = [];

  for (let offset = 0; offset < MIXED_ROWS.length; offset += pageSize) {
    pages.push(
      summarizeFeedPlacements(MIXED_ROWS.slice(offset, offset + pageSize), {
        // A page is never a complete scan on its own; the walk decides.
        scanComplete: false,
        isClassificationConsistent: isStoredAspectClassificationConsistent,
        hasDuplicateMuxAssetId,
      }),
    );
  }

  assert.ok(pages.length > 1);
  assert.deepEqual(
    mergeFeedPlacementAuditSummaries(pages, { scanComplete: true }),
    whole,
  );
  assert.deepEqual(
    mergeFeedPlacementAuditSummaries([], { scanComplete: false }),
    emptyFeedPlacementAuditSummary(),
  );
});

test("a partial scan never reports a passing coverage gate", () => {
  const clean = MIXED_ROWS.filter((row) => {
    const bucket = feedPlacementBucketOf(row);
    return bucket === "vertical" || bucket === "standard";
  });

  const complete = auditRows(clean);
  const partial = summarizeFeedPlacements(clean, {
    scanComplete: false,
    isClassificationConsistent: isStoredAspectClassificationConsistent,
    hasDuplicateMuxAssetId: buildDuplicateMuxAssetIdPredicate(clean),
  });

  // Identical rows and identical counts: only completeness differs.
  assert.equal(complete.omittedAfterCutover, 0);
  assert.equal(complete.coverageGatePassed, true);
  assert.equal(partial.omittedAfterCutover, 0);
  assert.equal(partial.scanComplete, false);
  assert.equal(partial.coverageGatePassed, false);

  // Merging complete pages under an incomplete walk stays failed.
  assert.equal(
    mergeFeedPlacementAuditSummaries([complete], { scanComplete: false })
      .coverageGatePassed,
    false,
  );
});

test("an empty table passes the gate only when the scan completed", () => {
  const complete = auditRows([]);
  const partial = summarizeFeedPlacements([], {
    scanComplete: false,
    isClassificationConsistent: isStoredAspectClassificationConsistent,
    hasDuplicateMuxAssetId: () => false,
  });

  assert.equal(complete.scanned, 0);
  assert.equal(complete.coverageGatePassed, true);
  assert.equal(partial.coverageGatePassed, false);
  assert.deepEqual(partial, emptyFeedPlacementAuditSummary());
});

/* ------------------------------------------------------------------ *
 * Private visibility
 * ------------------------------------------------------------------ */

test("a private 9:16 asset is withheld from every feed", () => {
  const privateRow = buildFixtureAssetRow({
    muxAssetId: "private_vertical",
    sourceAspectRatio: "1080:1920",
    overrides: { feedVisibility: "private" },
  });

  assert.equal(isVerticalFeedEligible(privateRow), false);
  assert.equal(isExclusiveHomeFeedEligible(privateRow), false);
  assert.equal(isLegacyHomeFeedEligible(privateRow), false);
  assert.equal(isFeedVisibilityPermitted(privateRow), false);
  assert.deepEqual(buildFeedVideoCard(privateRow, FIXTURE_CHANNELS), {
    card: null,
    hiddenReason: "private_visibility",
  });

  const { cards } = walkVerticalFeed([privateRow], 12);
  assert.deepEqual(cards, []);
});

test("a private standard asset is withheld from the standard feed too", () => {
  const privateRow = buildFixtureAssetRow({
    muxAssetId: "private_standard",
    sourceAspectRatio: "16:9",
    overrides: { feedVisibility: "private" },
  });

  assert.equal(isExclusiveHomeFeedEligible(privateRow), false);
  assert.deepEqual(
    buildFeedVideoCardPage(
      selectPlacementFeedRows([privateRow], STANDARD_FEED_PLACEMENT),
      FIXTURE_CHANNELS,
    ),
    [],
  );
});

test("public, unlisted, and never-written visibility all stay visible", () => {
  for (const feedVisibility of ["public", "unlisted", undefined]) {
    const row = buildFixtureAssetRow({
      muxAssetId: `visible_${String(feedVisibility)}`,
      sourceAspectRatio: "9:16",
      overrides: { feedVisibility },
    });

    assert.equal(isFeedVisibilityPermitted(row), true, String(feedVisibility));
    assert.equal(isVerticalFeedEligible(row), true, String(feedVisibility));
  }

  // An unrecognized value is not "private", so it does not hide the card.
  assert.equal(isFeedVisibilityPermitted({ feedVisibility: "restricted" }), true);
});

test("private rows are counted, not silently dropped, by the audit", () => {
  const summary = auditRows([
    buildFixtureAssetRow({
      muxAssetId: "audit_private",
      sourceAspectRatio: "9:16",
      overrides: { feedVisibility: "private" },
    }),
    buildFixtureAssetRow({
      muxAssetId: "audit_public",
      sourceAspectRatio: "9:16",
      overrides: { feedVisibility: "public" },
    }),
  ]);

  assert.equal(summary.scanned, 2);
  assert.equal(summary.hiddenByVisibility, 1);
  assert.equal(summary.playable, 1);
  assert.equal(summary.verticalFeedEligible, 1);
  // A withheld row is not an omission: it is not eligible for any feed.
  assert.equal(summary.omittedAfterCutover, 0);
  assert.equal(summary.coverageGatePassed, true);
});

/* ------------------------------------------------------------------ *
 * Duplicate cache rows
 * ------------------------------------------------------------------ */

test("a page never emits the same asset twice", () => {
  const { rows, duplicatedMuxAssetId } = buildDuplicateRowFixtureTable();
  const { pages, cards } = walkVerticalFeed(rows, 24);

  assert.equal(pages.length, 1);
  assert.deepEqual(cards.map((card) => card.muxAssetId), [
    duplicatedMuxAssetId,
    "vertical_unique",
  ]);
});

test("the first playable row wins when an asset is stored twice", () => {
  const hiddenFirst = [
    buildFixtureAssetRow({
      muxAssetId: "dup",
      sourceAspectRatio: "9:16",
      createdAtMs: 20,
      overrides: { playbackIds: [] },
    }),
    buildFixtureAssetRow({
      muxAssetId: "dup",
      sourceAspectRatio: "9:16",
      createdAtMs: 10,
      overrides: { playbackIds: [{ id: "pb-second", policy: "public" }] },
    }),
  ];

  const cards = buildFeedVideoCardPage(
    selectPlacementFeedRows(hiddenFirst, VERTICAL_FEED_PLACEMENT),
    FIXTURE_CHANNELS,
  );

  // A hidden duplicate does not consume the asset's single slot.
  assert.deepEqual(cards.map((card) => card.playbackId), ["pb-second"]);
});

test("duplicate ready rows fail the coverage gate", () => {
  const { rows, duplicatedMuxAssetId } = buildDuplicateRowFixtureTable();
  const summary = auditRows(rows);

  assert.equal(summary.scanned, 3);
  assert.equal(summary.playable, 3);
  // Both rows of the pair are reported, so the count locates the damage.
  assert.equal(summary.duplicateIdRows, 2);
  assert.equal(summary.omittedAfterCutover, 0);
  assert.equal(summary.inconsistentClassification, 0);
  assert.equal(summary.coverageGatePassed, false);

  const predicate = buildDuplicateMuxAssetIdPredicate(rows);
  assert.equal(predicate({ muxAssetId: duplicatedMuxAssetId }), true);
  assert.equal(predicate({ muxAssetId: "vertical_unique" }), false);
});

test("duplicate rows are counted across audit pages, not per page", () => {
  const { rows } = buildDuplicateRowFixtureTable();
  // The duplicate pair is split across two pages, as the cursor walk may split it.
  const hasDuplicateMuxAssetId = buildDuplicateMuxAssetIdPredicate(rows);
  const pages = [rows.slice(0, 1), rows.slice(1)].map((page) =>
    summarizeFeedPlacements(page, {
      scanComplete: false,
      isClassificationConsistent: isStoredAspectClassificationConsistent,
      hasDuplicateMuxAssetId,
    }),
  );

  assert.deepEqual(pages.map((page) => page.duplicateIdRows), [1, 1]);

  const merged = mergeFeedPlacementAuditSummaries(pages, { scanComplete: true });
  assert.equal(merged.duplicateIdRows, 2);
  assert.equal(merged.coverageGatePassed, false);
});

test("a duplicate pair split across cursor pages is caught by the gate", () => {
  const { rows, duplicatedMuxAssetId } = buildDuplicateRowFixtureTable();
  const { cards } = walkVerticalFeed(rows, 1);
  const emitted = cards.filter((card) => card.muxAssetId === duplicatedMuxAssetId);

  // A stateless page builder cannot collapse a pair that straddles two pages,
  // which is exactly why the audit gate refuses to pass while duplicates exist.
  assert.equal(emitted.length, 2);
  assert.equal(auditRows(rows).coverageGatePassed, false);
});

/* ------------------------------------------------------------------ *
 * Stored-classification integrity
 * ------------------------------------------------------------------ */

test("a stored 9:16 marked standard fails the gate", () => {
  const corrupt = buildFixtureAssetRow({
    muxAssetId: "corrupt_standard",
    sourceAspectRatio: "9:16",
    overrides: { aspectRatio: "9:16", feedPlacement: "standard" },
  });
  const summary = auditRows([
    corrupt,
    buildFixtureAssetRow({ muxAssetId: "clean", sourceAspectRatio: "16:9" }),
  ]);

  assert.equal(summary.inconsistentClassification, 1);
  assert.equal(summary.omittedAfterCutover, 0);
  assert.equal(summary.coverageGatePassed, false);

  // The corrupt row is served by the wrong feed until it is reclassified, which
  // is the damage the gate is refusing to sign off on.
  assert.equal(isExclusiveHomeFeedEligible(corrupt), true);
  assert.equal(isVerticalFeedEligible(corrupt), false);
});

test("an unnormalized stored ratio fails the gate", () => {
  const summary = auditRows([
    buildFixtureAssetRow({
      muxAssetId: "unnormalized",
      sourceAspectRatio: "9:16",
      overrides: { aspectRatio: "1080:1920", feedPlacement: "vertical" },
    }),
  ]);

  assert.equal(summary.inconsistentClassification, 1);
  assert.equal(summary.coverageGatePassed, false);
});

test("a fully classified, unique, consistent table passes the gate", () => {
  const rows = [
    buildFixtureAssetRow({ muxAssetId: "v1", sourceAspectRatio: "9:16" }),
    buildFixtureAssetRow({ muxAssetId: "v2", sourceAspectRatio: "1080:1920" }),
    buildFixtureAssetRow({ muxAssetId: "s1", sourceAspectRatio: "16:9" }),
    buildFixtureAssetRow({ muxAssetId: "s2", sourceAspectRatio: "4:5" }),
  ];

  const summary = auditRows(rows);

  assert.equal(summary.coverageGatePassed, true);
  assert.equal(summary.scanComplete, true);
  assert.equal(summary.duplicateIdRows, 0);
  assert.equal(summary.inconsistentClassification, 0);
  assert.equal(summary.verticalFeedEligible, 2);
  assert.equal(summary.exclusiveHomeEligible, 2);
});
