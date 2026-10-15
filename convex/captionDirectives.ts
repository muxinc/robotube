import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { upsertVideoMetadataAndSyncFeedReadModel } from "./feedReadModelSync";

export const claimInternal = internalMutation({
  args: { muxAssetId: v.string(), userId: v.string(), directiveId: v.optional(v.string()), includeSpeakers: v.boolean() },
  handler: async (ctx, args) => {
    const cache = await ctx.runQuery(internal.muxAssetCache.getByMuxAssetIdInternal, { muxAssetId: args.muxAssetId });
    const video: any = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, { muxAssetId: args.muxAssetId, userId: args.userId });
    const metadata = (Array.isArray(video?.metadata) ? video.metadata[0] : video?.metadata) ?? {};
    if (cache?.isDeleted || !video?.asset || metadata.userId !== args.userId || metadata.custom?.moderationPassed !== true || typeof metadata.custom?.moderationCheckedAtMs !== "number" || metadata.custom?.includeSpeakers !== args.includeSpeakers) return null;
    const existing = await ctx.db.query("captionDirectiveClaims").withIndex("by_asset", q => q.eq("muxAssetId", args.muxAssetId)).unique();
    if (existing) {
      if (existing.userId !== args.userId || existing.includeSpeakers !== args.includeSpeakers) return null;
      return { ...existing, acquired: false };
    }
    if (!args.directiveId) return { needsConfiguration: true as const };
    const claim = { ...args, directiveId: args.directiveId, createdAtMs: Date.now() };
    const id = await ctx.db.insert("captionDirectiveClaims", claim);
    return { ...claim, _id: id, acquired: true };
  },
});

export const updateMetadataInternal = internalMutation({
  args: { muxAssetId: v.string(), userId: v.string(), fields: v.record(v.string(), v.any()) },
  handler: async (ctx, args) => {
    const cache = await ctx.runQuery(internal.muxAssetCache.getByMuxAssetIdInternal, { muxAssetId: args.muxAssetId });
    const video: any = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, { muxAssetId: args.muxAssetId, userId: args.userId });
    const metadata = (Array.isArray(video?.metadata) ? video.metadata[0] : video?.metadata) ?? {};
    if (cache?.isDeleted || !video?.asset || metadata.userId !== args.userId || metadata.custom?.moderationPassed !== true || typeof metadata.custom?.moderationCheckedAtMs !== "number") return {};
    // Generation owns only the initial source. Even a same-job late poll must
    // not overwrite finalization or a canonical source advanced by the editor.
    const current = metadata.custom ?? {};
    if (current.aiCaptionsGeneratedAtMs !== undefined || current.aiCaptionsTrackId ||
        (current.aiCaptionsRevision ?? 0) > 0 || current.aiCaptionsEditedAtMs !== undefined) return {};
    const claim = await ctx.db.query("captionDirectiveClaims").withIndex("by_asset", q => q.eq("muxAssetId", args.muxAssetId)).unique();
    if (!claim) {
      // Configuration can fail before claiming; diagnostics may be recorded,
      // but no run, job, output, or canonical-source fields may be accepted.
      const diagnosticKeys = new Set(["aiCaptionsFailedAtMs", "aiCaptionsLastError", "aiCaptionsAttemptCount", "aiCaptionsRetryScheduled", "aiCaptionsUnavailableReason", "aiCaptionsPollingTimedOut"]);
      if (typeof current.includeSpeakers !== "boolean" || Object.keys(args.fields).some(key => !diagnosticKeys.has(key))) return {};
    } else if (claim.userId !== args.userId || claim.includeSpeakers !== current.includeSpeakers) return {};
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
