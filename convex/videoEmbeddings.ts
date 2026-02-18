import { v } from "convex/values";

import { internalMutation, internalQuery } from "./_generated/server";

export type EmbeddingChunk = {
  embedding: number[];
  chunkText?: string;
  startTimeSeconds?: number;
  endTimeSeconds?: number;
};

export const replaceAssetEmbeddingsInternal = internalMutation({
  args: {
    muxAssetId: v.string(),
    userId: v.string(),
    chunks: v.array(
      v.object({
        embedding: v.array(v.number()),
        chunkText: v.optional(v.string()),
        startTimeSeconds: v.optional(v.number()),
        endTimeSeconds: v.optional(v.number()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const db: any = ctx.db;
    const existing = await db
      .query("videoEmbeddings")
      .withIndex("by_asset", (q: any) => q.eq("muxAssetId", args.muxAssetId))
      .collect();

    for (const row of existing) {
      await db.delete(row._id);
    }

    let inserted = 0;
    for (const chunk of args.chunks) {
      await db.insert("videoEmbeddings", {
        muxAssetId: args.muxAssetId,
        userId: args.userId,
        embedding: chunk.embedding,
        chunkText: chunk.chunkText,
        startTimeSeconds: chunk.startTimeSeconds,
        endTimeSeconds: chunk.endTimeSeconds,
        createdAtMs: Date.now(),
      });
      inserted += 1;
    }

    return { inserted };
  },
});

export const findNearestAssetIdsByEmbeddingInternal = internalQuery({
  args: {
    embedding: v.array(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const expandedLimit = Math.max(20, Math.floor((args.limit ?? 10) * 8));
    const hits = await (ctx as any).vectorSearch("videoEmbeddings", "by_embedding", {
      vector: args.embedding,
      limit: expandedLimit,
    });

    const scoreByAsset = new Map<string, number>();
    for (const hit of hits) {
      const row = await (ctx.db as any).get(hit._id);
      if (!row) continue;

      const current = scoreByAsset.get(row.muxAssetId) ?? Number.NEGATIVE_INFINITY;
      if (hit._score > current) {
        scoreByAsset.set(row.muxAssetId, hit._score);
      }
    }

    return Array.from(scoreByAsset.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, args.limit ?? 10)
      .map(([muxAssetId, score]) => ({ muxAssetId, score }));
  },
});
