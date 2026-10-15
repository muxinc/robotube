import { v } from "convex/values";

import { components, internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { upsertVideoMetadataAndSyncFeedReadModel } from "./feedReadModelSync";
import { isLaravelOrchestrationEnabled } from "./laravelFlag";

function record(value: any): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function metadataOf(video: any) {
  return record(Array.isArray(video?.metadata) ? video.metadata[0] : video?.metadata);
}

/** The marker and scheduled action commit together, including component writes. */
export const enqueueForReadyAssetInternal = internalMutation({
  args: { muxAssetId: v.string(), userId: v.string() },
  handler: async (ctx, args) => {
    if (!isLaravelOrchestrationEnabled()) return { scheduled: false, reason: "flag_off" };
    if (!process.env.LARAVEL_ORCHESTRATION_URL || !process.env.LARAVEL_ORCHESTRATION_SECRET)
      return { scheduled: false, reason: "missing_env" };
    const cache = await ctx.runQuery(internal.muxAssetCache.getByMuxAssetIdInternal, {
      muxAssetId: args.muxAssetId,
    });
    if (cache?.isDeleted) return { scheduled: false, reason: "deleted" };
    const video = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, args);
    if (video?.asset?.status !== "ready") return { scheduled: false, reason: "not_ready" };
    const metadata = metadataOf(video);
    if (metadata.userId !== args.userId || args.userId === "default")
      return { scheduled: false, reason: "missing_owner" };
    const custom = record(metadata.custom);
    // Keep this guard after completion too: Laravel allows a NEW run once the
    // previous one is terminal, but repeated ready events are not rerun requests.
    if (typeof custom.laravelRunId === "number" || custom.laravelKickoffScheduledAtMs !== undefined)
      return { scheduled: false, reason: "already_started" };

    await upsertVideoMetadataAndSyncFeedReadModel(ctx, {
      ...args,
      custom: { ...custom, laravelKickoffScheduledAtMs: Date.now() },
    });
    await ctx.scheduler.runAfter(0, internal.laravelOrchestration.startLaravelRobotRun, {
      ...args,
      title: typeof metadata.title === "string" ? metadata.title : undefined,
      attempt: 0,
    });
    return { scheduled: true };
  },
});

/** Avoid overwriting a fast moderation sync with the initial POST response. */
export const storeRunInternal = internalMutation({
  args: { muxAssetId: v.string(), userId: v.string(), runId: v.number(), runStatus: v.string() },
  handler: async (ctx, args) => {
    const cache = await ctx.runQuery(internal.muxAssetCache.getByMuxAssetIdInternal, {
      muxAssetId: args.muxAssetId,
    });
    if (cache?.isDeleted) return;
    const video = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
      muxAssetId: args.muxAssetId, userId: args.userId,
    });
    if (!video?.asset) return;
    const metadata = metadataOf(video);
    const custom = record(metadata.custom);
    if (typeof custom.laravelRunId === "number" && custom.laravelRunId > args.runId) return;
    await upsertVideoMetadataAndSyncFeedReadModel(ctx, {
      muxAssetId: args.muxAssetId,
      userId: args.userId,
      custom: {
        ...custom,
        laravelRunId: args.runId,
        laravelRunStatus: custom.laravelRunId === args.runId
          ? custom.laravelRunStatus ?? args.runStatus
          : args.runStatus,
        laravelRunUpdatedAtMs: Date.now(),
      },
    });
  },
});
