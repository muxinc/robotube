import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

const action = read("convex/videoDeletion.ts");
const cleanup = read("convex/libraryReset.ts");
const cache = read("convex/muxAssetCache.ts");
const schema = read("convex/schema.ts");
const componentPatch = read("patches/convex-mux-component+0.1.11.patch");
const mobileProfile = read("app/(tabs)/profile.tsx");
const webApp = read("web/src/App.tsx");

test("video deletion requires authentication and matching owner metadata", () => {
  assert.match(action, /getAuthUserId\(ctx\)/);
  assert.match(action, /metadata\?\.userId !== userId/);
  assert.match(action, /do not have permission to delete it/);
});

test("Mux deletion happens before Convex data is purged and supports safe retry", () => {
  const muxDelete = action.indexOf("mux.video.assets.delete");
  const appCleanup = action.indexOf("deleteVideoDataInternal");
  const componentCleanup = action.indexOf("deleteVideoByMuxAssetIdPublic");

  assert.ok(muxDelete >= 0);
  assert.ok(appCleanup > muxDelete);
  assert.ok(componentCleanup > appCleanup);
  assert.match(action, /errorStatus\(error\) !== 404/);
});

test("Convex cleanup covers asset-scoped data and preserves a deletion tombstone", () => {
  for (const table of [
    "videoEmbeddings",
    "videoChatThreads",
    "audioTranslationJobs",
    "captionTranslationJobs",
    "aiMetadataLocks",
    "moderationLocks",
  ]) {
    assert.match(cleanup, new RegExp(`"${table}"`));
  }
  assert.match(cleanup, /status: "deleted"/);
  assert.match(cleanup, /isDeleted: true/);
  assert.match(cache, /reason: "deleted_tombstone"/);
  assert.match(schema, /videoChatThreads:[\s\S]*\.index\("by_asset", \["muxAssetId"\]\)/);
});

test("the Mux component patch hard-deletes component asset metadata", () => {
  assert.match(componentPatch, /deleteVideoByMuxAssetIdPublic/);
  assert.match(componentPatch, /query\("videoMetadata"\)/);
  assert.match(componentPatch, /ctx\.db\.delete\(metadata\._id\)/);
  assert.match(componentPatch, /ctx\.db\.delete\(asset\._id\)/);
});

test("web and mobile expose confirmed owner deletion controls", () => {
  for (const source of [webApp, mobileProfile]) {
    assert.match(source, /videoDeletion\.deleteOwnVideo/);
    assert.match(source, /deleteOwnVideo\(\{ muxAssetId:/);
    assert.match(source, /cannot be undone/i);
  }
  assert.match(webApp, /window\.confirm/);
  assert.match(mobileProfile, /style: "destructive"/);
});
