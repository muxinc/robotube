/**
 * Saved-query and dashboard-panel specifications for the Shorts rollout
 * (vertical-feed PRD Phase 7).
 *
 * These are specifications, not live dashboards. Robotube has no analytics
 * backend wired into `setFeedPerformanceSink` yet, so nothing here queries
 * anything. What it does give is a machine-checkable definition: every panel
 * names the events it reads and the fields it groups by, and
 * `findDashboardSpecViolations` proves those names exist in the emitted
 * vocabulary and survive the privacy sanitizer.
 *
 * That check is the point. A dashboard that groups by a field the sanitizer
 * strips is a panel that silently renders one bucket forever, and the failure
 * looks like "no data" rather than like a bug.
 */

import {
  ALL_FEED_EVENT_ALLOWED_FIELDS,
  ALL_FEED_PERFORMANCE_EVENT_NAMES,
  sanitizeFeedEventFields,
  type FeedPerformanceEventName,
} from "./feed-performance-events";

export type DashboardPanelKind =
  | "count"
  | "rate"
  | "latency_percentiles"
  | "distribution"
  | "invariant";

export type DashboardAlert = {
  /** Plain-language condition. Thresholds without a baseline say so. */
  condition: string;
  severity: "page" | "ticket" | "watch";
  /** True when the threshold is a placeholder awaiting a production baseline. */
  provisional: boolean;
};

export type ShortsDashboardPanel = {
  id: string;
  title: string;
  /** The operational question this panel exists to answer. */
  question: string;
  kind: DashboardPanelKind;
  /** Events the panel reads. Empty only for panels sourced outside telemetry. */
  events: readonly FeedPerformanceEventName[];
  /** Event fields used as filters or group-bys. Must survive the sanitizer. */
  fields: readonly string[];
  /** Non-telemetry inputs, for example a Convex audit query. */
  externalSources: readonly string[];
  owner: string;
  prdReference: string;
  alert: DashboardAlert | null;
};

const SHORTS_SCREEN_FILTER = 'screen == "shorts"';

/**
 * The eight panels PRD Phase 7 names — tab opens, query errors, empty rate,
 * first frame, buffering, playback errors, classification unknowns, and
 * player-invariant violations — plus two the rollout guards depend on.
 */
