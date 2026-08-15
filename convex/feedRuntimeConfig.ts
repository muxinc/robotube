import { v } from "convex/values";

import { internalMutation, query } from "./_generated/server";

const VERTICAL_FEED_CONFIG_KEY = "vertical-feed" as const;

type VerticalFeedRuntimeConfig = {
  shortsTabEnabled: boolean;
  exclusiveFeedPlacementEnabled: boolean;
  androidPhysicalValidationCompleted: boolean;
  updatedAtMs: number | null;
};

const DISABLED_VERTICAL_FEED_CONFIG: VerticalFeedRuntimeConfig = {
  shortsTabEnabled: false,
  exclusiveFeedPlacementEnabled: false,
  androidPhysicalValidationCompleted: false,
  updatedAtMs: null,
};

/**
 * Public, reactive rollout state for the mobile client.
 *
 * A missing row is intentionally all-off. Exclusive routing is additionally
 * constrained by the Shorts flag at the server boundary so no client can
 * receive a state that removes 9:16 assets from Home while hiding Shorts.
 */
export const getVerticalFeedFlags = query({
  args: {},
  handler: async (ctx): Promise<VerticalFeedRuntimeConfig> => {
    const row = await ctx.db
      .query("feedRuntimeConfig")
      .withIndex("by_key", (q) => q.eq("key", VERTICAL_FEED_CONFIG_KEY))
      .unique();

    if (!row) return DISABLED_VERTICAL_FEED_CONFIG;

    const shortsTabEnabled = row.shortsTabEnabled === true;
    return {
      shortsTabEnabled,
      exclusiveFeedPlacementEnabled:
        shortsTabEnabled && row.exclusiveFeedPlacementEnabled === true,
      androidPhysicalValidationCompleted:
        row.androidPhysicalValidationCompleted === true,
      updatedAtMs: row.updatedAtMs,
    };
  },
});

/**
 * Atomic operator control for the vertical-feed rollout.
 *
 * This is internal, so mobile clients cannot mutate rollout state. Operators
 * use the Convex dashboard or `npx convex run
 * feedRuntimeConfig:setVerticalFeedFlags ...`. Supplying the complete state in
 * one mutation prevents transient Home/Shorts disagreement during rollback.
 */
export const setVerticalFeedFlags = internalMutation({
  args: {
    shortsTabEnabled: v.boolean(),
    exclusiveFeedPlacementEnabled: v.boolean(),
    androidPhysicalValidationCompleted: v.boolean(),
  },
  handler: async (ctx, args): Promise<VerticalFeedRuntimeConfig> => {
    if (
      args.exclusiveFeedPlacementEnabled &&
      !args.shortsTabEnabled
    ) {
      throw new Error(
        "exclusiveFeedPlacementEnabled requires shortsTabEnabled",
      );
    }

    const updatedAtMs = Date.now();
    const existing = await ctx.db
      .query("feedRuntimeConfig")
      .withIndex("by_key", (q) => q.eq("key", VERTICAL_FEED_CONFIG_KEY))
      .unique();

    const value = {
      key: VERTICAL_FEED_CONFIG_KEY,
      shortsTabEnabled: args.shortsTabEnabled,
      exclusiveFeedPlacementEnabled: args.exclusiveFeedPlacementEnabled,
      androidPhysicalValidationCompleted:
        args.androidPhysicalValidationCompleted,
      updatedAtMs,
    };

    if (existing) {
      await ctx.db.patch(existing._id, value);
    } else {
      await ctx.db.insert("feedRuntimeConfig", value);
    }

    return {
      shortsTabEnabled: value.shortsTabEnabled,
      exclusiveFeedPlacementEnabled:
        value.shortsTabEnabled && value.exclusiveFeedPlacementEnabled,
      androidPhysicalValidationCompleted:
        value.androidPhysicalValidationCompleted,
      updatedAtMs,
    };
  },
});
