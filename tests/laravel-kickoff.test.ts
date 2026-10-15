import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { URL } from "node:url";
import { getFunctionName } from "convex/server";

// Resolve the extensionless local imports emitted for the Convex bundler when
// executing the actual mutation handlers with Node's TypeScript stripping.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && context.parentURL?.includes("/convex/")) {
      for (const extension of [".ts", ".js"]) {
        const url = new URL(specifier + extension, context.parentURL);
        if (existsSync(url)) return nextResolve(url.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
const { enqueueForReadyAssetInternal, storeRunInternal } = await import("../convex/laravelKickoff.ts");
const { seedInternal } = await import("../convex/uploadMetadata.ts");
after(() => hooks.deregister());

const envKeys = ["USE_LARAVEL_ORCHESTRATION", "LARAVEL_ORCHESTRATION_URL", "LARAVEL_ORCHESTRATION_SECRET"];
const saved = envKeys.map((key) => process.env[key]);
process.env.USE_LARAVEL_ORCHESTRATION = "true";
process.env.LARAVEL_ORCHESTRATION_URL = "https://orchestrator.example";
process.env.LARAVEL_ORCHESTRATION_SECRET = "test-only-secret";
after(() => envKeys.forEach((key, index) => {
  if (saved[index] === undefined) delete process.env[key];
  else process.env[key] = saved[index];
}));

function fixture(custom: Record<string, unknown> = {}) {
  const state: any = {
    video: { asset: { status: "ready" }, metadata: { userId: "owner", title: "Original", custom } },
    cache: { isDeleted: false }, scheduled: [],
  };
  const ctx = {
    async runQuery(ref: any) {
      try {
        assert.equal(getFunctionName(ref), "muxAssetCache:getByMuxAssetIdInternal");
        return structuredClone(state.cache);
      } catch (error) {
        if (error instanceof assert.AssertionError) throw error;
        return structuredClone(state.video);
      }
    },
    async runMutation(ref: any, args: any) {
      try {
        assert.equal(getFunctionName(ref), "feedReadModel:applyVideoMetadataInternal");
      } catch (error) {
        if (error instanceof assert.AssertionError) throw error;
        Object.assign(state.video.metadata, Object.fromEntries(
          Object.entries(structuredClone(args)).filter(([, value]) => value !== undefined),
        ));
      }
    },
    scheduler: { async runAfter(delay: number, ref: any, args: any) {
      state.scheduled.push({ delay, name: getFunctionName(ref), args });
    } },
  };
  // Convex serializes conflicting mutations. These handlers run against the
  // latest committed fixture state; this is not a simulation of Convex OCC.
  return { state, ctx };
}
const asset = { muxAssetId: "asset-1", userId: "owner" };
const enqueue = (ctx: any) => (enqueueForReadyAssetInternal as any)._handler(ctx, asset);
const seed = (ctx: any, args: any) => (seedInternal as any)._handler(ctx, { ...asset, ...args });
const store = (ctx: any, runId = 42, runStatus = "pending") =>
  (storeRunInternal as any)._handler(ctx, { ...asset, runId, runStatus });

test("ready event and polling fallback schedule one immediate kickoff, in either order", async () => {
  for (const first of ["webhook", "poll"]) {
    const { ctx, state } = fixture({ captionTranslationLanguageCodes: ["es"] });
    assert.deepEqual(await enqueue(ctx), { scheduled: true }, first);
    assert.equal((await enqueue(ctx)).reason, "already_started");
    assert.equal(state.scheduled.length, 1);
    assert.equal(state.scheduled[0].delay, 0);
    assert.equal(state.scheduled[0].name, "laravelOrchestration:startLaravelRobotRun");
    assert.deepEqual(state.video.metadata.custom.captionTranslationLanguageCodes, ["es"]);
  }
});

test("ready replay never restarts an existing run, including terminal runs", async () => {
  for (const status of ["pending", "running", "ready", "failed", "rejected"]) {
    const { ctx, state } = fixture({ laravelRunId: 42, laravelRunStatus: status });
    assert.equal((await enqueue(ctx)).reason, "already_started");
    assert.equal(state.scheduled.length, 0);
  }
});

test("late upload seed preserves the kickoff marker, generated results and published visibility", async () => {
  const { ctx, state } = fixture({ captionTranslationLanguageCodes: [] });
  await enqueue(ctx);
  await store(ctx);
  state.video.metadata.title = "Generated title";
  state.video.metadata.visibility = "public";
  state.video.metadata.custom.moderationPassed = true;
  await seed(ctx, {
    title: "Old upload title", visibility: "private",
    custom: { awaitingMetadataReview: true, captionTranslationLanguageCodes: ["fr"] },
  });
  assert.equal(state.video.metadata.title, "Generated title");
  assert.equal(state.video.metadata.visibility, "public");
  assert.equal(state.video.metadata.custom.moderationPassed, true);
  assert.equal(state.video.metadata.custom.laravelRunId, 42);
  assert.deepEqual(state.video.metadata.custom.captionTranslationLanguageCodes, []);
  assert.equal((await enqueue(ctx)).reason, "already_started");
  assert.equal(state.scheduled.length, 1);
});

test("initial response does not regress a faster Laravel sync or a newer run", async () => {
  const { ctx, state } = fixture({ laravelRunId: 42, laravelRunStatus: "ready", moderationPassed: true });
  await store(ctx);
  assert.equal(state.video.metadata.custom.laravelRunStatus, "ready");
  await store(ctx, 41);
  assert.equal(state.video.metadata.custom.laravelRunId, 42);
  assert.equal(state.video.metadata.custom.moderationPassed, true);
});

test("deleted, unready, or ownerless assets do not schedule a run", async () => {
  for (const kind of ["deleted", "preparing", "ownerless"]) {
    const { ctx, state } = fixture();
    if (kind === "deleted") state.cache.isDeleted = true;
    if (kind === "preparing") state.video.asset.status = "preparing";
    if (kind === "ownerless") state.video.metadata.userId = "default";
    assert.equal((await enqueue(ctx)).scheduled, false);
    assert.equal(state.scheduled.length, 0);
  }
});

test("disabled or unconfigured Laravel leaves no reservation so later kickoff can succeed", async () => {
  const { ctx, state } = fixture();
  process.env.USE_LARAVEL_ORCHESTRATION = "false";
  assert.equal((await enqueue(ctx)).reason, "flag_off");
  process.env.USE_LARAVEL_ORCHESTRATION = "true";
  delete process.env.LARAVEL_ORCHESTRATION_SECRET;
  assert.equal((await enqueue(ctx)).reason, "missing_env");
  process.env.LARAVEL_ORCHESTRATION_SECRET = "test-only-secret";
  assert.deepEqual(await enqueue(ctx), { scheduled: true });
  assert.equal(state.scheduled.length, 1);
});
