/**
 * Explicit data contracts for the news feed.
 *
 * This module is free of Convex imports, and of runtime imports of any kind, so
 * the projection, pagination, placement, and fallback rules can be unit tested
 * directly:
 *
 *   node --experimental-strip-types --test tests/feed-contracts.test.ts
 *   node --experimental-strip-types --test tests/vertical-feed-data.test.ts
 *
 * Card data and detail data are separate contracts. `FeedVideoCardItem` is the
 * only shape the paginated hot feed may return; rich AI metadata stays on the
 * video-detail contract.
 *
 * The placement section at the bottom carries the second contract: which feed a
 * classified asset belongs to, and the index range each placement-scoped query
 * reads. Aspect-ratio parsing itself lives in `./aspectClassification.ts`.
 */

import type { FeedPlacement } from "./aspectClassification";

/** The complete field list for a feed card. */
export const FEED_VIDEO_CARD_FIELDS = [
  "muxAssetId",
  "playbackId",
  "thumbnailUrl",
  "title",
  "channelName",
  "channelAvatarUrl",
  "durationSeconds",
  "createdAtMs",
] as const;

export type FeedVideoCardItem = {
  muxAssetId: string;
  playbackId: string;
  thumbnailUrl: string;
  title: string;
  channelName: string;
  channelAvatarUrl: string | null;
  durationSeconds: number | null;
  createdAtMs: number;
};

/**
 * Search results render the same card, so they share the card contract. The
 * ranking inputs (summary/tags) stay server-side and are never serialized to
 * the client.
 */
export type FeedSearchIndexItem = FeedVideoCardItem & {
  summary: string | null;
  tags: string[];
};

export const DEFAULT_CHANNEL_NAME = "Robotube";

/** Maximum server-generated thumbnail width; clients may request less. */
export const FEED_THUMBNAIL_WIDTH = 1280;

export type FeedChannelInfo = {
  channelName: string;
  channelAvatarUrl: string | null;
};

export const DEFAULT_FEED_CHANNEL: FeedChannelInfo = {
  channelName: DEFAULT_CHANNEL_NAME,
  channelAvatarUrl: null,
};

/** Metadata visibility, denormalized onto the cache as `feedVisibility`. */
export type FeedVisibility = "public" | "unlisted" | "private";

/** Visibilities a browse feed must not serve. */
export const FEED_HIDDEN_VISIBILITIES = ["private"] as const;

/**
 * The feed read model: everything the hot feed query is allowed to read. Every
 * denormalized `feed*` field is optional because rows written before the read
 * model existed have not been backfilled yet.
 */
export type FeedReadModelAsset = {
  muxAssetId: string;
  status?: string | null;
  isDeleted?: boolean | null;
  deletedAtMs?: number | null;
  durationSeconds?: number | null;
  createdAtMs?: number | null;
  passthrough?: string | null;
  playbackIds?: unknown;
  feedTitle?: string | null;
  feedChannelName?: string | null;
  feedUploaderUserId?: string | null;
  feedVisibility?: string | null;
};

export type FeedCardHiddenReason =
  | "not_ready_or_deleted"
  | "no_public_playback"
  | "private_visibility";

export type FeedCardBuildResult =
  | { card: FeedVideoCardItem; hiddenReason: null }
  | { card: null; hiddenReason: FeedCardHiddenReason };

export function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function asPlainRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The Mux component returns `metadata` as an array when no user id is supplied
 * and as a single record otherwise.
 */
export function pickPrimaryMetadata(metadataValue: unknown): Record<string, unknown> {
  return asPlainRecord(
    Array.isArray(metadataValue) ? metadataValue[0] : (metadataValue ?? null),
  );
}

/** `custom.channelName` is the explicit per-video channel display override. */
export function readChannelNameOverride(custom: unknown): string | undefined {
  return asNonEmptyString(asPlainRecord(custom).channelName) ?? undefined;
}

/**
 * Prefers a public playback ID and falls back to the first available one, which
 * matches the behavior the feed shipped with.
 */
