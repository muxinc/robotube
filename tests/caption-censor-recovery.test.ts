import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { URL } from "node:url";
import { getFunctionName } from "convex/server";
import { Assets } from "@mux/mux-node/resources/video/assets";
import { blocksCaptionEditing, canRecoverCaptionCensor, deleteReplacedSource } from "../convex/captionEditingWorkflow.ts";

const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && context.parentURL?.includes("/convex/")) {
    for (const extension of [".ts", ".js"]) {
      const url = new URL(specifier + extension, context.parentURL);
      if (existsSync(url)) return nextResolve(url.href, context);
    }
  }
  return nextResolve(specifier, context);
} });
const mutations = await import("../convex/captionEditing.ts");
const actions = await import("../convex/captionEditingNode.ts");
const translations = await import("../convex/captionTranslations.ts");
after(() => hooks.deregister());

const originalFetch = globalThis.fetch;
const retrieve = Assets.prototype.retrieve, createTrack = Assets.prototype.createTrack, deleteTrack = Assets.prototype.deleteTrack;
const savedEnv = [process.env.MUX_TOKEN_ID, process.env.MUX_TOKEN_SECRET];
process.env.MUX_TOKEN_ID = "test"; process.env.MUX_TOKEN_SECRET = "test";
after(() => {
  globalThis.fetch = originalFetch;
  Assets.prototype.retrieve = retrieve; Assets.prototype.createTrack = createTrack;
  Assets.prototype.deleteTrack = deleteTrack;
  for (const [i, key] of ["MUX_TOKEN_ID", "MUX_TOKEN_SECRET"].entries()) {
    if (savedEnv[i] === undefined) delete process.env[key]; else process.env[key] = savedEnv[i];
  }
});

function fixture(overrides: Record<string, any> = {}) {
  const row: any = { _id: "edit-1", muxAssetId: "asset-1", userId: "owner", sourceTrackId: "original",
    sourceLanguageCode: "en", revision: 1, operation: "manual", pipelineStage: "waiting_track",
    status: "processing", intermediateTrackId: "manual", temporaryStorageId: "vtt-1", autoCensorProfanity: true,
    censorAttempt: 1, pipelineUpdatedAtMs: Date.now(), ...overrides };
  const state: any = { row, scheduled: [], deletedStorage: [], stored: [], translations: [], createCount: 0, robotsBodies: [], deletedTracks: [], refreshed: [],
    identity: "owner|session", asset: { id: "asset-1", status: "ready", playback_ids: [{ id: "public-1", policy: "public" }],
      tracks: [{ id: "original", type: "text", status: "ready", language_code: "en" }, { id: "manual", type: "text", status: "ready", language_code: "en" }] },
    metadata: { userId: "owner", custom: { aiCaptionsTrackId: "original", aiCaptionsRevision: 0 } } };
  const db: any = {
    async get() { return state.row ? structuredClone(state.row) : null; },
    async patch(id: string, patch: any) { Object.assign(id === state.row?._id ? state.row : state.translations.find((item: any) => item._id === id), patch); },
    async insert(_table: string, value: any) { state.row = { ...value, _id: "edit-1" }; return "edit-1"; },
    query(table: string) { const result = () => table === "captionTranslationJobs" ? structuredClone(state.translations) : table !== "captionEditingJobs" ? [] : state.row ? [structuredClone(state.row)] : [];
      const query: any = { withIndex() { return query; }, order() { return query; }, async collect() { return result(); }, async take() { return result(); } }; return query;
    },
  };
  const ctx: any = { db,
    auth: { async getUserIdentity() { return state.identity ? { subject: state.identity } : null; } },
    storage: { async getUrl() { return "https://storage.example/vtt"; }, async store(blob: Blob) { state.stored.push(await blob.text()); return "vtt-1"; },
      async delete(id: string) { state.deletedStorage.push(id); } },
    scheduler: { async runAfter(delay: number, ref: any, args: any) { state.scheduled.push({ delay, name: getFunctionName(ref), args }); } },
    async runMutation(ref: any, args: any) {
      let name: string;
      try { name = getFunctionName(ref).split(":")[1]; }
      catch {
        if (args.asset) state.asset = structuredClone(args.asset);
        if (args.custom) state.metadata.custom = structuredClone(args.custom);
        return;
      }
      if (name === "upsertFromPayloadInternal" || name === "applyVideoMetadataInternal") return {};
      return (mutations as any)[name]._handler(ctx, args);
    },
    async runAction(ref: any) {
      state.refreshed.push(getFunctionName(ref));
      for (const translation of state.translations) Object.assign(translation, { status: "completed", uploadedTrackId: "new-translation", updatedAtMs: Date.now() });
    },
    async runQuery(ref: any, args: any) {
      let name: string;
      try { name = getFunctionName(ref).split(":")[1]; }
      catch { return { asset: structuredClone(state.asset), metadata: structuredClone(state.metadata) }; }
      if (name === "getByMuxAssetIdInternal") return { isDeleted: false };
      if (name === "getTranslationRowsInternal") return structuredClone(state.translations);
      if (name === "getRequestedLanguageCodesInternal") return state.translations.map((item: any) => item.languageCode);
      return (mutations as any)[name]._handler(ctx, args);
    },
  };
  (Assets.prototype as any).retrieve = async () => structuredClone(state.asset);
  (Assets.prototype as any).deleteTrack = async (_asset: string, id: string) => {
    state.deletedTracks.push(id); state.asset.tracks = state.asset.tracks.filter((track: any) => track.id !== id);
  };
  (Assets.prototype as any).createTrack = async (_asset: string, params: any) => {
    state.createCount++;
    state.asset.tracks.push({ id: "uploaded-manual", type: "text", status: "preparing", passthrough: params.passthrough });
    if (state.uploadThrows) throw new Error("Connection lost after server accepted upload");
    return { id: "uploaded-manual", status: "preparing" };
  };
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url).includes("stream.mux.com")) return new Response("WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello world\n");
    state.robotsBodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ data: { id: `robot-${state.robotsBodies.length}`, status: "pending" } }), { status: state.robotsHttpStatus ?? 200 });
  }) as typeof fetch;
  const run = (name: keyof typeof mutations, args: any) => (mutations[name] as any)._handler(ctx, args);
  const advance = () => (actions.advanceManualCaptionEditInternal as any)._handler(ctx, { requestId: "edit-1" });
  const sync = (status: string, extra: any = {}) => run("syncEditJobInternal", { requestId: "edit-1", jobId: state.row.jobId ?? "robot-1", status, ...extra });
  const recover = (useManualTrack: boolean) => (actions.recoverOwnCaptionCensoring as any)._handler(ctx, { muxAssetId: "asset-1", useManualTrack });
  return { state, ctx, run, advance, sync, recover };
}

