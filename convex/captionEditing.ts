import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";

import { components, internal } from "./_generated/api";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { parsePassthroughUserId } from "./feedContracts";
import { acceptsCensorEvent, blocksCaptionEditing, canRecoverCaptionCensor } from "./captionEditingWorkflow";

export const captionEditingStatus = v.union(
  v.literal("requested"),
  v.literal("pending"),
  v.literal("processing"),
  v.literal("completed"),
  v.literal("errored"),
  v.literal("cancelled"),
);

const TERMINAL = new Set(["completed", "errored", "cancelled"]);
const ACTIVE = new Set(["requested", "pending", "processing"]);
const ACTIVE_RANK: Record<string, number> = { requested: 0, pending: 1, processing: 2 };
const RECONCILIATION_LEASE_MS = 2 * 60 * 1000;
const REQUEST_RESERVATION_TIMEOUT_MS = 30 * 60 * 1000;

function isBlockingEdit(row: any) {
  return blocksCaptionEditing(row);
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function metadataRecord(value: unknown) {
  return Array.isArray(value) ? record(value[0]) : record(value);
}

function enabled() {
  return process.env.CAPTION_EDITING_ENABLED !== "false";
}

function publicJob(row: any) {
  if (!row) return undefined;
  return {
    status: row.status,
    operation: row.operation,
    pipelineStage: row.pipelineStage,
    canRecoverCensoring: enabled() && canRecoverCaptionCensor(row),
    canCheckUploadStatus: Boolean(enabled() && row.operation === "manual" && row.submissionUncertainAtMs && ["uploading", "waiting_track", "upload_requested", "censor_requested"].includes(row.pipelineStage)),
    jobId: row.jobId,
    uploadedTrackId: row.uploadedTrackId,
    totalReplacementCount: row.totalReplacementCount,
    errorMessage: row.errorMessage,
    submissionUncertain: Boolean(row.submissionUncertainAtMs),
    pollingTimedOut: Boolean(row.pollingTimedOutAtMs),
    reconciliationStatus: row.reconciliationStatus,
    reconciliationError: row.reconciliationError,
    revision: row.revision,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

export const getOwnCaptionEditorState = query({
  args: { muxAssetId: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { canEdit: false, unavailableReason: "signed_out" as const };

    const video: any = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
      muxAssetId: args.muxAssetId,
      userId,
    });
    if (!video?.asset) return { canEdit: false, unavailableReason: "not_owner" as const };
    const metadata = metadataRecord(video.metadata);
    const asset = record(video.asset);
    const owner =
      (typeof metadata.userId === "string" ? metadata.userId : undefined) ??
      parsePassthroughUserId(asset.passthrough);
    if (owner !== userId) return { canEdit: false, unavailableReason: "not_owner" as const };

    const rows = await (ctx.db as any)
      .query("captionEditingJobs")
      .withIndex("by_asset_created", (q: any) => q.eq("muxAssetId", args.muxAssetId))
      .order("desc")
      .take(1);
    const latest = rows[0];
    const custom = record(metadata.custom);
    const tracks = Array.isArray(asset.tracks) ? asset.tracks.map(record) : [];
    const preferredId =
      typeof custom.aiCaptionsTrackId === "string" ? custom.aiCaptionsTrackId : undefined;
    const readyTextTracks = tracks.filter(
      (track) => track.type === "text" && track.status === "ready" && typeof track.id === "string",
    );
    const translationRows = await (ctx.db as any)
      .query("captionTranslationJobs")
      .withIndex("by_asset", (q: any) => q.eq("muxAssetId", args.muxAssetId))
      .collect();
    const translationsActive = translationRows.some(
      (row: any) =>
        row.status === "requested" ||
        row.status === "pending" ||
        row.status === "processing",
    );
    const source =
      readyTextTracks.find((track) => track.id === preferredId) ??
      readyTextTracks.find((track) => track.id === latest?.uploadedTrackId) ??
      (latest?.reconciliationStatus === "completed" && latest.uploadedTrackId
        ? {
            id: latest.uploadedTrackId,
            language_code: latest.sourceLanguageCode,
            name: "reviewed",
            status: "ready",
          }
        : readyTextTracks[0]);
    const isEnabled = enabled();
    const active = latest && ACTIVE.has(latest.status);
    const reconciliationIncomplete =
      latest?.status === "completed" && latest.reconciliationStatus !== "completed";
    let unavailableReason: string | undefined;
    if (!isEnabled) unavailableReason = "Caption cleanup is temporarily unavailable.";
    else if (asset.status !== "ready") unavailableReason = "The video is still preparing.";
    else if (!source) unavailableReason = "No ready caption track is available.";
    else if (translationsActive)
      unavailableReason = "Caption translations are still processing. Try cleanup after they finish.";
    else if (latest?.submissionUncertainAtMs)
      unavailableReason = "Mux has not confirmed whether caption cleanup started. An operator must review this request before retrying.";
    else if (latest?.pollingTimedOutAtMs)
      unavailableReason = "Mux has not confirmed the final caption status. Check the job status again before retrying.";
    else if (active) unavailableReason = "Caption edits are already being applied.";
    else if (canRecoverCaptionCensor(latest)) unavailableReason = "Censoring failed. Your original and manually edited captions are retained. Retry censoring or finish without censoring.";
    else if (reconciliationIncomplete)
      unavailableReason =
        latest.reconciliationStatus === "errored"
          ? "The edited captions are ready, but related video features need to be refreshed."
          : "The edited captions are ready and related video features are refreshing.";

    return {
      enabled: isEnabled,
      canEdit: unavailableReason === undefined,
      unavailableReason,
      sourceTrack: source
        ? {
            id: source.id,
            languageCode: source.language_code ?? source.languageCode ?? source.language,
            name: source.name,
            status: source.status,
          }
        : undefined,
      latestJob: publicJob(latest),
      captionRevision:
        typeof custom.aiCaptionsRevision === "number" ? custom.aiCaptionsRevision : 0,
    };
  },
});

export const createRequestedEditInternal = internalMutation({
  args: {
    muxAssetId: v.string(),
    userId: v.string(),
    sourceTrackId: v.string(),
    sourceLanguageCode: v.optional(v.string()),
    revision: v.number(),
    operation: v.optional(v.union(v.literal("manual"), v.literal("robots"))),
    autoCensorProfanity: v.optional(v.boolean()),
    sourceTrackName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const translations = await (ctx.db as any)
      .query("captionTranslationJobs")
      .withIndex("by_asset", (q: any) => q.eq("muxAssetId", args.muxAssetId))
      .collect();
    if (
      translations.some(
        (row: any) =>
          row.status === "requested" ||
          row.status === "pending" ||
          row.status === "processing",
      )
    ) return { created: false, reason: "translations_active" as const };
    const rows = await (ctx.db as any)
      .query("captionEditingJobs")
      .withIndex("by_asset_created", (q: any) => q.eq("muxAssetId", args.muxAssetId))
      .order("desc")
      .collect();
    const active = rows.find(isBlockingEdit);
    if (active) return { created: false, row: active };
    // Reservations serialize against earlier completions, including a caller
    // that downloaded an old document before the previous edit finished.
    if (rows.some((row: any) => row.status === "completed" && row.revision >= args.revision))
      return { created: false, reason: "stale_revision" as const };
    const now = Date.now();
    const id = await (ctx.db as any).insert("captionEditingJobs", {
      ...args,
      status: "requested",
      ...(args.operation === "manual" ? { pipelineStage: "staging", censorAttempt: 1, pipelineUpdatedAtMs: now } : {}),
      createdAtMs: now,
      updatedAtMs: now,
    });
    await ctx.scheduler.runAfter(
      args.operation === "manual" ? 120_000 : REQUEST_RESERVATION_TIMEOUT_MS,
      args.operation === "manual" ? (internal as any).captionEditingNode.advanceManualCaptionEditInternal : (internal as any).captionEditing.expireUnattachedEditInternal,
      { requestId: id },
    );
    return { created: true, row: await (ctx.db as any).get(id) };
  },
});

export const markSubmissionUncertainInternal = internalMutation({
  args: { requestId: v.id("captionEditingJobs"), errorMessage: v.string() },
  handler: async (ctx, args) => {
    const row: any = await ctx.db.get(args.requestId);
    if (!row || row.jobId || row.status !== "requested") return { ok: false };
    await ctx.db.patch(args.requestId, {
      submissionUncertainAtMs: Date.now(),
      errorMessage: args.errorMessage,
      updatedAtMs: Date.now(),
    });
    return { ok: true };
  },
});

export const expireUnattachedEditInternal = internalMutation({
  args: { requestId: v.id("captionEditingJobs") },
  handler: async (ctx, args) => {
    const row: any = await ctx.db.get(args.requestId);
    if (!row || row.jobId || row.status !== "requested") return { expired: false };
    if (row.operation === "manual") return { expired: false };
    const now = Date.now();
    await ctx.db.patch(args.requestId, {
      status: "errored",
      submissionUncertainAtMs: row.submissionUncertainAtMs ?? now,
      errorMessage: "Mux did not confirm whether caption cleanup started. An operator must review this request before retrying.",
      completedAtMs: now,
      updatedAtMs: now,
    });
    return { expired: true };
  },
});

export const releaseUnattachedEditInternal = internalMutation({
  args: { requestId: v.id("captionEditingJobs") },
  handler: async (ctx, args) => {
    const row: any = await ctx.db.get(args.requestId);
    if (!row || row.jobId || !row.submissionUncertainAtMs)
      return { released: false };
    await ctx.db.patch(args.requestId, {
      status: "errored",
      submissionUncertainAtMs: undefined,
      ...(row.operation === "manual" ? { pipelineStage: row.pipelineStage === "censor_submitting" ? "censor_failed" : "failed" } : {}),
      errorMessage: "Mux did not start this caption cleanup request.",
      completedAtMs: row.completedAtMs ?? Date.now(),
      updatedAtMs: Date.now(),
    });
    if (row.operation === "manual" && row.temporaryStorageId) {
      await ctx.storage.delete(row.temporaryStorageId);
      await ctx.db.patch(row._id, { temporaryStorageId: undefined });
    }
    return { released: true };
  },
});

export const restartTimedOutPollingInternal = internalMutation({
  args: { requestId: v.id("captionEditingJobs") },
  handler: async (ctx, args) => {
    const row: any = await ctx.db.get(args.requestId);
    if (!row || !row.jobId || !row.pollingTimedOutAtMs)
      return { restarted: false };
    await ctx.db.patch(args.requestId, {
      status: "pending",
      pollingTimedOutAtMs: undefined,
      errorMessage: undefined,
      completedAtMs: undefined,
      updatedAtMs: Date.now(),
    });
    return { restarted: true, jobId: row.jobId };
  },
});

export const attachMuxJobInternal = internalMutation({
  args: {
    requestId: v.id("captionEditingJobs"),
    jobId: v.string(),
    status: captionEditingStatus,
    passthrough: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row: any = await ctx.db.get(args.requestId);
    if (!row) return { ok: false, reason: "missing" };
    if (TERMINAL.has(row.status)) return { ok: false, reason: "terminal" };
    if (row.jobId && row.jobId !== args.jobId) return { ok: false, reason: "already_attached" };
    if (!acceptsCensorEvent(row, args.jobId, args.passthrough)) return { ok: false, reason: "stale_attempt" };
    const patch: Record<string, unknown> = {
      jobId: args.jobId,
      passthrough: args.passthrough,
      submissionUncertainAtMs: undefined,
      updatedAtMs: Date.now(),
    };
    // Keep a terminal create response in local `requested` state until the
    // shared sync mutation applies it and schedules reconciliation exactly once.
    if (!TERMINAL.has(args.status)) patch.status = args.status;
    if (row.operation === "manual") patch.pipelineStage = "censoring";
    await ctx.db.patch(args.requestId, patch);
    await ctx.scheduler.runAfter(15_000, (internal as any).captionEditingNode.pollCaptionEditJobStatusInternal,
      { requestId: args.requestId, jobId: args.jobId, attempt: 0 });
    return { ok: true };
  },
});

/** Compare-and-set transitions also schedule the next step in the same transaction. */
export const transitionManualEditInternal = internalMutation({
  args: {
    requestId: v.id("captionEditingJobs"), expectedStage: v.string(), expectedAttempt: v.number(),
    stage: v.string(), status: captionEditingStatus,
    intermediateTrackId: v.optional(v.string()), storageId: v.optional(v.id("_storage")),
    uploadedTrackId: v.optional(v.string()), errorMessage: v.optional(v.string()),
    clearStorage: v.optional(v.boolean()), uncertain: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.requestId);
    if (!row || row.operation !== "manual" || row.pipelineStage !== args.expectedStage || row.censorAttempt !== args.expectedAttempt) return { changed: false };
    if (args.clearStorage && row.temporaryStorageId) await ctx.storage.delete(row.temporaryStorageId);
    const patch = {
      pipelineStage: args.stage, status: args.status, errorMessage: args.errorMessage,
      pipelineLeaseExpiresAtMs: undefined,
      updatedAtMs: Date.now(), pipelineUpdatedAtMs: Date.now(),
      ...(args.intermediateTrackId ? { intermediateTrackId: args.intermediateTrackId } : {}),
      ...(args.storageId ? { temporaryStorageId: args.storageId } : {}),
      ...(args.clearStorage ? { temporaryStorageId: undefined } : {}),
      ...(args.uploadedTrackId ? { uploadedTrackId: args.uploadedTrackId } : {}),
      submissionUncertainAtMs: args.uncertain ? Date.now() : undefined,
      ...(args.stage === "finalizing" ? { reconciliationStatus: "waiting" as const, completedAtMs: Date.now() } : {}),
    };
    await ctx.db.patch(row._id, patch);
    if (args.stage === "finalizing") {
      await ctx.scheduler.runAfter(0, (internal as any).captionEditingNode.reconcileCompletedCaptionEditInternal, { requestId: row._id });
    } else if (!["failed", "censor_failed", "done"].includes(args.stage) && !args.uncertain) {
      await ctx.scheduler.runAfter(["uploading", "censor_submitting", "staging"].includes(args.stage) ? 120_000 : 0,
        (internal as any).captionEditingNode.advanceManualCaptionEditInternal, { requestId: row._id });
    }
    return { changed: true, row: { ...row, ...patch } };
  },
});

