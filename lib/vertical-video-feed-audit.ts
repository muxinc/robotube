/**
 * Pure audit helpers for the classification operations described in
 * vertical-feed PRD sections 12 and 13.
 *
 * These compute; they do not read. A Convex read-only audit query (Phase 1) and
 * the backfill (Phase 1) supply the rows, and these functions turn them into
 * the counts and verdicts the coverage gate is defined in terms of. Keeping the
 * arithmetic here means the gate can be unit tested without a deployment, and
 * means the number quoted in an operations doc and the number a query returns
 * come from the same code.
 *
 * The module has **no runtime imports**, so it is safe to call from a Convex
 * query. The classifier it needs is injected rather than imported; see
 * `PlacementClassifier` for why that matters.
 *
 * The recurring rule, inherited from the news-feed work: **absence of data is
 * never a pass.** Every gate result can be `"unmeasured"`, and an unmeasured
 * gate is not a passing gate.
 */

import type { FeedPlacement } from "./feed-performance-events";

/**
 * Re-derives a placement from a stored ratio string.
 *
 * **Injected, never imported.** This module claims to be safe to call from a
 * Convex query, and that claim only holds if it pulls in nothing at runtime —
 * the single `import type` above is erased at compile time, so the emitted
 * module has no dependencies at all.
 *
 * It also must not define its own classifier. A second implementation of the
 * section 7.2 rule would eventually drift from the production one, and an audit
 * that disagrees with the thing it audits reports its own bugs as data
 * problems.
 *
 * Callers supply the one classifier that matters to them:
 *
 *   - the Convex audit query passes the production classifier
 *     (`convex/aspectClassification`, Phase 1);
 *   - the unit suite passes the fixture oracle from
 *     `lib/vertical-video-feed-fixtures.ts`.
 *
 * Once the production classifier exists, `findFixtureOracleDisagreements` in
 * the fixtures module cross-checks it against all 42 recorded expectations, so
 * "the two agree" is a test rather than an assumption.
 */
export type PlacementClassifier = (storedAspectRatio: string | null) => {
  aspectRatio: string | null;
  feedPlacement: FeedPlacement;
};

export type PlacementAuditRow = {
  muxAssetId: string;
  feedPlacement: FeedPlacement;
  isReady: boolean;
  isDeleted: boolean;
  /**
   * The **stored** normalized ratio, for example "9:16". Null when the asset has
   * no classifiable ratio. The audit re-derives placement from this value rather
   * than trusting `feedPlacement`.
   */
  aspectRatio: string | null;
};

export const PLACEMENT_MISMATCH_KINDS = [
  /** Stored placement disagrees with the placement the stored ratio implies. */
  "placement_disagrees",
  /** Stored ratio is valid but not in lowest terms; section 7.2 step 3 requires reduced. */
  "ratio_not_reduced",
  /**
   * A non-null stored ratio that does not parse. Section 7.1 types the field as
   * `string | null` holding a *normalized* ratio, so an unparseable value is a
   * contract violation whatever the stored placement says — `unknown` placement
   * does not make `"garbage"` an acceptable thing to have written.
   */
  "ratio_unparseable",
  /** Row claims a real placement but stored no ratio. */
  "placement_without_ratio",
] as const;
export type PlacementMismatchKind = (typeof PLACEMENT_MISMATCH_KINDS)[number];

export type PlacementMismatch = {
  muxAssetId: string;
  kind: PlacementMismatchKind;
  storedAspectRatio: string | null;
  storedPlacement: FeedPlacement;
  derivedAspectRatio: string | null;
  derivedPlacement: FeedPlacement;
};

export type PlacementDistribution = {
  /** Rows examined, including not-ready and deleted ones. */
  totalRows: number;
  /** Ready, non-deleted rows: the population the coverage gate is about. */
  readyRows: number;
  readyByPlacement: Record<FeedPlacement, number>;
  /** Ready rows classified `unknown`. The number the gate drives to zero. */
  readyUnknown: number;
  /** IDs of those rows, so an exception list can be matched against reality. */
  readyUnknownAssetIds: string[];
  /** Ready rows with a placement but no stored ratio string. */
  readyClassifiedWithoutRatio: number;
  /** Rows whose stored placement does not survive re-derivation. */
  placementMismatches: PlacementMismatch[];
  /** Ready rows whose id appears more than once. */
  duplicateAssetIds: string[];
  distinctAspectRatios: Record<string, number>;
};