test("manual track must be ready before storage cleanup and censor submission", async () => {
  const f = fixture();
  f.state.asset.tracks[1].status = "preparing";
  await f.advance();
  assert.equal(f.state.row.pipelineStage, "waiting_track");
  assert.equal(f.state.deletedStorage.length, 0);
  assert.equal(f.state.robotsBodies.length, 0);
  f.state.asset.tracks[1].status = "ready";
  f.state.row.pipelineLeaseExpiresAtMs = 0;
  await f.advance();
  assert.equal(f.state.row.pipelineStage, "censor_requested");
  assert.deepEqual(f.state.deletedStorage, ["vtt-1"]);
  assert.equal(f.state.row.temporaryStorageId, undefined);
  await f.advance();
  assert.equal(f.state.row.pipelineStage, "censoring");
  assert.equal(f.state.robotsBodies[0].parameters.track_id, "manual");
  assert.equal(f.state.robotsBodies[0].parameters.replace_existing_tracks, "replace");
  assert.ok(f.state.scheduled.some((job: any) => job.name.includes("pollCaptionEdit")));
  assert.ok(f.state.asset.tracks.some((track: any) => track.id === "original"));
});

test("successful censoring selects the final track and schedules reconciliation", async () => {
  const f = fixture({ pipelineStage: "censoring", jobId: "robot-1" });
  await f.sync("completed", { uploadedTrackId: "censored" });
  assert.equal(f.state.row.uploadedTrackId, "censored");
  assert.equal(f.state.row.pipelineStage, "finalizing");
  assert.equal(f.state.row.reconciliationStatus, "waiting");
  assert.equal(f.state.scheduled.filter((job: any) => job.name.includes("reconcileCompleted")).length, 1);
  await f.sync("completed", { uploadedTrackId: "censored" });
  assert.equal(f.state.scheduled.filter((job: any) => job.name.includes("reconcileCompleted")).length, 1);
});

