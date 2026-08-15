/**
 * Shorts rollout policy: the cohort ladder, the ordered rollback plan, and the
 * Shorts-specific rollout guards.
 *
 * The flag *registry* lives in `feed-feature-flags.ts` alongside every other
 * feed flag. What lives here is the vertical feed's rollout *policy* — the
 * order cohorts are exposed in, how long each is watched, and what turning the
 * flags back off actually does. Splitting it this way keeps the shared registry
 * from accumulating one feature's staging plan.
 *
 * Nothing here reports that a stage passed. `evaluateCohortReadiness` returns
 * `"unmeasured"` when a metric was not supplied, on the same principle as the
 * news-feed guards: an unobserved cohort is an unmonitored one, not a healthy
 * one.
 */

import type {
  FeedFeatureFlagKey,
  FeedFeatureFlagResolutions,
} from "./feed-feature-flags";

export const VERTICAL_FEED_FLAG_KEYS = [
  "shortsTabEnabled",
  "exclusiveFeedPlacementEnabled",
] as const satisfies readonly FeedFeatureFlagKey[];

export type VerticalFeedFlagKey = (typeof VERTICAL_FEED_FLAG_KEYS)[number];

export type CohortMechanism =
  /** Developer-menu override on a local or internal build. */
  | "local_override"
  /** Remote config value targeted at a build or an account list. */
  | "remote_targeting"
  /** Percentage bucketing by stable install ID. */
  | "percentage_rollout";

/**
 * One thing that must be true before a stage can advance.
 *
 * Criteria carry ids because `evaluateCohortReadiness` requires a per-criterion
 * attestation to report `ready`. A stage cannot be advanced by generally
 * feeling fine about it.
 */
export type CohortExitCriterion = {
  id: string;
  statement: string;
  /** How the criterion is judged. */
  evidence: "instrumented" | "observed" | "automated";
};

export type ShortsCohortStage = {
  id: string;
  label: string;
  order: number;
  mechanism: CohortMechanism;
  /** Null when the stage is not a percentage stage. */
  percent: number | null;
  /**
   * Minimum time the stage is watched before the next one opens. The PRD says
   * "at least one agreed observation window"; these are the proposed values and
   * they are the thing to argue about before a ramp, not during one.
   */
  minObservationHours: number;
  /** What must be true to move on. Judged by an operator, not by this module. */
  exitCriteria: readonly CohortExitCriterion[];
  nextStageId: string | null;
};

/**
 * PRD Phase 7: "team → internal beta → small production cohort → staged
 * increase → 100%."
 *
 * iOS-only until a physical Android device exists. `shortsTabEnabled` carries
 * `requiresAndroidPhysicalValidation`, so Android stays off through this whole
 * ladder regardless of the percentages below.
 */