export function selectFeedPlaybackId(playbackIds: unknown): string | null {
  if (!Array.isArray(playbackIds)) return null;

  const candidates = playbackIds.filter(
    (item): item is { id?: unknown; policy?: unknown } =>
      typeof item === "object" && item !== null,
  );
  const preferred =
    candidates.find((item) => item.policy === "public") ?? candidates[0];

  return asNonEmptyString(preferred?.id);
}

export function buildFeedThumbnailUrl(
  playbackId: string,
  width: number = FEED_THUMBNAIL_WIDTH,
) {
  return `https://image.mux.com/${playbackId}/thumbnail.jpg?width=${width}`;
}

/** Deterministic placeholder used when no display title is available yet. */
export function buildFeedCardTitle(title: unknown, muxAssetId: string) {
  return asNonEmptyString(title) ?? `Video ${String(muxAssetId).slice(0, 6)}`;
}

/**
 * Uploads encode `{ userId, ... }` into the Mux passthrough string, and the
 * asset cache already stores it. Reading the uploader from there keeps
 * channel/avatar resolution correct for rows whose denormalized uploader has
 * not been backfilled yet, without a Mux component subquery.
 */
export function parsePassthroughUserId(passthrough: unknown): string | null {
  const raw = asNonEmptyString(passthrough);
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return asNonEmptyString((parsed as { userId?: unknown }).userId);
  } catch {
    return null;
  }
}

export function resolveFeedUploaderUserId(
  asset: Pick<FeedReadModelAsset, "feedUploaderUserId" | "passthrough">,
): string | null {
  return (
    asNonEmptyString(asset.feedUploaderUserId) ??
    parsePassthroughUserId(asset.passthrough)
  );
}

export function deriveChannelNameFromUser(
  user:
    | { username?: unknown; name?: unknown; email?: unknown }
    | null
    | undefined,
): string {
  const username = asNonEmptyString(user?.username);
  if (username) return `@${username}`;

  const name = asNonEmptyString(user?.name);
  if (name) return name;

  const email = asNonEmptyString(user?.email);
  if (email) return email.split("@")[0] || DEFAULT_CHANNEL_NAME;

  return DEFAULT_CHANNEL_NAME;
}

/**
 * One entry per distinct uploader so channel/avatar data is resolved once per
 * uploader instead of once per video.
 */
export function collectDistinctUploaderUserIds(
  assets: readonly Pick<
    FeedReadModelAsset,
    "feedUploaderUserId" | "passthrough"
  >[],
): string[] {
  const uploaderUserIds: string[] = [];
  const seen = new Set<string>();

  for (const asset of assets) {
    const uploaderUserId = resolveFeedUploaderUserId(asset);
    if (!uploaderUserId || seen.has(uploaderUserId)) continue;
    seen.add(uploaderUserId);
    uploaderUserIds.push(uploaderUserId);
  }

  return uploaderUserIds;
}

export function isPlayableFeedAsset(asset: FeedReadModelAsset) {
  return !asset.isDeleted && !asset.deletedAtMs && asset.status === "ready";
}

export function asFeedVisibility(value: unknown): FeedVisibility | undefined {
  return value === "public" || value === "unlisted" || value === "private"
    ? value
    : undefined;
}

/**
 * Browse-feed visibility, read from the denormalized `feedVisibility` column so
 * no card path needs a per-video Mux metadata read.
 *
 * A missing value is permitted: rows written before visibility was denormalized
 * carry nothing, and defaulting them to hidden would remove videos that are
 * visible today. They become enforceable as soon as
 * `feedReadModel.backfillFeedReadModel` populates the column.
 *
 * Only `private` is withheld. `unlisted` keeps the visibility Home gives it
 * today; changing that is a product decision, not a classification one.
 */
export function isFeedVisibilityPermitted(
  asset: Pick<FeedReadModelAsset, "feedVisibility">,
): boolean {
  const visibility = asFeedVisibility(asset.feedVisibility);
  if (visibility === undefined) return true;
  return !(FEED_HIDDEN_VISIBILITIES as readonly string[]).includes(visibility);
}

