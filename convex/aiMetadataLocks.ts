import { v } from "convex/values";

import { internalMutation } from "./_generated/server";

const AI_METADATA_LOCK_TTL_MS = 30 * 60 * 1000;

export const claimAiMetadataLockInternal = internalMutation({
  args: {
    muxAssetId: v.string(),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const expiresAtMs = now + AI_METADATA_LOCK_TTL_MS;
    const existing = await (ctx.db as any)
      .query("aiMetadataLocks")
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
      await (ctx.db as any).insert("aiMetadataLocks", payload);
    }

    return {
      acquired: true,
      startedAtMs: now,
      userId: args.userId,
    };
  },
});

export const releaseAiMetadataLockInternal = internalMutation({
  args: {
    muxAssetId: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await (ctx.db as any)
      .query("aiMetadataLocks")
      .withIndex("by_asset", (q: any) => q.eq("muxAssetId", args.muxAssetId))
      .unique();

    if (!existing) {
      return { released: false };
    }

    await (ctx.db as any).delete(existing._id);
    return { released: true };
  },
});
