import { v } from "convex/values";

import { components, internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { upsertVideoMetadataAndSyncFeedReadModel } from "./feedReadModelSync";

/** Upload polling and webhook replays only fill missing metadata, atomically. */
export const seedInternal = internalMutation({
  args: {
    muxAssetId: v.string(), userId: v.string(),
    title: v.optional(v.string()), description: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    visibility: v.optional(v.union(v.literal("private"), v.literal("unlisted"), v.literal("public"))),
    custom: v.optional(v.record(v.string(), v.any())),
  },
  handler: async (ctx, args) => {
    const cache = await ctx.runQuery(internal.muxAssetCache.getByMuxAssetIdInternal, {
      muxAssetId: args.muxAssetId,
    });
    if (cache?.isDeleted) return { seeded: false };
    const video: any = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
      muxAssetId: args.muxAssetId, userId: args.userId,
    });
    if (!video?.asset) return { seeded: false };
    const existing = (Array.isArray(video.metadata) ? video.metadata[0] : video.metadata) ?? {};
    await upsertVideoMetadataAndSyncFeedReadModel(ctx, {
      ...args,
      title: existing.title ?? args.title,
      description: existing.description ?? args.description,
      tags: existing.tags ?? args.tags,
      visibility: existing.visibility ?? args.visibility,
      custom: { ...args.custom, ...existing.custom },
    });
    return { seeded: true };
  },
});