export const SHORTS_DASHBOARD_PANELS: readonly ShortsDashboardPanel[] = [
  {
    id: "shorts-tab-opens",
    title: "Shorts tab opens",
    question: "How many sessions reach the Shorts tab, and on which platforms?",
    kind: "count",
    events: ["shorts_tab_opened"],
    fields: ["session_id", "platform", "device_class"],
    externalSources: [],
    owner: "vertical-feed",
    prdReference: "Phase 7 — dashboards: tab opens",
    alert: null,
  },
  {
    id: "shorts-query-errors",
    title: "Shorts query error rate",
    question:
      "What share of Shorts queries fail, and is it worse than the Home query?",
    kind: "rate",
    // Query outcome is reported on the query event itself, as
    // `query_outcome == "error"` with an `error_code`. `feed_playback_error` is
    // deliberately NOT read here: a page that failed to load and a video that
    // failed to decode are different incidents with different owners, and
    // counting decode failures as query failures would inflate this rate while
    // hiding the real one.
    events: ["shorts_query_received"],
    fields: [
      "screen",
      "query_outcome",
      "error_code",
      "item_count",
      "platform",
      "network_class",
    ],
    externalSources: [],
    owner: "vertical-feed-data",
    prdReference: "Phase 7 — dashboards: query errors",
    alert: {
      condition: `${SHORTS_SCREEN_FILTER} and query_outcome == "error" rate > 1% of shorts_query_received over 30 minutes`,
      severity: "page",
      provisional: true,
    },
  },
  {
    id: "shorts-empty-rate",
    title: "Shorts empty-state rate",
    question:
      "How often does Shorts render empty, and is it an inventory problem or a query problem?",
    kind: "rate",
    events: ["shorts_empty_state_viewed", "shorts_tab_opened"],
    fields: ["empty_reason", "item_count", "network_class"],
    externalSources: [],
    owner: "vertical-feed",
    prdReference: "Phase 7 — dashboards: empty rate",
    alert: {
      condition:
        'empty_reason == "query_error" at any volume, or overall empty rate > 20% of tab opens',
      severity: "ticket",
      provisional: true,
    },
  },
  {
    id: "shorts-first-frame",
    title: "Shorts time to first frame",
    question: "What are p50/p75/p95 first-frame latencies, split cold versus warm?",
    kind: "latency_percentiles",
    events: ["feed_playback_requested", "feed_first_frame"],
    fields: ["screen", "cache_state", "is_preloaded", "elapsed_ms", "device_class", "network_class"],
    externalSources: [],
    owner: "vertical-feed",
    prdReference: "Phase 7 — dashboards: first frame; section 12 latency targets",
    alert: {
      condition:
        "warm p75 > 300 ms or cold p75 > 1.2 s on the reference device/network cohort",
      severity: "ticket",
      provisional: false,
    },
  },
  {
    id: "shorts-buffering",
    title: "Shorts buffering",
    question: "How often and how long does a committed Shorts page stall?",
    kind: "rate",
    events: ["feed_buffering_started", "feed_buffering_ended"],
    fields: ["screen", "elapsed_ms", "network_class", "device_class"],
    externalSources: [],
    owner: "vertical-feed",
    prdReference: "Phase 7 — dashboards: buffering",
    alert: {
      condition: "buffering rate exceeds the Home baseline rate by more than 20%",
      severity: "watch",
      provisional: true,
    },
  },
  {
    id: "shorts-playback-errors",
    title: "Shorts playback errors",
    question: "Which error codes dominate, and do users recover via retry?",
    kind: "distribution",
    events: ["feed_playback_error", "shorts_retry_playback"],
    fields: ["screen", "error_code", "retry_attempt", "platform"],
    externalSources: [],
    owner: "vertical-feed",
    prdReference: "Phase 7 — dashboards: playback errors",
    alert: {
      condition: "playback error rate exceeds 1.2x the Home baseline",
      severity: "page",
      provisional: true,
    },
  },
  {
    id: "shorts-classification-unknowns",
    title: "Classification unknowns",
    question:
      "How many ready assets still have unknown placement, and how are ready assets distributed?",
    kind: "distribution",
    events: [],
    fields: [],
    externalSources: [
      "Convex read-only placement audit query (Phase 1)",
      "lib/vertical-video-feed-audit.ts summarizePlacementDistribution",
    ],
    owner: "vertical-feed-data",
    prdReference:
      "Phase 7 — dashboards: classification unknowns; section 13 aggregate diagnostics",
    alert: {
      condition:
        "any ready asset with unknown placement that is not on the documented exception list",
      severity: "ticket",
      provisional: false,
    },
  },
  {
    id: "shorts-player-invariants",
    title: "Player invariant violations",
    question:
      "Did more than one video play, or more than one surface attach, on any device?",
    kind: "invariant",
    events: ["feed_player_attached", "feed_player_detached", "feed_playback_requested"],
    fields: ["screen", "mux_asset_id", "session_id"],
    externalSources: [
      "lib/feed-performance-counters.ts invariant violations (development builds)",
    ],
    owner: "vertical-feed",
    prdReference: "Phase 7 — dashboards: player-invariant violations",
    alert: {
      condition: "any observed violation of at-most-one playing video or attached surface",
      severity: "page",
      provisional: false,
    },
  },
  {
    id: "shorts-feed-exclusivity",
    title: "Home / Shorts exclusivity",
    question:
      "Is any eligible asset in both feeds, and — the one that matters — is any in neither?",
    kind: "invariant",
    events: [],
    fields: [],
    externalSources: [
      "Convex exclusivity audit query (Phase 2)",
      "lib/vertical-video-feed-audit.ts auditFeedExclusivity",
    ],
    owner: "vertical-feed-data",
    prdReference: "Phase 7 — rollback triggers; section 15 rollout sequence",
    alert: {
      condition: "any eligible asset appears in neither feed",
      severity: "page",
      provisional: false,
    },
  },
  {
    id: "shorts-page-impressions",
    title: "Shorts page impressions and engagement depth",
    question: "How many pages does a session actually watch?",
    kind: "distribution",
    events: [
      "shorts_page_impression",
      "shorts_manual_pause",
      "shorts_manual_resume",
      "shorts_muted",
      "shorts_unmuted",
      "shorts_open_detail",
    ],
    fields: ["session_id", "feed_index", "is_muted", "feed_placement"],
    externalSources: [],
    owner: "vertical-feed",
    prdReference: "Section 13 — Shorts event vocabulary",
    alert: null,
  },
];

