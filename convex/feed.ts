import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";

import type { Id } from "./_generated/dataModel";

import { components } from "./_generated/api";
import { internalQuery, query } from "./_generated/server";
import {
  type CachedMuxAsset,
  listRecentReadyCachedMuxAssets,
  getCachedMuxAssetById,
} from "./muxAssetCache";
import {
  type FeedChannelInfo,
  type FeedReadModelAsset,
  type FeedSearchIndexItem,
  type FeedVideoCardItem,
  DEFAULT_FEED_CHANNEL,
  asFiniteNumber,
  asNonEmptyString,
  asPlainRecord,
  pickPrimaryMetadata,
  buildFeedThumbnailUrl,
  buildFeedCardTitle,
  buildFeedVideoCard,
  buildFeedVideoCardPage,
  buildFeedVideoCardPageResult,
  collectDistinctUploaderUserIds,
  readSelectedThumbnailTimestampMs,
  deriveChannelNameFromUser,
  selectFeedPlaybackId,
  sortFeedCardsByNewestFirst,
  FEED_PLACEMENT_INDEX_NAME,
  FEED_PLACEMENT_MAX_PAGE_SIZE,
  STANDARD_FEED_PLACEMENT,
  VERTICAL_FEED_PLACEMENT,
  applyPlacementIndexRange,
  clampFeedPageSize,
} from "./feedContracts";
import type { FeedPlacement } from "./aspectClassification";

export type { FeedVideoCardItem, FeedSearchIndexItem } from "./feedContracts";

/** Rich video-detail data that is never included in the card feed. */
type FeedVideoDetailItem = {
  muxAssetId: string;
  playbackId: string;
  playbackUrl: string;
  thumbnailUrl: string;
  durationSeconds: number | null;
  title: string;
  summary: string | null;
  tags: string[];
  chapters: Array<{ title: string; startTime: number }>;
  keyMoments: Array<{
    startMs: number;
    endMs: number;
    cues: Array<{ startMs: number; endMs: number; text: string }>;
    overallScore: number | null;
    title: string | null;
    audibleNarrative: string | null;
    notableAudibleConcepts: string[];
    visualNarrative: string | null;
    notableVisualConcepts: Array<{
      concept: string;
      score: number;
      rationale: string;
    }>;
  }>;
  keyMomentsGeneratedAtMs: number | null;
  keyMomentsUnavailableReason: string | null;
  channelName: string;
  channelAvatarUrl: string | null;
  createdAtMs: number;
};

type FeedDetailBuildResult =
  | { row: FeedVideoDetailItem; hiddenReason: null }
  | {
      row: null;
      hiddenReason:
        | "not_ready_or_deleted"
        | "no_public_playback"
        | "private_visibility";
    };

const FEED_SCAN_MULTIPLIER = 3;
const FEED_PAGINATION_MAX_PAGE_SIZE = FEED_PLACEMENT_MAX_PAGE_SIZE;

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function asNumber(value: unknown): number | null {
  return asFiniteNumber(value);
}

/* ------------------------------------------------------------------ *
 * Uploader / channel resolution
 * ------------------------------------------------------------------ */

/**
 * Resolves channel display data once per distinct uploader, memoizing storage
 * URL generation so one avatar is never signed twice in the same page.
 */
async function resolveFeedChannels(
  ctx: any,
  uploaderUserIds: readonly string[],
): Promise<Map<string, FeedChannelInfo>> {
  const avatarUrlByStorageId = new Map<string, Promise<string | null>>();

  const getAvatarUrlOnce = (storageId: string) => {
    const pending = avatarUrlByStorageId.get(storageId);
    if (pending) return pending;

    const promise = Promise.resolve(ctx.storage.getUrl(storageId)).catch(
      () => null,
    ) as Promise<string | null>;
    avatarUrlByStorageId.set(storageId, promise);
    return promise;
  };

  const entries = await Promise.all(
    uploaderUserIds.map(async (uploaderUserId) => {
      const channel = await resolveChannelInfoForUser(
        ctx,
        uploaderUserId,
        getAvatarUrlOnce,
      );
      return [uploaderUserId, channel] as const;
    }),
  );

  return new Map(entries);
}

