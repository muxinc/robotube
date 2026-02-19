"use node";

import Mux from "@mux/mux-node";
import { v } from "convex/values";

import { components, internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

const MAX_ATTEMPTS = 10;

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

function getRetryDelayMs(nextAttempt: number) {
  if (nextAttempt <= 2) return 30 * 1000;
  if (nextAttempt <= 5) return 2 * 60 * 1000;
  return 10 * 60 * 1000;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function asCustomRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function getMetadataRecord(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return asCustomRecord(value[0]);
  return asCustomRecord(value);
}

function isNonRetryableCaptionsError(message: string) {
  return (
    /up to 7 days after an asset is created/i.test(message) ||
    /not support(ed)? for this audio/i.test(message) ||
    /no audio track/i.test(message)
  );
}

export const ensureGeneratedCaptionsTrackInternal = internalAction({
  args: {
    muxAssetId: v.string(),
    userId: v.string(),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const attempt = Math.max(0, Math.floor(args.attempt ?? 0));
    const nextAttempt = attempt + 1;

    const mux = createMuxClient();
    const video = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
      muxAssetId: args.muxAssetId,
      userId: args.userId,
    });

    const metadata = getMetadataRecord(video?.metadata);
    const custom = asCustomRecord(metadata.custom);
    if (custom.aiCaptionsGeneratedAtMs || custom.aiCaptionsUnavailableReason) {
      return { ok: true, skipped: true, reason: "already_handled" };
    }

    try {
      const asset = await mux.video.assets.retrieve(args.muxAssetId);
      if (asset.status !== "ready") {
        const shouldRetry = nextAttempt < MAX_ATTEMPTS;
        if (shouldRetry) {
          await ctx.scheduler.runAfter(
            getRetryDelayMs(nextAttempt),
            (internal as any).captions.ensureGeneratedCaptionsTrackInternal,
            {
              muxAssetId: args.muxAssetId,
              userId: args.userId,
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

      const existingTextTrack = (asset.tracks ?? []).find((track: any) => track.type === "text");
      if (existingTextTrack) {
        await ctx.runMutation(components.mux.videos.upsertVideoMetadata, {
          muxAssetId: args.muxAssetId,
          userId: args.userId,
          custom: {
            ...custom,
            aiCaptionsGeneratedAtMs: Date.now(),
            aiCaptionsTrackId: existingTextTrack.id,
            aiCaptionsUnavailableReason: null,
            aiCaptionsRetryScheduled: false,
          },
        });
        return { ok: true, skipped: false, alreadyExisted: true };
      }

      const audioTrack = (asset.tracks ?? []).find((track: any) => track.type === "audio");
      if (!audioTrack?.id) {
        await ctx.runMutation(components.mux.videos.upsertVideoMetadata, {
          muxAssetId: args.muxAssetId,
          userId: args.userId,
          custom: {
            ...custom,
            aiCaptionsUnavailableReason: "No audio track available for subtitle generation.",
            aiCaptionsRetryScheduled: false,
          },
        });
        return { ok: false, skipped: true, reason: "no_audio_track", retryScheduled: false };
      }

      await mux.video.assets.generateSubtitles(args.muxAssetId, audioTrack.id, {
        generated_subtitles: [
          {
            language_code: "en",
            name: "English (generated)",
            passthrough: "robotube:auto-generated",
          },
        ],
      });

      const shouldRetry = nextAttempt < MAX_ATTEMPTS;
      await ctx.runMutation(components.mux.videos.upsertVideoMetadata, {
        muxAssetId: args.muxAssetId,
        userId: args.userId,
        custom: {
          ...custom,
          aiCaptionsRequestedAtMs: Date.now(),
          aiCaptionsAttemptCount: nextAttempt,
          aiCaptionsUnavailableReason: null,
          aiCaptionsRetryScheduled: shouldRetry,
        },
      });

      if (shouldRetry) {
        await ctx.scheduler.runAfter(
          getRetryDelayMs(nextAttempt),
          (internal as any).captions.ensureGeneratedCaptionsTrackInternal,
          {
            muxAssetId: args.muxAssetId,
            userId: args.userId,
            attempt: nextAttempt,
          },
        );
      }

      return { ok: true, skipped: false, retryScheduled: shouldRetry, nextAttempt };
    } catch (error) {
      const message = getErrorMessage(error);
      const retryable = !isNonRetryableCaptionsError(message);
      const shouldRetry = retryable && nextAttempt < MAX_ATTEMPTS;

      await ctx.runMutation(components.mux.videos.upsertVideoMetadata, {
        muxAssetId: args.muxAssetId,
        userId: args.userId,
        custom: {
          ...custom,
          aiCaptionsFailedAtMs: Date.now(),
          aiCaptionsLastError: message,
          aiCaptionsAttemptCount: nextAttempt,
          aiCaptionsRetryScheduled: shouldRetry,
          ...(retryable ? {} : { aiCaptionsUnavailableReason: message }),
        },
      });

      if (shouldRetry) {
        await ctx.scheduler.runAfter(
          getRetryDelayMs(nextAttempt),
          (internal as any).captions.ensureGeneratedCaptionsTrackInternal,
          {
            muxAssetId: args.muxAssetId,
            userId: args.userId,
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
