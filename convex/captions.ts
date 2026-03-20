"use node";

import Mux from "@mux/mux-node";
import { v } from "convex/values";

import { components, internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

const MAX_ATTEMPTS = 10;
const GENERATED_CAPTIONS_PASSTHROUGH = "robotube:auto-generated";

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

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeLanguageCode(value: unknown) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().split("-")[0] ?? "";
}

function getLanguageDisplayLabel(languageCode: string) {
  const normalizedCode = normalizeLanguageCode(languageCode);
  if (!normalizedCode) {
    return "Original audio";
  }

  try {
    const displayNames = new Intl.DisplayNames(["en"], { type: "language" });
    return displayNames.of(normalizedCode) ?? "Original audio";
  } catch {
    return "Original audio";
  }
}

function findPrimaryAudioTrack(asset: any) {
  return (asset?.tracks ?? []).find(
    (track: any) =>
      track?.type === "audio" &&
      !track?.passthrough &&
      !track?.generated_by &&
      !track?.generatedBy,
  ) ?? (asset?.tracks ?? []).find((track: any) => track?.type === "audio");
}

function findGeneratedCaptionsTrack(asset: any) {
  return (asset?.tracks ?? []).find(
    (track: any) =>
      track?.type === "text" &&
      (track?.text_source === "generated_vod" ||
        track?.textSource === "generated_vod" ||
        track?.passthrough === GENERATED_CAPTIONS_PASSTHROUGH),
  );
}

function getTrackLanguageCode(track: any) {
  return normalizeLanguageCode(track?.language_code ?? track?.languageCode ?? track?.language);
}

function findSourceCaptionsTrack(asset: any) {
  const textTracks = (asset?.tracks ?? []).filter(
    (track: any) =>
      track?.type === "text" &&
      track?.status === "ready" &&
      getTrackLanguageCode(track) !== "" &&
      getTrackLanguageCode(track) !== "auto",
  );

  if (textTracks.length === 0) {
    return null;
  }

  const generatedTrack = findGeneratedCaptionsTrack(asset);
  if (generatedTrack && textTracks.includes(generatedTrack)) {
    return generatedTrack;
  }

  const primaryAudioTrack = findPrimaryAudioTrack(asset);
  const primaryAudioLanguageCode = getTrackLanguageCode(primaryAudioTrack);
  if (primaryAudioLanguageCode) {
    const matchingTrack = textTracks.find(
      (track: any) => getTrackLanguageCode(track) === primaryAudioLanguageCode,
    );
    if (matchingTrack) {
      return matchingTrack;
    }
  }

  return textTracks[0] ?? null;
}

function createMuxBasicAuthHeader() {
  const tokenId = requiredEnv("MUX_TOKEN_ID", process.env.MUX_TOKEN_ID);
  const tokenSecret = requiredEnv("MUX_TOKEN_SECRET", process.env.MUX_TOKEN_SECRET);
  return `Basic ${Buffer.from(`${tokenId}:${tokenSecret}`).toString("base64")}`;
}

async function updateAssetTrack(args: {
  assetId: string;
  trackId: string;
  languageCode: string;
  name: string;
}) {
  const response = await fetch(
    `https://api.mux.com/video/v1/assets/${args.assetId}/tracks/${args.trackId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: createMuxBasicAuthHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        language_code: args.languageCode,
        name: args.name,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Mux asset track update failed (${response.status}).`);
  }
}

async function syncPrimaryAudioTrackLanguage(args: {
  assetId: string;
  asset: any;
  detectedLanguageCode: string;
}) {
  const primaryAudioTrack = findPrimaryAudioTrack(args.asset);
  const normalizedLanguageCode = normalizeLanguageCode(args.detectedLanguageCode);
  if (!primaryAudioTrack?.id || !normalizedLanguageCode) {
    return;
  }

  const nextName = getLanguageDisplayLabel(normalizedLanguageCode);
  const currentLanguageCode = normalizeLanguageCode(
    primaryAudioTrack.language_code ?? primaryAudioTrack.languageCode ?? primaryAudioTrack.language,
  );
  const currentName =
    typeof primaryAudioTrack.name === "string" && primaryAudioTrack.name.length > 0
      ? primaryAudioTrack.name
      : "";

  if (currentLanguageCode === normalizedLanguageCode && currentName === nextName) {
    return;
  }

  await updateAssetTrack({
    assetId: args.assetId,
    trackId: primaryAudioTrack.id,
    languageCode: normalizedLanguageCode,
    name: nextName,
  });
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

    if (asNumber(custom.moderationCheckedAtMs) === undefined) {
      return { ok: true, skipped: true, reason: "moderation_pending" };
    }

    if (custom.moderationPassed !== true) {
      return { ok: true, skipped: true, reason: "moderation_rejected" };
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

      const sourceCaptionsTrack = findSourceCaptionsTrack(asset);
      if (sourceCaptionsTrack) {
        const detectedLanguageCode = getTrackLanguageCode(sourceCaptionsTrack);
        const captionsReady = sourceCaptionsTrack.status === "ready";
        const languageDetected =
          detectedLanguageCode.length > 0 && detectedLanguageCode !== "auto";

        if (!captionsReady || !languageDetected) {
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
            reason: "captions_not_ready",
            retryScheduled: shouldRetry,
            nextAttempt,
          };
        }

        await syncPrimaryAudioTrackLanguage({
          assetId: args.muxAssetId,
          asset,
          detectedLanguageCode,
        });

        await ctx.runMutation(components.mux.videos.upsertVideoMetadata, {
          muxAssetId: args.muxAssetId,
          userId: args.userId,
          custom: {
            ...custom,
            aiCaptionsGeneratedAtMs: Date.now(),
            aiCaptionsTrackId: sourceCaptionsTrack.id,
            aiSourceLanguageCode: detectedLanguageCode,
            aiSourceLanguageLabel: getLanguageDisplayLabel(detectedLanguageCode),
            aiCaptionsSource:
              sourceCaptionsTrack.text_source === "generated_vod" ||
              sourceCaptionsTrack.textSource === "generated_vod" ||
              sourceCaptionsTrack.passthrough === GENERATED_CAPTIONS_PASSTHROUGH
                ? "mux_generated"
                : "existing",
            aiCaptionsUnavailableReason: null,
            aiCaptionsRetryScheduled: false,
          },
        });
        return { ok: true, skipped: false, alreadyExisted: true };
      }

      const audioTrack = findPrimaryAudioTrack(asset);
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
            language_code: "auto" as any,
            name: "Original audio (generated)",
            passthrough: GENERATED_CAPTIONS_PASSTHROUGH,
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
