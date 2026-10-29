"use node";

import Mux from "@mux/mux-node";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";

import { components, internal } from "./_generated/api";
import { action, internalAction } from "./_generated/server";
import {
  createMuxCaptionEditingJob,
  getMuxCaptionEditingJob,
  MuxCaptionEditingHttpError,
} from "./captionEditingMuxAdapter";
import { parsePassthroughUserId } from "./feedContracts";
import { upsertVideoMetadataAndSyncFeedReadModel } from "./feedReadModelSync";
import { parseCaptionVtt, replaceCaptionCueText } from "./captionVtt";
import { captionRulesError } from "../lib/captionRobots";
import { canRecoverCaptionCensor, censorRequest, deleteReplacedSource } from "./captionEditingWorkflow";

const API = "https://api.mux.com/robots/v1/jobs/edit-captions";
const POLL_MS = 15_000;
const MAX_POLL_ATTEMPTS = 80;
const TRACK_WAIT_MS = 10_000;
const MAX_TRACK_WAIT_ATTEMPTS = 30;
const RECONCILIATION_RETRY_MS = 30_000;
const MAX_RECONCILIATION_RETRIES = 8;
const DEPENDENT_WAIT_MS = 30_000;
const MAX_DEPENDENT_WAIT_ATTEMPTS = 80;
const TERMINAL = new Set(["completed", "errored", "cancelled"]);
const ACTIVE = new Set(["pending", "processing"]);
type Status = "requested" | "pending" | "processing" | "completed" | "errored" | "cancelled";

class CaptionAssetDeletedError extends Error {}
class CaptionDependentRefreshError extends Error {}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
function metadataRecord(value: unknown) { return Array.isArray(value) ? record(value[0]) : record(value); }
function stringValue(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function numberValue(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
// The edited track replaces the source; keep "reviewed" in its name so the web player prefers it.
function reviewedTrackName(sourceName: unknown) {
  const base = stringValue(sourceName) ?? "Captions";
  return /reviewed/i.test(base) ? base : `${base.slice(0, 100)} (reviewed)`;
}
function isFailedDependentStatus(value: unknown) {
  return value === "errored" || value === "cancelled";
}
function isActiveDependentStatus(value: unknown) {
  return value === "pending" || value === "processing";
}
function httpStatus(error: unknown) {
  const value = record(error);
  return numberValue(value.status) ??
    numberValue(value.statusCode) ??
    numberValue(record(value.response).status);
}
function muxCredentials() {
  const tokenId = process.env.MUX_TOKEN_ID;
  const tokenSecret = process.env.MUX_TOKEN_SECRET;
  if (!tokenId) throw new Error("Missing env var: MUX_TOKEN_ID");
  if (!tokenSecret) throw new Error("Missing env var: MUX_TOKEN_SECRET");
  return { tokenId, tokenSecret };
}
function authHeader() { const credentials = muxCredentials(); return `Basic ${Buffer.from(`${credentials.tokenId}:${credentials.tokenSecret}`).toString("base64")}`; }
function muxClient() { return new Mux(muxCredentials()); }
function enabled() { return process.env.CAPTION_EDITING_ENABLED !== "false"; }

async function ownReadyTrack(ctx: any, muxAssetId: string, trackId: string) {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("You must be signed in to edit captions.");
  const video: any = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, { muxAssetId, userId });
  if (!video?.asset) throw new Error("Video not found.");
  const metadata = metadataRecord(video.metadata);
  const owner = stringValue(metadata.userId) ?? parsePassthroughUserId(record(video.asset).passthrough);
  if (owner !== userId) throw new Error("Video not found.");
  const asset: any = await muxClient().video.assets.retrieve(muxAssetId);
  if (asset.status !== "ready") throw new Error("The video is still preparing.");
  const track = (asset.tracks ?? []).find((item: any) => item.id === trackId && item.type === "text" && item.status === "ready");
  if (!track) throw new Error("Choose a ready caption track from this video.");
  return { userId, video, asset, track, metadata };
}

async function downloadCaptionVtt(asset: any, trackId: string): Promise<string> {
  const playback = asset.playback_ids?.find((item: any) => item.policy === "public") ?? asset.playback_ids?.[0];
  if (!playback?.id) throw new Error("Caption download is unavailable: this video needs a playback ID.");
  const url = new URL(`https://stream.mux.com/${encodeURIComponent(playback.id)}/text/${encodeURIComponent(trackId)}.vtt`);
  if (playback.policy === "signed") url.searchParams.set("token", await muxClient().jwt.signPlaybackId(playback.id, { type: "video", expiration: "5m" }));
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw new Error("Caption text is temporarily unavailable from Mux.");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > 5_000_000) throw new Error("Caption file is too large to edit (5 MB maximum).");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString("utf8");
}

export const loadOwnCaptionDocument = action({
  args: { muxAssetId: v.string(), trackId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<any> => {
    if (!enabled()) throw new Error("Caption editing is temporarily unavailable.");
    const muxAssetId = args.muxAssetId.trim();
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("You must be signed in to edit captions.");
    const video: any = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, { muxAssetId, userId });
    if (!video?.asset) throw new Error("Video not found.");
    const metadata = metadataRecord(video.metadata); const custom = record(metadata.custom);
    const owner = stringValue(metadata.userId) ?? parsePassthroughUserId(record(video.asset).passthrough);
    if (owner !== userId) throw new Error("Video not found.");
    const asset: any = await muxClient().video.assets.retrieve(muxAssetId);
    if (asset.status !== "ready") throw new Error("The video is still preparing.");
    const trackId = args.trackId?.trim() || stringValue(custom.aiCaptionsTrackId);
    const track = trackId
      ? (asset.tracks ?? []).find((item: any) => item.id === trackId && item.type === "text" && item.status === "ready")
      : (asset.tracks ?? []).find((item: any) => item.type === "text" && item.status === "ready");
    if (!track) throw new Error("No ready caption track is available.");
    const document = parseCaptionVtt(await downloadCaptionVtt(asset, track.id));
    return { trackId: track.id, captionRevision: numberValue(custom.aiCaptionsRevision) ?? 0, languageCode: track.language_code ?? track.languageCode ?? track.language, name: track.name, cues: document.cues };
  },
});

