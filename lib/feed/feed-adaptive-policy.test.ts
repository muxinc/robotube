import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyDevice,
  FEED_MAX_RESOLUTION,
  MAX_THUMBNAIL_WIDTH_PX,
  MIN_THUMBNAIL_WIDTH_PX,
  resolveFeedMediaPolicy,
  resolveThumbnailWidthPx,
  withThumbnailWidth,
  type FeedPolicyInputs,
} from "./feed-adaptive-policy";

function policyInputs(overrides: Partial<FeedPolicyInputs> = {}): FeedPolicyInputs {
  return {
    deviceClass: "standard",
    networkClass: "wifi",
    prefersReducedMotion: false,
    prefersLowData: false,
    ...overrides,
  };
}

describe("device classification", () => {
  it("uses reported memory when the platform provides it", () => {
    const geometry = { shortestSideDp: 430, pixelRatio: 3 };
    assert.equal(
      classifyDevice({ ...geometry, totalMemoryBytes: 2 * 1024 ** 3 }),
      "low",
    );
    assert.equal(
      classifyDevice({ ...geometry, totalMemoryBytes: 4 * 1024 ** 3 }),
      "standard",
    );
    assert.equal(
      classifyDevice({ ...geometry, totalMemoryBytes: 8 * 1024 ** 3 }),
      "high",
    );
  });

  it("falls back to screen geometry", () => {
    assert.equal(classifyDevice({ shortestSideDp: 320, pixelRatio: 2 }), "low");
    assert.equal(classifyDevice({ shortestSideDp: 414, pixelRatio: 2 }), "standard");
    assert.equal(classifyDevice({ shortestSideDp: 430, pixelRatio: 3 }), "high");
  });
});

describe("media policy", () => {
  it("allows muted autoplay on a healthy standard device", () => {
    const policy = resolveFeedMediaPolicy(policyInputs());
    assert.equal(policy.isAutoplayAllowed, true);
    assert.equal(policy.muted, true);
    assert.equal(policy.maxResolution, FEED_MAX_RESOLUTION);
  });

  it("respects reduced motion by disabling autoplay", () => {
    const policy = resolveFeedMediaPolicy(policyInputs({ prefersReducedMotion: true }));
    assert.equal(policy.isAutoplayAllowed, false);
    assert.equal(policy.isMediaPreloadAllowed, false);
  });

  it("respects a low-data preference", () => {
    const policy = resolveFeedMediaPolicy(policyInputs({ prefersLowData: true }));
    assert.equal(policy.isAutoplayAllowed, false);
    assert.equal(policy.isThumbnailPrefetchAllowed, false);
  });

  it("stops autoplay and prefetch when offline", () => {
    const policy = resolveFeedMediaPolicy(policyInputs({ networkClass: "offline" }));
    assert.equal(policy.isAutoplayAllowed, false);
    assert.equal(policy.isThumbnailPrefetchAllowed, false, "thumbnail fallback only");
  });

  it("keeps media preload off unless the network is confirmed wifi", () => {
    for (const networkClass of ["cellular", "constrained", "unknown", "offline"] as const) {
      assert.equal(
        resolveFeedMediaPolicy(policyInputs({ networkClass })).isMediaPreloadAllowed,
        false,
        `${networkClass} must not preload media`,
      );
    }
  });

  it("keeps media preload off on low-tier hardware", () => {
    assert.equal(
      resolveFeedMediaPolicy(policyInputs({ deviceClass: "low" })).isMediaPreloadAllowed,
      false,
    );
  });

  it("backs off under memory pressure", () => {
    const policy = resolveFeedMediaPolicy(
      policyInputs({ pressure: { memory: true } }),
    );
    assert.equal(policy.isAutoplayAllowed, false);
    assert.equal(policy.isMediaPreloadAllowed, false);
    assert.equal(policy.isThumbnailPrefetchAllowed, false);
  });

  it("never widens the preload window past one item ahead", () => {
    const policy = resolveFeedMediaPolicy(policyInputs({ deviceClass: "high" }));
    assert.ok(policy.preloadAhead <= 1);
    assert.equal(policy.preloadBehind, 0);
  });
});

describe("thumbnail sizing", () => {
  it("scales with rendered width and pixel ratio instead of always using 1280", () => {
    assert.equal(resolveThumbnailWidthPx(390, 2), 800);
    assert.equal(resolveThumbnailWidthPx(430, 3), MAX_THUMBNAIL_WIDTH_PX);
  });

  it("clamps to the documented bounds", () => {
    assert.equal(resolveThumbnailWidthPx(100, 1), MIN_THUMBNAIL_WIDTH_PX);
    assert.equal(resolveThumbnailWidthPx(2_000, 3), MAX_THUMBNAIL_WIDTH_PX);
  });

  it("quantises so a feed shares a few cache keys", () => {
    assert.equal(resolveThumbnailWidthPx(391, 2), resolveThumbnailWidthPx(399, 2));
  });

  it("survives bad inputs", () => {
    assert.equal(resolveThumbnailWidthPx(Number.NaN, 3), MIN_THUMBNAIL_WIDTH_PX);
    assert.equal(resolveThumbnailWidthPx(390, Number.NaN), 480);
  });
});

describe("thumbnail url rewriting", () => {
  it("replaces an existing width", () => {
    assert.equal(
      withThumbnailWidth("https://image.mux.com/abc/thumbnail.jpg?width=1280", 640),
      "https://image.mux.com/abc/thumbnail.jpg?width=640",
    );
  });

  it("adds a width when there is no query", () => {
    assert.equal(
      withThumbnailWidth("https://image.mux.com/abc/thumbnail.jpg", 640),
      "https://image.mux.com/abc/thumbnail.jpg?width=640",
    );
  });

  it("preserves other params such as time and token", () => {
    assert.equal(
      withThumbnailWidth(
        "https://image.mux.com/abc/thumbnail.jpg?time=4&width=1280&token=t",
        640,
      ),
      "https://image.mux.com/abc/thumbnail.jpg?time=4&token=t&width=640",
    );
  });

  it("produces one cache path per card and width", () => {
    const url = "https://image.mux.com/abc/thumbnail.jpg?width=1280";
    assert.equal(withThumbnailWidth(url, 640), withThumbnailWidth(url, 640));
  });

  it("passes empty input through untouched", () => {
    assert.equal(withThumbnailWidth("", 640), "");
  });
});
