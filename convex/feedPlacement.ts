/**
 * Aspect-classification backfill and the read-only placement audit.
 *
 * New assets are classified by the asset-sync writer in `./muxAssetCache.ts`, so
 * this module exists only for rows that predate classification. It reads the
 * ratio from the Mux component's own asset table (`components.mux.catalog`),
 * which already stores `aspectRatio` plus the original payload under `raw`, so
 * the backfill needs no Mux API credentials and the hot feed query never reads
 * the component at all.
 *
 * Operations:
 *
 *   npx convex run feedPlacement:backfillAspectClassification '{}'
 *   npx convex run feedPlacement:auditFeedPlacementCoverage '{}'
 *
 * The backfill is bounded (`batchSize`/`maxAssets`), resumable (pass the
 * returned `continueCursor` back in), idempotent (a row whose classification is
 * unchanged is not written), and safe to rerun. Pass `{"force": true}` to
 * reclassify every row, or `{"includeUnknown": true}` to retry rows that are
 * currently `unknown` (for example after Mux finishes processing an asset that
 * had no ratio yet).
 *
 * Rollback: the schema fields and the placement index may stay in place if the
 * feature is disabled. Nothing outside the placement-scoped queries reads them,
 * and the legacy Home path (`feed.listFeedVideosPaginated`) ignores placement
 * entirely, so a disabled Shorts tab leaves Home exactly as it is today.
 */

import { v } from "convex/values";

import { api, components, internal } from "./_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import {
  type FeedPlacement,
  buildAspectClassificationPatch,
  classifyAspectRatio,
  isStoredAspectClassificationConsistent,
  readMuxAspectRatioInput,
  resolveAspectClassificationForUpsert,
} from "./aspectClassification";
import {
  type FeedPlacementAuditSummary,
  type PlacementFeedAsset,
  mergeFeedPlacementAuditSummaries,
  summarizeFeedPlacements,
} from "./feedContracts";
import { resolveCursorBatchSize } from "./backfillPaging";

const BACKFILL_DEFAULT_BATCH_SIZE = 50;
const BACKFILL_MAX_BATCH_SIZE = 200;
const BACKFILL_DEFAULT_MAX_ASSETS = 5000;

const AUDIT_DEFAULT_PAGE_SIZE = 200;
const AUDIT_MAX_PAGE_SIZE = 1000;
const AUDIT_DEFAULT_MAX_ROWS = 20_000;

type ClassificationEntry = {
  muxAssetId: string;
  /**
   * The raw ratio string as Mux reports it, before normalization. Only read when
   * `aspectRatioProvided` is true.
   */
  sourceAspectRatio?: string;
  /** False when the component holds no ratio data for this asset. */
  aspectRatioProvided: boolean;
};

export type ClassificationCounters = {
  /** Rows whose stored classification was rewritten. */
  classified: number;
  /** Rows already carrying the resolved classification. */
  unchanged: number;
  /** Candidates whose cache row disappeared between the read and the write. */
  missingAsset: number;
  vertical: number;
  standard: number;
  unknown: number;
};

function emptyClassificationCounters(): ClassificationCounters {
  return {
    classified: 0,
    unchanged: 0,
    missingAsset: 0,
    vertical: 0,
    standard: 0,
    unknown: 0,
  };
}

function countPlacement(
  counters: ClassificationCounters,
  placement: FeedPlacement,
) {
  if (placement === "vertical") counters.vertical += 1;
  else if (placement === "standard") counters.standard += 1;
  else counters.unknown += 1;
}

/**
 * Candidates are rows that carry no placement at all, plus — when
 * `includeUnknown` is set — rows classified `unknown`, which is the retry path
 * for assets Mux had not finished processing on the first pass.
 */
export const listClassificationBackfillCandidatesInternal = internalQuery({
  args: {
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
    force: v.optional(v.boolean()),
    includeUnknown: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const page = await (ctx.db as any).query("muxAssetCache").paginate({
      cursor: args.cursor,
      numItems: Math.max(
        1,
        Math.min(BACKFILL_MAX_BATCH_SIZE, Math.floor(args.numItems)),
      ),
    });

    const candidates = (page.page as any[])
      .filter(
        (row) =>
          args.force === true ||
          row.feedPlacement === undefined ||
          (args.includeUnknown === true && row.feedPlacement === "unknown"),
      )
      .map((row) => ({ muxAssetId: row.muxAssetId as string }));

    return {
      candidates,
      scanned: page.page.length as number,
      isDone: page.isDone as boolean,
      continueCursor: page.continueCursor as string,
    };
  },
});

/**
 * Applies classifications transactionally.
 *
 * The patch carries the classification columns only, so the denormalized
 * `feed*` read-model fields and every asset column are preserved untouched.
 * `updatedAtMs` is deliberately left alone: this write does not change the
 * asset, and `aspectRatioUpdatedAtMs` already records when classification moved.
 */