test("confirmed censor failure retains tracks and supports a retry with a new attempt", async () => {
  const f = fixture({ pipelineStage: "censoring", jobId: "robot-1" });
  await f.sync("errored");
  assert.ok(canRecoverCaptionCensor(f.state.row));
  assert.ok(blocksCaptionEditing(f.state.row));
  assert.equal(f.state.asset.tracks.length, 2);
  assert.deepEqual(await f.recover(false), { restarted: true });
  assert.equal(f.state.row.censorAttempt, 2);
  assert.equal(f.state.row.jobId, undefined);
  assert.equal((await f.recover(false)).restarted, false);
  await f.run("syncEditJobInternal", { requestId: "edit-1", jobId: "robot-1", status: "completed", uploadedTrackId: "old-output",
    passthrough: JSON.stringify({ censorAttempt: 1 }) });
  assert.equal(f.state.row.pipelineStage, "censor_requested");
  await f.advance();
  assert.equal(JSON.parse(f.state.robotsBodies[0].passthrough).censorAttempt, 2);
  await f.sync("completed", { uploadedTrackId: "retry-output" });
  assert.equal(f.state.row.uploadedTrackId, "retry-output");
});

test("finish without censoring commits the manual track and ignores delayed Robots completion", async () => {
  const f = fixture({ pipelineStage: "censoring", jobId: "robot-1" });
  await f.sync("cancelled");
  await f.recover(true);
  assert.equal(f.state.row.uploadedTrackId, "manual");
  assert.equal(f.state.row.autoCensorProfanity, false);
  assert.equal(f.state.row.status, "completed");
  await f.sync("completed", { uploadedTrackId: "late-output" });
  assert.equal(f.state.row.uploadedTrackId, "manual");
  assert.equal(f.state.robotsBodies.length, 0);
});

test("timeouts and ambiguous submissions cannot be retried or bypassed until resolved", async () => {
  const f = fixture({ pipelineStage: "censoring", jobId: "robot-1" });
  await f.sync("errored", { pollingTimedOut: true });
  assert.equal(canRecoverCaptionCensor(f.state.row), false);
  assert.equal((await f.recover(true)).restarted, false);
  await f.sync("errored"); // A confirmed late terminal response resolves uncertainty.
  assert.ok(canRecoverCaptionCensor(f.state.row));
  const uncertain = fixture({ pipelineStage: "censor_submitting", status: "requested", submissionUncertainAtMs: Date.now() });
  assert.equal((await uncertain.recover(false)).restarted, false);
  await uncertain.sync("errored", { passthrough: JSON.stringify({ censorAttempt: 1 }) });
  assert.ok(canRecoverCaptionCensor(uncertain.state.row));
});

test("recovery requires the owner, authentication, feature flag and a ready manual track", async () => {
  const f = fixture({ pipelineStage: "censor_failed", status: "errored" });
  f.state.identity = null;
  await assert.rejects(f.recover(false), /signed in/);
  f.state.identity = "stranger|session";
  assert.equal((await f.recover(false)).restarted, false);
  f.state.identity = "owner|session"; f.state.metadata.userId = "different-owner";
  await assert.rejects(f.recover(true), /not found/);
  f.state.metadata.userId = "owner"; f.state.asset.tracks[1].status = "preparing";
  await assert.rejects(f.recover(true), /ready caption track/);
  const flag = process.env.CAPTION_EDITING_ENABLED;
  try { process.env.CAPTION_EDITING_ENABLED = "false"; await assert.rejects(f.recover(false), /unavailable/); }
  finally { if (flag === undefined) delete process.env.CAPTION_EDITING_ENABLED; else process.env.CAPTION_EDITING_ENABLED = flag; }
});

test("manual-only upload skips Robots but still waits for readiness", async () => {
  const f = fixture({ autoCensorProfanity: false });
  await f.advance();
  assert.equal(f.state.row.status, "completed");
  assert.equal(f.state.row.uploadedTrackId, "manual");
  assert.equal(f.state.robotsBodies.length, 0);
  assert.deepEqual(f.state.deletedStorage, ["vtt-1"]);
});

