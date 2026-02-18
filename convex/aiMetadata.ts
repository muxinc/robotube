"use node";

import { getSummaryAndTags } from "@mux/ai/workflows";
import { v } from "convex/values";

import { components, internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

const MAX_ATTEMPTS = 10;

function getRetryDelayMs(nextAttempt: number) {
  if (nextAttempt <= 1) return 5 * 60 * 1000;
  if (nextAttempt === 2) return 30 * 60 * 1000;
  if (nextAttempt === 3) return 2 * 60 * 60 * 1000;
  return 12 * 60 * 60 * 1000;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function asCustomRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function buildMetadataArgs(args: {
  muxAssetId: string;
  userId: string;
  title?: string;
  description?: string;
  tags?: string[];
  custom?: Record<string, unknown>;
}) {
  const payload: {
    muxAssetId: string;
    userId: string;
    title?: string;
    description?: string;
    tags?: string[];
    custom?: Record<string, unknown>;
  } = {
    muxAssetId: args.muxAssetId,
    userId: args.userId,
  };

  if (args.title !== undefined) payload.title = args.title;
  if (args.description !== undefined) payload.description = args.description;
  if (args.tags !== undefined) payload.tags = args.tags;
  if (args.custom !== undefined) payload.custom = args.custom;

  return payload;
}

export const generateSummaryAndTagsForAssetInternal = internalAction({
  args: {
    muxAssetId: v.string(),
    userId: v.string(),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const attempt = Math.max(0, Math.floor(args.attempt ?? 0));
    const video = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
      muxAssetId: args.muxAssetId,
      userId: args.userId,
    });

    if (!video || !video.asset) {
      return { ok: false, skipped: true, reason: "asset_not_found" };
    }

    const metadata = video.metadata ?? null;
    const existingCustom = asCustomRecord(metadata?.custom);

    if (existingCustom.aiGeneratedAtMs) {
      return { ok: true, skipped: true, reason: "already_generated" };
    }

    try {
      const result = await getSummaryAndTags(args.muxAssetId, {
        provider: "openai",
        includeTranscript: true,
      });

      await ctx.runMutation(
        components.mux.videos.upsertVideoMetadata,
        buildMetadataArgs({
          muxAssetId: args.muxAssetId,
          userId: args.userId,
          title: metadata?.title,
          description: result.description,
          tags: result.tags,
          custom: {
            ...existingCustom,
            aiGeneratedAtMs: Date.now(),
            aiProvider: "openai",
            aiAttemptCount: attempt + 1,
          },
        }),
      );

      return { ok: true, skipped: false };
    } catch (error) {
      const message = getErrorMessage(error);
      const nextAttempt = attempt + 1;
      const shouldRetry = nextAttempt < MAX_ATTEMPTS;

      if (shouldRetry) {
        await ctx.scheduler.runAfter(
          getRetryDelayMs(nextAttempt),
          (internal as any).aiMetadata.generateSummaryAndTagsForAssetInternal,
          {
            muxAssetId: args.muxAssetId,
            userId: args.userId,
            attempt: nextAttempt,
          },
        );
      }

      await ctx.runMutation(
        components.mux.videos.upsertVideoMetadata,
        buildMetadataArgs({
          muxAssetId: args.muxAssetId,
          userId: args.userId,
          title: metadata?.title,
          custom: {
            ...existingCustom,
            aiFailedAtMs: Date.now(),
            aiLastError: message,
            aiAttemptCount: nextAttempt,
            aiRetryScheduled: shouldRetry,
          },
        }),
      );

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
