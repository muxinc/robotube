/**
 * News-feed rollout flags (PRD Phase 6).
 *
 * The PRD requires independent flags for shared-player playback, predictive
 * preloading, and the lightweight feed query, plus a feature-flagged
 * standby-player fallback that section 7.2 permits only as a temporary
 * measure. Every flag carries an owner and a removal date because Phase 6's
 * exit gate is "the feature flags have documented owners and removal dates",
 * and because section 12 names permanent duplicate code as a named risk.
 *
 * Resolution order, strongest last:
 *
 *   1. `defaultValue` from the registry
 *   2. remote config value
 *   3. deterministic rollout-cohort bucketing
 *   4. Android physical-validation gate
 *   5. local override (developer menu)
 *   6. preload kill switch
 *
 * The kill switch is last on purpose: nothing can out-vote it.
 */

import { isPreloadKillSwitchEngaged } from "./feed-feature-kill-switch";

export const FEED_FEATURE_FLAG_KEYS = [
  "feedSharedPlayer",
  "feedPredictivePreload",
  "feedLightweightQuery",
  "feedStandbyPlayerFallback",
] as const;

export type FeedFeatureFlagKey = (typeof FEED_FEATURE_FLAG_KEYS)[number];

export type FeedFeatureFlagDefinition = {
  key: FeedFeatureFlagKey;
  description: string;
  defaultValue: boolean;
  /** Who removes this flag. Phase 6 exit gate. */
  owner: string;
  /** ISO date. Past this date the flag is a cleanup task, not a control. */
  removalDate: string;
  phase: string;
  /** Whether the preload kill switch can force this flag off. */
  killSwitchControlled: boolean;
  /**
   * Android exposure requires physical-device validation first. PRD Phase 6:
   * "Keep Android rollout disabled if only emulator results are available."
   */
  requiresAndroidPhysicalValidation: boolean;
  /** What reverting looks like if this flag is turned back off in production. */
  rollbackNote: string;
};

export const FEED_FEATURE_FLAGS: Record<
  FeedFeatureFlagKey,
  FeedFeatureFlagDefinition
> = {
  feedSharedPlayer: {
    key: "feedSharedPlayer",
    description:
      "Route Home-feed playback through one shared feed playback controller with a single attached surface.",
    defaultValue: false,
    owner: "news-feed-playback",
    removalDate: "2026-12-31",
    phase: "Phase 2",
    killSwitchControlled: false,
    requiresAndroidPhysicalValidation: true,
    rollbackNote:
      "Falls back to the previous per-card player path. Thumbnail cards and tap-to-open stay available either way.",
  },
  feedPredictivePreload: {
    key: "feedPredictivePreload",
    description:
      "Preload the committed item plus one direction-aware next item through the data-only preloader.",
    defaultValue: false,
    owner: "news-feed-playback",
    removalDate: "2026-12-31",
    phase: "Phase 3",
    killSwitchControlled: true,
    requiresAndroidPhysicalValidation: true,
    rollbackNote:
      "Disabling preloading must not revert shared-player or list improvements; first-frame latency regresses to the cold path.",
  },
  feedLightweightQuery: {
    key: "feedLightweightQuery",
    description:
      "Serve the Home feed from the section 7.4 card-only Convex contract instead of the full feed row.",
    defaultValue: false,
    owner: "news-feed-data",
    removalDate: "2026-12-31",
    phase: "Phase 4",
    killSwitchControlled: false,
    requiresAndroidPhysicalValidation: false,
    rollbackNote:
      "The previous feed query stays deployed until the lightweight query is validated at full rollout.",
  },
  feedStandbyPlayerFallback: {
    key: "feedStandbyPlayerFallback",
    description:
      "Temporary maximum-one standby player, permitted by section 7.2 only when data-only preloading is unavailable.",
    defaultValue: false,
    owner: "news-feed-playback",
    removalDate: "2026-09-30",
    phase: "Phase 3 fallback",
    killSwitchControlled: true,
    requiresAndroidPhysicalValidation: true,
    rollbackNote:
      "Not a target state. If it regresses scroll or memory, disable preloading entirely rather than shipping it.",
  },
};

export const FEED_FEATURE_FLAG_DEFINITIONS: readonly FeedFeatureFlagDefinition[] =
  FEED_FEATURE_FLAG_KEYS.map((key) => FEED_FEATURE_FLAGS[key]);

export function isFeedFeatureFlagKey(value: unknown): value is FeedFeatureFlagKey {
  return (
    typeof value === "string" &&
    (FEED_FEATURE_FLAG_KEYS as readonly string[]).includes(value)
  );
}

/** Flags whose removal date has passed as of `todayIso` (an ISO `YYYY-MM-DD` date). */
export function findExpiredFeedFeatureFlags(
  todayIso: string,
): FeedFeatureFlagDefinition[] {
  return FEED_FEATURE_FLAG_DEFINITIONS.filter(
    (definition) => definition.removalDate < todayIso,
  );
}

export type FeedFlagPlatform = "ios" | "android" | "other";

export type FeedRolloutStage = {
  /** 0-100. Applied per platform. */
  percent: number;
};

export type FeedFlagRolloutConfig = Partial<
  Record<FeedFeatureFlagKey, Partial<Record<FeedFlagPlatform, FeedRolloutStage>>>
>;

