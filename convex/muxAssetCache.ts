import { v } from "convex/values";

import {
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import {
  type FeedPlacement,
  buildAspectClassificationPatch,
  classifyMuxAssetPayloadAspect,
  resolveAspectClassificationForUpsert,
} from "./aspectClassification";
import type { FeedVisibility } from "./feedContracts";

export type CachedPlaybackId = {
  id: string;
  policy?: string;
};

export type CachedMuxAsset = {
  muxAssetId: string;
  status: string;
  isReady: boolean;
  isDeleted: boolean;
  durationSeconds?: number;
  createdAtMs: number;
  deletedAtMs?: number;
  passthrough?: string;
  playbackIds: CachedPlaybackId[];
  // Feed read model, maintained by ./feedReadModel.ts. Never written by the
  // asset-sync path below, so an asset upsert cannot clobber it.
  feedTitle?: string;
  feedChannelName?: string;
  feedUploaderUserId?: string;
  feedVisibility?: FeedVisibility;
  feedThumbnailTimestampMs?: number;
  feedReadModelUpdatedAtMs?: number;
  // Aspect classification, derived from the processed Mux asset by the sync path
  // below. `feedPlacement` is denormalized so a placement-scoped feed can
  // paginate through an index instead of filtering a mixed page.
  aspectRatio?: string;
  feedPlacement?: FeedPlacement;
  aspectRatioUpdatedAtMs?: number;
  updatedAtMs: number;
};

type CachedMuxAssetComparable = Omit<
  CachedMuxAsset,
  | "updatedAtMs"
  | "feedTitle"
  | "feedChannelName"
  | "feedUploaderUserId"
  | "feedVisibility"
  | "feedThumbnailTimestampMs"
  | "feedReadModelUpdatedAtMs"
  | "aspectRatioUpdatedAtMs"
>;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asTimestampMs(value: unknown): number | undefined {
  const numericValue = asFiniteNumber(value);
  if (numericValue !== undefined) {
    return numericValue > 1_000_000_000_000 ? numericValue : numericValue * 1000;
  }

  const stringValue = asString(value);
  if (!stringValue) {
    return undefined;
  }

  const parsedDate = Date.parse(stringValue);
  return Number.isFinite(parsedDate) ? parsedDate : undefined;
}

function normalizePlaybackIds(value: unknown): CachedPlaybackId[] {
  const rawItems = asArray(value) ?? [];
  const normalized: CachedPlaybackId[] = [];

  for (const item of rawItems) {
    const record = asRecord(item);
    const id = asString(record?.id);
    if (!id) {
      continue;
    }

    normalized.push({
      id,
      policy: asString(record?.policy),
    });
  }

  return normalized.sort((left, right) => {
    if (left.id !== right.id) {
      return left.id.localeCompare(right.id);
    }

    return (left.policy ?? "").localeCompare(right.policy ?? "");
  });
}

function arePlaybackIdsEqual(left: CachedPlaybackId[], right: CachedPlaybackId[]) {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index]?.id !== right[index]?.id) {
      return false;
    }

    if ((left[index]?.policy ?? undefined) !== (right[index]?.policy ?? undefined)) {
      return false;
    }
  }

  return true;
}

function isComparableAssetEqual(
  left: CachedMuxAssetComparable,
  right: CachedMuxAssetComparable,
) {
  return (
    left.muxAssetId === right.muxAssetId &&
    left.status === right.status &&
    left.isReady === right.isReady &&
    left.isDeleted === right.isDeleted &&
    left.durationSeconds === right.durationSeconds &&
    left.createdAtMs === right.createdAtMs &&
    left.deletedAtMs === right.deletedAtMs &&
    left.passthrough === right.passthrough &&
    left.aspectRatio === right.aspectRatio &&
    left.feedPlacement === right.feedPlacement &&
    arePlaybackIdsEqual(left.playbackIds, right.playbackIds)
  );
}

/**
 * Normalizes any Mux-shaped asset payload (webhook `data`, a Mux SDK asset, or a
 * Mux component asset row) into the cached row shape.
 *
 * `feedPlacement === undefined` means the payload carried no aspect-ratio data
 * at all, so the upsert below preserves whatever classification is already
 * stored. A payload that *does* carry ratio data always wins, even when the
 * ratio is unusable and classifies to `unknown`.
 */
export function normalizeMuxAssetPayload(asset: unknown): CachedMuxAsset | null {
  const record = asRecord(asset);
  const muxAssetId = asString(record?.muxAssetId) ?? asString(record?.id);
  if (!muxAssetId) {
    return null;
  }

  const status = asString(record?.status) ?? "unknown";
  const createdAtMs = asTimestampMs(record?.createdAtMs ?? record?.created_at) ?? Date.now();
  const deletedAtMs = asTimestampMs(record?.deletedAtMs ?? record?.deleted_at);
  const playbackIds = normalizePlaybackIds(record?.playbackIds ?? record?.playback_ids);
  const durationSeconds = asFiniteNumber(record?.durationSeconds ?? record?.duration);
  const classification = classifyMuxAssetPayloadAspect(record);

  return {
    muxAssetId,
    status,
    isReady: status === "ready",
    isDeleted: deletedAtMs !== undefined || status === "deleted",
    durationSeconds,
    createdAtMs,
    deletedAtMs,
    passthrough: asString(record?.passthrough),
    playbackIds,
    aspectRatio: classification.aspectRatio ?? undefined,
    feedPlacement: classification.provided
      ? classification.feedPlacement
      : undefined,
    updatedAtMs: Date.now(),
  };
}

