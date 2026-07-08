"use node";

import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";

import { components } from "./_generated/api";
import { action } from "./_generated/server";

export const editCaptionsForAsset = action({
  args: {
    muxAssetId: v.string(),
    trackId: v.string(),
    autoCensorProfanity: v.optional(
      v.object({
        mode: v.optional(v.union(v.literal("blank"), v.literal("remove"), v.literal("mask"))),
        alwaysCensor: v.optional(v.array(v.string())),
        neverCensor: v.optional(v.array(v.string())),
      }),
    ),
    replacements: v.optional(
      v.array(
        v.object({
          find: v.string(),
          replace: v.string(),
        }),
      ),
    ),
    deleteOriginalTrack: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("You must be signed in to edit captions.");
    }

    const video = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
      muxAssetId: args.muxAssetId,
      userId,
    });
    if (!video) {
      throw new Error("Video not found.");
    }

    throw new Error(
      "Caption editing is not available in the installed @mux/ai package. The package does not export editCaptions, so this action is disabled until a supported caption-editing API is wired in.",
    );
  },
});
