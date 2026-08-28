/**
 * Feed data-contract projection, pagination, and fallback tests.
 *
 * The repository has no test runner dependency, so these run on the Node
 * built-in runner with type stripping:
 *
 *   node --experimental-strip-types --test tests/feed-contracts.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type FeedChannelInfo,
  type FeedReadModelAsset,
  DEFAULT_CHANNEL_NAME,
  FEED_VIDEO_CARD_FIELDS,
  buildFeedCardTitle,
  buildFeedThumbnailUrl,
  buildFeedVideoCard,
  buildFeedVideoCardPage,
  buildFeedVideoCardPageResult,
  collectDistinctUploaderUserIds,
  deriveChannelNameFromUser,
  parsePassthroughUserId,
  projectToFeedVideoCardItem,
  resolveFeedUploaderUserId,
  selectFeedPlaybackId,
} from "../convex/feedContracts.ts";

/** The complete feed-card field list. */
const SECTION_7_4_FIELDS = [
  "muxAssetId",
  "playbackId",
  "thumbnailUrl",
  "title",
  "channelName",
  "channelAvatarUrl",
  "durationSeconds",
  "createdAtMs",
];

/** Fields that belong to the video-detail contract and must never ship in a card. */
const DETAIL_ONLY_FIELDS = [
  "playbackUrl",
  "summary",
  "tags",
  "chapters",
  "keyMoments",
  "keyMomentsGeneratedAtMs",
  "keyMomentsUnavailableReason",
];

function makeAsset(
  overrides: Partial<FeedReadModelAsset> & { muxAssetId: string },
): FeedReadModelAsset {
  return {
    status: "ready",
    isDeleted: false,
    durationSeconds: 128,
    createdAtMs: 1_700_000_000_000,
    playbackIds: [{ id: `pb-${overrides.muxAssetId}`, policy: "public" }],
    feedTitle: `Title ${overrides.muxAssetId}`,
    feedUploaderUserId: "user_a",
    ...overrides,
  };
}

const CHANNELS: ReadonlyMap<string, FeedChannelInfo> = new Map([
  [
    "user_a",
    { channelName: "@ada", channelAvatarUrl: "https://cdn.example/a.png" },
  ],
  ["user_b", { channelName: "Grace H", channelAvatarUrl: null }],
]);

/* ------------------------------------------------------------------ *
 * Response shape
 * ------------------------------------------------------------------ */

test("card contract matches PRD section 7.4 exactly", () => {
  assert.deepEqual([...FEED_VIDEO_CARD_FIELDS], SECTION_7_4_FIELDS);
});

test("a built card exposes only the section 7.4 fields", () => {
  const result = buildFeedVideoCard(makeAsset({ muxAssetId: "a1" }), CHANNELS);

  assert.notEqual(result.card, null);
  assert.deepEqual(Object.keys(result.card!).sort(), [...SECTION_7_4_FIELDS].sort());
});

test("rich metadata on the source row never reaches the card", () => {
  const asset = {
    ...makeAsset({ muxAssetId: "a2" }),
    summary: "a long AI summary",
    tags: ["ai", "mux"],
    chapters: [{ title: "Intro", startTime: 0 }],
    keyMoments: [{ startMs: 0, endMs: 1000, cues: [] }],
    keyMomentsGeneratedAtMs: 1,
    keyMomentsUnavailableReason: "pending",
  } as FeedReadModelAsset;

  const card = buildFeedVideoCard(asset, CHANNELS).card!;

  for (const field of DETAIL_ONLY_FIELDS) {
    assert.equal(
      Object.hasOwn(card, field),
      false,
      `card must not serialize detail field "${field}"`,
    );
  }
});

test("projection drops any extra key added upstream", () => {
  const card = buildFeedVideoCard(makeAsset({ muxAssetId: "a3" }), CHANNELS).card!;
  const contaminated = {
    ...card,
    summary: "should not ship",
    transcriptCues: [{ startMs: 0, endMs: 1, text: "hello" }],
  };

  const projected = projectToFeedVideoCardItem(contaminated);

  assert.deepEqual(Object.keys(projected).sort(), [...SECTION_7_4_FIELDS].sort());
  assert.deepEqual(projected, card);
});

test("a 16-card page serializes well under the 15 KB budget", () => {
  const assets = Array.from({ length: 16 }, (_, index) =>
    makeAsset({
      muxAssetId: `01a2b3c4d5e6f70000000000${String(index).padStart(2, "0")}`,
      feedTitle:
        "A representative feed video title that runs about sixty characters",
      feedUploaderUserId: index % 2 === 0 ? "user_a" : "user_b",
    }),
  );

  const page = buildFeedVideoCardPage(assets, CHANNELS);
  const serializedBytes = Buffer.byteLength(JSON.stringify(page), "utf8");

  assert.equal(page.length, 16);
  assert.ok(
    serializedBytes <= 15_000,
    `16-card response was ${serializedBytes} bytes, expected <= 15000`,
  );
});

/* ------------------------------------------------------------------ *
 * Pagination
 * ------------------------------------------------------------------ */