async function resolveChannelInfoForUser(
  ctx: any,
  uploaderUserId: string,
  getAvatarUrlOnce: (storageId: string) => Promise<string | null>,
): Promise<FeedChannelInfo> {
  try {
    const uploader = await ctx.db.get(uploaderUserId as Id<"users">);
    if (!uploader) return DEFAULT_FEED_CHANNEL;

    const avatarStorageId = asNonEmptyString(uploader.avatarStorageId);
    const storageAvatarUrl = avatarStorageId
      ? await getAvatarUrlOnce(avatarStorageId)
      : null;

    return {
      channelName: deriveChannelNameFromUser(uploader),
      channelAvatarUrl:
        asNonEmptyString(storageAvatarUrl) ?? asNonEmptyString(uploader.image),
    };
  } catch {
    // Non-user ids (for example the "default" metadata owner) fall back to the
    // shared channel identity rather than failing the page.
    return DEFAULT_FEED_CHANNEL;
  }
}

/**
 * Overlays authoritative component metadata on top of a read-model card. Used
 * by the search and profile paths, which already hold that metadata, so those
 * screens stay correct even before the read-model backfill runs.
 */
function overlayComponentMetadata(
  card: FeedVideoCardItem,
  metadata: Record<string, unknown>,
): FeedVideoCardItem {
  const custom = asPlainRecord(metadata.custom);

  return {
    ...card,
    // Falls back to the read-model title rather than to the placeholder, so an
    // overlay can only ever improve what the card already had.
    title: buildFeedCardTitle(
      asNonEmptyString(metadata.title) ?? card.title,
      card.muxAssetId,
    ),
    channelName: asNonEmptyString(custom.channelName) ?? card.channelName,
  };
}

/* ------------------------------------------------------------------ *
 * Video-detail builders (rich metadata; never used by the card feed)
 * ------------------------------------------------------------------ */

function asChapterArray(value: unknown): Array<{ title: string; startTime: number }> {
  if (!Array.isArray(value)) return [];

  return value
    .filter(
      (item): item is { title: string; startTime: number } =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { title?: unknown }).title === "string" &&
        typeof (item as { startTime?: unknown }).startTime === "number" &&
        Number.isFinite((item as { startTime: number }).startTime),
    )
    .map((item) => ({
      title: item.title,
      startTime: Math.max(0, item.startTime),
    }))
    .sort((a, b) => a.startTime - b.startTime);
}

function asKeyMomentArray(value: unknown): FeedVideoDetailItem["keyMoments"] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      if (typeof item !== "object" || item === null) {
        return null;
      }

      const cues = Array.isArray((item as any).cues)
        ? (item as any).cues
            .filter(
              (cue: unknown) =>
                typeof cue === "object" &&
                cue !== null &&
                asNumber((cue as any).startMs) !== null &&
                asNumber((cue as any).endMs) !== null &&
                typeof (cue as any).text === "string",
            )
            .map((cue: any) => ({
              startMs: Math.max(0, asNumber(cue.startMs) ?? 0),
              endMs: Math.max(0, asNumber(cue.endMs) ?? 0),
              text: cue.text.trim(),
            }))
        : [];

      const notableVisualConcepts = Array.isArray((item as any).notableVisualConcepts)
        ? (item as any).notableVisualConcepts
            .filter(
              (concept: unknown) =>
                typeof concept === "object" &&
                concept !== null &&
                typeof (concept as any).concept === "string",
            )
            .map((concept: any) => ({
              concept: concept.concept.trim(),
              score: asNumber(concept.score) ?? 0,
              rationale:
                typeof concept.rationale === "string" ? concept.rationale.trim() : "",
            }))
        : [];

      const startMs = asNumber((item as any).startMs);
      const endMs = asNumber((item as any).endMs);
      if (startMs === null || endMs === null) {
        return null;
      }

      return {
        startMs: Math.max(0, startMs),
        endMs: Math.max(0, endMs),
        cues,
        overallScore: asNumber((item as any).overallScore),
        title: asString((item as any).title),
        audibleNarrative: asString((item as any).audibleNarrative),
        notableAudibleConcepts: asStringArray((item as any).notableAudibleConcepts),
        visualNarrative: asString((item as any).visualNarrative),
        notableVisualConcepts,
      };
    })
    .filter((item): item is FeedVideoDetailItem["keyMoments"][number] => item !== null)
    .sort((a, b) => a.startMs - b.startMs);
}

