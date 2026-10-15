import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { URL } from "node:url";
import { getFunctionName } from "convex/server";
import { Assets } from "@mux/mux-node/resources/video/assets";

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && (context.parentURL?.includes("/convex/") || context.parentURL?.includes("/lib/"))) {
    for (const ext of [".ts", ".js"]) {
      const url = new URL(specifier + ext, context.parentURL);
      if (existsSync(url)) return next(url.href, context);
    }
  }
  return next(specifier, context);
} });
const actions = await import("../convex/captionEditingNode.ts");
const mutations = await import("../convex/captionEditing.ts");
const originalFetch = globalThis.fetch;
const retrieve = Assets.prototype.retrieve, createTrack = Assets.prototype.createTrack;
const env = [process.env.MUX_TOKEN_ID, process.env.MUX_TOKEN_SECRET];
process.env.MUX_TOKEN_ID = "test"; process.env.MUX_TOKEN_SECRET = "test";
after(() => {
  hooks.deregister(); globalThis.fetch = originalFetch;
  Assets.prototype.retrieve = retrieve; Assets.prototype.createTrack = createTrack;
  ["MUX_TOKEN_ID", "MUX_TOKEN_SECRET"].forEach((key, i) => { if (env[i] === undefined) delete process.env[key]; else process.env[key] = env[i]; });
});
function fixture() {
  const state: any = { row: null, bodies: [], owner: "owner", revision: 2, status: 200, translations: [], scheduled: [], source: "track", asset: { id: "asset", status: "ready", playback_ids: [{ id: "public", policy: "public" }], tracks: [{ id: "track", name: "English", language_code: "en", type: "text", status: "ready" }] } };
  const db: any = {
    async get() { return state.row && structuredClone(state.row); },
    async insert(_table: string, value: any) { state.row = { ...value, _id: "edit-1" }; return "edit-1"; },
    async patch(_id: string, value: any) { Object.assign(state.row, value); },
    query(table: string) {
      const q: any = { withIndex() { return q; }, order() { return q; }, async collect() { return table === "captionTranslationJobs" ? state.translations : state.row ? [...(state.newest ? [state.newest] : []), structuredClone(state.row)] : []; } }; return q;
    },
  };
  const ctx: any = { db, auth: { async getUserIdentity() { return { subject: "owner|session" }; } }, scheduler: { async runAfter(_delay: number, ref: any, args: any) { state.scheduled.push({ name: getFunctionName(ref), args }); } },
    async runQuery(ref: any, args: any) {
      let name: string;
      try { name = getFunctionName(ref).split(":")[1]; } catch { return { asset: state.asset, metadata: { userId: state.owner, custom: { aiCaptionsTrackId: state.source, aiCaptionsRevision: state.revision, aiSummary: "unchanged", aiCaptionsUnavailableReason: state.unavailable } } };  }
      if (name === "getByMuxAssetIdInternal") return { isDeleted: false };
      if (name === "getTranslationRowsInternal") return state.translations;
      return (mutations as any)[name]._handler(ctx, args);
    },
    async runMutation(ref: any, args: any) {
      let name: string;
      try { name = getFunctionName(ref).split(":")[1]; } catch {
        if (args.custom) { state.source = args.custom.aiCaptionsTrackId; state.revision = args.custom.aiCaptionsRevision; state.unavailable = args.custom.aiCaptionsUnavailableReason; assert.equal(args.custom.aiSummary, "unchanged"); }
        return {};
      }
      if (["upsertFromPayloadInternal", "applyVideoMetadataInternal"].includes(name)) return {};
      return (mutations as any)[name]._handler(ctx, args);
    },
  };
  (Assets.prototype as any).retrieve = async () => structuredClone(state.asset);
  (Assets.prototype as any).createTrack = async () => { assert.fail("Robots edits must not manually upload captions"); };
  globalThis.fetch = (async (_url: any, init: any) => {
    if (String(_url).includes("stream.mux.com")) return new Response("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n");
    state.bodies.push(JSON.parse(init.body));
    if (state.networkError) throw new Error("connection lost");
    return new Response(JSON.stringify({ data: { id: "robot-1", status: "pending" } }), { status: state.status });
  }) as typeof fetch;
  const submit = (args: any = {}) => (actions.editCaptionsForAsset as any)._handler(ctx, { muxAssetId: "asset", trackId: "track", captionRevision: 2, replacements: [{ find: " word ", replace: " corrected " }], ...args });
  return { state, submit, ctx };
}
test("action sends one current Robots request, preserves spaces, and serializes duplicates", async () => {
  const f = fixture();
  assert.equal((await f.submit({ speakerReplacements: [{ find: "speaker_0", replace: "Alice" }] })).alreadyActive, false);
  assert.deepEqual(f.state.bodies[0].parameters, { asset_id: "asset", track_id: "track", replacements: [{ find: " word ", replace: " corrected ", case_sensitive: false }], speaker_replacements: [{ find: "speaker_0", replace: "Alice" }], upload_to_mux: true, replace_existing_tracks: "replace" });
  assert.equal(f.state.row.operation, "robots");
  assert.equal((await f.submit()).alreadyActive, true);
  assert.equal(f.state.bodies.length, 1);
});
test("speaker-only and AI-only jobs are accepted", async () => {
  for (const args of [{ speakerReplacements: [{ find: "speaker_0", replace: "Alice" }] }, { autoCensorProfanity: { mode: "mask", alwaysCensor: ["bad"] } }]) {
    const f = fixture(); await f.submit({ replacements: [], ...args }); assert.equal(f.state.bodies.length, 1);
    assert.equal(f.state.bodies[0].parameters.replacements, undefined);
  }
});
test("invalid rules, revisions, ownership, tracks and active translations never submit", async () => {
  for (const args of [{ captionRevision: 1 }, { captionRevision: -1 }, { trackId: "old" }, { replacements: [] }, { replacements: [{ find: "same", replace: "same", caseSensitive: true }] }, { speakerReplacements: [{ find: "[speaker]", replace: "Alice" }] }, { replacements: [{ find: "x", replace: "a\nb" }] }, { replacements: Array.from({ length: 101 }, () => ({ find: "x", replace: "y" })) }]) {
    const f = fixture(); await assert.rejects(f.submit(args)); assert.equal(f.state.bodies.length, 0); assert.equal(f.state.row, null);
  }
  for (const change of [(s: any) => { s.owner = "other"; }, (s: any) => { s.translations = [{ status: "processing" }]; }]) {
    const f = fixture(); change(f.state); await assert.rejects(f.submit()); assert.equal(f.state.bodies.length, 0);
  }
});
test("confirmed failed Robots restoration rebinds only unique sources without changing revision", async () => {
  for (const scenario of ["restored", "unbound", "ambiguous", "missing", "newer", "newest", "owner", "timeout"]) {
    const f = fixture(); await f.submit();
    f.state.asset.tracks = [{ id: "restored", name: "English", language_code: "en", type: "text", status: "ready" }];
    if (scenario === "ambiguous") f.state.asset.tracks.push({ ...f.state.asset.tracks[0], id: "other" });
    if (scenario === "unbound") f.state.source = undefined;
    if (scenario === "newer") f.state.revision = 3;
    if (scenario === "newest") f.state.newest = { _id: "new-job", status: "pending", operation: "robots" };
    if (scenario === "owner") f.state.owner = "other";
    if (scenario === "missing") f.state.asset.tracks = [];
    await (actions.syncCaptionEditJobInternal as any)._handler(f.ctx, { job: { id: "robot-1", status: "errored" }, requestId: "edit-1" });
    assert.ok(f.state.scheduled.some((entry: any) => entry.name.endsWith(":reconcileFailedRobotsSourceInternal")));
    if (scenario === "timeout") f.state.row.pollingTimedOutAtMs = Date.now();
    await (actions.reconcileFailedRobotsSourceInternal as any)._handler(f.ctx, { requestId: "edit-1" });
    if (scenario === "restored" || scenario === "unbound") {
      assert.equal(f.state.source, "restored"); assert.equal(f.state.revision, 2);
      const doc = await (actions.loadOwnCaptionDocument as any)._handler(f.ctx, { muxAssetId: "asset" });
      assert.equal(doc.trackId, "restored"); assert.equal(doc.captionRevision, 2);
      await f.submit({ trackId: doc.trackId, captionRevision: doc.captionRevision });
      assert.equal(f.state.bodies[1].parameters.track_id, "restored");
    } else {
      assert.equal(f.state.source, "track");
      if (scenario === "ambiguous" || scenario === "missing") { assert.match(f.state.unavailable, /manual recovery/); await assert.rejects((actions.loadOwnCaptionDocument as any)._handler(f.ctx, { muxAssetId: "asset" })); }
    }
  }
});

