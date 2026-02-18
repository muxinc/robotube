"use node";

import { v } from "convex/values";

import { api, internal } from "./_generated/api";
import { action } from "./_generated/server";

function requiredEnv(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function normalizeSearchText(value: string) {
  return value.trim().toLowerCase();
}

async function getQueryEmbedding(searchText: string): Promise<number[]> {
  const openAiApiKey = requiredEnv("OPENAI_API_KEY", process.env.OPENAI_API_KEY);
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openAiApiKey}`,
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: searchText,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Embedding query failed (${response.status}): ${errorText}`);
  }

  const payload = (await response.json()) as {
    data?: Array<{ embedding?: unknown }>;
  };
  const embedding = Array.isArray(payload.data)
    ? payload.data[0]?.embedding
    : undefined;

  if (!Array.isArray(embedding)) {
    throw new Error("Embedding query response did not include an embedding.");
  }

  const values = embedding.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  if (values.length !== 1536) {
    throw new Error(`Expected 1536 embedding dimensions, got ${values.length}.`);
  }
  return values;
}

function scoreLexicalMatch(item: any, normalizedQuery: string) {
  const title = String(item.title ?? "").toLowerCase();
  const summary = String(item.summary ?? "").toLowerCase();
  const tags = Array.isArray(item.tags)
    ? item.tags.map((tag: unknown) => String(tag).toLowerCase())
    : [];

  let score = 0;
  if (title.includes(normalizedQuery)) score += 6;
  if (summary.includes(normalizedQuery)) score += 3;
  for (const tag of tags) {
    if (tag.includes(normalizedQuery)) {
      score += 5;
      break;
    }
  }
  return score;
}

export const searchVideos = action({
  args: {
    queryText: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const normalizedQuery = normalizeSearchText(args.queryText);
    if (normalizedQuery.length < 2) return [];

    const limit = Math.max(1, Math.min(20, Math.floor(args.limit ?? 12)));
    const feedVideos = (await ctx.runQuery(api.feed.listFeedVideos, {
      limit: 120,
    })) as any[];

    const byAssetId = new Map(feedVideos.map((video) => [video.muxAssetId, video]));

    let vectorResults: Array<{ muxAssetId: string; score: number }> = [];
    try {
      const queryEmbedding = await getQueryEmbedding(normalizedQuery);
      vectorResults = (await ctx.runQuery(
        (internal as any).videoEmbeddings.findNearestAssetIdsByEmbeddingInternal,
        {
          embedding: queryEmbedding,
          limit,
        },
      )) as Array<{ muxAssetId: string; score: number }>;
    } catch {
      vectorResults = [];
    }

    const mergedScores = new Map<string, number>();
    for (const result of vectorResults) {
      if (!byAssetId.has(result.muxAssetId)) continue;
      mergedScores.set(result.muxAssetId, result.score * 100);
    }

    for (const video of feedVideos) {
      const lexicalScore = scoreLexicalMatch(video, normalizedQuery);
      if (lexicalScore <= 0) continue;
      const current = mergedScores.get(video.muxAssetId) ?? 0;
      mergedScores.set(video.muxAssetId, current + lexicalScore);
    }

    return Array.from(mergedScores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([muxAssetId]) => byAssetId.get(muxAssetId))
      .filter(Boolean);
  },
});
