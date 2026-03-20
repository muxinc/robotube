"use node";

import Mux from "@mux/mux-node";
import { action } from "./_generated/server";
import { api, components, internal } from "./_generated/api";
import { v } from "convex/values";

import { normalizeAudioTranslationLanguageCodes } from "../constants/audio-translation-languages";

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
  audioTranslationLanguageCodes?: string[];
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
      audioTranslationLanguageCodes: normalizeAudioTranslationLanguageCodes(
        asStringArray(asRecord(parsedObj.custom)?.audioTranslationLanguageCodes) ?? [],
      ),
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

export const backfillMuxAssetCache = action({
  args: {
    maxAssets: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const mux = new Mux({
      tokenId: requiredEnv("MUX_TOKEN_ID", process.env.MUX_TOKEN_ID),
      tokenSecret: requiredEnv("MUX_TOKEN_SECRET", process.env.MUX_TOKEN_SECRET),
    });

    const maxAssets = Math.max(1, Math.floor(args.maxAssets ?? 500));

    let scanned = 0;
    let cached = 0;

    for await (const asset of mux.video.assets.list({ limit: 100 })) {
      if (scanned >= maxAssets) break;
      scanned += 1;

      await ctx.runMutation((internal as any).muxAssetCache.upsertFromPayloadInternal, {
        asset,
      });
      cached += 1;
    }

    return { scanned, cached };
  },
});

export const resetVideoLibrary = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    clearedAgentUsers: number;
    agentUserScanCount: number;
    deletedVideoEmbeddings: number;
    deletedVideoChatThreads: number;
    deletedAudioTranslationJobs: number;
    deletedMuxAssetCacheRows: number;
  }> => {
    const agentUserIds = new Set<string>();
    let cursor: string | null = null;
    let agentUserScanCount = 0;
    while (true) {
      const page = (await ctx.runQuery(components.agent.users.listUsersWithThreads, {
        paginationOpts: {
          cursor,
          numItems: 100,
        },
      })) as {
        continueCursor: string;
        isDone: boolean;
        page: string[];
      };

      for (const userId of page.page) {
        if (!userId) continue;
        agentUserIds.add(userId);
      }
      agentUserScanCount += page.page.length;

      if (page.isDone) {
        break;
      }
      cursor = page.continueCursor;
    }

    let clearedAgentUsers = 0;
    for (const userId of agentUserIds) {
      await ctx.runAction(components.agent.users.deleteAllForUserId, {
        userId,
      });
      clearedAgentUsers += 1;
    }

    const clearedTables = (await ctx.runMutation(
      (internal as any).libraryReset.clearVideoLibraryInternal,
      {},
    )) as {
      deletedVideoEmbeddings: number;
      deletedVideoChatThreads: number;
      deletedAudioTranslationJobs: number;
      deletedMuxAssetCacheRows: number;
    };

    return {
      clearedAgentUsers,
      agentUserScanCount,
      ...clearedTables,
    };
  },
});