async function buildFeedVideoDetailFromSource(
  ctx: any,
  source: {
    muxAssetId: string;
    playbackIds: unknown;
    durationSeconds: number | null;
    titleFallback?: string;
    createdAtMs: number;
    status: unknown;
    deletedAtMs: unknown;
    metadata: any;
  },
): Promise<FeedDetailBuildResult> {
  if (source.deletedAtMs || source.status !== "ready") {
    return { row: null, hiddenReason: "not_ready_or_deleted" };
  }

  const playbackId = selectFeedPlaybackId(source.playbackIds);
  if (!playbackId) {
    return { row: null, hiddenReason: "no_public_playback" };
  }

  const metadata = source.metadata;
  const metadataUserId = asString(metadata?.userId);
  const channels = await resolveFeedChannels(
    ctx,
    metadataUserId ? [metadataUserId] : [],
  );
  const channelInfo =
    (metadataUserId ? channels.get(metadataUserId) : undefined) ??
    DEFAULT_FEED_CHANNEL;
  const channelName = metadata?.custom?.channelName ?? channelInfo.channelName;

  return {
    hiddenReason: null,
    row: {
      muxAssetId: source.muxAssetId,
      playbackId,
      playbackUrl: `https://stream.mux.com/${playbackId}.m3u8`,
      thumbnailUrl: buildFeedThumbnailUrl(
        playbackId,
        undefined,
        readSelectedThumbnailTimestampMs(metadata?.custom),
      ),
      durationSeconds: source.durationSeconds,
      title:
        metadata?.title ??
        source.titleFallback ??
        `Video ${String(source.muxAssetId).slice(0, 6)}`,
      summary: asString(metadata?.description),
      tags: asStringArray(metadata?.tags),
      chapters: asChapterArray(metadata?.custom?.aiChapters),
      keyMoments: asKeyMomentArray(metadata?.custom?.aiKeyMoments),
      keyMomentsGeneratedAtMs: asNumber(metadata?.custom?.aiKeyMomentsGeneratedAtMs),
      keyMomentsUnavailableReason: asString(
        metadata?.custom?.aiKeyMomentsUnavailableReason,
      ),
      channelName,
      channelAvatarUrl: channelInfo.channelAvatarUrl,
      createdAtMs: source.createdAtMs,
    },
  };
}

async function buildFeedVideoDetail(
  ctx: any,
  asset: CachedMuxAsset,
): Promise<FeedDetailBuildResult> {
  const video = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
    muxAssetId: asset.muxAssetId as string,
  });

  return await buildFeedVideoDetailFromSource(ctx, {
    muxAssetId: asset.muxAssetId as string,
    playbackIds: asset.playbackIds,
    durationSeconds: asset.durationSeconds ?? null,
    createdAtMs: asset.createdAtMs ?? Date.now(),
    status: asset.status,
    deletedAtMs: asset.deletedAtMs,
    metadata: pickPrimaryMetadata((video as any)?.metadata),
  });
}

/* ------------------------------------------------------------------ *
 * Feed-card queries
 * ------------------------------------------------------------------ */

async function buildFeedCardsFromReadModel(
  ctx: any,
  assets: readonly FeedReadModelAsset[],
): Promise<FeedVideoCardItem[]> {
  const channels = await resolveFeedChannels(
    ctx,
    collectDistinctUploaderUserIds(assets),
  );

  return buildFeedVideoCardPage(assets, channels);
}

export const listFeedVideos = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<FeedVideoCardItem[]> => {
    const requestedLimit = Math.max(1, Math.floor(args.limit ?? 25));
    const assets = await listRecentReadyCachedMuxAssets(
      ctx,
      requestedLimit * FEED_SCAN_MULTIPLIER,
    );

    const cards = await buildFeedCardsFromReadModel(ctx, assets);
    return cards.slice(0, requestedLimit);
  },
});