export const SHORTS_COHORT_STAGES: readonly ShortsCohortStage[] = [
  {
    id: "team",
    label: "Team",
    order: 1,
    mechanism: "local_override",
    percent: null,
    minObservationHours: 24,
    exitCriteria: [
      {
        id: "team-acceptance",
        statement:
          "Every Phase 6 functional acceptance item passes on the reference iPhone.",
        evidence: "observed",
      },
      {
        id: "team-no-p0-p1",
        statement: "No P0 or P1 lifecycle, pagination, or playback defect is open.",
        evidence: "observed",
      },
      {
        id: "team-invariants",
        statement:
          "Player, surface, and preload counters show no invariant violation during a 50-item run.",
        evidence: "instrumented",
      },
    ],
    nextStageId: "internal-beta",
  },
  {
    id: "internal-beta",
    label: "Internal beta",
    order: 2,
    mechanism: "remote_targeting",
    percent: null,
    minObservationHours: 72,
    exitCriteria: [
      {
        id: "beta-query-errors",
        statement: "Shorts query error rate is at or below the Home query error rate.",
        evidence: "instrumented",
      },
      {
        id: "beta-empty-rate",
        statement:
          "Empty-state rate is explainable by the classified vertical inventory, not by query failures.",
        evidence: "instrumented",
      },
      {
        id: "beta-no-crash-memory-regression",
        statement: "No crash or memory-warning regression against the Home baseline.",
        evidence: "instrumented",
      },
      {
        id: "beta-home-regression",
        statement:
          "The Home regression checklist passes with both feeds live on internal builds.",
        evidence: "instrumented",
      },
    ],
    nextStageId: "production-small",
  },
  {
    id: "production-small",
    label: "Small production cohort",
    order: 3,
    mechanism: "percentage_rollout",
    percent: 5,
    minObservationHours: 48,
    exitCriteria: [
      {
        id: "small-first-frame",
        statement:
          "First-frame p75 is within the section 12 target on real traffic (warm 300 ms, cold 1.2 s).",
        evidence: "instrumented",
      },
      {
        id: "small-buffering",
        statement: "Buffering rate is within target against the Home baseline.",
        evidence: "instrumented",
      },
      {
        id: "small-playback-errors",
        statement: "Playback error rate is within target against the Home baseline.",
        evidence: "instrumented",
      },
      {
        id: "small-classification-unknowns",
        statement:
          "Classification unknown count for ready assets is zero, or every exception is matched to a documented id.",
        evidence: "automated",
      },
      {
        id: "small-invariants",
        statement: "No player-invariant violation reported from the field.",
        evidence: "instrumented",
      },
      {
        id: "small-home-regression",
        statement: "The Home regression checklist passes with both feeds live in production.",
        evidence: "instrumented",
      },
    ],
    nextStageId: "staged-increase",
  },
  {
    id: "staged-increase",
    label: "Staged increase",
    order: 4,
    mechanism: "percentage_rollout",
    percent: 25,
    minObservationHours: 48,
    exitCriteria: [
      {
        id: "staged-metrics-hold",
        statement:
          "First-frame, buffering, and playback-error metrics from the 5% cohort hold at 25%.",
        evidence: "instrumented",
      },
      {
        id: "staged-home-regression",
        statement: "Home shows no regression while both feeds are live at 25%.",
        evidence: "instrumented",
      },
      {
        id: "staged-support-volume",
        statement: "Support volume shows no Shorts-specific pattern.",
        evidence: "observed",
      },
    ],
    nextStageId: "full",
  },
  {
    id: "full",
    label: "100%",
    order: 5,
    mechanism: "percentage_rollout",
    percent: 100,
    minObservationHours: 168,
    exitCriteria: [
      {
        id: "full-week-clean",
        statement: "One full week at 100% with no rollout-guard breach.",
        evidence: "instrumented",
      },
      {
        id: "full-exclusivity-audit",
        statement:
          "The exclusivity audit passes with zero omissions, clearing exclusiveFeedPlacementEnabled for its own ramp.",
        evidence: "automated",
      },
      {
        id: "full-home-regression",
        statement: "The Home regression checklist passes at 100%.",
        evidence: "instrumented",
      },
      {
        id: "full-removal-owner",
        statement:
          "Migration-only legacy Home behavior has a named owner and a removal date.",
        evidence: "observed",
      },
    ],
    nextStageId: null,
  },
];

export function getShortsCohortStage(id: string): ShortsCohortStage | undefined {
  return SHORTS_COHORT_STAGES.find((stage) => stage.id === id);
}

export function getNextShortsCohortStage(id: string): ShortsCohortStage | undefined {
  const stage = getShortsCohortStage(id);
  if (!stage?.nextStageId) return undefined;
  return getShortsCohortStage(stage.nextStageId);
}

/**
 * `exclusiveFeedPlacementEnabled` does not get its own ladder. It ramps only
 * after Shorts is stable at 100% and the exclusivity audit passes, because
 * turning it on earlier removes 9:16 assets from Home for users who cannot see
 * the Shorts tab.
 */
export const EXCLUSIVE_PLACEMENT_PREREQUISITE_STAGE_ID = "full";

