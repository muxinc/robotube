/**
 * Deterministic feed fixtures and the feed-card response-shape contract.
 *
 * Two jobs:
 *
 *   1. Generate a repeatable feed of N items from a seed, so a scroll scenario
 *      run on Monday and the same run on Friday exercise identical data. The
 *      generator is pure: same seed and count always produce byte-identical
 *      JSON.
 *   2. Encode the card contract as an executable check so rich metadata cannot
 *      reappear in the feed response.
 *
 * The generator produces *fixtures*. Sizes computed from fixtures describe the
 * fixtures only; they are not measurements of the production Convex response.
 */

/** These eight fields are the entire feed-card contract. */
export const FEED_CARD_CONTRACT_FIELDS = [
  "muxAssetId",
  "playbackId",
  "thumbnailUrl",
  "title",
  "channelName",
  "channelAvatarUrl",
  "durationSeconds",
  "createdAtMs",
] as const;

export type FeedCardContractField = (typeof FEED_CARD_CONTRACT_FIELDS)[number];

export type FeedCardContract = {
  muxAssetId: string;
  playbackId: string;
  thumbnailUrl: string;
  title: string;
  channelName: string;
  channelAvatarUrl: string | null;
  durationSeconds: number | null;
  createdAtMs: number;
};

/**
 * Keys that must never appear in a feed-card response. `playbackUrl` is on the
 * list because the card contract carries a playback ID and the client builds
 * the URL; shipping a URL per card is both payload the feed does not need and
 * a field that tends to grow signed parameters later.
 */
export const FEED_CARD_FORBIDDEN_FIELDS = [
  "summary",
  "tags",
  "chapters",
  "keyMoments",
  "keyMomentsGeneratedAtMs",
  "keyMomentsUnavailableReason",
  "transcript",
  "transcriptCues",
  "cues",
  "embedding",
  "moderation",
  "playbackUrl",
  "playbackToken",
  "signedPlaybackUrl",
] as const;

export type FeedCardContractViolation = {
  index: number;
  kind: "missing_field" | "unexpected_field" | "forbidden_field" | "wrong_type";
  field: string;
  detail?: string;
};

const FORBIDDEN_FIELD_SET = new Set<string>(FEED_CARD_FORBIDDEN_FIELDS);
const CONTRACT_FIELD_SET = new Set<string>(FEED_CARD_CONTRACT_FIELDS);

function checkFieldType(field: FeedCardContractField, value: unknown): string | null {
  switch (field) {
    case "muxAssetId":
    case "playbackId":
    case "thumbnailUrl":
    case "title":
    case "channelName":
      return typeof value === "string" ? null : `expected string, received ${typeof value}`;
    case "channelAvatarUrl":
      return value === null || typeof value === "string"
        ? null
        : `expected string or null, received ${typeof value}`;
    case "durationSeconds":
      return value === null || (typeof value === "number" && Number.isFinite(value))
        ? null
        : "expected finite number or null";
    case "createdAtMs":
      return typeof value === "number" && Number.isFinite(value)
        ? null
        : "expected finite number";
    default:
      return null;
  }
}

/** Validates a feed-card page and returns every contract violation. */
export function findFeedCardContractViolations(
  page: readonly unknown[],
): FeedCardContractViolation[] {
  const violations: FeedCardContractViolation[] = [];

  page.forEach((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      violations.push({
        index,
        kind: "wrong_type",
        field: "<item>",
        detail: "expected a plain object",
      });
      return;
    }

    const record = item as Record<string, unknown>;

    for (const field of FEED_CARD_CONTRACT_FIELDS) {
      if (!(field in record)) {
        violations.push({ index, kind: "missing_field", field });
        continue;
      }
      const typeError = checkFieldType(field, record[field]);
      if (typeError) {
        violations.push({ index, kind: "wrong_type", field, detail: typeError });
      }
    }

    for (const key of Object.keys(record)) {
      if (CONTRACT_FIELD_SET.has(key)) continue;
      violations.push({
        index,
        kind: FORBIDDEN_FIELD_SET.has(key) ? "forbidden_field" : "unexpected_field",
        field: key,
      });
    }
  });

  return violations;
}

