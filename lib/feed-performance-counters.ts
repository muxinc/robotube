/**
 * Development-only news-feed counters.
 *
 * This module keeps a small in-memory registry that a debug overlay, a dev menu
 * entry, or a test can read synchronously.
 *
 * Two shapes are tracked:
 *
 *   gauges   — values that go up and down (mounted rows, attached surfaces,
 *              live players, playing videos). Peaks are retained so a scroll
 *              run can be judged after the fact.
 *   counters — monotonic totals (source replacements, preload starts,
 *              cancellations, cache hits, player creations/releases).
 *
 * Everything is a no-op unless counters are enabled, which defaults to
 * development builds only. Production behavior must not depend on these
 * counters.
 */

export const FEED_GAUGE_KEYS = [
  "mountedFeedRows",
  "attachedPlayerSurfaces",
  "livePlayerInstances",
  "playingFeedVideos",
  "preloadedItemsRetained",
] as const;
export type FeedGaugeKey = (typeof FEED_GAUGE_KEYS)[number];

export const FEED_COUNTER_KEYS = [
  "playerCreations",
  "playerReleases",
  "surfaceAttachments",
  "surfaceDetachments",
  "sourceReplacements",
  "preloadStarts",
  "preloadCompletions",
  "preloadCancellations",
  "preloadCacheHits",
  "preloadPromotions",
  "rowMounts",
  "rowUnmounts",
] as const;
export type FeedCounterKey = (typeof FEED_COUNTER_KEYS)[number];

export type FeedCountersSnapshot = {
  enabled: boolean;
  gauges: Record<FeedGaugeKey, number>;
  peaks: Record<FeedGaugeKey, number>;
  counters: Record<FeedCounterKey, number>;
  invariantViolations: FeedInvariantViolation[];
};

export type FeedInvariantViolation = {
  invariant: FeedInvariantName;
  observed: number;
  limit: number;
};

export const FEED_INVARIANTS = {
  atMostOneAttachedSurface: "at_most_one_attached_surface",
  atMostOnePlayingVideo: "at_most_one_playing_video",
  atMostOneLivePlayer: "at_most_one_live_player",
  boundedPreloadWindow: "bounded_preload_window",
} as const;
export type FeedInvariantName =
  (typeof FEED_INVARIANTS)[keyof typeof FEED_INVARIANTS];

/**
 * A temporary two-slot active/standby pool can raise the live-player limit.
 * Attached-surface and playing-video limits remain fixed.
 */
export type FeedInvariantLimits = {
  maxLivePlayerInstances: number;
  maxPreloadedItemsRetained: number;
};

export const DEFAULT_FEED_INVARIANT_LIMITS: FeedInvariantLimits = {
  maxLivePlayerInstances: 1,
  maxPreloadedItemsRetained: 2, // committed current item + one direction-aware next item
};

function detectDevelopmentMode(): boolean {
  const devFlag = (globalThis as { __DEV__?: boolean }).__DEV__;
  if (typeof devFlag === "boolean") return devFlag;
  const nodeEnv = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env?.NODE_ENV;
  return nodeEnv !== "production";
}

function emptyGauges(): Record<FeedGaugeKey, number> {
  const result = {} as Record<FeedGaugeKey, number>;
  for (const key of FEED_GAUGE_KEYS) result[key] = 0;
  return result;
}

function emptyCounters(): Record<FeedCounterKey, number> {
  const result = {} as Record<FeedCounterKey, number>;
  for (const key of FEED_COUNTER_KEYS) result[key] = 0;
  return result;
}

export type FeedCountersListener = (snapshot: FeedCountersSnapshot) => void;

/**
 * A standalone counter registry. The module-level singleton below is what the
 * app uses; tests instantiate their own so they never share state.
 */
export class FeedPerformanceCounters {
  private enabled: boolean;
  private limits: FeedInvariantLimits;
  private gauges = emptyGauges();
  private peaks = emptyGauges();
  private counters = emptyCounters();
  private listeners = new Set<FeedCountersListener>();