export const applyClassificationEntriesInternal = internalMutation({
  args: {
    entries: v.array(
      v.object({
        muxAssetId: v.string(),
        sourceAspectRatio: v.optional(v.string()),
        aspectRatioProvided: v.boolean(),
      }),
    ),
  },
  handler: async (ctx, args): Promise<ClassificationCounters> => {
    const counters = emptyClassificationCounters();
    const nowMs = Date.now();

    for (const entry of args.entries) {
      const existing = await (ctx.db as any)
        .query("muxAssetCache")
        .withIndex("by_mux_asset", (q: any) =>
          q.eq("muxAssetId", entry.muxAssetId),
        )
        .unique();

      if (!existing) {
        counters.missingAsset += 1;
        continue;
      }

      const incoming = entry.aspectRatioProvided
        ? classifyAspectRatio(entry.sourceAspectRatio)
        : { aspectRatio: null, feedPlacement: undefined };

      const resolved = resolveAspectClassificationForUpsert({
        existing,
        incoming,
      });
      countPlacement(counters, resolved.feedPlacement);

      if (!resolved.changed) {
        counters.unchanged += 1;
        continue;
      }

      await ctx.db.patch(
        existing._id,
        buildAspectClassificationPatch(resolved, nowMs) as any,
      );
      counters.classified += 1;
    }

    return counters;
  },
});

