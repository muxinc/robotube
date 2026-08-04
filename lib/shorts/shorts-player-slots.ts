/**
 * Slot assignment for the two-player Shorts stack.
 *
 * Two players leapfrog through the feed: the *active* slot owns the committed
 * page's surface, while the *standby* slot mounts a paused, muted surface
 * inside the predicted next page and loads it to its first frame off-screen.
 * When focus commits to that page, no source replacement happens at all — the
 * standby slot's already-rendered video simply starts playing and the roles
 * swap, with the vacated slot rebinding to the new prediction. This is what
 * removes the thumbnail-then-video flash on swipe: the incoming page shows a
 * real video frame the whole way in.
 *
 * The resolver is pure and identity-stable (returns `previous` unchanged when
 * nothing moved), so it can run during render against a ref.
 *
 * No React and no react-native imports.
 */

import type { FeedScrollDirection } from "@/lib/feed/feed-focus-machine";

export type ShortsSlotId = "a" | "b";

export type ShortsSlotAssignment = {
  /** muxAssetId bound to slot A, or null to release its player. */
  a: string | null;
  /** muxAssetId bound to slot B, or null to release its player. */
  b: string | null;
  /** The slot holding the committed asset — the only slot allowed to play. */
  active: ShortsSlotId | null;
};

export const EMPTY_SHORTS_SLOT_ASSIGNMENT: ShortsSlotAssignment = {
  a: null,
  b: null,
  active: null,
};

/**
 * The index the standby slot should prepare: one page in the direction of
 * travel, falling back to the other neighbour at either end of the feed so a
 * swipe-back from the last page is warm too.
 */
export function resolveShortsStandbyIndex(
  itemCount: number,
  committedIndex: number | null,
  direction: FeedScrollDirection,
): number | null {
  if (committedIndex === null) return null;
  const step = direction === "backward" ? -1 : 1;
  const preferred = committedIndex + step;
  if (preferred >= 0 && preferred < itemCount) return preferred;
  const fallback = committedIndex - step;
  if (fallback >= 0 && fallback < itemCount && fallback !== committedIndex) {
    return fallback;
  }
  return null;
}

export function resolveShortsSlotAssignment(
  previous: ShortsSlotAssignment,
  committedMuxAssetId: string | null,
  standbyMuxAssetId: string | null,
): ShortsSlotAssignment {
  if (committedMuxAssetId === null) {
    return stable(previous, EMPTY_SHORTS_SLOT_ASSIGNMENT);
  }
  // A one-item feed predicts itself; the committed slot already covers it.
  const standby =
    standbyMuxAssetId === committedMuxAssetId ? null : standbyMuxAssetId;

  const active = chooseActiveSlot(previous, committedMuxAssetId, standby);
  const next: ShortsSlotAssignment =
    active === "a"
      ? { a: committedMuxAssetId, b: standby, active }
      : { a: standby, b: committedMuxAssetId, active };
  return stable(previous, next);
}

function chooseActiveSlot(
  previous: ShortsSlotAssignment,
  committedMuxAssetId: string,
  standbyMuxAssetId: string | null,
): ShortsSlotId {
  // The promote path: the slot that prepared this asset becomes active with
  // its loaded source, rendered frame, and buffer intact.
  if (previous.a === committedMuxAssetId) return "a";
  if (previous.b === committedMuxAssetId) return "b";

  // The committed asset is cold. Never evict a slot that already holds the
  // desired standby — it may be mid-load and is exactly what the next swipe
  // needs.
  if (standbyMuxAssetId !== null) {
    if (previous.a === standbyMuxAssetId) return "b";
    if (previous.b === standbyMuxAssetId) return "a";
  }
  if (previous.a === null && previous.b !== null) return "a";
  if (previous.b === null && previous.a !== null) return "b";

  // Both slots are stale (a long fling skipped past both). Rebind the slot
  // that was playing so the old page's audio stops with its rebind.
  return previous.active ?? "a";
}

/** Preserve identity when nothing changed, so render-time use is cheap. */
function stable(
  previous: ShortsSlotAssignment,
  next: ShortsSlotAssignment,
): ShortsSlotAssignment {
  return previous.a === next.a &&
    previous.b === next.b &&
    previous.active === next.active
    ? previous
    : next;
}