function emptyPlacementCounts(): Record<FeedPlacement, number> {
  return { standard: 0, vertical: 0, unknown: 0 };
}

/**
 * Re-derives a row's placement from its stored ratio and reports any way the
 * two disagree.
 *
 * Trusting `feedPlacement` would make the audit tautological: it would confirm
 * that the column says what the column says. The whole value of the check is
 * that a classifier bug, a partial migration, or a hand-edited row shows up as
 * a mismatch instead of as a clean bill of health.
 */
function findRowMismatch(
  row: PlacementAuditRow,
  classify: PlacementClassifier,
): PlacementMismatch | null {
  const derived = classify(row.aspectRatio);

  const base = {
    muxAssetId: row.muxAssetId,
    storedAspectRatio: row.aspectRatio,
    storedPlacement: row.feedPlacement,
    derivedAspectRatio: derived.aspectRatio,
    derivedPlacement: derived.feedPlacement,
  };

  if (row.aspectRatio === null) {
    return row.feedPlacement === "unknown"
      ? null
      : { ...base, kind: "placement_without_ratio" };
  }

  if (derived.feedPlacement === "unknown") {
    // The cache contract says an unclassifiable asset stores `null`, not the
    // raw junk it failed to parse. A row holding `"garbage"` is inconsistent
    // even when its placement is honestly `unknown`, because the next reader —
    // a dashboard grouping by ratio, a rerun of the classifier — has no way to
    // tell a stored non-value from a stored value.
    return { ...base, kind: "ratio_unparseable" };
  }

  if (derived.feedPlacement !== row.feedPlacement) {
    return { ...base, kind: "placement_disagrees" };
  }

  if (derived.aspectRatio !== row.aspectRatio) {
    return { ...base, kind: "ratio_not_reduced" };
  }

  return null;
}

/**
 * Counts a set of cache rows by placement and re-derives every placement.
 *
 * Only ready, non-deleted rows count toward the placement totals: a deleted or
 * still-processing asset with an unknown ratio is not a coverage failure, and
 * folding it in would make the gate impossible to close.
 */
export function summarizePlacementDistribution(
  rows: readonly PlacementAuditRow[],
  classify: PlacementClassifier,
): PlacementDistribution {
  const readyByPlacement = emptyPlacementCounts();
  const distinctAspectRatios: Record<string, number> = {};
  const readyUnknownAssetIds: string[] = [];
  const placementMismatches: PlacementMismatch[] = [];
  const seenAssetIds = new Set<string>();
  const duplicateAssetIds = new Set<string>();
  let readyRows = 0;
  let readyClassifiedWithoutRatio = 0;

  for (const row of rows) {
    if (!row.isReady || row.isDeleted) continue;

    readyRows += 1;
    readyByPlacement[row.feedPlacement] += 1;

    if (seenAssetIds.has(row.muxAssetId)) duplicateAssetIds.add(row.muxAssetId);
    seenAssetIds.add(row.muxAssetId);

    if (row.feedPlacement === "unknown") readyUnknownAssetIds.push(row.muxAssetId);

    const mismatch = findRowMismatch(row, classify);
    if (mismatch) placementMismatches.push(mismatch);
    if (row.aspectRatio === null && row.feedPlacement !== "unknown") {
      readyClassifiedWithoutRatio += 1;
    }

    if (row.aspectRatio !== null) {
      distinctAspectRatios[row.aspectRatio] =
        (distinctAspectRatios[row.aspectRatio] ?? 0) + 1;
    }
  }

  return {
    totalRows: rows.length,
    readyRows,
    readyByPlacement,
    readyUnknown: readyByPlacement.unknown,
    readyUnknownAssetIds,
    readyClassifiedWithoutRatio,
    placementMismatches,
    duplicateAssetIds: [...duplicateAssetIds],
    distinctAspectRatios,
  };
}

export type CoverageGateStatus = "pass" | "fail" | "unmeasured";

export type DocumentedCoverageException = {
  muxAssetId: string;
  reason: string;
};