export type ShortsRollbackStep = {
  order: number;
  flagKey: VerticalFeedFlagKey;
  action: "disable";
  rationale: string;
  /**
   * True when completing this step alone leaves exact 9:16 assets reachable
   * from neither feed. Such a step must be followed immediately by the next.
   */
  leavesVerticalAssetsUnreachable: boolean;
};

export type ShortsRollbackPlan = {
  steps: ShortsRollbackStep[];
  /** True when the plan passes through a state with assets in no feed. */
  hasUnreachableWindow: boolean;
  summary: string;
};

/**
 * Builds the ordered rollback for the currently resolved flag state.
 *
 * Home is permanently standard-only. Disabling Shorts is still the fastest
 * operational lever for playback, memory, or query incidents, but it now makes
 * exact 9:16 assets temporarily unavailable rather than putting them back on
 * Home. The plan reports that product cost explicitly.
 *
 * The exclusive-placement flag is retained only as config compatibility. Its
 * cleanup step has no routing effect in current clients.
 */
export function buildShortsRollbackPlan(
  resolutions: FeedFeatureFlagResolutions,
): ShortsRollbackPlan {
  const shortsOn = resolutions.shortsTabEnabled.enabled;
  const exclusiveOn = resolutions.exclusiveFeedPlacementEnabled.enabled;
  const steps: ShortsRollbackStep[] = [];

  if (shortsOn) {
    steps.push({
      order: steps.length + 1,
      flagKey: "shortsTabEnabled",
      action: "disable",
      rationale:
        "Fastest lever: removes the tab and stops every Shorts query, player, and preload. Home remains standard-only, so exact 9:16 assets are temporarily unavailable.",
      leavesVerticalAssetsUnreachable: true,
    });
  }

  if (exclusiveOn) {
    steps.push({
      order: steps.length + 1,
      flagKey: "exclusiveFeedPlacementEnabled",
      action: "disable",
      rationale:
        "Compatibility cleanup only: current clients no longer use this flag to select Home's query.",
      leavesVerticalAssetsUnreachable: shortsOn,
    });
  }

  const hasUnreachableWindow = steps.some(
    (step) => step.leavesVerticalAssetsUnreachable,
  );

  const summary =
    steps.length === 0
      ? "Both vertical-feed flags are already off; there is nothing to roll back."
      : steps.length === 1
        ? `Disable ${steps[0].flagKey}; exact 9:16 assets will be unavailable until Shorts is restored.`
        : "Disable shortsTabEnabled first, accepting temporary 9:16 unavailability, then clear the legacy exclusiveFeedPlacementEnabled value as compatibility cleanup.";

  return { steps, hasUnreachableWindow, summary };
}

/**
 * Shorts-specific rollout metrics, layered on the shared
 * `evaluateRolloutGuards` rather than replacing it. The shared guards still own
 * crash rate, memory warnings, playback errors, and wrong-video incidents.
 */
export type ShortsRolloutMetrics = {
  /** Shorts pages that rendered the empty state, as a ratio of tab opens. */
  emptyStateRateRatio?: number;
  /** Shorts query errors as a ratio of Shorts queries. */
  queryErrorRateRatio?: number;
  /** Ready assets still classified `unknown`. */
  classificationUnknownCount?: number;
  /** Reported violations of the one-player / one-surface invariants. */
  playerInvariantViolationCount?: number;
  /** Assets found in neither Home nor Shorts by the exclusivity audit. */
  feedOmissionCount?: number;
};

export type ShortsRolloutThresholds = {
  maxEmptyStateRateRatio: number;
  maxQueryErrorRateRatio: number;
  maxClassificationUnknownCount: number;
  maxPlayerInvariantViolationCount: number;
  maxFeedOmissionCount: number;
};

/**
 * Placeholder thresholds. The two ratio values have no production baseline
 * behind them yet and must be reviewed before the 5% ramp; the three count
 * limits are zero because the PRD states them as absolutes.
 */
export const DEFAULT_SHORTS_ROLLOUT_THRESHOLDS: ShortsRolloutThresholds = {
  maxEmptyStateRateRatio: 0.2,
  maxQueryErrorRateRatio: 0.01,
  maxClassificationUnknownCount: 0,
  maxPlayerInvariantViolationCount: 0,
  maxFeedOmissionCount: 0,
};

