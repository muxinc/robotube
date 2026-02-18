import { v } from "convex/values";

import { components } from "./_generated/api";
import { query } from "./_generated/server";

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

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

async function buildFeedVideoRow(ctx: any, asset: any): Promise<FeedBuildResult> {
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

  if (metadata?.visibility === "private") {
    return { row: null, hiddenReason: "private_visibility" };
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
      channelName: metadata?.custom?.channelName ?? "Robotube",
      createdAtMs: asset.createdAtMs ?? Date.now(),
    },
  };
}

export const listFeedVideos = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const assets = await ctx.runQuery(components.mux.catalog.listAssets, {
      limit: args.limit ?? 25,
    });

    const rows = await Promise.all(assets.map((asset: any) => buildFeedVideoRow(ctx, asset)));
    const visibleRows = rows.flatMap((result) => (result.row ? [result.row] : []));
    visibleRows.sort((a, b) => b.createdAtMs - a.createdAtMs);
    return visibleRows;
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
    const asset = await ctx.runQuery(components.mux.catalog.getAssetByMuxId, {
      muxAssetId: args.muxAssetId,
    });
    if (!asset) return null;
    const result = await buildFeedVideoRow(ctx, asset);
    return result.row;
  },
});
