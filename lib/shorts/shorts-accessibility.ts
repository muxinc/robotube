/**
 * Pure screen-reader copy and touch-target constants for the Shorts overlay.
 *
 * Building the labels here rather than inline in JSX keeps the required content
 * — title, channel, playback state, sound state, action name — verifiable, and
 * keeps unbounded user-supplied titles from being read out in full.
 *
 * No React and no react-native imports.
 */

/**
 * Minimum touch target. 48dp satisfies both the iOS 44pt and the Android 48dp
 * guidance with one number, so every control can share it.
 */
export const SHORTS_MIN_TOUCH_TARGET_PX = 48;

/**
 * Cap on dynamic-type scaling for overlay text.
 *
 * Overlay copy sits in a fixed-height band above the tab bar. Beyond roughly
 * 1.4x the essential controls next to it start being pushed out of the safe
 * area, so text scales up to that point and then clamps while the controls stay
 * reachable.
 */
export const SHORTS_MAX_FONT_SIZE_MULTIPLIER = 1.4;

/** Longest title fragment read out in a label before it is truncated. */
export const SHORTS_LABEL_TEXT_MAX_LENGTH = 120;

/**
 * Collapse whitespace and clamp length.
 *
 * A pasted multi-line description as a video title would otherwise be announced
 * in full and would break the label into unreadable fragments.
 */
export function clampShortsLabelText(
  value: string | null | undefined,
  maxLength = SHORTS_LABEL_TEXT_MAX_LENGTH,
): string {
  if (typeof value !== "string") return "";
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export type ShortsPlaybackStateLabel = "playing" | "paused" | "error";

export function resolveShortsPlaybackStateLabel({
  isPlaying,
  hasError,
}: {
  isPlaying: boolean;
  hasError: boolean;
}): ShortsPlaybackStateLabel {
  if (hasError) return "error";
  return isPlaying ? "playing" : "paused";
}

export type ShortsVideoLabelInputs = {
  title: string;
  channelName: string;
  /** Zero-based position in the feed. */
  index: number;
  itemCount: number;
  isPlaying: boolean;
  isMuted: boolean;
  hasError: boolean;
};

/**
 * Label for the media surface itself: what the video is, who published it,
 * where it sits in the feed, and the current playback and sound state.
 */
export function buildShortsVideoAccessibilityLabel({
  title,
  channelName,
  index,
  itemCount,
  isPlaying,
  isMuted,
  hasError,
}: ShortsVideoLabelInputs): string {
  const parts: string[] = [];

  const safeTitle = clampShortsLabelText(title);
  parts.push(safeTitle.length > 0 ? safeTitle : "Untitled video");

  const safeChannel = clampShortsLabelText(channelName, 60);
  if (safeChannel.length > 0) parts.push(`by ${safeChannel}`);

  const position = formatShortsPosition(index, itemCount);
  if (position) parts.push(position);

  const state = resolveShortsPlaybackStateLabel({ isPlaying, hasError });
  if (state === "error") {
    parts.push("Playback failed");
  } else {
    parts.push(state === "playing" ? "Playing" : "Paused");
    parts.push(isMuted ? "Muted" : "Sound on");
  }

  return parts.join(", ");
}

/** Hint for the media surface. Named after the effect, not the gesture. */
export function buildShortsVideoAccessibilityHint({
  isPlaying,
  hasError,
}: {
  isPlaying: boolean;
  hasError: boolean;
}): string {
  if (hasError) return "Activates retry";
  return isPlaying ? "Pauses this video" : "Plays this video";
}

export type ShortsControlCopy = {
  label: string;
  hint: string;
  /** Announced as the control's current value. */
  value: string;
};

/** Sound control. The label names the action the press performs. */
export function buildShortsSoundControlCopy(isMuted: boolean): ShortsControlCopy {
  return {
    label: isMuted ? "Unmute video" : "Mute video",
    hint: isMuted ? "Turns sound on for this feed" : "Turns sound off for this feed",
    value: isMuted ? "Muted" : "Sound on",
  };
}

export function buildShortsPlaybackControlCopy(
  isPlaying: boolean,
): ShortsControlCopy {
  return {
    label: isPlaying ? "Pause video" : "Play video",
    hint: isPlaying ? "Pauses this video" : "Plays this video",
    value: isPlaying ? "Playing" : "Paused",
  };
}

export function buildShortsRetryCopy(): ShortsControlCopy {
  return {
    label: "Retry playback",
    hint: "Loads this video again",
    value: "",
  };
}

export function buildShortsExpandTitleCopy(isExpanded: boolean): ShortsControlCopy {
  return {
    label: isExpanded ? "Show less of the title" : "Show the full title",
    hint: isExpanded ? "Collapses the title" : "Expands the title",
    value: isExpanded ? "Expanded" : "Collapsed",
  };
}

/**
 * "Video 3 of 12". Omitted when the count is not yet meaningful, so a
 * still-paginating feed does not announce a total that keeps changing.
 */
export function formatShortsPosition(index: number, itemCount: number): string | null {
  if (!Number.isFinite(index) || index < 0) return null;
  if (!Number.isFinite(itemCount) || itemCount <= 1) return null;
  return `Video ${Math.floor(index) + 1} of ${Math.floor(itemCount)}`;
}
