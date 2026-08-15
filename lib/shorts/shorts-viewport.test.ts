import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MIN_SHORTS_PAGE_HEIGHT_PX,
  SHORTS_EDGE_MARGIN_PX,
  SHORTS_RETAINED_PAGES,
  SHORTS_TAB_BAR_CLEARANCE_PX,
  isUsableShortsPageHeight,
  resolveShortsDrawDistance,
  resolveShortsOverlayInsets,
  resolveShortsPageHeight,
  resolveShortsSnapProps,
} from "./shorts-viewport";

const BASE = {
  measuredHeight: null as number | null,
  windowHeight: 852,
  topInset: 59,
  bottomInset: 34,
};

describe("shorts page height", () => {
  it("prefers the measured content viewport over the window", () => {
    assert.equal(
      resolveShortsPageHeight({ ...BASE, measuredHeight: 700 }),
      700,
    );
  });

  it("does not subtract insets from a real measurement", () => {
    // The measurement already describes whatever the tab navigator handed the
    // screen; subtracting insets again would shrink every page.
    const height = resolveShortsPageHeight({
      ...BASE,
      measuredHeight: 759,
      topInset: 59,
      bottomInset: 34,
    });
    assert.equal(height, 759);
  });

  it("estimates from the window minus insets before the first layout", () => {
    assert.equal(resolveShortsPageHeight(BASE), 852 - 59 - 34);
  });

  it("preserves a fractional measurement exactly", () => {
    // iOS pagingEnabled snaps by the scroll view's real frame height. Rounding
    // the item height would drift by the discarded fraction on every page and
    // eventually leave the list resting between two items. A 3x device makes
    // thirds-of-a-point viewport heights the normal case.
    assert.equal(
      resolveShortsPageHeight({ ...BASE, measuredHeight: 759.6666666666666 }),
      759.6666666666666,
    );
    assert.equal(
      resolveShortsPageHeight({ ...BASE, measuredHeight: 758.3333333333334 }),
      758.3333333333334,
    );
  });

  it("keeps the item height and the Android snap interval identical", () => {
    const measuredHeight = 759.6666666666666;
    const pageHeight = resolveShortsPageHeight({ ...BASE, measuredHeight });
    const snap = resolveShortsSnapProps(pageHeight, "android");
    assert.equal(snap.snapToInterval, pageHeight);
    assert.equal(snap.snapToInterval, measuredHeight);
  });

  it("accumulates no drift across many pages", () => {
    const measuredHeight = 759.6666666666666;
    const pageHeight = resolveShortsPageHeight({ ...BASE, measuredHeight });
    // The 40th page boundary must land exactly on the 40th item's offset.
    assert.equal(pageHeight * 40, measuredHeight * 40);
  });

  it("preserves a fractional estimate before the first layout", () => {
    assert.equal(
      resolveShortsPageHeight({
        ...BASE,
        windowHeight: 852.5,
        topInset: 0,
        bottomInset: 0,
      }),
      852.5,
    );
  });

  it("ignores a zero or collapsed measurement", () => {
    assert.equal(resolveShortsPageHeight({ ...BASE, measuredHeight: 0 }), 759);
    assert.equal(resolveShortsPageHeight({ ...BASE, measuredHeight: 12 }), 759);
    assert.equal(resolveShortsPageHeight({ ...BASE, measuredHeight: -400 }), 759);
  });

  it("ignores non-finite measurements and window heights", () => {
    assert.equal(
      resolveShortsPageHeight({ ...BASE, measuredHeight: Number.NaN }),
      759,
    );
    assert.equal(
      resolveShortsPageHeight({
        measuredHeight: null,
        windowHeight: Number.NaN,
        topInset: 0,
        bottomInset: 0,
      }),
      MIN_SHORTS_PAGE_HEIGHT_PX,
    );
  });

  it("falls back to the raw window when insets would collapse the page", () => {
    // A bogus inset report must not produce an unusable page height.
    assert.equal(
      resolveShortsPageHeight({
        measuredHeight: null,
        windowHeight: 400,
        topInset: 300,
        bottomInset: 300,
      }),
      400,
    );
  });

  it("never returns less than a usable page", () => {
    assert.equal(
      resolveShortsPageHeight({
        measuredHeight: null,
        windowHeight: 0,
        topInset: 0,
        bottomInset: 0,
      }),
      MIN_SHORTS_PAGE_HEIGHT_PX,
    );
  });

  it("treats a landscape rotation as a new measurement, not a new asset", () => {
    // Same inputs shape, different orientation: only the height changes, which
    // is the value the list re-derives its snap interval from.
    const portrait = resolveShortsPageHeight({ ...BASE, measuredHeight: 759 });
    const landscape = resolveShortsPageHeight({
      measuredHeight: 359,
      windowHeight: 393,
      topInset: 0,
      bottomInset: 21,
    });
    assert.equal(portrait, 759);
    assert.equal(landscape, 359);
    assert.notEqual(portrait, landscape);
  });

  it("ignores a collapsed measurement during a rotation transition", () => {
    // Mid-rotation layout passes can report 0 before settling. Falling back to
    // the window estimate keeps the page usable instead of collapsing it.
    assert.ok(
      resolveShortsPageHeight({ ...BASE, measuredHeight: 0 }) >=
        MIN_SHORTS_PAGE_HEIGHT_PX,
    );
  });

  it("classifies usable heights", () => {
    assert.equal(isUsableShortsPageHeight(759), true);
    assert.equal(isUsableShortsPageHeight(MIN_SHORTS_PAGE_HEIGHT_PX), true);
    assert.equal(isUsableShortsPageHeight(0), false);
    assert.equal(isUsableShortsPageHeight(null), false);
  });
});

