/**
 * Deterministic aspect-ratio fixtures shared by the classification and vertical
 * feed tests.
 *
 * Fixture rows are classified through the production classifier
 * (`classifyMuxAssetPayloadAspect`) rather than by hand, so a fixture can never
 * assert a placement the shipping code would not produce.
 */

import {
  classifyMuxAssetPayloadAspect,
  type FeedPlacement,
} from "../convex/aspectClassification.ts";
import type {
  FeedChannelInfo,
  PlacementFeedAsset,
} from "../convex/feedContracts.ts";

/** At least ten source ratios that all reduce to exactly 9:16. */
export const VERTICAL_SOURCE_RATIOS = [
  "9:16",
  "18:32",
  "27:48",
  "45:80",
  "90:160",
  "144:256",
  "360:640",
  "540:960",
  "720:1280",
  "1080:1920",
  "1440:2560",
  "2160:3840",
  "009:016",
] as const;

/** At least ten valid ratios that must never qualify for the vertical feed. */
export const NON_QUALIFYING_SOURCE_RATIOS = [
  "16:9",
  "1920:1080",
  "1280:720",
  "4:5",
  "1:1",
  "2:3",
  "3:4",
  "4:3",
  "21:9",
  "10:16",
  "1000:1600",
  "9:17",
  "8:15",
] as const;

/**
 * Inputs that must classify as `unknown` with a null normalized ratio.
 *
 * The grammar is exactly `<digits>:<digits>`, so whitespace anywhere in the value
 * is malformed rather than trimmed.
 */
export const UNKNOWN_SOURCE_RATIOS = [
  "",
  "   ",
  " 9:16",
  "9:16 ",
  " 9:16 ",
  "9 : 16",
  "\t9:16",
  "9:16\n",
  "16:9 ",
  "9",
  "9x16",
  "9/16",
  "9 16",
  "9:16:9",
  "abc:def",
  "9:",
  ":16",
  "+9:16",
  "-9:16",
  "9:-16",
  "0:16",
  "9:0",
  "0:0",
  "9.0:16",
  "1.5:2",
  "0.5625",
  "1e3:16",
  "9,0:16",
  "١٦:٩",
  "9007199254740993:16",
  "10000000000000000:16",
] as const;

export const FIXTURE_CHANNELS: ReadonlyMap<string, FeedChannelInfo> = new Map([
  ["user_a", { channelName: "@ada", channelAvatarUrl: "https://cdn.example/a.png" }],
  ["user_b", { channelName: "Grace H", channelAvatarUrl: null }],
  ["user_c", { channelName: "Kathleen J", channelAvatarUrl: null }],
]);

const FIXTURE_UPLOADERS = ["user_a", "user_b", "user_c"] as const;

const BASE_CREATED_AT_MS = 1_700_000_000_000;

export type FixtureOverrides = Partial<PlacementFeedAsset>;

/**
 * Builds one cached-row fixture. `sourceAspectRatio` is the raw Mux value; the
 * stored `aspectRatio`/`feedPlacement` come from the production classifier.
 * Pass `sourceAspectRatio: null` for a legacy row that was never classified.
 */
export function buildFixtureAssetRow(args: {
  muxAssetId: string;
  sourceAspectRatio: string | null;
  createdAtMs?: number;
  uploaderUserId?: string;
  overrides?: FixtureOverrides;
}): PlacementFeedAsset {
  const classification =
    args.sourceAspectRatio === null
      ? null
      : classifyMuxAssetPayloadAspect({ aspect_ratio: args.sourceAspectRatio });

  return {
    muxAssetId: args.muxAssetId,
    status: "ready",
    isReady: true,
    isDeleted: false,
    durationSeconds: 42,
    createdAtMs: args.createdAtMs ?? BASE_CREATED_AT_MS,
    playbackIds: [{ id: `pb-${args.muxAssetId}`, policy: "public" }],
    feedTitle: `Title ${args.muxAssetId}`,
    feedUploaderUserId: args.uploaderUserId ?? "user_a",
    ...(classification
      ? {
          aspectRatio: classification.aspectRatio ?? undefined,
          feedPlacement: classification.feedPlacement,
        }
      : {}),
    ...args.overrides,
  };
}