test("late confirmed failure recovers an expired ambiguous submission exactly once", async () => {
  const f = fixture(); f.state.networkError = true;
  await assert.rejects(f.submit());
  await (mutations.expireUnattachedEditInternal as any)._handler(f.ctx, { requestId: "edit-1" });
  assert.equal(f.state.row.status, "errored");
  assert.ok(f.state.row.submissionUncertainAtMs);
  f.state.asset.tracks = [{ id: "restored", name: "English", language_code: "en", type: "text", status: "ready" }];
  const event = { job: { id: "robot-1", status: "errored" }, requestId: "edit-1" };
  await (actions.syncCaptionEditJobInternal as any)._handler(f.ctx, event);
  assert.equal(f.state.row.submissionUncertainAtMs, undefined);
  assert.equal(f.state.scheduled.filter((entry: any) => entry.name.endsWith(":reconcileFailedRobotsSourceInternal")).length, 1);
  await (actions.syncCaptionEditJobInternal as any)._handler(f.ctx, event);
  assert.equal(f.state.scheduled.filter((entry: any) => entry.name.endsWith(":reconcileFailedRobotsSourceInternal")).length, 1);
  await (actions.reconcileFailedRobotsSourceInternal as any)._handler(f.ctx, { requestId: "edit-1" });
  assert.equal(f.state.source, "restored");
  assert.equal(f.state.bodies.length, 1);
});

