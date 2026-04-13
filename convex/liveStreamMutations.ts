import { v } from "convex/values";

import { internalMutation } from "./_generated/server";

const liveStreamStatus = v.union(
  v.literal("idle"),
  v.literal("active"),
  v.literal("disabled"),
);

export const insertLiveStreamInternal = internalMutation({
  args: {
    userId: v.id("users"),
    title: v.string(),
    muxLiveStreamId: v.string(),
    livekitRoomName: v.string(),
    broadcasterIdentity: v.string(),
    livekitEgressId: v.optional(v.string()),
    streamKey: v.string(),
    playbackId: v.optional(v.string()),
    status: liveStreamStatus,
    createdAtMs: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("liveStreams", args);
  },
});

export const patchLiveStreamInternal = internalMutation({
  args: {
    muxLiveStreamId: v.string(),
    status: v.optional(liveStreamStatus),
    endedAtMs: v.optional(v.number()),
    livekitEgressId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("liveStreams")
      .withIndex("by_mux_live_stream", (q) =>
        q.eq("muxLiveStreamId", args.muxLiveStreamId),
      )
      .first();

    if (!doc) return;

    const patch: Record<string, unknown> = {};
    if (args.status !== undefined) {
      patch.status = args.status;
    }
    if (args.endedAtMs !== undefined) {
      patch.endedAtMs = args.endedAtMs;
    }
    if (args.livekitEgressId !== undefined) {
      patch.livekitEgressId = args.livekitEgressId;
    }

    if (Object.keys(patch).length === 0) return;

    await ctx.db.patch(doc._id, patch);
  },
});