export const claimManualWorkerInternal = internalMutation({
  args: { requestId: v.id("captionEditingJobs") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.requestId);
    if (!row || row.operation !== "manual" || row.submissionUncertainAtMs ||
      ["failed", "done", "finalizing", "censoring", "censor_failed"].includes(row.pipelineStage ?? "") ||
      (row.pipelineLeaseExpiresAtMs ?? 0) > Date.now()) return null;
    await ctx.db.patch(row._id, { pipelineLeaseExpiresAtMs: Date.now() + 90_000 });
    await ctx.scheduler.runAfter(120_000, (internal as any).captionEditingNode.advanceManualCaptionEditInternal, args);
    return row;
  },
});

export const restartManualUploadCheckInternal = internalMutation({
  args: { requestId: v.id("captionEditingJobs"), userId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.requestId);
    if (!enabled() || row?.userId !== args.userId || !publicJob(row)?.canCheckUploadStatus) return { restarted: false };
    await ctx.db.patch(args.requestId, { submissionUncertainAtMs: undefined, status: "processing", errorMessage: undefined,
      pipelineUpdatedAtMs: Date.now(), pipelineLeaseExpiresAtMs: undefined, updatedAtMs: Date.now() });
    await ctx.scheduler.runAfter(0, (internal as any).captionEditingNode.advanceManualCaptionEditInternal, { requestId: args.requestId });
    return { restarted: true };
  },
});

