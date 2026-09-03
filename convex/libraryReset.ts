import { v } from "convex/values";

import { internalMutation, internalQuery } from "./_generated/server";

async function deleteRowsForAsset(
  db: any,
  table: string,
  muxAssetId: string,
) {
  const rows = await db
    .query(table)
    .withIndex("by_asset", (q: any) => q.eq("muxAssetId", muxAssetId))
    .collect();
  for (const row of rows) {
    await db.delete(row._id);
  }
  return rows;
}

/**
 * Removes app-owned data for one deleted Mux asset. The feed cache row is kept
 * as a tombstone so a late ready/update webhook cannot put the video back into
 * a timeline after the owner deleted it.
 */
export const deleteVideoDataInternal = internalMutation({
  args: { muxAssetId: v.string() },
  handler: async (ctx, args) => {
    const db: any = ctx.db;
    const videoEmbeddings = await deleteRowsForAsset(
      db,
      "videoEmbeddings",
      args.muxAssetId,
    );
    const videoChatThreads = await deleteRowsForAsset(
      db,
      "videoChatThreads",
      args.muxAssetId,
    );
    const audioTranslationJobs = await deleteRowsForAsset(
      db,
      "audioTranslationJobs",
      args.muxAssetId,
    );
    const captionTranslationJobs = await deleteRowsForAsset(
      db,
      "captionTranslationJobs",
      args.muxAssetId,
    );
    const aiMetadataLocks = await deleteRowsForAsset(
      db,
      "aiMetadataLocks",
      args.muxAssetId,
    );
    const moderationLocks = await deleteRowsForAsset(
      db,
      "moderationLocks",
      args.muxAssetId,
    );

    const cachedAsset = await db
      .query("muxAssetCache")
      .withIndex("by_mux_asset", (q: any) =>
        q.eq("muxAssetId", args.muxAssetId),
      )
      .unique();
    const deletedAtMs = Date.now();
    if (cachedAsset) {
      await db.patch(cachedAsset._id, {
        status: "deleted",
        isReady: false,
        isDeleted: true,
        deletedAtMs,
        playbackIds: [],
        feedTitle: undefined,
        feedChannelName: undefined,
        feedUploaderUserId: undefined,
        feedVisibility: undefined,
        feedThumbnailTimestampMs: undefined,
        updatedAtMs: deletedAtMs,
      });
    } else {
      await db.insert("muxAssetCache", {
        muxAssetId: args.muxAssetId,
        status: "deleted",
        isReady: false,
        isDeleted: true,
        createdAtMs: deletedAtMs,
        deletedAtMs,
        playbackIds: [],
        feedPlacement: "unknown",
        updatedAtMs: deletedAtMs,
      });
    }

    return {
      deletedVideoEmbeddings: videoEmbeddings.length,
      deletedVideoChatThreads: videoChatThreads.length,
      deletedAudioTranslationJobs: audioTranslationJobs.length,
      deletedCaptionTranslationJobs: captionTranslationJobs.length,
      deletedAiMetadataLocks: aiMetadataLocks.length,
      deletedModerationLocks: moderationLocks.length,
    };
  },
});

export const getVideoChatThreadIdsInternal = internalQuery({
  args: { muxAssetId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("videoChatThreads")
      .withIndex("by_asset", (q) => q.eq("muxAssetId", args.muxAssetId))
      .collect();
    return rows.map((row) => row.threadId);
  },
});

export const clearVideoLibraryInternal = internalMutation({
  args: {},
  handler: async (ctx) => {
    const db: any = ctx.db;

    const videoEmbeddings = await db.query("videoEmbeddings").collect();
    for (const row of videoEmbeddings) {
      await db.delete(row._id);
    }

    const videoChatThreads = await db.query("videoChatThreads").collect();
    for (const row of videoChatThreads) {
      await db.delete(row._id);
    }

    const audioTranslationJobs = await db.query("audioTranslationJobs").collect();
    for (const row of audioTranslationJobs) {
      await db.delete(row._id);
    }

    const muxAssetCache = await db.query("muxAssetCache").collect();
    for (const row of muxAssetCache) {
      await db.delete(row._id);
    }

    return {
      deletedVideoEmbeddings: videoEmbeddings.length,
      deletedVideoChatThreads: videoChatThreads.length,
      deletedAudioTranslationJobs: audioTranslationJobs.length,
      deletedMuxAssetCacheRows: muxAssetCache.length,
    };
  },
});
