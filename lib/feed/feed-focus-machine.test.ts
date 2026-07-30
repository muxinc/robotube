import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_FEED_FOCUS_TIMINGS,
  createFeedFocusState,
  feedFocusReducer,
  isPlaybackAllowed,
  selectCandidateIndex,
  TOP_LOCK_OFFSET_PX,
  type FeedFocusEvent,
  type FeedFocusState,
} from "./feed-focus-machine";

const timings = DEFAULT_FEED_FOCUS_TIMINGS;

/** Applies a script of events and returns the final state plus the last delay. */
function run(
  initial: FeedFocusState,
  events: FeedFocusEvent[],
): { state: FeedFocusState; scheduleSettleInMs: number | null } {
  let state = initial;
  let scheduleSettleInMs: number | null = null;
  for (const event of events) {
    const transition = feedFocusReducer(state, event, timings);
    state = transition.state;
    scheduleSettleInMs = transition.scheduleSettleInMs;
  }
  return { state, scheduleSettleInMs };
}

/** A list scrolled away from the top, so the top-lock rule is not in play. */
function baseState(overrides: Partial<FeedFocusState> = {}) {
  return createFeedFocusState({
    itemCount: 50,
    idleSinceMs: 0,
    offsetY: 2_000,
    ...overrides,
  });
}

describe("selectCandidateIndex", () => {
  it("picks the lowest viewable index", () => {
    assert.equal(selectCandidateIndex([7, 5, 6], 900), 5);
  });

  it("pins to the first row while the list is at the top", () => {
    assert.equal(selectCandidateIndex([3, 4], TOP_LOCK_OFFSET_PX), 0);
    assert.equal(selectCandidateIndex([3, 4], TOP_LOCK_OFFSET_PX + 1), 3);
  });

  it("returns null when nothing is viewable", () => {
    assert.equal(selectCandidateIndex([], 500), null);
  });
});

describe("candidate to committed transitions", () => {
  it("commits an idle candidate once the dwell threshold passes", () => {
    const first = feedFocusReducer(
      baseState(),
      { type: "viewable", indexes: [4], nowMs: 1_000 },
      timings,
    );
    assert.equal(first.state.candidateIndex, 4);
    assert.equal(first.state.committedIndex, null, "dwell not met yet");
    assert.equal(first.scheduleSettleInMs, timings.dwellMs);

    const second = feedFocusReducer(
      first.state,
      { type: "settleElapsed", nowMs: 1_000 + timings.dwellMs },
      timings,
    );
    assert.equal(second.state.committedIndex, 4);
    assert.equal(second.scheduleSettleInMs, null);
  });

  it("does not re-stamp the idle clock on repeated dwell checks", () => {
    // Regression: re-stamping idleSinceMs on every settleElapsed reset the dwell
    // window forever and the feed never committed.
    const { state } = run(baseState({ scrollPhase: "settling" }), [
      { type: "viewable", indexes: [2], nowMs: 0 },
      { type: "settleElapsed", nowMs: 100 },
      { type: "settleElapsed", nowMs: 100 + timings.dwellMs },
    ]);
    assert.equal(state.committedIndex, 2);
  });
});

describe("scroll begin/end and momentum behaviour", () => {
  it("never commits while dragging", () => {
    const { state } = run(baseState(), [
      { type: "dragBegin" },
      { type: "viewable", indexes: [3], nowMs: 1_000 },
      { type: "viewable", indexes: [9], nowMs: 5_000 },
    ]);
    assert.equal(state.candidateIndex, 9, "candidate still tracks the viewport");
    assert.equal(state.committedIndex, null, "no commit during a drag");
  });

  it("never commits while momentum is running", () => {
    const { state } = run(baseState(), [
      { type: "dragBegin" },
      { type: "dragEnd", nowMs: 100 },
      { type: "momentumBegin" },
      { type: "viewable", indexes: [12], nowMs: 900 },
      { type: "viewable", indexes: [31], nowMs: 1_800 },
    ]);
    assert.equal(state.committedIndex, null);
  });

  it("commits only the card the fling landed on", () => {
    const { state } = run(baseState(), [
      { type: "dragBegin" },
      { type: "momentumBegin" },
      { type: "viewable", indexes: [8], nowMs: 100 },
      { type: "viewable", indexes: [17], nowMs: 200 },
      { type: "viewable", indexes: [26], nowMs: 300 },
      { type: "momentumEnd", nowMs: 400 },
      { type: "settleElapsed", nowMs: 400 + timings.settleAfterMomentumMs },
      {
        type: "settleElapsed",
        nowMs: 400 + timings.settleAfterMomentumMs + timings.dwellMs,
      },
    ]);
    assert.equal(state.committedIndex, 26, "only the landing card commits");
  });

  it("schedules the settle delay the phase asks for", () => {
    assert.equal(
      feedFocusReducer(baseState(), { type: "dragEnd", nowMs: 0 }, timings)
        .scheduleSettleInMs,
      timings.settleAfterDragMs,
    );
    assert.equal(
      feedFocusReducer(baseState(), { type: "momentumEnd", nowMs: 0 }, timings)
        .scheduleSettleInMs,
      timings.settleAfterMomentumMs,
    );
  });

  it("tracks scroll direction from the content offset", () => {
    const forward = run(baseState(), [{ type: "scroll", offsetY: 2_400 }]);
    assert.equal(forward.state.direction, "forward");
    const backward = feedFocusReducer(
      forward.state,
      { type: "scroll", offsetY: 2_100 },
      timings,
    );
    assert.equal(backward.state.direction, "backward");
    const unchanged = feedFocusReducer(
      backward.state,
      { type: "scroll", offsetY: 2_100 },
      timings,
    );
    assert.equal(unchanged.state.direction, "backward", "a resting scroll keeps direction");
  });
});

