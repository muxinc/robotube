import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SHORTS_PAGINATION_PREFETCH_PAGES,
  SHORTS_VIEWABILITY_CONFIG,
  resolveShortsAnchorIndex,
  resolveShortsListState,
  shouldLoadMoreShorts,
  shouldShowShortsExhaustedNotice,
  type ShortsFeedStatus,
} from "./shorts-paging";

describe("shorts list state", () => {
  it("shows the loading state only before the first page arrives", () => {
    assert.equal(
      resolveShortsListState({ status: "LoadingFirstPage", itemCount: 0 }),
      "loading",
    );
  });

  it("shows the empty state when an answered query returned nothing", () => {
    assert.equal(
      resolveShortsListState({ status: "Exhausted", itemCount: 0 }),
      "empty",
    );
    assert.equal(
      resolveShortsListState({ status: "CanLoadMore", itemCount: 0 }),
      "empty",
    );
  });

  it("never replaces a loaded feed with a loading or empty page", () => {
    // An offline viewer keeps the feed and posters they already have: Convex
    // serves the last result while the socket reconnects.
    for (const status of [
      "LoadingFirstPage",
      "CanLoadMore",
      "LoadingMore",
      "Exhausted",
    ] as ShortsFeedStatus[]) {
      assert.equal(
        resolveShortsListState({ status, itemCount: 4 }),
        "ready",
        status,
      );
    }
  });

  it("treats a negative or non-finite count as empty", () => {
    assert.equal(
      resolveShortsListState({ status: "Exhausted", itemCount: Number.NaN }),
      "empty",
    );
    assert.equal(
      resolveShortsListState({ status: "Exhausted", itemCount: -3 }),
      "empty",
    );
  });
});

describe("shorts pagination trigger", () => {
  const base = {
    status: "CanLoadMore" as ShortsFeedStatus,
    activeIndex: 0,
    itemCount: 16,
  };

  it("starts paginating before the final item", () => {
    // 16 items, lead of 3: fires from index 12 onward, not at index 15.
    assert.equal(shouldLoadMoreShorts({ ...base, activeIndex: 11 }), false);
    assert.equal(shouldLoadMoreShorts({ ...base, activeIndex: 12 }), true);
    assert.equal(shouldLoadMoreShorts({ ...base, activeIndex: 15 }), true);
  });

  it("does nothing unless another page exists", () => {
    for (const status of [
      "LoadingFirstPage",
      "LoadingMore",
      "Exhausted",
    ] as ShortsFeedStatus[]) {
      assert.equal(
        shouldLoadMoreShorts({ ...base, status, activeIndex: 15 }),
        false,
        status,
      );
    }
  });

  it("waits for a real active index", () => {
    assert.equal(shouldLoadMoreShorts({ ...base, activeIndex: null }), false);
    assert.equal(
      shouldLoadMoreShorts({ ...base, activeIndex: Number.NaN }),
      false,
    );
  });

  it("paginates immediately when the first page is shorter than the lead", () => {
    assert.equal(
      shouldLoadMoreShorts({ status: "CanLoadMore", activeIndex: 0, itemCount: 3 }),
      true,
    );
  });

  it("does nothing on an empty list", () => {
    assert.equal(
      shouldLoadMoreShorts({ status: "CanLoadMore", activeIndex: 0, itemCount: 0 }),
      false,
    );
  });

  it("honours an explicit lead", () => {
    assert.equal(
      shouldLoadMoreShorts({ ...base, activeIndex: 14, prefetchPages: 0 }),
      false,
    );
    assert.equal(
      shouldLoadMoreShorts({ ...base, activeIndex: 15, prefetchPages: 0 }),
      true,
    );
  });

  it("uses a lead of a few pages by default", () => {
    assert.ok(SHORTS_PAGINATION_PREFETCH_PAGES >= 1);
    assert.ok(SHORTS_PAGINATION_PREFETCH_PAGES <= 5);
  });
});

describe("shorts exhaustion notice", () => {
  it("only appears on the last page of an exhausted feed", () => {
    assert.equal(
      shouldShowShortsExhaustedNotice({
        status: "Exhausted",
        activeIndex: 9,
        itemCount: 10,
      }),
      true,
    );
    assert.equal(
      shouldShowShortsExhaustedNotice({
        status: "Exhausted",
        activeIndex: 8,
        itemCount: 10,
      }),
      false,
    );
  });

  it("stays hidden while more pages may arrive", () => {
    assert.equal(
      shouldShowShortsExhaustedNotice({
        status: "CanLoadMore",
        activeIndex: 9,
        itemCount: 10,
      }),
      false,
    );
  });

  it("stays hidden with no items or no focus", () => {
    assert.equal(
      shouldShowShortsExhaustedNotice({
        status: "Exhausted",
        activeIndex: 0,
        itemCount: 0,
      }),
      false,
    );
    assert.equal(
      shouldShowShortsExhaustedNotice({
        status: "Exhausted",
        activeIndex: null,
        itemCount: 10,
      }),
      false,
    );
  });
});

describe("shorts anchor index", () => {
  const items = [
    { muxAssetId: "a" },
    { muxAssetId: "b" },
    { muxAssetId: "c" },
  ];

  it("preserves the active asset rather than the scroll offset", () => {
    assert.equal(resolveShortsAnchorIndex(items, "c", 0), 2);
  });

  it("falls back to the clamped last known index when the asset is gone", () => {
    assert.equal(resolveShortsAnchorIndex(items, "missing", 9), 2);
    assert.equal(resolveShortsAnchorIndex(items, "missing", -4), 0);
    assert.equal(resolveShortsAnchorIndex(items, "missing", 1), 1);
  });

  it("returns null when there is nothing to restore", () => {
    assert.equal(resolveShortsAnchorIndex([], "a", 0), null);
    assert.equal(resolveShortsAnchorIndex(items, null, null), null);
  });

  it("keeps the anchor stable when later pages are appended", () => {
    const grown = [...items, { muxAssetId: "d" }, { muxAssetId: "e" }];
    assert.equal(resolveShortsAnchorIndex(grown, "b", 1), 1);
  });

  it("follows an asset that moved position", () => {
    const reordered = [{ muxAssetId: "z" }, ...items];
    assert.equal(resolveShortsAnchorIndex(reordered, "b", 1), 2);
  });
});

describe("shorts viewability config", () => {
  it("requires most of a full-viewport page to be visible", () => {
    // Home's 65% would make both pages viewable mid-swipe.
    assert.ok(SHORTS_VIEWABILITY_CONFIG.itemVisiblePercentThreshold > 65);
    assert.ok(SHORTS_VIEWABILITY_CONFIG.itemVisiblePercentThreshold <= 100);
  });

  it("keeps a dwell window so a fling does not commit every page it passes", () => {
    assert.ok(SHORTS_VIEWABILITY_CONFIG.minimumViewTime > 0);
  });
});