export type ShortsRolloutDecision = {
  /** "unmeasured" when nothing usable was supplied at all. */
  status: "pass" | "fail" | "unmeasured";
  shouldPauseRollout: boolean;
  /** An omission or invariant breach warrants immediate rollback, not a pause. */
  shouldRollBackImmediately: boolean;
  breachedMetrics: string[];
  unmeasuredMetrics: string[];
  /** Metrics supplied as NaN, ±Infinity, out of range, or the wrong shape. */
  invalidMetrics: string[];
  /** Metrics whose *threshold* is unusable, so nothing could be judged against it. */
  invalidThresholds: string[];
};

type RolloutMetricKind = "ratio" | "count";

type RolloutMetricSpec = {
  name: string;
  kind: RolloutMetricKind;
  metricKey: keyof ShortsRolloutMetrics;
  thresholdKey: keyof ShortsRolloutThresholds;
};

/**
 * The five guard metrics, paired with their thresholds.
 *
 * `ratio` metrics are proportions of a total — empty pages over tab opens,
 * failed queries over queries — so they live in [0, 1]. `count` metrics are
 * whole numbers of incidents.
 */
const ROLLOUT_METRIC_SPECS: readonly RolloutMetricSpec[] = [
  {
    name: "empty_state_rate",
    kind: "ratio",
    metricKey: "emptyStateRateRatio",
    thresholdKey: "maxEmptyStateRateRatio",
  },
  {
    name: "query_error_rate",
    kind: "ratio",
    metricKey: "queryErrorRateRatio",
    thresholdKey: "maxQueryErrorRateRatio",
  },
  {
    name: "classification_unknown",
    kind: "count",
    metricKey: "classificationUnknownCount",
    thresholdKey: "maxClassificationUnknownCount",
  },
  {
    name: "player_invariant_violations",
    kind: "count",
    metricKey: "playerInvariantViolationCount",
    thresholdKey: "maxPlayerInvariantViolationCount",
  },
  {
    name: "feed_omissions",
    kind: "count",
    metricKey: "feedOmissionCount",
    thresholdKey: "maxFeedOmissionCount",
  },
];

const ROLLOUT_METRIC_COUNT = ROLLOUT_METRIC_SPECS.length;

/**
 * A usable number is finite, non-negative, in range for its kind, and — for
 * counts — a whole number.
 *
 * This is applied to thresholds as well as values, and that is the load-bearing
 * part. `anything > NaN` is `false`, so a single NaN threshold would silently
 * turn its metric into one that can never breach: the dashboard would show a
 * catastrophe and the guard would report a pass.
 */
function isUsableRolloutNumber(value: number, kind: RolloutMetricKind): boolean {
  if (!Number.isFinite(value) || value < 0) return false;
  if (kind === "ratio") return value <= 1;
  return Number.isInteger(value);
}

/**
 * Evaluates Shorts rollout health.
 *
 * Three outcomes per metric, and the distinction between the last two carries
 * the weight:
 *
 *   - **not supplied** — reported as unmeasured. Never a pass, never a breach.
 *   - **supplied but unusable** (NaN, ±Infinity, negative) — reported as invalid
 *     *and* pauses the rollout. A pipeline emitting NaN is broken, and ramping
 *     on a broken pipeline is ramping blind. Folding these into "unmeasured"
 *     would make a silent instrumentation failure indistinguishable from a
 *     metric nobody has wired up yet.
 *   - **supplied and usable** — compared against its threshold.
 *
 * Two breaches escalate past "pause" to "roll back now": an asset in no feed,
 * and a broken one-player invariant. Both are visible to users and neither gets
 * better by waiting for the next observation window. An *invalid* value never
 * triggers automatic rollback — garbage input is a reason to stop and look, not
 * a reason to act as though the worst case is confirmed.
 */
