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
  videoChatThreads: defineTable({
    userId: v.string(),
    muxAssetId: v.string(),
    threadId: v.string(),
    createdAtMs: v.number(),
  })
    .index("by_user_video", ["userId", "muxAssetId"])
    .index("by_thread", ["threadId"]),
  audioTranslationJobs: defineTable({
    muxAssetId: v.string(),
    userId: v.string(),
    languageCode: v.string(),
    languageLabel: v.optional(v.string()),
    status: v.optional(
      v.union(
        v.literal("requested"),
        v.literal("pending"),
        v.literal("processing"),
        v.literal("completed"),
        v.literal("errored"),
        v.literal("cancelled"),
      ),
    ),
    jobId: v.optional(v.string()),
    passthrough: v.optional(v.string()),
    uploadedTrackId: v.optional(v.string()),
    temporaryVttUrl: v.optional(v.string()),
    dubbingId: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    createdAtMs: v.number(),
    updatedAtMs: v.number(),
  })
    .index("by_asset", ["muxAssetId"])
    .index("by_asset_language", ["muxAssetId", "languageCode"]),
  captionTranslationJobs: defineTable({
    muxAssetId: v.string(),
    userId: v.string(),
    languageCode: v.string(),
    languageLabel: v.optional(v.string()),
    fromLanguageCode: v.string(),
    status: v.optional(
      v.union(
        v.literal("requested"),
        v.literal("pending"),
        v.literal("processing"),
        v.literal("completed"),
        v.literal("errored"),
        v.literal("cancelled"),
      ),
    ),
    jobId: v.optional(v.string()),
    passthrough: v.optional(v.string()),
    uploadedTrackId: v.optional(v.string()),
    temporaryVttUrl: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    createdAtMs: v.number(),
    updatedAtMs: v.number(),
  })
    .index("by_asset", ["muxAssetId"])
    .index("by_asset_language", ["muxAssetId", "languageCode"]),
  muxAssetCache: defineTable({
    muxAssetId: v.string(),
    status: v.string(),
    isReady: v.boolean(),
    isDeleted: v.boolean(),
    durationSeconds: v.optional(v.number()),
    createdAtMs: v.number(),
    deletedAtMs: v.optional(v.number()),
    passthrough: v.optional(v.string()),
    playbackIds: v.array(
      v.object({
        id: v.string(),
        policy: v.optional(v.string()),
      }),
    ),
    updatedAtMs: v.number(),
  })
    .index("by_mux_asset", ["muxAssetId"])
    .index("by_ready_deleted_created", ["isReady", "isDeleted", "createdAtMs"]),
  aiMetadataLocks: defineTable({
    muxAssetId: v.string(),
    userId: v.string(),
    startedAtMs: v.number(),
    expiresAtMs: v.number(),
  }).index("by_asset", ["muxAssetId"]),
  moderationLocks: defineTable({
    muxAssetId: v.string(),
    userId: v.string(),
    startedAtMs: v.number(),
    expiresAtMs: v.number(),
  }).index("by_asset", ["muxAssetId"]),
});