export function buildFeedVideoCard(
  asset: FeedReadModelAsset,
  channels: ReadonlyMap<string, FeedChannelInfo>,
): FeedCardBuildResult {
  if (!isPlayableFeedAsset(asset)) {
    return { card: null, hiddenReason: "not_ready_or_deleted" };
  }

  const playbackId = selectFeedPlaybackId(asset.playbackIds);
  if (!playbackId) {
    return { card: null, hiddenReason: "no_public_playback" };
  }

  if (!isFeedVisibilityPermitted(asset)) {
    return { card: null, hiddenReason: "private_visibility" };
  }

  const uploaderUserId = resolveFeedUploaderUserId(asset);
  const channel = uploaderUserId ? channels.get(uploaderUserId) : undefined;

  return {
    hiddenReason: null,
    card: {
      muxAssetId: asset.muxAssetId,
      playbackId,
      thumbnailUrl: buildFeedThumbnailUrl(playbackId),
      title: buildFeedCardTitle(asset.feedTitle, asset.muxAssetId),
      channelName:
        asNonEmptyString(asset.feedChannelName) ??
        channel?.channelName ??
        DEFAULT_CHANNEL_NAME,
      channelAvatarUrl: channel?.channelAvatarUrl ?? null,
      durationSeconds: asFiniteNumber(asset.durationSeconds),
      createdAtMs: asFiniteNumber(asset.createdAtMs) ?? 0,
    },
  };
}

/**
 * Builds one page of cards. Source order is preserved: the feed index already
 * returns descending `createdAtMs`, and re-sorting a page can disagree with the
 * cursor boundary and reorder entries across pages.
 *
 * One asset can never produce two cards in the same page. `muxAssetCache` is
 * keyed by `muxAssetId` and every writer reads it through a unique lookup, so a
 * duplicate row is a data-integrity fault; the placement audit fails its gate on
 * duplicates because a pair split across two cursor pages cannot be collapsed by
 * a stateless page builder.
 */
export function buildFeedVideoCardPage(
  assets: readonly FeedReadModelAsset[],
  channels: ReadonlyMap<string, FeedChannelInfo>,
): FeedVideoCardItem[] {
  const cards: FeedVideoCardItem[] = [];
  const emitted = new Set<string>();

  for (const asset of assets) {
    if (emitted.has(asset.muxAssetId)) continue;

    const result = buildFeedVideoCard(asset, channels);
    if (!result.card) continue;

    emitted.add(asset.muxAssetId);
    cards.push(result.card);
  }

  return cards;
}

/**
 * Replaces the page contents of a Convex pagination result while passing
 * `isDone`, `continueCursor`, and any other pagination fields through
 * untouched. Hidden assets shrink a page; they never truncate it, so no card is
 * dropped between cursors.
 */
export function buildFeedVideoCardPageResult<
  TAsset extends FeedReadModelAsset,
  TResult extends { page: TAsset[] },
>(
  paginated: TResult,
  channels: ReadonlyMap<string, FeedChannelInfo>,
): Omit<TResult, "page"> & { page: FeedVideoCardItem[] } {
  return {
    ...paginated,
    page: buildFeedVideoCardPage(paginated.page, channels),
  };
}

/** Drops every source key that is not part of the feed-card contract. */
export function projectToFeedVideoCardItem(
  row: FeedVideoCardItem & Record<string, unknown>,
): FeedVideoCardItem {
  return {
    muxAssetId: row.muxAssetId,
    playbackId: row.playbackId,
    thumbnailUrl: row.thumbnailUrl,
    title: row.title,
    channelName: row.channelName,
    channelAvatarUrl: row.channelAvatarUrl,
    durationSeconds: row.durationSeconds,
    createdAtMs: row.createdAtMs,
  };
}

export function sortFeedCardsByNewestFirst<T extends { createdAtMs: number }>(
  cards: T[],
): T[] {
  return [...cards].sort((left, right) => right.createdAtMs - left.createdAtMs);
}

/* ------------------------------------------------------------------ *
 * Feed placement: which feed a classified asset belongs to
 *
 * Convex applies a cursor *after* an index range, so a placement-scoped feed has
 * to filter through an index. Filtering a mixed page afterwards produces short
 * pages and cursor behavior that can repeat or drop cards. `feedPlacement` is
 * therefore denormalized onto `muxAssetCache` and leads the index.
 * ------------------------------------------------------------------ */