export const recoverCaptionCensorInternal = internalMutation({
  args: { requestId: v.id("captionEditingJobs"), userId: v.string(), useManualTrack: v.boolean() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.requestId);
    if (!enabled() || row?.userId !== args.userId || !canRecoverCaptionCensor(row)) return { restarted: false };
    const patch = args.useManualTrack ? {
      status: "completed" as const, pipelineStage: "finalizing", uploadedTrackId: row!.intermediateTrackId,
      reconciliationStatus: "waiting" as const, autoCensorProfanity: false, completedAtMs: Date.now(),
    } : {
      status: "requested" as const, pipelineStage: "censor_requested", censorAttempt: (row!.censorAttempt ?? 1) + 1,
      jobId: undefined, passthrough: undefined, uploadedTrackId: undefined, completedAtMs: undefined,
    };
    await ctx.db.patch(args.requestId, { ...patch, errorMessage: undefined, updatedAtMs: Date.now(), pipelineUpdatedAtMs: Date.now() });
    await ctx.scheduler.runAfter(0, args.useManualTrack
      ? (internal as any).captionEditingNode.reconcileCompletedCaptionEditInternal
      : (internal as any).captionEditingNode.advanceManualCaptionEditInternal, { requestId: args.requestId });
    return { restarted: true };
  },
});

