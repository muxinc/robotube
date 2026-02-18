import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  videoEmbeddings: defineTable({
    muxAssetId: v.string(),
    userId: v.string(),
    chunkText: v.optional(v.string()),
    startTimeSeconds: v.optional(v.number()),
    endTimeSeconds: v.optional(v.number()),
    embedding: v.array(v.number()),
    createdAtMs: v.number(),
  })
    .index("by_asset", ["muxAssetId"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["muxAssetId", "userId"],
    }),
});
