import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createShortsPlaybackIntentState,
  isShortsAssetPausedByViewer,
  resolveShortsIntentFor,
  resolveShortsShouldPlay,
  shortsPlaybackIntentReducer,
  shortsRetryNonceFor,
  type ShortsPlaybackIntentEvent,
  type ShortsPlaybackIntentState,
} from "./shorts-playback-intent";

function reduce(
  state: ShortsPlaybackIntentState,
  ...events: ShortsPlaybackIntentEvent[]
): ShortsPlaybackIntentState {
  return events.reduce(shortsPlaybackIntentReducer, state);
}

function playInputs(
  state: ShortsPlaybackIntentState,
  overrides: Partial<Parameters<typeof resolveShortsShouldPlay>[0]> = {},
) {
  return {
    state,
    muxAssetId: "a",
    isFocusPlaybackAllowed: true,
    isAutoplayAllowed: true,
    ...overrides,
  };
}

describe("shorts session sound state", () => {
  it("opens muted", () => {
    assert.equal(createShortsPlaybackIntentState().isMuted, true);
  });

  it("toggles for the whole session, not for one asset", () => {
    const unmuted = reduce(createShortsPlaybackIntentState(), { type: "toggleMute" });
    assert.equal(unmuted.isMuted, false);

    const afterSwipe = reduce(unmuted, {
      type: "committedChanged",
      muxAssetId: "b",
    });
    assert.equal(afterSwipe.isMuted, false);
  });

  it("survives a retry and a manual pause", () => {
    const state = reduce(
      createShortsPlaybackIntentState(),
      { type: "toggleMute" },
      { type: "togglePlayback", muxAssetId: "a", isPlaying: true },
      { type: "playbackFailed", muxAssetId: "a" },
      { type: "retryRequested", muxAssetId: "a" },
    );
    assert.equal(state.isMuted, false);
  });

  it("toggles back", () => {
    const state = reduce(
      createShortsPlaybackIntentState(),
      { type: "toggleMute" },
      { type: "toggleMute" },
    );
    assert.equal(state.isMuted, true);
  });
});

describe("shorts manual pause and resume", () => {
  it("pauses the playing asset on toggle", () => {
    const state = reduce(createShortsPlaybackIntentState(), {
      type: "togglePlayback",
      muxAssetId: "a",
      isPlaying: true,
    });
    assert.equal(resolveShortsIntentFor(state, "a"), "pause");
    assert.equal(resolveShortsShouldPlay(playInputs(state)), false);
  });

  it("resumes a paused asset on the next toggle", () => {
    const state = reduce(
      createShortsPlaybackIntentState(),
      { type: "togglePlayback", muxAssetId: "a", isPlaying: true },
      { type: "togglePlayback", muxAssetId: "a", isPlaying: false },
    );
    assert.equal(resolveShortsIntentFor(state, "a"), "play");
    assert.equal(resolveShortsShouldPlay(playInputs(state)), true);
  });

  it("never applies one asset's intent to another", () => {
    const state = reduce(createShortsPlaybackIntentState(), {
      type: "togglePlayback",
      muxAssetId: "a",
      isPlaying: true,
    });
    assert.equal(resolveShortsIntentFor(state, "b"), "default");
    assert.equal(
      resolveShortsShouldPlay(playInputs(state, { muxAssetId: "b" })),
      true,
    );
  });

  it("clears a manual pause when the viewer swipes to another video", () => {
    const state = reduce(
      createShortsPlaybackIntentState(),
      { type: "togglePlayback", muxAssetId: "a", isPlaying: true },
      { type: "committedChanged", muxAssetId: "b" },
    );
    assert.equal(state.intent, "default");
    assert.equal(state.intentMuxAssetId, null);
    assert.equal(
      resolveShortsShouldPlay(playInputs(state, { muxAssetId: "b" })),
      true,
    );
  });

  it("keeps a manual pause when focus re-commits the same video", () => {
    // Returning from video detail, or a surface-loss re-commit, must not start
    // playing something the viewer deliberately paused.
    const state = reduce(
      createShortsPlaybackIntentState(),
      { type: "togglePlayback", muxAssetId: "a", isPlaying: true },
      { type: "committedChanged", muxAssetId: "a" },
    );
    assert.equal(resolveShortsIntentFor(state, "a"), "pause");
    assert.equal(resolveShortsShouldPlay(playInputs(state)), false);
  });

  it("reports the viewer-visible paused state", () => {
    const paused = reduce(createShortsPlaybackIntentState(), {
      type: "togglePlayback",
      muxAssetId: "a",
      isPlaying: true,
    });
    assert.equal(isShortsAssetPausedByViewer(paused, "a", true), true);
    assert.equal(isShortsAssetPausedByViewer(paused, "b", true), false);
    assert.equal(
      isShortsAssetPausedByViewer(createShortsPlaybackIntentState(), "a", true),
      false,
    );
  });
});

