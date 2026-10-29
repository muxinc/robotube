"use node";

import { v } from "convex/values";

import { components, internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { upsertVideoMetadataAndSyncFeedReadModel } from "./feedReadModelSync";

const MAX_ATTEMPTS = 5;
const MUX_ROBOTS_API_BASE_URL = "https://api.mux.com/robots/v1";
const FIND_BEST_THUMBNAILS_MAX = 3;
const THUMBNAIL_FALLBACK_POLL_INTERVAL_MS = 2 * 60 * 1000;
const THUMBNAIL_MAX_FALLBACK_POLLS = 10;

type FindBestThumbnailsJob = {
  id: string;
  status: "pending" | "processing" | "completed" | "errored" | "cancelled";
  passthrough?: unknown;
  outputs?: {
    best_thumbnails?: Array<{
      // Seconds in v1; v0 jobs returned timestamp_ms.
      time?: number;
      timestamp_ms?: number;
      overall?: number;
      description?: string;
      alt_text?: string;
      subscores?: Record<string, unknown>;
    }>;
  };
  errors?: {
    type?: string;
    message?: string;
  }[];
};

type ThumbnailCandidate = {
  timestampMs: number;
  overall: number | null;
  description: string | null;
  subscores: Record<string, number>;
};

type ThumbnailLockResult = {
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
  return 30 * 60 * 1000;
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

function unwrapJob(payload: unknown): FindBestThumbnailsJob {
  return ((payload as { data?: FindBestThumbnailsJob } | undefined)?.data ??
    payload) as FindBestThumbnailsJob;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asCustomRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function getMetadataRecord(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return asCustomRecord(value[0]);
  return asCustomRecord(value);
}

function isActiveJobStatus(value: unknown) {
  return value === "pending" || value === "processing";
}

function requireJobId(value: unknown) {
  const jobId = asString(value);
  if (!jobId) {
    throw new Error("Mux find-best-thumbnails job response did not include an id.");
  }
  return jobId;
}

function formatJobErrors(errors: FindBestThumbnailsJob["errors"]) {
  if (!errors || errors.length === 0) {
    return "Unknown Mux find-best-thumbnails error.";
  }

  return errors
    .map((error) => error?.message || error?.type || "Unknown error")
    .join("; ");
}

/** Mux candidates -> the { timestampMs, overall, description, subscores } shape the UI reads. */
function normalizeCandidates(
  value: NonNullable<FindBestThumbnailsJob["outputs"]>["best_thumbnails"],
): ThumbnailCandidate[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item): ThumbnailCandidate | null => {
      const seconds = asFiniteNumber(item?.time);
      const timestampMs =
        seconds !== undefined
          ? Math.max(0, Math.round(seconds * 1000))
          : asFiniteNumber(item?.timestamp_ms);
      if (timestampMs === undefined || timestampMs < 0) return null;

      const subscores = Object.fromEntries(
        Object.entries(asCustomRecord(item?.subscores)).filter(
          (entry): entry is [string, number] => asFiniteNumber(entry[1]) !== undefined,
        ),
      );

      return {
        timestampMs,
        overall: asFiniteNumber(item?.overall) ?? null,
        description: asString(item?.description?.trim()) ?? null,
        subscores,
      };
    })
    .filter((candidate): candidate is ThumbnailCandidate => candidate !== null)
    .slice(0, FIND_BEST_THUMBNAILS_MAX);
}

async function createFindBestThumbnailsJob(args: {
  assetId: string;
  passthrough: string;
}): Promise<FindBestThumbnailsJob> {
  const response = await fetch(`${MUX_ROBOTS_API_BASE_URL}/jobs/find-best-thumbnails`, {
    method: "POST",
    headers: {
      Authorization: createMuxBasicAuthHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      passthrough: args.passthrough,
      // Mux's default selection strategy; the asset's own thumbnail is left
      // unchanged and the uploader picks from the candidates.
      parameters: {
        asset_id: args.assetId,
        max_thumbnails: FIND_BEST_THUMBNAILS_MAX,
      },
    }),
  });

  if (!response.ok) {
    const details = await readResponseTextSafe(response);
    throw new Error(
      `Mux find-best-thumbnails job creation failed (${response.status})${details ? `: ${details}` : ""}.`,
    );
  }

  return unwrapJob(await response.json());
}

async function getFindBestThumbnailsJob(jobId: string): Promise<FindBestThumbnailsJob> {
  const normalizedJobId = requireJobId(jobId);
  const response = await fetch(
    `${MUX_ROBOTS_API_BASE_URL}/jobs/find-best-thumbnails/${normalizedJobId}`,
    {
      method: "GET",
      headers: {
        Authorization: createMuxBasicAuthHeader(),
      },
    },
  );

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
      `Mux find-best-thumbnails job lookup failed (${response.status})${details ? `: ${details}` : ""}.`,
      retryable,
    );
  }

  return unwrapJob(await response.json());
}