export const replaceOwnCaptionTrack = action({
  args: {
    muxAssetId: v.string(), trackId: v.string(), captionRevision: v.number(),
    edits: v.array(v.object({ id: v.string(), text: v.string() })),
    autoCensorProfanity: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<any> => {
    if (!enabled()) throw new Error("Caption editing is temporarily unavailable.");
    const current = await ownReadyTrack(ctx, args.muxAssetId.trim(), args.trackId.trim());
    const metadata = metadataRecord(current.video.metadata); const custom = record(metadata.custom);
    if ((numberValue(custom.aiCaptionsRevision) ?? 0) !== args.captionRevision) throw new Error("Caption document is stale. Refresh and try again.");
    const sourceId = stringValue(custom.aiCaptionsTrackId) ?? current.asset.tracks?.find((track: any) => track.type === "text" && track.status === "ready")?.id;
    if (sourceId !== current.track.id) throw new Error("Caption source track is stale. Refresh and try again.");
    if (args.edits.length > 5000) throw new Error("This caption track contains too many cues.");
    const source = await downloadCaptionVtt(current.asset, current.track.id); const document = parseCaptionVtt(source);
    const allowed = new Map(document.cues.map((cue) => [cue.id, cue]));
    const changed: Record<string, string> = Object.create(null);
    for (const edit of args.edits) {
      const cue = allowed.get(edit.id);
      if (!cue) throw new Error("Caption document is stale. Refresh and try again.");
      if (!edit.text.trim()) throw new Error("Caption cue text cannot be empty.");
      if (edit.text.length > 10_000) throw new Error("Caption cue text is too long.");
      if (/\n\s*\n|-->|\r|\u0000/.test(edit.text)) throw new Error("Caption text cannot contain blank lines or timestamp delimiters.");
      if (cue.text !== edit.text) changed[edit.id] = edit.text;
    }
    if (!Object.keys(changed).length && !args.autoCensorProfanity) throw new Error("Edit a caption or turn on auto-censor first.");
    const rebuilt = replaceCaptionCueText(source, document, changed);
    if (Buffer.byteLength(rebuilt) > 5_000_000) throw new Error("Caption file is too large to edit (5 MB maximum).");
    const created: any = await ctx.runMutation((internal as any).captionEditing.createRequestedEditInternal, {
      muxAssetId: args.muxAssetId.trim(), userId: current.userId, sourceTrackId: current.track.id,
      sourceLanguageCode: current.track.language_code ?? "en", sourceTrackName: current.track.name,
      revision: args.captionRevision + 1, operation: "manual", autoCensorProfanity: args.autoCensorProfanity ?? false,
    });
    if (!created.created) throw new Error(created.reason === "translations_active" ? "Wait for caption translations to finish before editing." :
      created.reason === "stale_revision" ? "Caption document is stale. Refresh and try again." : "Another caption edit or recovery is already active.");
    let storageId;
    try {
      storageId = await ctx.storage.store(new Blob([rebuilt], { type: "text/vtt" }));
      const result = await transitionManual(ctx, created.row, { stage: "upload_requested", status: "requested", storageId });
      if (!result.changed) throw new Error("Caption upload reservation expired. Please try again.");
      return { localJobId: created.row._id, changedCueCount: Object.keys(changed).length, status: "requested" };
    } catch (error) {
      if (storageId) await ctx.storage.delete(storageId);
      await transitionManual(ctx, created.row, { stage: "failed", status: "errored", errorMessage: "Could not stage the replacement captions. Please try again." });
      throw error;
    }
  },
});

async function transitionManual(ctx: any, row: any, patch: Record<string, unknown>): Promise<any> {
  return ctx.runMutation((internal as any).captionEditing.transitionManualEditInternal, {
    requestId: row._id, expectedStage: row.pipelineStage, expectedAttempt: row.censorAttempt, ...patch,
  });
}

export const advanceManualCaptionEditInternal = internalAction({
  args: { requestId: v.id("captionEditingJobs") },
  handler: async (ctx, args): Promise<any> => {
    let row: any = await ctx.runMutation((internal as any).captionEditing.claimManualWorkerInternal, args);
    if (!row) return;
    const age = Date.now() - row.pipelineUpdatedAtMs;
    // A scheduled successor precedes all external calls, including requests that
    // might time out after Mux accepted them. Never blindly repeat such a POST.
    try {
      if (row.pipelineStage === "staging") {
        if (age >= 120_000) await transitionManual(ctx, row, { stage: "failed", status: "errored", clearStorage: true, errorMessage: "Caption upload did not start. Please try again." });
        return;
      }
      const client = muxClient();
      const asset = await client.video.assets.retrieve(row.muxAssetId);
      const tag = `caption-edit:${row._id}`;
      if (row.pipelineStage === "upload_requested") {
        const url = row.temporaryStorageId && await ctx.storage.getUrl(row.temporaryStorageId);
        if (!url) throw new Error("Replacement caption file is missing.");
        const claim = await transitionManual(ctx, row, { stage: "uploading", status: "processing" });
        if (!claim.changed) return;
        row = claim.row;
        try {
          const track = await client.video.assets.createTrack(row.muxAssetId, {
            type: "text", text_type: "subtitles", url, language_code: row.sourceLanguageCode ?? "en",
            name: `${(row.sourceTrackName ?? "Captions").slice(0, 100)} edited ${String(row._id).slice(-8)}`,
            passthrough: tag,
          }, { maxRetries: 0, timeout: 60_000 });
          if (!track.id) throw new Error("Mux did not confirm the caption track ID.");
          await transitionManual(ctx, row, { stage: "waiting_track", status: "processing", intermediateTrackId: track.id });
        } catch (error) {
          // A network error or 5xx may follow successful creation. The successor
          // looks for the unique track passthrough before declaring uncertainty.
          const code = httpStatus(error);
          if (code && code >= 400 && code < 500 && code !== 408) {
            await transitionManual(ctx, row, { stage: "failed", status: "errored", clearStorage: true, errorMessage: "Mux could not upload the caption track. Please try again." });
          }
        }
        return;
      }
      if (row.pipelineStage === "uploading") {
        const track = asset.tracks?.find((item: any) => item.passthrough === tag);
        if (track?.id) await transitionManual(ctx, row, { stage: "waiting_track", status: "processing", intermediateTrackId: track.id });
        else if (age > 10 * 60_000) await transitionManual(ctx, row, { stage: "uploading", status: "errored", uncertain: true, errorMessage: "Mux has not confirmed the caption upload. An operator must review it before retrying." });
        return;
      }
      if (row.pipelineStage === "waiting_track") {
        const track = asset.tracks?.find((item) => item.id === row.intermediateTrackId);
        if (track?.status === "ready") {
          await transitionManual(ctx, row, row.autoCensorProfanity
            ? { stage: "censor_requested", status: "requested", clearStorage: true }
            : { stage: "finalizing", status: "completed", uploadedTrackId: track.id, clearStorage: true });
        } else if (track?.status === "errored") {
          await transitionManual(ctx, row, { stage: "failed", status: "errored", clearStorage: true, errorMessage: "Mux could not ingest the replacement captions. Your original captions are unchanged." });
        } else if (age > 10 * 60_000) {
          await transitionManual(ctx, row, { stage: "waiting_track", status: "errored", uncertain: true, errorMessage: "Mux has not confirmed caption ingestion. The original captions are unchanged. Check upload status again." });
        }
        return;
      }
      if (row.pipelineStage === "censor_requested") {
        if (!asset.tracks?.some((track) => track.id === row.intermediateTrackId && track.status === "ready")) {
          await transitionManual(ctx, row, { stage: "censor_failed", status: "errored", errorMessage: "The manually edited caption track is unavailable. Try recovery again after checking the video." });
          return;
        }
        const claim = await transitionManual(ctx, row, { stage: "censor_submitting", status: "requested" });
        if (!claim.changed) return;
        row = claim.row;
        const body = censorRequest(row);
        try {
          const job = await createMuxCaptionEditingJob(fetch, API, authHeader(), body);
          await ctx.runMutation((internal as any).captionEditing.attachMuxJobInternal,
            { requestId: row._id, jobId: job.id, status: job.status, passthrough: body.passthrough });
          await sync(ctx, job, row._id);
        } catch (error) {
          if (error instanceof MuxCaptionEditingHttpError && error.status < 500 && error.status !== 408) {
            await transitionManual(ctx, row, { stage: "censor_failed", status: "errored", errorMessage: "Censoring could not start. Your original and manually edited captions are retained." });
          }
          // Otherwise wait for the webhook or the submission watchdog.
        }
        return;
      }
      if (row.pipelineStage === "censor_submitting" && age >= 120_000) {
        await transitionManual(ctx, row, { stage: "censor_submitting", status: "requested", uncertain: true,
          errorMessage: "Mux has not confirmed whether censoring started. An operator must review this request before retrying." });
      }
    } catch (error) {
      if (httpStatus(error) === 404) {
        await transitionManual(ctx, row, { stage: "failed", status: "errored", clearStorage: true, errorMessage: "This video is no longer available." });
      } else if (age > 10 * 60_000) {
        await transitionManual(ctx, row, { stage: row.pipelineStage, status: "errored", uncertain: true,
          errorMessage: "Caption processing needs a status check. Your original captions are retained." });
      }
    }
  },
});

export const recoverOwnCaptionCensoring = action({
  args: { muxAssetId: v.string(), useManualTrack: v.boolean() },
  handler: async (ctx, args): Promise<any> => {
    if (!enabled()) throw new Error("Caption editing is temporarily unavailable.");
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("You must be signed in to recover captions.");
    const rows: any[] = await ctx.runQuery((internal as any).captionEditing.listEditJobsInternal, { muxAssetId: args.muxAssetId });
    const row = rows[0];
    if (row?.userId !== userId || !canRecoverCaptionCensor(row)) return { restarted: false };
    await ownReadyTrack(ctx, args.muxAssetId, row.intermediateTrackId);
    return ctx.runMutation((internal as any).captionEditing.recoverCaptionCensorInternal,
      { requestId: row._id, userId, useManualTrack: args.useManualTrack });
  },
});
function safeError(error: unknown, fallback = "Caption cleanup could not be completed.") {
  const status = httpStatus(error);
  if (status === 401 || status === 403) return "Caption cleanup is not configured for this environment.";
  if (status === 429) return "Caption cleanup is temporarily busy. Please try again later.";
  if (error instanceof Error && /timed out/i.test(error.message)) return "Caption cleanup timed out. Please try again.";
  return fallback;
}
function normalizeStatus(value: unknown): Status {
  if (value === "pending" || value === "processing" || value === "completed" || value === "errored" || value === "cancelled") return value;
  return "pending";
}
function normalizePassthrough(value: unknown) {
  if (typeof value === "string") return value;
  try { return value == null ? undefined : JSON.stringify(value); } catch { return undefined; }
}
function parsePassthrough(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) return record(value);
  if (typeof value !== "string") return {};
  try { return record(JSON.parse(value)); } catch { return {}; }
}
function unwrapJob(value: unknown) { const root = record(value); return record(root.data ?? root.job ?? root); }
function parseRequestId(value: unknown) {
  const parsed = parsePassthrough(value);
  return stringValue(parsed.editRequestId ?? parsed.edit_request_id);
}
function jobFields(job: Record<string, any>) {
  const outputs = record(job.outputs);
  const parameters = record(job.parameters);
  const passthrough = parsePassthrough(job.passthrough);
  return {
    jobId: stringValue(job.id),
    status: normalizeStatus(job.status),
    passthrough: normalizePassthrough(job.passthrough),
    muxAssetId: stringValue(
      parameters.asset_id ??
      parameters.assetId ??
      passthrough.muxAssetId ??
      passthrough.mux_asset_id,
    ),
    uploadedTrackId: stringValue(outputs.track_id ?? outputs.uploaded_track_id ?? outputs.uploadedTrackId),
    totalReplacementCount: numberValue(outputs.total_replacement_count ?? outputs.totalReplacementCount),
    errorMessage: job.status === "errored" ? "Mux could not apply these caption edits." : undefined,
  };
}
async function fetchJob(jobId: string) {
  return await getMuxCaptionEditingJob(
    fetch,
    `${API}/${encodeURIComponent(jobId)}`,
    authHeader(),
  );
}
async function sync(ctx: any, job: Record<string, any>, requestId?: any) {
  const fields = jobFields(job);
  if (!fields.jobId) return { ok: false, reason: "missing_job_id" };
  let resolvedRequestId = requestId;
  if (!resolvedRequestId) {
    const row: any = await ctx.runQuery(
      (internal as any).captionEditing.resolveEditJobInternal,
      {
        requestId: parseRequestId(job.passthrough),
        jobId: fields.jobId,
      },
    );
    resolvedRequestId = row?._id;
  }
  if (!resolvedRequestId) return { ok: false, reason: "unknown_job" };
  const result: any = await ctx.runMutation(
    (internal as any).captionEditing.syncEditJobInternal,
    { requestId: resolvedRequestId, ...fields },
  );
  if (result?.shouldReconcile) {
    console.log("[captionEditing] job completed", JSON.stringify({
      muxAssetId: result.row.muxAssetId,
      requestId: String(result.row._id),
      jobId: fields.jobId,
      replacementCount: fields.totalReplacementCount ?? 0,
    }));
  }
  return result;
}

