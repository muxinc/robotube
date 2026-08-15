import { v } from "convex/values";

import { internal } from "./_generated/api";
import { query } from "./_generated/server";
import {
  type FeedSearchIndexItem,
  type FeedVideoCardItem,
  projectToFeedVideoCardItem,
} from "./feedContracts";

const SEARCH_SCAN_MULTIPLIER = 4;
const SEARCH_MIN_SCAN_LIMIT = 48;
const SEARCH_MAX_SCAN_LIMIT = 120;

function getSearchScanLimit(resultLimit: number) {
  return Math.max(
    SEARCH_MIN_SCAN_LIMIT,
    Math.min(SEARCH_MAX_SCAN_LIMIT, resultLimit * SEARCH_SCAN_MULTIPLIER),
  );
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

function scoreLexicalMatch(
  item: FeedSearchIndexItem,
  normalizedQuery: string,
  tokens: string[],
) {
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

/**
 * Search results render the shared feed card, so the response uses the card
 * contract. Summary and tags are ranking inputs only and are not serialized.
 */
export const searchVideosFast = query({
  args: {
    queryText: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<FeedVideoCardItem[]> => {
    const normalizedQuery = normalizeSearchText(args.queryText);
    if (normalizedQuery.length < 2) return [];

    const queryTokens = tokenizeSearchText(normalizedQuery);
    const limit = Math.max(1, Math.min(60, Math.floor(args.limit ?? 20)));
    const scanLimit = getSearchScanLimit(limit);

    const feedVideos = await ctx.runQuery(internal.feed.listFeedSearchIndexInternal, {
      limit: scanLimit,
    });

    return feedVideos
      .map((video: FeedSearchIndexItem) => ({
        video,
        score: scoreLexicalMatch(video, normalizedQuery, queryTokens),
      }))
      .filter((item: { video: FeedSearchIndexItem; score: number }) => item.score > 0)
      .sort(
        (
          a: { video: FeedSearchIndexItem; score: number },
          b: { video: FeedSearchIndexItem; score: number },
        ) => b.score - a.score || b.video.createdAtMs - a.video.createdAtMs,
      )
      .slice(0, limit)
      .map((item: { video: FeedSearchIndexItem; score: number }) =>
        projectToFeedVideoCardItem(item.video),
      );
  },
});