export type FixtureRowSpec = {
  muxAssetId: string;
  sourceAspectRatio: string | null;
  expectedPlacement: FeedPlacement | "unclassified";
  /** False for rows that must be hidden even when the placement matches. */
  expectedEligible: boolean;
  note: string;
};

/**
 * A mixed table with interleaved creation times: vertical, standard, unknown,
 * and unclassified rows plus the deleted, missing-playback-ID, restricted, and
 * same-timestamp cases the query has to survive.
 *
 * Creation times descend with the fixture index, so the expected newest-first
 * order is the fixture order, except for the deliberate timestamp ties.
 */
export function buildMixedFixtureTable(): {
  rows: PlacementFeedAsset[];
  specs: FixtureRowSpec[];
} {
  const specs: FixtureRowSpec[] = [];

  // Interleave the vertical and non-qualifying ratios so no page of the mixed
  // table is homogeneous.
  const interleaved: { source: string | null; kind: string }[] = [];
  const verticalCount = Math.min(
    VERTICAL_SOURCE_RATIOS.length,
    NON_QUALIFYING_SOURCE_RATIOS.length,
  );
  for (let index = 0; index < verticalCount; index += 1) {
    interleaved.push({ source: VERTICAL_SOURCE_RATIOS[index], kind: "vertical" });
    interleaved.push({
      source: NON_QUALIFYING_SOURCE_RATIOS[index],
      kind: "standard",
    });
    if (index % 4 === 0) {
      interleaved.push({
        source: UNKNOWN_SOURCE_RATIOS[index % UNKNOWN_SOURCE_RATIOS.length],
        kind: "unknown",
      });
    }
    if (index % 5 === 0) {
      interleaved.push({ source: null, kind: "unclassified" });
    }
  }

  const rows = interleaved.map((entry, index) => {
    const muxAssetId = `asset_${String(index).padStart(3, "0")}_${entry.kind}`;
    const row = buildFixtureAssetRow({
      muxAssetId,
      sourceAspectRatio: entry.source,
      createdAtMs: BASE_CREATED_AT_MS - index * 1000,
      uploaderUserId: FIXTURE_UPLOADERS[index % FIXTURE_UPLOADERS.length],
    });

    specs.push({
      muxAssetId,
      sourceAspectRatio: entry.source,
      expectedPlacement:
        entry.kind === "unclassified"
          ? "unclassified"
          : entry.kind === "vertical"
            ? "vertical"
            : entry.kind === "standard"
              ? "standard"
              : "unknown",
      expectedEligible: entry.kind === "vertical",
      note: `${entry.kind} ratio ${String(entry.source)}`,
    });

    return row;
  });

  const oldestCreatedAtMs = BASE_CREATED_AT_MS - rows.length * 1000;

  // Hidden-case fixtures. All are exact 9:16 so only the extra rule can hide
  // them, and each carries a distinct timestamp below every row above.
  const hiddenCases: {
    muxAssetId: string;
    overrides: FixtureOverrides;
    note: string;
  }[] = [
    {
      muxAssetId: "hidden_deleted",
      overrides: { isDeleted: true, deletedAtMs: BASE_CREATED_AT_MS + 1 },
      note: "deleted vertical asset",
    },
    {
      muxAssetId: "hidden_deleted_flag_only",
      overrides: { isDeleted: true },
      note: "vertical asset flagged deleted without a timestamp",
    },
    {
      muxAssetId: "hidden_not_ready",
      overrides: { status: "preparing", isReady: false },
      note: "vertical asset still preparing",
    },
    {
      muxAssetId: "hidden_no_playback_id",
      overrides: { playbackIds: [] },
      note: "vertical asset with no playback ID",
    },
    {
      muxAssetId: "hidden_playback_without_id",
      overrides: { playbackIds: [{ policy: "public" }] },
      note: "vertical asset whose playback entry has no id",
    },
    {
      muxAssetId: "hidden_private",
      overrides: { feedVisibility: "private" },
      note: "private vertical asset",
    },
  ];

  hiddenCases.forEach((hiddenCase, index) => {
    rows.push(
      buildFixtureAssetRow({
        muxAssetId: hiddenCase.muxAssetId,
        sourceAspectRatio: "1080:1920",
        createdAtMs: oldestCreatedAtMs - index * 1000,
        overrides: hiddenCase.overrides,
      }),
    );
    specs.push({
      muxAssetId: hiddenCase.muxAssetId,
      sourceAspectRatio: "1080:1920",
      expectedPlacement: "vertical",
      expectedEligible: false,
      note: hiddenCase.note,
    });
  });

  // Visible-visibility cases. A signed-only playback ID stays visible, matching
  // Home's playback-ID rule, and `unlisted` keeps the visibility Home gives it.
  const visibleCases: {
    muxAssetId: string;
    sourceAspectRatio: string;
    overrides: FixtureOverrides;
    note: string;
  }[] = [
    {
      muxAssetId: "vertical_signed_only",
      sourceAspectRatio: "720:1280",
      overrides: { playbackIds: [{ id: "pb-signed-only", policy: "signed" }] },
      note: "vertical asset with a signed-only playback ID",
    },
    {
      muxAssetId: "vertical_public_visibility",
      sourceAspectRatio: "9:16",
      overrides: { feedVisibility: "public" },
      note: "explicitly public vertical asset",
    },
    {
      muxAssetId: "vertical_unlisted",
      sourceAspectRatio: "9:16",
      overrides: { feedVisibility: "unlisted" },
      note: "unlisted vertical asset",
    },
  ];

  const visibleCasesStartMs = oldestCreatedAtMs - hiddenCases.length * 1000;
  visibleCases.forEach((visibleCase, index) => {
    rows.push(
      buildFixtureAssetRow({
        muxAssetId: visibleCase.muxAssetId,
        sourceAspectRatio: visibleCase.sourceAspectRatio,
        createdAtMs: visibleCasesStartMs - index * 1000,
        overrides: visibleCase.overrides,
      }),
    );
    specs.push({
      muxAssetId: visibleCase.muxAssetId,
      sourceAspectRatio: visibleCase.sourceAspectRatio,
      expectedPlacement: "vertical",
      expectedEligible: true,
      note: visibleCase.note,
    });
  });

  const signedOnlyCreatedAtMs = visibleCasesStartMs - visibleCases.length * 1000;

  // Two distinct assets sharing one creation timestamp: the cursor walk must
  // return each exactly once even when the sort key repeats.
  const tieCreatedAtMs = signedOnlyCreatedAtMs - 1000;
  for (const suffix of ["a", "b"]) {
    const muxAssetId = `vertical_same_timestamp_${suffix}`;
    rows.push(
      buildFixtureAssetRow({
        muxAssetId,
        sourceAspectRatio: "9:16",
        createdAtMs: tieCreatedAtMs,
        uploaderUserId: "user_b",
      }),
    );
    specs.push({
      muxAssetId,
      sourceAspectRatio: "9:16",
      expectedPlacement: "vertical",
      expectedEligible: true,
      note: "vertical asset sharing a creation timestamp with a sibling",
    });
  }

  return { rows, specs };
}