export const enforceDeletedAssetTombstoneInternal = internalAction({
  args: { muxAssetId: v.string() },
  handler: async (ctx, args) => {
    const cached: any = await ctx.runQuery(
      (internal as any).muxAssetCache.getByMuxAssetIdInternal,
      { muxAssetId: args.muxAssetId },
    );
    if (!cached?.isDeleted) return { deleted: false };
    await ctx.runMutation(
      (components as any).mux.videos.deleteVideoByMuxAssetIdPublic,
      { muxAssetId: args.muxAssetId },
    );
    return { deleted: true };
  },
});

export const editCaptionsForAsset = action({
  args: {
    muxAssetId: v.string(), trackId: v.string(), captionRevision: v.optional(v.number()),
    speakerReplacements: v.optional(v.array(v.object({ find: v.string(), replace: v.string() }))),
    autoCensorProfanity: v.optional(v.object({
      mode: v.optional(v.union(v.literal("blank"), v.literal("remove"), v.literal("mask"))),
      alwaysCensor: v.optional(v.array(v.string())), neverCensor: v.optional(v.array(v.string())),
    })),
    replacements: v.optional(v.array(v.object({
      find: v.string(), replace: v.string(), caseSensitive: v.optional(v.boolean()),
    }))),
    deleteOriginalTrack: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<any> => {
    if (!enabled()) throw new Error("Caption cleanup is temporarily unavailable.");
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("You must be signed in to edit captions.");
    const muxAssetId = args.muxAssetId.trim(); const trackId = args.trackId.trim();
    if (!muxAssetId || !trackId) throw new Error("A video and ready caption track are required.");
    if (args.deleteOriginalTrack === false) throw new Error("Caption cleanup replaces the original caption track.");
    const speakers = args.speakerReplacements ?? [];
    const rulesError = captionRulesError(args.replacements ?? [], speakers, Boolean(args.autoCensorProfanity));
    if (rulesError) throw new Error(rulesError);
    const replacements = (args.replacements ?? []).map((item) => ({
      find: item.find, replace: item.replace, case_sensitive: item.caseSensitive ?? false,
    }));
    const terms = (values?: string[]) => {
      const normalized = [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
      if (normalized.length > 100) throw new Error("Use no more than 100 profanity terms per list.");
      if (normalized.some((value) => value.length > 200)) throw new Error("Profanity terms must be 200 characters or fewer.");
      return normalized;
    };
    const always = terms(args.autoCensorProfanity?.alwaysCensor); const never = terms(args.autoCensorProfanity?.neverCensor);
    const censor = args.autoCensorProfanity ? {
      mode: args.autoCensorProfanity.mode ?? "blank",
      ...(always.length ? { always_censor: always } : {}), ...(never.length ? { never_censor: never } : {}),
    } : undefined;
    if (args.captionRevision !== undefined && (!Number.isSafeInteger(args.captionRevision) || args.captionRevision < 0)) throw new Error("Invalid caption revision.");

    const componentVideo: any = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, { muxAssetId, userId });
    if (!componentVideo?.asset) throw new Error("Video not found.");
    const metadata = metadataRecord(componentVideo.metadata);
    const owner = stringValue(metadata.userId) ?? parsePassthroughUserId(record(componentVideo.asset).passthrough);
    if (owner !== userId) throw new Error("Video not found.");
    const asset: any = await muxClient().video.assets.retrieve(muxAssetId);
    if (asset.status !== "ready") throw new Error("The video is still preparing.");
    const selected = (asset.tracks ?? []).find((track: any) => track.id === trackId);
    if (!selected || selected.type !== "text" || selected.status !== "ready") throw new Error("Choose a ready caption track from this video.");
    const custom = record(metadata.custom);
    if (typeof custom.aiCaptionsTrackId === "string" && custom.aiCaptionsTrackId !== trackId) throw new Error("This caption track is stale. Refresh and choose the current track.");
    const translationRows: any[] = await ctx.runQuery(
      (internal as any).captionTranslations.getTranslationRowsInternal,
      { muxAssetId },
    );
    if (
      translationRows.some(
        (row) =>
          row.status === "requested" ||
          row.status === "pending" ||
          row.status === "processing",
      )
    ) throw new Error("Wait for caption translations to finish before editing the source captions.");
    const revision = numberValue(custom.aiCaptionsRevision) ?? 0;
    if (args.captionRevision !== undefined && args.captionRevision !== revision) throw new Error("Caption document is stale. Refresh and try again.");
    const created: any = await ctx.runMutation((internal as any).captionEditing.createRequestedEditInternal, {
      muxAssetId, userId, sourceTrackId: trackId, operation: "robots",
      sourceTrackName: typeof selected.name === "string" ? selected.name : undefined,
      sourceLanguageCode: stringValue(selected.language_code ?? selected.languageCode ?? selected.language), revision: revision + 1,
    });
    if (!created.created) {
      if (created.reason === "translations_active")
        throw new Error("Wait for caption translations to finish before editing the source captions.");
      if (created.reason === "stale_revision") throw new Error("The source captions changed. Refresh and try again.");
      return { localJobId: created.row._id, jobId: created.row.jobId, status: created.row.status, alreadyActive: true };
    }
    const requestId = created.row._id;
    const passthrough = JSON.stringify({ muxAssetId, userId, editRequestId: String(requestId) });
    try {
      const job = await createMuxCaptionEditingJob(fetch, API, authHeader(), {
        passthrough,
        parameters: {
          asset_id: muxAssetId, track_id: trackId,
          ...(replacements.length ? { replacements } : {}), ...(censor ? { auto_censor_profanity: censor } : {}),
          ...(speakers.length ? { speaker_replacements: speakers } : {}),
          upload_to_mux: true, replace_existing_tracks: "replace", track_name: reviewedTrackName(selected.name),
        },
      });
      const fields = jobFields(job);
      if (!fields.jobId) throw new Error("Mux job creation failed.");
      await ctx.runMutation((internal as any).captionEditing.attachMuxJobInternal, { requestId, jobId: fields.jobId, status: fields.status, passthrough: fields.passthrough ?? passthrough });
      await sync(ctx, job, requestId);
      console.log("[captionEditing] job submitted", JSON.stringify({
        muxAssetId,
        requestId: String(requestId),
        jobId: fields.jobId,
        status: fields.status,
      }));
      return { localJobId: requestId, jobId: fields.jobId, status: fields.status, alreadyActive: false };
    } catch (error) {
      const definitiveFailure =
        (error instanceof MuxCaptionEditingHttpError && error.status >= 400 && error.status < 500 && error.status !== 408) ||
        (error instanceof Error && /Missing env var/.test(error.message));
      const message = definitiveFailure
        ? safeError(error)
        : "Mux did not confirm whether caption cleanup started. Its status will update automatically if the request was accepted.";
      if (definitiveFailure) {
        await ctx.runMutation((internal as any).captionEditing.failRequestedEditInternal, { requestId, errorMessage: message });
      } else {
        await ctx.runMutation((internal as any).captionEditing.markSubmissionUncertainInternal, { requestId, errorMessage: message });
      }
      throw new Error(message);
    }
  },
});

export const reconcileFailedRobotsSourceInternal = internalAction({
  args: { requestId: v.id("captionEditingJobs"), attempt: v.optional(v.number()) },
  handler: async (ctx, args): Promise<any> => {
    const row: any = await ctx.runQuery((internal as any).captionEditing.getEditJobInternal, { requestId: args.requestId });
    if (!row || row.operation !== "robots" || row.pollingTimedOutAtMs || !["errored", "cancelled"].includes(row.status)) return { skipped: true };
    const attempt = args.attempt ?? 0;
    let result: { restored?: boolean; skipped?: boolean; error?: string };
    try {
      const asset = await muxClient().video.assets.retrieve(row.muxAssetId);
      result = await ctx.runMutation((internal as any).captionEditing.rebindFailedRobotsSourceInternal, { requestId: row._id, asset });
    } catch (error) {
      if (httpStatus(error) === 404) return { skipped: true };
      result = { error: "Could not check the restored caption source." };
    }
    const retryScheduled = !result.restored && !result.skipped && attempt < 6;
    if (retryScheduled) {
      await ctx.scheduler.runAfter(TRACK_WAIT_MS, (internal as any).captionEditingNode.reconcileFailedRobotsSourceInternal,
        { requestId: row._id, attempt: attempt + 1 });
    }
    return { ...result, retryScheduled };
  },
});

export const syncCaptionEditJobInternal = internalAction({
  args: { job: v.any(), requestId: v.optional(v.id("captionEditingJobs")) },
  handler: async (ctx, args) => await sync(ctx, unwrapJob(args.job), args.requestId),
});

export const pollCaptionEditJobStatusInternal = internalAction({
  args: { requestId: v.id("captionEditingJobs"), jobId: v.string(), attempt: v.optional(v.number()) },
  handler: async (ctx, args): Promise<any> => {
    const row: any = await ctx.runQuery((internal as any).captionEditing.getEditJobInternal, { requestId: args.requestId });
    if (!row || row.jobId !== args.jobId || TERMINAL.has(row.status)) return { skipped: true };
    const attempt = Math.max(0, Math.floor(args.attempt ?? 0));
    try {
      const job = await fetchJob(args.jobId); await sync(ctx, job, args.requestId); const status = normalizeStatus(job.status);
      if (ACTIVE.has(status)) {
        if (attempt + 1 >= MAX_POLL_ATTEMPTS) {
          await ctx.runMutation((internal as any).captionEditing.syncEditJobInternal, { requestId: args.requestId, jobId: args.jobId, status: "errored", pollingTimedOut: true, errorMessage: "Mux has not confirmed the final caption status. Check the job status again before retrying." });
          return { ok: false, timedOut: true };
        }
        await ctx.scheduler.runAfter(POLL_MS, (internal as any).captionEditingNode.pollCaptionEditJobStatusInternal, { ...args, attempt: attempt + 1 });
      }
      return { ok: true, status };
    } catch (error) {
      if (attempt + 1 < MAX_POLL_ATTEMPTS) {
        await ctx.scheduler.runAfter(POLL_MS, (internal as any).captionEditingNode.pollCaptionEditJobStatusInternal, { ...args, attempt: attempt + 1 });
        return { ok: false, retryScheduled: true };
      }
      await ctx.runMutation((internal as any).captionEditing.syncEditJobInternal, { requestId: args.requestId, jobId: args.jobId, status: "errored", pollingTimedOut: true, errorMessage: "Mux has not confirmed the final caption status. Check the job status again before retrying." });
      return { ok: false };
    }
  },
});

export const retryCaptionJobStatusForAsset = action({
  args: { muxAssetId: v.string() },
  handler: async (ctx, args): Promise<any> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("You must be signed in to check caption status.");
    const muxAssetId = args.muxAssetId.trim();
    const video: any = await ctx.runQuery(
      components.mux.videos.getVideoByMuxAssetId,
      { muxAssetId, userId },
    );
    const metadata = metadataRecord(video?.metadata);
    const owner =
      stringValue(metadata.userId) ??
      parsePassthroughUserId(record(video?.asset).passthrough);
    if (!video?.asset || owner !== userId) throw new Error("Video not found.");
    const rows: any[] = await ctx.runQuery(
      (internal as any).captionEditing.listEditJobsInternal,
      { muxAssetId },
    );
    const timedOut = rows.find(
      (row) => row.userId === userId && row.jobId && row.pollingTimedOutAtMs,
    );
    const manualUpload = rows.find((row) => row.userId === userId && row.operation === "manual" && row.submissionUncertainAtMs &&
      ["uploading", "waiting_track", "upload_requested", "censor_requested"].includes(row.pipelineStage));
    if (manualUpload) return ctx.runMutation((internal as any).captionEditing.restartManualUploadCheckInternal, { requestId: manualUpload._id, userId });
    if (!timedOut) return { restarted: false };
    const result: any = await ctx.runMutation(
      (internal as any).captionEditing.restartTimedOutPollingInternal,
      { requestId: timedOut._id },
    );
    if (result.restarted) {
      await ctx.scheduler.runAfter(
        0,
        (internal as any).captionEditingNode.pollCaptionEditJobStatusInternal,
        { requestId: timedOut._id, jobId: result.jobId, attempt: 0 },
      );
    }
    return result;
  },
});

