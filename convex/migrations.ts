"use node";

import Mux from "@mux/mux-node";
import { action } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { v } from "convex/values";

function requiredEnv(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length > 0 ? strings : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asVisibility(
  value: unknown
): "private" | "unlisted" | "public" | undefined {
  return value === "private" || value === "unlisted" || value === "public"
    ? value
    : undefined;
}

function parseMetadataPassthrough(passthrough: unknown): {
  userId?: string;
  title?: string;
  description?: string;
  tags?: string[];
  visibility?: "private" | "unlisted" | "public";
  custom?: Record<string, unknown>;
} {
  const raw = asString(passthrough);
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    const parsedObj = asRecord(parsed);
    if (!parsedObj) return { userId: raw };

    return {
      userId: asString(parsedObj.userId) ?? asString(parsedObj.user_id),
      title: asString(parsedObj.title),
      description: asString(parsedObj.description),
      tags: asStringArray(parsedObj.tags),
      visibility: asVisibility(parsedObj.visibility),
      custom: asRecord(parsedObj.custom),
    };
  } catch {
    return { userId: raw };
  }
}

function asMetadataRecord(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    const first = value[0];
    return asRecord(first) ?? {};
  }
  return asRecord(value) ?? {};
}

export const backfillMux = action({
  args: {
    maxAssets: v.optional(v.number()),
    defaultUserId: v.optional(v.string()),
    includeVideoMetadata: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const mux = new Mux({
      tokenId: requiredEnv("MUX_TOKEN_ID", process.env.MUX_TOKEN_ID),
      tokenSecret: requiredEnv("MUX_TOKEN_SECRET", process.env.MUX_TOKEN_SECRET),
    });

    const maxAssets = Math.max(1, Math.floor(args.maxAssets ?? 200));
    const includeVideoMetadata = args.includeVideoMetadata ?? true;

    let scanned = 0;
    let syncedAssets = 0;
    let metadataUpserts = 0;
    let missingUserId = 0;

    for await (const asset of mux.video.assets.list({ limit: 100 })) {
      if (scanned >= maxAssets) break;
      scanned += 1;
      if (!asset.id) continue;

      await ctx.runMutation(components.mux.sync.upsertAssetFromPayloadPublic, {
        asset: asset as unknown as Record<string, unknown>,
      });
      syncedAssets += 1;

      if (!includeVideoMetadata) continue;
      const metadata = parseMetadataPassthrough(asset.passthrough);
      const userId = metadata.userId ?? asString(args.defaultUserId) ?? "default";

      await ctx.runMutation(components.mux.videos.upsertVideoMetadata, {
        muxAssetId: asset.id,
        userId,
        title: metadata.title,
        description: metadata.description,
        tags: metadata.tags,
        visibility: metadata.visibility,
        custom: metadata.custom,
      });
      metadataUpserts += 1;
    }

    return { scanned, syncedAssets, metadataUpserts, missingUserId };
  },
});

export const backfillAiMetadataForReadyAssets = action({
  args: {
    maxAssets: v.optional(v.number()),
    defaultUserId: v.optional(v.string()),
    onlyMissing: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const mux = new Mux({
      tokenId: requiredEnv("MUX_TOKEN_ID", process.env.MUX_TOKEN_ID),
      tokenSecret: requiredEnv("MUX_TOKEN_SECRET", process.env.MUX_TOKEN_SECRET),
    });

    const maxAssets = Math.max(1, Math.floor(args.maxAssets ?? 200));
    const onlyMissing = args.onlyMissing ?? true;

    let scanned = 0;
    let queued = 0;
    let skippedNotReady = 0;
    let skippedAlreadyGenerated = 0;

    for await (const asset of mux.video.assets.list({ limit: 100 })) {
      if (scanned >= maxAssets) break;
      scanned += 1;

      if (!asset.id) continue;
      if (asset.status !== "ready") {
        skippedNotReady += 1;
        continue;
      }

      await ctx.runMutation(components.mux.sync.upsertAssetFromPayloadPublic, {
        asset: asset as unknown as Record<string, unknown>,
      });

      const video = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
        muxAssetId: asset.id,
      });
      const metadata = asMetadataRecord((video as any)?.metadata);
      const existingCustom = asRecord(metadata.custom) ?? {};

      if (onlyMissing && existingCustom.aiGeneratedAtMs) {
        skippedAlreadyGenerated += 1;
        continue;
      }

      const userId =
        asString(metadata.userId) ?? asString(args.defaultUserId) ?? "default";

      await ctx.scheduler.runAfter(
        0,
        (internal as any).aiMetadata.generateSummaryAndTagsForAssetInternal,
        {
          muxAssetId: asset.id,
          userId,
          attempt: 0,
        },
      );
      queued += 1;
    }

    return {
      scanned,
      queued,
      skippedNotReady,
      skippedAlreadyGenerated,
      onlyMissing,
    };
  },
});

