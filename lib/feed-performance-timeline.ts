/**
 * Records focus and playback marks per feed item and derives duration summaries
 * such as warm and cold time to first frame.
 *
 * The clock is injected. Nothing here reads wall-clock time on its own, so
 * tests are deterministic and a scenario run can be replayed from a captured
 * trace.
 */

export const FEED_TIMELINE_MARKS = [
  "candidate_changed",
  "focus_committed",
  "source_replace_started",
  "playback_requested",
  "source_ready",
  "first_frame",
  "buffering_started",
  "buffering_ended",
  "playback_error",
  "preload_started",
  "preload_completed",
  "preload_cancelled",
] as const;
export type FeedTimelineMark = (typeof FEED_TIMELINE_MARKS)[number];

export type FeedTimelineEntry = {
  mark: FeedTimelineMark;
  timestampMs: number;
};

/**
 * Warm and cold time to first frame use the same span; which one a sample belongs to
 * is decided by the recorded cache state, not by a different pair of marks.
 */
export const FEED_TIMELINE_SPANS = {
  candidateToCommit: { from: "candidate_changed", to: "focus_committed" },
  commitToPlaybackRequest: { from: "focus_committed", to: "playback_requested" },
  playbackRequestToSourceReady: { from: "playback_requested", to: "source_ready" },
  playbackRequestToFirstFrame: { from: "playback_requested", to: "first_frame" },
  sourceReadyToFirstFrame: { from: "source_ready", to: "first_frame" },
  commitToFirstFrame: { from: "focus_committed", to: "first_frame" },
  bufferingStall: { from: "buffering_started", to: "buffering_ended" },
  preloadDuration: { from: "preload_started", to: "preload_completed" },
} as const satisfies Record<string, { from: FeedTimelineMark; to: FeedTimelineMark }>;

export type FeedTimelineSpanName = keyof typeof FEED_TIMELINE_SPANS;

export type FeedTimelineTrack = {
  key: string;
  entries: FeedTimelineEntry[];
};

export type FeedDurationSummary = {
  count: number;
  min: number;
  p50: number;
  p75: number;
  p95: number;
  max: number;
  mean: number;
};

/**
 * Nearest-rank percentile on a sorted ascending array.
 *
 * Nearest-rank is used deliberately: it never invents a value that was not
 * measured, which matters for a document whose whole point is that reported
 * numbers are real. `percentile([100, 200], 75)` is 200, not 175.
 */
export function percentile(sortedAscending: readonly number[], percent: number): number {
  if (sortedAscending.length === 0) return Number.NaN;
  const clamped = Math.min(100, Math.max(0, percent));
  const rank = Math.ceil((clamped / 100) * sortedAscending.length);
  const index = Math.min(sortedAscending.length - 1, Math.max(0, rank - 1));
  return sortedAscending[index];
}

export function summarizeDurations(samples: readonly number[]): FeedDurationSummary {
  const usable = samples.filter((value) => Number.isFinite(value));
  if (usable.length === 0) {
    return {
      count: 0,
      min: Number.NaN,
      p50: Number.NaN,
      p75: Number.NaN,
      p95: Number.NaN,
      max: Number.NaN,
      mean: Number.NaN,
    };
  }

  const sorted = [...usable].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);

  return {
    count: sorted.length,
    min: sorted[0],
    p50: percentile(sorted, 50),
    p75: percentile(sorted, 75),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
    mean: total / sorted.length,
  };
}

export type FeedTimelineRecorderOptions = {
  /** Injected clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Oldest tracks are evicted past this many keys so a long scroll stays bounded. */
  maxTracks?: number;
};

const DEFAULT_MAX_TRACKS = 64;

export class FeedTimelineRecorder {
  private readonly now: () => number;
  private readonly maxTracks: number;
  private tracks = new Map<string, FeedTimelineEntry[]>();

  constructor(options?: FeedTimelineRecorderOptions) {
    this.now = options?.now ?? (() => Date.now());
    this.maxTracks = Math.max(1, options?.maxTracks ?? DEFAULT_MAX_TRACKS);
  }

  /**
   * Records a mark for `key` (normally a `muxAssetId`). Repeated marks are all
   * retained; span helpers use the first occurrence of `from` and the first
   * occurrence of `to` recorded at or after it.
   */
  mark(key: string, mark: FeedTimelineMark, timestampMs?: number): FeedTimelineEntry {
    const entry: FeedTimelineEntry = {
      mark,
      timestampMs: timestampMs ?? this.now(),
    };

    const existing = this.tracks.get(key);
    if (existing) {
      existing.push(entry);
      // Refresh insertion order so eviction stays least-recently-used.
      this.tracks.delete(key);
      this.tracks.set(key, existing);
    } else {
      this.tracks.set(key, [entry]);
      this.evictIfNeeded();
    }

    return entry;
  }