describe("shorts lifecycle and scroll gating", () => {
  it("does not play without a committed asset", () => {
    assert.equal(
      resolveShortsShouldPlay(
        playInputs(createShortsPlaybackIntentState(), { muxAssetId: null }),
      ),
      false,
    );
  });

  it("does not play when the focus machine forbids it", () => {
    // Tab blur, app background, or a lost surface.
    assert.equal(
      resolveShortsShouldPlay(
        playInputs(createShortsPlaybackIntentState(), {
          isFocusPlaybackAllowed: false,
        }),
      ),
      false,
    );
  });

  it("keeps the committed video playing while the viewer swipes", () => {
    // Scrolling is deliberately not an input: the committed video plays
    // through the drag and hands off when focus commits, like TikTok/Reels.
    assert.equal(
      resolveShortsShouldPlay(playInputs(createShortsPlaybackIntentState())),
      true,
    );
  });

  it("lets lifecycle gating override an explicit play press", () => {
    const state = reduce(createShortsPlaybackIntentState(), {
      type: "togglePlayback",
      muxAssetId: "a",
      isPlaying: false,
    });
    assert.equal(
      resolveShortsShouldPlay(
        playInputs(state, { isFocusPlaybackAllowed: false }),
      ),
      false,
    );
  });
});

describe("shorts autoplay policy", () => {
  it("does not autoplay when policy disallows it", () => {
    assert.equal(
      resolveShortsShouldPlay(
        playInputs(createShortsPlaybackIntentState(), {
          isAutoplayAllowed: false,
        }),
      ),
      false,
    );
  });

  it("still allows a manual press under reduced motion or low data", () => {
    const state = reduce(createShortsPlaybackIntentState(), {
      type: "togglePlayback",
      muxAssetId: "a",
      isPlaying: false,
    });
    assert.equal(
      resolveShortsShouldPlay(playInputs(state, { isAutoplayAllowed: false })),
      true,
    );
  });

  it("shows the paused affordance when autoplay is disabled", () => {
    assert.equal(
      isShortsAssetPausedByViewer(createShortsPlaybackIntentState(), "a", false),
      true,
    );
  });

  it("resets to the policy default on the next video", () => {
    const state = reduce(
      createShortsPlaybackIntentState(),
      { type: "togglePlayback", muxAssetId: "a", isPlaying: false },
      { type: "committedChanged", muxAssetId: "b" },
    );
    assert.equal(
      resolveShortsShouldPlay(
        playInputs(state, { muxAssetId: "b", isAutoplayAllowed: false }),
      ),
      false,
    );
  });
});

