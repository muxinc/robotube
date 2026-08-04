/**
 * Pure viewer-intent state for the Shorts feed: session sound state, manual
 * pause/resume, and recoverable playback failures.
 *
 * This is what separates "the feed may play" (owned by the focus machine's
 * lifecycle/policy gating) from "the viewer wants this to play". Keeping it
 * pure makes the tricky rules — a swipe cancels a manual pause, a failed item
 * must not silently retry, reduced motion suppresses autoplay but not a manual
 * press — testable without a player.
 *
 * No React and no react-native imports.
 */

/**
 * Explicit intent for the committed asset. `default` means "follow policy",
 * which is autoplay when policy allows it and paused-with-poster when it does
 * not.
 */
export type ShortsPlaybackIntent = "default" | "play" | "pause";

export type ShortsPlaybackIntentState = {
  /** Session-scoped sound state. Shorts always opens muted. */
  isMuted: boolean;
  intent: ShortsPlaybackIntent;
  /** The asset `intent` applies to. Intent never leaks to another asset. */
  intentMuxAssetId: string | null;
  /** Asset whose source failed and has not been retried yet. */
  failedMuxAssetId: string | null;
  /**
   * Per-asset retry counters. The playback controller watches its slot's
   * counter (via `shortsRetryNonceFor`) to re-load a source it already
   * considers loaded. Keyed by asset — a global nonce would leak a retry made
   * on one page into every other slot's source key and force a reload at the
   * moment a prepared standby page is promoted.
   */
  retryNonces: Readonly<Record<string, number>>;
};

export type ShortsPlaybackIntentEvent =
  | { type: "toggleMute" }
  /** `isPlaying` is the currently observed state, so the toggle can invert it. */
  | { type: "togglePlayback"; muxAssetId: string; isPlaying: boolean }
  | { type: "committedChanged"; muxAssetId: string | null }
  | { type: "playbackFailed"; muxAssetId: string }
  | { type: "retryRequested"; muxAssetId: string };

export function createShortsPlaybackIntentState(
  overrides: Partial<ShortsPlaybackIntentState> = {},
): ShortsPlaybackIntentState {
  return {
    isMuted: true,
    intent: "default",
    intentMuxAssetId: null,
    failedMuxAssetId: null,
    retryNonces: {},
    ...overrides,
  };
}

export function shortsPlaybackIntentReducer(
  state: ShortsPlaybackIntentState,
  event: ShortsPlaybackIntentEvent,
): ShortsPlaybackIntentState {
  switch (event.type) {
    case "toggleMute":
      return { ...state, isMuted: !state.isMuted };

    case "togglePlayback":
      // A failed asset keeps its failure: recovery goes through `retryRequested`
      // so a tap on a broken page cannot silently re-request a dead source.
      return {
        ...state,
        intent: event.isPlaying ? "pause" : "play",
        intentMuxAssetId: event.muxAssetId,
      };

    case "committedChanged": {
      // Swiping to a new video always resumes the policy default: a pause
      // gesture applies to the video it was made on, not to the feed.
      const keepsIntent =
        event.muxAssetId !== null && state.intentMuxAssetId === event.muxAssetId;
      const keepsFailure =
        event.muxAssetId !== null && state.failedMuxAssetId === event.muxAssetId;
      const nextIntent = keepsIntent ? state.intent : "default";
      const nextIntentMuxAssetId = keepsIntent ? state.intentMuxAssetId : null;
      const nextFailedMuxAssetId = keepsFailure ? state.failedMuxAssetId : null;
      // Commits are dispatched from an effect on every focus change, so an
      // unchanged result must keep its identity or the screen re-renders for
      // nothing on each settle.
      if (
        nextIntent === state.intent &&
        nextIntentMuxAssetId === state.intentMuxAssetId &&
        nextFailedMuxAssetId === state.failedMuxAssetId
      ) {
        return state;
      }
      return {
        ...state,
        intent: nextIntent,
        intentMuxAssetId: nextIntentMuxAssetId,
        failedMuxAssetId: nextFailedMuxAssetId,
      };
    }

    case "playbackFailed":
      if (state.failedMuxAssetId === event.muxAssetId) return state;
      return { ...state, failedMuxAssetId: event.muxAssetId };

    case "retryRequested":
      return {
        ...state,
        failedMuxAssetId:
          state.failedMuxAssetId === event.muxAssetId
            ? null
            : state.failedMuxAssetId,
        // A retry is an explicit play request for that asset.
        intent: "play",
        intentMuxAssetId: event.muxAssetId,
        retryNonces: {
          ...state.retryNonces,
          [event.muxAssetId]: shortsRetryNonceFor(state, event.muxAssetId) + 1,
        },
      };
  }
}