/** Vertical rows only, in the newest-first order the index produces. */
export function expectedVerticalFeedIds(specs: readonly FixtureRowSpec[]) {
  return specs.filter((spec) => spec.expectedEligible).map((spec) => spec.muxAssetId);
}

/**
 * A cache that violates the `muxAssetId` key: one ready vertical asset stored
 * twice, plus a clean neighbour. `muxAssetCache` is meant to hold one row per
 * asset, so this is a data-integrity fault the audit gate must fail on. It is
 * kept out of `buildMixedFixtureTable` so the cursor fixtures stay well-formed.
 */
export function buildDuplicateRowFixtureTable(): {
  rows: PlacementFeedAsset[];
  duplicatedMuxAssetId: string;
} {
  const duplicatedMuxAssetId = "vertical_duplicated";

  return {
    duplicatedMuxAssetId,
    rows: [
      buildFixtureAssetRow({
        muxAssetId: duplicatedMuxAssetId,
        sourceAspectRatio: "1080:1920",
        createdAtMs: BASE_CREATED_AT_MS,
      }),
      buildFixtureAssetRow({
        muxAssetId: duplicatedMuxAssetId,
        sourceAspectRatio: "1080:1920",
        // A second write of the same asset, recorded a second later.
        createdAtMs: BASE_CREATED_AT_MS - 1000,
      }),
      buildFixtureAssetRow({
        muxAssetId: "vertical_unique",
        sourceAspectRatio: "9:16",
        createdAtMs: BASE_CREATED_AT_MS - 2000,
      }),
    ],
  };
}
