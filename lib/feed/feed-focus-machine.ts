/**
 * Pure candidate/committed focus state machine for the news feed.
 *
 * PRD section 7.1: viewability callbacks may update a cheap *candidate* value
 * while the user scrolls, but they must never create, release, attach, replace,
 * play, or pause a native player. Only a *committed* focus change is allowed to
 * touch playback, and a commit requires all of:
 *
 *   - the list is idle (not dragging, not in momentum, not settling);
 *   - the same candidate has met the dwell threshold;
 *   - the screen is focused and the app is active;
 *   - autoplay is enabled by policy; and
 *   - the candidate is still within the rendered range.
 *
 * This module has no React and no react-native imports so it can be unit tested
 * directly with `node --test`.
 */

export type FeedScrollPhase = "idle" | "dragging" | "momentum" | "settling";

export type FeedFocusTimings = {
  /** Quiet period after a drag ends with no momentum. */
  settleAfterDragMs: number;
  /** Quiet period after momentum ends. */
  settleAfterMomentumMs: number;
  /**
   * How long a candidate must remain the candidate before it may be committed.
   * Measured from the moment the candidate index last changed.
   */
  dwellMs: number;
};

export const DEFAULT_FEED_FOCUS_TIMINGS: FeedFocusTimings = {
  settleAfterDragMs: 120,
  settleAfterMomentumMs: 80,
  dwellMs: 120,
};

/**
 * Scroll offsets at or below this value pin the candidate to the first row so
 * pull-to-top always focuses the first eligible card.
 */
export const TOP_LOCK_OFFSET_PX = 12;

export type FeedFocusState = {
  scrollPhase: FeedScrollPhase;
  offsetY: number;
  itemCount: number;
  isScreenFocused: boolean;
  isAppActive: boolean;
  isAutoplayAllowed: boolean;
  /** Cheap value updated by viewability during scroll. Never touches playback. */
  candidateIndex: number | null;
  /** Timestamp of the last candidate *change*, used for the dwell check. */
  candidateSinceMs: number | null;
  /** Timestamp at which the list last became idle. */
  idleSinceMs: number | null;
  /** The only index allowed to own a player surface. */
  committedIndex: number | null;
  /** Last scroll direction, used by the preload policy. */
  direction: FeedScrollDirection;
};

export type FeedScrollDirection = "forward" | "backward" | "none";

export type FeedFocusEvent =
  | { type: "viewable"; indexes: readonly number[]; nowMs: number }
  | { type: "scroll"; offsetY: number }
  | { type: "dragBegin" }
  | { type: "dragEnd"; nowMs: number }
  | { type: "momentumBegin" }
  | { type: "momentumEnd"; nowMs: number }
  | { type: "settleElapsed"; nowMs: number }
  | { type: "screenFocusChange"; isFocused: boolean; nowMs: number }
  | { type: "appStateChange"; isActive: boolean; nowMs: number }
  | { type: "autoplayPolicyChange"; isAllowed: boolean; nowMs: number }
  | { type: "itemCountChange"; itemCount: number; nowMs: number }
  | { type: "surfaceLost"; index: number; nowMs: number };

export type FeedFocusTransition = {
  state: FeedFocusState;
  /**
   * Delay after which the caller should send a `settleElapsed` event, or null
   * when no timer is required. The hook owns the actual timer.
   */
  scheduleSettleInMs: number | null;
};

export function createFeedFocusState(
  overrides: Partial<FeedFocusState> = {},
): FeedFocusState {
  return {
    scrollPhase: "idle",
    offsetY: 0,
    itemCount: 0,
    isScreenFocused: true,
    isAppActive: true,
    isAutoplayAllowed: true,
    candidateIndex: null,
    candidateSinceMs: null,
    idleSinceMs: 0,
    committedIndex: null,
    direction: "none",
    ...overrides,
  };
}

/**
 * True when the state permits playback at all. Distinct from committed focus:
 * losing tab focus pauses the active player but keeps the committed surface, so
 * returning to the tab does not pay for a native attach/detach cycle.
 */
export function isPlaybackAllowed(state: FeedFocusState): boolean {
  return state.isScreenFocused && state.isAppActive && state.isAutoplayAllowed;
}

/** True while the list is doing scroll work that must not be interrupted. */
export function isScrollActive(state: FeedFocusState): boolean {
  return state.scrollPhase !== "idle";
}

