import { v } from "convex/values";

import { components } from "./_generated/api";
import { query } from "./_generated/server";

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export const getUploadModerationStatus = query({
  args: {
    uploadId: v.string(),
    userId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const upload = await ctx.runQuery(components.mux.catalog.getUploadByMuxId, {
      muxUploadId: args.uploadId,
    });

    if (!upload) {
      return {
        stage: "upload_pending",
        done: false,
        passed: null,
        progress: 95,
        statusText: "Waiting for Mux to confirm the upload...",
      };
    }

    const uploadRecord = asRecord(upload) ?? {};
    const uploadStatus = asString(uploadRecord.status) ?? "";
    const muxAssetId =
      asString(uploadRecord.assetId) ?? asString(uploadRecord.asset_id);

    if (!muxAssetId) {
      const pendingText =
        uploadStatus === "waiting"
          ? "Upload received. Waiting for Mux processing to start..."
          : "Upload complete. Creating your video asset...";
      return {
        stage: "asset_pending",
        done: false,
        passed: null,
        progress: 96,
        statusText: pendingText,
      };
    }

    const asset = await ctx.runQuery(components.mux.catalog.getAssetByMuxId, {
      muxAssetId,
    });
    const assetRecord = asRecord(asset) ?? {};
    const assetStatus = asString(assetRecord.status) ?? "";

    const video = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
      muxAssetId,
      userId: args.userId,
    });
    const videoRecord = asRecord(video) ?? {};
    const metadataValue = videoRecord.metadata;
    const metadataRecord = Array.isArray(metadataValue)
      ? asRecord(metadataValue[0])
      : asRecord(metadataValue);
    const custom = asRecord(metadataRecord?.custom) ?? {};

    const moderationCheckedAtMs = asNumber(custom.moderationCheckedAtMs);
    const moderationPassed = asBoolean(custom.moderationPassed);
    const moderationRetryScheduled = asBoolean(custom.moderationRetryScheduled);
    const moderationFailedAtMs = asNumber(custom.moderationFailedAtMs);

    if (moderationCheckedAtMs !== undefined) {
      if (moderationPassed) {
        return {
          stage: "approved",
          done: true,
          passed: true,
          progress: 100,
          statusText: "Moderation passed. Your video is now visible in the feed.",
        };
      }

      return {
        stage: "rejected",
        done: true,
        passed: false,
        progress: 100,
        statusText:
          "Moderation flagged this video. It stays private and hidden from the feed.",
      };
    }

    if (assetStatus !== "ready") {
      return {
        stage: "processing",
        done: false,
        passed: null,
        progress: 97,
        statusText: "Processing video... moderation will run as soon as it is ready.",
      };
    }

    if (moderationFailedAtMs !== undefined && moderationRetryScheduled) {
      return {
        stage: "moderation_retrying",
        done: false,
        passed: null,
        progress: 98,
        statusText: "Moderation check is retrying. Keeping your upload under review...",
      };
    }

    return {
      stage: "moderation_pending",
      done: false,
      passed: null,
      progress: 99,
      statusText: "Running moderation checks...",
    };
  },
});