export function isFeedCardContractPage(page: readonly unknown[]): boolean {
  return findFeedCardContractViolations(page).length === 0;
}

/** Narrows an arbitrary feed row to the card contract, dropping everything else. */
export function projectFeedCard(row: Readonly<Record<string, unknown>>): FeedCardContract {
  return {
    muxAssetId: String(row.muxAssetId ?? ""),
    playbackId: String(row.playbackId ?? ""),
    thumbnailUrl: String(row.thumbnailUrl ?? ""),
    title: String(row.title ?? ""),
    channelName: String(row.channelName ?? ""),
    channelAvatarUrl:
      typeof row.channelAvatarUrl === "string" ? row.channelAvatarUrl : null,
    durationSeconds:
      typeof row.durationSeconds === "number" && Number.isFinite(row.durationSeconds)
        ? row.durationSeconds
        : null,
    createdAtMs:
      typeof row.createdAtMs === "number" && Number.isFinite(row.createdAtMs)
        ? row.createdAtMs
        : 0,
  };
}

/** Serialized byte length of the JSON encoding, counting UTF-8 bytes. */
export function serializedByteLength(value: unknown): number {
  const json = JSON.stringify(value) ?? "";
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(json).length;
  }
  // Fallback for runtimes without TextEncoder; ASCII-only fixtures are exact.
  return json.length;
}

/** A 16-card feed response must serialize to at most 15 KB. */
export const FEED_RESPONSE_SIZE_BUDGET_BYTES = 15 * 1024;
export const FEED_RESPONSE_SIZE_BUDGET_CARD_COUNT = 16;

export type FeedResponseSizeReport = {
  cardCount: number;
  bytes: number;
  bytesPerCard: number;
  budgetBytes: number;
  withinBudget: boolean;
};

/**
 * Scales the budget with the card count so a 48-item page is judged against
 * the same per-card allowance as the 16-item page.
 */
export function measureFeedResponseSize(
  page: readonly unknown[],
  budgetBytes = FEED_RESPONSE_SIZE_BUDGET_BYTES,
  budgetCardCount = FEED_RESPONSE_SIZE_BUDGET_CARD_COUNT,
): FeedResponseSizeReport {
  const bytes = serializedByteLength(page);
  const cardCount = page.length;
  const scaledBudget =
    cardCount === 0 ? budgetBytes : (budgetBytes / budgetCardCount) * cardCount;

  return {
    cardCount,
    bytes,
    bytesPerCard: cardCount === 0 ? 0 : bytes / cardCount,
    budgetBytes: Math.round(scaledBudget),
    withinBudget: bytes <= scaledBudget,
  };
}

/** mulberry32: small, fast, and stable across engines. */
function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIXTURE_TITLE_NOUNS = [
  "Pipeline",
  "Ingest",
  "Playback",
  "Manifest",
  "Renditions",
  "Captions",
  "Thumbnails",
  "Webhooks",
  "Latency",
  "Encoding",
] as const;

const FIXTURE_TITLE_VERBS = [
  "Debugging",
  "Shipping",
  "Measuring",
  "Rewriting",
  "Profiling",
  "Explaining",
] as const;

const FIXTURE_CHANNELS = [
  "@robotube",
  "@muxlabs",
  "@convexdev",
  "@expo",
  "@streamteam",
] as const;

export type DeterministicFeedOptions = {
  /** Number of cards to generate. */
  count: number;
  /** Any integer. The same seed always yields the same feed. */
  seed?: number;
  /**
   * Real Mux playback IDs to cycle through. Supply these to make the fixture
   * feed actually playable; without them the generator emits clearly-marked
   * synthetic IDs that will not resolve against Mux.
   */
  playbackIds?: readonly string[];
  /** Fixed epoch for `createdAtMs` so output never depends on the current time. */
  baseCreatedAtMs?: number;
  /** Thumbnail width requested from image.mux.com. */
  thumbnailWidth?: number;
};

export const DEFAULT_FIXTURE_SEED = 20260730;
/** 2026-01-01T00:00:00.000Z — a fixed epoch keeps generated JSON stable. */
export const DEFAULT_FIXTURE_BASE_CREATED_AT_MS = 1767225600000;

