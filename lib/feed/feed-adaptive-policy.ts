/**
 * Pure resolution of device, network, accessibility, and pressure signals into
 * the levers the feed actually has: autoplay, rendition cap, preload window size, and
 * thumbnail request width. No React and no react-native imports, so this is
 * directly unit testable.
 */

export type FeedDeviceClass = "low" | "standard" | "high";

export type FeedNetworkClass =
  | "wifi"
  | "cellular"
  | "constrained"
  | "offline"
  | "unknown";

/** Rendition caps the installed Mux player accepts. */
export type FeedMaxResolution = "720p" | "1080p" | "1440p" | "2160p";

export type FeedResourcePressure = {
  /** Set by a memory-warning listener. */
  memory?: boolean;
  /** Reserved for a future thermal/CPU signal source. */
  thermal?: boolean;
};

export type FeedPolicyInputs = {
  deviceClass: FeedDeviceClass;
  networkClass: FeedNetworkClass;
  /** OS "reduce motion" preference. */
  prefersReducedMotion: boolean;
  /** OS/user low-data preference. */
  prefersLowData: boolean;
  pressure?: FeedResourcePressure;
};

export type FeedMediaPolicy = {
  /** False keeps the feed thumbnail-only and tap-to-open. */
  isAutoplayAllowed: boolean;
  /** Feed previews are always muted. */
  muted: true;
  maxResolution: FeedMaxResolution;
  /** How many items ahead of the committed item may hold preload resources. */
  preloadAhead: number;
  /** How many items behind may hold preload resources. */
  preloadBehind: number;
  /** False disables the media preloader entirely. */
  isMediaPreloadAllowed: boolean;
  /** False disables predictive thumbnail prefetch. */
  isThumbnailPrefetchAllowed: boolean;
};

/**
 * The feed video area is a full-width 16:9 card. Even on a 3x 430pt device that
 * is ~1290x726 physical pixels, so 720p remains the right cap: the next rung up
 * (1080p) costs roughly 2.2x the bitrate for detail the card cannot resolve at
 * normal viewing distance, and it is the lowest cap the player type allows.
 * Revisit if the feed ever renders full-bleed portrait video.
 */
export const FEED_MAX_RESOLUTION: FeedMaxResolution = "720p";

/** Never request a thumbnail wider than this, whatever the device reports. */
export const MAX_THUMBNAIL_WIDTH_PX = 1280;
/** Below this the JPEG artifacts become visible on the card. */
export const MIN_THUMBNAIL_WIDTH_PX = 320;

export function resolveFeedMediaPolicy(inputs: FeedPolicyInputs): FeedMediaPolicy {
  const { deviceClass, networkClass, prefersReducedMotion, prefersLowData } = inputs;
  const isMemoryPressured = inputs.pressure?.memory === true;
  const isThermalPressured = inputs.pressure?.thermal === true;
  const isPressured = isMemoryPressured || isThermalPressured;

  const isOffline = networkClass === "offline";
  const isConstrained = networkClass === "constrained" || prefersLowData;

  const isAutoplayAllowed =
    !prefersReducedMotion && !prefersLowData && !isOffline && !isMemoryPressured;

  const isMediaPreloadAllowed =
    isAutoplayAllowed &&
    !isConstrained &&
    !isPressured &&
    networkClass === "wifi" &&
    deviceClass !== "low";

  const preloadAhead = isMediaPreloadAllowed ? 1 : 0;
  const preloadBehind = 0;

  const isThumbnailPrefetchAllowed = !isOffline && !isConstrained && !isPressured;

  return {
    isAutoplayAllowed,
    muted: true,
    maxResolution: FEED_MAX_RESOLUTION,
    preloadAhead,
    preloadBehind,
    isMediaPreloadAllowed,
    isThumbnailPrefetchAllowed,
  };
}

export type DeviceClassInputs = {
  /** Shortest window dimension in density-independent points. */
  shortestSideDp: number;
  pixelRatio: number;
  /** Total device memory in bytes when the platform reports it. */
  totalMemoryBytes?: number;
};

const LOW_TIER_MEMORY_BYTES = 3 * 1024 * 1024 * 1024;
const HIGH_TIER_MEMORY_BYTES = 6 * 1024 * 1024 * 1024;

export function classifyDevice({
  shortestSideDp,
  pixelRatio,
  totalMemoryBytes,
}: DeviceClassInputs): FeedDeviceClass {
  if (totalMemoryBytes !== undefined && Number.isFinite(totalMemoryBytes)) {
    if (totalMemoryBytes < LOW_TIER_MEMORY_BYTES) return "low";
    if (totalMemoryBytes >= HIGH_TIER_MEMORY_BYTES) return "high";
    return "standard";
  }
  // Screen geometry is the only universally available proxy without adding a
  // device-info dependency. Small, low-density screens track low-tier hardware.
  if (shortestSideDp < 360 || pixelRatio < 2) return "low";
  if (shortestSideDp >= 400 && pixelRatio >= 3) return "high";
  return "standard";
}

/**
 * Request a thumbnail sized for what is actually rendered rather than always
 * asking for 1280px. Rounded up to a 160px step so a feed shares a handful of
 * cache keys instead of one per device width.
 */
export function resolveThumbnailWidthPx(
  renderedWidthDp: number,
  pixelRatio: number,
  step = 160,
): number {
  const safeWidth = Number.isFinite(renderedWidthDp) ? Math.max(0, renderedWidthDp) : 0;
  const safeRatio = Number.isFinite(pixelRatio) ? Math.max(1, pixelRatio) : 1;
  const target = safeWidth * safeRatio;
  const stepped = Math.ceil(target / step) * step;
  return clamp(stepped, MIN_THUMBNAIL_WIDTH_PX, MAX_THUMBNAIL_WIDTH_PX);
}

/**
 * Rewrite the `width` on a Mux image URL so one card produces one image cache
 * path and one poster representation. Unknown or non-Mux URLs pass through
 * untouched.
 */
export function withThumbnailWidth(thumbnailUrl: string, widthPx: number): string {
  if (!thumbnailUrl) return thumbnailUrl;
  const separatorIndex = thumbnailUrl.indexOf("?");
  if (separatorIndex === -1) {
    return `${thumbnailUrl}?width=${widthPx}`;
  }
  const base = thumbnailUrl.slice(0, separatorIndex);
  const query = thumbnailUrl.slice(separatorIndex + 1);
  const parts = query
    .split("&")
    .filter((part) => part.length > 0 && !part.startsWith("width="));
  parts.push(`width=${widthPx}`);
  return `${base}?${parts.join("&")}`;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