describe("shorts snap configuration", () => {
  it("uses native paging on iOS", () => {
    const props = resolveShortsSnapProps(759, "ios");
    assert.equal(props.pagingEnabled, true);
    assert.equal(props.decelerationRate, "fast");
    // pagingEnabled and snapToInterval share one native snap path; setting both
    // double-snaps.
    assert.equal(props.snapToInterval, undefined);
  });

  it("uses a viewport-sized snap interval on Android", () => {
    // React Native's pagingEnabled does not support vertical pagination there.
    const props = resolveShortsSnapProps(759, "android");
    assert.equal(props.pagingEnabled, false);
    assert.equal(props.snapToInterval, 759);
    assert.equal(props.snapToAlignment, "start");
    assert.equal(props.disableIntervalMomentum, true);
    assert.equal(props.decelerationRate, "fast");
  });

  it("keeps one page per swipe on every non-iOS platform", () => {
    for (const os of ["android", "web", "windows"]) {
      const props = resolveShortsSnapProps(600, os);
      assert.equal(props.disableIntervalMomentum, true, os);
      assert.equal(props.snapToInterval, 600, os);
    }
  });
});

describe("shorts draw distance", () => {
  it("retains more than one page so a short reverse fling keeps the surface", () => {
    // The single MuxVideoView lives in the committed cell, so retention is what
    // stops a fling from recycling the cell out from under the player.
    assert.equal(SHORTS_RETAINED_PAGES, 2);
    assert.equal(resolveShortsDrawDistance(759), 1518);
  });

  it("rounds up so a fractional page is fully covered", () => {
    assert.equal(resolveShortsDrawDistance(759.6666666666666), 1520);
  });

  it("stays bounded — retention cannot grow without a memory cost", () => {
    const pageHeight = 759;
    const distance = resolveShortsDrawDistance(pageHeight);
    assert.ok(distance <= pageHeight * 3, "retention window must stay small");
  });

  it("stays bounded for degenerate page heights", () => {
    assert.equal(
      resolveShortsDrawDistance(0),
      MIN_SHORTS_PAGE_HEIGHT_PX * SHORTS_RETAINED_PAGES,
    );
    assert.equal(
      resolveShortsDrawDistance(-10),
      MIN_SHORTS_PAGE_HEIGHT_PX * SHORTS_RETAINED_PAGES,
    );
  });

  it("never retains less than one page", () => {
    assert.equal(resolveShortsDrawDistance(759, 0), 759);
    assert.equal(resolveShortsDrawDistance(759, -5), 759);
  });
});

describe("shorts overlay insets", () => {
  it("only needs an edge margin when the tab bar sits outside the page", () => {
    const insets = resolveShortsOverlayInsets({
      pageHeight: 700,
      windowHeight: 852,
      topInset: 59,
      bottomInset: 34,
    });
    // 852 - 700 - 59 = 93 reserved below, more than clearance + bottom inset.
    assert.equal(insets.paddingBottom, SHORTS_EDGE_MARGIN_PX);
  });

  it("adds clearance when the page runs under the tab bar", () => {
    const insets = resolveShortsOverlayInsets({
      pageHeight: 852,
      windowHeight: 852,
      topInset: 0,
      bottomInset: 34,
    });
    assert.equal(
      insets.paddingBottom,
      SHORTS_EDGE_MARGIN_PX + SHORTS_TAB_BAR_CLEARANCE_PX + 34,
    );
  });

  it("adds only the shortfall when the page is partly inset", () => {
    const insets = resolveShortsOverlayInsets({
      pageHeight: 810,
      windowHeight: 852,
      topInset: 0,
      bottomInset: 34,
    });
    // 42 already reserved against a 52 + 34 requirement.
    assert.equal(
      insets.paddingBottom,
      SHORTS_EDGE_MARGIN_PX + SHORTS_TAB_BAR_CLEARANCE_PX + 34 - 42,
    );
  });

  it("keeps the top overlay below the status bar", () => {
    const insets = resolveShortsOverlayInsets({
      pageHeight: 759,
      windowHeight: 852,
      topInset: 59,
      bottomInset: 34,
    });
    assert.equal(insets.paddingTop, 59 + SHORTS_EDGE_MARGIN_PX);
  });

  it("survives negative and non-finite inset reports", () => {
    const insets = resolveShortsOverlayInsets({
      pageHeight: Number.NaN,
      windowHeight: -1,
      topInset: -20,
      bottomInset: Number.NaN,
    });
    assert.ok(insets.paddingTop >= SHORTS_EDGE_MARGIN_PX);
    assert.ok(insets.paddingBottom >= SHORTS_EDGE_MARGIN_PX);
    assert.ok(Number.isFinite(insets.paddingTop));
    assert.ok(Number.isFinite(insets.paddingBottom));
  });

  it("never returns padding that would push controls off the page", () => {
    const insets = resolveShortsOverlayInsets({
      pageHeight: 400,
      windowHeight: 852,
      topInset: 0,
      bottomInset: 0,
    });
    assert.ok(insets.paddingBottom < 400);
  });
});
