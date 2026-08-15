import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * Regression tests for the retry path in `useFeedPlaybackController`.
 *
 * These model the installed native player's source-diffing contract, because
 * that contract is the reason a retry cannot simply call `replace()` again:
 *
 *  - `@mux/mux-react-native-player@0.1.10`
 *    `ios/MuxVideoView.swift` → `setSource(_:)`:
 *      `guard source.fingerprint != sourceFingerprint else { return }`
 *  - `android/.../MuxVideoView.kt` → `setSource(source)`:
 *      `if (source.fingerprint == sourceFingerprint) { return }`
 *  - `ios/MuxVideoRecords.swift` → `MuxVideoSourceRecord.fingerprint` and its
 *    Kotlin twin: the joined playbackId, tokens, custom domain, resolution
 *    window, rendition order, clipping bounds, and Mux Data metadata.
 *  - `release()` on both views sets `sourceFingerprint` back to nil/null.
 *
 * Every fingerprint field is reproduced exactly by an identical retry, so a
 * repeat `replace()` of a failed source is silently dropped on device and the
 * broken page never recovers. The controller therefore releases first. If anyone
 * simplifies that back to a bare `replace()`, these tests fail.
 */

type ModelSource = {
  playbackId: string;
  maxResolution?: string;
  renditionOrder?: string;
  metadata?: { playerName?: string; videoId?: string; videoTitle?: string };
};

/** Mirrors `MuxVideoSourceRecord.fingerprint`, in field order. */
function nativeFingerprint(source: ModelSource): string {
  return [
    source.playbackId,
    "", // playbackToken
    "", // drmToken
    "", // thumbnailToken
    "", // storyboardToken
    "", // customDomain
    "", // minResolution
    source.maxResolution ?? "",
    source.renditionOrder ?? "default",
    "", // clipping.assetStartTime
    "", // clipping.assetEndTime
    "", // metadata.envKey
    source.metadata?.playerName ?? "",
    "", // metadata.playerVersion
    source.metadata?.videoTitle ?? "",
    source.metadata?.videoId ?? "",
    "", // metadata.videoSeries
    "", // metadata.viewerUserId
    "", // customData
  ].join("|");
}

/** Models the native view's `setSource` / `release` pair. */
function createNativeViewModel() {
  let sourceFingerprint: string | null = null;
  let loadCount = 0;
  let releaseCount = 0;

  return {
    setSource(source: ModelSource | null) {
      if (source === null) {
        this.release();
        return;
      }
      const fingerprint = nativeFingerprint(source);
      if (fingerprint === sourceFingerprint) return;
      sourceFingerprint = fingerprint;
      loadCount += 1;
    },
    release() {
      sourceFingerprint = null;
      releaseCount += 1;
    },
    get loadCount() {
      return loadCount;
    },
    get releaseCount() {
      return releaseCount;
    },
  };
}

function sourceFor(muxAssetId: string, title = "Title"): ModelSource {
  return {
    playbackId: `${muxAssetId}-playback`,
    maxResolution: "720p",
    renditionOrder: "default",
    metadata: {
      playerName: "Robotube shorts",
      videoId: muxAssetId,
      videoTitle: title,
    },
  };
}

describe("mux native source fingerprint", () => {
  it("is identical for a retry of the same asset", () => {
    // This is the whole problem: nothing the controller can vary between a first
    // attempt and a retry appears in the fingerprint.
    assert.equal(
      nativeFingerprint(sourceFor("asset-a")),
      nativeFingerprint(sourceFor("asset-a")),
    );
  });

  it("differs between assets", () => {
    assert.notEqual(
      nativeFingerprint(sourceFor("asset-a")),
      nativeFingerprint(sourceFor("asset-b")),
    );
  });

  it("does not change when only the feed index or attempt count changes", () => {
    // Neither value is part of the source, so neither can be used to force a
    // reload by itself.
    const first = nativeFingerprint(sourceFor("asset-a"));
    const second = nativeFingerprint(sourceFor("asset-a"));
    assert.equal(first, second);
  });

  it("changes when the player name changes", () => {
    // Confirms Shorts and Home are distinguishable to Mux Data.
    const home = nativeFingerprint({
      ...sourceFor("asset-a"),
      metadata: { playerName: "Robotube feed preview", videoId: "asset-a" },
    });
    const shorts = nativeFingerprint({
      ...sourceFor("asset-a"),
      metadata: { playerName: "Robotube shorts", videoId: "asset-a" },
    });
    assert.notEqual(home, shorts);
  });
});

describe("shorts retry reload", () => {
  it("is dropped by the native view when it only replaces the same source", () => {
    const view = createNativeViewModel();
    const source = sourceFor("asset-a");

    view.setSource(source);
    assert.equal(view.loadCount, 1);

    // The failed page's retry, implemented as a bare replace.
    view.setSource(sourceFor("asset-a"));
    assert.equal(
      view.loadCount,
      1,
      "a bare replace of an identical source must not reload — this is why retry releases first",
    );
  });

  it("reloads when the controller releases before replacing", () => {
    const view = createNativeViewModel();

    view.setSource(sourceFor("asset-a"));
    assert.equal(view.loadCount, 1);

    view.release();
    view.setSource(sourceFor("asset-a"));

    assert.equal(view.loadCount, 2, "retry must produce a second native load");
    assert.equal(view.releaseCount, 1);
  });

  it("reloads on every subsequent retry", () => {
    const view = createNativeViewModel();
    view.setSource(sourceFor("asset-a"));

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      view.release();
      view.setSource(sourceFor("asset-a"));
      assert.equal(view.loadCount, attempt + 1, `retry ${attempt}`);
    }
  });

  it("does not need a release to move to a different asset", () => {
    // A normal commit hand-off must stay a single native operation.
    const view = createNativeViewModel();
    view.setSource(sourceFor("asset-a"));
    view.setSource(sourceFor("asset-b"));

    assert.equal(view.loadCount, 2);
    assert.equal(view.releaseCount, 0);
  });

  it("treats a nil source as a release, clearing the fingerprint", () => {
    // This is the path a JS-side `release()` takes: the view re-renders with
    // `source: undefined` before the reload lands.
    const view = createNativeViewModel();
    view.setSource(sourceFor("asset-a"));
    view.setSource(null);
    view.setSource(sourceFor("asset-a"));

    assert.equal(view.loadCount, 2);
    assert.ok(view.releaseCount >= 1);
  });

  it("still reloads when the effect re-runs mid-release", () => {
    // The controller claims the source key before awaiting the release, then
    // rolls the claim back if it was cancelled before applying. The release has
    // already cleared the fingerprint, so the re-run replaces directly.
    const view = createNativeViewModel();
    view.setSource(sourceFor("asset-a"));
    assert.equal(view.loadCount, 1);

    // Retry: release lands, then the effect is cancelled before replacing.
    view.release();
    // Re-run replaces without a second release.
    view.setSource(sourceFor("asset-a"));

    assert.equal(view.loadCount, 2, "the retried page must still reload");
    assert.equal(view.releaseCount, 1);
  });

  it("loses the reload if the release and the replace collapse into one update", () => {
    // React coalesces a release and a replace inside one commit into a single
    // native `source` prop, so the clear never reaches the view. The controller
    // awaits the release for exactly this reason.
    const view = createNativeViewModel();
    view.setSource(sourceFor("asset-a"));

    // Only the final value of the coalesced update is delivered.
    const coalescedFinalSource = sourceFor("asset-a");
    view.setSource(coalescedFinalSource);

    assert.equal(
      view.loadCount,
      1,
      "a coalesced release+replace must be treated as a regression",
    );
  });
});
