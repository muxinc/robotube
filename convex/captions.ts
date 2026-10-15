"use node";

import Mux from "@mux/mux-node";
import { v } from "convex/values";

import { components, internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { isLaravelOrchestrationEnabled } from "./laravelFlag";
import { selectCaptionDirectiveId } from "./captionDirectivesConfig";
import { parseCaptionDirectiveRun, parseCaptionDirectiveRunId } from "./captionDirectivesMuxAdapter";
import {
  buildMuxPremiumCaptionsRequest,
  createMuxPremiumCaptionsJob,
  getMuxPremiumCaptionsJob,
  MuxPremiumCaptionsHttpError,
  parseMuxPremiumCaptionsJob,
  type MuxPremiumCaptionsJob,
} from "./premiumCaptionsMuxAdapter";
import { upsertVideoMetadataAndSyncFeedReadModel } from "./feedReadModelSync";

const MAX_ATTEMPTS = 10;
const LEGACY_GENERATED_CAPTIONS_PASSTHROUGH = "robotube:auto-generated";
const PREMIUM_CAPTIONS_API_URL =
  "https://api.mux.com/robots/v0/jobs/generate-premium-captions";

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

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length > 0 ? strings : undefined;
}

function asVisibility(
  value: unknown,
): "private" | "unlisted" | "public" | undefined {
  return value === "private" || value === "unlisted" || value === "public"
    ? value
    : undefined;
}

function normalizeLanguageCode(value: unknown) {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase().split("-")[0] ?? "";
  return normalized === "auto" || normalized === "und" ? "" : normalized;
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
        track?.passthrough === LEGACY_GENERATED_CAPTIONS_PASSTHROUGH),
  );
}

function getTrackLanguageCode(track: any) {
  return normalizeLanguageCode(track?.language_code ?? track?.languageCode ?? track?.language);
}

function findSourceCaptionsTrack(asset: any, preferredTrackId?: string) {
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

  if (preferredTrackId) {
    const preferredTrack = textTracks.find(
      (track: any) => track?.id === preferredTrackId,
    );
    if (preferredTrack) {
      return preferredTrack;
    }
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

function isRetryableCaptionsError(error: unknown, message: string) {
  if (error instanceof MuxPremiumCaptionsHttpError) {
    return (
      error.status === 404 ||
      error.status === 408 ||
      error.status === 409 ||
      error.status === 425 ||
      error.status === 429 ||
      error.status >= 500
    );
  }
  return !isNonRetryableCaptionsError(message);
}

// Any text track on the asset that is not in a failed state means captions are
// ready or in flight. Reuse it rather than creating a conflicting Premium
// Captions track for the same language.
function hasNonErroredTextTrack(asset: any) {
  return (asset?.tracks ?? []).some(
    (track: any) => track?.type === "text" && track?.status !== "errored",
  );
}

function isActiveMuxRobotsJobStatus(value: unknown) {
  return value === "pending" || value === "processing";
}

function formatPremiumCaptionsErrors(job: MuxPremiumCaptionsJob) {
  if (!job.errors || job.errors.length === 0) {
    return `Mux Premium Captions job ${job.status}.`;
  }

  return job.errors
    .map((error) => error?.message || error?.type || "Unknown error")
    .join("; ");
}

async function upsertCaptionMetadataFields(
  ctx: any,
  args: { muxAssetId: string; userId: string },
  customFields: Record<string, unknown>,
) {
  const latestVideo = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
    muxAssetId: args.muxAssetId,
    userId: args.userId,
  });
  const cache = await ctx.runQuery((internal as any).muxAssetCache.getByMuxAssetIdInternal, { muxAssetId: args.muxAssetId });
  if (cache?.isDeleted || !latestVideo?.asset) return {};
  const latestMetadata = getMetadataRecord(latestVideo?.metadata);
  if (latestMetadata.userId !== args.userId) return {};
  const latestCustom = asCustomRecord(latestMetadata.custom);
  if (typeof latestCustom.includeSpeakers === "boolean") {
    return await ctx.runMutation((internal as any).captionDirectives.updateMetadataInternal, {
      muxAssetId: args.muxAssetId, userId: args.userId, fields: customFields,
    });
  }
  const nextCustom = {
    ...latestCustom,
    ...customFields,
  };

  await upsertVideoMetadataAndSyncFeedReadModel(ctx, {
    muxAssetId: args.muxAssetId,
    userId: args.userId,
    title: asString(latestMetadata.title),
    description: asString(latestMetadata.description),
    tags: asStringArray(latestMetadata.tags),
    visibility: asVisibility(latestMetadata.visibility),
    custom: nextCustom,
  });

  return nextCustom;
}

