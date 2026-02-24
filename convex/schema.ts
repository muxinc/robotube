import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";

export default defineSchema({
  ...authTables,
  users: defineTable({
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    username: v.optional(v.string()),
  })
    .index("email", ["email"])
    .index("phone", ["phone"])
    .index("username", ["username"]),
  videoEmbeddings: defineTable({
    muxAssetId: v.string(),
    userId: v.string(),
    chunkText: v.optional(v.string()),
    startTimeSeconds: v.optional(v.number()),
    endTimeSeconds: v.optional(v.number()),
    embedding: v.array(v.float64()),
    createdAtMs: v.number(),
  })
    .index("by_asset", ["muxAssetId"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["muxAssetId", "userId"],
    }),
});
