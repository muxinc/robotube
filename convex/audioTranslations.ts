import { v } from "convex/values";

import {
  getAudioTranslationLanguageLabel,
  normalizeAudioTranslationLanguageCodes,
} from "../constants/audio-translation-languages";
import {
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";

type TranslateAudioJobStatus =
  | "requested"
  | "pending"
  | "processing"
  | "completed"
  | "errored"
  | "cancelled";

const REQUEST_CLAIM_COOLDOWN_MS = 60 * 1000;

export const listForAsset = query({
  args: { muxAssetId: v.string() },
  handler: async (ctx, args) => {
    const rows = await (ctx.db as any)
      .query("audioTranslationJobs")
      .withIndex("by_asset", (q: any) => q.eq("muxAssetId", args.muxAssetId))
      .collect();

    return rows
      .sort((a: any, b: any) => {
        const leftLabel = a.languageLabel ?? getAudioTranslationLanguageLabel(a.languageCode);
        const rightLabel = b.languageLabel ?? getAudioTranslationLanguageLabel(b.languageCode);
        return leftLabel.localeCompare(rightLabel);
      })
      .map((row: any) => ({
        languageCode: row.languageCode,
        languageLabel:
          row.languageLabel ?? getAudioTranslationLanguageLabel(row.languageCode),
        status: row.status ?? "requested",
        jobId: row.jobId ?? null,
        uploadedTrackId: row.uploadedTrackId ?? null,
        dubbingId: row.dubbingId ?? null,
        temporaryVttUrl: row.temporaryVttUrl ?? null,
        errorMessage: row.errorMessage ?? null,
        updatedAtMs: row.updatedAtMs,
      }));
  },
});

export const claimRequestedTranslationsInternal = internalMutation({
  args: {
    muxAssetId: v.string(),
    userId: v.string(),
    languageCodes: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const requestedAtMs = Date.now();
    const languageCodes = normalizeAudioTranslationLanguageCodes(args.languageCodes);
    const claimed: Array<{ languageCode: string; shouldCreate: boolean }> = [];

    for (const languageCode of languageCodes) {
      const existing = await (ctx.db as any)
        .query("audioTranslationJobs")
        .withIndex("by_asset_language", (q: any) =>
          q.eq("muxAssetId", args.muxAssetId).eq("languageCode", languageCode),
        )
        .unique();

      if (existing) {
        if (existing.status === "errored" || existing.status === "cancelled") {
          await (ctx.db as any).patch(existing._id, {
            status: "requested",
            updatedAtMs: requestedAtMs,
            languageLabel:
              existing.languageLabel ?? getAudioTranslationLanguageLabel(languageCode),
            errorMessage: undefined,
            jobId: undefined,
            uploadedTrackId: undefined,
            temporaryVttUrl: undefined,
            dubbingId: undefined,
          });
          claimed.push({ languageCode, shouldCreate: true });
          continue;
        }

        if (
          existing.status === "requested" &&
          typeof existing.updatedAtMs === "number" &&
          requestedAtMs - existing.updatedAtMs < REQUEST_CLAIM_COOLDOWN_MS
        ) {
          claimed.push({ languageCode, shouldCreate: false });
          continue;
        }

        if (existing.status === "requested" || !existing.status) {
          await (ctx.db as any).patch(existing._id, {
            status: "requested",
            updatedAtMs: requestedAtMs,
            languageLabel:
              existing.languageLabel ?? getAudioTranslationLanguageLabel(languageCode),
          });
          claimed.push({ languageCode, shouldCreate: true });
          continue;
        }
        claimed.push({ languageCode, shouldCreate: false });
        continue;
      }

      await (ctx.db as any).insert("audioTranslationJobs", {
        muxAssetId: args.muxAssetId,
        userId: args.userId,
        languageCode,
        languageLabel: getAudioTranslationLanguageLabel(languageCode),
        status: "requested",
        createdAtMs: requestedAtMs,
        updatedAtMs: requestedAtMs,
      });
      claimed.push({ languageCode, shouldCreate: true });
    }

    return claimed;
  },
});

export const updateTranslationStatusInternal = internalMutation({
  args: {
    muxAssetId: v.string(),
    languageCode: v.string(),
    status: v.union(
      v.literal("requested"),
      v.literal("pending"),
      v.literal("processing"),
      v.literal("completed"),
      v.literal("errored"),
      v.literal("cancelled"),
    ),
    jobId: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    uploadedTrackId: v.optional(v.string()),
    temporaryVttUrl: v.optional(v.string()),
    dubbingId: v.optional(v.string()),
    passthrough: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await (ctx.db as any)
      .query("audioTranslationJobs")
      .withIndex("by_asset_language", (q: any) =>
        q.eq("muxAssetId", args.muxAssetId).eq("languageCode", args.languageCode),
      )
      .unique();

    if (!row) {
      return { ok: false, missing: true };
    }

    const patch: {
      status: TranslateAudioJobStatus;
      updatedAtMs: number;
      jobId?: string;
      errorMessage?: string;
      uploadedTrackId?: string;
      temporaryVttUrl?: string;
      dubbingId?: string;
      passthrough?: string;
    } = {
      status: args.status,
      updatedAtMs: Date.now(),
    };

    if (args.jobId !== undefined) patch.jobId = args.jobId;
    if (args.passthrough !== undefined) patch.passthrough = args.passthrough;
    if (args.errorMessage !== undefined) patch.errorMessage = args.errorMessage;
    if (args.uploadedTrackId !== undefined) patch.uploadedTrackId = args.uploadedTrackId;
    if (args.temporaryVttUrl !== undefined) patch.temporaryVttUrl = args.temporaryVttUrl;
    if (args.dubbingId !== undefined) patch.dubbingId = args.dubbingId;

    await (ctx.db as any).patch(row._id, patch);
    return { ok: true };
  },
});

export const getTranslationJobInternal = internalQuery({
  args: {
    muxAssetId: v.string(),
    languageCode: v.string(),
  },
  handler: async (ctx, args) => {
    return await (ctx.db as any)
      .query("audioTranslationJobs")
      .withIndex("by_asset_language", (q: any) =>
        q.eq("muxAssetId", args.muxAssetId).eq("languageCode", args.languageCode),
      )
      .unique();
  },
});

export const listTranslationJobsForAssetInternal = internalQuery({
  args: {
    muxAssetId: v.string(),
  },
  handler: async (ctx, args) => {
    return await (ctx.db as any)
      .query("audioTranslationJobs")
      .withIndex("by_asset", (q: any) => q.eq("muxAssetId", args.muxAssetId))
      .collect();
  },
});

export const repairMissingFieldsInternal = internalMutation({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const rows = await (ctx.db as any).query("audioTranslationJobs").collect();
    const limit = Math.max(1, Math.floor(args.limit ?? rows.length));

    let scanned = 0;
    let repaired = 0;

    for (const row of rows.slice(0, limit)) {
      scanned += 1;

      const patch: Record<string, unknown> = {};
      if (!row.status) {
        patch.status = "requested";
      }
      if (!row.languageLabel && row.languageCode) {
        patch.languageLabel = getAudioTranslationLanguageLabel(row.languageCode);
      }
      if (Object.keys(patch).length === 0) {
        continue;
      }

      patch.updatedAtMs = Date.now();
      await (ctx.db as any).patch(row._id, patch);
      repaired += 1;
    }

    return { scanned, repaired };
  },
});