async function applyPremiumCaptionsJobUpdate(
  ctx: any,
  args: { muxAssetId: string; userId: string },
  job: MuxPremiumCaptionsJob,
) {
  const video = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
    muxAssetId: args.muxAssetId,
    userId: args.userId,
  });
  const metadata = getMetadataRecord(video?.metadata);
  const custom = asCustomRecord(metadata.custom);
  const currentJobId = asString(custom.aiCaptionsJobId);

  if (currentJobId && currentJobId !== job.id) {
    return { ok: true, skipped: true, reason: "job_replaced" as const };
  }

  if (isActiveMuxRobotsJobStatus(job.status)) {
    await upsertCaptionMetadataFields(ctx, args, {
      aiCaptionsJobId: job.id,
      aiCaptionsJobStatus: job.status,
      aiCaptionsSource: "mux_premium",
      aiCaptionsUnavailableReason: null,
    });
    return { ok: true, skipped: false, status: job.status };
  }

  if (job.status === "completed") {
    await upsertCaptionMetadataFields(ctx, args, {
      aiCaptionsJobId: job.id,
      aiCaptionsJobStatus: job.status,
      aiCaptionsPremiumTrackId: asString(job.outputs?.track_id),
      aiCaptionsPremiumLanguageCode:
        normalizeLanguageCode(job.outputs?.language_code) || "en",
      aiCaptionsSource: "mux_premium",
      aiCaptionsUnavailableReason: null,
      aiCaptionsRetryScheduled: false,
    });
    return { ok: true, skipped: false, status: job.status };
  }

  const message = formatPremiumCaptionsErrors(job);
  await upsertCaptionMetadataFields(ctx, args, {
    aiCaptionsJobId: job.id,
    aiCaptionsJobStatus: job.status,
    aiCaptionsFailedAtMs: Date.now(),
    aiCaptionsLastError: message,
    aiCaptionsUnavailableReason: message,
    aiCaptionsPollingTimedOut: false,
    aiCaptionsRetryScheduled: false,
  });
  return { ok: false, skipped: false, status: job.status, error: message };
}

export const syncPremiumCaptionsJobInternal = internalAction({
  args: {
    muxAssetId: v.string(),
    userId: v.string(),
    job: v.any(),
  },
  handler: async (ctx, args) => {
    const video = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, { muxAssetId: args.muxAssetId, userId: args.userId });
    if (typeof asCustomRecord(getMetadataRecord(video?.metadata).custom).includeSpeakers === "boolean") {
      await ctx.scheduler.runAfter(0, (internal as any).captions.ensureGeneratedCaptionsTrackInternal, { muxAssetId: args.muxAssetId, userId: args.userId });
      return { ok: true, skipped: true, reason: "directive_poll_owned" };
    }
    const job = parseMuxPremiumCaptionsJob(args.job);
    const result = await applyPremiumCaptionsJobUpdate(ctx, args, job);

    if (job.status === "completed") {
      await ctx.scheduler.runAfter(
        0,
        (internal as any).captions.ensureGeneratedCaptionsTrackInternal,
        {
          muxAssetId: args.muxAssetId,
          userId: args.userId,
          attempt: 0,
        },
      );
    }

    return result;
  },
});

