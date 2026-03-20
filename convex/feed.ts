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

type PlaybackId = {
  id?: string;
  policy?: string;
};

type FeedVideoRow = {
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
  createdAtMs: number;
};

type FeedBuildResult =
  | { row: FeedVideoRow; hiddenReason: null }
  | {
      row: null;
      hiddenReason:
        | "not_ready_or_deleted"
        | "no_public_playback"
        | "private_visibility";
    };

const FEED_SCAN_MULTIPLIER = 3;
const FEED_PAGINATION_SCAN_MULTIPLIER = 1;
const FEED_PAGINATION_MAX_PAGE_SIZE = 24;

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

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

function asKeyMomentArray(value: unknown): FeedVideoRow["keyMoments"] {
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
    .filter((item): item is FeedVideoRow["keyMoments"][number] => item !== null)
    .sort((a, b) => a.startMs - b.startMs);
}

async function buildFeedVideoRow(ctx: any, asset: CachedMuxAsset): Promise<FeedBuildResult> {
  if (asset.deletedAtMs || asset.status !== "ready") {
    return { row: null, hiddenReason: "not_ready_or_deleted" };
  }

  const playbackIds = (asset.playbackIds ?? []) as PlaybackId[];
  const playback =
    playbackIds.find((id) => id.policy === "public") ?? playbackIds[0];
  if (!playback?.id) {
    return { row: null, hiddenReason: "no_public_playback" };
  }

  const video = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
    muxAssetId: asset.muxAssetId as string,
  });
  const metadataValue = (video as any)?.metadata;
  const metadata = Array.isArray(metadataValue)
    ? metadataValue[0]
    : metadataValue ?? null;
  const metadataUserId = asString(metadata?.userId);

  let channelName = metadata?.custom?.channelName ?? "Robotube";
  if (metadataUserId) {
    try {
      const uploader = await ctx.db.get(metadataUserId as Id<"users">);
      const uploaderUsername = asString((uploader as any)?.username);
      const uploaderName = asString((uploader as any)?.name);
      const uploaderEmail = asString((uploader as any)?.email);

      if (uploaderUsername) {
        channelName = `@${uploaderUsername}`;
      } else if (uploaderName) {
        channelName = uploaderName;
      } else if (uploaderEmail) {
        channelName = uploaderEmail.split("@")[0] || channelName;
      }
    } catch {
      // Keep metadata/custom fallback channel name.
    }
  }

  return {
    hiddenReason: null,
    row: {
      muxAssetId: asset.muxAssetId as string,
      playbackId: playback.id,
      playbackUrl: `https://stream.mux.com/${playback.id}.m3u8`,
      thumbnailUrl: `https://image.mux.com/${playback.id}/thumbnail.jpg?width=1280`,
      durationSeconds: asset.durationSeconds ?? null,
      title: metadata?.title ?? `Video ${String(asset.muxAssetId).slice(0, 6)}`,
      summary: asString(metadata?.description),
      tags: asStringArray(metadata?.tags),
      chapters: asChapterArray(metadata?.custom?.aiChapters),
      keyMoments: asKeyMomentArray(metadata?.custom?.aiKeyMoments),
      keyMomentsGeneratedAtMs: asNumber(metadata?.custom?.aiKeyMomentsGeneratedAtMs),
      keyMomentsUnavailableReason: asString(metadata?.custom?.aiKeyMomentsUnavailableReason),
      channelName,
      createdAtMs: asset.createdAtMs ?? Date.now(),
    },
  };
}

async function buildVisibleFeedRows(
  ctx: any,
  assets: CachedMuxAsset[],
  requestedLimit: number,
) {
  const rows = await Promise.all(assets.map((asset) => buildFeedVideoRow(ctx, asset)));
  const visibleRows = rows
    .flatMap((result) => (result.row ? [result.row] : []))
    .slice(0, requestedLimit);

  visibleRows.sort((a, b) => b.createdAtMs - a.createdAtMs);
  return visibleRows;
}

export const listFeedVideos = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const requestedLimit = Math.max(1, Math.floor(args.limit ?? 25));
    const assets = await listRecentReadyCachedMuxAssets(
      ctx,
      requestedLimit * FEED_SCAN_MULTIPLIER,
    );

    return await buildVisibleFeedRows(ctx, assets, requestedLimit);
  },
});

export const listFeedVideosInternal = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const requestedLimit = Math.max(1, Math.floor(args.limit ?? 25));
    const assets = await listRecentReadyCachedMuxAssets(
      ctx,
      requestedLimit * FEED_SCAN_MULTIPLIER,
    );

    return await buildVisibleFeedRows(ctx, assets, requestedLimit);
  },
});

export const listFeedVideosPaginated = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const requestedPageSize = Math.max(
      1,
      Math.min(FEED_PAGINATION_MAX_PAGE_SIZE, Math.floor(args.paginationOpts.numItems)),
    );
    const paginatedAssets = await (ctx.db as any)
      .query("muxAssetCache")
      .withIndex("by_ready_deleted_created", (q: any) =>
        q.eq("isReady", true).eq("isDeleted", false),
      )
      .order("desc")
      .paginate({
        ...args.paginationOpts,
        numItems: requestedPageSize * FEED_PAGINATION_SCAN_MULTIPLIER,
      });

    return {
      ...paginatedAssets,
      page: await buildVisibleFeedRows(
        ctx,
        paginatedAssets.page as CachedMuxAsset[],
        requestedPageSize,
      ),
    };
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
      const result = await buildFeedVideoRow(ctx, asset as any);
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

export const getFeedVideoByMuxAssetId = query({
  args: { muxAssetId: v.string() },
  handler: async (ctx, args) => {
    const asset = await getCachedMuxAssetById(ctx, args.muxAssetId);
    if (!asset) return null;
    const result = await buildFeedVideoRow(ctx, asset);
    return result.row;
  },
});