export const failRequestedEditInternal = internalMutation({
  args: { requestId: v.id("captionEditingJobs"), errorMessage: v.string() },
  handler: async (ctx, args) => {
    const row: any = await ctx.db.get(args.requestId);
    if (!row || row.status !== "requested" || row.jobId) return { ok: false };
    const now = Date.now();
    await ctx.db.patch(args.requestId, {
      status: "errored", errorMessage: args.errorMessage, updatedAtMs: now, completedAtMs: now,
    });
    return { ok: true };
  },
});

export const getEditJobInternal = internalQuery({
  args: { requestId: v.optional(v.id("captionEditingJobs")), jobId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (args.requestId) return await ctx.db.get(args.requestId);
    if (!args.jobId) return null;
    return await (ctx.db as any)
      .query("captionEditingJobs")
      .withIndex("by_job", (q: any) => q.eq("jobId", args.jobId))
      .unique();
  },
});

export const resolveEditJobInternal = internalQuery({
  args: { requestId: v.optional(v.string()), jobId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (args.requestId) {
      const id = ctx.db.normalizeId("captionEditingJobs", args.requestId);
      if (id) {
        const row = await ctx.db.get(id);
        if (row) return row;
      }
    }
    if (!args.jobId) return null;
    return await (ctx.db as any)
      .query("captionEditingJobs")
      .withIndex("by_job", (q: any) => q.eq("jobId", args.jobId))
      .unique();
  },
});