export const repairAudioTranslationRows = action({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ scanned: number; repaired: number }> => {
    return (await ctx.runMutation(
      (internal as any).audioTranslations.repairMissingFieldsInternal,
      {
        limit: args.limit,
      },
    )) as { scanned: number; repaired: number };
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
      const hasSummary = asNumber(existingCustom.aiGeneratedAtMs) !== undefined;
      const hasChapters =
        asNumber(existingCustom.aiChaptersGeneratedAtMs) !== undefined;
      const hasKeyMoments =
        asNumber(existingCustom.aiKeyMomentsGeneratedAtMs) !== undefined;

      if (onlyMissing && hasSummary && hasChapters && hasKeyMoments) {
        skippedAlreadyGenerated += 1;
        continue;
      }

      await ctx.scheduler.runAfter(
        0,
        (internal as any).aiMetadata.ensureAiMetadataForAssetInternal,
        {
          muxAssetId: asset.id,
          defaultUserId: args.defaultUserId,
        },
      );
      queued += 1;
    }

    return {
      scanned,
      queued,
      skippedNotReady,
      skippedAlreadyGenerated,
      skippedAlreadyComplete: skippedAlreadyGenerated,
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

export const backfillCaptionsForReadyAssets = action({
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
    let skippedAlreadyHandled = 0;

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

      if (
        onlyMissing &&
        (asNumber(existingCustom.aiCaptionsGeneratedAtMs) !== undefined ||
          asString(existingCustom.aiCaptionsUnavailableReason) !== undefined)
      ) {
        skippedAlreadyHandled += 1;
        continue;
      }

      const userId =
        asString(metadata.userId) ?? asString(args.defaultUserId) ?? "default";

      await ctx.scheduler.runAfter(
        0,
        (internal as any).captions.ensureGeneratedCaptionsTrackInternal,
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
      skippedAlreadyHandled,
      onlyMissing,
    };
  },
});

export const backfillAudioTranslationsForReadyAssets = action({
  args: {
    languageCodes: v.array(v.string()),
    maxAssets: v.optional(v.number()),
    defaultUserId: v.optional(v.string()),
    onlyMissing: v.optional(v.boolean()),
    staggerMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const mux = new Mux({
      tokenId: requiredEnv("MUX_TOKEN_ID", process.env.MUX_TOKEN_ID),
      tokenSecret: requiredEnv("MUX_TOKEN_SECRET", process.env.MUX_TOKEN_SECRET),
    });

    const languageCodes = normalizeAudioTranslationLanguageCodes(args.languageCodes);
    if (languageCodes.length === 0) {
      throw new Error("At least one supported translation language is required.");
    }

    const maxAssets = Math.max(1, Math.floor(args.maxAssets ?? 200));
    const onlyMissing = args.onlyMissing ?? true;
    const staggerMs = Math.max(0, Math.floor(args.staggerMs ?? 1000));

    let scanned = 0;
    let queued = 0;
    let requestedTrackCount = 0;
    let skippedNotReady = 0;
    let skippedAlreadyRequested = 0;

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
      const parsedPassthrough = parseMetadataPassthrough(asset.passthrough);
      const userId =
        asString(metadata.userId) ??
        parsedPassthrough.userId ??
        asString(args.defaultUserId) ??
        "default";
      const title = asString(metadata.title) ?? parsedPassthrough.title;

      let requestedLanguageCodes = languageCodes;
      if (onlyMissing) {
        const existing = (await ctx.runQuery((api as any).audioTranslations.listForAsset, {
          muxAssetId: asset.id,
        })) as Array<{ languageCode: string }>;

        requestedLanguageCodes = languageCodes.filter(
          (languageCode) =>
            !existing.some((translation) => translation.languageCode === languageCode),
        );

        if (requestedLanguageCodes.length === 0) {
          skippedAlreadyRequested += 1;
          continue;
        }
      }

      await ctx.scheduler.runAfter(
        queued * staggerMs,
        (internal as any).audioTranslationsNode.ensureAudioTranslationsForAssetInternal,
        {
          muxAssetId: asset.id,
          userId,
          languageCodes: requestedLanguageCodes,
          title,
        },
      );

      queued += 1;
      requestedTrackCount += requestedLanguageCodes.length;
    }

    return {
      scanned,
      queued,
      requestedTrackCount,
      skippedNotReady,
      skippedAlreadyRequested,
      onlyMissing,
      staggerMs,
      languageCodes,
    };
  },
});

export const backfillRequestedTranslationTracksForReadyAssets = action({
  args: {
    maxAssets: v.optional(v.number()),
    defaultUserId: v.optional(v.string()),
    staggerMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const mux = new Mux({
      tokenId: requiredEnv("MUX_TOKEN_ID", process.env.MUX_TOKEN_ID),
      tokenSecret: requiredEnv("MUX_TOKEN_SECRET", process.env.MUX_TOKEN_SECRET),
    });

    const maxAssets = Math.max(1, Math.floor(args.maxAssets ?? 200));
    const staggerMs = Math.max(0, Math.floor(args.staggerMs ?? 1000));

    let scanned = 0;
    let queuedAssets = 0;
    let queuedAudioRequests = 0;
    let queuedCaptionRequests = 0;
    let skippedNotReady = 0;
    let skippedNoRequestedLanguages = 0;

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
      const parsedPassthrough = parseMetadataPassthrough(asset.passthrough);
      const requestedLanguageCodes = normalizeAudioTranslationLanguageCodes(
        asStringArray(existingCustom.audioTranslationLanguageCodes) ??
          parsedPassthrough.audioTranslationLanguageCodes ??
          [],
      );

      if (requestedLanguageCodes.length === 0) {
        skippedNoRequestedLanguages += 1;
        continue;
      }

      const userId =
        asString(metadata.userId) ??
        parsedPassthrough.userId ??
        asString(args.defaultUserId) ??
        "default";
      const title = asString(metadata.title) ?? parsedPassthrough.title;
      const delayMs = queuedAssets * staggerMs;

      await ctx.scheduler.runAfter(
        delayMs,
        (internal as any).audioTranslationsNode.ensureAudioTranslationsForAssetInternal,
        {
          muxAssetId: asset.id,
          userId,
          languageCodes: requestedLanguageCodes,
          title,
          attempt: 0,
        },
      );

      await ctx.scheduler.runAfter(
        delayMs,
        (internal as any).captionTranslationsNode.ensureCaptionTranslationsForAssetInternal,
        {
          muxAssetId: asset.id,
          userId,
          languageCodes: requestedLanguageCodes,
          title,
          attempt: 0,
        },
      );

      queuedAssets += 1;
      queuedAudioRequests += requestedLanguageCodes.length;
      queuedCaptionRequests += requestedLanguageCodes.length;
    }

    return {
      scanned,
      queuedAssets,
      queuedAudioRequests,
      queuedCaptionRequests,
      skippedNotReady,
      skippedNoRequestedLanguages,
      staggerMs,
    };
  },
});