describe("tab focus and app state", () => {
  it("blocks playback and commits when the screen is not focused", () => {
    const { state } = run(baseState({ committedIndex: 2, candidateIndex: 2 }), [
      { type: "screenFocusChange", isFocused: false, nowMs: 1_000 },
      { type: "viewable", indexes: [6], nowMs: 2_000 },
      { type: "settleElapsed", nowMs: 9_000 },
    ]);
    assert.equal(isPlaybackAllowed(state), false);
    assert.equal(state.committedIndex, 2, "commit is frozen, not cleared");
  });

  it("blocks playback while the app is backgrounded", () => {
    const { state } = run(baseState({ committedIndex: 1 }), [
      { type: "appStateChange", isActive: false, nowMs: 500 },
    ]);
    assert.equal(isPlaybackAllowed(state), false);
  });

  it("re-commits to the current candidate after foregrounding", () => {
    // Foregrounding must not autoplay a stale offscreen card: the candidate the
    // viewport actually shows wins.
    const backgrounded = run(baseState({ committedIndex: 1, candidateIndex: 1 }), [
      { type: "appStateChange", isActive: false, nowMs: 0 },
      { type: "viewable", indexes: [14], nowMs: 100 },
    ]).state;
    assert.equal(backgrounded.committedIndex, 1);

    const { state } = run(backgrounded, [
      { type: "appStateChange", isActive: true, nowMs: 5_000 },
      { type: "settleElapsed", nowMs: 5_000 + timings.dwellMs },
    ]);
    assert.equal(state.committedIndex, 14);
  });

  it("blocks commits when autoplay policy is off", () => {
    const { state } = run(baseState(), [
      { type: "autoplayPolicyChange", isAllowed: false, nowMs: 0 },
      { type: "viewable", indexes: [3], nowMs: 100 },
      { type: "settleElapsed", nowMs: 9_000 },
    ]);
    assert.equal(state.committedIndex, null);
    assert.equal(isPlaybackAllowed(state), false);
  });
});

describe("list invalidation", () => {
  it("drops focus that falls outside a shrinking list", () => {
    const { state } = run(baseState({ committedIndex: 40, candidateIndex: 40 }), [
      { type: "itemCountChange", itemCount: 10, nowMs: 1_000 },
    ]);
    assert.equal(state.committedIndex, null);
    assert.equal(state.candidateIndex, null);
  });

  it("keeps focus stable when pagination appends items", () => {
    const { state } = run(baseState({ itemCount: 16, committedIndex: 3, candidateIndex: 3 }), [
      { type: "itemCountChange", itemCount: 28, nowMs: 1_000 },
    ]);
    assert.equal(state.committedIndex, 3, "pagination must not interrupt playback");
  });

  it("releases the commitment when the committed row loses its surface", () => {
    const { state } = run(baseState({ committedIndex: 5, candidateIndex: 5 }), [
      { type: "surfaceLost", index: 5, nowMs: 1_000 },
    ]);
    assert.equal(state.committedIndex, null);
  });

  it("ignores surface loss reported by a non-committed row", () => {
    const { state } = run(baseState({ committedIndex: 5, candidateIndex: 5 }), [
      { type: "surfaceLost", index: 9, nowMs: 1_000 },
    ]);
    assert.equal(state.committedIndex, 5);
  });
});

describe("exactly-one-playing invariant", () => {
  it("never exposes more than one committed index across a full scroll script", () => {
    let state = baseState();
    const script: FeedFocusEvent[] = [
      { type: "viewable", indexes: [0], nowMs: 0 },
      { type: "settleElapsed", nowMs: timings.dwellMs },
      { type: "dragBegin" },
      { type: "viewable", indexes: [1], nowMs: 400 },
      { type: "viewable", indexes: [2], nowMs: 500 },
      { type: "dragEnd", nowMs: 600 },
      { type: "momentumBegin" },
      { type: "viewable", indexes: [7], nowMs: 700 },
      { type: "momentumEnd", nowMs: 800 },
      { type: "settleElapsed", nowMs: 880 },
      { type: "settleElapsed", nowMs: 1_100 },
    ];
    const committedOverTime: (number | null)[] = [];
    for (const event of script) {
      state = feedFocusReducer(state, event, timings).state;
      committedOverTime.push(state.committedIndex);
      assert.ok(
        state.committedIndex === null ||
          (state.committedIndex >= 0 && state.committedIndex < state.itemCount),
        "committed index must stay in range",
      );
    }
    assert.deepEqual(
      committedOverTime,
      [null, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7],
      "focus holds card 0 through the whole fling and only moves once settled",
    );
  });
});