export const listEditJobsInternal = internalQuery({
  args: { muxAssetId: v.string() },
  handler: async (ctx, args) =>
    await (ctx.db as any)
      .query("captionEditingJobs")
      .withIndex("by_asset_created", (q: any) => q.eq("muxAssetId", args.muxAssetId))
      .order("desc")
      .collect(),
});

export const syncEditJobInternal = internalMutation({
  args: {
    requestId: v.optional(v.id("captionEditingJobs")),
    jobId: v.string(),
    muxAssetId: v.optional(v.string()),
    status: captionEditingStatus,
    passthrough: v.optional(v.string()),
    uploadedTrackId: v.optional(v.string()),
    totalReplacementCount: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
    pollingTimedOut: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const row: any = args.requestId
      ? await ctx.db.get(args.requestId)
      : await (ctx.db as any)
          .query("captionEditingJobs")
          .withIndex("by_job", (q: any) => q.eq("jobId", args.jobId))
          .unique();
    if (
      !row ||
      (row.jobId && row.jobId !== args.jobId) ||
      (args.muxAssetId && row.muxAssetId !== args.muxAssetId)
    ) return { ok: false, reason: "missing" };
    if (!acceptsCensorEvent(row, args.jobId, args.passthrough)) return { ok: false, reason: "stale_attempt" };
    const isLateMuxTerminal =
      Boolean(row.pollingTimedOutAtMs) && TERMINAL.has(args.status);
    if (TERMINAL.has(row.status) && (row.jobId || !args.requestId) && !isLateMuxTerminal)
      return { ok: true, changed: false, row };
    if (
      !TERMINAL.has(args.status) &&
      (ACTIVE_RANK[args.status] ?? 0) < (ACTIVE_RANK[row.status] ?? 0)
    ) return { ok: true, changed: false, row };
    const now = Date.now();
    const patch: Record<string, unknown> = {
      jobId: args.jobId,
      status: args.status,
      updatedAtMs: now,
    };
    if (args.passthrough !== undefined) patch.passthrough = args.passthrough;
    if (args.uploadedTrackId !== undefined) patch.uploadedTrackId = args.uploadedTrackId;
    if (args.totalReplacementCount !== undefined)
      patch.totalReplacementCount = args.totalReplacementCount;
    if (args.errorMessage !== undefined) patch.errorMessage = args.errorMessage;
    else if (args.status !== "errored" && row.errorMessage !== undefined)
      patch.errorMessage = undefined;
    if (TERMINAL.has(args.status)) patch.completedAtMs = now;
    if (TERMINAL.has(args.status) && row.submissionUncertainAtMs)
      patch.submissionUncertainAtMs = undefined;
    if (args.pollingTimedOut) patch.pollingTimedOutAtMs = now;
    else if (isLateMuxTerminal) patch.pollingTimedOutAtMs = undefined;
    if (args.status === "completed") patch.reconciliationStatus = "waiting";
    if (row.operation === "manual") {
      patch.pipelineStage = args.status === "completed" ? "finalizing" :
        (args.status === "errored" || args.status === "cancelled") && !args.pollingTimedOut ? "censor_failed" : "censoring";
      if (patch.pipelineStage === "censor_failed") patch.errorMessage = "Censoring failed. Your original and manually edited captions are retained.";
    }
    await ctx.db.patch(row._id, patch);
    if (args.status === "completed" && row.status !== "completed") {
      await ctx.scheduler.runAfter(0, (internal as any).captionEditingNode.reconcileCompletedCaptionEditInternal, { requestId: row._id });
    }
    return {
      ok: true,
      changed: row.status !== args.status,
      shouldReconcile: args.status === "completed" && row.status !== "completed",
      row: { ...row, ...patch },
    };
  },
});

