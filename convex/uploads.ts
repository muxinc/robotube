"use node";

import Mux from "@mux/mux-node";
import { v } from "convex/values";

import { components, internal } from "./_generated/api";
import { action, internalAction } from "./_generated/server";

function requiredEnv(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function createMuxClient() {
  return new Mux({
    tokenId: requiredEnv("MUX_TOKEN_ID", process.env.MUX_TOKEN_ID),
    tokenSecret: requiredEnv("MUX_TOKEN_SECRET", process.env.MUX_TOKEN_SECRET),
  });
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length > 0 ? strings : undefined;
}

function asVisibility(
  value: unknown,
): "private" | "unlisted" | "public" | undefined {
  return value === "private" || value === "unlisted" || value === "public"
    ? value
    : undefined;
}

function parseMetadataPassthrough(passthrough: unknown): {
  userId?: string;
  title?: string;
  description?: string;
  tags?: string[];
  visibility?: "private" | "unlisted" | "public";
  custom?: Record<string, unknown>;
} {
  const raw = asString(passthrough);
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    const parsedObj = asRecord(parsed);
    if (!parsedObj) return { userId: raw };

    return {
      userId: asString(parsedObj.userId) ?? asString(parsedObj.user_id),
      title: asString(parsedObj.title),
      description: asString(parsedObj.description),
      tags: asStringArray(parsedObj.tags),
      visibility: asVisibility(parsedObj.visibility),
      custom: asRecord(parsedObj.custom),
    };
  } catch {
    return { userId: raw };
  }
}

const MAX_UPLOAD_SYNC_ATTEMPTS = 40;

function getUploadSyncDelayMs(nextAttempt: number) {
  if (nextAttempt <= 5) return 5 * 1000;
  if (nextAttempt <= 20) return 15 * 1000;
  return 60 * 1000;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

export const createMuxDirectUpload = action({
  args: {
    userId: v.optional(v.string()),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const mux = createMuxClient();
    const userId = args.userId ?? "mobile-user";
    const title = args.title?.trim() || undefined;
    const passthrough = JSON.stringify({
      userId,
      title,
      visibility: "private",
    });

    const upload = await mux.video.uploads.create({
      cors_origin: "*",
      new_asset_settings: {
        playback_policies: ["public"],
        passthrough,
      },
    });

    await ctx.runMutation(components.mux.sync.upsertUploadFromPayloadPublic, {
      upload: upload as unknown as Record<string, unknown>,
    });

    if (upload.id) {
      await ctx.scheduler.runAfter(
        0,
        (internal as any).uploads.syncUploadAssetAndMetadataInternal,
        {
          uploadId: upload.id,
          userId,
          title,
          attempt: 0,
        },
      );
    }

    return {
      uploadId: upload.id,
      uploadUrl: upload.url,
      status: upload.status,
    };
  },
});

export const syncUploadAssetAndMetadataInternal = internalAction({
  args: {
    uploadId: v.string(),
    userId: v.string(),
    title: v.optional(v.string()),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const mux = createMuxClient();
    const attempt = Math.max(0, Math.floor(args.attempt ?? 0));

    try {
      const upload = await mux.video.uploads.retrieve(args.uploadId);
      await ctx.runMutation(components.mux.sync.upsertUploadFromPayloadPublic, {
        upload: upload as unknown as Record<string, unknown>,
      });

      const muxAssetId = asString(upload.asset_id);
      if (!muxAssetId) {
        const nextAttempt = attempt + 1;
        const shouldRetry = nextAttempt < MAX_UPLOAD_SYNC_ATTEMPTS;
        if (shouldRetry) {
          await ctx.scheduler.runAfter(
            getUploadSyncDelayMs(nextAttempt),
            (internal as any).uploads.syncUploadAssetAndMetadataInternal,
            {
              uploadId: args.uploadId,
              userId: args.userId,
              title: args.title,
              attempt: nextAttempt,
            },
          );
        }
        return {
          ok: false,
          skipped: true,
          reason: "asset_not_ready",
          retryScheduled: shouldRetry,
          nextAttempt,
        };
      }

      const asset = await mux.video.assets.retrieve(muxAssetId);
      await ctx.runMutation(components.mux.sync.upsertAssetFromPayloadPublic, {
        asset: asset as unknown as Record<string, unknown>,
      });

      const metadata = parseMetadataPassthrough(asset.passthrough);
      const metadataArgs: {
        muxAssetId: string;
        userId: string;
        title?: string;
        description?: string;
        tags?: string[];
        visibility?: "private" | "unlisted" | "public";
        custom?: Record<string, unknown>;
      } = {
        muxAssetId,
        userId: metadata.userId ?? args.userId,
      };

      const resolvedTitle = metadata.title ?? args.title;
      if (resolvedTitle !== undefined) metadataArgs.title = resolvedTitle;
      if (metadata.description !== undefined) {
        metadataArgs.description = metadata.description;
      }
      if (metadata.tags !== undefined) metadataArgs.tags = metadata.tags;
      if (metadata.visibility !== undefined) {
        metadataArgs.visibility = metadata.visibility;
      }
      if (metadata.custom !== undefined) metadataArgs.custom = metadata.custom;

      await ctx.runMutation(components.mux.videos.upsertVideoMetadata, metadataArgs);

      if (asString(asset.status) === "ready") {
        await ctx.scheduler.runAfter(
          0,
          (internal as any).aiMetadata.generateSummaryAndTagsForAssetInternal,
          {
            muxAssetId,
            userId: metadataArgs.userId,
            attempt: 0,
          },
        );

        await ctx.scheduler.runAfter(
          0,
          (internal as any).moderation.moderateAssetInternal,
          {
            muxAssetId,
            userId: metadataArgs.userId,
            attempt: 0,
          },
        );
      }

      return { ok: true, skipped: false, muxAssetId };
    } catch (error) {
      const message = getErrorMessage(error);
      const nextAttempt = attempt + 1;
      const shouldRetry = nextAttempt < MAX_UPLOAD_SYNC_ATTEMPTS;
      if (shouldRetry) {
        await ctx.scheduler.runAfter(
          getUploadSyncDelayMs(nextAttempt),
          (internal as any).uploads.syncUploadAssetAndMetadataInternal,
          {
            uploadId: args.uploadId,
            userId: args.userId,
            title: args.title,
            attempt: nextAttempt,
          },
        );
      }
      return {
        ok: false,
        skipped: false,
        error: message,
        retryScheduled: shouldRetry,
        nextAttempt,
      };
    }
  },
});
