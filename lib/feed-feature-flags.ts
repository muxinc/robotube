/**
 * Independent rollout flags for shared playback, predictive preloading, the
 * lightweight query, the temporary standby-player fallback, the Shorts tab, and
 * exclusive Home/Shorts feed placement.
 *
 * Resolution order, strongest last:
 *
 *   1. `defaultValue` from the registry
 *   2. remote config value
 *   3. deterministic rollout-cohort bucketing
 *   4. Android physical-validation gate
 *   5. local override (developer menu)
 *   6. preload kill switch
 *   7. cross-flag dependency gate
 *
 * Two rules bend that ladder, both in the disabling direction:
 *
 *   - **A remote `false` is authoritative over a percentage rollout.** Step 3
 *     normally overwrites step 2, but a remote `false` is an operator switching
 *     something off, and a stale or forgotten rollout percentage must not
 *     quietly switch it back on. Only a local developer override — which exists
 *     for debugging and never ships enabled — can still turn it on after that.
 *   - **The dependency gate runs last and only ever disables.** A flag whose
 *     prerequisite resolved off cannot be left on by any earlier step,
 *     including an override.
 *
 * The kill switch and the dependency gate are last on purpose: nothing can
 * out-vote them upward.
 */

import { isPreloadKillSwitchEngaged } from "./feed-feature-kill-switch";

export const FEED_FEATURE_FLAG_KEYS = [
  "feedSharedPlayer",
  "feedPredictivePreload",
  "feedLightweightQuery",
  "feedStandbyPlayerFallback",
  "shortsTabEnabled",
  "exclusiveFeedPlacementEnabled",
] as const;

export type FeedFeatureFlagKey = (typeof FEED_FEATURE_FLAG_KEYS)[number];

export type FeedFeatureFlagDefinition = {
  key: FeedFeatureFlagKey;
  description: string;
  defaultValue: boolean;
  /** Team responsible for removing this flag. */
  owner: string;
  /** ISO date. Past this date the flag is a cleanup task, not a control. */
  removalDate: string;
  phase: string;
  /** Whether the preload kill switch can force this flag off. */
  killSwitchControlled: boolean;
  /** Android exposure requires physical-device validation first. */
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
  shortsTabEnabled: {
    key: "shortsTabEnabled",
    description:
      "Register the Shorts native tab and allow its vertical query, playback, and preload work. Off means the tab is absent and no Shorts query runs.",
    defaultValue: false,
    owner: "vertical-feed",
    removalDate: "2026-12-31",
    phase: "Vertical feed Phase 7",
    // The preload kill switch relieves preload pressure; it is not a reason to
    // take away a whole tab. Shorts has its own first-lever rollback below.
    killSwitchControlled: false,
    requiresAndroidPhysicalValidation: true,
    rollbackNote:
      "Disabling hides the tab and stops every Shorts query, player, and preload. Home is untouched and keeps serving exactly what it served before. This is the first rollback lever.",
  },
  exclusiveFeedPlacementEnabled: {
    key: "exclusiveFeedPlacementEnabled",
    description:
      'Legacy Home-cutover flag retained for runtime-config compatibility. Home now always uses feedPlacement == "standard", so this flag has no mobile-client routing effect.',
    defaultValue: false,
    owner: "vertical-feed-data",
    removalDate: "2026-12-31",
    phase: "Vertical feed Phase 7",
    killSwitchControlled: false,
    // A Convex placement filter does not depend on Android hardware behavior.
    requiresAndroidPhysicalValidation: false,
    rollbackNote:
      "No current mobile-client effect. Home remains standard-only when this legacy migration flag changes.",
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
  /** Set true only after physical Android validation has completed. */
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
    | "kill_switch"
    | "dependency_gate";
  reason: string;
};

/**
 * Flags that cannot be on unless their prerequisite is also on.
 *
 * This is enforced during resolution, not merely reported afterwards. A
 * consumer that reads `isFeedFeatureEnabled("exclusiveFeedPlacementEnabled")`
 * gets `false` the moment the Shorts tab is off, so there is no window in which
 * Home has dropped exact 9:16 assets and no Shorts tab exists to show them.
 */
export const FEED_FLAG_DEPENDENCIES: Partial<
  Record<FeedFeatureFlagKey, { requires: FeedFeatureFlagKey; because: string }>
> = {
  exclusiveFeedPlacementEnabled: {
    requires: "shortsTabEnabled",
    because:
      "exclusive placement removes exact 9:16 assets from Home; without the Shorts tab they would appear in neither feed",
  },
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
  const remoteDisabled = remoteValue === false;
  if (typeof remoteValue === "boolean") {
    enabled = remoteValue;
    source = "remote";
    reason = remoteDisabled
      ? "remote config disabled the flag"
      : "remote config value";
  }

  const stage = context.rollout?.[key]?.[context.platform];
  if (stage && typeof stage.percent === "number") {
    if (remoteDisabled) {
      // A remote `false` is an operator turning something off. A rollout
      // percentage that is still sitting in config — usually because nobody
      // remembered to zero it — must not quietly turn it back on. Staying off
      // here is what makes remote config usable as an emergency lever.
      enabled = false;
      source = "remote";
      reason = `remote config disabled the flag; ${stage.percent}% ${context.platform} rollout ignored`;
    } else if (context.stableId) {
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

/**
 * Forces a dependent flag off when its prerequisite resolved off.
 *
 * Runs after every per-flag step, including the Android validation gate, the
 * developer override, and the kill switch, because any of those can turn a
 * prerequisite off after the dependent flag has already been decided.
 *
 * Applied repeatedly until stable so a chain of dependencies resolves in one
 * call; the flag count bounds the loop.
 */
function applyDependencyGates(resolutions: FeedFeatureFlagResolutions): void {
  for (let pass = 0; pass < FEED_FEATURE_FLAG_KEYS.length; pass += 1) {
    let changed = false;

    for (const key of FEED_FEATURE_FLAG_KEYS) {
      const dependency = FEED_FLAG_DEPENDENCIES[key];
      if (!dependency) continue;

      const resolution = resolutions[key];
      if (!resolution.enabled) continue;
      if (resolutions[dependency.requires].enabled) continue;

      resolutions[key] = {
        key,
        enabled: false,
        source: "dependency_gate",
        reason: `${dependency.requires} is off: ${dependency.because}`,
      };
      changed = true;
    }

    if (!changed) return;
  }
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

  applyDependencyGates(result);
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

  // Vertical-feed PRD section 15: the rollout may temporarily duplicate a video
  // between Home and Shorts, but it must never let a classified video fall out
  // of both.
  //
  // `applyDependencyGates` already makes this state unreachable through
  // `resolveFeedFeatureFlags`. This check stays as defense in depth for
  // resolutions assembled by hand — a test fixture, a config preview screen, a
  // future caller that builds the record itself — so the invariant is still
  // named rather than silently assumed.
  if (
    resolutions.exclusiveFeedPlacementEnabled.enabled &&
    !resolutions.shortsTabEnabled.enabled
  ) {
    violations.push(
      "exclusiveFeedPlacementEnabled requires shortsTabEnabled: exclusive placement removes exact 9:16 assets from Home, and with no Shorts tab they appear in neither feed",
    );
  }

  return violations;
}