test("page result passes cursor fields through untouched", () => {
  const paginated = {
    page: [makeAsset({ muxAssetId: "p1" }), makeAsset({ muxAssetId: "p2" })],
    isDone: false,
    continueCursor: "cursor-2",
    splitCursor: null,
    pageStatus: null,
  };

  const result = buildFeedVideoCardPageResult(paginated, CHANNELS);

  assert.equal(result.isDone, false);
  assert.equal(result.continueCursor, "cursor-2");
  assert.equal(result.splitCursor, null);
  assert.equal(result.pageStatus, null);
  assert.deepEqual(
    result.page.map((card) => card.muxAssetId),
    ["p1", "p2"],
  );
});

test("descending source order is preserved, not re-sorted", () => {
  const assets = [
    makeAsset({ muxAssetId: "newest", createdAtMs: 300 }),
    makeAsset({ muxAssetId: "middle", createdAtMs: 200 }),
    // Equal timestamps must keep index order rather than being reshuffled.
    makeAsset({ muxAssetId: "tie-first", createdAtMs: 200 }),
    makeAsset({ muxAssetId: "oldest", createdAtMs: 100 }),
  ];

  assert.deepEqual(
    buildFeedVideoCardPage(assets, CHANNELS).map((card) => card.muxAssetId),
    ["newest", "middle", "tie-first", "oldest"],
  );
});

test("hidden assets shrink a page but never drop a card past the cursor", () => {
  const pageOne = {
    page: [
      makeAsset({ muxAssetId: "v1", createdAtMs: 500 }),
      makeAsset({ muxAssetId: "hidden", createdAtMs: 400, playbackIds: [] }),
      makeAsset({ muxAssetId: "v2", createdAtMs: 300 }),
    ],
    isDone: false,
    continueCursor: "cursor-after-v2",
  };
  const pageTwo = {
    page: [
      makeAsset({ muxAssetId: "v3", createdAtMs: 200 }),
      makeAsset({ muxAssetId: "v4", createdAtMs: 100 }),
    ],
    isDone: true,
    continueCursor: "cursor-end",
  };

  const first = buildFeedVideoCardPageResult(pageOne, CHANNELS);
  const second = buildFeedVideoCardPageResult(pageTwo, CHANNELS);
  const ids = [...first.page, ...second.page].map((card) => card.muxAssetId);

  // The hidden row is filtered, every visible row survives exactly once, and
  // the combined feed is still strictly newest-first.
  assert.deepEqual(ids, ["v1", "v2", "v3", "v4"]);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(first.page.length, 2);

  const timestamps = [...first.page, ...second.page].map(
    (card) => card.createdAtMs,
  );
  assert.deepEqual(timestamps, [...timestamps].sort((a, b) => b - a));
});

/* ------------------------------------------------------------------ *
 * Missing-data fallbacks
 * ------------------------------------------------------------------ */

test("assets without a playback id are hidden", () => {
  assert.deepEqual(
    buildFeedVideoCard(makeAsset({ muxAssetId: "x", playbackIds: [] }), CHANNELS),
    { card: null, hiddenReason: "no_public_playback" },
  );
  assert.deepEqual(
    buildFeedVideoCard(
      makeAsset({ muxAssetId: "x", playbackIds: undefined }),
      CHANNELS,
    ),
    { card: null, hiddenReason: "no_public_playback" },
  );
  assert.deepEqual(
    buildFeedVideoCard(
      makeAsset({ muxAssetId: "x", playbackIds: [{ policy: "public" }] }),
      CHANNELS,
    ),
    { card: null, hiddenReason: "no_public_playback" },
  );
});

test("deleted and not-ready assets are hidden", () => {
  for (const overrides of [
    { isDeleted: true },
    { deletedAtMs: 1_700_000_000_001 },
    { status: "preparing" },
    { status: undefined },
  ]) {
    assert.equal(
      buildFeedVideoCard(
        makeAsset({ muxAssetId: "gone", ...overrides }),
        CHANNELS,
      ).hiddenReason,
      "not_ready_or_deleted",
    );
  }
});

test("a public playback id wins over a signed one", () => {
  assert.equal(
    selectFeedPlaybackId([
      { id: "signed-id", policy: "signed" },
      { id: "public-id", policy: "public" },
    ]),
    "public-id",
  );
  // No public policy available: fall back to the first usable id.
  assert.equal(
    selectFeedPlaybackId([{ id: "signed-id", policy: "signed" }]),
    "signed-id",
  );
  assert.equal(selectFeedPlaybackId("not-an-array"), null);
});

test("a selected Robots thumbnail timestamp is carried into the image URL", () => {
  assert.equal(
    buildFeedThumbnailUrl("playback-1", 1280, 42_500),
    "https://image.mux.com/playback-1/thumbnail.jpg?width=1280&time=42.5",
  );

  const card = buildFeedVideoCard(
    makeAsset({ muxAssetId: "thumb", feedThumbnailTimestampMs: 118_500 }),
    CHANNELS,
  ).card!;
  assert.match(card.thumbnailUrl, /[?&]time=118\.5(?:&|$)/);
});

