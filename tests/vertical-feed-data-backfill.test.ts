/**
 * Backfill paging tests: a bounded run must always advance, must never re-read a
 * page it already finished, and must never skip one.
 *
 *   node --experimental-strip-types --test tests/vertical-feed-data-backfill.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MUX_LIST_MAX_PAGE_SIZE,
  resolveBackfillPageOutcome,
  resolveBackfillPagePlan,
  resolveCursorBatchSize,
} from "../convex/backfillPaging.ts";

/* ------------------------------------------------------------------ *
 * Page plans
 * ------------------------------------------------------------------ */

test("a plan never requests more assets per page than its budget", () => {
  assert.deepEqual(resolveBackfillPagePlan({ maxAssets: 500, pageSize: 100 }), {
    limit: 100,
    maxPages: 5,
    startPage: 1,
  });

  // The regression: a budget smaller than the page size used to leave a page
  // partially processed, so the resume token pointed back at the same prefix.
  assert.deepEqual(resolveBackfillPagePlan({ maxAssets: 10, pageSize: 100 }), {
    limit: 10,
    maxPages: 1,
    startPage: 1,
  });

  assert.deepEqual(resolveBackfillPagePlan({ maxAssets: 1 }), {
    limit: 1,
    maxPages: 1,
    startPage: 1,
  });

  // A budget that is not a whole multiple of the page size stops on a boundary.
  assert.deepEqual(resolveBackfillPagePlan({ maxAssets: 250, pageSize: 100 }), {
    limit: 100,
    maxPages: 2,
    startPage: 1,
  });
});

test("plan inputs are clamped instead of trusted", () => {
  assert.equal(resolveBackfillPagePlan({ maxAssets: 500, pageSize: 0 }).limit, 1);
  assert.equal(
    resolveBackfillPagePlan({ maxAssets: 500, pageSize: 10_000 }).limit,
    MUX_LIST_MAX_PAGE_SIZE,
  );
  assert.equal(resolveBackfillPagePlan({ maxAssets: 0 }).limit, 1);
  assert.equal(resolveBackfillPagePlan({ maxAssets: -50 }).maxPages, 1);
  assert.equal(
    resolveBackfillPagePlan({ maxAssets: Number.NaN, pageSize: Number.NaN }).limit,
    1,
  );
  assert.equal(
    resolveBackfillPagePlan({ maxAssets: 100, startPage: 0 }).startPage,
    1,
  );
  assert.equal(
    resolveBackfillPagePlan({ maxAssets: 100, startPage: 3.7 }).startPage,
    3,
  );
});

test("every plan keeps its budget and still makes progress", () => {
  for (const maxAssets of [1, 2, 3, 7, 10, 99, 100, 101, 250, 500, 5000]) {
    for (const pageSize of [1, 2, 25, 100, 250]) {
      const plan = resolveBackfillPagePlan({ maxAssets, pageSize });

      assert.ok(plan.limit >= 1, `limit for ${maxAssets}/${pageSize}`);
      assert.ok(plan.maxPages >= 1, `maxPages for ${maxAssets}/${pageSize}`);
      assert.ok(
        plan.limit <= maxAssets,
        `limit must fit the budget for ${maxAssets}/${pageSize}`,
      );
      assert.ok(
        plan.limit * plan.maxPages <= maxAssets,
        `budget overrun for ${maxAssets}/${pageSize}`,
      );
    }
  }
});

/* ------------------------------------------------------------------ *
 * Page outcomes
 * ------------------------------------------------------------------ */

test("an exhausted source list has nothing to resume", () => {
  assert.deepEqual(
    resolveBackfillPageOutcome({
      startPage: 4,
      pagesProcessed: 1,
      maxPages: 5,
      hasNextPage: false,
    }),
    { isDone: true, shouldContinue: false, nextPage: null },
  );
});

test("a run that hits its page budget resumes past the pages it finished", () => {
  assert.deepEqual(
    resolveBackfillPageOutcome({
      startPage: 1,
      pagesProcessed: 1,
      maxPages: 1,
      hasNextPage: true,
    }),
    { isDone: false, shouldContinue: false, nextPage: 2 },
  );

  assert.deepEqual(
    resolveBackfillPageOutcome({
      startPage: 7,
      pagesProcessed: 2,
      maxPages: 2,
      hasNextPage: true,
    }),
    { isDone: false, shouldContinue: false, nextPage: 9 },
  );
});

test("a run keeps going while pages remain in its budget", () => {
  const outcome = resolveBackfillPageOutcome({
    startPage: 1,
    pagesProcessed: 2,
    maxPages: 5,
    hasNextPage: true,
  });

  assert.equal(outcome.shouldContinue, true);
  assert.equal(outcome.isDone, false);
});

test("the resume page is always past the start page", () => {
  for (const startPage of [1, 2, 9, 1000]) {
    for (const pagesProcessed of [1, 2, 5]) {
      const outcome = resolveBackfillPageOutcome({
        startPage,
        pagesProcessed,
        maxPages: pagesProcessed,
        hasNextPage: true,
      });

      assert.ok(
        (outcome.nextPage ?? 0) > startPage,
        `resume must advance from ${startPage} after ${pagesProcessed} pages`,
      );
    }
  }
});

/* ------------------------------------------------------------------ *
 * A simulated resumed run over the whole list
 * ------------------------------------------------------------------ */

