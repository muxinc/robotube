"use node";

import { generateEmbeddings } from "@mux/ai/workflows";
import { v } from "convex/values";

import { components, internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import type { EmbeddingChunk } from "./videoEmbeddings";

const EMBEDDING_DIMENSIONS = 1536;
const MAX_EMBEDDING_ATTEMPTS = 8;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getRetryDelayMs(nextAttempt: number) {
  if (nextAttempt <= 1) return 2 * 60 * 1000;
  if (nextAttempt <= 3) return 10 * 60 * 1000;
  if (nextAttempt <= 5) return 30 * 60 * 1000;
  return 2 * 60 * 60 * 1000;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function getMetadataRecord(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return asRecord(value[0]);
  return asRecord(value);
}

function getCustomRecord(metadata: Record<string, unknown>): Record<string, unknown> {
  return asRecord(metadata.custom);
}

function parseEmbeddingChunks(result: unknown): EmbeddingChunk[] {
  const root = asRecord(result);
  const rawChunks = Array.isArray(root.chunks) ? root.chunks : [];
  const chunks: EmbeddingChunk[] = [];

  for (const rawChunk of rawChunks) {
    const chunk = asRecord(rawChunk);
    const metadata = asRecord(chunk.metadata);
    const rawEmbedding = Array.isArray(chunk.embedding) ? chunk.embedding : [];
    const embedding = rawEmbedding.filter(
      (value): value is number => typeof value === "number" && Number.isFinite(value),
    );
    if (embedding.length !== EMBEDDING_DIMENSIONS) continue;

    chunks.push({
      embedding,
      chunkText:
        asString(chunk.text) ??
        asString(chunk.chunkText) ??
        asString(chunk.content) ??
        asString(metadata.text),
      startTimeSeconds:
        asNumber(chunk.startTimeSeconds) ??
        asNumber(chunk.startTime) ??
        asNumber(metadata.startTime),
      endTimeSeconds:
        asNumber(chunk.endTimeSeconds) ??
        asNumber(chunk.endTime) ??
        asNumber(metadata.endTime),
    });
  }

  return chunks;
}

export const generateAssetEmbeddingsInternal = internalAction({
  args: {
    muxAssetId: v.string(),
    userId: v.string(),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const attempt = Math.max(0, Math.floor(args.attempt ?? 0));
    const video = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
      muxAssetId: args.muxAssetId,
      userId: args.userId,
    });

    if (!video || !video.asset) {
      return { ok: false, skipped: true, reason: "asset_not_found" };
    }

    const metadata = getMetadataRecord(video.metadata);
    const existingCustom = getCustomRecord(metadata);
    if (existingCustom.embeddingsGeneratedAtMs) {
      return { ok: true, skipped: true, reason: "already_generated" };
    }

    try {
      const result = await generateEmbeddings(args.muxAssetId, {
        provider: "openai",
      });
      const chunks = parseEmbeddingChunks(result);

      if (chunks.length === 0) {
        throw new Error("No embedding chunks were generated for this asset.");
      }

      await ctx.runMutation((internal as any).videoEmbeddings.replaceAssetEmbeddingsInternal, {
        muxAssetId: args.muxAssetId,
        userId: args.userId,
        chunks,
      });

      const latestVideo = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
        muxAssetId: args.muxAssetId,
        userId: args.userId,
      });
      const latestMetadata = getMetadataRecord(latestVideo?.metadata);
      const latestCustom = getCustomRecord(latestMetadata);

      await ctx.runMutation(components.mux.videos.upsertVideoMetadata, {
        muxAssetId: args.muxAssetId,
        userId: args.userId,
        title: asString(latestMetadata.title) ?? asString(metadata.title),
        description:
          asString(latestMetadata.description) ?? asString(metadata.description),
        tags: Array.isArray(latestMetadata.tags)
          ? (latestMetadata.tags as string[])
          : Array.isArray(metadata.tags)
            ? (metadata.tags as string[])
            : undefined,
        custom: {
          ...latestCustom,
          embeddingsGeneratedAtMs: Date.now(),
          embeddingsAttemptCount: attempt + 1,
          embeddingsChunkCount: chunks.length,
          embeddingsProvider: "openai",
        },
      });

      return { ok: true, skipped: false, chunkCount: chunks.length };
    } catch (error) {
      const message = getErrorMessage(error);
      const nextAttempt = attempt + 1;
      const shouldRetry = nextAttempt < MAX_EMBEDDING_ATTEMPTS;

      if (shouldRetry) {
        await ctx.scheduler.runAfter(
          getRetryDelayMs(nextAttempt),
          (internal as any).videoEmbeddingsNode.generateAssetEmbeddingsInternal,
          {
            muxAssetId: args.muxAssetId,
            userId: args.userId,
            attempt: nextAttempt,
          },
        );
      }

      const latestVideo = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
        muxAssetId: args.muxAssetId,
        userId: args.userId,
      });
      const latestMetadata = getMetadataRecord(latestVideo?.metadata);
      const latestCustom = getCustomRecord(latestMetadata);

      await ctx.runMutation(components.mux.videos.upsertVideoMetadata, {
        muxAssetId: args.muxAssetId,
        userId: args.userId,
        title: asString(latestMetadata.title) ?? asString(metadata.title),
        description:
          asString(latestMetadata.description) ?? asString(metadata.description),
        tags: Array.isArray(latestMetadata.tags)
          ? (latestMetadata.tags as string[])
          : Array.isArray(metadata.tags)
            ? (metadata.tags as string[])
            : undefined,
        custom: {
          ...latestCustom,
          embeddingsFailedAtMs: Date.now(),
          embeddingsLastError: message,
          embeddingsAttemptCount: nextAttempt,
          embeddingsRetryScheduled: shouldRetry,
        },
      });

      return {
        ok: false,
        skipped: false,
        error: message,
        retryScheduled: shouldRetry,
        nextAttempt,
      };
    }
  },
});