export type FeedFeatureFlagContext = {
  platform: FeedFlagPlatform;
  /**
   * Stable per-install or per-user identifier used for cohort bucketing. The
   * same identifier always lands in the same bucket, so a user does not flip
   * between architectures between launches.
   */
  stableId?: string;
  /** Values from remote config. Unknown keys are ignored. */
  remote?: Partial<Record<FeedFeatureFlagKey, boolean>>;
  /** Percentage rollout per flag per platform. */
  rollout?: FeedFlagRolloutConfig;
  /** Developer-menu overrides. Highest precedence below the kill switch. */
  overrides?: Partial<Record<FeedFeatureFlagKey, boolean>>;
  /**
   * Set true only after the PRD's physical-Android validation has actually
   * happened. Defaults to false, which keeps Android exposure at zero for the
   * flags that require it.
   */
  androidPhysicalValidationCompleted?: boolean;
  /** Defaults to the module-level preload kill switch. */
  preloadKillSwitchEngaged?: boolean;
};

export type FeedFeatureFlagResolution = {
  key: FeedFeatureFlagKey;
  enabled: boolean;
  /** Which resolution step produced the final value. */
  source:
    | "default"
    | "remote"
    | "rollout"
    | "android_validation_gate"
    | "override"
    | "kill_switch";
  reason: string;
};

export type FeedFeatureFlagResolutions = Record<
  FeedFeatureFlagKey,
  FeedFeatureFlagResolution
>;

/**
 * Deterministic 0-99 bucket for a (flag, id) pair.
 *
 * Domain separation by flag key means a user who lands in the first 10% for
 * one flag is not automatically in the first 10% for the others, so the flags
 * can be ramped independently without their cohorts being correlated.
 */
export function rolloutBucket(flagKey: string, stableId: string): number {
  const input = `${flagKey}:${stableId}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 100;
}

export function isInRolloutCohort(
  flagKey: string,
  stableId: string,
  percent: number,
): boolean {
  if (!Number.isFinite(percent) || percent <= 0) return false;
  if (percent >= 100) return true;
  return rolloutBucket(flagKey, stableId) < percent;
}

function resolveOne(
  definition: FeedFeatureFlagDefinition,
  context: FeedFeatureFlagContext,
  killSwitchEngaged: boolean,
): FeedFeatureFlagResolution {
  const { key } = definition;
  let enabled = definition.defaultValue;
  let source: FeedFeatureFlagResolution["source"] = "default";
  let reason = "registry default";

  const remoteValue = context.remote?.[key];
  if (typeof remoteValue === "boolean") {
    enabled = remoteValue;
    source = "remote";
    reason = "remote config value";
  }

  const stage = context.rollout?.[key]?.[context.platform];
  if (stage && typeof stage.percent === "number") {
    if (context.stableId) {
      enabled = isInRolloutCohort(key, context.stableId, stage.percent);
      source = "rollout";
      reason = `${stage.percent}% ${context.platform} cohort`;
    } else {
      // No stable identifier means no reproducible cohort. Staying off is the
      // only safe read: a random assignment per launch would flip a user
      // between architectures mid-session.
      enabled = false;
      source = "rollout";
      reason = "rollout configured but no stableId supplied";
    }
  }

  if (
    enabled &&
    definition.requiresAndroidPhysicalValidation &&
    context.platform === "android" &&
    context.androidPhysicalValidationCompleted !== true
  ) {
    enabled = false;
    source = "android_validation_gate";
    reason = "physical Android validation not recorded";
  }

  const overrideValue = context.overrides?.[key];
  if (typeof overrideValue === "boolean") {
    enabled = overrideValue;
    source = "override";
    reason = "local developer override";
  }

  if (enabled && definition.killSwitchControlled && killSwitchEngaged) {
    enabled = false;
    source = "kill_switch";
    reason = "preload kill switch engaged";
  }

  return { key, enabled, source, reason };
}

export function resolveFeedFeatureFlags(
  context: FeedFeatureFlagContext,
): FeedFeatureFlagResolutions {
  const killSwitchEngaged =
    context.preloadKillSwitchEngaged ?? isPreloadKillSwitchEngaged();

  const result = {} as FeedFeatureFlagResolutions;
  for (const key of FEED_FEATURE_FLAG_KEYS) {
    result[key] = resolveOne(FEED_FEATURE_FLAGS[key], context, killSwitchEngaged);
  }
  return result;
}

export function isFeedFeatureEnabled(
  key: FeedFeatureFlagKey,
  context: FeedFeatureFlagContext,
): boolean {
  return resolveFeedFeatureFlags(context)[key].enabled;
}

/**
 * Section 7.2 allows the standby-player fallback only when data-only
 * preloading is unavailable, and never alongside it. Returns the violations so
 * a startup assertion or a test can name the bad combination.
 */
export function findFlagCombinationViolations(
  resolutions: FeedFeatureFlagResolutions,
): string[] {
  const violations: string[] = [];

  if (
    resolutions.feedPredictivePreload.enabled &&
    resolutions.feedStandbyPlayerFallback.enabled
  ) {
    violations.push(
      "feedStandbyPlayerFallback is a substitute for feedPredictivePreload, not a supplement; enable at most one",
    );
  }

  if (
    resolutions.feedPredictivePreload.enabled &&
    !resolutions.feedSharedPlayer.enabled
  ) {
    violations.push(
      "feedPredictivePreload requires feedSharedPlayer: preloaded media has no single active player to promote into",
    );
  }

  if (
    resolutions.feedStandbyPlayerFallback.enabled &&
    !resolutions.feedSharedPlayer.enabled
  ) {
    violations.push(
      "feedStandbyPlayerFallback requires feedSharedPlayer: the standby slot is defined relative to the shared active player",
    );
  }

  return violations;
}
