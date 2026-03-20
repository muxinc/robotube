import { v } from "convex/values";

import {
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";

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
  updatedAtMs: number;
};

type CachedMuxAssetComparable = Omit<CachedMuxAsset, "updatedAtMs">;

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
    arePlaybackIdsEqual(left.playbackIds, right.playbackIds)
  );
}

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
    const payload: CachedMuxAssetComparable = {
      ...normalized,
      createdAtMs: existing?.createdAtMs ?? normalized.createdAtMs,
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
      };

      if (isComparableAssetEqual(comparableExisting, payload)) {
        return { ok: true, skipped: false, inserted: false, unchanged: true };
      }

      await (ctx.db as any).patch((existing as any)._id, {
        ...payload,
        updatedAtMs: Date.now(),
      });
      return { ok: true, skipped: false, inserted: false, unchanged: false };
    }

    await (ctx.db as any).insert("muxAssetCache", {
      ...payload,
      updatedAtMs: Date.now(),
    });
    return { ok: true, skipped: false, inserted: true, unchanged: false };
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
