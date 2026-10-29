import { v } from "convex/values";

import { internalMutation } from "./_generated/server";

const THUMBNAIL_SELECTION_LOCK_TTL_MS = 10 * 60 * 1000;

export const claimThumbnailSelectionLockInternal = internalMutation({
  args: {
    muxAssetId: v.string(),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const expiresAtMs = now + THUMBNAIL_SELECTION_LOCK_TTL_MS;
    const existing = await (ctx.db as any)
      .query("thumbnailSelectionLocks")
      .withIndex("by_asset", (q: any) => q.eq("muxAssetId", args.muxAssetId))
      .unique();

    if (existing && existing.expiresAtMs > now) {
      return {
        acquired: false,
        startedAtMs: existing.startedAtMs as number,
        userId: existing.userId as string,
      };
    }

    const payload = {
      muxAssetId: args.muxAssetId,
      userId: args.userId,
      startedAtMs: now,
      expiresAtMs,
    };

    if (existing) {
      await (ctx.db as any).patch(existing._id, payload);
    } else {
      await (ctx.db as any).insert("thumbnailSelectionLocks", payload);
    }

    return {
      acquired: true,
      startedAtMs: now,
      userId: args.userId,
    };
  },
});

export const releaseThumbnailSelectionLockInternal = internalMutation({
  args: {
    muxAssetId: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await (ctx.db as any)
      .query("thumbnailSelectionLocks")
      .withIndex("by_asset", (q: any) => q.eq("muxAssetId", args.muxAssetId))
      .unique();

    if (!existing) {
      return { released: false };
    }

    await (ctx.db as any).delete(existing._id);
    return { released: true };
  },
});