type FakeMuxPage = {
  data: string[];
  hasNextPage: () => boolean;
  getNextPage: () => FakeMuxPage;
};

function fakeMuxList(
  assets: readonly string[],
  params: { limit: number; page: number },
): FakeMuxPage {
  const offset = (params.page - 1) * params.limit;

  return {
    data: assets.slice(offset, offset + params.limit) as string[],
    hasNextPage: () => offset + params.limit < assets.length,
    getNextPage: () =>
      fakeMuxList(assets, { limit: params.limit, page: params.page + 1 }),
  };
}

/** Mirrors the loop in `migrations.backfillMuxAssetCache`. */
function runOneBackfillPass(
  assets: readonly string[],
  args: { maxAssets: number; pageSize?: number; startPage?: number },
) {
  const plan = resolveBackfillPagePlan(args);
  const processed: string[] = [];

  let page = fakeMuxList(assets, { limit: plan.limit, page: plan.startPage });
  let pagesProcessed = 0;
  let nextPage: number | null = null;
  let isDone = false;

  for (;;) {
    for (const asset of page.data) processed.push(asset);
    pagesProcessed += 1;

    const outcome = resolveBackfillPageOutcome({
      startPage: plan.startPage,
      pagesProcessed,
      maxPages: plan.maxPages,
      hasNextPage: page.hasNextPage(),
    });
    isDone = outcome.isDone;
    nextPage = outcome.nextPage;

    if (!outcome.shouldContinue) break;
    page = page.getNextPage();
  }

  return { processed, nextPage, isDone, plan };
}

test("a small budget still advances instead of reprocessing its prefix", () => {
  const assets = Array.from({ length: 100 }, (_, index) => `asset_${index}`);

  const first = runOneBackfillPass(assets, { maxAssets: 10, pageSize: 100 });
  assert.deepEqual(first.processed, assets.slice(0, 10));
  assert.equal(first.isDone, false);
  assert.equal(first.nextPage, 2);

  const second = runOneBackfillPass(assets, {
    maxAssets: 10,
    pageSize: 100,
    startPage: first.nextPage ?? 1,
  });
  assert.deepEqual(second.processed, assets.slice(10, 20));
  assert.equal(second.nextPage, 3);

  // No asset is seen twice across the two runs.
  const seen = [...first.processed, ...second.processed];
  assert.equal(new Set(seen).size, seen.length);
});

test("resumed runs cover the whole list exactly once", () => {
  const cases = [
    { total: 100, maxAssets: 10, pageSize: 100 },
    { total: 100, maxAssets: 250, pageSize: 100 },
    { total: 7, maxAssets: 3, pageSize: 2 },
    { total: 7, maxAssets: 1, pageSize: 100 },
    { total: 250, maxAssets: 100, pageSize: 100 },
    { total: 13, maxAssets: 5, pageSize: 4 },
  ];

  for (const testCase of cases) {
    const assets = Array.from(
      { length: testCase.total },
      (_, index) => `asset_${index}`,
    );
    const label = `${testCase.total} assets, budget ${testCase.maxAssets}, page ${testCase.pageSize}`;

    const processed: string[] = [];
    let startPage = 1;

    for (let run = 0; run < 500; run += 1) {
      const pass = runOneBackfillPass(assets, {
        maxAssets: testCase.maxAssets,
        pageSize: testCase.pageSize,
        startPage,
      });

      assert.ok(
        pass.processed.length > 0 || pass.isDone,
        `${label}: a run must process something or finish`,
      );
      processed.push(...pass.processed);

      if (pass.isDone) break;
      assert.ok(
        (pass.nextPage ?? 0) > startPage,
        `${label}: resume must advance from ${startPage}`,
      );
      startPage = pass.nextPage ?? startPage + 1;
    }

    assert.deepEqual(processed, assets, `${label}: exact once-through coverage`);
    assert.equal(new Set(processed).size, processed.length, `${label}: duplicates`);
  }
});

test("an empty source list finishes immediately", () => {
  const pass = runOneBackfillPass([], { maxAssets: 100 });

  assert.deepEqual(pass.processed, []);
  assert.equal(pass.isDone, true);
  assert.equal(pass.nextPage, null);
});

/* ------------------------------------------------------------------ *
 * Cursor batches
 * ------------------------------------------------------------------ */

test("a cursor batch stays inside the remaining budget", () => {
  assert.equal(
    resolveCursorBatchSize({
      batchSize: 50,
      scanned: 0,
      maxAssets: 5000,
      maxBatchSize: 200,
    }),
    50,
  );
  assert.equal(
    resolveCursorBatchSize({
      batchSize: 50,
      scanned: 4990,
      maxAssets: 5000,
      maxBatchSize: 200,
    }),
    10,
  );
  assert.equal(
    resolveCursorBatchSize({
      batchSize: 1000,
      scanned: 0,
      maxAssets: 5000,
      maxBatchSize: 200,
    }),
    200,
  );
});

test("a cursor batch is never empty", () => {
  for (const scanned of [5000, 5001, 10_000]) {
    assert.equal(
      resolveCursorBatchSize({
        batchSize: 50,
        scanned,
        maxAssets: 5000,
        maxBatchSize: 200,
      }),
      1,
    );
  }

  assert.equal(
    resolveCursorBatchSize({
      batchSize: Number.NaN,
      scanned: 0,
      maxAssets: 100,
      maxBatchSize: 200,
    }),
    1,
  );
});