export async function getCachedMuxAssetById(
  ctx: QueryCtx | MutationCtx,
  muxAssetId: string,
): Promise<CachedMuxAsset | null> {
  return ((await (ctx.db as any)
    .query("muxAssetCache")
    .withIndex("by_mux_asset", (q: any) => q.eq("muxAssetId", muxAssetId))
    .unique()) ?? null) as CachedMuxAsset | null;
}

export async function listRecentReadyCachedMuxAssets(
  ctx: QueryCtx | MutationCtx,
  limit: number,
): Promise<CachedMuxAsset[]> {
  const requestedLimit = Math.max(1, Math.floor(limit));

  return (await (ctx.db as any)
    .query("muxAssetCache")
    .withIndex("by_ready_deleted_created", (q: any) =>
      q.eq("isReady", true).eq("isDeleted", false),
    )
    .order("desc")
    .take(requestedLimit)) as CachedMuxAsset[];
}

export const getByMuxAssetId = query({
  args: { muxAssetId: v.string() },
  handler: async (ctx, args) => {
    return await getCachedMuxAssetById(ctx, args.muxAssetId);
  },
});

export const getByMuxAssetIdInternal = internalQuery({
  args: { muxAssetId: v.string() },
  handler: async (ctx, args) => {
    return await getCachedMuxAssetById(ctx, args.muxAssetId);
  },
});

export const listRecentReadyAssets = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return await listRecentReadyCachedMuxAssets(ctx, args.limit ?? 25);
  },
});

/**
 * The single asset-sync writer. Every caller (webhook, upload sync, AI metadata
 * repair, Mux backfill) goes through it, so classification is applied on
 * `video.asset.ready` and on every later asset update without any caller change.
 *
 * The payload never carries `feed*` read-model fields and the patch below writes
 * only the comparable asset columns plus the classification, so a classification
 * write cannot clobber the denormalized title, channel name, or uploader that
 * `./feedReadModel.ts` owns.
 */
export const upsertFromPayloadInternal = internalMutation({
  args: {
    asset: v.any(),
  },
  handler: async (ctx, args) => {
    const normalized = normalizeMuxAssetPayload(args.asset);
    if (!normalized) {
      return { ok: false, skipped: true, reason: "missing_asset_id" };
    }

    const existing = await getCachedMuxAssetById(ctx, normalized.muxAssetId);
    const classification = resolveAspectClassificationForUpsert({
      existing,
      incoming: normalized,
    });
    const payload: CachedMuxAssetComparable = {
      ...normalized,
      createdAtMs: existing?.createdAtMs ?? normalized.createdAtMs,
      aspectRatio: classification.aspectRatio,
      feedPlacement: classification.feedPlacement,
    };
    const classificationResult = {
      aspectRatio: classification.aspectRatio ?? null,
      feedPlacement: classification.feedPlacement,
      classificationChanged: classification.changed,
    };

    if (existing) {
      const comparableExisting: CachedMuxAssetComparable = {
        muxAssetId: existing.muxAssetId,
        status: existing.status,
        isReady: existing.isReady,
        isDeleted: existing.isDeleted,
        durationSeconds: existing.durationSeconds,
        createdAtMs: existing.createdAtMs,
        deletedAtMs: existing.deletedAtMs,
        passthrough: existing.passthrough,
        playbackIds: existing.playbackIds,
        aspectRatio: existing.aspectRatio,
        feedPlacement: existing.feedPlacement,
      };

      if (isComparableAssetEqual(comparableExisting, payload)) {
        return {
          ok: true,
          skipped: false,
          inserted: false,
          unchanged: true,
          ...classificationResult,
        };
      }

      await (ctx.db as any).patch((existing as any)._id, {
        ...payload,
        ...buildAspectClassificationPatch(classification, Date.now()),
        updatedAtMs: Date.now(),
      });
      return {
        ok: true,
        skipped: false,
        inserted: false,
        unchanged: false,
        ...classificationResult,
      };
    }

    await (ctx.db as any).insert("muxAssetCache", {
      ...payload,
      ...buildAspectClassificationPatch(
        { ...classification, changed: true },
        Date.now(),
      ),
      updatedAtMs: Date.now(),
    });
    return {
      ok: true,
      skipped: false,
      inserted: true,
      unchanged: false,
      ...classificationResult,
    };
  },
});

export const markDeletedInternal = internalMutation({
  args: {
    muxAssetId: v.string(),
    deletedAtMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await getCachedMuxAssetById(ctx, args.muxAssetId);
    if (!existing) {
      await (ctx.db as any).insert("muxAssetCache", {
        muxAssetId: args.muxAssetId,
        status: "deleted",
        isReady: false,
        isDeleted: true,
        createdAtMs: args.deletedAtMs ?? Date.now(),
        deletedAtMs: args.deletedAtMs ?? Date.now(),
        playbackIds: [],
        // A tombstone has no ratio to classify. It is excluded from every feed
        // by `isReady`/`isDeleted`, and stays countable in the placement audit.
        feedPlacement: "unknown",
        updatedAtMs: Date.now(),
      });
      return { ok: true, inserted: true };
    }

    const deletedAtMs = args.deletedAtMs ?? Date.now();
    if (
      existing.status === "deleted" &&
      existing.isReady === false &&
      existing.isDeleted === true &&
      existing.deletedAtMs === deletedAtMs
    ) {
      return { ok: true, inserted: false, unchanged: true };
    }

    await (ctx.db as any).patch((existing as any)._id, {
      status: "deleted",
      isReady: false,
      isDeleted: true,
      deletedAtMs,
      updatedAtMs: Date.now(),
    });
    return { ok: true, inserted: false, unchanged: false };
  },
});