export const claimReconciliationInternal = internalMutation({
  args: { requestId: v.id("captionEditingJobs") },
  handler: async (ctx, args) => {
    const row: any = await ctx.db.get(args.requestId);
    if (!row || row.status !== "completed") return { acquired: false, reason: "not_completed" };
    if (row.reconciliationStatus === "completed") return { acquired: false, reason: "completed" };
    const now = Date.now();
    if (
      row.reconciliationStatus === "processing" &&
      typeof row.reconciliationLeaseExpiresAtMs === "number" &&
      row.reconciliationLeaseExpiresAtMs > now
    ) return { acquired: false, reason: "leased" };
    await ctx.db.patch(args.requestId, {
      reconciliationStatus: "processing",
      reconciliationAttempt: (row.reconciliationAttempt ?? 0) + 1,
      reconciliationLeaseExpiresAtMs: now + RECONCILIATION_LEASE_MS,
      reconciliationError: undefined,
      updatedAtMs: now,
    });
    return { acquired: true, row };
  },
});

export const finishReconciliationInternal = internalMutation({
  args: {
    requestId: v.id("captionEditingJobs"),
    status: v.union(v.literal("waiting"), v.literal("completed"), v.literal("errored")),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.requestId);
    if (!row) return { ok: false };
    await ctx.db.patch(args.requestId, {
      reconciliationStatus: args.status,
      reconciliationError: args.errorMessage,
      reconciliationLeaseExpiresAtMs: undefined,
      ...(row.operation === "manual" && args.status === "completed" ? { pipelineStage: "done" } : {}),
      updatedAtMs: Date.now(),
    });
    return { ok: true };
  },
});