test("interrupted upload is rediscovered by passthrough without duplicate uploads", async () => {
  const f = fixture({ pipelineStage: "upload_requested", intermediateTrackId: undefined });
  f.state.uploadThrows = true;
  await f.advance();
  assert.equal(f.state.row.pipelineStage, "uploading");
  assert.equal(f.state.deletedStorage.length, 0);
  await f.advance();
  assert.equal(f.state.row.intermediateTrackId, "uploaded-manual");
  assert.equal(f.state.row.pipelineStage, "waiting_track");
  assert.equal(f.state.createCount, 1);
});

test("terminal ingestion failure cleans temporary storage and retains the original", async () => {
  const f = fixture(); f.state.asset.tracks[1].status = "errored";
  await f.advance();
  assert.equal(f.state.row.status, "errored");
  assert.deepEqual(f.state.deletedStorage, ["vtt-1"]);
  assert.equal(f.state.asset.tracks[0].id, "original");
});

test("censor submission rejection exposes recovery; a 5xx remains uncertain", async () => {
  const f = fixture({ pipelineStage: "censor_requested", temporaryStorageId: undefined });
  f.state.robotsHttpStatus = 429;
  await f.advance();
  assert.ok(canRecoverCaptionCensor(f.state.row));
  const ambiguous = fixture({ pipelineStage: "censor_requested", temporaryStorageId: undefined });
  ambiguous.state.robotsHttpStatus = 503;
  await ambiguous.advance();
  assert.equal(ambiguous.state.row.pipelineStage, "censor_submitting");
  ambiguous.state.row.pipelineUpdatedAtMs = Date.now() - 121_000;
  await ambiguous.advance();
  assert.ok(ambiguous.state.row.submissionUncertainAtMs);
  assert.equal(canRecoverCaptionCensor(ambiguous.state.row), false);
});

test("source deletion requires ready final track; retrying a completed deletion tolerates 404", async () => {
  const f = fixture({ uploadedTrackId: "manual" }); const deleted: string[] = [];
  f.state.asset.tracks[1].status = "preparing";
  await assert.rejects(deleteReplacedSource(f.state.row, f.state.asset, async (_asset, id) => deleted.push(id)), /not ready/);
  assert.equal(deleted.length, 0);
  f.state.asset.tracks[1].status = "ready";
  await deleteReplacedSource(f.state.row, f.state.asset, async (_asset, id) => deleted.push(id));
  assert.deepEqual(deleted, ["original"]);
  assert.deepEqual(f.state.asset.tracks.map((track: any) => track.id), ["manual"]);
  await deleteReplacedSource(f.state.row, f.state.asset, async () => { throw { status: 404 }; });
});

test("reservations reject active translations, concurrent recovery, and stale completed revisions", async () => {
  const f = fixture({ pipelineStage: "censor_failed", status: "errored" });
  const args = { muxAssetId: "asset-1", userId: "owner", sourceTrackId: "original", revision: 1, operation: "manual" };
  assert.equal((await f.run("createRequestedEditInternal", args)).created, false);
  f.state.translations = [{ status: "processing" }];
  assert.equal((await f.run("createRequestedEditInternal", args)).reason, "translations_active");
  f.state.translations = []; f.state.row.status = "completed"; f.state.row.reconciliationStatus = "completed";
  assert.equal((await f.run("createRequestedEditInternal", args)).reason, "stale_revision");
});

test("translation requests cannot start during recovery", async () => {
  const f = fixture({ pipelineStage: "censor_failed", status: "errored" });
  const result = await (translations.claimRequestedTranslationsInternal as any)._handler(f.ctx,
    { muxAssetId: "asset-1", userId: "owner", fromLanguageCode: "en", languageCodes: ["es"] });
  assert.deepEqual(result, [{ languageCode: "es", shouldCreate: false }]);
});

test("save rejects stale revision, wrong source, and stale cue before storing/uploading", async () => {
  const f = fixture();
  const save = (patch: any) => (actions.replaceOwnCaptionTrack as any)._handler(f.ctx,
    { muxAssetId: "asset-1", trackId: "original", captionRevision: 0, edits: [], ...patch });
  await assert.rejects(save({ captionRevision: 5 }), /stale/);
  await assert.rejects(save({ trackId: "manual" }), /stale/);
  await assert.rejects(save({ edits: [{ id: "obsolete", text: "changed" }] }), /stale/);
  assert.equal(f.state.stored.length, 0); assert.equal(f.state.createCount, 0);
});