/**
 * The hot feed path. It reads only the feed read model on `muxAssetCache` and
 * performs no per-video Mux component subquery.
 */
export const listFeedVideosPaginated = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const requestedPageSize = Math.max(
      1,
      Math.min(FEED_PAGINATION_MAX_PAGE_SIZE, Math.floor(args.paginationOpts.numItems)),
    );

    // The page is never truncated after the fact: hidden assets shrink a page,
    // they never push cards past the cursor where they would be lost.
    const paginatedAssets: {
      page: CachedMuxAsset[];
      isDone: boolean;
      continueCursor: string;
    } = await (ctx.db as any)
      .query("muxAssetCache")
      .withIndex("by_ready_deleted_created", (q: any) =>
        q.eq("isReady", true).eq("isDeleted", false),
      )
      .order("desc")
      .paginate({
        ...args.paginationOpts,
        numItems: requestedPageSize,
      });

    const channels = await resolveFeedChannels(
      ctx,
      collectDistinctUploaderUserIds(paginatedAssets.page),
    );

    return buildFeedVideoCardPageResult(paginatedAssets, channels);
  },
});

/* ------------------------------------------------------------------ *
 * Placement-scoped card feeds
 * ------------------------------------------------------------------ */

/**
 * One page of cards for a single feed placement.
 *
 * Selection happens entirely inside `by_feed_placement_ready_deleted_created`,
 * before Convex applies the cursor, so pages are stable newest-first with no
 * duplicated, skipped, or re-sorted cards. Like the Home hot path it reads only
 * the denormalized read model: no per-video Mux component query, and each
 * uploader/avatar is resolved at most once per page.
 */
async function paginatePlacementFeedCards(
  ctx: any,
  placement: FeedPlacement,
  paginationOpts: { numItems: number; cursor: string | null },
) {
  const paginatedAssets: {
    page: CachedMuxAsset[];
    isDone: boolean;
    continueCursor: string;
  } = await (ctx.db as any)
    .query("muxAssetCache")
    .withIndex(FEED_PLACEMENT_INDEX_NAME, (q: any) =>
      applyPlacementIndexRange(q, placement),
    )
    .order("desc")
    .paginate({
      ...paginationOpts,
      numItems: clampFeedPageSize(paginationOpts.numItems),
    });

  const channels = await resolveFeedChannels(
    ctx,
    collectDistinctUploaderUserIds(paginatedAssets.page),
  );

  return buildFeedVideoCardPageResult(paginatedAssets, channels);
}

/**
 * The vertical (Shorts) feed: exact normalized `9:16` only.
 *
 * Returns the same lightweight `FeedVideoCardItem` contract as Home. Aspect
 * ratio and placement are server-side selection inputs and are deliberately not
 * serialized to the client.
 *
 * Rollback: disabling the Shorts tab stops all calls to this query. The schema
 * fields and the placement index can stay in place; nothing else reads them.
 */
export const listVerticalFeedVideosPaginated = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    return await paginatePlacementFeedCards(
      ctx,
      VERTICAL_FEED_PLACEMENT,
      args.paginationOpts,
    );
  },
});

/**
 * The placement-filtered Home feed (16:9 grid). Web Home serves its main grid
 * from this query, with `listVerticalFeedVideosPaginated` feeding the Shorts
 * shelf. The cutover happened after `feedPlacement.auditFeedPlacementCoverage`
 * reported `coverageGatePassed: true`; rows classified `unknown` are not served
 * from either feed, so rerun the backfill with `{"includeUnknown": true}` once
 * Mux finishes processing an asset that had no ratio yet.
 */
export const listStandardFeedVideosPaginated = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    return await paginatePlacementFeedCards(
      ctx,
      STANDARD_FEED_PLACEMENT,
      args.paginationOpts,
    );
  },
});