async function readLatestCustom(ctx: any, args: { muxAssetId: string; userId: string }) {
  const video = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
    muxAssetId: args.muxAssetId,
    userId: args.userId,
  });
  return {
    exists: Boolean(video?.asset),
    custom: asCustomRecord(getMetadataRecord(video?.metadata).custom),
  };
}

async function updateThumbnailFields(
  ctx: any,
  args: { muxAssetId: string; userId: string },
  customFields: Record<string, unknown>,
) {
  const { custom } = await readLatestCustom(ctx, args);

  // Only `custom` is written, so title/description/tags are left untouched.
  await upsertVideoMetadataAndSyncFeedReadModel(ctx, {
    muxAssetId: args.muxAssetId,
    userId: args.userId,
    custom: {
      ...custom,
      ...customFields,
    },
  });
}

async function scheduleThumbnailFallbackPoll(
  ctx: any,
  args: { muxAssetId: string; userId: string; jobId: string; attempt: number },
) {
  await ctx.scheduler.runAfter(
    THUMBNAIL_FALLBACK_POLL_INTERVAL_MS,
    (internal as any).thumbnailSelection.pollThumbnailSelectionJobInternal,
    args,
  );
}

async function applyThumbnailJobUpdate(
  ctx: any,
  args: { muxAssetId: string; userId: string },
  job: FindBestThumbnailsJob,
) {
  const latest = await readLatestCustom(ctx, args);
  if (!latest.exists) {
    return { ok: false, skipped: true, reason: "asset_not_found" as const };
  }

  const currentJobId = asString(latest.custom.aiThumbnailJobId);
  if (currentJobId && currentJobId !== job.id) {
    return { ok: true, skipped: true, reason: "job_replaced" as const };
  }

  if (isActiveJobStatus(job.status)) {
    await updateThumbnailFields(ctx, args, {
      aiThumbnailJobId: job.id,
      aiThumbnailJobStatus: job.status,
    });
    return { ok: true, skipped: false, status: job.status };
  }

  if (job.status === "completed") {
    if (
      currentJobId === job.id &&
      asFiniteNumber(latest.custom.aiThumbnailGeneratedAtMs) !== undefined
    ) {
      return { ok: true, skipped: true, reason: "already_selected" as const };
    }

    const candidates = normalizeCandidates(job.outputs?.best_thumbnails);
    await updateThumbnailFields(ctx, args, {
      aiThumbnailJobId: job.id,
      aiThumbnailJobStatus: job.status,
      aiThumbnailCandidates: candidates,
      aiThumbnailProvider: "mux_robots",
      aiThumbnailGeneratedAtMs: Date.now(),
      aiThumbnailLastError: undefined,
      // Start with Mux's highest-ranked candidate, but never override a
      // thumbnail the uploader already chose.
      ...(candidates.length > 0 &&
      asFiniteNumber(latest.custom.selectedThumbnailTimestampMs) === undefined
        ? { selectedThumbnailTimestampMs: candidates[0].timestampMs }
        : {}),
    });

    return { ok: true, skipped: false, candidateCount: candidates.length };
  }

  // Thumbnail picks are optional: record the failure and leave the asset's
  // default thumbnail in place rather than retrying a failed job.
  const message = formatJobErrors(job.errors);
  await updateThumbnailFields(ctx, args, {
    aiThumbnailJobId: job.id,
    aiThumbnailJobStatus: job.status,
    aiThumbnailLastError: message,
  });

  return { ok: false, skipped: false, error: message };
}

