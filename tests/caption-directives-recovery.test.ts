import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { URL } from "node:url";
import { getFunctionName } from "convex/server";
import { after, test } from "node:test";

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === "@mux/mux-node") return { url: 'data:text/javascript,export default class Mux { webhooks = { unwrap: raw => JSON.parse(raw) }; video = { assets: { retrieve: async () => { if (globalThis.__recoveryRetrieveError) throw new Error("temporary SDK asset retrieval failure"); return globalThis.__recoveryAsset; }, list: async function* () { yield globalThis.__recoveryAsset; } } }; }', shortCircuit: true };
  if (specifier.startsWith(".") && context.parentURL?.includes("/convex/")) {
    for (const ext of [".ts", ".js"]) {
      const url = new URL(specifier + ext, context.parentURL);
      if (existsSync(url)) return next(url.href, context);
    }
  }
  return next(specifier, context);
} });
const directives = await import("../convex/captionDirectives.ts");
const { ensureGeneratedCaptionsTrackInternal, syncPremiumCaptionsJobInternal } = await import("../convex/captions.ts");
const { backfillRequestedTranslationTracksForReadyAssets } = await import("../convex/migrations.ts");
const { ensureAiMetadataForAssetInternal } = await import("../convex/aiMetadata.ts");
const { decodeUploadCustom } = await import("../convex/uploadPassthrough.ts");
const { ingestMuxWebhook } = await import("../convex/muxWebhook.ts");
after(() => hooks.deregister());

function fixture(includeSpeakers = true) {
  process.env.MUX_TOKEN_ID = "test";
  process.env.MUX_TOKEN_SECRET = "test";
  process.env.MUX_CAPTION_DIRECTIVE_WITH_SPEAKERS_ID = "speakers";
  process.env.MUX_CAPTION_DIRECTIVE_WITHOUT_SPEAKERS_ID = "plain";
  const state: any = {
    custom: { includeSpeakers, moderationCheckedAtMs: 1, moderationPassed: true },
    claim: { _id: "claim", muxAssetId: "asset", userId: "owner", directiveId: "pinned", includeSpeakers, runId: "run", createdAtMs: 1 },
    job: { id: "job", status: "completed", parameters: { asset_id: "asset", include_speakers: includeSpeakers }, outputs: { track_id: "original", language_code: "en" } },
    run: { status: "completed", node_states: [{ reference_id: "premium_captions", status: "dispatched", job_id: "job", workflow_name: "generate-premium-captions" }] },
    asset: { status: "ready", tracks: [{ id: "original", type: "text", status: "ready", language_code: "en" }] },
    requests: [], writes: [], schedules: [], beforeUpdate: undefined,
  };
  (globalThis as any).__recoveryAsset = state.asset;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, options: any) => {
    state.requests.push(`${options?.method ?? "GET"} ${url}`);
    if (state.fetchError) throw new Error("temporary polling failure");
    if (options?.method === "POST" && state.submission !== undefined) return Response.json({ data: state.submission });
    assert.notEqual(options?.method, "POST", "known claims must not POST");
    if (url.includes("/runs/")) return Response.json({ data: state.run });
    return Response.json({ data: state.job });
  }) as any;
  const ctx: any = {
    async runQuery(_ref: any, args: any) {
      let name = "component";
      try { name = getFunctionName(_ref); } catch {}
      if (name.startsWith("captionDirectives:")) return await (directives as any)[name.split(":")[1]]._handler(ctx, args);
      if (name === "muxAssetCache:getByMuxAssetIdInternal") return { isDeleted: state.deleted === true };
      return args.userId ? { asset: structuredClone(state.asset), metadata: { userId: state.metadataOwner ?? "owner", custom: structuredClone(state.custom) } } : {};
    },
    db: {
      query() { return { withIndex() { return { async unique() { return structuredClone(state.claim); } }; } }; },
      async insert(_table: any, claim: any) { state.claim = { ...claim, _id: "claim" }; return "claim"; },
      async get() { return structuredClone(state.claim); }, async patch(_id: any, fields: any) { Object.assign(state.claim, fields); },
    },
    async runMutation(ref: any, args: any) {
      let name = "component";
      try { name = getFunctionName(ref); } catch {}
      if (name.startsWith("captionDirectives:")) {
        if (name.endsWith("updateMetadataInternal") && state.beforeUpdate) await state.beforeUpdate(args);
        return await (directives as any)[name.split(":")[1]]._handler(ctx, args);
      }
      if (args.custom) { state.writes.push(structuredClone(args.custom)); state.custom = structuredClone(args.custom); }
    },
    scheduler: { async runAfter(_delay: any, ref: any, args: any) { state.schedules.push({ name: getFunctionName(ref), args }); } },
  };
  return { state, ctx, ensure: (attempt = 0) => (ensureGeneratedCaptionsTrackInternal as any)._handler(ctx, { muxAssetId: "asset", userId: "owner", attempt }), restore() { globalThis.fetch = oldFetch; delete (globalThis as any).__recoveryAsset; delete (globalThis as any).__recoveryRetrieveError; } };
}

