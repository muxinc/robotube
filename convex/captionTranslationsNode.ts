"use node";

import Mux from "@mux/mux-node";
import { v } from "convex/values";

import { normalizeAudioTranslationLanguageCodes } from "../constants/audio-translation-languages";
import { components, internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

const MUX_ROBOTS_API_BASE_URL = "https://api.mux.com/robots/v1";
const TRANSLATE_CAPTIONS_SOURCE_WAIT_INTERVAL_MS = 15 * 1000;
const TRANSLATE_CAPTIONS_FALLBACK_POLL_INTERVAL_MS = 2 * 60 * 1000;
const TRANSLATE_CAPTIONS_MAX_SOURCE_WAIT_ATTEMPTS = 40;
const TRANSLATE_CAPTIONS_MAX_FALLBACK_ATTEMPTS = 10;

type TranslateCaptionsJob = {
  id: string;
  passthrough?: unknown;
  status: "pending" | "processing" | "completed" | "errored" | "cancelled";
  outputs?: {
    uploaded_track_id?: string;
    temporary_vtt_url?: string;
  };
  errors?: {
    type?: string;
    message?: string;
  }[];
};

class MuxJobLookupError extends Error {
  retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "MuxJobLookupError";
    this.retryable = retryable;
  }
}

function unwrapTranslateCaptionsJob(payload: unknown): TranslateCaptionsJob {
  return ((payload as { data?: TranslateCaptionsJob } | undefined)?.data ??
    payload) as TranslateCaptionsJob;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function getMetadataRecord(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return asRecord(value[0]);
  return asRecord(value);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requireTranslateCaptionsJobId(value: unknown) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Mux translate-captions job response did not include an id.");
  }
  return value;
}

