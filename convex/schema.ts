import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";

export default defineSchema({
  ...authTables,
  users: defineTable({
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    avatarStorageId: v.optional(v.id("_storage")),
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
    // Display-ready values denormalized from the Mux component so the paginated
    // feed query never runs a per-video subquery. Optional for older rows that
    // have not been backfilled.
    feedTitle: v.optional(v.string()),
    feedChannelName: v.optional(v.string()),
    feedUploaderUserId: v.optional(v.string()),
    // Metadata visibility, denormalized so the card path can withhold private
    // videos without a per-video Mux metadata read. Absent means "never written",
    // which is treated as permitted.
    feedVisibility: v.optional(
      v.union(v.literal("public"), v.literal("unlisted"), v.literal("private")),
    ),
    feedReadModelUpdatedAtMs: v.optional(v.number()),
    // Normalized display aspect ratio from the processed Mux asset, plus the
    // denormalized feed placement it selects. Optional so legacy rows stay
    // readable before the classification backfill runs; an unclassified row is
    // in neither indexed feed and remains visible on the legacy Home path.
    aspectRatio: v.optional(v.string()),
    feedPlacement: v.optional(
      v.union(v.literal("standard"), v.literal("vertical"), v.literal("unknown")),
    ),
    aspectRatioUpdatedAtMs: v.optional(v.number()),
    updatedAtMs: v.number(),
  })
    .index("by_mux_asset", ["muxAssetId"])
    .index("by_ready_deleted_created", ["isReady", "isDeleted", "createdAtMs"])
    // Placement must lead the index: Convex applies a cursor after the index
    // range, so a placement-scoped feed has to filter through the index rather
    // than filter a mixed page afterwards.
    .index("by_feed_placement_ready_deleted_created", [
      "feedPlacement",
      "isReady",
      "isDeleted",
      "createdAtMs",
    ]),
  feedRuntimeConfig: defineTable({
    key: v.literal("vertical-feed"),
    shortsTabEnabled: v.boolean(),
    exclusiveFeedPlacementEnabled: v.boolean(),
    androidPhysicalValidationCompleted: v.boolean(),
    updatedAtMs: v.number(),
  }).index("by_key", ["key"]),
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
  liveStreams: defineTable({
    userId: v.id("users"),
    title: v.string(),
    muxLiveStreamId: v.string(),
    livekitRoomName: v.string(),
    broadcasterIdentity: v.string(),
    livekitEgressId: v.optional(v.string()),
    streamKey: v.string(),
    playbackId: v.optional(v.string()),
    status: v.union(
      v.literal("idle"),
      v.literal("active"),
      v.literal("disabled"),
    ),
    createdAtMs: v.number(),
    endedAtMs: v.optional(v.number()),
  })
    .index("by_mux_live_stream", ["muxLiveStreamId"])
    .index("by_user", ["userId"])
    .index("by_status", ["status", "createdAtMs"]),
});
