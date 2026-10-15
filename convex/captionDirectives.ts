import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { upsertVideoMetadataAndSyncFeedReadModel } from "./feedReadModelSync";

export const claimInternal = internalMutation({
  args: { muxAssetId: v.string(), userId: v.string(), directiveId: v.string(), includeSpeakers: v.boolean() },
  handler: async (ctx, args) => {
    const cache = await ctx.runQuery(internal.muxAssetCache.getByMuxAssetIdInternal, { muxAssetId: args.muxAssetId });
    const video: any = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, { muxAssetId: args.muxAssetId, userId: args.userId });
    const metadata = (Array.isArray(video?.metadata) ? video.metadata[0] : video?.metadata) ?? {};
    if (cache?.isDeleted || !video?.asset || metadata.userId !== args.userId || metadata.custom?.moderationPassed !== true || typeof metadata.custom?.moderationCheckedAtMs !== "number" || metadata.custom?.includeSpeakers !== args.includeSpeakers) return null;
    const existing = await (ctx.db as any).query("captionDirectiveClaims").withIndex("by_asset", (q: any) => q.eq("muxAssetId", args.muxAssetId)).unique();
    if (existing) {
      if (existing.userId !== args.userId || existing.includeSpeakers !== args.includeSpeakers) return null;
      return { ...existing, acquired: false };
    }
    const claim = { ...args, createdAtMs: Date.now() };
    const id = await (ctx.db as any).insert("captionDirectiveClaims", claim);
    return { ...claim, _id: id, acquired: true };
  },
});

export const updateMetadataInternal = internalMutation({
  args: { muxAssetId: v.string(), userId: v.string(), fields: v.record(v.string(), v.any()) },
  handler: async (ctx, args) => {
    const cache = await ctx.runQuery(internal.muxAssetCache.getByMuxAssetIdInternal, { muxAssetId: args.muxAssetId });
    const video: any = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, { muxAssetId: args.muxAssetId, userId: args.userId });
    const metadata = (Array.isArray(video?.metadata) ? video.metadata[0] : video?.metadata) ?? {};
    if (cache?.isDeleted || !video?.asset || metadata.userId !== args.userId || metadata.custom?.moderationPassed !== true) return {};
    const claim = await (ctx.db as any).query("captionDirectiveClaims").withIndex("by_asset", (q: any) => q.eq("muxAssetId", args.muxAssetId)).unique();
    if (!claim || claim.userId !== args.userId || claim.includeSpeakers !== metadata.custom?.includeSpeakers) return {};
    if (args.fields.aiCaptionsJobId && metadata.custom?.aiCaptionsJobId && args.fields.aiCaptionsJobId !== metadata.custom.aiCaptionsJobId) return {};
    const custom = { ...metadata.custom, ...args.fields };
    await upsertVideoMetadataAndSyncFeedReadModel(ctx, {
      muxAssetId: args.muxAssetId, userId: args.userId,
      title: metadata.title, description: metadata.description, tags: metadata.tags,
      visibility: metadata.visibility, custom,
    });
    return custom;
  },
});

export const recordRunInternal = internalMutation({
  args: { claimId: v.id("captionDirectiveClaims"), runId: v.string() },
  handler: async (ctx, args) => {
    const claim = await ctx.db.get(args.claimId);
    if (!claim || claim.runId) return;
    const cache = await ctx.runQuery(internal.muxAssetCache.getByMuxAssetIdInternal, { muxAssetId: claim.muxAssetId });
    if (cache?.isDeleted) return;
    await ctx.db.patch(args.claimId, { runId: args.runId });
  },
});
