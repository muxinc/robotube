import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EMPTY_SHORTS_SLOT_ASSIGNMENT,
  resolveShortsSlotAssignment,
  resolveShortsStandbyIndex,
} from "./shorts-player-slots";

describe("shorts standby index", () => {
  it("prepares the next page in the direction of travel", () => {
    assert.equal(resolveShortsStandbyIndex(10, 3, "forward"), 4);
    assert.equal(resolveShortsStandbyIndex(10, 3, "backward"), 2);
    // No direction yet (fresh feed) defaults forward.
    assert.equal(resolveShortsStandbyIndex(10, 0, "none"), 1);
  });

  it("falls back to the other neighbour at the ends of the feed", () => {
    assert.equal(resolveShortsStandbyIndex(10, 9, "forward"), 8);
    assert.equal(resolveShortsStandbyIndex(10, 0, "backward"), 1);
  });

  it("returns null when there is nothing to prepare", () => {
    assert.equal(resolveShortsStandbyIndex(1, 0, "forward"), null);
    assert.equal(resolveShortsStandbyIndex(10, null, "forward"), null);
  });
});

describe("shorts slot assignment", () => {
  it("binds the first commit cold and prepares the standby beside it", () => {
    const next = resolveShortsSlotAssignment(
      EMPTY_SHORTS_SLOT_ASSIGNMENT,
      "v1",
      "v2",
    );
    assert.equal(next[next.active!], "v1");
    const standbySlot = next.active === "a" ? "b" : "a";
    assert.equal(next[standbySlot], "v2");
  });

  it("promotes the prepared slot without rebinding it", () => {
    const initial = resolveShortsSlotAssignment(
      EMPTY_SHORTS_SLOT_ASSIGNMENT,
      "v1",
      "v2",
    );
    const standbySlot = initial.active === "a" ? "b" : "a";

    // Swipe to v2: its slot becomes active with the same binding, and the
    // vacated slot leapfrogs to the new prediction v3.
    const promoted = resolveShortsSlotAssignment(initial, "v2", "v3");
    assert.equal(promoted.active, standbySlot);
    assert.equal(promoted[standbySlot], "v2");
    assert.equal(promoted[initial.active!], "v3");
  });

  it("promotes backward the same way", () => {
    const initial = resolveShortsSlotAssignment(
      EMPTY_SHORTS_SLOT_ASSIGNMENT,
      "v2",
      "v3",
    );
    // Direction flips: standby rebinds to v1, then the viewer swipes back.
    const flipped = resolveShortsSlotAssignment(initial, "v2", "v1");
    const back = resolveShortsSlotAssignment(flipped, "v1", "v0");
    assert.equal(back[back.active!], "v1");
    const standbySlot = back.active === "a" ? "b" : "a";
    assert.equal(back[standbySlot], "v0");
  });

  it("never evicts a slot that already holds the desired standby", () => {
    // A fling lands on a cold page while one slot happens to hold the next
    // prediction: the other slot must take the committed asset.
    const previous = { a: "v5", b: "v9", active: "a" } as const;
    const next = resolveShortsSlotAssignment(previous, "v8", "v9");
    assert.equal(next.b, "v9");
    assert.equal(next.a, "v8");
    assert.equal(next.active, "a");
  });

  it("rebinds the previously playing slot when both are stale", () => {
    const previous = { a: "v1", b: "v2", active: "a" } as const;
    const next = resolveShortsSlotAssignment(previous, "v7", "v8");
    // The playing slot takes the new page so old audio stops with the rebind;
    // the other slot takes the prediction.
    assert.equal(next.a, "v7");
    assert.equal(next.active, "a");
    assert.equal(next.b, "v8");
  });

  it("holds only the committed asset on a one-item feed", () => {
    const next = resolveShortsSlotAssignment(
      EMPTY_SHORTS_SLOT_ASSIGNMENT,
      "v1",
      "v1",
    );
    assert.equal(next[next.active!], "v1");
    const standbySlot = next.active === "a" ? "b" : "a";
    assert.equal(next[standbySlot], null);
  });

  it("releases both slots when nothing is committed", () => {
    const previous = { a: "v1", b: "v2", active: "a" } as const;
    const next = resolveShortsSlotAssignment(previous, null, null);
    assert.deepEqual(next, EMPTY_SHORTS_SLOT_ASSIGNMENT);
  });

  it("keeps identity when nothing moved", () => {
    const first = resolveShortsSlotAssignment(
      EMPTY_SHORTS_SLOT_ASSIGNMENT,
      "v1",
      "v2",
    );
    const second = resolveShortsSlotAssignment(first, "v1", "v2");
    assert.equal(second, first);
  });
});
