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
const { syncRobotRunInternal } = await import("../convex/laravelSync.ts");
const { syncAiMetadataJobInternal } = await import("../convex/aiMetadata.ts");
after(() => hooks.deregister());

test("regenerated chapters survive old Laravel results, while a new run can replace them", async () => {
  let metadata: any = {
    userId: "owner", description: "Existing summary",
    custom: { laravelRunId: 65, laravelRunStatus: "ready", aiChapters: [{ title: "旧章节", startTime: 0 }] },
  };
  const ctx: any = {
    async runQuery() { return { asset: {}, metadata: structuredClone(metadata) }; },
    async runMutation(_ref: any, args: any) {
      if (args.userId) metadata = { ...metadata, ...structuredClone(args) };
    },
  };
  const chapters = [{ title: "Opening conversation", start_time: 0 }];
  await (syncAiMetadataJobInternal as any)._handler(ctx, {
    muxAssetId: "asset", userId: "owner", workflow: "generate-chapters",
    job: { id: "new-english-job", status: "completed", outputs: { chapters } },
  });
  assert.equal(metadata.custom.aiChaptersSupersededLaravelRunId, 65);
  assert.equal(metadata.custom.aiChapters[0].title, "Opening conversation");
  await (syncRobotRunInternal as any)._handler(ctx, {
    muxAssetId: "asset", runId: 65, runStatus: "ready",
    results: { chapters: [{ title: "旧章节", start_time: 0 }], summary: "Updated summary" },
  });
  assert.equal(metadata.custom.aiChapters[0].title, "Opening conversation");
  assert.equal(metadata.description, "Updated summary");
  await (syncRobotRunInternal as any)._handler(ctx, {
    muxAssetId: "asset", runId: 66, runStatus: "ready",
    results: { chapters: [{ title: "New run chapter", start_time: 0 }] },
  });
  assert.equal(metadata.custom.aiChapters[0].title, "New run chapter");
});
