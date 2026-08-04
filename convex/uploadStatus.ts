import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";

import {
  getAudioTranslationLanguageLabel,
  normalizeAudioTranslationLanguageCodes,
} from "../constants/audio-translation-languages";
import { components } from "./_generated/api";
import { query } from "./_generated/server";
import { isLaravelOrchestrationEnabled } from "./laravelFlag";
import { getCachedMuxAssetById } from "./muxAssetCache";

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isMuxRobotsPollingDisabled() {
  return process.env.DISABLE_MUX_ROBOTS_POLLING === "true";
}

export const getUploadModerationStatus = query({
  args: {
    uploadId: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("You must be signed in to view upload status.");
    }

    const upload = await ctx.runQuery(components.mux.catalog.getUploadByMuxId, {
      muxUploadId: args.uploadId,
    });

    if (!upload) {
      return {
        stage: "upload_pending",
        done: false,
        passed: null,
        progress: 95,
        statusText: "Waiting for Mux to confirm the upload...",
      };
    }

    const uploadRecord = asRecord(upload) ?? {};
    const uploadStatus = asString(uploadRecord.status) ?? "";
    const muxAssetId =
      asString(uploadRecord.assetId) ?? asString(uploadRecord.asset_id);

    if (!muxAssetId) {
      const pendingText =
        uploadStatus === "waiting"
          ? "Upload received. Waiting for Mux processing to start..."
          : "Upload complete. Creating your video asset...";
      return {
        stage: "asset_pending",
        done: false,
        passed: null,
        progress: 96,
        statusText: pendingText,
      };
    }

    const asset = await getCachedMuxAssetById(ctx, muxAssetId);
    const assetRecord = asRecord(asset) ?? {};
    const assetStatus = asString(assetRecord.status) ?? "";

    const video = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
      muxAssetId,
      userId: authUserId,
    });
    const videoRecord = asRecord(video) ?? {};
    const metadataValue = videoRecord.metadata;
    const metadataRecord = Array.isArray(metadataValue)
      ? asRecord(metadataValue[0])
      : asRecord(metadataValue);
    const custom = asRecord(metadataRecord?.custom) ?? {};
    const metadataUserId = asString(metadataRecord?.userId);
    if (metadataUserId && metadataUserId !== authUserId) {
      return {
        stage: "forbidden",
        done: true,
        passed: null,
        progress: 100,
        statusText: "This upload belongs to a different account.",
      };
    }

    const moderationCheckedAtMs = asNumber(custom.moderationCheckedAtMs);
    const moderationPassed = asBoolean(custom.moderationPassed);
    const moderationRetryScheduled = asBoolean(custom.moderationRetryScheduled);
    const moderationFailedAtMs = asNumber(custom.moderationFailedAtMs);

    if (moderationCheckedAtMs !== undefined) {
      if (moderationPassed) {
        return {
          stage: "approved",
          done: true,
          passed: true,
          progress: 100,
          statusText: "Moderation passed. Your video is now visible in the feed.",
        };
      }

      return {
        stage: "rejected",
        done: true,
        passed: false,
        progress: 100,
        statusText:
          "Moderation flagged this video. It stays private and hidden from the feed.",
      };
    }

    if (assetStatus !== "ready") {
      return {
        stage: "processing",
        done: false,
        passed: null,
        progress: 97,
        statusText: "Processing video... moderation will run as soon as it is ready.",
      };
    }

    if (isMuxRobotsPollingDisabled()) {
      return {
        stage: "moderation_disabled",
        done: true,
        passed: null,
        progress: 100,
        statusText: "Video processing is complete. Automated moderation is disabled for this deployment.",
      };
    }

    if (moderationFailedAtMs !== undefined && moderationRetryScheduled) {
      return {
        stage: "moderation_retrying",
        done: false,
        passed: null,
        progress: 98,
        statusText: "Moderation check is retrying. Keeping your upload under review...",
      };
    }

    return {
      stage: "moderation_pending",
      done: false,
      passed: null,
      progress: 99,
      statusText: "Running moderation checks...",
    };
  },
});