export type CoverageGateResult = {
  status: CoverageGateStatus;
  readyRows: number;
  readyUnknown: number;
  /** Unknown rows with no matching documented exception. */
  undocumentedUnknownAssetIds: string[];
  /** Exceptions whose id is not a ready, unknown-placement row right now. */
  staleExceptionAssetIds: string[];
  /** Ids listed more than once in the exception list. */
  duplicateExceptionAssetIds: string[];
  /** Exceptions that actually excuse a real unknown row. */
  matchedExceptions: readonly DocumentedCoverageException[];
  /** Rows whose stored placement failed re-derivation. */
  placementMismatches: readonly PlacementMismatch[];
  detail: string;
};

/**
 * Vertical-feed PRD Phase 1 exit gate: "Ready assets have zero unknown
 * placements, or every exception is recorded with a reason and remains visible
 * on legacy Home."
 *
 * Exceptions are matched **by asset id**, not counted. Counting was the earlier
 * shape of this function and it was wrong in a quiet way: three exception
 * entries naming assets that no longer exist would fully excuse three real
 * unknown rows nobody had ever looked at. Matching means a wrong id excuses
 * nothing, and a duplicated id excuses one row rather than two.
 *
 * An audit over zero rows is `unmeasured`, not `pass`. A deployment that has
 * never been scanned and a deployment that is fully classified must not produce
 * the same verdict.
 */
export function evaluateClassificationCoverageGate(
  distribution: PlacementDistribution,
  documentedExceptions: readonly DocumentedCoverageException[] = [],
): CoverageGateResult {
  const unknownIds = new Set(distribution.readyUnknownAssetIds);

  const seenExceptionIds = new Set<string>();
  const duplicateExceptionAssetIds: string[] = [];
  const usable: DocumentedCoverageException[] = [];

  for (const exception of documentedExceptions) {
    const id = exception.muxAssetId.trim();
    // An exception with no stated reason documents nothing; it is a name on a
    // list. Drop it before matching so it cannot excuse a row.
    if (id.length === 0 || exception.reason.trim().length === 0) continue;

    if (seenExceptionIds.has(id)) {
      duplicateExceptionAssetIds.push(id);
      continue;
    }
    seenExceptionIds.add(id);
    usable.push(exception);
  }

  const matchedExceptions = usable.filter((exception) =>
    unknownIds.has(exception.muxAssetId.trim()),
  );
  const matchedIds = new Set(
    matchedExceptions.map((exception) => exception.muxAssetId.trim()),
  );

  const staleExceptionAssetIds = usable
    .map((exception) => exception.muxAssetId.trim())
    .filter((id) => !unknownIds.has(id));

  const undocumentedUnknownAssetIds = distribution.readyUnknownAssetIds.filter(
    (id) => !matchedIds.has(id),
  );

  const base = {
    readyRows: distribution.readyRows,
    readyUnknown: distribution.readyUnknown,
    undocumentedUnknownAssetIds,
    staleExceptionAssetIds,
    duplicateExceptionAssetIds,
    matchedExceptions,
    placementMismatches: distribution.placementMismatches,
  };

  if (distribution.readyRows === 0) {
    return {
      ...base,
      status: "unmeasured",
      detail: "No ready rows were scanned; the gate has not been measured.",
    };
  }

  const failures: string[] = [];

  if (distribution.placementMismatches.length > 0) {
    const kinds = [
      ...new Set(distribution.placementMismatches.map((mismatch) => mismatch.kind)),
    ].sort();
    failures.push(
      `${distribution.placementMismatches.length} row(s) failed placement re-derivation (${kinds.join(", ")})`,
    );
  }

  if (distribution.duplicateAssetIds.length > 0) {
    failures.push(
      `${distribution.duplicateAssetIds.length} asset id(s) appear on more than one ready row`,
    );
  }

  if (duplicateExceptionAssetIds.length > 0) {
    failures.push(
      `${duplicateExceptionAssetIds.length} exception id(s) are listed more than once`,
    );
  }

  if (undocumentedUnknownAssetIds.length > 0) {
    failures.push(
      `${undocumentedUnknownAssetIds.length} ready row(s) have unknown placement with no matching documented exception`,
    );
  }

  if (failures.length > 0) {
    return { ...base, status: "fail", detail: `${failures.join("; ")}.` };
  }

  // Stale entries cannot excuse anything — matching already made sure of that —
  // so they are reported as cleanup rather than treated as a gate failure.
  const staleNote =
    staleExceptionAssetIds.length > 0
      ? ` ${staleExceptionAssetIds.length} exception entr(y/ies) no longer match an unknown row and can be pruned.`
      : "";

  return {
    ...base,
    status: "pass",
    detail:
      (distribution.readyUnknown === 0
        ? "Every ready row has a deterministic placement that survives re-derivation."
        : `${distribution.readyUnknown} unknown row(s), each matched to a documented exception and still visible on legacy Home.`) +
      staleNote,
  };
}