export const FEED_PLACEMENT_INDEX_NAME =
  "by_feed_placement_ready_deleted_created";

/** Field order of `by_feed_placement_ready_deleted_created`. */
export const FEED_PLACEMENT_INDEX_FIELDS = [
  "feedPlacement",
  "isReady",
  "isDeleted",
  "createdAtMs",
] as const;

/** Shared upper bound for one card page, for Home and the vertical feed alike. */
export const FEED_PLACEMENT_MAX_PAGE_SIZE = 24;

export const VERTICAL_FEED_PLACEMENT: FeedPlacement = "vertical";
export const STANDARD_FEED_PLACEMENT: FeedPlacement = "standard";

/** A cached asset row as the placement-scoped feeds and the audit read it. */
export type PlacementFeedAsset = FeedReadModelAsset & {
  isReady?: boolean | null;
  aspectRatio?: string | null;
  feedPlacement?: string | null;
};

/** `unclassified` is a legacy row that predates classification entirely. */
export type FeedPlacementBucket = FeedPlacement | "unclassified";

export const FEED_PLACEMENT_BUCKETS = [
  "standard",
  "vertical",
  "unknown",
  "unclassified",
] as const;

/** Minimal shape of a Convex index-range builder. */
export type PlacementIndexRangeBuilder<TSelf> = {
  eq(field: string, value: unknown): TSelf;
};

/**
 * The single definition of a placement feed's index range. The Convex queries
 * and the contract tests both go through this, so the tested range and the
 * executed range cannot drift.
 *
 * Equality on `isReady`/`isDeleted` is exact: a row missing either field is not
 * in the range, which is why every writer stores both as booleans.
 */
export function applyPlacementIndexRange<
  TBuilder extends PlacementIndexRangeBuilder<TBuilder>,
>(builder: TBuilder, placement: FeedPlacement): TBuilder {
  return builder
    .eq("feedPlacement", placement)
    .eq("isReady", true)
    .eq("isDeleted", false);
}

export function clampFeedPageSize(
  numItems: number,
  maxPageSize: number = FEED_PLACEMENT_MAX_PAGE_SIZE,
): number {
  if (!Number.isFinite(numItems)) return 1;
  return Math.max(1, Math.min(maxPageSize, Math.floor(numItems)));
}

export function feedPlacementBucketOf(
  asset: Pick<PlacementFeedAsset, "feedPlacement">,
): FeedPlacementBucket {
  const placement = asset.feedPlacement;
  return placement === "standard" ||
    placement === "vertical" ||
    placement === "unknown"
    ? placement
    : "unclassified";
}

/**
 * Section 7.3 readiness: ready, not deleted, holding a usable playback ID, and
 * permitted by feed visibility. `isReady === true` mirrors the index range and
 * the remaining rules mirror what the card builder accepts, so this cannot call a
 * row eligible that the card builder would then hide.
 */
export function isPlayablePlacementAsset(asset: PlacementFeedAsset): boolean {
  return (
    asset.isReady === true &&
    asset.isDeleted === false &&
    isPlayableFeedAsset(asset) &&
    selectFeedPlaybackId(asset.playbackIds) !== null &&
    isFeedVisibilityPermitted(asset)
  );
}

export function isVerticalFeedEligible(asset: PlacementFeedAsset): boolean {
  return (
    isPlayablePlacementAsset(asset) &&
    feedPlacementBucketOf(asset) === VERTICAL_FEED_PLACEMENT
  );
}

/** Home after the coverage gate passes: `standard` only. */
export function isExclusiveHomeFeedEligible(asset: PlacementFeedAsset): boolean {
  return (
    isPlayablePlacementAsset(asset) &&
    feedPlacementBucketOf(asset) === STANDARD_FEED_PLACEMENT
  );
}

/**
 * Home before the cutover: every playable ready asset regardless of placement,
 * which is what `listFeedVideosPaginated` returns today. Unknown and
 * unclassified rows stay visible here, so no asset can disappear from both feeds
 * during migration.
 */