type PipelineJobStatus =
  | "waiting"
  | "processing"
  | "completed"
  | "errored"
  | "skipped";

type PipelineJob = {
  key: string;
  label: string;
  status: PipelineJobStatus;
};

function isTerminalPipelineJobStatus(status: PipelineJobStatus) {
  return status === "completed" || status === "errored" || status === "skipped";
}

function asStringArrayLoose(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

/** Map a Mux Robots / translation job status onto the checklist vocabulary. */
function toPipelineJobStatus(
  status: string | undefined,
  fallback: PipelineJobStatus,
): PipelineJobStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "errored":
      return "errored";
    case "cancelled":
      return "skipped";
    case "requested":
    case "pending":
    case "processing":
      return "processing";
    default:
      return fallback;
  }
}

function computePipelineProgress(jobs: PipelineJob[]) {
  if (jobs.length === 0) return 100;
  const score = jobs.reduce((total, job) => {
    if (isTerminalPipelineJobStatus(job.status)) return total + 1;
    if (job.status === "processing") return total + 0.5;
    return total;
  }, 0);
  return Math.round((score / jobs.length) * 100);
}

/**
 * Live status for every post-upload Mux Robots job (moderation, AI summary /
 * chapters / key moments, and the per-language audio + caption translations)
 * so the upload screen can show pipeline progress until everything finishes.
 *
 * Works on both orchestration paths: the native Convex pipeline and the
 * Laravel-owned pipeline mirror the SAME videoMetadata.custom keys and typed
 * translation tables (see convex/laravelSync.ts).
 *
 * The optional language-code args are client-side hints so the checklist can
 * render the requested translations before the asset metadata (which carries
 * the authoritative lists) has been synced.
 */