export function feedFocusReducer(
  state: FeedFocusState,
  event: FeedFocusEvent,
  timings: FeedFocusTimings = DEFAULT_FEED_FOCUS_TIMINGS,
): FeedFocusTransition {
  switch (event.type) {
    case "scroll": {
      const direction =
        event.offsetY > state.offsetY
          ? "forward"
          : event.offsetY < state.offsetY
            ? "backward"
            : state.direction;
      return settle({ ...state, offsetY: event.offsetY, direction }, null, timings);
    }

    case "viewable": {
      const nextCandidate = selectCandidateIndex(event.indexes, state.offsetY);
      if (nextCandidate === null) return settle(state, null, timings);
      if (nextCandidate === state.candidateIndex) {
        return settle(state, event.nowMs, timings);
      }
      return settle(
        {
          ...state,
          candidateIndex: nextCandidate,
          candidateSinceMs: event.nowMs,
        },
        event.nowMs,
        timings,
      );
    }

    case "dragBegin":
      return {
        state: { ...state, scrollPhase: "dragging", idleSinceMs: null },
        scheduleSettleInMs: null,
      };

    case "momentumBegin":
      return {
        state: { ...state, scrollPhase: "momentum", idleSinceMs: null },
        scheduleSettleInMs: null,
      };

    case "dragEnd":
      return {
        state: { ...state, scrollPhase: "settling", idleSinceMs: null },
        scheduleSettleInMs: timings.settleAfterDragMs,
      };

    case "momentumEnd":
      return {
        state: { ...state, scrollPhase: "settling", idleSinceMs: null },
        scheduleSettleInMs: timings.settleAfterMomentumMs,
      };

    case "settleElapsed":
      return settle(
        {
          ...state,
          scrollPhase: "idle",
          // Only stamp the idle clock on the transition *into* idle. Re-stamping
          // it on every dwell re-check would reset the dwell window forever.
          idleSinceMs: state.scrollPhase === "idle" ? state.idleSinceMs : event.nowMs,
        },
        event.nowMs,
        timings,
      );

    case "screenFocusChange":
      return settle(
        { ...state, isScreenFocused: event.isFocused },
        event.nowMs,
        timings,
      );

    case "appStateChange":
      return settle({ ...state, isAppActive: event.isActive }, event.nowMs, timings);

    case "autoplayPolicyChange":
      return settle(
        { ...state, isAutoplayAllowed: event.isAllowed },
        event.nowMs,
        timings,
      );

    case "itemCountChange": {
      const itemCount = Math.max(0, event.itemCount);
      const candidateIndex =
        state.candidateIndex !== null && state.candidateIndex >= itemCount
          ? null
          : state.candidateIndex;
      const committedIndex =
        state.committedIndex !== null && state.committedIndex >= itemCount
          ? null
          : state.committedIndex;
      return settle(
        { ...state, itemCount, candidateIndex, committedIndex },
        event.nowMs,
        timings,
      );
    }

    case "surfaceLost": {
      // The committed row was recycled or unmounted out from under the player.
      // Drop the commitment so the next idle evaluation can rebuild it.
      if (state.committedIndex !== event.index) {
        return settle(state, event.nowMs, timings);
      }
      return settle({ ...state, committedIndex: null }, event.nowMs, timings);
    }
  }
}

/**
 * Lowest fully-eligible viewable index, or index 0 when the list is pinned to
 * the top. Returns null when nothing is viewable.
 */
export function selectCandidateIndex(
  indexes: readonly number[],
  offsetY: number,
): number | null {
  let lowest: number | null = null;
  for (const index of indexes) {
    if (index === null || index === undefined || !Number.isFinite(index)) continue;
    if (index < 0) continue;
    if (lowest === null || index < lowest) lowest = index;
  }
  if (lowest === null) return null;
  return offsetY <= TOP_LOCK_OFFSET_PX ? 0 : lowest;
}

/**
 * Apply the commit rules. When every precondition except dwell is satisfied,
 * this returns the remaining dwell time so the caller can re-evaluate instead of
 * silently dropping the candidate.
 */
function settle(
  state: FeedFocusState,
  nowMs: number | null,
  timings: FeedFocusTimings,
): FeedFocusTransition {
  if (state.scrollPhase !== "idle") {
    return { state, scheduleSettleInMs: null };
  }
  if (!isPlaybackAllowed(state)) {
    return { state, scheduleSettleInMs: null };
  }
  const candidateIndex = state.candidateIndex;
  if (candidateIndex === null) return { state, scheduleSettleInMs: null };
  if (state.itemCount > 0 && candidateIndex >= state.itemCount) {
    return { state, scheduleSettleInMs: null };
  }
  if (candidateIndex === state.committedIndex) {
    return { state, scheduleSettleInMs: null };
  }
  if (nowMs === null) return { state, scheduleSettleInMs: null };

  const stableSinceMs = Math.max(
    state.candidateSinceMs ?? nowMs,
    state.idleSinceMs ?? nowMs,
  );
  const dwellElapsedMs = nowMs - stableSinceMs;
  if (dwellElapsedMs < timings.dwellMs) {
    return { state, scheduleSettleInMs: timings.dwellMs - dwellElapsedMs };
  }

  return {
    state: { ...state, committedIndex: candidateIndex },
    scheduleSettleInMs: null,
  };
}