export const backfillAspectClassification = internalAction({
  args: {
    batchSize: v.optional(v.number()),
    maxAssets: v.optional(v.number()),
    /** Resume token from a previous run's `continueCursor`. */
    cursor: v.optional(v.union(v.string(), v.null())),
    force: v.optional(v.boolean()),
    includeUnknown: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<
    ClassificationCounters & {
      scanned: number;
      inspected: number;
      failed: number;
      isDone: boolean;
      continueCursor: string | null;
    }
  > => {
    const batchSize = Math.max(
      1,
      Math.min(
        BACKFILL_MAX_BATCH_SIZE,
        Math.floor(args.batchSize ?? BACKFILL_DEFAULT_BATCH_SIZE),
      ),
    );
    const maxAssets = Math.max(
      1,
      Math.floor(args.maxAssets ?? BACKFILL_DEFAULT_MAX_ASSETS),
    );

    const totals = emptyClassificationCounters();
    let cursor: string | null = args.cursor ?? null;
    let scanned = 0;
    let inspected = 0;
    let failed = 0;
    let isDone = false;

    while (scanned < maxAssets) {
      const page: {
        candidates: { muxAssetId: string }[];
        scanned: number;
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runQuery(
        (internal as any).feedPlacement.listClassificationBackfillCandidatesInternal,
        {
          cursor,
          numItems: resolveCursorBatchSize({
            batchSize,
            scanned,
            maxAssets,
            maxBatchSize: BACKFILL_MAX_BATCH_SIZE,
          }),
          force: args.force,
          includeUnknown: args.includeUnknown,
        },
      );

      scanned += page.scanned;
      const entries: ClassificationEntry[] = [];

      // A page that scanned nothing cannot advance the run; stop rather than
      // spin on the same cursor.
      if (page.scanned === 0 && !page.isDone) {
        cursor = page.continueCursor;
        break;
      }

      for (const candidate of page.candidates) {
        try {
          const componentAsset = await ctx.runQuery(
            components.mux.catalog.getAssetByMuxId,
            { muxAssetId: candidate.muxAssetId },
          );
          // Reads camelCase `aspectRatio` on the component row and falls back to
          // snake_case `raw.aspect_ratio` from the original Mux payload.
          const input = readMuxAspectRatioInput(componentAsset);

          entries.push({
            muxAssetId: candidate.muxAssetId,
            sourceAspectRatio:
              typeof input.value === "string" ? input.value : undefined,
            aspectRatioProvided: input.provided,
          });
          inspected += 1;
        } catch {
          // One unreadable asset must not abort the run; rerunning picks it up.
          failed += 1;
        }
      }

      if (entries.length > 0) {
        const applied: ClassificationCounters = await ctx.runMutation(
          (internal as any).feedPlacement.applyClassificationEntriesInternal,
          { entries },
        );

        totals.classified += applied.classified;
        totals.unchanged += applied.unchanged;
        totals.missingAsset += applied.missingAsset;
        totals.vertical += applied.vertical;
        totals.standard += applied.standard;
        totals.unknown += applied.unknown;
      }

      cursor = page.continueCursor;
      if (page.isDone) {
        isDone = true;
        break;
      }
    }

    return {
      ...totals,
      scanned,
      inspected,
      failed,
      isDone,
      // Null once the table is exhausted; otherwise pass it back in to resume.
      continueCursor: isDone ? null : cursor,
    };
  },
});

/* ------------------------------------------------------------------ *
 * Read-only placement audit
 * ------------------------------------------------------------------ */

/**
 * One bounded page of placement totals, overlap, omission, integrity, and
 * duplicate counts. Read-only and safe to run against production. Call repeatedly
 * with `continueCursor`, or use `auditFeedPlacementCoverage` to aggregate.
 *
 * Duplicate `muxAssetId` rows are resolved through `by_mux_asset`, not within the
 * page, so a duplicate pair that straddles two cursor pages is still counted.
 */
export const getFeedPlacementAuditPage = query({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    summary: FeedPlacementAuditSummary;
    isDone: boolean;
    continueCursor: string;
  }> => {
    const cursor = args.cursor ?? null;
    const page = await (ctx.db as any).query("muxAssetCache").paginate({
      cursor,
      numItems: Math.max(
        1,
        Math.min(
          AUDIT_MAX_PAGE_SIZE,
          Math.floor(args.numItems ?? AUDIT_DEFAULT_PAGE_SIZE),
        ),
      ),
    });

    const rows = page.page as PlacementFeedAsset[];
    const duplicateIds = new Set<string>();
    const checkedIds = new Set<string>();

    for (const row of rows) {
      if (checkedIds.has(row.muxAssetId)) continue;
      checkedIds.add(row.muxAssetId);

      const sameId = await (ctx.db as any)
        .query("muxAssetCache")
        .withIndex("by_mux_asset", (q: any) => q.eq("muxAssetId", row.muxAssetId))
        .take(2);

      if (sameId.length > 1) duplicateIds.add(row.muxAssetId);
    }

    return {
      summary: summarizeFeedPlacements(rows, {
        // A single page is a complete scan only when it is both the first and the
        // last page of the table.
        scanComplete: cursor === null && page.isDone === true,
        isClassificationConsistent: isStoredAspectClassificationConsistent,
        hasDuplicateMuxAssetId: (asset) => duplicateIds.has(asset.muxAssetId),
      }),
      isDone: page.isDone as boolean,
      continueCursor: page.continueCursor as string,
    };
  },
});

/**
 * The coverage gate for the exclusive Home cutover.
 *
 * `coverageGatePassed` is true only when the scan reached the end of the table
 * *and* every playable ready asset appears in exactly one feed:
 * `omittedAfterCutover` counts rows that would appear in neither,
 * `overlapExclusive` counts rows that would appear in both,
 * `inconsistentClassification` counts rows whose stored ratio and placement
 * disagree (which would serve a row from the wrong feed), and `duplicateIdRows`
 * counts ready rows whose `muxAssetId` is not unique (which can surface the same
 * video twice across cursor pages). A run that stops at `maxRows` reports
 * `scanComplete: false` and can never pass.
 *
 * `overlapLegacyMigration` is expected to be non-zero before the cutover, since
 * legacy Home intentionally still shows vertical assets.
 *
 * Repairs: rerun `backfillAspectClassification` with `{"force": true}` to rewrite
 * inconsistent classifications, and `{"includeUnknown": true}` to retry rows Mux
 * had not finished processing. Duplicate rows are a cache-integrity fault and
 * must be removed by hand; the upsert path reads `muxAssetCache` through a unique
 * lookup, so it will surface them loudly on the next asset event.
 */
export const auditFeedPlacementCoverage = internalAction({
  args: {
    pageSize: v.optional(v.number()),
    maxRows: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    summary: FeedPlacementAuditSummary;
    pages: number;
    isDone: boolean;
    scanComplete: boolean;
    coverageGatePassed: boolean;
    continueCursor: string | null;
  }> => {
    const pageSize = Math.max(
      1,
      Math.min(
        AUDIT_MAX_PAGE_SIZE,
        Math.floor(args.pageSize ?? AUDIT_DEFAULT_PAGE_SIZE),
      ),
    );
    const maxRows = Math.max(
      1,
      Math.floor(args.maxRows ?? AUDIT_DEFAULT_MAX_ROWS),
    );

    const summaries: FeedPlacementAuditSummary[] = [];
    let cursor: string | null = null;
    let scanned = 0;
    let pages = 0;
    let isDone = false;

    while (scanned < maxRows) {
      const page: {
        summary: FeedPlacementAuditSummary;
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runQuery((api as any).feedPlacement.getFeedPlacementAuditPage, {
        cursor,
        numItems: Math.min(pageSize, maxRows - scanned),
      });

      summaries.push(page.summary);
      scanned += page.summary.scanned;
      pages += 1;
      cursor = page.continueCursor;

      if (page.isDone) {
        isDone = true;
        break;
      }
    }

    // Merging an empty list is the empty-table case, and still gates on
    // completeness rather than reporting a pass by default.
    const summary = mergeFeedPlacementAuditSummaries(summaries, {
      scanComplete: isDone,
    });

    return {
      summary,
      pages,
      isDone,
      scanComplete: summary.scanComplete,
      coverageGatePassed: summary.coverageGatePassed,
      continueCursor: isDone ? null : cursor,
    };
  },
});
