"use node";

import Mux from "@mux/mux-node";
import { action } from "./_generated/server";
import { api, components, internal } from "./_generated/api";
import { v } from "convex/values";

import { normalizeAudioTranslationLanguageCodes } from "../constants/audio-translation-languages";
import { isLaravelOrchestrationEnabled } from "./laravelFlag";
import {
  resolveBackfillPageOutcome,
  resolveBackfillPagePlan,
} from "./backfillPaging";
import { upsertVideoMetadataAndSyncFeedReadModel } from "./feedReadModelSync";

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
  captionTranslationLanguageCodes?: string[];
} {
  const raw = asString(passthrough);
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    const parsedObj = asRecord(parsed);
    if (!parsedObj) return { userId: raw };
    const custom = asRecord(parsedObj.custom);
    const audioLanguageCodes = asStringArray(
      custom?.audioTranslationLanguageCodes,
    );
    const captionLanguageCodes = asStringArray(
      custom?.captionTranslationLanguageCodes,
    );

    return {
      userId: asString(parsedObj.userId) ?? asString(parsedObj.user_id),
      title: asString(parsedObj.title),
      description: asString(parsedObj.description),
      tags: asStringArray(parsedObj.tags),
      visibility: asVisibility(parsedObj.visibility),
      custom,
      audioTranslationLanguageCodes: audioLanguageCodes
        ? normalizeAudioTranslationLanguageCodes(audioLanguageCodes)
        : undefined,
      captionTranslationLanguageCodes: captionLanguageCodes
        ? normalizeAudioTranslationLanguageCodes(captionLanguageCodes)
        : undefined,
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

      await upsertVideoMetadataAndSyncFeedReadModel(ctx, {
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

/**
 * Re-syncs cached asset rows straight from the Mux API, which also populates the
 * aspect classification for legacy rows: `upsertFromPayloadInternal` reads
 * `aspect_ratio` off every payload it is given.
 *
 * Bounded by `maxAssets`, resumable through Mux's page numbers (pass the
 * returned `nextPage` back in as `startPage`), idempotent because an unchanged
 * row is detected and not written, and safe to rerun. One failing asset is
 * counted and skipped rather than aborting the run.
 *
 * The request limit is lowered to the run's asset budget (see
 * `./backfillPaging.ts`), so every page a run touches is consumed whole. A resumed
 * run therefore never re-reads a finished page and never stalls on one, including
 * when `maxAssets` is smaller than `pageSize`.
 *
 * `feedPlacement.backfillAspectClassification` is the cheaper classification
 * backfill: it reads ratios from the Mux component tables instead of the Mux API
 * and resumes on an exact Convex cursor. Use this action when the cached rows
 * themselves need to be refreshed from Mux.
 */
export const backfillMuxAssetCache = action({
  args: {
    maxAssets: v.optional(v.number()),
    pageSize: v.optional(v.number()),
    startPage: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const mux = new Mux({
      tokenId: requiredEnv("MUX_TOKEN_ID", process.env.MUX_TOKEN_ID),
      tokenSecret: requiredEnv("MUX_TOKEN_SECRET", process.env.MUX_TOKEN_SECRET),
    });

    const plan = resolveBackfillPagePlan({
      maxAssets: args.maxAssets ?? 500,
      pageSize: args.pageSize,
      startPage: args.startPage,
    });

    let scanned = 0;
    let cached = 0;
    let classified = 0;
    let unchanged = 0;
    let failed = 0;
    let vertical = 0;
    let standard = 0;
    let unknown = 0;

    let page = await mux.video.assets.list({
      limit: plan.limit,
      page: plan.startPage,
    });
    let pagesProcessed = 0;
    let nextPage: number | null = null;
    let isDone = false;

    while (true) {
      for (const asset of page.data) {
        scanned += 1;

        try {
          const result = (await ctx.runMutation(
            (internal as any).muxAssetCache.upsertFromPayloadInternal,
            { asset },
          )) as {
            ok: boolean;
            unchanged?: boolean;
            classificationChanged?: boolean;
            feedPlacement?: "standard" | "vertical" | "unknown";
          };

          if (!result?.ok) {
            failed += 1;
            continue;
          }

          cached += 1;
          if (result.unchanged === true) unchanged += 1;
          if (result.classificationChanged === true) classified += 1;
          if (result.feedPlacement === "vertical") vertical += 1;
          else if (result.feedPlacement === "standard") standard += 1;
          else unknown += 1;
        } catch {
          failed += 1;
        }
      }

      pagesProcessed += 1;

      const outcome = resolveBackfillPageOutcome({
        startPage: plan.startPage,
        pagesProcessed,
        maxPages: plan.maxPages,
        hasNextPage: page.hasNextPage(),
      });
      isDone = outcome.isDone;
      nextPage = outcome.nextPage;

      if (!outcome.shouldContinue) break;
      page = await page.getNextPage();
    }

    return {
      scanned,
      cached,
      classified,
      unchanged,
      failed,
      vertical,
      standard,
      unknown,
      startPage: plan.startPage,
      pageSize: plan.limit,
      pagesProcessed,
      nextPage,
      isDone,
    };
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
    // Laravel owns Robots orchestration when the flag is on; this backfill
    // kicks off the Convex-native AI-metadata Robots pipeline, so it must be a
    // no-op to avoid creating duplicate Robots jobs.
    if (isLaravelOrchestrationEnabled()) {
      return {
        scanned: 0,
        queued: 0,
        skippedNotReady: 0,
        skippedAlreadyGenerated: 0,
        skippedLaravelOrchestration: true,
      };
    }

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
    // Laravel owns Robots orchestration when the flag is on; this backfill
    // kicks off the Convex-native moderation Robots pipeline, so it must be a
    // no-op to avoid creating duplicate Robots jobs.
    if (isLaravelOrchestrationEnabled()) {
      return {
        scanned: 0,
        queued: 0,
        skippedNotReady: 0,
        skippedAlreadyModerated: 0,
        skippedLaravelOrchestration: true,
      };
    }

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
    // Laravel owns caption/audio translation Robots jobs when the flag is on;
    // this backfill kicks off the Convex-native audio-translation pipeline, so
    // it must be a no-op to avoid creating duplicate Robots jobs.
    if (isLaravelOrchestrationEnabled()) {
      return {
        scanned: 0,
        queued: 0,
        requestedTrackCount: 0,
        skippedNotReady: 0,
        skippedAlreadyRequested: 0,
        skippedLaravelOrchestration: true,
      };
    }

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
    // Laravel owns caption/audio translation Robots jobs when the flag is on;
    // this backfill re-requests native translation tracks, so it must be a
    // no-op to avoid creating duplicate Robots jobs.
    if (isLaravelOrchestrationEnabled()) {
      return {
        scanned: 0,
        queuedAssets: 0,
        queuedAudioRequests: 0,
        queuedCaptionRequests: 0,
        skippedNotReady: 0,
        skippedNoRequestedLanguages: 0,
        skippedLaravelOrchestration: true,
      };
    }

    const mux = new Mux({
      tokenId: requiredEnv("MUX_TOKEN_ID", process.env.MUX_TOKEN_ID),
      tokenSecret: requiredEnv(
        "MUX_TOKEN_SECRET",
        process.env.MUX_TOKEN_SECRET,
      ),
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

      const video = await ctx.runQuery(
        components.mux.videos.getVideoByMuxAssetId,
        {
          muxAssetId: asset.id,
        },
      );
      const metadata = asMetadataRecord((video as any)?.metadata);
      const existingCustom = asRecord(metadata.custom) ?? {};
      const parsedPassthrough = parseMetadataPassthrough(asset.passthrough);
      const requestedAudioLanguageCodes =
        normalizeAudioTranslationLanguageCodes(
          asStringArray(existingCustom.audioTranslationLanguageCodes) ??
            parsedPassthrough.audioTranslationLanguageCodes ??
            [],
        );
      const requestedCaptionLanguageCodes =
        normalizeAudioTranslationLanguageCodes(
          asStringArray(existingCustom.captionTranslationLanguageCodes) ??
            parsedPassthrough.captionTranslationLanguageCodes ??
            requestedAudioLanguageCodes,
        );

      if (
        requestedAudioLanguageCodes.length === 0 &&
        requestedCaptionLanguageCodes.length === 0
      ) {
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

      if (requestedAudioLanguageCodes.length > 0) {
        await ctx.scheduler.runAfter(
          delayMs,
          (internal as any).audioTranslationsNode
            .ensureAudioTranslationsForAssetInternal,
          {
            muxAssetId: asset.id,
            userId,
            languageCodes: requestedAudioLanguageCodes,
            title,
            attempt: 0,
          },
        );
      }

      if (requestedCaptionLanguageCodes.length > 0) {
        await ctx.scheduler.runAfter(
          delayMs,
          (internal as any).captionTranslationsNode
            .ensureCaptionTranslationsForAssetInternal,
          {
            muxAssetId: asset.id,
            userId,
            languageCodes: requestedCaptionLanguageCodes,
            title,
            attempt: 0,
          },
        );
      }

      queuedAssets += 1;
      queuedAudioRequests += requestedAudioLanguageCodes.length;
      queuedCaptionRequests += requestedCaptionLanguageCodes.length;
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
