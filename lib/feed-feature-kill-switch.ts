/**
 * Immediate remote kill switch for news-feed predictive preloading.
 *
 * Design constraints that shaped this module:
 *
 *   - Immediate means synchronous. Subscribers are notified inside
 *     `engagePreloadKillSwitch`, so in-flight preload work can be cancelled in
 *     the same tick rather than on the next render or the next config poll.
 *   - Reading the state must never be async. `isPreloadKillSwitchEngaged()` is
 *     a plain boolean read, safe to call from a hot path.
 *   - It fails closed. A malformed or unreadable remote payload engages the
 *     switch. Preloading is the optional half of the architecture; losing it
 *     costs first-frame latency, while running it blind costs memory and
 *     bandwidth on devices we cannot see.
 *   - It is monotonic in time. A stale payload arriving out of order cannot
 *     re-enable preloading that a newer payload disabled.
 *
 * The switch only ever disables. It cannot turn preloading on where a feature
 * flag or a rollout cohort has it off.
 */

export type PreloadKillSwitchSource =
  | "default"
  | "remote_config"
  | "local_override"
  | "malformed_remote_payload"
  | "rollout_guard";

export type PreloadKillSwitchState = {
  engaged: boolean;
  reason: string | null;
  source: PreloadKillSwitchSource;
  /** Timestamp of the payload or call that produced this state. */
  updatedAtMs: number;
};

export type PreloadKillSwitchListener = (state: PreloadKillSwitchState) => void;

const INITIAL_STATE: PreloadKillSwitchState = {
  engaged: false,
  reason: null,
  source: "default",
  updatedAtMs: 0,
};

export class PreloadKillSwitch {
  private state: PreloadKillSwitchState = { ...INITIAL_STATE };
  private listeners = new Set<PreloadKillSwitchListener>();

  isEngaged(): boolean {
    return this.state.engaged;
  }

  getState(): PreloadKillSwitchState {
    return { ...this.state };
  }

  /**
   * Disables preloading now. Listeners run synchronously before this returns.
   * Re-engaging with a new reason updates the reason and re-notifies.
   */
  engage(
    reason: string,
    options?: { source?: PreloadKillSwitchSource; atMs?: number },
  ): PreloadKillSwitchState {
    return this.transition({
      engaged: true,
      reason,
      source: options?.source ?? "local_override",
      updatedAtMs: options?.atMs ?? this.state.updatedAtMs,
    });
  }

  /** Re-enables preloading. Only an operator action or a newer remote payload should call this. */
  release(options?: {
    source?: PreloadKillSwitchSource;
    atMs?: number;
  }): PreloadKillSwitchState {
    return this.transition({
      engaged: false,
      reason: null,
      source: options?.source ?? "local_override",
      updatedAtMs: options?.atMs ?? this.state.updatedAtMs,
    });
  }

  /**
   * Applies a remote config payload of the shape
   * `{ preloadDisabled: boolean, reason?: string, updatedAtMs?: number }`.
   *
   * Returns the resulting state. Payloads older than the current state are
   * ignored; anything that is not a well-formed payload engages the switch.
   */
  applyRemotePayload(payload: unknown): PreloadKillSwitchState {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return this.transition({
        engaged: true,
        reason: "remote kill-switch payload was not an object",
        source: "malformed_remote_payload",
        updatedAtMs: this.state.updatedAtMs,
      });
    }

    const record = payload as Record<string, unknown>;
    const disabled = record.preloadDisabled;

    if (typeof disabled !== "boolean") {
      return this.transition({
        engaged: true,
        reason: "remote kill-switch payload missing boolean preloadDisabled",
        source: "malformed_remote_payload",
        updatedAtMs: this.state.updatedAtMs,
      });
    }

    const updatedAtMs =
      typeof record.updatedAtMs === "number" && Number.isFinite(record.updatedAtMs)
        ? record.updatedAtMs
        : this.state.updatedAtMs;

    // Out-of-order delivery must not resurrect preloading.
    if (updatedAtMs < this.state.updatedAtMs) {
      return this.getState();
    }

    const reason =
      typeof record.reason === "string" && record.reason.length > 0
        ? record.reason.slice(0, 200)
        : disabled
          ? "disabled by remote config"
          : null;

