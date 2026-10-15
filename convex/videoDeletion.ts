"use node";

import Mux from "@mux/mux-node";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";

import { components, internal } from "./_generated/api";
import { action } from "./_generated/server";
import { parsePassthroughUserId } from "./feedContracts";

function requiredEnv(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

export const deleteOwnVideo = action({
  args: { muxAssetId: v.string() },
  handler: async (ctx, args) => {
    const muxAssetId = args.muxAssetId.trim();
    if (!muxAssetId) {
      throw new Error("A video asset ID is required.");
    }

    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("You must be signed in to delete a video.");
    }

    const video = asRecord(
      await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
        muxAssetId,
        userId,
      }),
    );
    const asset = asRecord(video?.asset);
    const metadata = asRecord(video?.metadata);
    const passthroughOwnerUserId = parsePassthroughUserId(asset?.passthrough);
    if (
      !asset ||
      (metadata?.userId !== userId && passthroughOwnerUserId !== userId)
    ) {
      throw new Error("Video not found or you do not have permission to delete it.");
    }

    const mux = new Mux({
      tokenId: requiredEnv("MUX_TOKEN_ID", process.env.MUX_TOKEN_ID),
      tokenSecret: requiredEnv("MUX_TOKEN_SECRET", process.env.MUX_TOKEN_SECRET),
    });

    try {
      await mux.video.assets.delete(muxAssetId);
    } catch (error) {
      // Retrying a partially completed deletion is safe if Mux already removed
      // the asset; every other Mux failure leaves Convex data intact for retry.
      if (errorStatus(error) !== 404) throw error;
    }

    const threadIds = await ctx.runQuery(
      (internal as any).libraryReset.getVideoChatThreadIdsInternal,
      { muxAssetId },
    );

    for (const threadId of threadIds as string[]) {
      await ctx.runMutation(
        (components as any).agent.threads.deleteAllForThreadIdAsync,
        { threadId },
      );
    }

    await ctx.runMutation(
      (internal as any).libraryReset.deleteVideoDataInternal,
      { muxAssetId },
    );

    await ctx.runMutation(
      (components as any).mux.videos.deleteVideoByMuxAssetIdPublic,
      { muxAssetId },
    );

    return { ok: true, muxAssetId };
  },
});
