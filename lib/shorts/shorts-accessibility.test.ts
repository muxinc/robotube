import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SHORTS_LABEL_TEXT_MAX_LENGTH,
  SHORTS_MAX_FONT_SIZE_MULTIPLIER,
  SHORTS_MIN_TOUCH_TARGET_PX,
  buildShortsExpandTitleCopy,
  buildShortsOpenDetailCopy,
  buildShortsPlaybackControlCopy,
  buildShortsRetryCopy,
  buildShortsSoundControlCopy,
  buildShortsVideoAccessibilityHint,
  buildShortsVideoAccessibilityLabel,
  clampShortsLabelText,
  formatShortsPosition,
  resolveShortsPlaybackStateLabel,
} from "./shorts-accessibility";

const BASE = {
  title: "Sunset timelapse",
  channelName: "Robotube",
  index: 2,
  itemCount: 12,
  isPlaying: true,
  isMuted: true,
  hasError: false,
};

describe("shorts label text clamping", () => {
  it("collapses whitespace so a pasted description reads as one line", () => {
    assert.equal(
      clampShortsLabelText("  a\n\n  multi   line\ttitle "),
      "a multi line title",
    );
  });

  it("truncates unbounded titles", () => {
    const long = "x".repeat(400);
    const clamped = clampShortsLabelText(long);
    assert.equal(clamped.length, SHORTS_LABEL_TEXT_MAX_LENGTH);
    assert.ok(clamped.endsWith("…"));
  });

  it("leaves a short title untouched", () => {
    assert.equal(clampShortsLabelText("Short"), "Short");
  });

  it("handles missing values", () => {
    assert.equal(clampShortsLabelText(null), "");
    assert.equal(clampShortsLabelText(undefined), "");
    assert.equal(clampShortsLabelText("   "), "");
  });

  it("respects an explicit maximum", () => {
    assert.equal(clampShortsLabelText("abcdefghij", 5), "abcd…");
  });
});

describe("shorts media label", () => {
  it("includes title, channel, position, playback state and sound state", () => {
    const label = buildShortsVideoAccessibilityLabel(BASE);
    assert.match(label, /Sunset timelapse/);
    assert.match(label, /by Robotube/);
    assert.match(label, /Video 3 of 12/);
    assert.match(label, /Playing/);
    assert.match(label, /Muted/);
  });

  it("announces sound-on when unmuted", () => {
    const label = buildShortsVideoAccessibilityLabel({ ...BASE, isMuted: false });
    assert.match(label, /Sound on/);
    assert.doesNotMatch(label, /Muted/);
  });

  it("announces the paused state", () => {
    const label = buildShortsVideoAccessibilityLabel({ ...BASE, isPlaying: false });
    assert.match(label, /Paused/);
  });

  it("replaces playback state with the failure when playback failed", () => {
    const label = buildShortsVideoAccessibilityLabel({ ...BASE, hasError: true });
    assert.match(label, /Playback failed/);
    assert.doesNotMatch(label, /Playing/);
    assert.doesNotMatch(label, /Muted/);
  });

  it("falls back to a title placeholder rather than an empty label", () => {
    const label = buildShortsVideoAccessibilityLabel({ ...BASE, title: "   " });
    assert.match(label, /Untitled video/);
  });

  it("omits the channel when it is missing", () => {
    const label = buildShortsVideoAccessibilityLabel({ ...BASE, channelName: "" });
    assert.doesNotMatch(label, /by /);
    assert.match(label, /Sunset timelapse/);
  });

  it("keeps a long title from swallowing the state announcements", () => {
    const label = buildShortsVideoAccessibilityLabel({
      ...BASE,
      title: "y".repeat(500),
      channelName: "z".repeat(500),
    });
    assert.match(label, /Playing/);
    assert.match(label, /Muted/);
    assert.match(label, /Video 3 of 12/);
    assert.ok(label.length < 260, `label was ${label.length} characters`);
  });
});

