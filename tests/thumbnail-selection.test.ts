import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { URL } from "node:url";

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
const { syncThumbnailSelectionJobInternal } = await import("../convex/thumbnailSelection.ts");
after(() => hooks.deregister());

function fixture(custom: Record<string, unknown>) {
  let metadata: any = { userId: "owner", title: "Kept title", custom };
  const ctx: any = {
    async runQuery() { return { asset: {}, metadata: structuredClone(metadata) }; },
    async runMutation(_ref: any, args: any) {
      if (args.userId) metadata = { ...metadata, ...structuredClone(args) };
    },
  };
  return { ctx, metadata: () => metadata };
}

const sync = (ctx: any, job: unknown) =>
  (syncThumbnailSelectionJobInternal as any)._handler(ctx, {
    muxAssetId: "asset", userId: "owner", job,
  });

test("completed v1 job stores candidates in ms and preselects the top one", async () => {
  const { ctx, metadata } = fixture({ aiThumbnailJobId: "rjob_1", aiThumbnailJobStatus: "processing" });
  await sync(ctx, {
    id: "rjob_1", status: "completed",
    outputs: { best_thumbnails: [
      { time: 12.5, overall: 0.9, description: " Speaker on stage ", subscores: { focus: 0.8, junk: "x" } },
      { time: 3, overall: 0.7 },
    ] },
  });

  const custom = metadata().custom;
  assert.deepEqual(custom.aiThumbnailCandidates, [
    { timestampMs: 12500, overall: 0.9, description: "Speaker on stage", subscores: { focus: 0.8 } },
    { timestampMs: 3000, overall: 0.7, description: null, subscores: {} },
  ]);
  assert.equal(custom.aiThumbnailJobStatus, "completed");
  assert.equal(custom.aiThumbnailProvider, "mux_robots");
  assert.equal(custom.selectedThumbnailTimestampMs, 12500);
  assert.equal(metadata().title, "Kept title");
});

test("an uploader's existing thumbnail choice is kept", async () => {
  const { ctx, metadata } = fixture({ aiThumbnailJobId: "rjob_1", selectedThumbnailTimestampMs: 40000 });
  await sync(ctx, { id: "rjob_1", status: "completed", outputs: { best_thumbnails: [{ time: 1 }] } });
  assert.equal(metadata().custom.selectedThumbnailTimestampMs, 40000);
});

test("v0 timestamp_ms candidates are still accepted", async () => {
  const { ctx, metadata } = fixture({ aiThumbnailJobId: "rjob_v0" });
  await sync(ctx, { id: "rjob_v0", status: "completed", outputs: { best_thumbnails: [{ timestamp_ms: 2500 }] } });
  assert.equal(metadata().custom.aiThumbnailCandidates[0].timestampMs, 2500);
});

test("events for a replaced job are ignored", async () => {
  const { ctx, metadata } = fixture({ aiThumbnailJobId: "rjob_new" });
  const result = await sync(ctx, { id: "rjob_old", status: "completed", outputs: { best_thumbnails: [{ time: 1 }] } });
  assert.equal(result.reason, "job_replaced");
  assert.equal(metadata().custom.aiThumbnailCandidates, undefined);
});

test("a failed job records the error without candidates", async () => {
  const { ctx, metadata } = fixture({ aiThumbnailJobId: "rjob_1" });
  await sync(ctx, { id: "rjob_1", status: "errored", errors: [{ message: "No frames" }] });
  assert.equal(metadata().custom.aiThumbnailJobStatus, "errored");
  assert.equal(metadata().custom.aiThumbnailLastError, "No frames");
  assert.equal(metadata().custom.aiThumbnailCandidates, undefined);
});