  getTrack(key: string): FeedTimelineEntry[] {
    return [...(this.tracks.get(key) ?? [])];
  }

  getTracks(): FeedTimelineTrack[] {
    return [...this.tracks.entries()].map(([key, entries]) => ({
      key,
      entries: [...entries],
    }));
  }

  trackCount(): number {
    return this.tracks.size;
  }

  /**
   * Duration between the first `from` mark and the first `to` mark that
   * follows it. Returns `null` when either mark is missing or when `to` only
   * appears before `from`, which is how an incomplete or out-of-order sequence
   * stays out of the summaries instead of contributing a bogus zero.
   */
  durationBetween(
    key: string,
    from: FeedTimelineMark,
    to: FeedTimelineMark,
  ): number | null {
    const entries = this.tracks.get(key);
    if (!entries) return null;

    const start = entries.find((entry) => entry.mark === from);
    if (!start) return null;

    const end = entries.find(
      (entry) => entry.mark === to && entry.timestampMs >= start.timestampMs,
    );
    if (!end) return null;

    return end.timestampMs - start.timestampMs;
  }

  spanDuration(key: string, span: FeedTimelineSpanName): number | null {
    const definition = FEED_TIMELINE_SPANS[span];
    return this.durationBetween(key, definition.from, definition.to);
  }

  /** Every non-null sample of `span` across all tracks, in insertion order. */
  collectSpanSamples(span: FeedTimelineSpanName): number[] {
    const samples: number[] = [];
    for (const key of this.tracks.keys()) {
      const duration = this.spanDuration(key, span);
      if (duration !== null) samples.push(duration);
    }
    return samples;
  }

  summarizeSpan(span: FeedTimelineSpanName): FeedDurationSummary {
    return summarizeDurations(this.collectSpanSamples(span));
  }

  /** Total stall time for a key, summing every buffering_started/ended pair. */
  totalBufferingMs(key: string): number {
    const entries = this.tracks.get(key);
    if (!entries) return 0;

    let total = 0;
    let openedAt: number | null = null;
    for (const entry of entries) {
      if (entry.mark === "buffering_started" && openedAt === null) {
        openedAt = entry.timestampMs;
      } else if (entry.mark === "buffering_ended" && openedAt !== null) {
        total += Math.max(0, entry.timestampMs - openedAt);
        openedAt = null;
      }
    }
    return total;
  }

  reset(): void {
    this.tracks.clear();
  }

  private evictIfNeeded(): void {
    while (this.tracks.size > this.maxTracks) {
      const oldestKey = this.tracks.keys().next().value;
      if (oldestKey === undefined) return;
      this.tracks.delete(oldestKey);
    }
  }
}

export type FeedFirstFrameGateInput = {
  /** Samples in milliseconds, split by media cache state. */
  warmSamples: readonly number[];
  coldSamples: readonly number[];
  /** First-frame latency targets. */
  warmP75TargetMs?: number;
  coldP75TargetMs?: number;
};

export type FeedFirstFrameGateResult = {
  warm: FeedDurationSummary;
  cold: FeedDurationSummary;
  warmP75TargetMs: number;
  coldP75TargetMs: number;
  /** `null` when there are no samples: an unmeasured gate is not a passing gate. */
  warmPasses: boolean | null;
  coldPasses: boolean | null;
};

export const WARM_FIRST_FRAME_P75_TARGET_MS = 300;
export const COLD_FIRST_FRAME_P75_TARGET_MS = 1200;

/**
 * Evaluates the time-to-first-frame gates. Absence of data reports as `null`
 * rather than `true` so an unrun scenario can never be mistaken for a pass.
 */
export function evaluateFirstFrameGate(
  input: FeedFirstFrameGateInput,
): FeedFirstFrameGateResult {
  const warm = summarizeDurations(input.warmSamples);
  const cold = summarizeDurations(input.coldSamples);
  const warmP75TargetMs = input.warmP75TargetMs ?? WARM_FIRST_FRAME_P75_TARGET_MS;
  const coldP75TargetMs = input.coldP75TargetMs ?? COLD_FIRST_FRAME_P75_TARGET_MS;

  return {
    warm,
    cold,
    warmP75TargetMs,
    coldP75TargetMs,
    warmPasses: warm.count === 0 ? null : warm.p75 <= warmP75TargetMs,
    coldPasses: cold.count === 0 ? null : cold.p75 <= coldP75TargetMs,
  };
}
