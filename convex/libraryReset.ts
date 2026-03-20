import { internalMutation } from "./_generated/server";

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