test("reconciliation waits for readiness then deletes source, advances revision and refreshes dependents", async () => {
  const f = fixture({ status: "completed", pipelineStage: "finalizing", uploadedTrackId: "manual", reconciliationStatus: "waiting" });
  const reconcile = () => (actions.reconcileCompletedCaptionEditInternal as any)._handler(f.ctx, { requestId: "edit-1" });
  f.state.asset.tracks[1].status = "preparing";
  await reconcile();
  assert.deepEqual(f.state.deletedTracks, []);
  assert.equal(f.state.metadata.custom.aiCaptionsRevision, 0);
  f.state.asset.tracks[1].status = "ready";
  f.state.translations = [{ _id: "translation-1", languageCode: "es", status: "completed", uploadedTrackId: "old-translation" }];
  const result = await reconcile();
  assert.equal(result.ok, true);
  assert.deepEqual(f.state.deletedTracks, ["original", "old-translation"]);
  assert.equal(f.state.metadata.custom.aiCaptionsRevision, 1);
  assert.equal(f.state.metadata.custom.aiCaptionsTrackId, "manual");
  assert.ok(f.state.refreshed.some((name: string) => name.includes("ensureCaptionTranslations")));
  assert.ok(f.state.refreshed.some((name: string) => name.includes("generateSummaryAndTags")));
  assert.equal(f.state.row.pipelineStage, "done");
  assert.equal(f.state.row.reconciliationStatus, "completed");
});

test("transcript loading rejects a missing selected track instead of opening a different track", async () => {
  const f = fixture();
  await assert.rejects((actions.loadOwnCaptionDocument as any)._handler(f.ctx,
    { muxAssetId: "asset-1", trackId: "deleted-track" }), /No ready caption track/);
  f.state.identity = "stranger|session";
  await assert.rejects((actions.loadOwnCaptionDocument as any)._handler(f.ctx,
    { muxAssetId: "asset-1", trackId: "original" }), /not found/);
});

test("saving an unchanged transcript without censoring does not reserve or upload a track", async () => {
  const f = fixture(); f.state.row = null;
  const document = await (actions.loadOwnCaptionDocument as any)._handler(f.ctx, { muxAssetId: "asset-1" });
  await assert.rejects((actions.replaceOwnCaptionTrack as any)._handler(f.ctx,
    { muxAssetId: "asset-1", trackId: "original", captionRevision: 0,
      edits: [{ id: document.cues[0].id, text: document.cues[0].text }] }), /Edit a caption/);
  assert.equal(f.state.row, null);
  assert.equal(f.state.stored.length, 0);
});

test("manual save persists a job and storage before the upload worker starts", async () => {
  const f = fixture(); f.state.row = null;
  const document = await (actions.loadOwnCaptionDocument as any)._handler(f.ctx, { muxAssetId: "asset-1" });
  const result = await (actions.replaceOwnCaptionTrack as any)._handler(f.ctx,
    { muxAssetId: "asset-1", trackId: "original", captionRevision: 0, edits: [{ id: document.cues[0].id, text: "Edited text" }], autoCensorProfanity: true });
  assert.equal(result.status, "requested");
  assert.equal(f.state.row.pipelineStage, "upload_requested");
  assert.equal(f.state.row.temporaryStorageId, "vtt-1");
  assert.ok(f.state.stored[0].includes("Edited text"));
  assert.equal(JSON.stringify(f.state.row).includes("Edited text"), false);
  assert.equal(f.state.deletedStorage.length, 0);
  assert.equal(f.state.createCount, 0);
  await f.advance();
  assert.equal(f.state.row.pipelineStage, "waiting_track");
  assert.equal(f.state.deletedStorage.length, 0);
});

test("upload status check resumes discovery without a second POST", async () => {
  const f = fixture({ pipelineStage: "uploading", submissionUncertainAtMs: Date.now(), status: "errored" });
  f.state.asset.tracks[1].passthrough = "caption-edit:edit-1";
  const result = await (actions.retryCaptionJobStatusForAsset as any)._handler(f.ctx, { muxAssetId: "asset-1" });
  assert.equal(result.restarted, true);
  await f.advance();
  assert.equal(f.state.row.pipelineStage, "waiting_track");
  assert.equal(f.state.createCount, 0);
});