test("delayed generation cannot overwrite finalized captions or an advanced edit revision", async () => {
  const f = fixture();
  let release!: () => void;
  let reached!: () => void;
  const paused = new Promise<void>(resolve => { reached = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  f.state.beforeUpdate = async (args: any) => {
    if (args.fields.aiCaptionsGeneratedAtMs && first) { first = false; reached(); await resume; }
  };
  try {
    const delayed = f.ensure();
    await paused;
    await f.ensure();
    const finalized = f.state.custom.aiCaptionsGeneratedAtMs;
    // Existing editor reconciliation retains the generation job, advances
    // revision, and replaces only the canonical source track.
    Object.assign(f.state.custom, { aiCaptionsTrackId: "renamed", aiCaptionsRevision: 1, aiCaptionsEditedAtMs: 5 });
    release();
    await delayed;
    assert.equal(f.state.custom.aiCaptionsTrackId, "renamed");
    assert.equal(f.state.custom.aiCaptionsRevision, 1);
    assert.equal(f.state.custom.aiCaptionsGeneratedAtMs, finalized);
  } finally { release?.(); f.restore(); }
});

for (const advanced of [{ aiCaptionsGeneratedAtMs: 5 }, { aiCaptionsRevision: 1 }, { aiCaptionsTrackId: "renamed" }]) {
  test(`atomic metadata guard rejects all late generation writes after ${JSON.stringify(advanced)}`, async () => {
    const f = fixture();
    Object.assign(f.state.custom, advanced);
    const before = structuredClone(f.state.custom);
    try {
      await (directives.updateMetadataInternal as any)._handler(f.ctx, { muxAssetId: "asset", userId: "owner", fields: { aiCaptionsJobStatus: "errored", aiCaptionsUnavailableReason: "late failure", aiCaptionsTrackId: "old" } });
      assert.deepEqual(f.state.custom, before);
    } finally { f.restore(); }
  });
}

for (const pending of ["job", "track", "http"]) {
  test(`late same-run completion reconciles after ${pending} polling exhaustion`, async () => {
    const f = fixture();
    try {
      if (pending === "job") f.state.job.status = "processing";
      else if (pending === "track") f.state.asset.tracks[0].status = "preparing";
      else f.state.fetchError = true;
      await f.ensure(9);
      f.state.job.status = "completed";
      f.state.asset.tracks[0].status = "ready";
      f.state.fetchError = false;
      await (syncPremiumCaptionsJobInternal as any)._handler(f.ctx, { muxAssetId: "asset", userId: "owner", job: f.state.job });
      const scheduled = f.state.schedules.find((row: any) => row.name === "captions:ensureGeneratedCaptionsTrackInternal");
      assert.ok(scheduled);
      await (ensureGeneratedCaptionsTrackInternal as any)._handler(f.ctx, scheduled.args);
      assert.equal(f.state.custom.aiCaptionsTrackId, "original");
      assert.equal(f.state.custom.aiCaptionsUnavailableReason, null);
      assert.equal(f.state.custom.aiCaptionsPollingTimedOut, false);
      assert.equal(f.state.custom.aiCaptionsLastError, null);
      assert.equal(f.state.custom.aiCaptionsFailedAtMs, null);
      assert.equal(f.state.requests.some((s: string) => s.startsWith("POST")), false);
    } finally { f.restore(); }
  });
}

test("last-attempt SDK retrieval failure permits late same-run recovery", async () => {
  const f = fixture();
  try {
    (globalThis as any).__recoveryRetrieveError = true;
    await f.ensure(9);
    assert.match(f.state.custom.aiCaptionsLastError, /SDK asset retrieval/);
    assert.equal(f.state.custom.aiCaptionsPollingTimedOut, true);
    delete (globalThis as any).__recoveryRetrieveError;
    await f.ensure();
    assert.equal(f.state.custom.aiCaptionsTrackId, "original");
    assert.equal(f.state.custom.aiCaptionsUnavailableReason, null);
    assert.equal(f.state.requests.some((s: string) => s.startsWith("POST")), false);
  } finally { f.restore(); }
});

test("legacy completed premium job preparing at exhaustion still recovers when ready", async () => {
  const f = fixture();
  delete f.state.custom.includeSpeakers;
  f.state.custom.aiCaptionsJobId = "job";
  f.state.claim = null;
  f.state.asset.tracks[0].status = "preparing";
  try {
    await f.ensure(9);
    assert.equal(f.state.custom.aiCaptionsTrackId, undefined);
    f.state.asset.tracks[0].status = "ready";
    await f.ensure();
    assert.equal(f.state.custom.aiCaptionsTrackId, "original");
    assert.equal(f.state.custom.aiCaptionsUnavailableReason, null);
    assert.equal(f.state.requests.some((s: string) => s.startsWith("POST")), false);
  } finally { f.restore(); }
});

for (const failure of ["asset", "job"]) {
  test(`legacy transient ${failure} failure at polling exhaustion permits late recovery`, async () => {
    const f = fixture();
    delete f.state.custom.includeSpeakers;
    f.state.custom.aiCaptionsJobId = "job";
    f.state.claim = null;
    try {
      if (failure === "asset") (globalThis as any).__recoveryRetrieveError = true;
      else f.state.fetchError = true;
      await f.ensure(9);
      assert.equal(f.state.custom.aiCaptionsUnavailableReason, undefined);
      delete (globalThis as any).__recoveryRetrieveError;
      f.state.fetchError = false;
      await f.ensure();
      assert.equal(f.state.custom.aiCaptionsTrackId, "original");
      assert.equal(f.state.requests.some((request: string) => request.startsWith("POST")), false);
    } finally { f.restore(); }
  });
}

for (const status of ["completed", "errored"]) {
  test(`actual webhook ingress reconciles claimed directive ${status} job without user passthrough`, async () => {
    const f = fixture();
    process.env.MUX_WEBHOOK_SECRET = "test";
    f.state.custom.aiCaptionsPollingTimedOut = true;
    f.state.custom.aiCaptionsUnavailableReason = "polling timed out";
    f.state.job.status = status;
    if (status === "errored") f.state.job.errors = [{ message: "premium generation failed" }];
    try {
      const event = { type: `robots.job.generate_premium_captions.${status}`, data: f.state.job };
      const result = await (ingestMuxWebhook as any)._handler(f.ctx, { rawBody: JSON.stringify(event), headers: {} });
      assert.equal(result.skipped, false);
      const scheduled = f.state.schedules.find((row: any) => row.name === "captions:ensureGeneratedCaptionsTrackInternal");
      assert.ok(scheduled);
      assert.deepEqual(scheduled.args, { muxAssetId: "asset", userId: "owner", attempt: 0 });
      await (ensureGeneratedCaptionsTrackInternal as any)._handler(f.ctx, scheduled.args);
      if (status === "completed") assert.equal(f.state.custom.aiCaptionsTrackId, "original");
      else assert.match(f.state.custom.aiCaptionsUnavailableReason, /premium generation failed/);
      assert.equal(f.state.requests.some((s: string) => s.startsWith("POST")), false);
    } finally { f.restore(); }
  });
}

test("directive webhook identifiers are only a wakeup; canonical run and owner win", async () => {
  const f = fixture();
  process.env.MUX_WEBHOOK_SECRET = "test";
  try {
    const event = { type: "robots.job.generate_premium_captions.completed", data: {
      ...f.state.job, id: "unrelated-event-job", passthrough: { userId: "attacker" }, outputs: { track_id: "forged" },
    } };
    await (ingestMuxWebhook as any)._handler(f.ctx, { rawBody: JSON.stringify(event), headers: {} });
    const scheduled = f.state.schedules[0];
    assert.deepEqual(scheduled.args, { muxAssetId: "asset", userId: "owner", attempt: 0 });
    await (ensureGeneratedCaptionsTrackInternal as any)._handler(f.ctx, scheduled.args);
    assert.equal(f.state.custom.aiCaptionsJobId, "job");
    assert.equal(f.state.custom.aiCaptionsTrackId, "original");
    assert.equal(f.state.requests.some((s: string) => s.includes("unrelated-event-job")), false);
  } finally { f.restore(); }
});

for (const jobId of ["job", "unrelated-job"]) {
  test(`actual legacy webhook sync requires durable matching job identity: ${jobId}`, async () => {
    const f = fixture();
    process.env.MUX_WEBHOOK_SECRET = "test";
    f.state.claim = null;
    delete f.state.custom.includeSpeakers;
    f.state.custom.aiCaptionsJobId = "job";
    try {
      const event = { type: "robots.job.generate_premium_captions.completed", data: { ...f.state.job, id: jobId, passthrough: { userId: "owner" } } };
      const result = await (ingestMuxWebhook as any)._handler(f.ctx, { rawBody: JSON.stringify(event), headers: {} });
      assert.equal(result.skipped, jobId !== "job");
      assert.equal(f.state.schedules.length, jobId === "job" ? 1 : 0);
      if (jobId === "job") {
        assert.equal(f.state.schedules[0].name, "captions:syncPremiumCaptionsJobInternal");
        await (syncPremiumCaptionsJobInternal as any)._handler(f.ctx, f.state.schedules[0].args);
        assert.equal(f.state.custom.aiCaptionsJobId, "job");
      }
    } finally { f.restore(); }
  });
}

for (const condition of ["no_claim", "no_run", "deleted", "moderation_pending", "moderation_rejected", "wrong_owner", "changed_choice"]) {
  test(`webhook without user context cannot bypass trusted claim guard: ${condition}`, async () => {
    const f = fixture();
    process.env.MUX_WEBHOOK_SECRET = "test";
    if (condition === "no_claim") f.state.claim = null;
    if (condition === "no_run") delete f.state.claim.runId;
    if (condition === "deleted") f.state.deleted = true;
    if (condition === "moderation_pending") delete f.state.custom.moderationCheckedAtMs;
    if (condition === "moderation_rejected") f.state.custom.moderationPassed = false;
    if (condition === "wrong_owner") f.state.metadataOwner = "different-owner";
    if (condition === "changed_choice") f.state.custom.includeSpeakers = false;
    try {
      const event = { type: "robots.job.generate_premium_captions.completed", data: f.state.job };
      const result = await (ingestMuxWebhook as any)._handler(f.ctx, { rawBody: JSON.stringify(event), headers: {} });
      assert.equal(result.skipped, true);
      assert.equal(f.state.schedules.length, 0);
      assert.equal(f.state.writes.length, 0);
    } finally { f.restore(); }
  });
}

test("known pinned run polls with selected env missing", async () => {
  const f = fixture();
  delete process.env.MUX_CAPTION_DIRECTIVE_WITH_SPEAKERS_ID;
  try {
    await f.ensure();
    assert.ok(f.state.requests.some((s: string) => s.includes("/directives/pinned/runs/run")));
    assert.equal(f.state.custom.aiCaptionsTrackId, "original");
  } finally { f.restore(); }
});

test("preclaim configuration diagnostic persists but cannot accept tracks or jobs", async () => {
  const f = fixture();
  f.state.claim = null;
  delete process.env.MUX_CAPTION_DIRECTIVE_WITH_SPEAKERS_ID;
  try {
    await f.ensure(9);
    assert.match(f.state.custom.aiCaptionsLastError, /MUX_CAPTION_DIRECTIVE_WITH_SPEAKERS_ID/);
    assert.match(f.state.custom.aiCaptionsUnavailableReason, /MUX_CAPTION_DIRECTIVE_WITH_SPEAKERS_ID/);
    await (directives.updateMetadataInternal as any)._handler(f.ctx, { muxAssetId: "asset", userId: "owner", fields: { aiCaptionsTrackId: "forged", aiCaptionsJobId: "forged" } });
    assert.equal(f.state.custom.aiCaptionsTrackId, undefined);
    assert.equal(f.state.custom.aiCaptionsJobId, undefined);
  } finally { f.restore(); }
});

test("plain claim accepts omitted speaker parameter as false, but rejects true", async () => {
  for (const actual of [undefined, true]) {
    const f = fixture(false);
    f.state.job.parameters.include_speakers = actual;
    try {
      await f.ensure(9);
      assert.equal(f.state.custom.aiCaptionsTrackId, actual === undefined ? "original" : undefined);
      if (actual) assert.match(f.state.custom.aiCaptionsUnavailableReason, /speaker/i);
    } finally { f.restore(); }
  }
});

for (const invalid of ["", " ", {}, 1]) {
  test(`malformed submission run_id never gets persisted: ${JSON.stringify(invalid)}`, async () => {
    const f = fixture();
    f.state.claim = null;
    f.state.submission = { run_id: invalid };
    try {
      await f.ensure(9);
      assert.equal(f.state.claim.runId, undefined);
      assert.match(f.state.custom.aiCaptionsLastError, /invalid.*run_id/i);
      await f.ensure();
      assert.equal(f.state.requests.filter((s: string) => s.startsWith("POST")).length, 1);
    } finally { f.restore(); }
  });
}

for (const actual of [false, undefined, "true"]) {
  test(`speaker-enabled claim rejects job include_speakers=${actual}`, async () => {
    const f = fixture();
    f.state.job.parameters.include_speakers = actual;
    try {
      await f.ensure(9);
      assert.equal(f.state.custom.aiCaptionsTrackId, undefined);
      assert.match(f.state.custom.aiCaptionsUnavailableReason, /speaker/i);
    } finally { f.restore(); }
  });
}

test("AI metadata handler independently recovers compact language choices", async () => {
  let saved: any = {};
  const asset = { status: "ready", passthrough: JSON.stringify({ userId: "owner", v: 1, a: ["es"], c: [] }) };
  const ctx: any = {
    async runQuery() { return { asset, metadata: { userId: "owner", custom: saved } }; },
    async runMutation(_ref: any, args: any) { if (args.custom) saved = structuredClone(args.custom); },
    scheduler: { async runAfter() { assert.fail("moderation is still pending"); } },
  };
  await (ensureAiMetadataForAssetInternal as any)._handler(ctx, { muxAssetId: "asset" });
  assert.deepEqual(saved.audioTranslationLanguageCodes, ["es"]);
  assert.deepEqual(saved.captionTranslationLanguageCodes, []);
});

for (const selection of [
  { v: 1, a: ["es"], c: ["fr"], expectedAudio: ["es"], expectedCaptions: ["fr"] },
  { v: 1, a: ["es"], c: [], expectedAudio: ["es"], expectedCaptions: [] },
  { custom: { audioTranslationLanguageCodes: ["es"] }, expectedAudio: ["es"], expectedCaptions: ["es"] },
]) {
  test(`all recovery readers expand compact languages and preserve empty/legacy selections: ${JSON.stringify(selection)}`, async () => {
    process.env.MUX_TOKEN_ID = "test";
    process.env.MUX_TOKEN_SECRET = "test";
    const asset = { id: "asset", status: "ready", passthrough: JSON.stringify({ userId: "owner", ...selection }) };
    (globalThis as any).__recoveryAsset = asset;
    const schedules: any[] = [];
    let saved: any = {};
    const ctx: any = {
      async runQuery() { return { asset, metadata: { userId: "owner", custom: saved } }; },
      async runMutation(_ref: any, args: any) { if (args.custom) saved = structuredClone(args.custom); },
      scheduler: { async runAfter(_delay: any, ref: any, args: any) { schedules.push({ name: getFunctionName(ref), args }); } },
    };
    const result = await (backfillRequestedTranslationTracksForReadyAssets as any)._handler(ctx, {});
    assert.equal(result.queuedAudioRequests, selection.expectedAudio.length);
    assert.equal(result.queuedCaptionRequests, selection.expectedCaptions.length);
    assert.deepEqual(schedules.find(row => row.name.startsWith("audioTranslationsNode:"))?.args.languageCodes ?? [], selection.expectedAudio);
    assert.deepEqual(schedules.find(row => row.name.startsWith("captionTranslationsNode:"))?.args.languageCodes ?? [], selection.expectedCaptions);
    await (ensureAiMetadataForAssetInternal as any)._handler(ctx, { muxAssetId: "asset" });
    assert.deepEqual(saved.audioTranslationLanguageCodes, selection.expectedAudio);
    if ("v" in selection) assert.deepEqual(saved.captionTranslationLanguageCodes, selection.expectedCaptions);
    else assert.equal(saved.captionTranslationLanguageCodes, undefined);
    // Existing explicit empty metadata takes precedence over compact replay.
    saved = { audioTranslationLanguageCodes: [], captionTranslationLanguageCodes: [] };
    schedules.length = 0;
    const replay = await (backfillRequestedTranslationTracksForReadyAssets as any)._handler(ctx, {});
    assert.equal(replay.queuedAssets, 0);
    assert.deepEqual(decodeUploadCustom(JSON.parse(asset.passthrough))?.audioTranslationLanguageCodes, selection.expectedAudio);
    delete (globalThis as any).__recoveryAsset;
  });
}

for (const node of [{ status: "dispatched", job_id: {} }, { status: "dispatched", job_id: " " }, { status: "invented", job_id: "job" }]) {
  test(`malformed run node rejected: ${JSON.stringify(node)}`, async () => {
    const f = fixture();
    f.state.run.node_states = [{ reference_id: "premium_captions", ...node }];
    try {
      await f.ensure(9);
      assert.equal(f.state.custom.aiCaptionsTrackId, undefined);
      assert.equal(f.state.requests.filter((s: string) => s.includes("/jobs/")).length, 0);
      assert.match(f.state.custom.aiCaptionsLastError, /invalid/i);
    } finally { f.restore(); }
  });
}
