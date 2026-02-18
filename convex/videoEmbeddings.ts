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
        embedding: v.array(v.float64()),
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

export const getEmbeddingRowsByIdsInternal = internalQuery({
  args: {
    ids: v.array(v.id("videoEmbeddings")),
  },
  handler: async (ctx, args) => {
    const rows: Array<{ _id: string; muxAssetId: string }> = [];
    for (const id of args.ids) {
      const row = await (ctx.db as any).get(id);
      if (!row) continue;
      rows.push({ _id: String(id), muxAssetId: row.muxAssetId });
    }
    return rows;
  },
});