export const listCurrentUserUploadedVideos = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<FeedVideoCardItem[]> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const requestedLimit = Math.max(1, Math.floor(args.limit ?? 12));
    // One component call for the whole page, not one per video.
    const uploads = await ctx.runQuery(components.mux.videos.listVideosForUser, {
      userId,
      limit: requestedLimit * FEED_SCAN_MULTIPLIER,
    });

    const channels = await resolveFeedChannels(ctx, [userId]);
    const cards: FeedVideoCardItem[] = [];

    for (const entry of uploads as any[]) {
      const asset = entry?.asset;
      const muxAssetId = asString(asset?.muxAssetId);
      if (!muxAssetId) continue;

      const metadata = asPlainRecord(entry?.metadata);
      const result = buildFeedVideoCard(
        {
          muxAssetId,
          status: asString(asset?.status),
          deletedAtMs: asNumber(asset?.deletedAtMs),
          durationSeconds: asNumber(asset?.durationSeconds),
          createdAtMs: asNumber(asset?.createdAtMs) ?? Date.now(),
          playbackIds: asset?.playbackIds,
          feedUploaderUserId: userId,
        },
        channels,
      );

      if (result.card) {
        cards.push(overlayComponentMetadata(result.card, metadata));
      }
    }

    return sortFeedCardsByNewestFirst(cards).slice(0, requestedLimit);
  },
});

/**
 * Ranking input for search. Summary and tags are scored server-side; the search
 * queries project their results back down to the card contract before they are
 * serialized to a screen.
 */
export const listFeedSearchIndexInternal = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<FeedSearchIndexItem[]> => {
    const requestedLimit = Math.max(1, Math.floor(args.limit ?? 25));
    const assets = await listRecentReadyCachedMuxAssets(
      ctx,
      requestedLimit * FEED_SCAN_MULTIPLIER,
    );

    const channels = await resolveFeedChannels(
      ctx,
      collectDistinctUploaderUserIds(assets),
    );

    const rows = await Promise.all(
      assets.map(async (asset) => {
        const result = buildFeedVideoCard(asset, channels);
        if (!result.card) return null;

        const video = await ctx.runQuery(
          components.mux.videos.getVideoByMuxAssetId,
          { muxAssetId: asset.muxAssetId },
        );
        const metadata = pickPrimaryMetadata((video as any)?.metadata);

        return {
          ...overlayComponentMetadata(result.card, metadata),
          summary: asString(metadata.description),
          tags: asStringArray(metadata.tags),
        };
      }),
    );

    return rows
      .filter((row): row is FeedSearchIndexItem => row !== null)
      .slice(0, requestedLimit);
  },
});

export const getFeedVisibilityDebugStats = query({
  args: { scanLimit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const assets = await ctx.runQuery(components.mux.catalog.listAssets, {
      limit: args.scanLimit ?? 250,
    });

    let visible = 0;
    let hiddenNotReadyOrDeleted = 0;
    let hiddenNoPublicPlayback = 0;
    let hiddenPrivateVisibility = 0;

    for (const asset of assets) {
      const result = await buildFeedVideoDetail(ctx, asset as any);
      if (result.row) {
        visible += 1;
        continue;
      }

      if (result.hiddenReason === "not_ready_or_deleted") {
        hiddenNotReadyOrDeleted += 1;
      } else if (result.hiddenReason === "no_public_playback") {
        hiddenNoPublicPlayback += 1;
      } else if (result.hiddenReason === "private_visibility") {
        hiddenPrivateVisibility += 1;
      }
    }

    return {
      scanned: assets.length,
      visible,
      hiddenNotReadyOrDeleted,
      hiddenNoPublicPlayback,
      hiddenPrivateVisibility,
      hiddenTotal:
        hiddenNotReadyOrDeleted + hiddenNoPublicPlayback + hiddenPrivateVisibility,
    };
  },
});

/** The video-detail contract: rich metadata for `/video/[muxAssetId]`. */
export const getFeedVideoByMuxAssetId = query({
  args: { muxAssetId: v.string() },
  handler: async (ctx, args): Promise<FeedVideoDetailItem | null> => {
    const asset = await getCachedMuxAssetById(ctx, args.muxAssetId);
    if (!asset) return null;
    const result = await buildFeedVideoDetail(ctx, asset);
    return result.row;
  },
});