test("a missing title falls back to a deterministic placeholder", () => {
  const card = buildFeedVideoCard(
    makeAsset({ muxAssetId: "abcdef123456", feedTitle: undefined }),
    CHANNELS,
  ).card!;

  assert.equal(card.title, "Video abcdef");
  assert.equal(buildFeedCardTitle("   ", "abcdef123456"), "Video abcdef");
  assert.equal(buildFeedCardTitle("Real title", "abcdef123456"), "Real title");
});

test("a missing uploader falls back to the default channel and no avatar", () => {
  const card = buildFeedVideoCard(
    makeAsset({ muxAssetId: "n1", feedUploaderUserId: undefined }),
    CHANNELS,
  ).card!;

  assert.equal(card.channelName, DEFAULT_CHANNEL_NAME);
  assert.equal(card.channelAvatarUrl, null);
});

test("an unresolvable uploader falls back to the default channel", () => {
  const card = buildFeedVideoCard(
    makeAsset({ muxAssetId: "n2", feedUploaderUserId: "user_missing" }),
    CHANNELS,
  ).card!;

  assert.equal(card.channelName, DEFAULT_CHANNEL_NAME);
  assert.equal(card.channelAvatarUrl, null);
});

test("an uploader without an avatar still resolves its channel name", () => {
  const card = buildFeedVideoCard(
    makeAsset({ muxAssetId: "n3", feedUploaderUserId: "user_b" }),
    CHANNELS,
  ).card!;

  assert.equal(card.channelName, "Grace H");
  assert.equal(card.channelAvatarUrl, null);
});

test("an explicit channel-name override wins over the uploader name", () => {
  const card = buildFeedVideoCard(
    makeAsset({ muxAssetId: "n4", feedChannelName: "Robotube Live" }),
    CHANNELS,
  ).card!;

  assert.equal(card.channelName, "Robotube Live");
  // The override changes the name only; the uploader avatar is still used.
  assert.equal(card.channelAvatarUrl, "https://cdn.example/a.png");
});

test("channel name derivation follows username, name, email, default", () => {
  assert.equal(
    deriveChannelNameFromUser({ username: "ada", name: "Ada L" }),
    "@ada",
  );
  assert.equal(deriveChannelNameFromUser({ name: "Ada L" }), "Ada L");
  assert.equal(deriveChannelNameFromUser({ email: "ada@example.com" }), "ada");
  assert.equal(deriveChannelNameFromUser({}), DEFAULT_CHANNEL_NAME);
  assert.equal(deriveChannelNameFromUser(null), DEFAULT_CHANNEL_NAME);
});

test("a missing duration or creation timestamp degrades safely", () => {
  const card = buildFeedVideoCard(
    makeAsset({
      muxAssetId: "n5",
      durationSeconds: undefined,
      createdAtMs: undefined,
    }),
    CHANNELS,
  ).card!;

  assert.equal(card.durationSeconds, null);
  assert.equal(card.createdAtMs, 0);
});

/* ------------------------------------------------------------------ *
 * Uploader resolution and de-duplication
 * ------------------------------------------------------------------ */

test("uploader falls back to the passthrough user id before backfill", () => {
  const asset = makeAsset({
    muxAssetId: "n6",
    feedUploaderUserId: undefined,
    passthrough: JSON.stringify({ userId: "user_b", visibility: "public" }),
  });

  assert.equal(resolveFeedUploaderUserId(asset), "user_b");
  assert.equal(buildFeedVideoCard(asset, CHANNELS).card!.channelName, "Grace H");
});

test("the denormalized uploader wins over the passthrough uploader", () => {
  assert.equal(
    resolveFeedUploaderUserId({
      feedUploaderUserId: "user_a",
      passthrough: JSON.stringify({ userId: "user_b" }),
    }),
    "user_a",
  );
});

test("malformed passthrough values never throw", () => {
  assert.equal(parsePassthroughUserId("not json"), null);
  assert.equal(parsePassthroughUserId(JSON.stringify({ userId: 42 })), null);
  assert.equal(parsePassthroughUserId(JSON.stringify(["user_a"])), null);
  assert.equal(parsePassthroughUserId(null), null);
  assert.equal(parsePassthroughUserId(""), null);
});

test("uploaders are resolved once per distinct uploader, not once per video", () => {
  const assets = [
    makeAsset({ muxAssetId: "d1", feedUploaderUserId: "user_a" }),
    makeAsset({ muxAssetId: "d2", feedUploaderUserId: "user_a" }),
    makeAsset({ muxAssetId: "d3", feedUploaderUserId: "user_b" }),
    makeAsset({
      muxAssetId: "d4",
      feedUploaderUserId: undefined,
      passthrough: JSON.stringify({ userId: "user_b" }),
    }),
    makeAsset({ muxAssetId: "d5", feedUploaderUserId: undefined }),
  ];

  assert.deepEqual(collectDistinctUploaderUserIds(assets), ["user_a", "user_b"]);
});