export function getShortsDashboardPanel(
  id: string,
): ShortsDashboardPanel | undefined {
  return SHORTS_DASHBOARD_PANELS.find((panel) => panel.id === id);
}

export type DashboardSpecViolation = {
  panelId: string;
  kind:
    | "unknown_event"
    | "unstripped_field"
    | "no_source"
    | "duplicate_panel_id"
    | "missing_owner";
  detail: string;
};

const KNOWN_EVENT_NAMES = new Set<string>(ALL_FEED_PERFORMANCE_EVENT_NAMES);
const KNOWN_FIELD_NAMES = new Set<string>(ALL_FEED_EVENT_ALLOWED_FIELDS);

/**
 * Validates the panel specs against the live vocabulary.
 *
 * Field validity is checked two ways: the name must be on the allowlist, and a
 * representative value must actually survive `sanitizeFeedEventFields`. The
 * second check catches the case where a field is allowlisted but its shape
 * check is stricter than the panel assumes.
 */
export function findDashboardSpecViolations(
  panels: readonly ShortsDashboardPanel[] = SHORTS_DASHBOARD_PANELS,
): DashboardSpecViolation[] {
  const violations: DashboardSpecViolation[] = [];
  const seenIds = new Set<string>();

  for (const panel of panels) {
    if (seenIds.has(panel.id)) {
      violations.push({
        panelId: panel.id,
        kind: "duplicate_panel_id",
        detail: `Panel id "${panel.id}" is used more than once.`,
      });
    }
    seenIds.add(panel.id);

    if (panel.owner.trim().length === 0) {
      violations.push({
        panelId: panel.id,
        kind: "missing_owner",
        detail: "Every panel needs an owner who answers its alert.",
      });
    }

    for (const event of panel.events) {
      if (!KNOWN_EVENT_NAMES.has(event)) {
        violations.push({
          panelId: panel.id,
          kind: "unknown_event",
          detail: `Event "${event}" is not in the emitted vocabulary.`,
        });
      }
    }

    for (const field of panel.fields) {
      if (!KNOWN_FIELD_NAMES.has(field)) {
        violations.push({
          panelId: panel.id,
          kind: "unstripped_field",
          detail: `Field "${field}" is not on the telemetry allowlist; the sanitizer drops it.`,
        });
      }
    }

    if (panel.events.length === 0 && panel.externalSources.length === 0) {
      violations.push({
        panelId: panel.id,
        kind: "no_source",
        detail: "Panel reads neither an event nor an external source.",
      });
    }
  }

  return violations;
}

/**
 * A representative field payload for every allowlisted field, used to prove the
 * sanitizer keeps what the panels group by rather than only that the names are
 * spelled correctly.
 */
export const DASHBOARD_FIELD_PROBE: Readonly<Record<string, unknown>> = {
  session_id: "session-abc",
  screen: "shorts",
  mux_asset_id: "asset-abc",
  playback_id_hash: "0a1b2c3d",
  feed_index: 4,
  device_class: "high",
  platform: "ios",
  network_class: "wifi",
  cache_state: "warm",
  is_preloaded: true,
  elapsed_ms: 240,
  error_code: "MEDIA_DECODE_FAILED",
  feed_placement: "vertical",
  item_count: 16,
  is_muted: false,
  retry_attempt: 1,
  empty_reason: "no_vertical_assets",
  page_height_dp: 812,
  query_outcome: "success",
};

/** Allowlisted fields whose probe value does not survive sanitization. */
export function findUnsanitizableProbeFields(): string[] {
  const sanitized = sanitizeFeedEventFields(DASHBOARD_FIELD_PROBE).fields as Record<
    string,
    unknown
  >;
  return [...KNOWN_FIELD_NAMES].filter((field) => !(field in sanitized));
}
