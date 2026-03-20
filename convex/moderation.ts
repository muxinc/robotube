"use node";

import { v } from "convex/values";

import { normalizeAudioTranslationLanguageCodes } from "../constants/audio-translation-languages";
import { components, internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

const MAX_ATTEMPTS = 8;
const MUX_ROBOTS_API_BASE_URL = "https://api.mux.com/robots/v1";
const MODERATE_FALLBACK_POLL_INTERVAL_MS = 2 * 60 * 1000;
const MODERATE_MAX_FALLBACK_POLLS = 10;
const MODERATION_THRESHOLDS = {
  sexual: 0.7,
  violence: 0.8,
};

type ModerateJob = {
  id: string;
  status: "pending" | "processing" | "completed" | "errored" | "cancelled";
  passthrough?: unknown;
  parameters?: {
    asset_id?: string;
    language_code?: string;
    thresholds?: {
      sexual?: number;
      violence?: number;
    };
    sampling_interval?: number;
    max_samples?: number;
  };
  outputs?: {
    thumbnail_scores?: Array<{
      url?: string;
      sexual?: number;
      violence?: number;
    }>;
    max_scores?: {
      sexual?: number;
      violence?: number;
    };
    exceeds_threshold?: boolean;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    reasoning_tokens?: number;
    cached_input_tokens?: number;
  };
  errors?: {
    type?: string;
    message?: string;
  }[];
};

type ModerationLockResult = {
  acquired: boolean;
  startedAtMs: number;
  userId: string;
};

class MuxJobLookupError extends Error {
  retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "MuxJobLookupError";
    this.retryable = retryable;
  }
}

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

function isMuxRobotsPollingDisabled() {
  return process.env.DISABLE_MUX_ROBOTS_POLLING === "true";
}

function requiredEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing env var: ${name}`);
  }
  return value;
}

function createMuxBasicAuthHeader() {
  const tokenId = requiredEnv("MUX_TOKEN_ID", process.env.MUX_TOKEN_ID);
  const tokenSecret = requiredEnv("MUX_TOKEN_SECRET", process.env.MUX_TOKEN_SECRET);
  return `Basic ${Buffer.from(`${tokenId}:${tokenSecret}`).toString("base64")}`;
}

async function readResponseTextSafe(response: Response) {
  try {
    const text = await response.text();
    return text.trim();
  } catch {
    return "";
  }
}

function unwrapModerateJob(payload: unknown): ModerateJob {
  return ((payload as { data?: ModerateJob } | undefined)?.data ?? payload) as ModerateJob;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asModerationJobStatus(value: unknown): ModerateJob["status"] | undefined {
  return value === "pending" ||
    value === "processing" ||
    value === "completed" ||
    value === "errored" ||
    value === "cancelled"
    ? value
    : undefined;
}

function isTerminalModerationStatus(
  value: unknown,
): value is "completed" | "errored" | "cancelled" {
  return value === "completed" || value === "errored" || value === "cancelled";
}

function requireModerationJobId(value: unknown) {
  const jobId = asString(value);
  if (!jobId) {
    throw new Error("Mux moderate job response did not include an id.");
  }
  return jobId;
}

function formatModerateErrors(errors: ModerateJob["errors"]) {
  if (!errors || errors.length === 0) {
    return "Unknown Mux moderate error.";
  }

  return errors
    .map((error) => error?.message || error?.type || "Unknown error")
    .join("; ");
}

async function createModerateJob(args: {
  assetId: string;
  passthrough?: string;
}): Promise<ModerateJob> {
  const response = await fetch(`${MUX_ROBOTS_API_BASE_URL}/jobs/moderate`, {
    method: "POST",
    headers: {
      Authorization: createMuxBasicAuthHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      passthrough: args.passthrough,
      parameters: {
        asset_id: args.assetId,
        thresholds: MODERATION_THRESHOLDS,
      },
    }),
  });

  if (!response.ok) {
    const details = await readResponseTextSafe(response);
    throw new Error(
      `Mux moderate job creation failed (${response.status})${details ? `: ${details}` : ""}.`,
    );
  }

  return unwrapModerateJob(await response.json());
}

async function getModerateJob(jobId: string): Promise<ModerateJob> {
  const normalizedJobId = requireModerationJobId(jobId);
  const response = await fetch(`${MUX_ROBOTS_API_BASE_URL}/jobs/moderate/${normalizedJobId}`, {
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
      `Mux moderate job lookup failed (${response.status})${details ? `: ${details}` : ""}.`,
      retryable,
    );
  }

  return unwrapModerateJob(await response.json());
}

function asCustomRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseModerationPassthrough(passthrough: unknown): Record<string, unknown> {
  if (typeof passthrough === "string") {
    try {
      return asCustomRecord(JSON.parse(passthrough));
    } catch {
      return {};
    }
  }

  return asCustomRecord(passthrough);
}

function getMetadataRecord(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return asCustomRecord(value[0]);
  return asCustomRecord(value);
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

async function updateModerationTrackingFields(
  ctx: any,
  args: { muxAssetId: string; userId: string },
  fallbackMetadata: Record<string, unknown>,
  customFields: Record<string, unknown>,
) {
  const latestVideo = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
    muxAssetId: args.muxAssetId,
    userId: args.userId,
  });
  const latestMetadata = getMetadataRecord(latestVideo?.metadata);
  const latestCustom = asCustomRecord(latestMetadata.custom);

  await ctx.runMutation(
    components.mux.videos.upsertVideoMetadata,
    buildMetadataArgs({
      muxAssetId: args.muxAssetId,
      userId: args.userId,
      title: asString(latestMetadata.title) ?? asString(fallbackMetadata.title),
      description: asString(latestMetadata.description) ?? asString(fallbackMetadata.description),
      tags: Array.isArray(latestMetadata.tags)
        ? (latestMetadata.tags as string[])
        : Array.isArray(fallbackMetadata.tags)
          ? (fallbackMetadata.tags as string[])
          : undefined,
      visibility: asVisibility(latestMetadata.visibility) ?? asVisibility(fallbackMetadata.visibility),
      custom: {
        ...latestCustom,
        ...customFields,
      },
    }),
  );
}

async function scheduleApprovedAssetJobs(ctx: any, args: { muxAssetId: string; userId: string }) {
  const latestVideo = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
    muxAssetId: args.muxAssetId,
    userId: args.userId,
  });

  if (!latestVideo?.asset) {
    return;
  }

  const latestMetadata = getMetadataRecord(latestVideo.metadata);
  const latestCustom = asCustomRecord(latestMetadata.custom);
  const languageCodes = normalizeAudioTranslationLanguageCodes(
    Array.isArray(latestCustom.audioTranslationLanguageCodes)
      ? latestCustom.audioTranslationLanguageCodes.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
  );
  const title = asString(latestMetadata.title);

  if (languageCodes.length > 0) {
    await ctx.scheduler.runAfter(
      0,
      (internal as any).audioTranslationsNode.ensureAudioTranslationsForAssetInternal,
      {
        muxAssetId: args.muxAssetId,
        userId: args.userId,
        languageCodes,
        title,
        attempt: 0,
      },
    );

    await ctx.scheduler.runAfter(
      0,
      (internal as any).captionTranslationsNode.ensureCaptionTranslationsForAssetInternal,
      {
        muxAssetId: args.muxAssetId,
        userId: args.userId,
        languageCodes,
        title,
        attempt: 0,
      },
    );
  }

  await ctx.scheduler.runAfter(0, (internal as any).aiMetadata.ensureAiMetadataForAssetInternal, {
    muxAssetId: args.muxAssetId,
    defaultUserId: args.userId,
  });
}

async function scheduleModerationFallbackPoll(
  ctx: any,
  args: { muxAssetId: string; userId: string; jobId: string; attempt: number },
) {
  await ctx.scheduler.runAfter(
    MODERATE_FALLBACK_POLL_INTERVAL_MS,
    (internal as any).moderation.pollModerationJobStatusInternal,
    args,
  );
}

async function applyModerationJobUpdate(
  ctx: any,
  args: { muxAssetId: string; userId: string },
  job: ModerateJob,
) {
  const latestVideo = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
    muxAssetId: args.muxAssetId,
    userId: args.userId,
  });

  if (!latestVideo?.asset) {
    return { ok: false, skipped: true, reason: "asset_not_found" as const };
  }

  const latestMetadata = getMetadataRecord(latestVideo.metadata);
  const latestCustom = asCustomRecord(latestMetadata.custom);
  const currentJobId = asString(latestCustom.moderationJobId);

  if (currentJobId && currentJobId !== job.id) {
    return { ok: true, skipped: true, reason: "job_replaced" as const };
  }

  if (job.status === "pending" || job.status === "processing") {
    await ctx.runMutation(
      components.mux.videos.upsertVideoMetadata,
      buildMetadataArgs({
        muxAssetId: args.muxAssetId,
        userId: args.userId,
        title: asString(latestMetadata.title),
        description: asString(latestMetadata.description),
        tags: Array.isArray(latestMetadata.tags) ? (latestMetadata.tags as string[]) : undefined,
        visibility: asVisibility(latestMetadata.visibility),
        custom: {
          ...latestCustom,
          moderationJobId: job.id,
          moderationJobStatus: job.status,
          moderationLastError: undefined,
        },
      }),
    );

    return { ok: true, skipped: false, status: job.status };
  }

  if (job.status === "completed") {
    if (
      currentJobId === job.id &&
      asFiniteNumber(latestCustom.moderationCheckedAtMs) !== undefined
    ) {
      return { ok: true, skipped: true, reason: "already_moderated" as const };
    }

    const exceedsThreshold = job.outputs?.exceeds_threshold === true;
    const moderationPassed = !exceedsThreshold;

    await ctx.runMutation(
      components.mux.videos.upsertVideoMetadata,
      buildMetadataArgs({
        muxAssetId: args.muxAssetId,
        userId: args.userId,
        title: asString(latestMetadata.title),
        description: asString(latestMetadata.description),
        tags: Array.isArray(latestMetadata.tags) ? (latestMetadata.tags as string[]) : undefined,
        visibility: "public",
        custom: {
          ...latestCustom,
          moderationCheckedAtMs: Date.now(),
          moderationProvider: "mux_robots",
          moderationWorkflow: "moderate",
          moderationJobId: job.id,
          moderationJobStatus: job.status,
          moderationAttemptCount: asFiniteNumber(latestCustom.moderationAttemptCount) ?? 1,
          moderationPassed,
          moderationExceedsThreshold: exceedsThreshold,
          moderationThresholds: job.parameters?.thresholds ?? MODERATION_THRESHOLDS,
          moderationMaxScores: job.outputs?.max_scores,
          moderationThumbnailScores: job.outputs?.thumbnail_scores,
          moderationUsage: job.usage,
          moderationLastError: undefined,
          moderationFailedAtMs: undefined,
          moderationRetryScheduled: false,
        },
      }),
    );

    if (moderationPassed) {
      await scheduleApprovedAssetJobs(ctx, args);
    }

    return {
      ok: true,
      skipped: false,
      moderationPassed,
      exceedsThreshold,
    };
  }

  const message = formatModerateErrors(job.errors);
  const hasSameTerminalState =
    currentJobId === job.id && latestCustom.moderationJobStatus === job.status;
  const passthrough = parseModerationPassthrough(job.passthrough);
  const currentAttempt = asFiniteNumber(passthrough.attempt);
  const nextAttempt =
    (currentAttempt ?? Math.max(0, (asFiniteNumber(latestCustom.moderationAttemptCount) ?? 1) - 1)) + 1;
  const shouldRetry = !hasSameTerminalState && nextAttempt < MAX_ATTEMPTS;

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
      title: asString(latestMetadata.title),
      description: asString(latestMetadata.description),
      tags: Array.isArray(latestMetadata.tags) ? (latestMetadata.tags as string[]) : undefined,
      visibility: asVisibility(latestMetadata.visibility) ?? "public",
      custom: {
        ...latestCustom,
        moderationJobId: job.id,
        moderationJobStatus: job.status,
        moderationFailedAtMs: hasSameTerminalState
          ? asFiniteNumber(latestCustom.moderationFailedAtMs) ?? Date.now()
          : Date.now(),
        moderationLastError: message,
        moderationAttemptCount: nextAttempt + 1,
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

export const moderateAssetInternal = internalAction({
  args: {
    muxAssetId: v.string(),
    userId: v.string(),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const lock = (await ctx.runMutation((internal as any).moderationLocks.claimModerationLockInternal, {
      muxAssetId: args.muxAssetId,
      userId: args.userId,
    })) as ModerationLockResult;
    if (!lock.acquired) {
      return {
        ok: true,
        skipped: true,
        reason: "already_running",
        runningUserId: lock.userId,
        startedAtMs: lock.startedAtMs,
      };
    }

    try {
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
      let moderationJobId = asString(existingCustom.moderationJobId);
      let moderationJobStatus = existingCustom.moderationCheckedAtMs
        ? "completed"
        : asModerationJobStatus(existingCustom.moderationJobStatus);

      if (existingCustom.moderationCheckedAtMs) {
        return { ok: true, skipped: true, reason: "already_moderated" };
      }

      if (isMuxRobotsPollingDisabled()) {
        return { ok: true, skipped: true, reason: "polling_disabled" };
      }

      try {
        const shouldCreateModerationJob =
          !moderationJobId ||
          moderationJobStatus === "errored" ||
          moderationJobStatus === "cancelled";
        if (shouldCreateModerationJob) {
          const createdJob = await createModerateJob({
            assetId: args.muxAssetId,
            passthrough: JSON.stringify({
              muxAssetId: args.muxAssetId,
              userId: args.userId,
              attempt,
            }),
          });
          moderationJobId = requireModerationJobId(createdJob.id);
          moderationJobStatus = createdJob.status;

          await updateModerationTrackingFields(ctx, args, metadata, {
            moderationJobId,
            moderationJobStatus,
            moderationAttemptCount: attempt + 1,
            moderationRetryScheduled: false,
            moderationLastError: undefined,
          });

          if (isTerminalModerationStatus(createdJob.status)) {
            return await applyModerationJobUpdate(ctx, args, createdJob);
          }

          await scheduleModerationFallbackPoll(ctx, {
            muxAssetId: args.muxAssetId,
            userId: args.userId,
            jobId: moderationJobId,
            attempt: 0,
          });

          return {
            ok: true,
            skipped: false,
            created: true,
            jobId: moderationJobId,
            status: moderationJobStatus,
          };
        }

        if (moderationJobId && (moderationJobStatus === "pending" || moderationJobStatus === "processing")) {
          await scheduleModerationFallbackPoll(ctx, {
            muxAssetId: args.muxAssetId,
            userId: args.userId,
            jobId: moderationJobId,
            attempt: 0,
          });
        }

        return {
          ok: true,
          skipped: true,
          reason: moderationJobId ? "job_in_progress" : "job_missing",
        };
      } catch (error) {
        const message = getErrorMessage(error);
        const nextAttempt = attempt + 1;
        const shouldRetry = nextAttempt < MAX_ATTEMPTS;

        const latestVideo = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
          muxAssetId: args.muxAssetId,
          userId: args.userId,
        });
        const latestMetadata = getMetadataRecord(latestVideo?.metadata);
        const latestCustom = asCustomRecord(latestMetadata.custom);

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
            title: asString(latestMetadata.title) ?? asString(metadata.title),
            description: asString(latestMetadata.description) ?? asString(metadata.description),
            tags: Array.isArray(latestMetadata.tags)
              ? (latestMetadata.tags as string[])
              : Array.isArray(metadata.tags)
                ? (metadata.tags as string[])
                : undefined,
            visibility: asVisibility(latestMetadata.visibility) ?? asVisibility(metadata.visibility),
            custom: {
              ...latestCustom,
              ...(moderationJobId
                ? {
                    moderationJobId,
                    moderationJobStatus,
                  }
                : {}),
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
    } finally {
      await ctx.runMutation((internal as any).moderationLocks.releaseModerationLockInternal, {
        muxAssetId: args.muxAssetId,
      });
    }
  },
});

export const syncModerationJobInternal = internalAction({
  args: {
    muxAssetId: v.string(),
    userId: v.string(),
    job: v.any(),
  },
  handler: async (ctx, args) => {
    return await applyModerationJobUpdate(ctx, args, args.job as ModerateJob);
  },
});

export const pollModerationJobStatusInternal = internalAction({
  args: {
    muxAssetId: v.string(),
    userId: v.string(),
    jobId: v.string(),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (isMuxRobotsPollingDisabled()) {
      return { ok: false, skipped: true, reason: "polling_disabled" };
    }

    const attempt = Math.max(0, Math.floor(args.attempt ?? 0));
    const video = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
      muxAssetId: args.muxAssetId,
      userId: args.userId,
    });
    const metadata = getMetadataRecord(video?.metadata);
    const custom = asCustomRecord(metadata.custom);

    if (asFiniteNumber(custom.moderationCheckedAtMs) !== undefined) {
      return { ok: true, skipped: true, reason: "already_moderated" };
    }

    if (asString(custom.moderationJobId) !== args.jobId) {
      return { ok: false, skipped: true, reason: "job_missing_or_replaced" };
    }

    try {
      const job = await getModerateJob(args.jobId);
      const result = await applyModerationJobUpdate(ctx, args, job);

      if ((job.status === "pending" || job.status === "processing") && attempt + 1 < MODERATE_MAX_FALLBACK_POLLS) {
        await scheduleModerationFallbackPoll(ctx, {
          muxAssetId: args.muxAssetId,
          userId: args.userId,
          jobId: args.jobId,
          attempt: attempt + 1,
        });
      }

      return result;
    } catch (error) {
      const nextAttempt = attempt + 1;
      const retryable = error instanceof MuxJobLookupError ? error.retryable : true;

      if (retryable && nextAttempt < MODERATE_MAX_FALLBACK_POLLS) {
        await scheduleModerationFallbackPoll(ctx, {
          muxAssetId: args.muxAssetId,
          userId: args.userId,
          jobId: args.jobId,
          attempt: nextAttempt,
        });
        return { ok: false, skipped: false, retryScheduled: true };
      }

      const latestVideo = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
        muxAssetId: args.muxAssetId,
        userId: args.userId,
      });
      const latestMetadata = getMetadataRecord(latestVideo?.metadata);
      const latestCustom = asCustomRecord(latestMetadata.custom);
      const message = getErrorMessage(error);
      const attemptCount = (asFiniteNumber(latestCustom.moderationAttemptCount) ?? 0) + 1;
      const shouldRetry = attemptCount < MAX_ATTEMPTS;

      if (shouldRetry) {
        await ctx.scheduler.runAfter(
          getRetryDelayMs(attemptCount),
          (internal as any).moderation.moderateAssetInternal,
          {
            muxAssetId: args.muxAssetId,
            userId: args.userId,
            attempt: attemptCount,
          },
        );
      }

      await ctx.runMutation(
        components.mux.videos.upsertVideoMetadata,
        buildMetadataArgs({
          muxAssetId: args.muxAssetId,
          userId: args.userId,
          title: asString(latestMetadata.title),
          description: asString(latestMetadata.description),
          tags: Array.isArray(latestMetadata.tags) ? (latestMetadata.tags as string[]) : undefined,
          visibility: asVisibility(latestMetadata.visibility),
          custom: {
            ...latestCustom,
            moderationLastError: message,
            moderationFailedAtMs: Date.now(),
            moderationRetryScheduled: shouldRetry,
            moderationAttemptCount: attemptCount,
          },
        }),
      );

      return {
        ok: false,
        skipped: false,
        error: message,
        retryScheduled: shouldRetry,
        nextAttempt: attemptCount,
      };
    }
  },
});
