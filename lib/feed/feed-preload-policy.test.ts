import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  diffPreloadWindow,
  feedPreloadCacheKey,
  isFlingVelocity,
  selectPreloadWindow,
  type FeedPreloadWindowInputs,
} from "./feed-preload-policy";
import { createDisabledFeedPreloader } from "./feed-preloader";

function inputs(overrides: Partial<FeedPreloadWindowInputs> = {}): FeedPreloadWindowInputs {
  return {
    committedIndex: 5,
    direction: "forward",
    itemCount: 50,
    preloadAhead: 1,
    preloadBehind: 0,
    isPreloadAllowed: true,
    isScrolling: false,
    isFling: false,
    ...overrides,
  };
}

describe("preload window selection", () => {
  it("defaults to the committed item plus one item ahead", () => {
    assert.deepEqual(selectPreloadWindow(inputs()), [5, 6]);
  });

  it("puts the committed item first so active playback outranks preload", () => {
    assert.equal(selectPreloadWindow(inputs({ preloadAhead: 1, preloadBehind: 1 }))[0], 5);
  });

  it("follows the scroll direction when the user reverses", () => {
    assert.deepEqual(selectPreloadWindow(inputs({ direction: "backward" })), [5, 4]);
  });

  it("clamps the window to the list bounds", () => {
    assert.deepEqual(selectPreloadWindow(inputs({ committedIndex: 49 })), [49]);
    assert.deepEqual(
      selectPreloadWindow(inputs({ committedIndex: 0, direction: "backward" })),
      [0],
    );
  });

  it("never exceeds the current plus next eligible items", () => {
    const window = selectPreloadWindow(inputs({ preloadAhead: 1, preloadBehind: 1 }));
    assert.equal(window.length, 3);
    assert.deepEqual(window, [5, 6, 4]);
  });

  it("suspends every preload during a fling", () => {
    assert.deepEqual(selectPreloadWindow(inputs({ isFling: true })), []);
  });

  it("narrows to the committed item while scrolling", () => {
    assert.deepEqual(selectPreloadWindow(inputs({ isScrolling: true })), [5]);
  });

  it("returns nothing when preloading is disallowed", () => {
    assert.deepEqual(selectPreloadWindow(inputs({ isPreloadAllowed: false })), []);
  });

  it("returns nothing with no committed focus or no items", () => {
    assert.deepEqual(selectPreloadWindow(inputs({ committedIndex: null })), []);
    assert.deepEqual(selectPreloadWindow(inputs({ itemCount: 0 })), []);
    assert.deepEqual(selectPreloadWindow(inputs({ committedIndex: 99 })), []);
  });
});

describe("preload window diffing", () => {
  it("starts new keys and cancels keys that became distant", () => {
    const diff = diffPreloadWindow(["a", "b"], ["b", "c"]);
    assert.deepEqual(diff.start, ["c"]);
    assert.deepEqual(diff.cancel, ["a"]);
  });

  it("is a no-op when the window is unchanged", () => {
    const diff = diffPreloadWindow(["a", "b"], ["a", "b"]);
    assert.deepEqual(diff.start, []);
    assert.deepEqual(diff.cancel, []);
  });

  it("cancels everything when the window empties", () => {
    assert.deepEqual(diffPreloadWindow(["a", "b"], []).cancel, ["a", "b"]);
  });
});

describe("preload cache key", () => {
  it("is stable for identical requests", () => {
    const key = () => feedPreloadCacheKey({ playbackId: "abc", maxResolution: "720p" });
    assert.equal(key(), key());
  });

  it("separates rendition constraints and clipping", () => {
    const base = { playbackId: "abc" };
    const keys = new Set([
      feedPreloadCacheKey(base),
      feedPreloadCacheKey({ ...base, maxResolution: "720p" }),
      feedPreloadCacheKey({ ...base, maxResolution: "1080p" }),
      feedPreloadCacheKey({ ...base, minResolution: "480p" }),
      feedPreloadCacheKey({ ...base, renditionOrder: "desc" }),
      feedPreloadCacheKey({ ...base, clipping: { assetStartTime: 5 } }),
      feedPreloadCacheKey({ ...base, clipping: { assetStartTime: 5, assetEndTime: 9 } }),
    ]);
    assert.equal(keys.size, 7, "every constraint must produce a distinct key");
  });

  it("does not collide across playback ids", () => {
    assert.notEqual(
      feedPreloadCacheKey({ playbackId: "abc" }),
      feedPreloadCacheKey({ playbackId: "abd" }),
    );
  });
});

describe("fling detection", () => {
  it("treats fast scrolls as flings in both directions", () => {
    assert.equal(isFlingVelocity(2_000), true);
    assert.equal(isFlingVelocity(-2_000), true);
    assert.equal(isFlingVelocity(200), false);
  });
});

describe("default (disabled) preloader", () => {
  it("reports that it cannot feed the active player and adds no surfaces", () => {
    const preloader = createDisabledFeedPreloader();
    assert.equal(preloader.isEnabled(), false);
    assert.equal(preloader.capabilities.reusableByActivePlayer, false);
    assert.equal(preloader.capabilities.extraAttachedSurfaces, 0);
  });

  it("tracks and releases the keys the policy hands it", () => {
    const preloader = createDisabledFeedPreloader();
    preloader.start({
      cacheKey: "k1",
      muxAssetId: "a1",
      playbackId: "p1",
      feedIndex: 0,
    });
    preloader.start({
      cacheKey: "k2",
      muxAssetId: "a2",
      playbackId: "p2",
      feedIndex: 1,
    });
    assert.deepEqual(preloader.retainedKeys(), ["k1", "k2"]);

    preloader.cancel("k1");
    assert.deepEqual(preloader.retainedKeys(), ["k2"]);

    preloader.cancelAll();
    assert.deepEqual(preloader.retainedKeys(), [], "backgrounding releases everything");
  });
});