export const backfillModerationForReadyAssets = action({
  args: {
    maxAssets: v.optional(v.number()),
    defaultUserId: v.optional(v.string()),
    onlyMissing: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const mux = new Mux({
      tokenId: requiredEnv("MUX_TOKEN_ID", process.env.MUX_TOKEN_ID),
      tokenSecret: requiredEnv("MUX_TOKEN_SECRET", process.env.MUX_TOKEN_SECRET),
    });

    const maxAssets = Math.max(1, Math.floor(args.maxAssets ?? 200));
    const onlyMissing = args.onlyMissing ?? true;

    let scanned = 0;
    let queued = 0;
    let skippedNotReady = 0;
    let skippedAlreadyModerated = 0;

    for await (const asset of mux.video.assets.list({ limit: 100 })) {
      if (scanned >= maxAssets) break;
      scanned += 1;

      if (!asset.id) continue;
      if (asset.status !== "ready") {
        skippedNotReady += 1;
        continue;
      }

      await ctx.runMutation(components.mux.sync.upsertAssetFromPayloadPublic, {
        asset: asset as unknown as Record<string, unknown>,
      });

      const video = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
        muxAssetId: asset.id,
      });
      const metadata = asMetadataRecord((video as any)?.metadata);
      const existingCustom = asRecord(metadata.custom) ?? {};

      if (onlyMissing && asNumber(existingCustom.moderationCheckedAtMs) !== undefined) {
        skippedAlreadyModerated += 1;
        continue;
      }

      const userId =
        asString(metadata.userId) ?? asString(args.defaultUserId) ?? "default";

      await ctx.scheduler.runAfter(
        0,
        (internal as any).moderation.moderateAssetInternal,
        {
          muxAssetId: asset.id,
          userId,
          attempt: 0,
        },
      );
      queued += 1;
    }

    return {
      scanned,
      queued,
      skippedNotReady,
      skippedAlreadyModerated,
      onlyMissing,
    };
  },
});

export const backfillEmbeddingsForReadyAssets = action({
  args: {
    maxAssets: v.optional(v.number()),
    defaultUserId: v.optional(v.string()),
    onlyMissing: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const mux = new Mux({
      tokenId: requiredEnv("MUX_TOKEN_ID", process.env.MUX_TOKEN_ID),
      tokenSecret: requiredEnv("MUX_TOKEN_SECRET", process.env.MUX_TOKEN_SECRET),
    });

    const maxAssets = Math.max(1, Math.floor(args.maxAssets ?? 200));
    const onlyMissing = args.onlyMissing ?? true;

    let scanned = 0;
    let queued = 0;
    let skippedNotReady = 0;
    let skippedAlreadyGenerated = 0;

    for await (const asset of mux.video.assets.list({ limit: 100 })) {
      if (scanned >= maxAssets) break;
      scanned += 1;

      if (!asset.id) continue;
      if (asset.status !== "ready") {
        skippedNotReady += 1;
        continue;
      }

      await ctx.runMutation(components.mux.sync.upsertAssetFromPayloadPublic, {
        asset: asset as unknown as Record<string, unknown>,
      });

      const video = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
        muxAssetId: asset.id,
      });
      const metadata = asMetadataRecord((video as any)?.metadata);
      const existingCustom = asRecord(metadata.custom) ?? {};

      if (onlyMissing && asNumber(existingCustom.embeddingsGeneratedAtMs) !== undefined) {
        skippedAlreadyGenerated += 1;
        continue;
      }

      const userId =
        asString(metadata.userId) ?? asString(args.defaultUserId) ?? "default";

      await ctx.scheduler.runAfter(
        0,
        (internal as any).videoEmbeddingsNode.generateAssetEmbeddingsInternal,
        {
          muxAssetId: asset.id,
          userId,
          attempt: 0,
        },
      );
      queued += 1;
    }

    return {
      scanned,
      queued,
      skippedNotReady,
      skippedAlreadyGenerated,
      onlyMissing,
    };
  },
});