/** Creates the find-best-thumbnails job for an approved asset, at most once. */
export const ensureThumbnailSelectionForAssetInternal = internalAction({
  args: {
    muxAssetId: v.string(),
    userId: v.string(),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (isMuxRobotsPollingDisabled()) {
      return { ok: true, skipped: true, reason: "polling_disabled" };
    }

    const lock = (await ctx.runMutation(
      (internal as any).thumbnailSelectionLocks.claimThumbnailSelectionLockInternal,
      { muxAssetId: args.muxAssetId, userId: args.userId },
    )) as ThumbnailLockResult;
    if (!lock.acquired) {
      return { ok: true, skipped: true, reason: "already_running" };
    }

    try {
      const attempt = Math.max(0, Math.floor(args.attempt ?? 0));
      const latest = await readLatestCustom(ctx, args);
      if (!latest.exists) {
        return { ok: false, skipped: true, reason: "asset_not_found" };
      }

      if (asFiniteNumber(latest.custom.aiThumbnailGeneratedAtMs) !== undefined) {
        return { ok: true, skipped: true, reason: "already_selected" };
      }

      const existingJobId = asString(latest.custom.aiThumbnailJobId);
      if (existingJobId && isActiveJobStatus(latest.custom.aiThumbnailJobStatus)) {
        await scheduleThumbnailFallbackPoll(ctx, {
          muxAssetId: args.muxAssetId,
          userId: args.userId,
          jobId: existingJobId,
          attempt: 0,
        });
        return { ok: true, skipped: true, reason: "job_in_progress" };
      }

      try {
        const createdJob = await createFindBestThumbnailsJob({
          assetId: args.muxAssetId,
          passthrough: JSON.stringify({
            muxAssetId: args.muxAssetId,
            userId: args.userId,
            attempt,
          }),
        });
        const jobId = requireJobId(createdJob.id);

        await updateThumbnailFields(ctx, args, {
          aiThumbnailJobId: jobId,
          aiThumbnailJobStatus: createdJob.status,
          aiThumbnailAttemptCount: attempt + 1,
          aiThumbnailLastError: undefined,
        });

        if (!isActiveJobStatus(createdJob.status)) {
          return await applyThumbnailJobUpdate(ctx, args, createdJob);
        }

        await scheduleThumbnailFallbackPoll(ctx, {
          muxAssetId: args.muxAssetId,
          userId: args.userId,
          jobId,
          attempt: 0,
        });

        return { ok: true, skipped: false, created: true, jobId };
      } catch (error) {
        const message = getErrorMessage(error);
        const nextAttempt = attempt + 1;
        const shouldRetry = nextAttempt < MAX_ATTEMPTS;

        if (shouldRetry) {
          await ctx.scheduler.runAfter(
            getRetryDelayMs(nextAttempt),
            (internal as any).thumbnailSelection.ensureThumbnailSelectionForAssetInternal,
            { muxAssetId: args.muxAssetId, userId: args.userId, attempt: nextAttempt },
          );
        }

        await updateThumbnailFields(ctx, args, {
          aiThumbnailJobStatus: shouldRetry ? "requested" : "errored",
          aiThumbnailLastError: message,
          aiThumbnailAttemptCount: nextAttempt,
        });

        return { ok: false, skipped: false, error: message, retryScheduled: shouldRetry };
      }
    } finally {
      await ctx.runMutation(
        (internal as any).thumbnailSelectionLocks.releaseThumbnailSelectionLockInternal,
        { muxAssetId: args.muxAssetId },
      );
    }
  },
});

export const syncThumbnailSelectionJobInternal = internalAction({
  args: {
    muxAssetId: v.string(),
    userId: v.string(),
    job: v.any(),
  },
  handler: async (ctx, args) => {
    return await applyThumbnailJobUpdate(ctx, args, args.job as FindBestThumbnailsJob);
  },
});

/** Fallback for a missed webhook: re-reads the job until it is terminal. */
export const pollThumbnailSelectionJobInternal = internalAction({
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
    const latest = await readLatestCustom(ctx, args);

    if (asFiniteNumber(latest.custom.aiThumbnailGeneratedAtMs) !== undefined) {
      return { ok: true, skipped: true, reason: "already_selected" };
    }

    if (asString(latest.custom.aiThumbnailJobId) !== args.jobId) {
      return { ok: false, skipped: true, reason: "job_missing_or_replaced" };
    }

    const pollArgs = { muxAssetId: args.muxAssetId, userId: args.userId, jobId: args.jobId };

    try {
      const job = await getFindBestThumbnailsJob(args.jobId);
      const result = await applyThumbnailJobUpdate(ctx, args, job);

      if (isActiveJobStatus(job.status) && attempt + 1 < THUMBNAIL_MAX_FALLBACK_POLLS) {
        await scheduleThumbnailFallbackPoll(ctx, { ...pollArgs, attempt: attempt + 1 });
      }

      return result;
    } catch (error) {
      const nextAttempt = attempt + 1;
      const retryable = error instanceof MuxJobLookupError ? error.retryable : true;

      if (retryable && nextAttempt < THUMBNAIL_MAX_FALLBACK_POLLS) {
        await scheduleThumbnailFallbackPoll(ctx, { ...pollArgs, attempt: nextAttempt });
        return { ok: false, skipped: false, retryScheduled: true };
      }

      const message = getErrorMessage(error);
      await updateThumbnailFields(ctx, args, {
        aiThumbnailJobStatus: "errored",
        aiThumbnailLastError: message,
      });
      return { ok: false, skipped: false, error: message };
    }
  },
});
