import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_FEED_FOCUS_TIMINGS,
  createFeedFocusState,
  feedFocusReducer,
  isScrollActive,
  type FeedFocusEvent,
  type FeedFocusState,
} from "@/lib/feed/feed-focus-machine";
import {
  SHORTS_RETAINED_PAGES,
  resolveShortsDrawDistance,
} from "@/lib/shorts/shorts-viewport";

/**
 * Fling invariants for the Shorts feed.
 *
 * The single `MuxVideoView` lives inside the committed cell, so a long enough
 * fling scrolls that cell past the retention window and FlashList recycles it out
 * from under the player. These tests pin down what happens next, because the
 * acceptance criterion is that **no source replacement occurs during a fling**:
 *
 *  1. losing the surface drops the commitment, and
 *  2. nothing can re-commit while the list is still moving, and
 *  3. the replacement therefore happens once, after the list settles.
 *
 * A source replacement is only ever issued from a non-null committed target, so
 * proving (2) proves the counter cannot move mid-fling.
 */

/** Tracks how many times a committed target would have been handed to the player. */
function drive(events: readonly FeedFocusEvent[], initial?: Partial<FeedFocusState>) {
  let state = createFeedFocusState({ itemCount: 20, ...initial });
  const commits: (number | null)[] = [];
  const scheduled: (number | null)[] = [];

  for (const event of events) {
    const previousCommitted = state.committedIndex;
    const transition = feedFocusReducer(state, event, DEFAULT_FEED_FOCUS_TIMINGS);
    state = transition.state;
    scheduled.push(transition.scheduleSettleInMs);
    if (state.committedIndex !== previousCommitted) {
      commits.push(state.committedIndex);
    }
  }

  return { state, commits, scheduled };
}

/** Commits index 0 the way a settled first page does. */
const SETTLE_ON_FIRST_PAGE: FeedFocusEvent[] = [
  { type: "viewable", indexes: [0], nowMs: 0 },
  { type: "settleElapsed", nowMs: 1000 },
];

/**
 * A settle takes two ticks whenever the candidate is newer than the idle clock:
 * the first one enters idle and reports the remaining dwell, and the hook's timer
 * sends the second. Modelling both is what makes these tests match runtime.
 */
function settleWithDwell(nowMs: number): FeedFocusEvent[] {
  return [
    { type: "settleElapsed", nowMs },
    { type: "settleElapsed", nowMs: nowMs + DEFAULT_FEED_FOCUS_TIMINGS.dwellMs },
  ];
}