export const SYNTHETIC_PLAYBACK_ID_PREFIX = "synthetic-not-playable-";

export function isSyntheticPlaybackId(playbackId: string): boolean {
  return playbackId.startsWith(SYNTHETIC_PLAYBACK_ID_PREFIX);
}

/**
 * Builds a deterministic feed-card page.
 *
 * Cards are ordered newest-first to match `listFeedVideosPaginated`, and
 * `createdAtMs` values are strictly descending so pagination tests can detect
 * reordering.
 */
export function createDeterministicFeed(
  options: DeterministicFeedOptions,
): FeedCardContract[] {
  const count = Math.max(0, Math.floor(options.count));
  const random = createSeededRandom(options.seed ?? DEFAULT_FIXTURE_SEED);
  const baseCreatedAtMs = options.baseCreatedAtMs ?? DEFAULT_FIXTURE_BASE_CREATED_AT_MS;
  const thumbnailWidth = options.thumbnailWidth ?? 1280;
  const playbackIds = options.playbackIds ?? [];

  const cards: FeedCardContract[] = [];

  for (let index = 0; index < count; index += 1) {
    const verb = FIXTURE_TITLE_VERBS[Math.floor(random() * FIXTURE_TITLE_VERBS.length)];
    const noun = FIXTURE_TITLE_NOUNS[Math.floor(random() * FIXTURE_TITLE_NOUNS.length)];
    const channelName = FIXTURE_CHANNELS[Math.floor(random() * FIXTURE_CHANNELS.length)];
    const hasAvatar = random() > 0.25;
    const hasDuration = random() > 0.05;
    const durationSeconds = hasDuration ? 15 + Math.floor(random() * 585) : null;

    const paddedIndex = String(index).padStart(3, "0");
    const playbackId =
      playbackIds.length > 0
        ? playbackIds[index % playbackIds.length]
        : `${SYNTHETIC_PLAYBACK_ID_PREFIX}${paddedIndex}`;

    cards.push({
      muxAssetId: `fixture-asset-${paddedIndex}`,
      playbackId,
      thumbnailUrl: `https://image.mux.com/${playbackId}/thumbnail.jpg?width=${thumbnailWidth}`,
      title: `${verb} ${noun} #${paddedIndex}`,
      channelName,
      channelAvatarUrl: hasAvatar
        ? `https://images.example.test/avatars/${channelName.slice(1)}.png`
        : null,
      durationSeconds,
      // Strictly descending, one hour apart.
      createdAtMs: baseCreatedAtMs - index * 3_600_000,
    });
  }

  return cards;
}

/**
 * Attaches synthetic rich metadata to a card. Used only as the negative case
 * for the response-shape contract test; nothing should ever send this shape to
 * the feed.
 */
export function withSyntheticRichMetadata(
  card: FeedCardContract,
  options?: { keyMomentCount?: number; transcriptCueCount?: number },
): Record<string, unknown> {
  const keyMomentCount = options?.keyMomentCount ?? 2;
  const transcriptCueCount = options?.transcriptCueCount ?? 10;

  return {
    ...card,
    playbackUrl: `https://stream.mux.com/${card.playbackId}.m3u8`,
    summary: `Synthetic summary for ${card.title}.`,
    tags: ["synthetic", "fixture", "not-real"],
    chapters: [{ title: "Intro", startTime: 0 }],
    keyMoments: Array.from({ length: keyMomentCount }, (_unused, momentIndex) => ({
      startMs: momentIndex * 30_000,
      endMs: momentIndex * 30_000 + 15_000,
      cues: Array.from({ length: transcriptCueCount }, (_cue, cueIndex) => ({
        startMs: cueIndex * 1_000,
        endMs: cueIndex * 1_000 + 900,
        text: `synthetic cue ${cueIndex}`,
      })),
      overallScore: 0.5,
      title: `Moment ${momentIndex}`,
      audibleNarrative: "synthetic",
      notableAudibleConcepts: ["synthetic"],
      visualNarrative: "synthetic",
      notableVisualConcepts: [{ concept: "synthetic", score: 0.5, rationale: "fixture" }],
    })),
    keyMomentsGeneratedAtMs: card.createdAtMs,
    keyMomentsUnavailableReason: null,
  };
}
