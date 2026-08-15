/**
 * Entry point for the 9:16 vertical-feed verification, fixture, audit, and
 * rollout tooling.
 *
 * Import from `@/lib/vertical-video-feed` rather than reaching into individual
 * modules, so the Phase 7 cleanup is a change in one file.
 *
 * What is production-safe and what is tooling:
 *
 *   vertical-video-feed-fixtures    test/fixture tooling and the eligibility oracle
 *   vertical-video-feed-audit       pure audit arithmetic; safe to call from a query
 *   vertical-video-feed-scenarios   documentation data for run sheets and checklists
 *   vertical-video-feed-rollout     rollout policy; removed with the flags
 *   vertical-video-feed-dashboards  saved-query specifications
 *
 * Telemetry and flags are **not** re-exported here. Shorts uses the same
 * `@/lib/feed-performance` and `@/lib/feed-feature-flags` surfaces the Home feed
 * uses; a second import path for the same emitter is how two vocabularies start.
 */

export {
  ASPECT_UNKNOWN_REASONS,
  SHORTS_INELIGIBILITY_REASONS,
  VERTICAL_ASPECT_RATIO,
  VERTICAL_FEED_FIXTURES,
  VERTICAL_FIXTURE_BASE_CREATED_AT_MS,
  VERTICAL_STANDARD_SCENARIO_ITEM_COUNT,
  VERTICAL_THUMBNAIL_HEIGHT,
  VERTICAL_THUMBNAIL_WIDTH,
  classifyFixture,
  createDeterministicVerticalFeed,
  evaluateFixtureVisibility,
  evaluateShortsVisibility,
  findFixtureOracleDisagreements,
  getShortsEligibleFixtures,
  getShortsIneligibleFixtures,
  getVerticalFeedFixtures,
  normalizeAspectRatio,
  type AspectClassification,
  type AspectUnknownReason,
  type DeterministicVerticalFeedOptions,
  type FeedPlacement,
  type FixtureClassifier,
  type FixtureDisagreement,
  type ShortsIneligibilityReason,
  type ShortsVisibilityInput,
  type ShortsVisibilityResult,
  type VerticalFeedFixture,
  type VerticalFixtureGroup,
} from "./vertical-video-feed-fixtures";

export {
  PLACEMENT_MISMATCH_KINDS,
  auditFeedExclusivity,
  buildPlacementDiagnostics,
  evaluateClassificationCoverageGate,
  formatPlacementDiagnostics,
  summarizeBackfillRun,
  summarizePlacementDistribution,
  type BackfillCounterReport,
  type BackfillCounters,
  type CoverageGateResult,
  type CoverageGateStatus,
  type DocumentedCoverageException,
  type ExclusivityAuditInput,
  type ExclusivityAuditResult,
  type PlacementAuditRow,
  type PlacementClassifier,
  type PlacementDiagnostics,
  type PlacementDistribution,
  type PlacementMismatch,
  type PlacementMismatchKind,
} from "./vertical-video-feed-audit";

export {
  HOME_REGRESSION_CHECKLIST,
  SHORTS_ACCEPTANCE_CHECKLIST,
  SHORTS_ACCESSIBILITY_CHECKLIST,
  SHORTS_CHECKLISTS,
  SHORTS_SCENARIOS,
  buildShortsRunMatrix,
  getShortsScenario,
  type ChecklistItem,
  type ShortsChecklistName,
  type ShortsRunCell,
  type ShortsScenario,
} from "./vertical-video-feed-scenarios";

export {
  DEFAULT_SHORTS_ROLLOUT_THRESHOLDS,
  EXCLUSIVE_PLACEMENT_PREREQUISITE_STAGE_ID,
  SHORTS_COHORT_STAGES,
  VERTICAL_FEED_FLAG_KEYS,
  buildShortsRollbackPlan,
  evaluateCohortReadiness,
  evaluateShortsRolloutGuards,
  getNextShortsCohortStage,
  getShortsCohortStage,
  type CohortCriterionAttestation,
  type CohortExitCriterion,
  type CohortMechanism,
  type CohortReadiness,
  type ShortsCohortStage,
  type ShortsRollbackPlan,
  type ShortsRollbackStep,
  type ShortsRolloutDecision,
  type ShortsRolloutMetrics,
  type ShortsRolloutThresholds,
  type VerticalFeedFlagKey,
} from "./vertical-video-feed-rollout";

export {
  DASHBOARD_FIELD_PROBE,
  SHORTS_DASHBOARD_PANELS,
  findDashboardSpecViolations,
  findUnsanitizableProbeFields,
  getShortsDashboardPanel,
  type DashboardAlert,
  type DashboardPanelKind,
  type DashboardSpecViolation,
  type ShortsDashboardPanel,
} from "./vertical-video-feed-dashboards";
