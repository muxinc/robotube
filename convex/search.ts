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

function tokenizeSearchText(normalizedQuery: string) {
  return normalizedQuery
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
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

function scoreLexicalMatch(item: any, normalizedQuery: string, tokens: string[]) {
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

  for (const token of tokens) {
    if (title.includes(token)) score += 2.5;
    if (summary.includes(token)) score += 1;
    if (tags.some((tag: string) => tag.includes(token))) score += 2;
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
    const queryTokens = tokenizeSearchText(normalizedQuery);

    const limit = Math.max(1, Math.min(20, Math.floor(args.limit ?? 12)));
    const feedVideos = (await ctx.runQuery(api.feed.listFeedVideos, {
      limit: 120,
    })) as any[];

    const byAssetId = new Map(feedVideos.map((video) => [video.muxAssetId, video]));

    let vectorResults: Array<{ muxAssetId: string; score: number }> = [];
    try {
      const queryEmbedding = await getQueryEmbedding(normalizedQuery);
      const expandedLimit = Math.max(20, limit * 8);
      const hits = (await (ctx as any).vectorSearch("videoEmbeddings", "by_embedding", {
        vector: queryEmbedding,
        limit: expandedLimit,
      })) as Array<{ _id: string; _score: number }>;

      const rows = (await ctx.runQuery(
        (internal as any).videoEmbeddings.getEmbeddingRowsByIdsInternal,
        {
          ids: hits.map((hit) => hit._id),
        },
      )) as Array<{ _id: string; muxAssetId: string }>;

      const assetByEmbeddingId = new Map(rows.map((row) => [row._id, row.muxAssetId]));
      const scoreByAsset = new Map<string, number>();
      for (const hit of hits) {
        const muxAssetId = assetByEmbeddingId.get(hit._id);
        if (!muxAssetId || !byAssetId.has(muxAssetId)) continue;
        const current = scoreByAsset.get(muxAssetId) ?? Number.NEGATIVE_INFINITY;
        if (hit._score > current) {
          scoreByAsset.set(muxAssetId, hit._score);
        }
      }

      vectorResults = Array.from(scoreByAsset.entries()).map(([muxAssetId, score]) => ({
        muxAssetId,
        score,
      }));
    } catch {
      vectorResults = [];
    }

    const lexicalScores = new Map<string, number>();
    for (const video of feedVideos) {
      const lexicalScore = scoreLexicalMatch(video, normalizedQuery, queryTokens);
      if (lexicalScore > 0) {
        lexicalScores.set(video.muxAssetId, lexicalScore);
      }
    }

    const hasLexicalMatches = lexicalScores.size > 0;
    const mergedScores = new Map<string, number>();

    for (const result of vectorResults) {
      if (!byAssetId.has(result.muxAssetId)) continue;
      if (result.score < 0.45) continue;

      const vectorBoost = Math.max(0, (result.score - 0.45) * 20);
      const current = mergedScores.get(result.muxAssetId) ?? 0;
      mergedScores.set(result.muxAssetId, current + vectorBoost);
    }

    for (const [muxAssetId, lexicalScore] of lexicalScores.entries()) {
      const current = mergedScores.get(muxAssetId) ?? 0;
      const lexicalWeight = hasLexicalMatches ? 4 : 2;
      mergedScores.set(muxAssetId, current + lexicalScore * lexicalWeight);
    }

    return Array.from(mergedScores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([muxAssetId]) => byAssetId.get(muxAssetId))
      .filter(Boolean);
  },
});
