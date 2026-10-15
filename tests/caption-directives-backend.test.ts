import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { URL } from "node:url";
import { getFunctionName } from "convex/server";
import { after, test } from "node:test";
import { buildCaptionDirectiveDefinition, selectCaptionDirectiveId } from "../convex/captionDirectivesConfig.ts";

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === "@mux/mux-node") return { url: 'data:text/javascript,export default class Mux { video = { assets: { retrieve: async () => globalThis.__directiveTestAsset }, uploads: { create: async (args) => { globalThis.__directiveTestUpload = args; return { id: "upload", url: "https://example.test/upload", status: "waiting" }; } } }; }', shortCircuit: true };
  if (specifier.startsWith(".") && context.parentURL?.includes("/convex/")) {
    for (const ext of [".ts", ".js"]) {
      const url = new URL(specifier + ext, context.parentURL);
      if (existsSync(url)) return next(url.href, context);
    }
  }
  return next(specifier, context);
} });
const { claimInternal, updateMetadataInternal } = await import("../convex/captionDirectives.ts");
const { createMuxDirectUpload } = await import("../convex/uploads.ts");
const { seedInternal } = await import("../convex/uploadMetadata.ts");
const { ensureGeneratedCaptionsTrackInternal } = await import("../convex/captions.ts");
after(() => hooks.deregister());

for (const requested of [undefined, false, true]) {
  test(`upload persists explicit speaker choice, request=${requested}`, async () => {
    process.env.MUX_TOKEN_ID = "test";
    process.env.MUX_TOKEN_SECRET = "test";
    process.env.MUX_CAPTION_DIRECTIVE_WITH_SPEAKERS_ID = "speakers";
    process.env.MUX_CAPTION_DIRECTIVE_WITHOUT_SPEAKERS_ID = "plain";
    const ctx: any = { auth: { async getUserIdentity() { return { subject: "owner|session" }; } }, async runMutation() {}, scheduler: { async runAfter() {} } };
    await (createMuxDirectUpload as any)._handler(ctx, { includeSpeakers: requested, audioTranslationLanguageCodes: ["es"], captionTranslationLanguageCodes: ["fr"] });
    const settings = (globalThis as any).__directiveTestUpload.new_asset_settings;
    assert.equal(settings.directives, undefined);
    assert.ok(settings.passthrough.length <= 255);
    const transport = JSON.parse(settings.passthrough);
    assert.equal(transport.custom.includeSpeakers, requested ?? false);
    assert.deepEqual(transport.a, ["es"]);
    assert.deepEqual(transport.c, ["fr"]);
    delete process.env[requested ? "MUX_CAPTION_DIRECTIVE_WITH_SPEAKERS_ID" : "MUX_CAPTION_DIRECTIVE_WITHOUT_SPEAKERS_ID"];
    delete (globalThis as any).__directiveTestUpload;
    await assert.rejects((createMuxDirectUpload as any)._handler(ctx, { includeSpeakers: requested }), /Missing env var/);
    assert.equal((globalThis as any).__directiveTestUpload, undefined);
  });
}

test("metadata replay fills speaker marker without overriding saved user choices", async () => {
  for (const existingCustom of [{}, { includeSpeakers: true, captionTranslationLanguageCodes: ["es"] }]) {
    const writes: any[] = [];
    const ctx: any = {
      async runQuery(_ref: any, args: any) { return args.userId ? { asset: {}, metadata: { userId: "owner", title: "saved", custom: existingCustom } } : {}; },
      async runMutation(_ref: any, args: any) { writes.push(args); },
    };
    await (seedInternal as any)._handler(ctx, { muxAssetId: "asset", userId: "owner", title: "replayed", custom: { includeSpeakers: false, captionTranslationLanguageCodes: ["fr"] } });
    assert.equal(writes[0].title, "saved");
    assert.equal(writes[0].custom.includeSpeakers, "includeSpeakers" in existingCustom ? true : false);
    assert.deepEqual(writes[0].custom.captionTranslationLanguageCodes, "includeSpeakers" in existingCustom ? ["es"] : ["fr"]);
  }
});