export function evaluateShortsRolloutGuards(
  metrics: ShortsRolloutMetrics,
  thresholds: ShortsRolloutThresholds = DEFAULT_SHORTS_ROLLOUT_THRESHOLDS,
): ShortsRolloutDecision {
  const breachedMetrics: string[] = [];
  const unmeasuredMetrics: string[] = [];
  const invalidMetrics: string[] = [];
  const invalidThresholds: string[] = [];

  for (const spec of ROLLOUT_METRIC_SPECS) {
    const limit = thresholds[spec.thresholdKey];

    // Check the threshold before the value. An unusable threshold means this
    // metric cannot be judged at all, and reporting the value as "within
    // threshold" against a NaN limit is exactly the false green light this
    // guard exists to prevent.
    if (!isUsableRolloutNumber(limit, spec.kind)) {
      invalidThresholds.push(spec.name);
      continue;
    }

    const value = metrics[spec.metricKey];

    if (value === undefined) {
      unmeasuredMetrics.push(spec.name);
      continue;
    }
    if (!isUsableRolloutNumber(value, spec.kind)) {
      invalidMetrics.push(spec.name);
      continue;
    }
    if (value > limit) breachedMetrics.push(spec.name);
  }

  const usableCount =
    ROLLOUT_METRIC_COUNT -
    unmeasuredMetrics.length -
    invalidMetrics.length -
    invalidThresholds.length;
  const failed =
    breachedMetrics.length > 0 ||
    invalidMetrics.length > 0 ||
    invalidThresholds.length > 0;

  return {
    status: failed ? "fail" : usableCount === 0 ? "unmeasured" : "pass",
    shouldPauseRollout: failed,
    shouldRollBackImmediately:
      breachedMetrics.includes("feed_omissions") ||
      breachedMetrics.includes("player_invariant_violations"),
    breachedMetrics,
    unmeasuredMetrics,
    invalidMetrics,
    invalidThresholds,
  };
}

/**
 * An operator's attestation for one exit criterion.
 *
 * `note` is the evidence — a run sheet link, a dashboard snapshot, a defect
 * query. An attestation without one is a checkbox, and a checkbox is not
 * evidence, so it is treated as missing.
 */
export type CohortCriterionAttestation = {
  met: boolean;
  note?: string;
};

export type CohortReadiness = {
  stageId: string;
  /** "unmeasured" until the guards and every criterion have something to judge. */
  status: "ready" | "blocked" | "unmeasured";
  reasons: string[];
  /** Criteria explicitly attested as not met. */
  failedCriteria: string[];
  /** Criteria with no attestation, or an attestation with no evidence note. */
  unattestedCriteria: string[];
  nextStageId: string | null;
};

/**
 * Combines the guard decision, the stage's observation window, and a
 * per-criterion attestation.
 *
 * Three independent things must all hold before this reports `ready`:
 *
 *   1. the observation window has been served;
 *   2. every rollout metric is supplied, usable, and within threshold;
 *   3. **every** exit criterion for the stage has an explicit attestation with
 *      an evidence note.
 *
 * The third was the gap worth closing. Metrics cover first-frame, buffering,
 * playback errors, unknowns, and omissions — but not "the Home regression
 * checklist passed", "no P0 is open", or "migration code has a removal owner".
 * Those are real gates that no counter can answer, and without an attestation
 * requirement a stage could report `ready` while nobody had looked at them.
 *
 * The `blocked` / `unmeasured` split is consistent across all three inputs, and
 * neither is ever `ready`, so the function is fail-closed either way:
 *
 *   | Input            | Evidence says no        | No evidence            |
 *   | ---------------- | ----------------------- | ---------------------- |
 *   | observation time | short of the window     | not supplied           |
 *   | guard metrics    | breached, or unusable   | not supplied           |
 *   | exit criteria    | attested `met: false`   | absent or no note      |
 *   | **result**       | `blocked`               | `unmeasured`           |
 *
 * An unusable `observedHours` — NaN, negative, infinite — counts as evidence
 * that something is wrong rather than as absent evidence, so it blocks.
 */