    return this.transition({
      engaged: disabled,
      reason: disabled ? reason : null,
      source: "remote_config",
      updatedAtMs,
    });
  }

  /**
   * Subscribes to state changes. The listener is not called on subscribe; read
   * `getState()` first if the current value matters. Returns an unsubscribe
   * function.
   */
  subscribe(listener: PreloadKillSwitchListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Test helper. Clears state and listeners. */
  reset(): void {
    this.state = { ...INITIAL_STATE };
    this.listeners.clear();
  }

  private transition(next: PreloadKillSwitchState): PreloadKillSwitchState {
    const unchanged =
      next.engaged === this.state.engaged &&
      next.reason === this.state.reason &&
      next.source === this.state.source &&
      next.updatedAtMs === this.state.updatedAtMs;

    this.state = next;
    if (!unchanged) this.notify();
    return this.getState();
  }

  private notify(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // A failing subscriber must not prevent the remaining subscribers from
        // hearing about a kill-switch change.
      }
    }
  }
}

export const preloadKillSwitch = new PreloadKillSwitch();

export function isPreloadKillSwitchEngaged(): boolean {
  return preloadKillSwitch.isEngaged();
}

export function getPreloadKillSwitchState(): PreloadKillSwitchState {
  return preloadKillSwitch.getState();
}

export function engagePreloadKillSwitch(
  reason: string,
  options?: { source?: PreloadKillSwitchSource; atMs?: number },
): PreloadKillSwitchState {
  return preloadKillSwitch.engage(reason, options);
}

export function releasePreloadKillSwitch(options?: {
  source?: PreloadKillSwitchSource;
  atMs?: number;
}): PreloadKillSwitchState {
  return preloadKillSwitch.release(options);
}

export function applyRemotePreloadKillSwitchPayload(
  payload: unknown,
): PreloadKillSwitchState {
  return preloadKillSwitch.applyRemotePayload(payload);
}

export function subscribeToPreloadKillSwitch(
  listener: PreloadKillSwitchListener,
): () => void {
  return preloadKillSwitch.subscribe(listener);
}

/**
 * Crossing any rollout guard pauses rollout automatically. Ratio thresholds
 * remain placeholders until baseline values exist.
 */
export type RolloutGuardMetrics = {
  crashRateRatioToBaseline?: number;
  memoryWarningRateRatioToBaseline?: number;
  playbackErrorRateRatioToBaseline?: number;
  wrongVideoIncidentCount?: number;
};

export type RolloutGuardThresholds = {
  maxCrashRateRatio: number;
  maxMemoryWarningRateRatio: number;
  maxPlaybackErrorRateRatio: number;
  maxWrongVideoIncidents: number;
};

export const DEFAULT_ROLLOUT_GUARD_THRESHOLDS: RolloutGuardThresholds = {
  maxCrashRateRatio: 1.1,
  maxMemoryWarningRateRatio: 1.2,
  maxPlaybackErrorRateRatio: 1.2,
  maxWrongVideoIncidents: 0,
};

export type RolloutGuardDecision = {
  shouldPauseRollout: boolean;
  shouldEngagePreloadKillSwitch: boolean;
  breachedMetrics: string[];
};

/**
 * Evaluates observed metrics against the guard thresholds.
 *
 * Metrics that were not supplied are treated as "not measured" and never count
 * as a pass or a breach — an unobserved rollout is not a healthy rollout, it is
 * an unmonitored one, and the operator has to say so explicitly.
 */
export function evaluateRolloutGuards(
  metrics: RolloutGuardMetrics,
  thresholds: RolloutGuardThresholds = DEFAULT_ROLLOUT_GUARD_THRESHOLDS,
): RolloutGuardDecision {
  const breachedMetrics: string[] = [];

  if (
    metrics.crashRateRatioToBaseline !== undefined &&
    metrics.crashRateRatioToBaseline > thresholds.maxCrashRateRatio
  ) {
    breachedMetrics.push("crash_rate");
  }
  if (
    metrics.memoryWarningRateRatioToBaseline !== undefined &&
    metrics.memoryWarningRateRatioToBaseline > thresholds.maxMemoryWarningRateRatio
  ) {
    breachedMetrics.push("memory_warning_rate");
  }
  if (
    metrics.playbackErrorRateRatioToBaseline !== undefined &&
    metrics.playbackErrorRateRatioToBaseline > thresholds.maxPlaybackErrorRateRatio
  ) {
    breachedMetrics.push("playback_error_rate");
  }
  if (
    metrics.wrongVideoIncidentCount !== undefined &&
    metrics.wrongVideoIncidentCount > thresholds.maxWrongVideoIncidents
  ) {
    breachedMetrics.push("wrong_video_incidents");
  }

  return {
    shouldPauseRollout: breachedMetrics.length > 0,
    // Memory and playback-error pressure are the two the preload path can
    // actually relieve, so those are the ones that pull the preload switch.
    shouldEngagePreloadKillSwitch:
      breachedMetrics.includes("memory_warning_rate") ||
      breachedMetrics.includes("playback_error_rate"),
    breachedMetrics,
  };
}