export function isLegacyHomeFeedEligible(asset: PlacementFeedAsset): boolean {
  return isPlayablePlacementAsset(asset);
}

/**
 * In-memory equivalent of one `by_feed_placement_ready_deleted_created` range,
 * newest-first. Used by the placement audit and by fixture-driven tests. The hot
 * query never filters a page in memory.
 */
export function selectPlacementFeedRows<TAsset extends PlacementFeedAsset>(
  rows: readonly TAsset[],
  placement: FeedPlacement,
): TAsset[] {
  return rows
    .filter(
      (row) =>
        row.feedPlacement === placement &&
        row.isReady === true &&
        row.isDeleted === false,
    )
    .slice()
    .sort((left, right) => (right.createdAtMs ?? 0) - (left.createdAtMs ?? 0));
}

export type FeedPlacementAuditSummary = {
  scanned: number;
  /** Ready, undeleted, playable, and permitted by visibility. */
  playable: number;
  /** Every scanned row, by placement bucket. */
  byPlacement: Record<FeedPlacementBucket, number>;
  /** Playable rows only, by placement bucket. */
  playableByPlacement: Record<FeedPlacementBucket, number>;
  /** Playable rows with a missing or malformed ratio, so no known placement. */
  playableUnknownRatio: number;
  /** Rows withheld from browse feeds by `feedVisibility`. */
  hiddenByVisibility: number;
  /** Rows whose stored `aspectRatio` and `feedPlacement` disagree. */
  inconsistentClassification: number;
  /** Playable rows whose `muxAssetId` is not unique in the cache. */
  duplicateIdRows: number;
  verticalFeedEligible: number;
  exclusiveHomeEligible: number;
  legacyHomeEligible: number;
  /** Exclusive Home ∩ vertical. Must be 0: placement is a single value. */
  overlapExclusive: number;
  /** Legacy Home ∩ vertical. Non-zero before the cutover, by design. */
  overlapLegacyMigration: number;
  /** Playable rows that would appear in neither feed after the cutover. */
  omittedAfterCutover: number;
  /** False whenever the scan stopped early; a partial scan proves nothing. */
  scanComplete: boolean;
  /**
   * The Home-cutover gate. True only for a complete scan with no omissions, no
   * cross-feed overlap, no corrupt classification, and no duplicate rows.
   */
  coverageGatePassed: boolean;
};

export type FeedPlacementAuditOptions = {
  /** True only when the scan covered the whole table. */
  scanComplete: boolean;
  /**
   * Cross-field integrity check for one row's stored classification. Injected
   * because the ratio parser lives in `./aspectClassification.ts` and this module
   * deliberately has no runtime imports.
   */
  isClassificationConsistent: (asset: PlacementFeedAsset) => boolean;
  /**
   * Whether this row's `muxAssetId` also appears on another cache row. Injected
   * because the authoritative check is an index lookup, not page-local: a
   * duplicate pair can straddle two cursor pages.
   */
  hasDuplicateMuxAssetId: (asset: PlacementFeedAsset) => boolean;
};

/** In-memory duplicate-id predicate for a fully materialized row set. */
export function buildDuplicateMuxAssetIdPredicate(
  rows: readonly PlacementFeedAsset[],
): (asset: PlacementFeedAsset) => boolean {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.muxAssetId, (counts.get(row.muxAssetId) ?? 0) + 1);
  }

  return (asset) => (counts.get(asset.muxAssetId) ?? 0) > 1;
}

function emptyPlacementBucketCounts(): Record<FeedPlacementBucket, number> {
  return { standard: 0, vertical: 0, unknown: 0, unclassified: 0 };
}

export function emptyFeedPlacementAuditSummary(): FeedPlacementAuditSummary {
  return {
    scanned: 0,
    playable: 0,
    byPlacement: emptyPlacementBucketCounts(),
    playableByPlacement: emptyPlacementBucketCounts(),
    playableUnknownRatio: 0,
    hiddenByVisibility: 0,
    inconsistentClassification: 0,
    duplicateIdRows: 0,
    verticalFeedEligible: 0,
    exclusiveHomeEligible: 0,
    legacyHomeEligible: 0,
    overlapExclusive: 0,
    overlapLegacyMigration: 0,
    omittedAfterCutover: 0,
    scanComplete: false,
    coverageGatePassed: false,
  };
}

