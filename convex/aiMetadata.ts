"use node";

import { generateChapters, getSummaryAndTags } from "@mux/ai/workflows";
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

function isMissingCaptionTrackError(message: string) {
  return /no caption track found/i.test(message);
}

function asCustomRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function getMetadataRecord(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return asCustomRecord(value[0]);
  return asCustomRecord(value);
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

function normalizeChapters(value: Array<{ title: string; startTime: number }>) {
  return value
    .filter(
      (chapter) =>
        typeof chapter.title === "string" &&
        chapter.title.trim().length > 0 &&
        Number.isFinite(chapter.startTime),
    )
    .map((chapter) => ({
      title: chapter.title.trim(),
      startTime: Math.max(0, chapter.startTime),
    }))
    .sort((a, b) => a.startTime - b.startTime);
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

    const metadata = getMetadataRecord(video.metadata);
    const existingCustom = asCustomRecord(metadata.custom);
    const hasSummary = Boolean(existingCustom.aiGeneratedAtMs);
    const hasChapters = Boolean(existingCustom.aiChaptersGeneratedAtMs);
    const captionsRequested =
      Boolean(existingCustom.aiCaptionsRequestedAtMs) ||
      Boolean(existingCustom.aiCaptionsGeneratedAtMs);
    const captionsUnavailable = Boolean(existingCustom.aiCaptionsUnavailableReason);

    if (hasSummary && hasChapters) {
      if (!existingCustom.embeddingsGeneratedAtMs) {
        await ctx.scheduler.runAfter(
          0,
          (internal as any).videoEmbeddingsNode.generateAssetEmbeddingsInternal,
          {
            muxAssetId: args.muxAssetId,
            userId: args.userId,
            attempt: 0,
          },
        );
      }
      return { ok: true, skipped: true, reason: "already_generated" };
    }

    let summaryResult:
      | {
          description: string;
          tags: string[];
        }
      | null = null;
    let summaryError: string | null = null;
    let chaptersResult:
      | {
          chapters: Array<{ title: string; startTime: number }>;
        }
      | null = null;
    let chaptersError: string | null = null;
    const errors: string[] = [];

    if (!hasSummary) {
      try {
        summaryResult = (await getSummaryAndTags(args.muxAssetId, {
          provider: "openai",
          includeTranscript: true,
        })) as { description: string; tags: string[] };
      } catch (error) {
        summaryError = getErrorMessage(error);
        errors.push(`summary: ${summaryError}`);
      }
    }

    if (!hasChapters) {
      try {
        chaptersResult = (await generateChapters(args.muxAssetId, "en", {
          provider: "openai",
        })) as { chapters: Array<{ title: string; startTime: number }> };
      } catch (error) {
        chaptersError = getErrorMessage(error);
        errors.push(`chapters: ${chaptersError}`);
      }
    }

    const nextChapters = chaptersResult
      ? normalizeChapters(chaptersResult.chapters)
      : undefined;
    const summaryCompletedThisRun = Boolean(summaryResult);
    const chaptersCompletedThisRun = Boolean(chaptersResult);

    const latestVideo = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
      muxAssetId: args.muxAssetId,
      userId: args.userId,
    });
    const latestMetadata = getMetadataRecord(latestVideo?.metadata);
    const latestCustom = asCustomRecord(latestMetadata.custom);

    const nextAttempt = attempt + 1;
    const stillMissingSummary = !hasSummary && !summaryCompletedThisRun;
    const stillMissingChapters = !hasChapters && !chaptersCompletedThisRun;
    const summaryRetryable =
      stillMissingSummary &&
      !(summaryError && isMissingCaptionTrackError(summaryError) && !captionsRequested);
    const chaptersRetryable =
      stillMissingChapters &&
      !captionsUnavailable &&
      !(chaptersError && isMissingCaptionTrackError(chaptersError) && !captionsRequested);
    const shouldRetry =
      (summaryRetryable || chaptersRetryable) && nextAttempt < MAX_ATTEMPTS;

    await ctx.runMutation(
      components.mux.videos.upsertVideoMetadata,
      buildMetadataArgs({
        muxAssetId: args.muxAssetId,
        userId: args.userId,
        title: (latestMetadata.title as string | undefined) ?? (metadata.title as string | undefined),
        description: summaryResult?.description,
        tags: summaryResult?.tags,
        custom: {
          ...latestCustom,
          ...(summaryCompletedThisRun
            ? {
                aiGeneratedAtMs: Date.now(),
                aiProvider: "openai",
                aiAttemptCount: nextAttempt,
              }
            : {}),
          ...(chaptersCompletedThisRun
            ? {
                aiChapters: nextChapters ?? [],
                aiChaptersGeneratedAtMs: Date.now(),
                aiChaptersProvider: "openai",
                aiChaptersAttemptCount: nextAttempt,
                aiChaptersUnavailableReason: null,
              }
            : {}),
          ...(stillMissingChapters && chaptersError && !chaptersRetryable
            ? {
                aiChaptersUnavailableReason: chaptersError,
              }
            : {}),
          ...(errors.length > 0
            ? {
                aiMetadataFailedAtMs: Date.now(),
                aiMetadataLastError: errors.join(" | "),
                aiMetadataAttemptCount: nextAttempt,
                aiMetadataRetryScheduled: shouldRetry,
              }
            : {
                aiMetadataRetryScheduled: false,
              }),
        },
      }),
    );

    if (hasSummary || summaryCompletedThisRun) {
      if (!latestCustom.embeddingsGeneratedAtMs) {
        await ctx.scheduler.runAfter(
          0,
          (internal as any).videoEmbeddingsNode.generateAssetEmbeddingsInternal,
          {
            muxAssetId: args.muxAssetId,
            userId: args.userId,
            attempt: 0,
          },
        );
      }
    }

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

    return {
      ok: errors.length === 0,
      skipped: false,
      retryScheduled: shouldRetry,
      nextAttempt,
      errors,
    };
  },
});
