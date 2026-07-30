/**
 * Explicit data contracts for the news feed.
 *
 * This module is free of Convex imports so the projection,
 * pagination, and fallback rules can be unit tested directly:
 *
 *   node --experimental-strip-types --test tests/feed-contracts.test.ts
 *
 * Card data and detail data are separate contracts. `FeedVideoCardItem` is the
 * only shape the paginated hot feed may return; rich AI metadata stays on the
 * video-detail contract.
 */

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
 */
export function buildFeedVideoCardPage(
  assets: readonly FeedReadModelAsset[],
  channels: ReadonlyMap<string, FeedChannelInfo>,
): FeedVideoCardItem[] {
  const cards: FeedVideoCardItem[] = [];

  for (const asset of assets) {
    const result = buildFeedVideoCard(asset, channels);
    if (result.card) cards.push(result.card);
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