test("failed-job restoration retries while the restored track is still preparing", async () => {
  const f = fixture(); await f.submit();
  f.state.asset.tracks = [{ id: "restored", name: "English", language_code: "en", type: "text", status: "preparing" }];
  await (actions.syncCaptionEditJobInternal as any)._handler(f.ctx, { job: { id: "robot-1", status: "errored" }, requestId: "edit-1" });
  const result = await (actions.reconcileFailedRobotsSourceInternal as any)._handler(f.ctx, { requestId: "edit-1" });
  assert.equal(result.retryScheduled, true);
  assert.ok(f.state.scheduled.some((entry: any) => entry.name.endsWith(":reconcileFailedRobotsSourceInternal") && entry.args.attempt === 1));
  f.state.asset.tracks[0].status = "ready";
  await (actions.reconcileFailedRobotsSourceInternal as any)._handler(f.ctx, { requestId: "edit-1", attempt: 1 });
  assert.equal(f.state.source, "restored");
  assert.equal(f.state.revision, 2);
});

test("confirmed failures release reservation; ambiguous creation remains reserved without repost", async () => {
  for (const status of [422, 408, 500, 503, "network"]) {
    const f = fixture(); if (status === "network") f.state.networkError = true; else f.state.status = status;
    await assert.rejects(f.submit());
    if (status === 422) assert.equal(f.state.row.status, "errored");
    else { assert.ok(f.state.row.submissionUncertainAtMs); assert.equal((await f.submit()).alreadyActive, true); assert.equal(f.state.bodies.length, 1); }
  }
});
