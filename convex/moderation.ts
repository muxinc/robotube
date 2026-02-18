"use node";

import { getModerationScores } from "@mux/ai/workflows";
import { v } from "convex/values";

import { components, internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

const MAX_ATTEMPTS = 8;
const MODERATION_THRESHOLDS = {
  sexual: 0.7,
  violence: 0.8,
};

function getRetryDelayMs(nextAttempt: number) {
  if (nextAttempt <= 1) return 2 * 60 * 1000;
  if (nextAttempt <= 3) return 10 * 60 * 1000;
  if (nextAttempt <= 5) return 30 * 60 * 1000;
  return 2 * 60 * 60 * 1000;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function asCustomRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asVisibility(value: unknown): "private" | "unlisted" | "public" | undefined {
  return value === "private" || value === "unlisted" || value === "public"
    ? value
    : undefined;
}

function buildMetadataArgs(args: {
  muxAssetId: string;
  userId: string;
  title?: string;
  description?: string;
  tags?: string[];
  visibility?: "private" | "unlisted" | "public";
  custom?: Record<string, unknown>;
}) {
  const payload: {
    muxAssetId: string;
    userId: string;
    title?: string;
    description?: string;
    tags?: string[];
    visibility?: "private" | "unlisted" | "public";
    custom?: Record<string, unknown>;
  } = {
    muxAssetId: args.muxAssetId,
    userId: args.userId,
  };

  if (args.title !== undefined) payload.title = args.title;
  if (args.description !== undefined) payload.description = args.description;
  if (args.tags !== undefined) payload.tags = args.tags;
  if (args.visibility !== undefined) payload.visibility = args.visibility;
  if (args.custom !== undefined) payload.custom = args.custom;

  return payload;
}

export const moderateAssetInternal = internalAction({
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
    const currentVisibility = asVisibility(metadata?.visibility);

    if (existingCustom.moderationCheckedAtMs) {
      return { ok: true, skipped: true, reason: "already_moderated" };
    }

    try {
      const result = await getModerationScores(args.muxAssetId, {
        provider: "openai",
        thresholds: MODERATION_THRESHOLDS,
      });

      const moderationPassed = !result.exceedsThreshold;
      const nextVisibility = moderationPassed
        ? currentVisibility === "unlisted"
          ? "unlisted"
          : "public"
        : "private";

      await ctx.runMutation(
        components.mux.videos.upsertVideoMetadata,
        buildMetadataArgs({
          muxAssetId: args.muxAssetId,
          userId: args.userId,
          title: metadata?.title,
          description: metadata?.description,
          tags: metadata?.tags,
          visibility: nextVisibility,
          custom: {
            ...existingCustom,
            moderationCheckedAtMs: Date.now(),
            moderationProvider: "openai",
            moderationAttemptCount: attempt + 1,
            moderationPassed,
            moderationExceedsThreshold: result.exceedsThreshold,
            moderationThresholds: result.thresholds,
            moderationMaxScores: result.maxScores,
            moderationMode: result.mode,
          },
        }),
      );

      return {
        ok: true,
        skipped: false,
        moderationPassed,
        exceedsThreshold: result.exceedsThreshold,
      };
    } catch (error) {
      const message = getErrorMessage(error);
      const nextAttempt = attempt + 1;
      const shouldRetry = nextAttempt < MAX_ATTEMPTS;

      if (shouldRetry) {
        await ctx.scheduler.runAfter(
          getRetryDelayMs(nextAttempt),
          (internal as any).moderation.moderateAssetInternal,
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
          description: metadata?.description,
          tags: metadata?.tags,
          visibility: "private",
          custom: {
            ...existingCustom,
            moderationFailedAtMs: Date.now(),
            moderationLastError: message,
            moderationAttemptCount: nextAttempt,
            moderationRetryScheduled: shouldRetry,
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