export type ExclusivityAuditInput = {
  /** Asset IDs the Home query returns. */
  homeAssetIds: readonly string[];
  /** Asset IDs the Shorts query returns. */
  shortsAssetIds: readonly string[];
  /** Every asset that should be reachable from exactly one feed. */
  eligibleAssetIds: readonly string[];
  /**
   * False during migration, when Home may still legitimately show 9:16 assets.
   * True once `exclusiveFeedPlacementEnabled` is on.
   */
  exclusivePlacementActive: boolean;
};

export type ExclusivityAuditResult = {
  /** Present in both feeds. Tolerated during migration, a failure after cutover. */
  duplicated: string[];
  /** Eligible but reachable from neither feed. Always a failure. */
  omitted: string[];
  /** Returned by a feed but not in the eligible set at all. */
  unexpected: string[];
  /** Ids a single feed returned more than once. Always a failure. */
  repeatedWithinHome: string[];
  repeatedWithinShorts: string[];
  /** Ids listed more than once in the eligible set, which makes the audit unsound. */
  repeatedWithinEligible: string[];
  status: CoverageGateStatus;
  detail: string;
};

/** Ids that appear more than once, in first-seen order. */
function findRepeatedIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) repeated.add(id);
    seen.add(id);
  }
  return [...repeated];
}

/**
 * PRD section 15: the rollout intentionally allows a temporary duplicate
 * between Home and Shorts, "but never allows a classified video to disappear
 * from both feeds."
 *
 * So omissions fail at every stage, while duplicates only fail once exclusive
 * placement is active. Encoding that asymmetry here is the point — a single
 * "are the feeds identical" check would either block the migration or miss the
 * one thing the migration must not do.
 */
export function auditFeedExclusivity(
  input: ExclusivityAuditInput,
): ExclusivityAuditResult {
  const home = new Set(input.homeAssetIds);
  const shorts = new Set(input.shortsAssetIds);
  const eligible = new Set(input.eligibleAssetIds);

  const duplicated = [...eligible].filter((id) => home.has(id) && shorts.has(id));
  const omitted = [...eligible].filter((id) => !home.has(id) && !shorts.has(id));
  const unexpected = [...new Set([...home, ...shorts])].filter(
    (id) => !eligible.has(id),
  );

  // Set membership answers "is it in both feeds"; it cannot answer "did one
  // feed return it twice". That second question is PRD section 12's
  // "duplicate or cursor-lost cards = 0" metric, and collapsing the input to a
  // Set before asking it is how a paging bug hides inside a passing audit.
  const repeatedWithinHome = findRepeatedIds(input.homeAssetIds);
  const repeatedWithinShorts = findRepeatedIds(input.shortsAssetIds);
  const repeatedWithinEligible = findRepeatedIds(input.eligibleAssetIds);

  const base = {
    duplicated,
    omitted,
    unexpected,
    repeatedWithinHome,
    repeatedWithinShorts,
    repeatedWithinEligible,
  };

  if (eligible.size === 0) {
    return {
      ...base,
      status: "unmeasured",
      detail: "No eligible assets were supplied; exclusivity has not been measured.",
    };
  }

  const failures: string[] = [];
  if (omitted.length > 0) {
    failures.push(`${omitted.length} eligible asset(s) appear in neither feed`);
  }
  if (unexpected.length > 0) {
    failures.push(`${unexpected.length} returned asset(s) are not eligible`);
  }
  if (repeatedWithinHome.length > 0) {
    failures.push(`Home returned ${repeatedWithinHome.length} asset(s) more than once`);
  }
  if (repeatedWithinShorts.length > 0) {
    failures.push(
      `Shorts returned ${repeatedWithinShorts.length} asset(s) more than once`,
    );
  }
  if (repeatedWithinEligible.length > 0) {
    failures.push(
      `${repeatedWithinEligible.length} eligible id(s) were supplied more than once`,
    );
  }
  if (input.exclusivePlacementActive && duplicated.length > 0) {
    failures.push(
      `${duplicated.length} asset(s) appear in both feeds after the exclusivity cutover`,
    );
  }

  if (failures.length > 0) {
    return { ...base, status: "fail", detail: `${failures.join("; ")}.` };
  }

  return {
    ...base,
    status: "pass",
    detail:
      duplicated.length > 0
        ? `${duplicated.length} migration-era duplicate(s); acceptable until exclusive placement is enabled.`
        : "Every eligible asset appears in exactly one feed.",
  };
}

