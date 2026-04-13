import { v } from "convex/values";

import { internalQuery, query } from "./_generated/server";

/**
 * List all currently active live streams for the feed.
 */
export const listActiveLiveStreams = query({
  args: {},
  handler: async (ctx) => {
    const streams = await ctx.db
      .query("liveStreams")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .order("desc")
      .collect();

    const results = [];
    for (const stream of streams) {
      const user = await ctx.db.get(stream.userId);
      results.push({
        _id: stream._id,
        title: stream.title,
        muxLiveStreamId: stream.muxLiveStreamId,
        playbackId: stream.playbackId ?? null,
        playbackUrl: stream.playbackId
          ? `https://stream.mux.com/${stream.playbackId}.m3u8`
          : null,
        thumbnailUrl: stream.playbackId
          ? `https://image.mux.com/${stream.playbackId}/thumbnail.jpg?width=640&time=1`
          : null,
        status: stream.status,
        channelName: user?.name ?? user?.username ?? "Unknown",
        channelAvatarUrl: user?.image ?? null,
        createdAtMs: stream.createdAtMs,
      });
    }

    return results;
  },
});

/**
 * Get a single live stream by its Mux live stream ID.
 */
export const getLiveStreamByMuxId = query({
  args: {
    muxLiveStreamId: v.string(),
  },
  handler: async (ctx, args) => {
    const stream = await ctx.db
      .query("liveStreams")
      .withIndex("by_mux_live_stream", (q) =>
        q.eq("muxLiveStreamId", args.muxLiveStreamId),
      )
      .first();

    if (!stream) return null;

    const user = await ctx.db.get(stream.userId);

    return {
      _id: stream._id,
      title: stream.title,
      muxLiveStreamId: stream.muxLiveStreamId,
      playbackId: stream.playbackId ?? null,
      playbackUrl: stream.playbackId
        ? `https://stream.mux.com/${stream.playbackId}.m3u8`
        : null,
      status: stream.status,
      channelName: user?.name ?? user?.username ?? "Unknown",
      channelAvatarUrl: user?.image ?? null,
      createdAtMs: stream.createdAtMs,
      endedAtMs: stream.endedAtMs ?? null,
    };
  },
});

export const getLiveStreamByMuxIdInternal = internalQuery({
  args: {
    muxLiveStreamId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("liveStreams")
      .withIndex("by_mux_live_stream", (q) =>
        q.eq("muxLiveStreamId", args.muxLiveStreamId),
      )
      .first();
  },
});
