/**
 * Pure policy that decides what may hold preload resources right now. The
 * caller diffs that against what is currently retained to derive start/cancel
 * work. No React, no react-native, no platform APIs.
 *
 * Rules:
 *   - default window is the committed item plus one direction-aware next item;
 *   - preload work is suspended during a fast fling;
 *   - preload work is suspended when the app backgrounds or the feed loses focus;
 *   - media that becomes distant is dropped from the window;
 *   - active playback always outranks every preload request.
 */

import type { FeedScrollDirection } from "./feed-focus-machine";

export type FeedPreloadCandidate = {
  muxAssetId: string;
  playbackId: string;
  index: number;
};

export type FeedPreloadWindowInputs = {
  committedIndex: number | null;
  direction: FeedScrollDirection;
  itemCount: number;
  preloadAhead: number;
  preloadBehind: number;
  /** False whenever policy, lifecycle, or focus forbids preloading. */
  isPreloadAllowed: boolean;
  /** True while the list is dragging or in momentum. Retained work is preserved. */
  isScrolling: boolean;
  /** True when the scroll is fast enough to be treated as a fling. */
  isFling: boolean;
};

/**
 * Indexes that may hold preload resources, ordered by priority. The committed
 * index is always first so callers that respect ordering give active playback
 * strict priority over preload work.
 */
export function selectPreloadWindow(inputs: FeedPreloadWindowInputs): number[] {
  const {
    committedIndex,
    direction,
    itemCount,
    preloadAhead,
    preloadBehind,
    isPreloadAllowed,
    isFling,
  } = inputs;

  if (!isPreloadAllowed) return [];
  if (isFling) return [];
  if (committedIndex === null) return [];
  if (itemCount <= 0) return [];
  if (committedIndex < 0 || committedIndex >= itemCount) return [];

  const window = [committedIndex];

  const ahead = Math.max(0, Math.trunc(preloadAhead));
  const behind = Math.max(0, Math.trunc(preloadBehind));
  // A backward scroll makes the previous item the "next likely" item.
  const forwardFirst = direction !== "backward";

  const push = (index: number) => {
    if (index < 0 || index >= itemCount) return;
    if (window.includes(index)) return;
    window.push(index);
  };

  if (forwardFirst) {
    for (let step = 1; step <= ahead; step += 1) push(committedIndex + step);
    for (let step = 1; step <= behind; step += 1) push(committedIndex - step);
  } else {
    for (let step = 1; step <= ahead; step += 1) push(committedIndex - step);
    for (let step = 1; step <= behind; step += 1) push(committedIndex + step);
  }

  // `isScrolling` deliberately does not narrow this retained window. On iOS,
  // the warm bytes live in the retained AVPlayerItem itself, so cancelling the
  // likely destination when a gesture begins would guarantee a cold start.
  // A true high-velocity fling is still handled by the `isFling` gate above.

  return window;
}

export type FeedPreloadDiff = {
  /** Cache keys to start, highest priority first. */
  start: string[];
  /** Cache keys whose work must be cancelled and resources released. */
  cancel: string[];
};

/**
 * Diff a desired window against what is currently retained. Anything retained
 * but no longer in the window is distant and must be released.
 */
export function diffPreloadWindow(
  retained: Iterable<string>,
  desired: readonly string[],
): FeedPreloadDiff {
  const desiredSet = new Set(desired);
  const retainedSet = new Set(retained);
  return {
    start: desired.filter((key) => !retainedSet.has(key)),
    cancel: [...retainedSet].filter((key) => !desiredSet.has(key)),
  };
}

export type FeedPreloadCacheKeyInput = {
  playbackId: string;
  maxResolution?: string;
  minResolution?: string;
  renditionOrder?: string;
  clipping?: { assetStartTime?: number; assetEndTime?: number };
};

/**
 * Bounded cache key: playback ID plus the rendition constraints and clipping
 * parameters that change which bytes are fetched. Two requests that would hit
 * the same Mux media playlist share a key; anything else does not.
 */
export function feedPreloadCacheKey({
  playbackId,
  maxResolution,
  minResolution,
  renditionOrder,
  clipping,
}: FeedPreloadCacheKeyInput): string {
  return [
    playbackId,
    maxResolution ?? "",
    minResolution ?? "",
    renditionOrder ?? "default",
    clipping?.assetStartTime ?? "",
    clipping?.assetEndTime ?? "",
  ].join("|");
}

/**
 * A scroll faster than this (in points per second) counts as a fling and
 * suspends all preload work.
 */
export const FLING_VELOCITY_THRESHOLD_PPS = 1200;

export function isFlingVelocity(pointsPerSecond: number): boolean {
  return Math.abs(pointsPerSecond) >= FLING_VELOCITY_THRESHOLD_PPS;
}