function resolveCoverageGate(summary: FeedPlacementAuditSummary): boolean {
  return (
    summary.scanComplete &&
    summary.omittedAfterCutover === 0 &&
    summary.overlapExclusive === 0 &&
    summary.inconsistentClassification === 0 &&
    summary.duplicateIdRows === 0
  );
}

/**
 * Read-only exclusivity audit over a set of cached rows.
 *
 * Overlap is counted by asking each row how many feeds it qualifies for rather
 * than by assuming placement is exclusive, so the count stays honest if the
 * eligibility rules ever change.
 */
export function summarizeFeedPlacements(
  rows: readonly PlacementFeedAsset[],
  options: FeedPlacementAuditOptions,
): FeedPlacementAuditSummary {
  const summary = emptyFeedPlacementAuditSummary();
  summary.scanned = rows.length;
  summary.scanComplete = options.scanComplete;

  for (const row of rows) {
    const bucket = feedPlacementBucketOf(row);
    summary.byPlacement[bucket] += 1;

    if (!options.isClassificationConsistent(row)) {
      summary.inconsistentClassification += 1;
    }

    if (!isFeedVisibilityPermitted(row)) {
      summary.hiddenByVisibility += 1;
    }

    if (!isPlayablePlacementAsset(row)) continue;

    summary.playable += 1;
    summary.playableByPlacement[bucket] += 1;
    if (bucket === "unknown" || bucket === "unclassified") {
      summary.playableUnknownRatio += 1;
    }
    if (options.hasDuplicateMuxAssetId(row)) {
      summary.duplicateIdRows += 1;
    }

    const vertical = isVerticalFeedEligible(row);
    const exclusiveHome = isExclusiveHomeFeedEligible(row);
    const legacyHome = isLegacyHomeFeedEligible(row);

    if (vertical) summary.verticalFeedEligible += 1;
    if (exclusiveHome) summary.exclusiveHomeEligible += 1;
    if (legacyHome) summary.legacyHomeEligible += 1;
    if (vertical && exclusiveHome) summary.overlapExclusive += 1;
    if (vertical && legacyHome) summary.overlapLegacyMigration += 1;
    if (!vertical && !exclusiveHome) summary.omittedAfterCutover += 1;
  }

  summary.coverageGatePassed = resolveCoverageGate(summary);
  return summary;
}

/**
 * Combines audit pages so a bounded scan can be run cursor by cursor.
 * Completeness belongs to the walk, not to a page, so the caller states it: a
 * walk that stopped at its row budget can never report a passing gate.
 */
export function mergeFeedPlacementAuditSummaries(
  summaries: readonly FeedPlacementAuditSummary[],
  options: { scanComplete: boolean },
): FeedPlacementAuditSummary {
  const merged = emptyFeedPlacementAuditSummary();
  merged.scanComplete = options.scanComplete;

  for (const summary of summaries) {
    merged.scanned += summary.scanned;
    merged.playable += summary.playable;
    merged.playableUnknownRatio += summary.playableUnknownRatio;
    merged.hiddenByVisibility += summary.hiddenByVisibility;
    merged.inconsistentClassification += summary.inconsistentClassification;
    merged.duplicateIdRows += summary.duplicateIdRows;
    merged.verticalFeedEligible += summary.verticalFeedEligible;
    merged.exclusiveHomeEligible += summary.exclusiveHomeEligible;
    merged.legacyHomeEligible += summary.legacyHomeEligible;
    merged.overlapExclusive += summary.overlapExclusive;
    merged.overlapLegacyMigration += summary.overlapLegacyMigration;
    merged.omittedAfterCutover += summary.omittedAfterCutover;

    for (const bucket of FEED_PLACEMENT_BUCKETS) {
      merged.byPlacement[bucket] += summary.byPlacement[bucket];
      merged.playableByPlacement[bucket] += summary.playableByPlacement[bucket];
    }
  }

  merged.coverageGatePassed = resolveCoverageGate(merged);
  return merged;
}