function normalizePassthrough(value: unknown) {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined || value === null) {
    return undefined;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

type ClaimedTranslation = {
  languageCode: string;
  shouldCreate: boolean;
};

type EnsureCaptionTranslationsResult =
  | { ok: true; skipped: true; reason: "no_requested_languages" }
  | { ok: true; skipped: true; reason: "moderation_pending" | "moderation_rejected" }
  | { ok: true; skipped: true; reason: "source_captions_unavailable" }
  | { ok: true; skipped: true; reason: "polling_disabled" }
  | { ok: true; skipped: false; created: number }
  | {
      ok: false;
      skipped: true;
      reason: "source_captions_not_ready";
      retryScheduled: boolean;
      nextAttempt: number;
    };

type PollCaptionTranslationsResult =
  | { ok: true; status: TranslateCaptionsJob["status"] }
  | {
      ok: false;
      skipped: true;
      reason: "job_missing_or_replaced";
    }
  | {
      ok: false;
      skipped: false;
      reason: "timed_out" | "status_lookup_failed";
    }
  | {
      ok: false;
      skipped: false;
      retryScheduled: true;
    };

function requiredEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing env var: ${name}`);
  }
  return value;
}

async function readResponseTextSafe(response: Response) {
  try {
    const text = await response.text();
    return text.trim();
  } catch {
    return "";
  }
}

function isMuxRobotsPollingDisabled() {
  return process.env.DISABLE_MUX_ROBOTS_POLLING === "true";
}

function createMuxBasicAuthHeader() {
  const tokenId = requiredEnv("MUX_TOKEN_ID", process.env.MUX_TOKEN_ID);
  const tokenSecret = requiredEnv("MUX_TOKEN_SECRET", process.env.MUX_TOKEN_SECRET);
  return `Basic ${Buffer.from(`${tokenId}:${tokenSecret}`).toString("base64")}`;
}

function createMuxClient() {
  return new Mux({
    tokenId: requiredEnv("MUX_TOKEN_ID", process.env.MUX_TOKEN_ID),
    tokenSecret: requiredEnv("MUX_TOKEN_SECRET", process.env.MUX_TOKEN_SECRET),
  });
}

function normalizeLanguageCode(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().toLowerCase().split("-")[0] ?? "";
}

function getTrackLanguageCode(track: any) {
  return normalizeLanguageCode(track?.language_code ?? track?.languageCode ?? track?.language);
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

  for (const track of textTracks) {
    const textSource = track?.text_source ?? track?.textSource;
    const passthrough = track?.passthrough;
    if (textSource !== "generated_vod" && passthrough !== "robotube:auto-generated") {
      continue;
    }

    const languageCode = getTrackLanguageCode(track);
    if (!languageCode || languageCode === "auto") {
      continue;
    }

    return track;
  }

  const primaryAudioLanguageCode = getTrackLanguageCode(findPrimaryAudioTrack(asset));
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

function getSourceCaptionsLanguageCode(asset: any) {
  return getTrackLanguageCode(findSourceCaptionsTrack(asset));
}

function findExistingTranslatedCaptionsTrack(asset: any, languageCode: string) {
  const normalizedLanguageCode = normalizeLanguageCode(languageCode);
  if (!normalizedLanguageCode) {
    return null;
  }

  return (asset?.tracks ?? []).find(
    (track: any) =>
      track?.type === "text" &&
      track?.status === "ready" &&
      getTrackLanguageCode(track) === normalizedLanguageCode,
  ) ?? null;
}

function isActiveCaptionTranslationStatus(status: unknown) {
  return status === "pending" || status === "processing";
}

async function applyCaptionTranslationJobUpdate(
  ctx: any,
  args: { muxAssetId: string; languageCode: string },
  job: TranslateCaptionsJob,
) {
  const row = await ctx.runQuery((internal as any).captionTranslations.getTranslationJobInternal, {
    muxAssetId: args.muxAssetId,
    languageCode: args.languageCode,
  });

  if (!row) {
    return { ok: false, skipped: true, reason: "job_missing_or_replaced" as const };
  }

  if (typeof row.jobId === "string" && row.jobId.length > 0 && row.jobId !== job.id) {
    return { ok: false, skipped: true, reason: "job_missing_or_replaced" as const };
  }

  const jobId = requireTranslateCaptionsJobId(job.id);
  const errorMessage =
    job.status === "errored" ? formatTranslateCaptionsErrors(job.errors) : undefined;

  await ctx.runMutation((internal as any).captionTranslations.updateTranslationStatusInternal, {
    muxAssetId: args.muxAssetId,
    languageCode: args.languageCode,
    status: job.status,
    jobId,
    passthrough: normalizePassthrough(job.passthrough),
    errorMessage,
    uploadedTrackId: job.outputs?.uploaded_track_id,
    temporaryVttUrl: job.outputs?.temporary_vtt_url,
  });

  return { ok: true, skipped: false, status: job.status };
}

function formatTranslateCaptionsErrors(errors: TranslateCaptionsJob["errors"]) {
  if (!errors || errors.length === 0) {
    return "Unknown Mux translate-captions error.";
  }

  return errors
    .map((error) => error?.message || error?.type || "Unknown error")
    .join("; ");
}

async function createTranslateCaptionsJob(args: {
  assetId: string;
  fromLanguageCode: string;
  toLanguageCode: string;
  passthrough?: string;
}): Promise<TranslateCaptionsJob> {
  const response = await fetch(`${MUX_ROBOTS_API_BASE_URL}/jobs/translate-captions`, {
    method: "POST",
    headers: {
      Authorization: createMuxBasicAuthHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      passthrough: args.passthrough,
      parameters: {
        asset_id: args.assetId,
        from_language_code: args.fromLanguageCode,
        to_language_code: args.toLanguageCode,
        upload_to_mux: true,
      },
    }),
  });

  if (!response.ok) {
    const details = await readResponseTextSafe(response);
    throw new Error(
      `Mux translate-captions job creation failed (${response.status})${details ? `: ${details}` : ""}.`,
    );
  }

  return unwrapTranslateCaptionsJob(await response.json());
}

async function getTranslateCaptionsJob(jobId: string): Promise<TranslateCaptionsJob> {
  const normalizedJobId = requireTranslateCaptionsJobId(jobId);
  const response = await fetch(`${MUX_ROBOTS_API_BASE_URL}/jobs/translate-captions/${normalizedJobId}`, {
    method: "GET",
    headers: {
      Authorization: createMuxBasicAuthHeader(),
    },
  });

  if (!response.ok) {
    const details = await readResponseTextSafe(response);
    const retryable =
      response.status === 404 ||
      response.status === 408 ||
      response.status === 409 ||
      response.status === 425 ||
      response.status === 429 ||
      response.status >= 500;
    throw new MuxJobLookupError(
      `Mux translate-captions job lookup failed (${response.status})${details ? `: ${details}` : ""}.`,
      retryable,
    );
  }

  return unwrapTranslateCaptionsJob(await response.json());
}

export const ensureCaptionTranslationsForAssetInternal = internalAction({
  args: {
    muxAssetId: v.string(),
    userId: v.string(),
    languageCodes: v.array(v.string()),
    title: v.optional(v.string()),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<EnsureCaptionTranslationsResult> => {
    const attempt = Math.max(0, Math.floor(args.attempt ?? 0));
    const requestedLanguageCodes = normalizeAudioTranslationLanguageCodes(args.languageCodes);

    if (requestedLanguageCodes.length === 0) {
      return { ok: true, skipped: true, reason: "no_requested_languages" };
    }

    const video = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
      muxAssetId: args.muxAssetId,
      userId: args.userId,
    });
    const metadata = getMetadataRecord(video?.metadata);
    const custom = asRecord(metadata.custom);

    if (asNumber(custom.moderationCheckedAtMs) === undefined) {
      return { ok: true, skipped: true, reason: "moderation_pending" };
    }

    if (custom.moderationPassed !== true) {
      return { ok: true, skipped: true, reason: "moderation_rejected" };
    }

    if (typeof custom.aiCaptionsUnavailableReason === "string" && custom.aiCaptionsUnavailableReason) {
      return { ok: true, skipped: true, reason: "source_captions_unavailable" };
    }

    const mux = createMuxClient();
    const asset = await mux.video.assets.retrieve(args.muxAssetId);
    const sourceLanguageCode = getSourceCaptionsLanguageCode(asset);
    const languageCodes = requestedLanguageCodes.filter(
      (languageCode) => languageCode !== sourceLanguageCode,
    );

    if (languageCodes.length === 0) {
      return { ok: true, skipped: true, reason: "no_requested_languages" };
    }

    if (asset.status !== "ready" || !sourceLanguageCode) {
      const nextAttempt = attempt + 1;
      const shouldRetry = nextAttempt < TRANSLATE_CAPTIONS_MAX_SOURCE_WAIT_ATTEMPTS;

      if (shouldRetry) {
        await ctx.scheduler.runAfter(
          TRANSLATE_CAPTIONS_SOURCE_WAIT_INTERVAL_MS,
          (internal as any).captionTranslationsNode.ensureCaptionTranslationsForAssetInternal,
          {
            muxAssetId: args.muxAssetId,
            userId: args.userId,
            languageCodes,
            title: args.title,
            attempt: nextAttempt,
          },
        );
      }

      return {
        ok: false,
        skipped: true,
        reason: "source_captions_not_ready",
        retryScheduled: shouldRetry,
        nextAttempt,
      };
    }

    if (isMuxRobotsPollingDisabled()) {
      return { ok: true, skipped: true, reason: "polling_disabled" };
    }

    const claimed: ClaimedTranslation[] = await ctx.runMutation(
      (internal as any).captionTranslations.claimRequestedTranslationsInternal,
      {
        muxAssetId: args.muxAssetId,
        userId: args.userId,
        fromLanguageCode: sourceLanguageCode,
        languageCodes,
      },
    );
    let createdCount = 0;

    for (const item of claimed) {
      if (!item.shouldCreate) {
        continue;
      }

      const existingTrack = findExistingTranslatedCaptionsTrack(asset, item.languageCode);
      if (existingTrack) {
        await ctx.runMutation((internal as any).captionTranslations.updateTranslationStatusInternal, {
          muxAssetId: args.muxAssetId,
          languageCode: item.languageCode,
          status: "completed",
          uploadedTrackId:
            typeof existingTrack.id === "string" && existingTrack.id.length > 0
              ? existingTrack.id
              : undefined,
          temporaryVttUrl: undefined,
          errorMessage: undefined,
        });
        continue;
      }

      try {
        const passthrough = JSON.stringify({
          muxAssetId: args.muxAssetId,
          fromLanguageCode: sourceLanguageCode,
          languageCode: item.languageCode,
          title: args.title,
        });
        const job = await createTranslateCaptionsJob({
          assetId: args.muxAssetId,
          fromLanguageCode: sourceLanguageCode,
          toLanguageCode: item.languageCode,
          passthrough,
        });
        createdCount += 1;
        const jobId = requireTranslateCaptionsJobId(job.id);
        const errorMessage =
          job.status === "errored" ? formatTranslateCaptionsErrors(job.errors) : undefined;

        await ctx.runMutation((internal as any).captionTranslations.updateTranslationStatusInternal, {
          muxAssetId: args.muxAssetId,
          languageCode: item.languageCode,
          status: job.status,
          jobId,
          passthrough: normalizePassthrough(job.passthrough) ?? passthrough,
          errorMessage,
          uploadedTrackId: job.outputs?.uploaded_track_id,
          temporaryVttUrl: job.outputs?.temporary_vtt_url,
        });

        if (isActiveCaptionTranslationStatus(job.status)) {
          await ctx.scheduler.runAfter(
            TRANSLATE_CAPTIONS_FALLBACK_POLL_INTERVAL_MS,
            (internal as any).captionTranslationsNode.pollCaptionTranslationJobStatusInternal,
            {
              muxAssetId: args.muxAssetId,
              languageCode: item.languageCode,
              jobId,
              attempt: 0,
            },
          );
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Could not create translate-captions job.";
        await ctx.runMutation((internal as any).captionTranslations.updateTranslationStatusInternal, {
          muxAssetId: args.muxAssetId,
          languageCode: item.languageCode,
          status: "errored",
          errorMessage: message,
        });
      }
    }

    return {
      ok: true,
      skipped: false,
      created: createdCount,
    };
  },
});

export const syncCaptionTranslationJobInternal = internalAction({
  args: {
    muxAssetId: v.string(),
    languageCode: v.string(),
    job: v.any(),
  },
  handler: async (ctx, args) => {
    return await applyCaptionTranslationJobUpdate(ctx, args, args.job as TranslateCaptionsJob);
  },
});

export const pollCaptionTranslationJobStatusInternal = internalAction({
  args: {
    muxAssetId: v.string(),
    languageCode: v.string(),
    jobId: v.string(),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<PollCaptionTranslationsResult> => {
    if (isMuxRobotsPollingDisabled()) {
      return { ok: false, skipped: true, reason: "job_missing_or_replaced" };
    }

    const attempt = Math.max(0, Math.floor(args.attempt ?? 0));
    const row = await ctx.runQuery((internal as any).captionTranslations.getTranslationJobInternal, {
      muxAssetId: args.muxAssetId,
      languageCode: args.languageCode,
    });

    if (!row || row.jobId !== args.jobId) {
      return { ok: false, skipped: true, reason: "job_missing_or_replaced" };
    }

    if (!isActiveCaptionTranslationStatus(row.status)) {
      return {
        ok: true,
        status:
          row.status === "completed" ||
          row.status === "errored" ||
          row.status === "cancelled"
            ? row.status
            : "completed",
      };
    }

    try {
      const job = await getTranslateCaptionsJob(args.jobId);
      const syncResult = await applyCaptionTranslationJobUpdate(
        ctx,
        {
          muxAssetId: args.muxAssetId,
          languageCode: args.languageCode,
        },
        job,
      );

      if (!syncResult.ok) {
        return { ok: false, skipped: true, reason: "job_missing_or_replaced" };
      }

      if (isActiveCaptionTranslationStatus(job.status)) {
        const nextAttempt = attempt + 1;
        if (nextAttempt >= TRANSLATE_CAPTIONS_MAX_FALLBACK_ATTEMPTS) {
          await ctx.runMutation(
            (internal as any).captionTranslations.updateTranslationStatusInternal,
            {
              muxAssetId: args.muxAssetId,
              languageCode: args.languageCode,
              status: "errored",
              jobId: args.jobId,
              errorMessage: "Translate-captions job timed out before completion.",
            },
          );
          return { ok: false, skipped: false, reason: "timed_out" };
        }

        await ctx.scheduler.runAfter(
          TRANSLATE_CAPTIONS_FALLBACK_POLL_INTERVAL_MS,
          (internal as any).captionTranslationsNode.pollCaptionTranslationJobStatusInternal,
          {
            muxAssetId: args.muxAssetId,
            languageCode: args.languageCode,
            jobId: args.jobId,
            attempt: nextAttempt,
          },
        );
      }

      return { ok: true, status: job.status };
    } catch (error) {
      const nextAttempt = attempt + 1;
      const shouldRetryLookup =
        error instanceof MuxJobLookupError ? error.retryable : true;
      if (!shouldRetryLookup) {
        const message =
          error instanceof Error ? error.message : "Could not check translate-captions job.";
        await ctx.runMutation((internal as any).captionTranslations.updateTranslationStatusInternal, {
          muxAssetId: args.muxAssetId,
          languageCode: args.languageCode,
          status: "errored",
          jobId: args.jobId,
          errorMessage: message,
        });
        return { ok: false, skipped: false, reason: "status_lookup_failed" };
      }

      if (nextAttempt >= TRANSLATE_CAPTIONS_MAX_FALLBACK_ATTEMPTS) {
        const message =
          error instanceof Error ? error.message : "Could not check translate-captions job.";
        await ctx.runMutation((internal as any).captionTranslations.updateTranslationStatusInternal, {
          muxAssetId: args.muxAssetId,
          languageCode: args.languageCode,
          status: "errored",
          jobId: args.jobId,
          errorMessage: message,
        });
        return { ok: false, skipped: false, reason: "status_lookup_failed" };
      }

      await ctx.scheduler.runAfter(
        TRANSLATE_CAPTIONS_FALLBACK_POLL_INTERVAL_MS,
        (internal as any).captionTranslationsNode.pollCaptionTranslationJobStatusInternal,
        {
          muxAssetId: args.muxAssetId,
          languageCode: args.languageCode,
          jobId: args.jobId,
          attempt: nextAttempt,
        },
      );
      return { ok: false, skipped: false, retryScheduled: true };
    }
  },
});
