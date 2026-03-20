import { v } from "convex/values";

import { internalMutation } from "./_generated/server";

const MODERATION_LOCK_TTL_MS = 30 * 60 * 1000;

export const claimModerationLockInternal = internalMutation({
  args: {
    muxAssetId: v.string(),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const expiresAtMs = now + MODERATION_LOCK_TTL_MS;
    const existing = await (ctx.db as any)
      .query("moderationLocks")
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
      await (ctx.db as any).insert("moderationLocks", payload);
    }

    return {
      acquired: true,
      startedAtMs: now,
      userId: args.userId,
    };
  },
});

export const releaseModerationLockInternal = internalMutation({
  args: {
    muxAssetId: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await (ctx.db as any)
      .query("moderationLocks")
      .withIndex("by_asset", (q: any) => q.eq("muxAssetId", args.muxAssetId))
      .unique();

    if (!existing) {
      return { released: false };
    }

    await (ctx.db as any).delete(existing._id);
    return { released: true };
  },
});