export const retryCaptionReconciliationForAsset = action({
  args: { muxAssetId: v.string() },
  handler: async (ctx, args): Promise<any> => {
    if (!enabled()) throw new Error("Caption cleanup is temporarily unavailable.");
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("You must be signed in to refresh captions.");
    const muxAssetId = args.muxAssetId.trim();
    const video: any = await ctx.runQuery(
      components.mux.videos.getVideoByMuxAssetId,
      { muxAssetId, userId },
    );
    const metadata = metadataRecord(video?.metadata);
    const owner =
      stringValue(metadata.userId) ??
      parsePassthroughUserId(record(video?.asset).passthrough);
    if (!video?.asset || owner !== userId) throw new Error("Video not found.");
    const rows: any[] = await ctx.runQuery(
      (internal as any).captionEditing.listEditJobsInternal,
      { muxAssetId },
    );
    const repairable = rows.find(
      (row) =>
        row.userId === userId &&
        row.status === "completed" &&
        row.uploadedTrackId &&
        row.reconciliationStatus !== "completed",
    );
    if (!repairable) return { scheduled: false, reason: "nothing_to_repair" };
    const result: any = await ctx.runMutation(
      (internal as any).captionEditing.requestReconciliationRepairInternal,
      { requestId: repairable._id },
    );
    if (result.scheduled) {
      await ctx.scheduler.runAfter(
        0,
        (internal as any).captionEditingNode.reconcileCompletedCaptionEditInternal,
        { requestId: repairable._id, trackAttempt: 0, refreshAttempt: 0 },
      );
    }
    return result;
  },
});

