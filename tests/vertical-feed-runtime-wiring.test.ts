/**
 * Runtime rollout wiring contracts for the vertical feed.
 *
 * These source-level checks complement the pure flag resolver tests. They make
 * the safety boundary explicit: one remote snapshot controls the tab, route,
 * and Home query, and a disabled tab cannot mount Shorts work.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

const schema = read("convex/schema.ts");
const runtimeConfig = read("convex/feedRuntimeConfig.ts");
const provider = read("hooks/use-feed-feature-flags.tsx");
const playbackController = read("hooks/use-feed-playback-controller.ts");
const homePlayback = read("hooks/use-feed-screen-playback.ts");
const shortsPlayback = read("hooks/use-shorts-screen-playback.ts");
const tabLayout = read("app/(tabs)/_layout.tsx");
const shortsRoute = read("app/(tabs)/shorts.tsx");
const homeRoute = read("app/(tabs)/index.tsx");
const shortsCell = read("components/shorts-vertical-video-cell.tsx");
const shortsOverlay = read("components/shorts-vertical-video-overlay.tsx");

test("runtime config is a singleton indexed Convex table", () => {
  assert.match(schema, /feedRuntimeConfig:\s*defineTable/);
  assert.match(schema, /key:\s*v\.literal\("vertical-feed"\)/);
  assert.match(schema, /\.index\("by_key",\s*\["key"\]\)/);
});

test("missing runtime config fails closed and unsafe exclusive state is rejected", () => {
  assert.match(runtimeConfig, /shortsTabEnabled:\s*false/);
  assert.match(runtimeConfig, /exclusiveFeedPlacementEnabled:\s*false/);
  assert.match(runtimeConfig, /if\s*\(\s*args\.exclusiveFeedPlacementEnabled\s*&&\s*!args\.shortsTabEnabled/s);
  assert.match(
    runtimeConfig,
    /shortsTabEnabled\s*&&\s*row\.exclusiveFeedPlacementEnabled\s*===\s*true/s,
  );
});

test("one app-wide subscription resolves the shared flag snapshot", () => {
  assert.equal(
    (provider.match(/useQuery\(/g) ?? []).length,
    1,
    "the provider must own exactly one remote subscription",
  );
  assert.match(provider, /resolveFeedFeatureFlags/);
  assert.match(
    provider,
    /resolutions\.shortsTabEnabled\.enabled\s*&&\s*resolutions\.exclusiveFeedPlacementEnabled\.enabled/s,
  );
});

test("disabled Shorts is hidden and direct routes redirect before mounting work", () => {
  assert.match(
    tabLayout,
    /NativeTabs\.Trigger name="shorts" hidden=\{!shortsTabEnabled\}/,
  );
  const guard = shortsRoute.indexOf(
    'if (!shortsTabEnabled) return <Redirect href="/" />;',
  );
  const enabledMount = shortsRoute.indexOf("return <EnabledShortsScreen />;");
  const query = shortsRoute.indexOf("usePaginatedQuery(");
  assert.ok(guard >= 0 && enabledMount > guard && query > enabledMount);
});

test("Home permanently selects only standard placement", () => {
  assert.match(
    homeRoute,
    /usePaginatedQuery\(\s*\/\/[^]*\(api as any\)\.feed\.listStandardFeedVideosPaginated/s,
  );
  assert.doesNotMatch(homeRoute, /listFeedVideosPaginated/);
  assert.doesNotMatch(homeRoute, /exclusiveFeedPlacementEnabled/);
});

test("retained native tabs allocate a player only for the focused feed", () => {
  assert.match(playbackController, /if\s*\(!isPlayerEnabled\)/);
  assert.match(
    playbackController,
    /const nextPlayer = createMuxVideoPlayer\(\)/,
  );
  assert.match(homePlayback, /isPlayerEnabled:\s*isScreenFocused/);
  assert.match(shortsPlayback, /isPlayerEnabled:\s*isScreenFocused/);
});

test("Shorts exposes the Mux player UI without duplicate media controls", () => {
  // The committed page carries Mux's custom controls; the pre-rendered standby
  // page is bare video so no chrome slides in with the swipe.
  assert.match(shortsCell, /controls=\{isActive \? "custom" : "none"\}/);
  assert.doesNotMatch(shortsCell, /pointerEvents="none"[^]*<MuxVideoView/);
  assert.doesNotMatch(shortsOverlay, /onTogglePlayback/);
  assert.doesNotMatch(shortsOverlay, /name=\{isPlaying \? "pause" : "play"\}/);
  assert.match(
    shortsOverlay,
    /Mux's custom controls intentionally do not include a sound button/,
  );
});

test("Shorts is the complete 9:16 experience, not a detail-page handoff", () => {
  for (const source of [shortsRoute, shortsCell, shortsOverlay]) {
    assert.doesNotMatch(source, /\/video\/\[muxAssetId\]/);
    assert.doesNotMatch(source, /shorts_open_detail/);
    assert.doesNotMatch(source, /onOpenDetail/);
  }
});