async function maybeScheduleAiMetadataForReadyCaptions(
  ctx: any,
  args: { muxAssetId: string; userId: string },
  custom: Record<string, unknown>,
) {
  // Captions/STT generation stays Convex-owned, but the AI-metadata Robots
  // kickoff it chains into is owned by Laravel when the flag is on. Skip the
  // schedule entirely so we do not create duplicate summarize/chapters/
  // key-moments jobs (this was the double-processing path found in Loop 18).
  if (isLaravelOrchestrationEnabled()) {
    console.log(
      `[captions] AI-metadata kickoff skipped for ${args.muxAssetId}: USE_LARAVEL_ORCHESTRATION on`,
    );
    return false;
  }

  const missingSummary =
    asNumber(custom.aiGeneratedAtMs) === undefined &&
    !isActiveMuxRobotsJobStatus(custom.aiSummaryJobStatus);
  const missingChapters =
    asNumber(custom.aiChaptersGeneratedAtMs) === undefined &&
    !asString(custom.aiChaptersUnavailableReason) &&
    !isActiveMuxRobotsJobStatus(custom.aiChaptersJobStatus);
  const missingKeyMoments =
    asNumber(custom.aiKeyMomentsGeneratedAtMs) === undefined &&
    !asString(custom.aiKeyMomentsUnavailableReason) &&
    !isActiveMuxRobotsJobStatus(custom.aiKeyMomentsJobStatus);

  if (!missingSummary && !missingChapters && !missingKeyMoments) {
    return false;
  }

  await ctx.scheduler.runAfter(
    0,
    (internal as any).aiMetadata.generateSummaryAndTagsForAssetInternal,
    {
      muxAssetId: args.muxAssetId,
      userId: args.userId,
      attempt: 0,
    },
  );

  return true;
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
    if (asNumber(custom.moderationCheckedAtMs) === undefined) {
      return { ok: true, skipped: true, reason: "moderation_pending" };
    }

    if (custom.moderationPassed !== true) {
      return { ok: true, skipped: true, reason: "moderation_rejected" };
    }

    if (custom.aiCaptionsGeneratedAtMs && asString(custom.aiSourceLanguageCode)) {
      const scheduledAiMetadata = await maybeScheduleAiMetadataForReadyCaptions(
        ctx,
        args,
        custom,
      );
      return {
        ok: true,
        skipped: true,
        reason: "already_handled",
        scheduledAiMetadata,
      };
    }

    if (asString(custom.aiCaptionsUnavailableReason) &&
        !(typeof custom.includeSpeakers === "boolean" && custom.aiCaptionsPollingTimedOut === true)) {
      return { ok: true, skipped: true, reason: "already_handled" };
    }

    let hasClaimedDirectiveRun = false;
    try {
      if (typeof custom.includeSpeakers === "boolean") {
        const context = await ctx.runQuery((internal as any).captionDirectives.getReconciliationContextInternal, {
          muxAssetId: args.muxAssetId,
        });
        hasClaimedDirectiveRun = context?.kind === "directive";
      }
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

      let premiumJob: MuxPremiumCaptionsJob | undefined;
      const directiveMode = typeof custom.includeSpeakers === "boolean";
      let directiveJobId: string | undefined;
      if (directiveMode) {
        const claimArgs = { muxAssetId: args.muxAssetId, userId: args.userId, includeSpeakers: custom.includeSpeakers };
        // Existing claims pin their configuration, even if env mappings have
        // since disappeared. Only a new claim requires current configuration.
        let claim: any = await ctx.runMutation((internal as any).captionDirectives.claimInternal, claimArgs);
        if (claim?.needsConfiguration) {
          claim = await ctx.runMutation((internal as any).captionDirectives.claimInternal, {
            ...claimArgs, directiveId: selectCaptionDirectiveId(custom.includeSpeakers as boolean, process.env),
          });
        }
        if (!claim) return { ok: true, skipped: true, reason: "asset_not_owned_or_deleted" };
        const url = `https://api.mux.com/robots/v0/directives/${encodeURIComponent(claim.directiveId)}/runs`;
        let runId = claim.runId;
        if (claim.acquired) {
          // The claim is permanent: an ambiguous POST must never be reposted.
          const response = await fetch(url, {
            method: "POST", signal: AbortSignal.timeout(60_000), headers: { Authorization: createMuxBasicAuthHeader(), "Content-Type": "application/json" },
            body: JSON.stringify({ asset_id: args.muxAssetId }),
          });
          if (!response.ok) throw new MuxPremiumCaptionsHttpError(response.status, `Caption Directive submission: ${await response.text()}. Manual reconciliation required; no automatic resubmission.`);
          runId = parseCaptionDirectiveRunId(await response.json());
          await ctx.runMutation((internal as any).captionDirectives.recordRunInternal, { claimId: claim._id, runId });
        }
        if (runId) {
          hasClaimedDirectiveRun = true;
          const response = await fetch(`${url}/${encodeURIComponent(runId)}`, { signal: AbortSignal.timeout(60_000), headers: { Authorization: createMuxBasicAuthHeader() } });
          if (!response.ok) throw new Error(`Caption Directive polling failed (${response.status}).`);
          const run = parseCaptionDirectiveRun(await response.json());
          const node = run.node_states.find(item => item.reference_id === "premium_captions");
          if (node?.status === "failed" || ["partial", "errored"].includes(run?.status)) {
            const message = node?.reason || `Caption Directive ${run.status}`;
            await upsertCaptionMetadataFields(ctx, args, { aiCaptionsUnavailableReason: message, aiCaptionsLastError: message, aiCaptionsRetryScheduled: false, aiCaptionsPollingTimedOut: false });
            return { ok: false, error: message };
          }
          directiveJobId = node?.job_id;
          await upsertCaptionMetadataFields(ctx, args, { aiCaptionsDirectiveId: claim.directiveId, aiCaptionsDirectiveRunId: runId });
        }
        if (!directiveJobId) throw new Error(runId ? "Caption Directive awaiting premium job." : "Caption Directive submission outcome unknown; manual reconciliation required.");
      }
      if (directiveMode && asString(custom.aiCaptionsJobId) && custom.aiCaptionsJobId !== directiveJobId) {
        return { ok: true, skipped: true, reason: "job_replaced" };
      }
      const existingPremiumJobId = directiveJobId ?? asString(custom.aiCaptionsJobId);
      if (existingPremiumJobId) {
        premiumJob = await getMuxPremiumCaptionsJob(
          fetch,
          `${PREMIUM_CAPTIONS_API_URL}/${encodeURIComponent(existingPremiumJobId)}`,
          createMuxBasicAuthHeader(),
        );
        if (directiveMode && asCustomRecord(premiumJob.parameters).asset_id !== args.muxAssetId) {
          throw new Error("Caption Directive premium job asset does not match the claimed asset.");
        }
        if (directiveMode) {
          const requested = asCustomRecord(premiumJob.parameters).include_speakers;
          const includeSpeakers = requested === undefined ? false : requested;
          if (typeof includeSpeakers !== "boolean" || includeSpeakers !== custom.includeSpeakers) {
            throw new MuxPremiumCaptionsHttpError(422, "Caption Directive speaker setting does not match the claimed choice.");
          }
        }
        await applyPremiumCaptionsJobUpdate(ctx, args, premiumJob);

        if (isActiveMuxRobotsJobStatus(premiumJob.status)) {
          const shouldRetry = nextAttempt < MAX_ATTEMPTS;
          await upsertCaptionMetadataFields(ctx, args, {
            aiCaptionsRetryScheduled: shouldRetry,
            ...(!shouldRetry && directiveMode ? { aiCaptionsUnavailableReason: "Premium captions polling timed out.", aiCaptionsPollingTimedOut: true } : {}),
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
            ok: true,
            skipped: true,
            reason: "premium_captions_in_flight",
            retryScheduled: shouldRetry,
            nextAttempt,
          };
        }

        if (premiumJob.status !== "completed") {
          return {
            ok: false,
            skipped: false,
            reason: "premium_captions_failed",
            status: premiumJob.status,
          };
        }
      }

      const preferredPremiumTrackId = directiveMode
        ? asString(premiumJob?.outputs?.track_id)
        : asString(premiumJob?.outputs?.track_id) ?? asString(custom.aiCaptionsPremiumTrackId);
      const sourceCaptionsTrack = directiveMode
        ? (asset.tracks ?? []).find((track: any) => track.id === preferredPremiumTrackId && track.type === "text" && track.status === "ready")
        : findSourceCaptionsTrack(asset, preferredPremiumTrackId);
      if (sourceCaptionsTrack) {
        const detectedLanguageCode = getTrackLanguageCode(sourceCaptionsTrack);
        const captionsReady = sourceCaptionsTrack.status === "ready";
        const languageDetected = detectedLanguageCode.length > 0;

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

        const nextCustom = await upsertCaptionMetadataFields(ctx, args, {
          ...(existingPremiumJobId ? { aiCaptionsJobId: existingPremiumJobId } : {}),
          aiCaptionsGeneratedAtMs: Date.now(),
          aiCaptionsTrackId: sourceCaptionsTrack.id,
          aiCaptionsPollingTimedOut: false,
          aiCaptionsLastError: null,
          aiCaptionsFailedAtMs: null,
          aiSourceLanguageCode: detectedLanguageCode,
          aiSourceLanguageLabel: getLanguageDisplayLabel(detectedLanguageCode),
          aiCaptionsSource: existingPremiumJobId
            ? "mux_premium"
            : sourceCaptionsTrack.text_source === "generated_vod" ||
                sourceCaptionsTrack.textSource === "generated_vod" ||
                sourceCaptionsTrack.passthrough ===
                  LEGACY_GENERATED_CAPTIONS_PASSTHROUGH
              ? "mux_generated"
              : "existing",
          aiCaptionsUnavailableReason: null,
          aiCaptionsRetryScheduled: false,
        });
        if (!nextCustom.aiCaptionsGeneratedAtMs) return { ok: true, skipped: true, reason: "asset_not_owned_or_deleted" };
        const scheduledAiMetadata = await maybeScheduleAiMetadataForReadyCaptions(
          ctx,
          args,
          nextCustom,
        );
        return { ok: true, skipped: false, alreadyExisted: true, scheduledAiMetadata };
      }

      if (directiveMode || premiumJob?.status === "completed") {
        const shouldRetry = nextAttempt < MAX_ATTEMPTS;
        await upsertCaptionMetadataFields(ctx, args, {
          aiCaptionsRetryScheduled: shouldRetry,
          ...(!shouldRetry && directiveMode ? { aiCaptionsUnavailableReason: "Premium caption output track readiness timed out.", aiCaptionsPollingTimedOut: true } : {}),
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
          ok: true,
          skipped: true,
          reason: "premium_track_not_ready",
          retryScheduled: shouldRetry,
          nextAttempt,
        };
      }

      // A ready or preparing text track means caption work is already complete
      // or in flight. Let the track.ready webhook reconcile it instead of
      // creating a conflicting same-language Premium Captions job.
      if (hasNonErroredTextTrack(asset)) {
        await upsertCaptionMetadataFields(ctx, args, {
          aiCaptionsRequestedAtMs:
            asNumber(custom.aiCaptionsRequestedAtMs) ?? Date.now(),
          aiCaptionsUnavailableReason: null,
          aiCaptionsRetryScheduled: false,
        });
        return { ok: true, skipped: true, reason: "captions_in_flight" };
      }

      const createdJob = await createMuxPremiumCaptionsJob(
        fetch,
        PREMIUM_CAPTIONS_API_URL,
        createMuxBasicAuthHeader(),
        buildMuxPremiumCaptionsRequest(args),
      );

      const shouldRetry =
        (isActiveMuxRobotsJobStatus(createdJob.status) ||
          createdJob.status === "completed") &&
        nextAttempt < MAX_ATTEMPTS;
      await upsertCaptionMetadataFields(ctx, args, {
        aiCaptionsRequestedAtMs:
          asNumber(custom.aiCaptionsRequestedAtMs) ?? Date.now(),
        aiCaptionsJobId: createdJob.id,
        aiCaptionsJobStatus: createdJob.status,
        aiCaptionsSource: "mux_premium",
        aiCaptionsAttemptCount: nextAttempt,
        aiCaptionsUnavailableReason: null,
        aiCaptionsRetryScheduled: shouldRetry,
      });
      await applyPremiumCaptionsJobUpdate(ctx, args, createdJob);

      if (shouldRetry) {
        await ctx.scheduler.runAfter(
          createdJob.status === "completed" ? 0 : getRetryDelayMs(nextAttempt),
          (internal as any).captions.ensureGeneratedCaptionsTrackInternal,
          {
            muxAssetId: args.muxAssetId,
            userId: args.userId,
            attempt: nextAttempt,
          },
        );
      }

      return {
        ok: createdJob.status !== "errored" && createdJob.status !== "cancelled",
        skipped: false,
        status: createdJob.status,
        retryScheduled: shouldRetry,
        nextAttempt,
      };
    } catch (error) {
      const message = getErrorMessage(error);
      const retryable = isRetryableCaptionsError(error, message);
      const shouldRetry = retryable && nextAttempt < MAX_ATTEMPTS;

      await upsertCaptionMetadataFields(ctx, args, {
        aiCaptionsFailedAtMs: Date.now(),
        aiCaptionsLastError: message,
        aiCaptionsAttemptCount: nextAttempt,
        aiCaptionsRetryScheduled: shouldRetry,
        ...(!shouldRetry ? { aiCaptionsUnavailableReason: message, aiCaptionsPollingTimedOut: hasClaimedDirectiveRun && retryable } : {}),
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