export const reconcileCompletedCaptionEditInternal = internalAction({
  args: {
    requestId: v.id("captionEditingJobs"),
    trackAttempt: v.optional(v.number()),
    refreshAttempt: v.optional(v.number()),
    dependentAttempt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<any> => {
    const claim: any = await ctx.runMutation((internal as any).captionEditing.claimReconciliationInternal, { requestId: args.requestId });
    if (!claim.acquired) return { skipped: true, reason: claim.reason };
    const row = claim.row;
    const trackAttempt = Math.max(0, Math.floor(args.trackAttempt ?? 0));
    const refreshAttempt = Math.max(0, Math.floor(args.refreshAttempt ?? 0));
    const dependentAttempt = Math.max(0, Math.floor(args.dependentAttempt ?? 0));
    if (!row.uploadedTrackId) {
      await ctx.runMutation((internal as any).captionEditing.finishReconciliationInternal, { requestId: args.requestId, status: "errored", errorMessage: "Mux completed without an uploaded caption track." }); return { ok: false };
    }
    try {
      const cachedBefore: any = await ctx.runQuery(
        (internal as any).muxAssetCache.getByMuxAssetIdInternal,
        { muxAssetId: row.muxAssetId },
      );
      if (cachedBefore?.isDeleted) throw new CaptionAssetDeletedError();
      const asset: any = await muxClient().video.assets.retrieve(row.muxAssetId);
      const uploaded = (asset.tracks ?? []).find((track: any) => track.id === row.uploadedTrackId);
      if (!uploaded || uploaded.status !== "ready") {
        if (trackAttempt + 1 >= MAX_TRACK_WAIT_ATTEMPTS) throw new Error("Edited caption track did not become ready.");
        await ctx.runMutation((internal as any).captionEditing.finishReconciliationInternal, { requestId: args.requestId, status: "waiting" });
        await ctx.scheduler.runAfter(TRACK_WAIT_MS, (internal as any).captionEditingNode.reconcileCompletedCaptionEditInternal, {
          requestId: args.requestId,
          trackAttempt: trackAttempt + 1,
          refreshAttempt,
          dependentAttempt,
        });
        return { ok: false, retryScheduled: true };
      }

      if (row.operation === "manual") {
        const currentVideo: any = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId,
          { muxAssetId: row.muxAssetId, userId: row.userId });
        const currentMetadata = metadataRecord(currentVideo?.metadata);
        const owner = stringValue(currentMetadata.userId) ?? parsePassthroughUserId(record(currentVideo?.asset).passthrough);
        if (!currentVideo?.asset || owner !== row.userId) throw new CaptionAssetDeletedError();
        const currentCustom = record(currentMetadata.custom);
        const currentRevision = numberValue(currentCustom.aiCaptionsRevision) ?? 0;
        const currentSource = stringValue(currentCustom.aiCaptionsTrackId);
        if (currentRevision > row.revision || (currentSource && currentSource !== row.sourceTrackId && currentSource !== row.uploadedTrackId))
          throw new CaptionDependentRefreshError("The caption source changed. Review is required before replacing it.");
        await deleteReplacedSource(row, asset, (assetId, trackId) => muxClient().video.assets.deleteTrack(assetId, trackId));
      }

      // Direct Robots calls do not pass through a video.asset webhook before
      // this action necessarily runs. Refresh both asset stores so queries and
      // players can see the replacement track as soon as its Mux status is ready.
      const cachedImmediatelyBeforeWrite: any = await ctx.runQuery(
        (internal as any).muxAssetCache.getByMuxAssetIdInternal,
        { muxAssetId: row.muxAssetId },
      );
      if (cachedImmediatelyBeforeWrite?.isDeleted)
        throw new CaptionAssetDeletedError();
      // Register a compensating tombstone check before the cross-component
      // write. It still runs if this action is interrupted after writing the
      // component asset but before the immediate cache/tombstone check below.
      await ctx.scheduler.runAfter(
        30_000,
        (internal as any).captionEditingNode.enforceDeletedAssetTombstoneInternal,
        { muxAssetId: row.muxAssetId },
      );
      await ctx.runMutation(components.mux.sync.upsertAssetFromPayloadPublic, {
        asset: asset as Record<string, unknown>,
      });
      const cacheResult: any = await ctx.runMutation((internal as any).muxAssetCache.upsertFromPayloadInternal, {
        asset,
      });
      if (cacheResult?.reason === "deleted_tombstone") {
        await ctx.runMutation(
          (components as any).mux.videos.deleteVideoByMuxAssetIdPublic,
          { muxAssetId: row.muxAssetId },
        );
        throw new CaptionAssetDeletedError();
      }

      const video: any = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, { muxAssetId: row.muxAssetId, userId: row.userId });
      if (!video?.asset) throw new Error("Video was deleted before caption reconciliation.");
      const metadata = metadataRecord(video.metadata); const custom = record(metadata.custom);
      const currentRevision = numberValue(custom.aiCaptionsRevision) ?? 0;
      if (currentRevision > row.revision) {
        await ctx.runMutation((internal as any).captionEditing.finishReconciliationInternal, {
          requestId: args.requestId,
          status: "completed",
        });
        return { ok: true, skipped: true, reason: "superseded_revision" };
      }

      const sourceMetadataCurrent =
        currentRevision === row.revision &&
        stringValue(custom.aiCaptionsTrackId) === row.uploadedTrackId;
      if (row.sourceAppliedAtMs && !sourceMetadataCurrent) {
        throw new CaptionDependentRefreshError(
          "Caption revision metadata changed while related features were refreshing. Repair is required.",
        );
      }

      if (!row.sourceAppliedAtMs) {
        if (!sourceMetadataCurrent) {
          await upsertVideoMetadataAndSyncFeedReadModel(ctx, { muxAssetId: row.muxAssetId, userId: row.userId, custom: {
            ...custom, aiCaptionsTrackId: row.uploadedTrackId, aiCaptionsRevision: row.revision,
            aiCaptionsEditedAtMs: Date.now(), aiCaptionsEditJobId: row.jobId,
            aiCaptionsReplacementCount: row.totalReplacementCount ?? 0, aiCaptionsUnavailableReason: null,
            captionTranslationsStaleAtMs: Date.now(), embeddingsGeneratedAtMs: undefined,
            aiGeneratedAtMs: undefined, aiSummaryJobId: undefined, aiSummaryJobStatus: undefined,
            aiChaptersGeneratedAtMs: undefined, aiChaptersJobId: undefined,
            aiChaptersJobStatus: undefined, aiChaptersUnavailableReason: undefined,
            aiKeyMomentsGeneratedAtMs: undefined,
            aiKeyMomentsJobId: undefined, aiKeyMomentsJobStatus: undefined,
            aiKeyMomentsUnavailableReason: undefined, aiMetadataFailedAtMs: undefined,
            aiMetadataLastError: undefined, aiMetadataRetryScheduled: undefined,
            embeddingsAttemptCount: undefined,
          }});
        }
        await ctx.runMutation((internal as any).captionEditing.markReconciliationStageInternal, {
          requestId: args.requestId,
          stage: "source_applied",
        });
      }

      if (!row.dependentsInvalidatedAtMs) {
        const translationRows: any[] = await ctx.runQuery((internal as any).captionTranslations.getTranslationRowsInternal, { muxAssetId: row.muxAssetId });
        for (const translation of translationRows) {
          if (!translation.uploadedTrackId || translation.uploadedTrackId === row.uploadedTrackId) continue;
          try { await muxClient().video.assets.deleteTrack(row.muxAssetId, translation.uploadedTrackId); }
          catch (error) { if (httpStatus(error) !== 404) throw error; }
        }
        await ctx.runMutation((internal as any).captionEditing.markCaptionDependentsStaleInternal, { muxAssetId: row.muxAssetId, sourceLanguageCode: row.sourceLanguageCode });
        await ctx.runMutation((internal as any).captionEditing.markReconciliationStageInternal, {
          requestId: args.requestId,
          stage: "dependents_invalidated",
        });
      }

      if (!row.regenerationScheduledAtMs) {
        const codes = await ctx.runQuery((internal as any).captionTranslations.getRequestedLanguageCodesInternal, { muxAssetId: row.muxAssetId });
        if (codes.length > 0) {
          await ctx.runAction((internal as any).captionTranslationsNode.ensureCaptionTranslationsForAssetInternal, { muxAssetId: row.muxAssetId, userId: row.userId, languageCodes: codes, attempt: 0, forceConvexOwnership: true });
        }
        await ctx.runAction((internal as any).aiMetadata.generateSummaryAndTagsForAssetInternal, { muxAssetId: row.muxAssetId, userId: row.userId, attempt: 0, forceConvexOwnership: true });
        await ctx.runMutation((internal as any).captionEditing.markReconciliationStageInternal, {
          requestId: args.requestId,
          stage: "regeneration_scheduled",
        });
      }

      const refreshedVideo: any = await ctx.runQuery(
        components.mux.videos.getVideoByMuxAssetId,
        { muxAssetId: row.muxAssetId, userId: row.userId },
      );
      if (!refreshedVideo?.asset) throw new CaptionAssetDeletedError();
      const refreshedCustom = record(metadataRecord(refreshedVideo.metadata).custom);
      const refreshedTranslations: any[] = await ctx.runQuery(
        (internal as any).captionTranslations.getTranslationRowsInternal,
        { muxAssetId: row.muxAssetId },
      );
      const dependentTranslations = refreshedTranslations.filter(
        (translation) => translation.languageCode !== row.sourceLanguageCode,
      );
      const captionEditedAtMs = numberValue(refreshedCustom.aiCaptionsEditedAtMs);
      const failedTranslation = dependentTranslations.some(
        (translation) =>
          isFailedDependentStatus(translation.status) ||
          (translation.status === "completed" &&
            (typeof translation.uploadedTrackId !== "string" ||
              translation.uploadedTrackId.length === 0)),
      );
      const translationsReady = dependentTranslations.every(
        (translation) =>
          translation.status === "completed" &&
          typeof translation.uploadedTrackId === "string" &&
          translation.uploadedTrackId.length > 0 &&
          captionEditedAtMs !== undefined &&
          numberValue(translation.updatedAtMs) !== undefined &&
          translation.updatedAtMs >= captionEditedAtMs,
      );
      const aiStatuses = [
        refreshedCustom.aiSummaryJobStatus,
        refreshedCustom.aiChaptersJobStatus,
        refreshedCustom.aiKeyMomentsJobStatus,
      ];
      const requiresAiMetadata =
        numberValue(refreshedCustom.moderationCheckedAtMs) !== undefined &&
        refreshedCustom.moderationPassed === true;
      const aiReady =
        !requiresAiMetadata ||
        (captionEditedAtMs !== undefined &&
          (numberValue(refreshedCustom.aiGeneratedAtMs) ?? 0) >= captionEditedAtMs &&
          (numberValue(refreshedCustom.aiChaptersGeneratedAtMs) ?? 0) >= captionEditedAtMs &&
          (numberValue(refreshedCustom.aiKeyMomentsGeneratedAtMs) ?? 0) >= captionEditedAtMs);
      const aiTerminalFailure =
        requiresAiMetadata &&
        refreshedCustom.aiMetadataRetryScheduled !== true &&
        aiStatuses.some(isFailedDependentStatus) &&
        !aiStatuses.some(isActiveDependentStatus);
      const embeddingsReady =
        !requiresAiMetadata ||
        (captionEditedAtMs !== undefined &&
          (numberValue(refreshedCustom.embeddingsGeneratedAtMs) ?? 0) >= captionEditedAtMs);

      if (failedTranslation || aiTerminalFailure) {
        throw new CaptionDependentRefreshError(
          "A dependent caption workflow needs repair before refresh can finish.",
        );
      }
      if (!translationsReady || !aiReady || !embeddingsReady) {
        if (dependentAttempt + 1 >= MAX_DEPENDENT_WAIT_ATTEMPTS) {
          throw new CaptionDependentRefreshError(
            "Dependent caption data did not finish refreshing in time.",
          );
        }
        await ctx.runMutation((internal as any).captionEditing.finishReconciliationInternal, {
          requestId: args.requestId,
          status: "waiting",
        });
        await ctx.scheduler.runAfter(
          DEPENDENT_WAIT_MS,
          (internal as any).captionEditingNode.reconcileCompletedCaptionEditInternal,
          {
            requestId: args.requestId,
            trackAttempt,
            refreshAttempt,
            dependentAttempt: dependentAttempt + 1,
          },
        );
        return { ok: false, waitingForDependents: true, retryScheduled: true };
      }

      if (!row.dependentsReadyAtMs) {
        await ctx.runMutation((internal as any).captionEditing.markReconciliationStageInternal, {
          requestId: args.requestId,
          stage: "dependents_ready",
        });
      }
      await ctx.runMutation((internal as any).captionEditing.finishReconciliationInternal, { requestId: args.requestId, status: "completed" });
      console.log("[captionEditing] reconciliation completed", JSON.stringify({
        muxAssetId: row.muxAssetId,
        requestId: String(args.requestId),
        jobId: row.jobId,
        revision: row.revision,
      }));
      return { ok: true };
    } catch (error) {
      const assetDeleted = error instanceof CaptionAssetDeletedError;
      const dependentRefreshFailed = error instanceof CaptionDependentRefreshError;
      const message = assetDeleted
        ? "The video was deleted before caption refresh completed."
        : dependentRefreshFailed
          ? error.message
        : safeError(error, "The edited track is ready, but dependent caption data could not be refreshed.");
      const trackWaitExpired =
        error instanceof Error && /did not become ready/i.test(error.message);
      const retryScheduled =
        !assetDeleted &&
        !dependentRefreshFailed &&
        !trackWaitExpired &&
        refreshAttempt + 1 < MAX_RECONCILIATION_RETRIES;
      await ctx.runMutation((internal as any).captionEditing.finishReconciliationInternal, {
        requestId: args.requestId,
        status: retryScheduled ? "waiting" : "errored",
        errorMessage: message,
      });
      console.log("[captionEditing] reconciliation failed", JSON.stringify({
        muxAssetId: row.muxAssetId,
        requestId: String(args.requestId),
        jobId: row.jobId,
        retryScheduled,
        refreshAttempt,
      }));
      if (retryScheduled) {
        await ctx.scheduler.runAfter(
          RECONCILIATION_RETRY_MS,
          (internal as any).captionEditingNode.reconcileCompletedCaptionEditInternal,
          {
            requestId: args.requestId,
            trackAttempt,
            refreshAttempt: refreshAttempt + 1,
            dependentAttempt,
          },
        );
      }
      return { ok: false, error: message, retryScheduled };
    }
  },
});
