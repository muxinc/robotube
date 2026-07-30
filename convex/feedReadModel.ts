/**
 * The paginated feed query does not call `components.mux.videos.*` per card, so
 * the display-ready title/uploader values live denormalized on `muxAssetCache`.
 * They are written from the same metadata mutation path every writer already
 * uses (`upsertVideoMetadataAndSyncFeedReadModel`), and `backfillFeedReadModel`
 * repairs rows that predate the read model.
 *
 * Nothing here assumes the backfill has run: reads fall back to the passthrough
 * uploader and a deterministic placeholder title (see `feedContracts.ts`).
 */

import { v } from "convex/values";

import { components, internal } from "./_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import {
  asNonEmptyString,
  pickPrimaryMetadata,
  readChannelNameOverride,
} from "./feedContracts";

const BACKFILL_DEFAULT_BATCH_SIZE = 50;
const BACKFILL_MAX_BATCH_SIZE = 200;
const BACKFILL_DEFAULT_MAX_ASSETS = 5000;

type FeedReadModelPatch = {
  feedTitle?: string;
  feedChannelName?: string;
  feedUploaderUserId?: string;
  feedReadModelUpdatedAtMs: number;
};

/**
 * Applies a read-model patch to the cached asset row.
 *
 * `undefined` on an applied field removes it, which mirrors the component's
 * own "only write what was provided" semantics: a metadata write that does not
 * carry a title must not clobber the denormalized title.
 */
async function patchFeedReadModel(
  ctx: MutationCtx,
  args: {
    muxAssetId: string;
    title?: string;
    uploaderUserId?: string;
    channelName?: string;
    applyChannelName: boolean;
  },
): Promise<"patched" | "unchanged" | "missing_asset"> {
  const existing = await (ctx.db as any)
    .query("muxAssetCache")
    .withIndex("by_mux_asset", (q: any) => q.eq("muxAssetId", args.muxAssetId))
    .unique();

  if (!existing) {
    return "missing_asset";
  }

  const patch: FeedReadModelPatch = {
    feedReadModelUpdatedAtMs: Date.now(),
  };
  let changed = false;

  if (args.title !== undefined && existing.feedTitle !== args.title) {
    patch.feedTitle = args.title;
    changed = true;
  }

  if (
    args.uploaderUserId !== undefined &&
    existing.feedUploaderUserId !== args.uploaderUserId
  ) {
    patch.feedUploaderUserId = args.uploaderUserId;
    changed = true;
  }

  if (args.applyChannelName && existing.feedChannelName !== args.channelName) {
    patch.feedChannelName = args.channelName;
    changed = true;
  }

  if (!changed && existing.feedReadModelUpdatedAtMs !== undefined) {
    return "unchanged";
  }

  await ctx.db.patch(existing._id, patch as any);
  return "patched";
}

/**
 * Write-through sync from a video-metadata write. Called by
 * `upsertVideoMetadataAndSyncFeedReadModel`, and safe to call directly from a
 * mutation that already wrote metadata.
 */
export const applyVideoMetadataInternal = internalMutation({
  args: {
    muxAssetId: v.string(),
    uploaderUserId: v.optional(v.string()),
    title: v.optional(v.string()),
    channelName: v.optional(v.string()),
    applyChannelName: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const result = await patchFeedReadModel(ctx, {
      muxAssetId: args.muxAssetId,
      title: args.title,
      uploaderUserId: args.uploaderUserId,
      channelName: args.channelName,
      applyChannelName: args.applyChannelName === true,
    });

    return { ok: true, result };
  },
});

export const listBackfillCandidatesInternal = internalQuery({
  args: {
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
    force: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const page = await (ctx.db as any).query("muxAssetCache").paginate({
      cursor: args.cursor,
      numItems: Math.max(1, Math.min(BACKFILL_MAX_BATCH_SIZE, args.numItems)),
    });

    // Target rows that are still missing display data rather than rows that
    // have simply never been touched: a metadata write that carried no title
    // stamps `feedReadModelUpdatedAtMs` while leaving `feedTitle` unset.
    const candidates = (page.page as any[])
      .filter(
        (row) =>
          args.force === true ||
          row.feedTitle === undefined ||
          row.feedUploaderUserId === undefined,
      )
      .map((row) => ({ muxAssetId: row.muxAssetId as string }));

    return {
      candidates,
      scanned: page.page.length,
      isDone: page.isDone as boolean,
      continueCursor: page.continueCursor as string,
    };
  },
});

export const applyBackfillEntriesInternal = internalMutation({
  args: {
    entries: v.array(
      v.object({
        muxAssetId: v.string(),
        title: v.optional(v.string()),
        uploaderUserId: v.optional(v.string()),
        channelName: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    let patched = 0;
    let unchanged = 0;
    let missingAsset = 0;

    for (const entry of args.entries) {
      const result = await patchFeedReadModel(ctx, {
        muxAssetId: entry.muxAssetId,
        title: entry.title,
        uploaderUserId: entry.uploaderUserId,
        channelName: entry.channelName,
        applyChannelName: true,
      });

      if (result === "patched") patched += 1;
      else if (result === "unchanged") unchanged += 1;
      else missingAsset += 1;
    }

    return { patched, unchanged, missingAsset };
  },
});

/**
 * Repair/backfill tooling. Run after deploying the read model:
 *
 *   npx convex run feedReadModel:backfillFeedReadModel '{}'
 *
 * Pass `{"force": true}` to rewrite rows that already carry read-model values.
 * This is the only place that reads Mux component metadata in bulk; the feed
 * query itself never does.
 */
export const backfillFeedReadModel = internalAction({
  args: {
    batchSize: v.optional(v.number()),
    maxAssets: v.optional(v.number()),
    force: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    scanned: number;
    inspected: number;
    patched: number;
    unchanged: number;
    missingAsset: number;
    isDone: boolean;
  }> => {
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

    let cursor: string | null = null;
    let scanned = 0;
    let inspected = 0;
    let patched = 0;
    let unchanged = 0;
    let missingAsset = 0;
    let isDone = false;

    while (scanned < maxAssets) {
      const page: {
        candidates: { muxAssetId: string }[];
        scanned: number;
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runQuery(
        (internal as any).feedReadModel.listBackfillCandidatesInternal,
        { cursor, numItems: batchSize, force: args.force },
      );

      scanned += page.scanned;

      const entries: {
        muxAssetId: string;
        title?: string;
        uploaderUserId?: string;
        channelName?: string;
      }[] = [];

      for (const candidate of page.candidates) {
        const video = await ctx.runQuery(
          components.mux.videos.getVideoByMuxAssetId,
          { muxAssetId: candidate.muxAssetId },
        );
        const metadata = pickPrimaryMetadata((video as any)?.metadata);
        inspected += 1;

        entries.push({
          muxAssetId: candidate.muxAssetId,
          title: asNonEmptyString(metadata.title) ?? undefined,
          uploaderUserId: asNonEmptyString(metadata.userId) ?? undefined,
          channelName: readChannelNameOverride(metadata.custom),
        });
      }

      if (entries.length > 0) {
        const applied: {
          patched: number;
          unchanged: number;
          missingAsset: number;
        } = await ctx.runMutation(
          (internal as any).feedReadModel.applyBackfillEntriesInternal,
          { entries },
        );

        patched += applied.patched;
        unchanged += applied.unchanged;
        missingAsset += applied.missingAsset;
      }

      if (page.isDone) {
        isDone = true;
        break;
      }

      cursor = page.continueCursor;
    }

    return { scanned, inspected, patched, unchanged, missingAsset, isDone };
  },
});