export const markReconciliationStageInternal = internalMutation({
  args: {
    requestId: v.id("captionEditingJobs"),
    stage: v.union(
      v.literal("source_applied"),
      v.literal("dependents_invalidated"),
      v.literal("regeneration_scheduled"),
      v.literal("dependents_ready"),
    ),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.requestId);
    if (!row || row.status !== "completed") return { ok: false };
    const now = Date.now();
    const patch: Record<string, number> = { updatedAtMs: now };
    if (args.stage === "source_applied") patch.sourceAppliedAtMs = now;
    if (args.stage === "dependents_invalidated") patch.dependentsInvalidatedAtMs = now;
    if (args.stage === "regeneration_scheduled") patch.regenerationScheduledAtMs = now;
    if (args.stage === "dependents_ready") patch.dependentsReadyAtMs = now;
    await ctx.db.patch(args.requestId, patch);
    return { ok: true };
  },
});

export const requestReconciliationRepairInternal = internalMutation({
  args: { requestId: v.id("captionEditingJobs") },
  handler: async (ctx, args) => {
    const row: any = await ctx.db.get(args.requestId);
    if (!row || row.status !== "completed" || !row.uploadedTrackId)
      return { scheduled: false, reason: "not_repairable" as const };
    if (row.reconciliationStatus === "completed")
      return { scheduled: false, reason: "already_completed" as const };
    const now = Date.now();
    if (
      row.reconciliationStatus === "processing" &&
      typeof row.reconciliationLeaseExpiresAtMs === "number" &&
      row.reconciliationLeaseExpiresAtMs > now
    ) return { scheduled: false, reason: "already_processing" as const };
    await ctx.db.patch(args.requestId, {
      reconciliationStatus: "waiting",
      reconciliationError: undefined,
      reconciliationLeaseExpiresAtMs: undefined,
      sourceAppliedAtMs: undefined,
      dependentsInvalidatedAtMs: undefined,
      regenerationScheduledAtMs: undefined,
      dependentsReadyAtMs: undefined,
      updatedAtMs: now,
    });
    return { scheduled: true, row };
  },
});

export const getOperationsSummaryInternal = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(500, Math.max(1, Math.floor(args.limit ?? 200)));
    const rows = await (ctx.db as any)
      .query("captionEditingJobs")
      .order("desc")
      .take(limit);
    const now = Date.now();
    return {
      scanned: rows.length,
      active: rows.filter((row: any) => ACTIVE.has(row.status)).length,
      failed: rows.filter(
        (row: any) =>
          row.status === "errored" ||
          row.status === "cancelled" ||
          row.reconciliationStatus === "errored",
      ).length,
      stale: rows.filter(
        (row: any) =>
          isBlockingEdit(row) &&
          typeof row.updatedAtMs === "number" &&
          now - row.updatedAtMs > 30 * 60 * 1000,
      ).length,
      repairable: rows.filter(
        (row: any) =>
          canRecoverCaptionCensor(row) ||
          Boolean(row.submissionUncertainAtMs) ||
          Boolean(row.pollingTimedOutAtMs) ||
          (row.status === "completed" &&
            Boolean(row.uploadedTrackId) &&
            row.reconciliationStatus === "errored"),
      ).length,
    };
  },
});

export const markCaptionDependentsStaleInternal = internalMutation({
  args: { muxAssetId: v.string(), sourceLanguageCode: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const rows = await (ctx.db as any)
      .query("captionTranslationJobs")
      .withIndex("by_asset", (q: any) => q.eq("muxAssetId", args.muxAssetId))
      .collect();
    for (const row of rows) {
      await ctx.db.patch(row._id, {
        status: "requested",
        fromLanguageCode: args.sourceLanguageCode ?? row.fromLanguageCode,
        jobId: undefined,
        uploadedTrackId: undefined,
        temporaryVttUrl: undefined,
        passthrough: undefined,
        errorMessage: undefined,
        // Make the existing translation claim immediately eligible. The
        // normal claim path deliberately cools down freshly-requested rows.
        updatedAtMs: 0,
      });
    }
    const embeddings = await (ctx.db as any)
      .query("videoEmbeddings")
      .withIndex("by_asset", (q: any) => q.eq("muxAssetId", args.muxAssetId))
      .collect();
    for (const row of embeddings) await ctx.db.delete(row._id);
    return { translationCount: rows.length, embeddingCount: embeddings.length };
  },
});