  constructor(options?: {
    enabled?: boolean;
    limits?: Partial<FeedInvariantLimits>;
  }) {
    this.enabled = options?.enabled ?? detectDevelopmentMode();
    this.limits = { ...DEFAULT_FEED_INVARIANT_LIMITS, ...options?.limits };
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  setLimits(limits: Partial<FeedInvariantLimits>): void {
    this.limits = { ...this.limits, ...limits };
  }

  getLimits(): FeedInvariantLimits {
    return { ...this.limits };
  }

  /** Adds `delta` to a gauge, clamping at zero so unbalanced teardown cannot go negative. */
  adjustGauge(key: FeedGaugeKey, delta: number): number {
    if (!this.enabled) return this.gauges[key];
    const next = Math.max(0, this.gauges[key] + delta);
    this.gauges[key] = next;
    if (next > this.peaks[key]) this.peaks[key] = next;
    this.notify();
    return next;
  }

  setGauge(key: FeedGaugeKey, value: number): number {
    if (!this.enabled) return this.gauges[key];
    const next = Math.max(0, value);
    this.gauges[key] = next;
    if (next > this.peaks[key]) this.peaks[key] = next;
    this.notify();
    return next;
  }

  increment(key: FeedCounterKey, delta = 1): number {
    if (!this.enabled) return this.counters[key];
    this.counters[key] += delta;
    this.notify();
    return this.counters[key];
  }

  getGauge(key: FeedGaugeKey): number {
    return this.gauges[key];
  }

  getPeak(key: FeedGaugeKey): number {
    return this.peaks[key];
  }

  getCounter(key: FeedCounterKey): number {
    return this.counters[key];
  }

  /** Returns every currently violated invariant. */
  getInvariantViolations(): FeedInvariantViolation[] {
    const violations: FeedInvariantViolation[] = [];

    if (this.gauges.attachedPlayerSurfaces > 1) {
      violations.push({
        invariant: FEED_INVARIANTS.atMostOneAttachedSurface,
        observed: this.gauges.attachedPlayerSurfaces,
        limit: 1,
      });
    }
    if (this.gauges.playingFeedVideos > 1) {
      violations.push({
        invariant: FEED_INVARIANTS.atMostOnePlayingVideo,
        observed: this.gauges.playingFeedVideos,
        limit: 1,
      });
    }
    if (this.gauges.livePlayerInstances > this.limits.maxLivePlayerInstances) {
      violations.push({
        invariant: FEED_INVARIANTS.atMostOneLivePlayer,
        observed: this.gauges.livePlayerInstances,
        limit: this.limits.maxLivePlayerInstances,
      });
    }
    if (this.gauges.preloadedItemsRetained > this.limits.maxPreloadedItemsRetained) {
      violations.push({
        invariant: FEED_INVARIANTS.boundedPreloadWindow,
        observed: this.gauges.preloadedItemsRetained,
        limit: this.limits.maxPreloadedItemsRetained,
      });
    }

    return violations;
  }

  snapshot(): FeedCountersSnapshot {
    return {
      enabled: this.enabled,
      gauges: { ...this.gauges },
      peaks: { ...this.peaks },
      counters: { ...this.counters },
      invariantViolations: this.getInvariantViolations(),
    };
  }

  /** Clears gauges, peaks, and counters. Call between measured scenario runs. */
  reset(): void {
    this.gauges = emptyGauges();
    this.peaks = emptyGauges();
    this.counters = emptyCounters();
    this.notify();
  }

  subscribe(listener: FeedCountersListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // A broken debug overlay must not break the feed.
      }
    }
  }
}

export const feedPerformanceCounters = new FeedPerformanceCounters();

/**
 * Renders a snapshot as a single fixed-width line per group. Used by the dev
 * overlay and by scenario run sheets so two runs can be diffed by eye.
 */
export function formatFeedCountersSnapshot(snapshot: FeedCountersSnapshot): string {
  const gauges = FEED_GAUGE_KEYS.map(
    (key) => `${key}=${snapshot.gauges[key]}(peak ${snapshot.peaks[key]})`,
  ).join(" ");
  const counters = FEED_COUNTER_KEYS.map(
    (key) => `${key}=${snapshot.counters[key]}`,
  ).join(" ");
  const violations =
    snapshot.invariantViolations.length === 0
      ? "none"
      : snapshot.invariantViolations
          .map((violation) => `${violation.invariant}(${violation.observed}>${violation.limit})`)
          .join(" ");

  return [
    `enabled: ${snapshot.enabled}`,
    `gauges:  ${gauges}`,
    `totals:  ${counters}`,
    `broken:  ${violations}`,
  ].join("\n");
}