export function evaluateCohortReadiness(input: {
  stageId: string;
  observedHours?: number;
  metrics?: ShortsRolloutMetrics;
  thresholds?: ShortsRolloutThresholds;
  /** Keyed by `CohortExitCriterion.id`. */
  criterionAttestations?: Readonly<Record<string, CohortCriterionAttestation>>;
}): CohortReadiness {
  const stage = getShortsCohortStage(input.stageId);
  if (!stage) {
    return {
      stageId: input.stageId,
      status: "blocked",
      reasons: [`Unknown cohort stage "${input.stageId}".`],
      failedCriteria: [],
      unattestedCriteria: [],
      nextStageId: null,
    };
  }

  const reasons: string[] = [];
  const decision = evaluateShortsRolloutGuards(input.metrics ?? {}, input.thresholds);
  const attestations = input.criterionAttestations ?? {};

  const failedCriteria: string[] = [];
  const unattestedCriteria: string[] = [];

  for (const criterion of stage.exitCriteria) {
    const attestation = attestations[criterion.id];
    if (!attestation) {
      unattestedCriteria.push(criterion.id);
      continue;
    }
    if (!attestation.met) {
      failedCriteria.push(criterion.id);
      continue;
    }
    if (!attestation.note || attestation.note.trim().length === 0) {
      unattestedCriteria.push(criterion.id);
    }
  }

  const observedHours = input.observedHours;
  const observationMissing = observedHours === undefined;
  const observationUnusable =
    !observationMissing && (!Number.isFinite(observedHours) || observedHours < 0);
  const observationShort =
    !observationMissing &&
    !observationUnusable &&
    observedHours < stage.minObservationHours;

  if (observationMissing) {
    reasons.push("Observation time was not supplied.");
  } else if (observationUnusable) {
    reasons.push(`Observation time "${observedHours}" is not a usable duration.`);
  } else if (observationShort) {
    reasons.push(
      `Observed ${observedHours}h of the required ${stage.minObservationHours}h.`,
    );
  }

  if (decision.breachedMetrics.length > 0) {
    reasons.push(`Guard breach: ${decision.breachedMetrics.join(", ")}.`);
  }
  if (decision.invalidMetrics.length > 0) {
    reasons.push(
      `Unusable metric value: ${decision.invalidMetrics.join(", ")}.`,
    );
  }
  if (decision.invalidThresholds.length > 0) {
    reasons.push(
      `Unusable threshold, so the metric could not be judged: ${decision.invalidThresholds.join(", ")}.`,
    );
  }
  if (decision.unmeasuredMetrics.length > 0) {
    reasons.push(`Not measured: ${decision.unmeasuredMetrics.join(", ")}.`);
  }
  if (failedCriteria.length > 0) {
    reasons.push(`Exit criteria attested as not met: ${failedCriteria.join(", ")}.`);
  }
  if (unattestedCriteria.length > 0) {
    reasons.push(
      `Exit criteria with no evidence: ${unattestedCriteria.join(", ")}.`,
    );
  }

  const blocked =
    observationShort ||
    observationUnusable ||
    decision.breachedMetrics.length > 0 ||
    decision.invalidMetrics.length > 0 ||
    decision.invalidThresholds.length > 0 ||
    failedCriteria.length > 0;

  if (blocked) {
    return {
      stageId: stage.id,
      status: "blocked",
      reasons,
      failedCriteria,
      unattestedCriteria,
      nextStageId: stage.nextStageId,
    };
  }

  if (
    observationMissing ||
    decision.unmeasuredMetrics.length > 0 ||
    unattestedCriteria.length > 0
  ) {
    return {
      stageId: stage.id,
      status: "unmeasured",
      reasons,
      failedCriteria,
      unattestedCriteria,
      nextStageId: stage.nextStageId,
    };
  }

  return {
    stageId: stage.id,
    status: "ready",
    reasons: [
      `Observation window met, every guard metric within threshold, and all ${stage.exitCriteria.length} exit criteria attested with evidence.`,
    ],
    failedCriteria: [],
    unattestedCriteria: [],
    nextStageId: stage.nextStageId,
  };
}