export const getUploadPipelineStatus = query({
  args: {
    uploadId: v.string(),
    audioTranslationLanguageCodes: v.optional(v.array(v.string())),
    captionTranslationLanguageCodes: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("You must be signed in to view upload status.");
    }

    const hintAudioCodes = normalizeAudioTranslationLanguageCodes(
      args.audioTranslationLanguageCodes ?? [],
    );
    const hintCaptionCodes = normalizeAudioTranslationLanguageCodes(
      args.captionTranslationLanguageCodes ?? [],
    );

    const buildJobs = (input: {
      moderation: PipelineJobStatus;
      aiStatuses?: Record<"summary" | "chapters" | "keyMoments", PipelineJobStatus>;
      audioCodes: string[];
      captionCodes: string[];
      audioStatusByCode?: Map<string, PipelineJobStatus>;
      captionStatusByCode?: Map<string, PipelineJobStatus>;
    }): PipelineJob[] => {
      const ai = input.aiStatuses ?? {
        summary: "waiting" as const,
        chapters: "waiting" as const,
        keyMoments: "waiting" as const,
      };
      return [
        { key: "moderation", label: "Moderation", status: input.moderation },
        { key: "summary", label: "AI summary", status: ai.summary },
        { key: "chapters", label: "AI chapters", status: ai.chapters },
        { key: "keyMoments", label: "AI key moments", status: ai.keyMoments },
        ...input.audioCodes.map((code) => ({
          key: `audio:${code}`,
          label: `${getAudioTranslationLanguageLabel(code)} audio dub`,
          status: input.audioStatusByCode?.get(code) ?? ("waiting" as const),
        })),
        ...input.captionCodes.map((code) => ({
          key: `captions:${code}`,
          label: `${getAudioTranslationLanguageLabel(code)} captions`,
          status: input.captionStatusByCode?.get(code) ?? ("waiting" as const),
        })),
      ];
    };

    const upload = await ctx.runQuery(components.mux.catalog.getUploadByMuxId, {
      muxUploadId: args.uploadId,
    });
    if (!upload) {
      const jobs = buildJobs({
        moderation: "waiting",
        audioCodes: hintAudioCodes,
        captionCodes: hintCaptionCodes,
      });
      return {
        stage: "upload_pending",
        done: false,
        passed: null,
        progress: computePipelineProgress(jobs),
        statusText: "Waiting for Mux to confirm the upload...",
        jobs,
      };
    }

    const uploadRecord = asRecord(upload) ?? {};
    const muxAssetId =
      asString(uploadRecord.assetId) ?? asString(uploadRecord.asset_id);
    if (!muxAssetId) {
      const jobs = buildJobs({
        moderation: "waiting",
        audioCodes: hintAudioCodes,
        captionCodes: hintCaptionCodes,
      });
      return {
        stage: "asset_pending",
        done: false,
        passed: null,
        progress: computePipelineProgress(jobs),
        statusText: "Upload received. Creating your video asset...",
        jobs,
      };
    }

    const asset = await getCachedMuxAssetById(ctx, muxAssetId);
    const assetRecord = asRecord(asset) ?? {};
    const assetReady = asString(assetRecord.status) === "ready";

    const video = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
      muxAssetId,
      userId: authUserId,
    });
    const videoRecord = asRecord(video) ?? {};
    const metadataValue = videoRecord.metadata;
    const metadataRecord = Array.isArray(metadataValue)
      ? asRecord(metadataValue[0])
      : asRecord(metadataValue);
    const custom = asRecord(metadataRecord?.custom) ?? {};
    const metadataUserId = asString(metadataRecord?.userId);
    const generatedMetadata = {
      summaryReady:
        asNumber(custom.aiGeneratedAtMs) !== undefined ||
        asString(custom.aiSummaryJobStatus) === "completed",
      generatedAtMs: asNumber(custom.aiGeneratedAtMs),
      summaryStatus: asString(custom.aiSummaryJobStatus),
      suggestedTitle: asString(custom.aiSuggestedTitle),
      suggestedDescription: asString(custom.aiSuggestedDescription),
      suggestedTags:
        asStringArrayLoose(custom.aiSuggestedTags) ??
        asStringArrayLoose(metadataRecord?.tags) ??
        [],
      appliedTitle: asString(metadataRecord?.title),
      appliedDescription: asString(metadataRecord?.description),
    };

    if (metadataUserId && metadataUserId !== authUserId) {
      return {
        stage: "forbidden",
        done: true,
        passed: null,
        progress: 100,
        statusText: "This upload belongs to a different account.",
        jobs: [] as PipelineJob[],
      };
    }

    // Requested translation languages: metadata custom is authoritative once
    // synced; fall back to the client hints before that. A missing caption key
    // on a legacy upload means "same as audio".
    const customAudioCodes = asStringArrayLoose(
      custom.audioTranslationLanguageCodes,
    );
    const customCaptionCodes = asStringArrayLoose(
      custom.captionTranslationLanguageCodes,
    );
    const audioCodes = normalizeAudioTranslationLanguageCodes(
      customAudioCodes ?? hintAudioCodes,
    );
    const captionCodes = normalizeAudioTranslationLanguageCodes(
      customCaptionCodes ??
        (customAudioCodes !== undefined ? customAudioCodes : hintCaptionCodes),
    );

    const moderationCheckedAtMs = asNumber(custom.moderationCheckedAtMs);
    const moderationPassed = asBoolean(custom.moderationPassed);
    const moderationDone = moderationCheckedAtMs !== undefined;
    const moderationStatus: PipelineJobStatus = moderationDone
      ? "completed"
      : assetReady
        ? "processing"
        : "waiting";

    // Moderation rejected: everything downstream is skipped and we are done.
    if (moderationDone && moderationPassed === false) {
      const jobs = buildJobs({
        moderation: "completed",
        aiStatuses: { summary: "skipped", chapters: "skipped", keyMoments: "skipped" },
        audioCodes,
        captionCodes,
        audioStatusByCode: new Map(audioCodes.map((code) => [code, "skipped"])),
        captionStatusByCode: new Map(captionCodes.map((code) => [code, "skipped"])),
      });
      return {
        stage: "rejected",
        done: true,
        passed: false,
        progress: 100,
        statusText:
          "Moderation flagged this video. It stays private and hidden from the feed.",
        jobs,
        muxAssetId,
        generatedMetadata,
      };
    }

    if (!assetReady) {
      const jobs = buildJobs({
        moderation: "waiting",
        audioCodes,
        captionCodes,
      });
      return {
        stage: "processing",
        done: false,
        passed: null,
        progress: computePipelineProgress(jobs),
        statusText:
          "Processing video... Mux Robots jobs will start as soon as it is ready.",
        jobs,
      };
    }

    if (isMuxRobotsPollingDisabled() && !isLaravelOrchestrationEnabled()) {
      return {
        stage: "moderation_disabled",
        done: true,
        passed: null,
        progress: 100,
        statusText:
          "Video processing is complete. Automated Robots jobs are disabled for this deployment.",
        jobs: [] as PipelineJob[],
        muxAssetId,
        generatedMetadata,
      };
    }

    // AI metadata jobs only start after moderation passes, so before that they
    // are "waiting"; afterwards a missing status means the job is being queued.
    const aiFallback: PipelineJobStatus = "waiting";
    const unavailableStatus = (reason: unknown): PipelineJobStatus | undefined =>
      asString(reason) ? "skipped" : undefined;
    const aiStatuses = {
      summary: toPipelineJobStatus(asString(custom.aiSummaryJobStatus), aiFallback),
      chapters:
        unavailableStatus(custom.aiChaptersUnavailableReason) ??
        toPipelineJobStatus(asString(custom.aiChaptersJobStatus), aiFallback),
      keyMoments:
        unavailableStatus(custom.aiKeyMomentsUnavailableReason) ??
        toPipelineJobStatus(asString(custom.aiKeyMomentsJobStatus), aiFallback),
    };

    const [audioRows, captionRows] = await Promise.all([
      ctx.db
        .query("audioTranslationJobs")
        .withIndex("by_asset", (q) => q.eq("muxAssetId", muxAssetId))
        .collect(),
      ctx.db
        .query("captionTranslationJobs")
        .withIndex("by_asset", (q) => q.eq("muxAssetId", muxAssetId))
        .collect(),
    ]);
    const audioStatusByCode = new Map<string, PipelineJobStatus>(
      audioRows.map((row) => [
        row.languageCode,
        toPipelineJobStatus(row.status, "processing"),
      ]),
    );
    const captionStatusByCode = new Map<string, PipelineJobStatus>(
      captionRows.map((row) => [
        row.languageCode,
        toPipelineJobStatus(row.status, "processing"),
      ]),
    );

    const jobs = buildJobs({
      moderation: moderationStatus,
      aiStatuses,
      audioCodes,
      captionCodes,
      audioStatusByCode,
      captionStatusByCode,
    });

    const done = jobs.every((job) => isTerminalPipelineJobStatus(job.status));
    const erroredJobs = jobs.filter((job) => job.status === "errored");
    const activeJobs = jobs.filter((job) => job.status === "processing");

    let statusText: string;
    if (done) {
      statusText =
        erroredJobs.length > 0
          ? `Processing finished, but ${erroredJobs
              .map((job) => job.label)
              .join(", ")} failed.`
          : "All Mux Robots jobs are complete. Your video is fully ready.";
    } else if (!moderationDone) {
      statusText = "Running moderation checks...";
    } else if (activeJobs.length > 0) {
      statusText = `Moderation passed. Working on: ${activeJobs
        .map((job) => job.label)
        .join(", ")}...`;
    } else {
      statusText = "Moderation passed. Queueing the remaining Robots jobs...";
    }

    return {
      stage: done ? (erroredJobs.length > 0 ? "completed_with_errors" : "completed") : "robots_running",
      done,
      passed: moderationPassed ?? null,
      progress: computePipelineProgress(jobs),
      statusText,
      jobs,
      muxAssetId,
      generatedMetadata,
    };
  },
});