test("deleted assets cannot acquire claims or accept late metadata", async () => {
  const ctx: any = { async runQuery(_ref: any, args: any) { return args.userId ? { asset: {}, metadata: { userId: "owner", custom: { moderationPassed: true, moderationCheckedAtMs: 1, includeSpeakers: true } } } : { isDeleted: true }; }, db: { query() { assert.fail("no claim writes"); } }, async runMutation() { assert.fail("no metadata writes"); } };
  assert.equal(await (claimInternal as any)._handler(ctx, { muxAssetId: "asset", userId: "owner", directiveId: "speakers", includeSpeakers: true }), null);
  assert.deepEqual(await (updateMetadataInternal as any)._handler(ctx, { muxAssetId: "asset", userId: "owner", fields: { aiCaptionsTrackId: "late" } }), {});
});

for (const includeSpeakers of [false, true]) {
  test(`immutable captions-only definition: speakers=${includeSpeakers}`, () => {
    const definition = buildCaptionDirectiveDefinition({ includeSpeakers });
    assert.deepEqual(definition.resources, []);
    assert.equal(definition.workflows.length, 1);
    assert.equal(definition.workflows[0].workflow, "generate-premium-captions");
    assert.equal(definition.workflows[0].params.include_speakers, includeSpeakers);
    assert.equal(definition.workflows[0].params.replace_existing_tracks, "fail");
    assert.equal(selectCaptionDirectiveId(includeSpeakers, { MUX_CAPTION_DIRECTIVE_WITH_SPEAKERS_ID: "speakers", MUX_CAPTION_DIRECTIVE_WITHOUT_SPEAKERS_ID: "plain" }), includeSpeakers ? "speakers" : "plain");
    assert.throws(() => selectCaptionDirectiveId(includeSpeakers, {}), /Missing env var/);
  });
}

test("durable claims pin options and never reacquire an uncertain submission", async () => {
  let stored: any;
  const ctx: any = {
    async runQuery(_ref: any, args: any) { return args.userId ? { asset: {}, metadata: { userId: "owner", custom: { includeSpeakers: true, moderationPassed: true, moderationCheckedAtMs: 1 } } } : {}; },
    db: { query() { return { withIndex() { return { async unique() { return stored; } }; } }; }, async insert(_table: any, claim: any) { stored = { ...claim, _id: "claim" }; return "claim"; } },
  };
  const args = { muxAssetId: "asset", userId: "owner", includeSpeakers: true, directiveId: "original" };
  assert.equal((await (claimInternal as any)._handler(ctx, args)).acquired, true);
  const replay = await (claimInternal as any)._handler(ctx, { ...args, directiveId: "changed" });
  assert.equal(replay.acquired, false);
  assert.equal(replay.directiveId, "original");
  assert.equal(replay.runId, undefined);
});

for (const custom of [{}, { moderationCheckedAtMs: 1, moderationPassed: false }]) {
  test(`moderation gate submits no jobs: ${JSON.stringify(custom)}`, async () => {
    process.env.MUX_TOKEN_ID = "test";
    process.env.MUX_TOKEN_SECRET = "test";
    const ctx: any = { async runQuery() { return { asset: {}, metadata: { custom: { ...custom, includeSpeakers: true } } }; }, async runMutation() { assert.fail("no mutation before moderation"); }, scheduler: { runAfter() { assert.fail("no jobs before moderation"); } } };
    const result = await (ensureGeneratedCaptionsTrackInternal as any)._handler(ctx, { muxAssetId: "asset", userId: "owner" });
    assert.match(result.reason, /moderation_/);
  });
}