describe("shorts playback failures", () => {
  it("stops requesting a failed source", () => {
    const state = reduce(createShortsPlaybackIntentState(), {
      type: "playbackFailed",
      muxAssetId: "a",
    });
    assert.equal(resolveShortsShouldPlay(playInputs(state)), false);
  });

  it("does not block a different asset", () => {
    // One broken item must not stop the viewer paging past it.
    const state = reduce(createShortsPlaybackIntentState(), {
      type: "playbackFailed",
      muxAssetId: "a",
    });
    assert.equal(
      resolveShortsShouldPlay(playInputs(state, { muxAssetId: "b" })),
      true,
    );
  });

  it("does not re-request the source without an explicit retry", () => {
    const state = reduce(
      createShortsPlaybackIntentState(),
      { type: "playbackFailed", muxAssetId: "a" },
      { type: "togglePlayback", muxAssetId: "a", isPlaying: false },
    );
    assert.equal(state.failedMuxAssetId, "a");
    assert.equal(resolveShortsShouldPlay(playInputs(state)), false);
  });

  it("clears the failure and bumps that asset's nonce on retry", () => {
    const state = reduce(
      createShortsPlaybackIntentState(),
      { type: "playbackFailed", muxAssetId: "a" },
      { type: "retryRequested", muxAssetId: "a" },
    );
    assert.equal(state.failedMuxAssetId, null);
    assert.equal(shortsRetryNonceFor(state, "a"), 1);
    // The nonce is per-asset: another slot's source key must not change, or a
    // prepared standby page would reload at the moment it is promoted.
    assert.equal(shortsRetryNonceFor(state, "b"), 0);
    assert.equal(resolveShortsShouldPlay(playInputs(state)), true);
  });

  it("plays after a retry even when autoplay policy is off", () => {
    const state = reduce(
      createShortsPlaybackIntentState(),
      { type: "playbackFailed", muxAssetId: "a" },
      { type: "retryRequested", muxAssetId: "a" },
    );
    assert.equal(
      resolveShortsShouldPlay(playInputs(state, { isAutoplayAllowed: false })),
      true,
    );
  });

  it("advances the nonce on every retry so a repeat attempt reloads", () => {
    const state = reduce(
      createShortsPlaybackIntentState(),
      { type: "playbackFailed", muxAssetId: "a" },
      { type: "retryRequested", muxAssetId: "a" },
      { type: "playbackFailed", muxAssetId: "a" },
      { type: "retryRequested", muxAssetId: "a" },
    );
    assert.equal(shortsRetryNonceFor(state, "a"), 2);
    assert.equal(state.failedMuxAssetId, null);
  });

  it("clears a failure when the viewer swipes away", () => {
    const state = reduce(
      createShortsPlaybackIntentState(),
      { type: "playbackFailed", muxAssetId: "a" },
      { type: "committedChanged", muxAssetId: "b" },
    );
    assert.equal(state.failedMuxAssetId, null);
  });

  it("keeps a failure while the failed asset stays committed", () => {
    const state = reduce(
      createShortsPlaybackIntentState(),
      { type: "playbackFailed", muxAssetId: "a" },
      { type: "committedChanged", muxAssetId: "a" },
    );
    assert.equal(state.failedMuxAssetId, "a");
  });

  it("ignores a repeated failure report for the same asset", () => {
    const first = reduce(createShortsPlaybackIntentState(), {
      type: "playbackFailed",
      muxAssetId: "a",
    });
    const second = shortsPlaybackIntentReducer(first, {
      type: "playbackFailed",
      muxAssetId: "a",
    });
    assert.equal(second, first, "identity is preserved so React skips a render");
  });

  it("does not show the paused affordance for a failed asset", () => {
    // The error state owns that corner of the overlay.
    const state = reduce(createShortsPlaybackIntentState(), {
      type: "playbackFailed",
      muxAssetId: "a",
    });
    assert.equal(isShortsAssetPausedByViewer(state, "a", true), false);
  });
});

describe("shorts intent state identity", () => {
  it("is unchanged when a commit needs no reset", () => {
    const base = createShortsPlaybackIntentState();
    assert.equal(
      shortsPlaybackIntentReducer(base, {
        type: "committedChanged",
        muxAssetId: null,
      }),
      base,
    );
  });

  it("clears intent when nothing is committed", () => {
    const state = reduce(
      createShortsPlaybackIntentState(),
      { type: "togglePlayback", muxAssetId: "a", isPlaying: true },
      { type: "committedChanged", muxAssetId: null },
    );
    assert.equal(state.intentMuxAssetId, null);
    assert.equal(state.intent, "default");
  });
});
