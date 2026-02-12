import { v } from "convex/values";

import { components } from "./_generated/api";
import { query } from "./_generated/server";

type PlaybackId = {
  id?: string;
  policy?: string;
};

export const listFeedVideos = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const assets = await ctx.runQuery(components.mux.catalog.listAssets, {
      limit: args.limit ?? 25,
    });
    const metadataRows = await ctx.db.query("videoMetadata").collect();
    const metadataByAssetId = new Map<string, any>();
    for (const row of metadataRows as any[]) {
      if (!metadataByAssetId.has(row.muxAssetId)) {
        metadataByAssetId.set(row.muxAssetId, row);
      }
    }

    const rows = await Promise.all(
      assets.map(async (asset: any) => {
        const playbackIds = (asset.playbackIds ?? []) as PlaybackId[];
        const playback = playbackIds.find((id) => id.policy === "public") ?? playbackIds[0];
        if (!playback?.id) return null;
        if (asset.deletedAtMs || asset.status !== "ready") return null;
        const metadata = metadataByAssetId.get(asset.muxAssetId);

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
      }),
    );

    return rows.filter((row): row is NonNullable<typeof row> => Boolean(row));
  },
});