/**
 * Counts the Phase 1 backfill must return. Named to match the PRD wording:
 * "Return scanned/classified/unknown/unchanged/failed counts."
 */
export type BackfillCounters = {
  scanned: number;
  classified: number;
  unknown: number;
  unchanged: number;
  failed: number;
};

export type BackfillCounterReport = {
  counters: BackfillCounters;
  /** scanned minus the four outcome buckets. Non-zero means rows went missing. */
  unaccounted: number;
  balanced: boolean;
  /** True when a rerun over the same rows would be a no-op. */
  idempotentRun: boolean;
};

/**
 * Checks that a backfill run accounted for every row it scanned.
 *
 * A bounded, resumable backfill that silently drops rows is the failure mode
 * worth catching: the totals still look plausible, but coverage never reaches
 * zero unknowns and nothing says why.
 */
export function summarizeBackfillRun(counters: BackfillCounters): BackfillCounterReport {
  const accounted =
    counters.classified + counters.unknown + counters.unchanged + counters.failed;
  const unaccounted = counters.scanned - accounted;

  return {
    counters,
    unaccounted,
    balanced: unaccounted === 0,
    idempotentRun:
      counters.scanned > 0 &&
      counters.unchanged === counters.scanned &&
      counters.failed === 0,
  };
}

export type PlacementDiagnostics = {
  distribution: PlacementDistribution;
  coverage: CoverageGateResult;
  exclusivity: ExclusivityAuditResult | null;
  backfill: BackfillCounterReport | null;
};

/**
 * Everything PRD section 13 asks classification operations to expose, in one
 * object, so a dashboard panel and a runbook step read the same numbers.
 */
export function buildPlacementDiagnostics(input: {
  rows: readonly PlacementAuditRow[];
  /** The production classifier, or the fixture oracle in tests. */
  classify: PlacementClassifier;
  documentedExceptions?: readonly DocumentedCoverageException[];
  exclusivity?: ExclusivityAuditInput;
  backfill?: BackfillCounters;
}): PlacementDiagnostics {
  const distribution = summarizePlacementDistribution(input.rows, input.classify);

  return {
    distribution,
    coverage: evaluateClassificationCoverageGate(
      distribution,
      input.documentedExceptions ?? [],
    ),
    exclusivity: input.exclusivity ? auditFeedExclusivity(input.exclusivity) : null,
    backfill: input.backfill ? summarizeBackfillRun(input.backfill) : null,
  };
}

/** Renders diagnostics as fixed-width lines for a runbook paste or a dev overlay. */
export function formatPlacementDiagnostics(diagnostics: PlacementDiagnostics): string {
  const { distribution, coverage, exclusivity, backfill } = diagnostics;

  const lines = [
    `rows:      total=${distribution.totalRows} ready=${distribution.readyRows}`,
    `placement: standard=${distribution.readyByPlacement.standard} vertical=${distribution.readyByPlacement.vertical} unknown=${distribution.readyByPlacement.unknown}`,
    `rederive:  mismatches=${distribution.placementMismatches.length} duplicate_ids=${distribution.duplicateAssetIds.length}`,
    `coverage:  ${coverage.status} — ${coverage.detail}`,
  ];

  lines.push(
    exclusivity
      ? `exclusive: ${exclusivity.status} — ${exclusivity.detail}`
      : "exclusive: not audited",
  );

  lines.push(
    backfill
      ? `backfill:  scanned=${backfill.counters.scanned} classified=${backfill.counters.classified} unknown=${backfill.counters.unknown} unchanged=${backfill.counters.unchanged} failed=${backfill.counters.failed} balanced=${backfill.balanced}`
      : "backfill:  not run",
  );

  return lines.join("\n");
}
