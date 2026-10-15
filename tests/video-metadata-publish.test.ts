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
const { updateOwnVideoMetadata } = await import("../convex/videoMetadata.ts");
after(() => hooks.deregister());

function fixture(metadata: Record<string, any>) {
  const writes: any[] = [];
  const ctx = {
    auth: { async getUserIdentity() { return { subject: "owner|session" }; } },
    async runQuery() { return { asset: {}, metadata: { userId: "owner", ...metadata } }; },
    async runMutation(_ref: any, args: any) { writes.push(args); },
  };
  return {
    writes,
    publish: (edits: Record<string, unknown> = {}) =>
      (updateOwnVideoMetadata as any)._handler(ctx, {
        muxAssetId: "asset", title: "My title", publish: true, ...edits,
      }),
  };
}

test("publishing only a title preserves completed summaries and tags", async () => {
  const { publish, writes } = fixture({
    description: "Generated summary", tags: ["animation"],
    custom: { moderationPassed: true, aiUseGeneratedDescription: true, aiSuggestedDescription: "Generated summary" },
  });
  await publish();
  assert.equal(writes[0].description, undefined);
  assert.equal(writes[0].tags, undefined);
  assert.equal(writes[0].custom.aiUseGeneratedDescription, true);
  assert.equal(writes[0].custom.aiUseGeneratedTags, undefined);
  assert.equal(writes[0].visibility, "public");
});

test("publishing before summarization completes leaves later results enabled", async () => {
  const { publish, writes } = fixture({ custom: { moderationPassed: true } });
  await publish();
  assert.equal(writes[0].description, undefined);
  assert.equal(writes[0].tags, undefined);
  assert.equal(writes[0].custom.aiUseGeneratedDescription, undefined);
  assert.equal(writes[0].custom.aiUseGeneratedTags, undefined);
  assert.equal(writes[0].custom.aiUseGeneratedTitle, false);
});

test("explicitly clearing a reviewed draft still prevents Robots from replacing edits", async () => {
  const { publish, writes } = fixture({ custom: { moderationPassed: true } });
  await publish({ description: "", tags: [] });
  assert.equal(writes[0].description, "");
  assert.deepEqual(writes[0].tags, []);
  assert.equal(writes[0].custom.aiUseGeneratedDescription, false);
  assert.equal(writes[0].custom.aiUseGeneratedTags, false);
});

test("publishing still requires ownership and passed moderation", async () => {
  for (const metadata of [
    { userId: "someone-else", custom: { moderationPassed: true } },
    { custom: { moderationPassed: false } },
  ]) {
    const { publish, writes } = fixture(metadata);
    await assert.rejects(publish());
    assert.equal(writes.length, 0);
  }
});
