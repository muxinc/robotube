"use node";

import { randomUUID } from "node:crypto";

import Mux from "@mux/mux-node";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";

import { normalizeAudioTranslationLanguageCodes } from "../constants/audio-translation-languages";
import { components, internal } from "./_generated/api";
import { action, internalAction } from "./_generated/server";
import { isLaravelOrchestrationEnabled } from "./laravelFlag";
import { upsertVideoMetadataAndSyncFeedReadModel } from "./feedReadModelSync";

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
  audioTranslationLanguageCodes?: string[];
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
      audioTranslationLanguageCodes: normalizeAudioTranslationLanguageCodes(
        asStringArray(asRecord(parsedObj.custom)?.audioTranslationLanguageCodes) ?? [],
      ),
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

function isMuxRobotsPollingDisabled() {
  return process.env.DISABLE_MUX_ROBOTS_POLLING === "true";
}

export const createMuxDirectUpload = action({
  args: {
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    useGeneratedTitle: v.optional(v.boolean()),
    useGeneratedDescription: v.optional(v.boolean()),
    audioTranslationLanguageCodes: v.optional(v.array(v.string())),
    captionTranslationLanguageCodes: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("You must be signed in to upload videos.");
    }

    const mux = createMuxClient();
    const userId = authUserId;
    const title = args.title?.trim() || undefined;
    const description = args.description?.trim() || undefined;
    const audioTranslationLanguageCodes = normalizeAudioTranslationLanguageCodes(
      args.audioTranslationLanguageCodes ?? [],
    );
    const captionTranslationLanguageCodes = normalizeAudioTranslationLanguageCodes(
      args.captionTranslationLanguageCodes ?? [],
    );
    // Mux caps passthrough at 255 characters, so the user's title never goes
    // into it: each upload gets a short unique reference id that becomes the
    // Mux-side meta.title/external_id (asset identity + dashboard search),
    // while the full title only lives in Convex videoMetadata (carried via the
    // syncUploadAssetAndMetadataInternal scheduler args below).
    //
    // Write both language keys whenever either job was requested: a
    // present-but-empty captionTranslationLanguageCodes means "explicitly no
    // captions", while a missing key means a legacy upload where the audio
    // list covered both jobs.
    const muxReferenceId = `rt-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const passthrough = JSON.stringify({
      userId,
      // Upload and process privately. The uploader explicitly publishes after
      // reviewing the generated Mux Robots metadata draft.
      visibility: "private",
      custom: {
        awaitingMetadataReview: true,
        audioTranslationLanguageCodes,
        captionTranslationLanguageCodes,
      },
    });

    const upload = await mux.video.uploads.create({
      cors_origin: "*",
      new_asset_settings: {
        playback_policies: ["public"],
        passthrough,
        meta: {
          title: muxReferenceId,
          external_id: muxReferenceId,
        },
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
          description,
          useGeneratedTitle: args.useGeneratedTitle,
          useGeneratedDescription: args.useGeneratedDescription,
          attempt: 0,
        },
      );
    }

    return {
      uploadId: upload.id,
      uploadUrl: upload.url,
      status: upload.status,
      muxReferenceId,
    };
  },
});

export const syncUploadAssetAndMetadataInternal = internalAction({
  args: {
    uploadId: v.string(),
    userId: v.string(),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    useGeneratedTitle: v.optional(v.boolean()),
    useGeneratedDescription: v.optional(v.boolean()),
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
              description: args.description,
              useGeneratedTitle: args.useGeneratedTitle,
              useGeneratedDescription: args.useGeneratedDescription,
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
      await ctx.runMutation((internal as any).muxAssetCache.upsertFromPayloadInternal, {
        asset,
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
      const resolvedDescription = metadata.description ?? args.description;
      if (resolvedDescription !== undefined) {
        metadataArgs.description = resolvedDescription;
      }
      if (metadata.tags !== undefined) metadataArgs.tags = metadata.tags;
      if (metadata.visibility !== undefined) {
        metadataArgs.visibility = metadata.visibility;
      }
      // The Mux-side asset title is a generated reference id (see
      // createMuxDirectUpload); keep it on the Convex video so the two can be
      // cross-referenced later.
      const muxReferenceId = asString(asRecord((asset as any).meta)?.external_id);
      const mergedCustom = {
        ...(metadata.custom ?? {}),
        ...(args.useGeneratedTitle !== undefined
          ? { aiUseGeneratedTitle: args.useGeneratedTitle }
          : {}),
        ...(args.useGeneratedDescription !== undefined
          ? { aiUseGeneratedDescription: args.useGeneratedDescription }
          : {}),
        ...(muxReferenceId ? { muxReferenceId } : {}),
      };
      if (Object.keys(mergedCustom).length > 0) {
        metadataArgs.custom = mergedCustom;
      }

      await upsertVideoMetadataAndSyncFeedReadModel(ctx, metadataArgs);

      if (asString(asset.status) !== "ready") {
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
              description: args.description,
              useGeneratedTitle: args.useGeneratedTitle,
              useGeneratedDescription: args.useGeneratedDescription,
              attempt: nextAttempt,
            },
          );
        }

        return {
          ok: false,
          skipped: true,
          reason: "asset_processing",
          retryScheduled: shouldRetry,
          nextAttempt,
          muxAssetId,
        };
      }

      if (isLaravelOrchestrationEnabled()) {
        // Laravel is the ONLY Robots runner. Hand off to the Laravel
        // orchestration backend instead of kicking off the Convex-native
        // moderation -> AI-metadata pipeline (which would create duplicate
        // Robots jobs). Convex creates zero Robots jobs on this path.
        await ctx.scheduler.runAfter(
          0,
          (internal as any).laravelOrchestration.startLaravelRobotRun,
          {
            muxAssetId,
            userId: metadataArgs.userId,
            title: resolvedTitle,
            attempt: 0,
          },
        );
      } else if (!isMuxRobotsPollingDisabled()) {
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
            description: args.description,
            useGeneratedTitle: args.useGeneratedTitle,
            useGeneratedDescription: args.useGeneratedDescription,
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
