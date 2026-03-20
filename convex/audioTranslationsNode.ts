"use node";

import Mux from "@mux/mux-node";
import { v } from "convex/values";

import { normalizeAudioTranslationLanguageCodes } from "../constants/audio-translation-languages";
import { components, internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

const MUX_ROBOTS_API_BASE_URL = "https://api.mux.com/robots/v1";
const TRANSLATE_AUDIO_ASSET_WAIT_INTERVAL_MS = 15 * 1000;
const TRANSLATE_AUDIO_FALLBACK_POLL_INTERVAL_MS = 2 * 60 * 1000;
const TRANSLATE_AUDIO_MAX_ASSET_WAIT_ATTEMPTS = 40;
const TRANSLATE_AUDIO_MAX_FALLBACK_ATTEMPTS = 10;
const TRANSLATE_AUDIO_NEXT_LANGUAGE_DELAY_MS = 5 * 1000;

type TranslateAudioJob = {
  id: string;
  passthrough?: unknown;
  status: "pending" | "processing" | "completed" | "errored" | "cancelled";
  outputs?: {
    dubbing_id?: string;
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

function unwrapTranslateAudioJob(payload: any): TranslateAudioJob {
  return ((payload?.data ?? payload) as TranslateAudioJob);
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

function requireTranslateAudioJobId(value: unknown) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Mux translate-audio job response did not include an id.");
  }
  return value;
}

function isTerminalTranslateAudioStatus(status: unknown): status is "completed" | "errored" | "cancelled" {
  return status === "completed" || status === "errored" || status === "cancelled";
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

type EnsureAudioTranslationsResult =
  | { ok: true; skipped: true; reason: "no_requested_languages" }
  | { ok: true; skipped: true; reason: "moderation_pending" | "moderation_rejected" }
  | { ok: true; skipped: true; reason: "no_audio_track" }
  | { ok: true; skipped: true; reason: "polling_disabled" }
  | { ok: true; skipped: false; created: number };
type EnsureAudioTranslationsRetryResult = {
  ok: false;
  skipped: true;
  reason: "asset_not_ready" | "audio_static_rendition_not_ready";
  retryScheduled: boolean;
  nextAttempt: number;
};

type PollAudioTranslationsResult =
  | { ok: true; status: TranslateAudioJob["status"] }
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

function getAudioOnlyStaticRendition(asset: any) {
  return (asset?.static_renditions?.files ?? []).find(
    (file: any) =>
      file?.resolution === "audio-only" ||
      file?.resolution_tier === "audio-only" ||
      file?.name === "audio.m4a" ||
      file?.ext === "m4a",
  );
}

function hasReadyAudioTrack(asset: any) {
  return (asset?.tracks ?? []).some(
    (track: any) => track?.type === "audio" && track?.status === "ready",
  );
}

function formatTranslateAudioErrors(errors: TranslateAudioJob["errors"]) {
  if (!errors || errors.length === 0) {
    return "Unknown Mux translate-audio error.";
  }

  return errors
    .map((error) => error?.message || error?.type || "Unknown error")
    .join("; ");
}

function isActiveAudioTranslationStatus(status: unknown) {
  return status === "pending" || status === "processing";
}

function isQueuedAudioTranslationStatus(status: unknown) {
  return status === "requested" || status === undefined || status === null;
}

async function scheduleNextQueuedAudioTranslation(ctx: any, muxAssetId: string) {
  const rows = await ctx.runQuery(
    (internal as any).audioTranslations.listTranslationJobsForAssetInternal,
    {
      muxAssetId,
    },
  );

  if (!Array.isArray(rows) || rows.length === 0) {
    return { scheduled: false, reason: "no_rows" as const };
  }

  if (rows.some((row: any) => isActiveAudioTranslationStatus(row?.status))) {
    return { scheduled: false, reason: "job_already_active" as const };
  }

  const queuedLanguageCodes = rows
    .filter((row: any) => isQueuedAudioTranslationStatus(row?.status))
    .map((row: any) => row?.languageCode)
    .filter((languageCode: unknown): languageCode is string => typeof languageCode === "string");

  if (queuedLanguageCodes.length === 0) {
    return { scheduled: false, reason: "no_queued_languages" as const };
  }

  const userId = rows.find((row: any) => typeof row?.userId === "string")?.userId;
  if (!userId) {
    return { scheduled: false, reason: "missing_user_id" as const };
  }

  await ctx.scheduler.runAfter(
    TRANSLATE_AUDIO_NEXT_LANGUAGE_DELAY_MS,
    (internal as any).audioTranslationsNode.ensureAudioTranslationsForAssetInternal,
    {
      muxAssetId,
      userId,
      languageCodes: queuedLanguageCodes,
      attempt: 0,
    },
  );

  return {
    scheduled: true,
    queuedLanguageCodes,
  };
}

async function applyAudioTranslationJobUpdate(
  ctx: any,
  args: { muxAssetId: string; languageCode: string },
  job: TranslateAudioJob,
) {
  const row = await ctx.runQuery((internal as any).audioTranslations.getTranslationJobInternal, {
    muxAssetId: args.muxAssetId,
    languageCode: args.languageCode,
  });

  if (!row) {
    return { ok: false, skipped: true, reason: "job_missing_or_replaced" as const };
  }

  if (typeof row.jobId === "string" && row.jobId.length > 0 && row.jobId !== job.id) {
    return { ok: false, skipped: true, reason: "job_missing_or_replaced" as const };
  }

  const jobId = requireTranslateAudioJobId(job.id);
  const errorMessage =
    job.status === "errored" ? formatTranslateAudioErrors(job.errors) : undefined;

  await ctx.runMutation((internal as any).audioTranslations.updateTranslationStatusInternal, {
    muxAssetId: args.muxAssetId,
    languageCode: args.languageCode,
    status: job.status,
    jobId,
    passthrough: normalizePassthrough(job.passthrough),
    errorMessage,
    uploadedTrackId: job.outputs?.uploaded_track_id,
    temporaryVttUrl: job.outputs?.temporary_vtt_url,
    dubbingId: job.outputs?.dubbing_id,
  });

  if (isTerminalTranslateAudioStatus(job.status)) {
    await scheduleNextQueuedAudioTranslation(ctx, args.muxAssetId);
  }

  return { ok: true, skipped: false, status: job.status };
}

async function createTranslateAudioJob(args: {
  assetId: string;
  languageCode: string;
  passthrough?: string;
}): Promise<TranslateAudioJob> {
  const response = await fetch(`${MUX_ROBOTS_API_BASE_URL}/jobs/translate-audio`, {
    method: "POST",
    headers: {
      Authorization: createMuxBasicAuthHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      passthrough: args.passthrough,
      parameters: {
        asset_id: args.assetId,
        to_language_code: args.languageCode,
        upload_to_mux: true,
      },
    }),
  });

  if (!response.ok) {
    const details = await readResponseTextSafe(response);
    throw new Error(
      `Mux translate-audio job creation failed (${response.status})${details ? `: ${details}` : ""}.`,
    );
  }

  return unwrapTranslateAudioJob(await response.json());
}

async function getTranslateAudioJob(jobId: string): Promise<TranslateAudioJob> {
  const normalizedJobId = requireTranslateAudioJobId(jobId);
  const response = await fetch(`${MUX_ROBOTS_API_BASE_URL}/jobs/translate-audio/${normalizedJobId}`, {
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
      `Mux translate-audio job lookup failed (${response.status})${details ? `: ${details}` : ""}.`,
      retryable,
    );
  }

  return unwrapTranslateAudioJob(await response.json());
}

export const ensureAudioTranslationsForAssetInternal = internalAction({
  args: {
    muxAssetId: v.string(),
    userId: v.string(),
    languageCodes: v.array(v.string()),
    title: v.optional(v.string()),
    attempt: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<EnsureAudioTranslationsResult | EnsureAudioTranslationsRetryResult> => {
    const attempt = Math.max(0, Math.floor(args.attempt ?? 0));
    const languageCodes = normalizeAudioTranslationLanguageCodes(args.languageCodes);
    if (languageCodes.length === 0) {
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

    const mux = createMuxClient();
    const asset = await mux.video.assets.retrieve(args.muxAssetId);
    if (asset.status !== "ready") {
      const nextAttempt = attempt + 1;
      const shouldRetry = nextAttempt < TRANSLATE_AUDIO_MAX_ASSET_WAIT_ATTEMPTS;
      if (shouldRetry) {
        await ctx.scheduler.runAfter(
          TRANSLATE_AUDIO_ASSET_WAIT_INTERVAL_MS,
          (internal as any).audioTranslationsNode.ensureAudioTranslationsForAssetInternal,
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
        reason: "asset_not_ready",
        retryScheduled: shouldRetry,
        nextAttempt,
      };
    }

    if (!hasReadyAudioTrack(asset)) {
      return { ok: true, skipped: true, reason: "no_audio_track" };
    }

    const audioOnlyStaticRendition = getAudioOnlyStaticRendition(asset);
    if (!audioOnlyStaticRendition) {
      try {
        await mux.video.assets.createStaticRendition(args.muxAssetId, {
          resolution: "audio-only",
        });
      } catch {
        // Another job or webhook path may have already requested it.
      }

      const nextAttempt = attempt + 1;
      const shouldRetry = nextAttempt < TRANSLATE_AUDIO_MAX_ASSET_WAIT_ATTEMPTS;
      if (shouldRetry) {
        await ctx.scheduler.runAfter(
          TRANSLATE_AUDIO_ASSET_WAIT_INTERVAL_MS,
          (internal as any).audioTranslationsNode.ensureAudioTranslationsForAssetInternal,
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
        reason: "audio_static_rendition_not_ready",
        retryScheduled: shouldRetry,
        nextAttempt,
      };
    }

    if (audioOnlyStaticRendition.status === "skipped") {
      return { ok: true, skipped: true, reason: "no_audio_track" };
    }

    if (audioOnlyStaticRendition.status !== "ready") {
      const nextAttempt = attempt + 1;
      const shouldRetry = nextAttempt < TRANSLATE_AUDIO_MAX_ASSET_WAIT_ATTEMPTS;
      if (shouldRetry) {
        await ctx.scheduler.runAfter(
          TRANSLATE_AUDIO_ASSET_WAIT_INTERVAL_MS,
          (internal as any).audioTranslationsNode.ensureAudioTranslationsForAssetInternal,
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
        reason: "audio_static_rendition_not_ready",
        retryScheduled: shouldRetry,
        nextAttempt,
      };
    }

    if (isMuxRobotsPollingDisabled()) {
      return { ok: true, skipped: true, reason: "polling_disabled" };
    }

    const claimed: ClaimedTranslation[] = await ctx.runMutation(
      (internal as any).audioTranslations.claimRequestedTranslationsInternal,
      {
        muxAssetId: args.muxAssetId,
        userId: args.userId,
        languageCodes,
      },
    );

    const rows = await ctx.runQuery(
      (internal as any).audioTranslations.listTranslationJobsForAssetInternal,
      {
        muxAssetId: args.muxAssetId,
      },
    );

    if (Array.isArray(rows) && rows.some((row: any) => isActiveAudioTranslationStatus(row?.status))) {
      return {
        ok: true,
        skipped: false,
        created: 0,
      };
    }

    const nextItem = claimed.find((item) => item.shouldCreate);
    if (!nextItem) {
      return {
        ok: true,
        skipped: false,
        created: 0,
      };
    }

    try {
      const passthrough = JSON.stringify({
        muxAssetId: args.muxAssetId,
        languageCode: nextItem.languageCode,
        title: args.title,
      });
      const job = await createTranslateAudioJob({
        assetId: args.muxAssetId,
        languageCode: nextItem.languageCode,
        passthrough,
      });
      const jobId = requireTranslateAudioJobId(job.id);
      const errorMessage =
        job.status === "errored" ? formatTranslateAudioErrors(job.errors) : undefined;

      await ctx.runMutation((internal as any).audioTranslations.updateTranslationStatusInternal, {
        muxAssetId: args.muxAssetId,
        languageCode: nextItem.languageCode,
        status: job.status,
        jobId,
        passthrough: normalizePassthrough(job.passthrough) ?? passthrough,
        errorMessage,
        uploadedTrackId: job.outputs?.uploaded_track_id,
        temporaryVttUrl: job.outputs?.temporary_vtt_url,
        dubbingId: job.outputs?.dubbing_id,
      });

      if (isActiveAudioTranslationStatus(job.status)) {
        await ctx.scheduler.runAfter(
          TRANSLATE_AUDIO_FALLBACK_POLL_INTERVAL_MS,
          (internal as any).audioTranslationsNode.pollAudioTranslationJobStatusInternal,
          {
            muxAssetId: args.muxAssetId,
            languageCode: nextItem.languageCode,
            jobId,
            attempt: 0,
          },
        );
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not create translate-audio job.";
      await ctx.runMutation((internal as any).audioTranslations.updateTranslationStatusInternal, {
        muxAssetId: args.muxAssetId,
        languageCode: nextItem.languageCode,
        status: "errored",
        errorMessage: message,
      });

      await scheduleNextQueuedAudioTranslation(ctx, args.muxAssetId);
    }

    return {
      ok: true,
      skipped: false,
      created: 1,
    };
  },
});

export const syncAudioTranslationJobInternal = internalAction({
  args: {
    muxAssetId: v.string(),
    languageCode: v.string(),
    job: v.any(),
  },
  handler: async (ctx, args) => {
    return await applyAudioTranslationJobUpdate(ctx, args, args.job as TranslateAudioJob);
  },
});

export const pollAudioTranslationJobStatusInternal = internalAction({
  args: {
    muxAssetId: v.string(),
    languageCode: v.string(),
    jobId: v.string(),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<PollAudioTranslationsResult> => {
    if (isMuxRobotsPollingDisabled()) {
      return { ok: false, skipped: true, reason: "job_missing_or_replaced" };
    }

    const attempt = Math.max(0, Math.floor(args.attempt ?? 0));
    const row = await ctx.runQuery((internal as any).audioTranslations.getTranslationJobInternal, {
      muxAssetId: args.muxAssetId,
      languageCode: args.languageCode,
    });

    if (!row || row.jobId !== args.jobId) {
      return { ok: false, skipped: true, reason: "job_missing_or_replaced" };
    }

    if (!isActiveAudioTranslationStatus(row.status)) {
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
      const job = await getTranslateAudioJob(args.jobId);
      const syncResult = await applyAudioTranslationJobUpdate(
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

      if (job.status === "pending" || job.status === "processing") {
        const nextAttempt = attempt + 1;
        if (nextAttempt >= TRANSLATE_AUDIO_MAX_FALLBACK_ATTEMPTS) {
          await ctx.runMutation(
            (internal as any).audioTranslations.updateTranslationStatusInternal,
            {
              muxAssetId: args.muxAssetId,
              languageCode: args.languageCode,
              status: "errored",
              jobId: args.jobId,
              errorMessage: "Translate-audio job timed out before completion.",
            },
          );
          return { ok: false, skipped: false, reason: "timed_out" };
        }

        await ctx.scheduler.runAfter(
          TRANSLATE_AUDIO_FALLBACK_POLL_INTERVAL_MS,
          (internal as any).audioTranslationsNode.pollAudioTranslationJobStatusInternal,
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
          error instanceof Error ? error.message : "Could not check translate-audio job.";
        await ctx.runMutation((internal as any).audioTranslations.updateTranslationStatusInternal, {
          muxAssetId: args.muxAssetId,
          languageCode: args.languageCode,
          status: "errored",
          jobId: args.jobId,
          errorMessage: message,
        });
        await scheduleNextQueuedAudioTranslation(ctx, args.muxAssetId);
        return { ok: false, skipped: false, reason: "status_lookup_failed" };
      }

      if (nextAttempt >= TRANSLATE_AUDIO_MAX_FALLBACK_ATTEMPTS) {
        const message =
          error instanceof Error ? error.message : "Could not check translate-audio job.";
        await ctx.runMutation((internal as any).audioTranslations.updateTranslationStatusInternal, {
          muxAssetId: args.muxAssetId,
          languageCode: args.languageCode,
          status: "errored",
          jobId: args.jobId,
          errorMessage: message,
        });
        await scheduleNextQueuedAudioTranslation(ctx, args.muxAssetId);
        return { ok: false, skipped: false, reason: "status_lookup_failed" };
      }

      await ctx.scheduler.runAfter(
        TRANSLATE_AUDIO_FALLBACK_POLL_INTERVAL_MS,
        (internal as any).audioTranslationsNode.pollAudioTranslationJobStatusInternal,
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
