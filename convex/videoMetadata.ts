import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";

import { components } from "./_generated/api";
import { mutation } from "./_generated/server";
import { parsePassthroughUserId } from "./feedContracts";
import { upsertVideoMetadataAndSyncFeedReadModel } from "./feedReadModelSync";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asVisibility(
  value: unknown,
): "private" | "unlisted" | "public" | undefined {
  return value === "private" || value === "unlisted" || value === "public"
    ? value
    : undefined;
}

function getMetadataRecord(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return asRecord(value[0]) ?? {};
  return asRecord(value) ?? {};
}

function normalizeTags(tags: string[]) {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const rawTag of tags) {
    const tag = rawTag.replace(/^#+/, "").trim().slice(0, 40);
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    normalized.push(tag);
    if (normalized.length === 10) break;
  }

  return normalized;
}

/** Save an uploader's edits to the Mux Robots metadata draft. */
export const updateOwnVideoMetadata = mutation({
  args: {
    muxAssetId: v.string(),
    title: v.string(),
    description: v.string(),
    tags: v.array(v.string()),
    publish: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("You must be signed in to edit video metadata.");
    }

    const video = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
      muxAssetId: args.muxAssetId,
      userId: authUserId,
    });
    if (!video?.asset) {
      throw new Error("Video not found.");
    }

    const asset = asRecord(video.asset) ?? {};
    const metadata = getMetadataRecord(video.metadata);
    const metadataOwner = asString(metadata.userId);
    const passthroughOwner = parsePassthroughUserId(asset.passthrough);
    const owner = metadataOwner ?? passthroughOwner;
    if (owner !== authUserId) {
      throw new Error("You can only edit your own videos.");
    }

    const custom = asRecord(metadata.custom) ?? {};
    if (args.publish === true && custom.moderationPassed !== true) {
      throw new Error("This video cannot be published before moderation passes.");
    }
    const title = args.title.trim().slice(0, 120);
    const description = args.description.trim().slice(0, 500);
    const tags = normalizeTags(args.tags);

    await upsertVideoMetadataAndSyncFeedReadModel(ctx, {
      muxAssetId: args.muxAssetId,
      userId: authUserId,
      title,
      description,
      tags,
      visibility:
        args.publish === true ? "public" : asVisibility(metadata.visibility),
      custom: {
        ...custom,
        // Once the uploader edits the draft, a delayed/replayed Robots sync
        // must not replace those edits with its original suggestions.
        aiUseGeneratedTitle: false,
        aiUseGeneratedDescription: false,
        aiUseGeneratedTags: false,
        aiMetadataEditedAtMs: Date.now(),
        ...(args.publish === true
          ? {
              awaitingMetadataReview: false,
              publishedAtMs: Date.now(),
            }
          : {}),
      },
    });

    return {
      ok: true,
      title,
      description,
      tags,
      published: args.publish === true,
    };
  },
});