describe("shorts media hint", () => {
  it("names the effect of the press", () => {
    assert.equal(
      buildShortsVideoAccessibilityHint({ isPlaying: true, hasError: false }),
      "Pauses this video",
    );
    assert.equal(
      buildShortsVideoAccessibilityHint({ isPlaying: false, hasError: false }),
      "Plays this video",
    );
  });

  it("points at retry when playback failed", () => {
    assert.equal(
      buildShortsVideoAccessibilityHint({ isPlaying: false, hasError: true }),
      "Activates retry",
    );
  });
});

describe("shorts control copy", () => {
  it("labels the sound control by the action it performs", () => {
    const muted = buildShortsSoundControlCopy(true);
    assert.equal(muted.label, "Unmute video");
    assert.equal(muted.value, "Muted");

    const unmuted = buildShortsSoundControlCopy(false);
    assert.equal(unmuted.label, "Mute video");
    assert.equal(unmuted.value, "Sound on");
  });

  it("labels the playback control by the action it performs", () => {
    assert.equal(buildShortsPlaybackControlCopy(true).label, "Pause video");
    assert.equal(buildShortsPlaybackControlCopy(false).label, "Play video");
  });

  it("names the video in the open-detail label", () => {
    const copy = buildShortsOpenDetailCopy("Sunset timelapse");
    assert.match(copy.label, /Sunset timelapse/);
    assert.match(copy.hint, /full video/i);
  });

  it("falls back to a generic open-detail label without a title", () => {
    assert.equal(buildShortsOpenDetailCopy("  ").label, "Open video details");
  });

  it("clamps a long title inside the open-detail label", () => {
    const copy = buildShortsOpenDetailCopy("q".repeat(300));
    assert.ok(copy.label.length < 100);
  });

  it("provides retry and expand copy", () => {
    assert.equal(buildShortsRetryCopy().label, "Retry playback");
    assert.equal(buildShortsExpandTitleCopy(false).label, "Show the full title");
    assert.equal(buildShortsExpandTitleCopy(true).label, "Show less of the title");
  });

  it("gives every control a label and a hint", () => {
    const controls = [
      buildShortsSoundControlCopy(true),
      buildShortsSoundControlCopy(false),
      buildShortsPlaybackControlCopy(true),
      buildShortsPlaybackControlCopy(false),
      buildShortsOpenDetailCopy("Title"),
      buildShortsRetryCopy(),
      buildShortsExpandTitleCopy(false),
    ];
    for (const control of controls) {
      assert.ok(control.label.length > 0, JSON.stringify(control));
      assert.ok(control.hint.length > 0, JSON.stringify(control));
    }
  });
});

describe("shorts playback state label", () => {
  it("prefers the failure over the transport state", () => {
    assert.equal(
      resolveShortsPlaybackStateLabel({ isPlaying: true, hasError: true }),
      "error",
    );
  });

  it("reports playing and paused", () => {
    assert.equal(
      resolveShortsPlaybackStateLabel({ isPlaying: true, hasError: false }),
      "playing",
    );
    assert.equal(
      resolveShortsPlaybackStateLabel({ isPlaying: false, hasError: false }),
      "paused",
    );
  });
});

describe("shorts position announcement", () => {
  it("is one-based for the viewer", () => {
    assert.equal(formatShortsPosition(0, 10), "Video 1 of 10");
  });

  it("is omitted when a total is not meaningful yet", () => {
    assert.equal(formatShortsPosition(0, 1), null);
    assert.equal(formatShortsPosition(0, 0), null);
  });

  it("is omitted for an invalid index", () => {
    assert.equal(formatShortsPosition(-1, 10), null);
    assert.equal(formatShortsPosition(Number.NaN, 10), null);
  });
});

describe("shorts control sizing constants", () => {
  it("meets both platforms' minimum touch target", () => {
    assert.ok(SHORTS_MIN_TOUCH_TARGET_PX >= 48);
  });

  it("allows dynamic type to scale but not unboundedly", () => {
    assert.ok(SHORTS_MAX_FONT_SIZE_MULTIPLIER > 1);
    assert.ok(SHORTS_MAX_FONT_SIZE_MULTIPLIER <= 2);
  });
});