/** Retry counter for one asset; feeds that asset's slot `sourceAttempt`. */
export function shortsRetryNonceFor(
  state: ShortsPlaybackIntentState,
  muxAssetId: string | null,
): number {
  if (muxAssetId === null) return 0;
  return state.retryNonces[muxAssetId] ?? 0;
}

export type ShortsShouldPlayInputs = {
  state: ShortsPlaybackIntentState;
  /** Committed asset, or null when nothing may play. */
  muxAssetId: string | null;
  /** Focus machine gate: screen focused, app active, surface intact. */
  isFocusPlaybackAllowed: boolean;
  /** Policy gate: reduced motion, low data, offline, memory pressure. */
  isAutoplayAllowed: boolean;
};

/**
 * Whether the committed asset should be playing right now.
 *
 * Scrolling deliberately does NOT pause: the committed video keeps playing
 * while the viewer drags toward the next page, and the hand-off happens when
 * focus commits and the source swaps. That is the TikTok/Reels feel — pausing
 * on touch made every swipe start from a frozen frame plus a pause/play cycle.
 * A long fling is still bounded: once the committed cell leaves the retention
 * window it is recycled, the surface detaches, and playback stops.
 *
 * Ordering matters: the hard gates (no target, lifecycle, unrecovered error)
 * come first and cannot be overridden by intent, then an explicit press wins
 * over policy, and only then does autoplay policy decide. That last step is
 * what lets reduced motion disable autoplay while still allowing a manual
 * press to play.
 */
export function resolveShortsShouldPlay({
  state,
  muxAssetId,
  isFocusPlaybackAllowed,
  isAutoplayAllowed,
}: ShortsShouldPlayInputs): boolean {
  if (muxAssetId === null) return false;
  if (!isFocusPlaybackAllowed) return false;
  if (state.failedMuxAssetId === muxAssetId) return false;

  const intent = resolveShortsIntentFor(state, muxAssetId);
  if (intent === "pause") return false;
  if (intent === "play") return true;
  return isAutoplayAllowed;
}

/** The intent that applies to one asset, ignoring intent held for another. */
export function resolveShortsIntentFor(
  state: ShortsPlaybackIntentState,
  muxAssetId: string,
): ShortsPlaybackIntent {
  return state.intentMuxAssetId === muxAssetId ? state.intent : "default";
}

/**
 * Whether the pause affordance should read as paused.
 *
 * This is the *viewer-visible* paused state, so it deliberately ignores
 * transient scroll pauses: a page that is only paused because the list is still
 * settling must not flash a pause badge on every swipe.
 */
export function isShortsAssetPausedByViewer(
  state: ShortsPlaybackIntentState,
  muxAssetId: string | null,
  isAutoplayAllowed: boolean,
): boolean {
  if (muxAssetId === null) return false;
  if (state.failedMuxAssetId === muxAssetId) return false;
  const intent = resolveShortsIntentFor(state, muxAssetId);
  if (intent === "pause") return true;
  if (intent === "play") return false;
  return !isAutoplayAllowed;
}
