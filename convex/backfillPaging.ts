/**
 * Bounded, resumable paging arithmetic for the asset backfills.
 *
 * This module is free of imports of any kind so the resume guarantees can be
 * unit tested directly:
 *
 *   node --experimental-strip-types --test tests/vertical-feed-data-backfill.test.ts
 *
 * Mux's asset list is paged by page *number*, which cannot express "resume in the
 * middle of page 4". A run that stopped mid-page would therefore have to either
 * re-read the prefix it already processed or skip the remainder of that page. The
 * plan below removes the choice: the request limit is lowered to the run's own
 * asset budget, so every page a run touches is consumed whole and the resume
 * token is always the next untouched page.
 */

/** Mux caps a single asset-list page at 100. */
export const MUX_LIST_MAX_PAGE_SIZE = 100;

export type BackfillPagePlan = {
  /** Assets to request per page. Never larger than the run's budget. */
  limit: number;
  /** Whole pages this run may process. Always at least one. */
  maxPages: number;
  /** 1-based page this run starts on. */
  startPage: number;
};

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

/**
 * Plans a bounded run.
 *
 * Guarantees, for any inputs:
 *
 *   - `limit >= 1` and `maxPages >= 1`, so a run always makes progress;
 *   - `limit * maxPages <= max(1, maxAssets)`, so the budget is never exceeded;
 *   - `limit <= maxAssets`, so a partially consumed page is impossible.
 *
 * A run may therefore process fewer assets than `maxAssets` when the budget is
 * not a whole multiple of the page size. Stopping on a page boundary is worth
 * more than saturating the budget, because it is what makes the resume exact.
 */
export function resolveBackfillPagePlan(args: {
  maxAssets: number;
  pageSize?: number;
  startPage?: number;
  maxPageSize?: number;
}): BackfillPagePlan {
  const maxPageSize = clampInteger(
    args.maxPageSize ?? MUX_LIST_MAX_PAGE_SIZE,
    1,
    MUX_LIST_MAX_PAGE_SIZE,
  );
  const maxAssets = Math.max(1, Math.floor(args.maxAssets) || 1);
  const pageSize = clampInteger(args.pageSize ?? maxPageSize, 1, maxPageSize);
  const limit = Math.min(pageSize, maxAssets);

  return {
    limit,
    maxPages: Math.max(1, Math.floor(maxAssets / limit)),
    startPage: clampInteger(args.startPage ?? 1, 1, Number.MAX_SAFE_INTEGER),
  };
}

export type BackfillPageOutcome = {
  /** The source list is exhausted; there is nothing left to resume. */
  isDone: boolean;
  /** Another page fits inside this run's budget. */
  shouldContinue: boolean;
  /** Resume token for the next run, or null when done. */
  nextPage: number | null;
};

/**
 * Decides what happens after a page has been fully processed.
 *
 * `nextPage` is `startPage + pagesProcessed`, which is strictly greater than
 * `startPage` for any completed page: a resumed run can never re-read the pages
 * an earlier run already finished, and can never stall on the same page.
 */
export function resolveBackfillPageOutcome(args: {
  startPage: number;
  pagesProcessed: number;
  maxPages: number;
  hasNextPage: boolean;
}): BackfillPageOutcome {
  const pagesProcessed = Math.max(0, Math.floor(args.pagesProcessed));

  if (!args.hasNextPage) {
    return { isDone: true, shouldContinue: false, nextPage: null };
  }

  return {
    isDone: false,
    shouldContinue: pagesProcessed < args.maxPages,
    nextPage: args.startPage + pagesProcessed,
  };
}

/**
 * Batch size for a cursor-paged (Convex) backfill.
 *
 * Convex cursors resume exactly, so the only requirement is that a batch is at
 * least one row and never overruns the remaining budget.
 */
export function resolveCursorBatchSize(args: {
  batchSize: number;
  scanned: number;
  maxAssets: number;
  maxBatchSize: number;
}): number {
  const maxBatchSize = Math.max(1, Math.floor(args.maxBatchSize));
  const batchSize = clampInteger(args.batchSize, 1, maxBatchSize);
  const remaining = Math.floor(args.maxAssets) - Math.floor(args.scanned);

  return Math.max(1, Math.min(batchSize, remaining));
}