test("real gateway polls run then premium job then exact ready track, never edits or rePOSTs", async () => {
  process.env.MUX_CAPTION_DIRECTIVE_WITH_SPEAKERS_ID = "speakers";
  process.env.USE_LARAVEL_ORCHESTRATION = "false";
  const custom: any = { includeSpeakers: true, moderationCheckedAtMs: 1, moderationPassed: true };
  const asset: any = { status: "ready", tracks: [{ id: "unrelated", type: "text", status: "ready", language_code: "en" }] };
  (globalThis as any).__directiveTestAsset = asset;
  let claim: any;
  let postCount = 0;
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, options: any) => {
    requests.push(`${options?.method ?? "GET"} ${url}`);
    if (options?.method === "POST") { postCount++; assert.deepEqual(JSON.parse(options.body), { asset_id: "asset" }); return Response.json({ data: { run_id: "run" } }); }
    if (url.endsWith("/runs/run")) return Response.json({ data: { status: "completed", node_states: [{ reference_id: "premium_captions", status: "dispatched", job_id: "job" }] } });
    assert.match(url, /jobs\/generate-premium-captions\/job$/);
    return Response.json({ data: { id: "job", status: "completed", parameters: { asset_id: "asset", include_speakers: true }, outputs: { track_id: "exact", language_code: "en" } } });
  }) as any;
  const ctx: any = {
    async runQuery(_ref: any, args: any) { return args.userId ? { asset, metadata: { userId: "owner", custom } } : {}; },
    async runMutation(ref: any, args: any) {
      const name = getFunctionName(ref);
      if (name.endsWith("claimInternal")) {
        if (!claim && !args.directiveId) return { needsConfiguration: true };
        if (!claim) { claim = { ...args, _id: "claim" }; return { ...claim, acquired: true }; }
        return { ...claim, acquired: false };
      }
      if (name.endsWith("recordRunInternal")) { claim.runId = args.runId; return; }
      if (name.endsWith("updateMetadataInternal")) { Object.assign(custom, args.fields); return custom; }
      assert.fail(`Unexpected mutation ${name}`);
    },
    scheduler: { async runAfter() {} },
  };
  try {
    await (ensureGeneratedCaptionsTrackInternal as any)._handler(ctx, { muxAssetId: "asset", userId: "owner", attempt: 0 });
    assert.equal(custom.aiCaptionsGeneratedAtMs, undefined);
    asset.tracks.push({ id: "exact", type: "text", status: "preparing", language_code: "en" });
    await (ensureGeneratedCaptionsTrackInternal as any)._handler(ctx, { muxAssetId: "asset", userId: "owner", attempt: 1 });
    assert.equal(custom.aiCaptionsGeneratedAtMs, undefined);
    asset.tracks[1].status = "ready";
    await (ensureGeneratedCaptionsTrackInternal as any)._handler(ctx, { muxAssetId: "asset", userId: "owner", attempt: 2 });
    assert.equal(custom.aiCaptionsTrackId, "exact");
    assert.equal(typeof custom.aiCaptionsGeneratedAtMs, "number");
    assert.equal(postCount, 1);
    assert.equal(requests.some(url => url.includes("edit-captions")), false);
    // Simulate an accepted POST whose response was lost: the permanent claim
    // blocks a second POST even though no run id could be persisted.
    claim = undefined;
    for (const key of Object.keys(custom)) if (key.startsWith("ai")) delete custom[key];
    globalThis.fetch = (async () => { postCount++; throw new Error("accepted POST response timeout"); }) as any;
    await (ensureGeneratedCaptionsTrackInternal as any)._handler(ctx, { muxAssetId: "asset", userId: "owner", attempt: 0 });
    await (ensureGeneratedCaptionsTrackInternal as any)._handler(ctx, { muxAssetId: "asset", userId: "owner", attempt: 9 });
    assert.equal(postCount, 2);
    assert.match(custom.aiCaptionsUnavailableReason, /outcome unknown/);
    delete custom.aiCaptionsUnavailableReason;
    claim.runId = "run";
    globalThis.fetch = (async () => Response.json({ data: { status: "errored", node_states: [{ reference_id: "premium_captions", status: "failed", reason: "Existing English track conflict" }] } })) as any;
    await (ensureGeneratedCaptionsTrackInternal as any)._handler(ctx, { muxAssetId: "asset", userId: "owner", attempt: 0 });
    assert.equal(custom.aiCaptionsUnavailableReason, "Existing English track conflict");
  } finally { globalThis.fetch = originalFetch; delete (globalThis as any).__directiveTestAsset; }
});