describe("shorts fling: surface loss during momentum", () => {
  it("commits the first page once the list is idle", () => {
    const { state, commits } = drive(SETTLE_ON_FIRST_PAGE);
    assert.equal(state.committedIndex, 0);
    assert.deepEqual(commits, [0]);
  });

  it("drops the commitment when the committed cell is recycled mid-fling", () => {
    const { state } = drive([
      ...SETTLE_ON_FIRST_PAGE,
      { type: "dragBegin" },
      { type: "momentumBegin" },
      // FlashList recycles the committed cell; its MuxVideoView unmounts.
      { type: "surfaceLost", index: 0, nowMs: 1100 },
    ]);
    assert.equal(state.committedIndex, null);
  });

  it("issues no new commitment while momentum is still running", () => {
    // No committed target means no source replacement: this is the invariant.
    const { commits } = drive([
      ...SETTLE_ON_FIRST_PAGE,
      { type: "dragBegin" },
      { type: "momentumBegin" },
      { type: "surfaceLost", index: 0, nowMs: 1100 },
      // A long fling keeps reporting viewable pages as it flies past them.
      { type: "scroll", offsetY: 800 },
      { type: "viewable", indexes: [1], nowMs: 1150 },
      { type: "scroll", offsetY: 1600 },
      { type: "viewable", indexes: [2], nowMs: 1200 },
      { type: "scroll", offsetY: 6400 },
      { type: "viewable", indexes: [8], nowMs: 1400 },
    ]);
    assert.deepEqual(
      commits,
      [0, null],
      "the initial commit, then losing it — nothing new mid-fling",
    );
  });

  it("commits exactly once after the fling settles", () => {
    const { state, commits } = drive([
      ...SETTLE_ON_FIRST_PAGE,
      { type: "dragBegin" },
      { type: "momentumBegin" },
      { type: "surfaceLost", index: 0, nowMs: 1100 },
      { type: "scroll", offsetY: 6400 },
      { type: "viewable", indexes: [8], nowMs: 1400 },
      { type: "momentumEnd", nowMs: 1500 },
      ...settleWithDwell(2000),
    ]);
    assert.equal(state.committedIndex, 8);
    assert.deepEqual(commits, [0, null, 8], "one teardown, then one commit");
  });

  it("reports the remaining dwell instead of committing mid-settle", () => {
    // The scheduled follow-up is what the hook's timer turns into the second
    // tick; without it a fling would end on a page that never commits.
    const { scheduled, state } = drive([
      ...SETTLE_ON_FIRST_PAGE,
      { type: "dragBegin" },
      { type: "momentumBegin" },
      { type: "surfaceLost", index: 0, nowMs: 1100 },
      { type: "viewable", indexes: [8], nowMs: 1400 },
      { type: "momentumEnd", nowMs: 1500 },
      { type: "settleElapsed", nowMs: 2000 },
    ]);
    assert.equal(state.committedIndex, null, "dwell is not satisfied yet");
    assert.equal(
      scheduled.at(-1),
      DEFAULT_FEED_FOCUS_TIMINGS.dwellMs,
      "the machine asks to be re-checked rather than dropping the candidate",
    );
  });

  it("keeps the list marked as scrolling for the whole fling", () => {
    // `isScrollActive` is what gates playback off during the fling, so audio
    // never runs over pages sliding out of the viewport.
    let state = createFeedFocusState({ itemCount: 20 });
    for (const event of [
      ...SETTLE_ON_FIRST_PAGE,
      { type: "dragBegin" },
      { type: "momentumBegin" },
    ] as FeedFocusEvent[]) {
      state = feedFocusReducer(state, event, DEFAULT_FEED_FOCUS_TIMINGS).state;
    }
    assert.equal(isScrollActive(state), true);

    state = feedFocusReducer(
      state,
      { type: "momentumEnd", nowMs: 1500 },
      DEFAULT_FEED_FOCUS_TIMINGS,
    ).state;
    assert.equal(isScrollActive(state), true, "still settling");

    state = feedFocusReducer(
      state,
      { type: "settleElapsed", nowMs: 2000 },
      DEFAULT_FEED_FOCUS_TIMINGS,
    ).state;
    assert.equal(isScrollActive(state), false);
  });

  it("ignores a surface loss reported for a cell that is not committed", () => {
    // The outgoing cell detaching during a normal hand-off must not disturb the
    // new commitment.
    const { state } = drive([
      ...SETTLE_ON_FIRST_PAGE,
      { type: "surfaceLost", index: 5, nowMs: 1100 },
    ]);
    assert.equal(state.committedIndex, 0);
  });

  it("re-commits the same page when a short fling returns to it", () => {
    const { state, commits } = drive([
      ...SETTLE_ON_FIRST_PAGE,
      { type: "dragBegin" },
      { type: "momentumBegin" },
      { type: "surfaceLost", index: 0, nowMs: 1100 },
      { type: "scroll", offsetY: 40 },
      { type: "viewable", indexes: [0], nowMs: 1200 },
      { type: "momentumEnd", nowMs: 1300 },
      ...settleWithDwell(1800),
    ]);
    assert.equal(state.committedIndex, 0);
    assert.deepEqual(commits, [0, null, 0]);
  });
});

describe("shorts fling: retention window", () => {
  it("retains more than the visible page so a short fling keeps the surface", () => {
    assert.ok(
      SHORTS_RETAINED_PAGES >= 2,
      "one page of retention recycles the committed cell on any overscroll",
    );
  });

  it("keeps retention bounded so a 50-item run stays within memory targets", () => {
    const pageHeight = 759;
    assert.ok(resolveShortsDrawDistance(pageHeight) <= pageHeight * 3);
  });

  it("scales retention with the measured page, not a fixed pixel guess", () => {
    assert.ok(resolveShortsDrawDistance(1000) > resolveShortsDrawDistance(500));
  });
});
