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
  channelName: string;
  createdAtMs: number;
};

async function toFeedVideoRow(ctx: any, asset: any): Promise<FeedVideoRow | null> {
  const playbackIds = (asset.playbackIds ?? []) as PlaybackId[];
  const playback =
    playbackIds.find((id) => id.policy === "public") ?? playbackIds[0];
  if (!playback?.id) return null;
  if (asset.deletedAtMs || asset.status !== "ready") return null;

  const video = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
    muxAssetId: asset.muxAssetId as string,
  });
  const metadataValue = (video as any)?.metadata;
  const metadata = Array.isArray(metadataValue)
    ? metadataValue[0]
    : metadataValue ?? null;

  if (metadata?.visibility === "private") return null;

  return {
    muxAssetId: asset.muxAssetId as string,
    playbackId: playback.id,
    playbackUrl: `https://stream.mux.com/${playback.id}.m3u8`,
    thumbnailUrl: `https://image.mux.com/${playback.id}/thumbnail.jpg?width=1280`,
    durationSeconds: asset.durationSeconds ?? null,
    title: metadata?.title ?? `Video ${String(asset.muxAssetId).slice(0, 6)}`,
    channelName: metadata?.custom?.channelName ?? "Robotube",
    createdAtMs: asset.createdAtMs ?? Date.now(),
  };
}

export const listFeedVideos = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const assets = await ctx.runQuery(components.mux.catalog.listAssets, {
      limit: args.limit ?? 25,
    });

    const rows = await Promise.all(
      assets.map((asset: any) => toFeedVideoRow(ctx, asset)),
    );

    return rows.filter((row): row is NonNullable<typeof row> => Boolean(row));
  },
});

export const getFeedVideoByMuxAssetId = query({
  args: { muxAssetId: v.string() },
  handler: async (ctx, args) => {
    const asset = await ctx.runQuery(components.mux.catalog.getAssetByMuxId, {
      muxAssetId: args.muxAssetId,
    });
    if (!asset) return null;
    return toFeedVideoRow(ctx, asset);
  },
});
