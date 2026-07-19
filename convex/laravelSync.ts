/**
 * Laravel -> Convex sync receiver (PRD §22.12 / Loop 11).
 *
 * Laravel owns Mux Robots workflow state; Convex remains the storage/display
 * layer. Laravel calls this endpoint to push run status + display-ready results
 * back into the mounted Mux component's videoMetadata.custom, using the SAME
 * custom keys the Robotube UI already reads (see convex/feed.ts,
 * convex/uploadStatus.ts, convex/moderation.ts, convex/aiMetadata.ts) so the app
 * renders Laravel-produced output with zero UI changes.
 *
 * This file runs in the default Convex runtime (NOT "use node") because
 * httpActions cannot live in a Node action module. HMAC verification uses Web
 * Crypto (crypto.subtle).
 *
 * Contract #2 (sync back) — must not deviate:
 *   POST {convex site URL}/laravel/sync
 *   Headers: X-Robotube-Signature: hex(HMAC-SHA256(rawBody, secret))
 *   Body: {
 *     mux_asset_id: string,
 *     run_id: number,
 *     run_status: "running"|"rejected"|"ready"|"failed",
 *     results: {
 *       moderation_passed: boolean|null,
 *       summary: string|null,
 *       chapters: array|null,
 *       key_moments: array|null,
 *     } | null,
 *   }
 *   Responses:
 *     200 {"ok": true}                         handled (or idempotent no-op)
 *     200 {"ok": false, reason:"unknown_asset"} asset not found — 200 signals
 *          Laravel NOT to retry (chosen non-retry semantics; documented here).
 *     401                                       missing/invalid signature
 *     404                                       flag off (endpoint inert)
 *
 * Env vars: USE_LARAVEL_ORCHESTRATION, LARAVEL_ORCHESTRATION_SECRET
 *   (see convex/laravelFlag.ts).
 */

import { v } from "convex/values";

import { components, internal } from "./_generated/api";
import { httpAction, internalMutation } from "./_generated/server";
import { isLaravelOrchestrationEnabled } from "./laravelFlag";

const TERMINAL_STATUSES = new Set(["ready", "rejected", "failed"]);

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

/** Copy of a custom map with the bookkeeping timestamp dropped, for equality checks. */
function customWithoutTimestamp(custom: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...custom };
  delete clone.laravelRunUpdatedAtMs;
  return clone;
}

/** Mirror of aiMetadata.ts normalizeGeneratedTags: trim, drop empties, dedupe. */
function normalizeGeneratedTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}

// The Laravel sync forwards Mux Robots outputs in snake_case, but the UI/native
// pipeline (aiMetadata.ts + feed.ts) reads camelCase. These helpers read either
// spelling (so a re-sync of already-camelCase data is a no-op) and emit the
// EXACT native shapes feed.ts asChapterArray / asKeyMomentArray consume.
function firstNum(rec: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function firstStr(rec: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

type NativeChapter = { title: string; startTime: number };

/** Mirror of aiMetadata.ts chapter mapping + normalizeChapters. */
function toNativeChapters(raw: unknown): NativeChapter[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const rec = asRecord(item);
      if (!rec) return null;
      const title = typeof rec.title === "string" ? rec.title : "";
      const startTime = firstNum(rec, "start_time", "startTime") ?? -1;
      return { title, startTime };
    })
    .filter(
      (chapter): chapter is NativeChapter =>
        chapter !== null &&
        chapter.title.trim().length > 0 &&
        Number.isFinite(chapter.startTime),
    )
    .map((chapter) => ({ title: chapter.title.trim(), startTime: Math.max(0, chapter.startTime) }))
    .sort((a, b) => a.startTime - b.startTime);
}

type NativeKeyMoment = {
  startMs: number;
  endMs: number;
  cues: { startMs: number; endMs: number; text: string }[];
  overallScore: number | null;
  title: string | null;
  audibleNarrative: string | null;
  notableAudibleConcepts: string[];
  visualNarrative: string | null;
  notableVisualConcepts: { concept: string; score: number; rationale: string }[];
};

/** Mirror of aiMetadata.ts normalizeKeyMoments (snake_case input -> camelCase). */
function toNativeKeyMoments(raw: unknown): NativeKeyMoment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): NativeKeyMoment | null => {
      const rec = asRecord(item);
      if (!rec) return null;
      const startMs = firstNum(rec, "start_ms", "startMs");
      const endMs = firstNum(rec, "end_ms", "endMs");
      if (startMs === undefined || endMs === undefined) return null;

      const cues = Array.isArray(rec.cues)
        ? rec.cues
            .map((cue) => asRecord(cue))
            .map((cue) => {
              if (!cue) return null;
              const cueStart = firstNum(cue, "start_ms", "startMs");
              const cueEnd = firstNum(cue, "end_ms", "endMs");
              const text = typeof cue.text === "string" ? cue.text.trim() : "";
              if (cueStart === undefined || cueEnd === undefined || text.length === 0) return null;
              return { startMs: Math.max(0, cueStart), endMs: Math.max(0, cueEnd), text };
            })
            .filter((cue): cue is { startMs: number; endMs: number; text: string } => cue !== null)
        : [];

      const notableVisualConcepts = Array.isArray(
        rec.notable_visual_concepts ?? rec.notableVisualConcepts,
      )
        ? ((rec.notable_visual_concepts ?? rec.notableVisualConcepts) as unknown[])
            .map((concept) => asRecord(concept))
            .map((concept) => {
              if (!concept) return null;
              const name = firstStr(concept, "concept");
              if (!name) return null;
              const score = firstNum(concept, "score") ?? 0;
              const rationale = typeof concept.rationale === "string" ? concept.rationale.trim() : "";
              return { concept: name.trim(), score, rationale };
            })
            .filter(
              (concept): concept is { concept: string; score: number; rationale: string } =>
                concept !== null,
            )
        : [];

      const audibleConceptsRaw =
        rec.notable_audible_concepts ?? rec.notableAudibleConcepts;

      return {
        startMs: Math.max(0, startMs),
        endMs: Math.max(0, endMs),
        cues,
        overallScore: firstNum(rec, "overall_score", "overallScore") ?? null,
        title: firstStr(rec, "title")?.trim() ?? null,
        audibleNarrative: firstStr(rec, "audible_narrative", "audibleNarrative")?.trim() ?? null,
        notableAudibleConcepts: Array.isArray(audibleConceptsRaw)
          ? audibleConceptsRaw
              .filter((concept): concept is string => typeof concept === "string")
              .map((concept) => concept.trim())
              .filter(Boolean)
          : [],
        visualNarrative: firstStr(rec, "visual_narrative", "visualNarrative")?.trim() ?? null,
        notableVisualConcepts,
      };
    })
    .filter((moment): moment is NativeKeyMoment => moment !== null)
    .sort((a, b) => a.startMs - b.startMs);
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

/** Constant-time comparison of two hex signature strings. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

async function hmacSha256Hex(secret: string, rawBody: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  return toHex(signature);
}

/**
 * Idempotent, order-safe merge of a Laravel run status + results into
 * videoMetadata.custom. Never regresses a terminal run status back to running,
 * and no-ops on a replayed identical (run_id, run_status) delivery.
 */
export const syncRobotRunInternal = internalMutation({
  args: {
    muxAssetId: v.string(),
    runId: v.number(),
    runStatus: v.union(
      v.literal("running"),
      v.literal("rejected"),
      v.literal("ready"),
      v.literal("failed"),
    ),
    results: v.optional(
      v.union(
        v.object({
          moderation_passed: v.optional(v.union(v.boolean(), v.null())),
          summary: v.optional(v.union(v.string(), v.null())),
          title: v.optional(v.union(v.string(), v.null())),
          tags: v.optional(v.union(v.array(v.string()), v.null())),
          chapters: v.optional(v.union(v.array(v.any()), v.null())),
          key_moments: v.optional(v.union(v.array(v.any()), v.null())),
          translations: v.optional(
            v.union(
              v.array(
                v.object({
                  type: v.union(v.literal("captions"), v.literal("audio")),
                  language: v.string(),
                  status: v.union(
                    v.literal("completed"),
                    v.literal("failed"),
                    v.literal("running"),
                  ),
                  mux_job_id: v.optional(v.union(v.string(), v.null())),
                }),
              ),
              v.null(),
            ),
          ),
        }),
        v.null(),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const video = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
      muxAssetId: args.muxAssetId,
    });
    if (!video) {
      return { ok: false, matched: false, reason: "unknown_asset" as const };
    }

    const metadata = getMetadataRecord((video as any)?.metadata);
    const existingCustom = asRecord(metadata.custom) ?? {};
    const userId = asString(metadata.userId) ?? "default";

    const existingRunId = existingCustom.laravelRunId;
    const existingStatus = asString(existingCustom.laravelRunStatus);
    const results = args.results ?? undefined;

    // Run-id authority: an OLDER run_id must never overwrite a newer run's data.
    // This protects a newer (possibly terminal) run from stale / out-of-order
    // deliveries of a different, older run. A newer or same run_id proceeds.
    if (typeof existingRunId === "number" && args.runId < existingRunId) {
      return { ok: true, matched: true, skipped: true, reason: "stale_run" as const };
    }

    // Status regression protection: for the SAME run, a late 'running' sync must
    // not roll a terminal status (ready/rejected/failed) back to running. We keep
    // the stored terminal status but STILL merge whatever result fields the sync
    // carries, so retroactive formatting/field fixes can land after 'ready'.
    const regressingStatus =
      args.runStatus === "running" &&
      existingRunId === args.runId &&
      existingStatus !== undefined &&
      TERMINAL_STATUSES.has(existingStatus);
    const effectiveStatus = regressingStatus ? existingStatus : args.runStatus;

    // Translation results -> the typed tables the UI reads (audioTranslationJobs
    // / captionTranslationJobs), matched by asset + language + type. These upsert
    // mutations are independently idempotent and never regress a terminal row, so
    // repeated / same-status "running" syncs update translation progress safely.
    const translations = results?.translations;
    if (Array.isArray(translations)) {
      for (const entry of translations) {
        const mappedStatus =
          entry.status === "completed"
            ? "completed"
            : entry.status === "failed"
              ? "errored"
              : "processing";
        const upsert =
          entry.type === "audio"
            ? (internal as any).audioTranslations.upsertLaravelTranslationInternal
            : (internal as any).captionTranslations.upsertLaravelTranslationInternal;
        await ctx.runMutation(upsert, {
          muxAssetId: args.muxAssetId,
          userId,
          languageCode: entry.language,
          status: mappedStatus,
          jobId: entry.mux_job_id ?? undefined,
        });
      }
    }

    const now = Date.now();
    const nextCustom: Record<string, unknown> = {
      ...existingCustom,
      laravelRunId: args.runId,
      laravelRunStatus: effectiveStatus,
      laravelRunUpdatedAtMs: now,
    };

    // Native summarize maps into the video's own title/description/tags fields
    // (see aiMetadata.ts upsertAiMetadataFields); mirror those destinations.
    let nextDescription = asString(metadata.description);
    let nextTitle = asString(metadata.title);
    let nextTags = asStringArray(metadata.tags);

    if (results) {
      // Moderation -> the keys uploadStatus.ts + the pipeline gate on.
      // "AtMs" timestamps are pinned to their existing value on replay so an
      // identical re-sync produces an identical record (true no-op below).
      if (typeof results.moderation_passed === "boolean") {
        nextCustom.moderationPassed = results.moderation_passed;
        nextCustom.moderationCheckedAtMs =
          asNumber(existingCustom.moderationCheckedAtMs) ?? now;
        nextCustom.moderationProvider = "laravel_orchestration";
        nextCustom.moderationWorkflow = "moderate";
        nextCustom.moderationJobStatus = "completed";
      }

      // Summary -> video description (feed.ts maps summary <- metadata.description).
      if (typeof results.summary === "string") {
        nextDescription = results.summary;
        nextCustom.aiSummaryJobStatus = "completed";
        nextCustom.aiGeneratedAtMs = asNumber(existingCustom.aiGeneratedAtMs) ?? now;
        nextCustom.aiProvider = "laravel_orchestration";
      }

      // Title -> video title. The native pipeline NEVER overwrites the title
      // from summarize outputs (upsertAiMetadataFields keeps the existing
      // title), so mirror that protection: never clobber a user-provided title,
      // only use Laravel's title to fill an empty one.
      if (
        typeof results.title === "string" &&
        results.title.trim().length > 0 &&
        nextTitle === undefined
      ) {
        nextTitle = results.title.trim();
      }

      // Tags -> video tags. Native replaces tags with the generated set on
      // summarize completion (normalizeGeneratedTags), so replace when provided.
      if (Array.isArray(results.tags)) {
        nextTags = normalizeGeneratedTags(results.tags);
      }

      // Chapters -> custom.aiChapters, converted to the EXACT native camelCase
      // shape ({ title, startTime }) feed.ts asChapterArray reads. Laravel
      // forwards Mux snake_case ({ start_time }), which the UI silently drops.
      if (Array.isArray(results.chapters)) {
        nextCustom.aiChapters = toNativeChapters(results.chapters);
        nextCustom.aiChaptersJobStatus = "completed";
        nextCustom.aiChaptersProvider = "laravel_orchestration";
        nextCustom.aiChaptersGeneratedAtMs =
          asNumber(existingCustom.aiChaptersGeneratedAtMs) ?? now;
        nextCustom.aiChaptersUnavailableReason = null;
      }

      // Key moments -> custom.aiKeyMoments, converted to the EXACT native
      // camelCase StoredKeyMoment shape (startMs/audibleNarrative/...) feed.ts
      // asKeyMomentArray reads. Laravel forwards Mux snake_case.
      if (Array.isArray(results.key_moments)) {
        nextCustom.aiKeyMoments = toNativeKeyMoments(results.key_moments);
        nextCustom.aiKeyMomentsJobStatus = "completed";
        nextCustom.aiKeyMomentsProvider = "laravel_orchestration";
        nextCustom.aiKeyMomentsGeneratedAtMs =
          asNumber(existingCustom.aiKeyMomentsGeneratedAtMs) ?? now;
        nextCustom.aiKeyMomentsUnavailableReason = null;
      }
    }

    const payload: {
      muxAssetId: string;
      userId: string;
      title?: string;
      description?: string;
      tags?: string[];
      visibility?: "private" | "unlisted" | "public";
      custom: Record<string, unknown>;
    } = {
      muxAssetId: args.muxAssetId,
      userId,
      custom: nextCustom,
    };

    if (nextTitle !== undefined) payload.title = nextTitle;
    if (nextDescription !== undefined) payload.description = nextDescription;
    if (nextTags !== undefined) payload.tags = nextTags;
    const visibility = asVisibility(metadata.visibility);
    if (visibility !== undefined) payload.visibility = visibility;

    // Idempotency: if the merge changes nothing (identical replay), skip the
    // write entirely — no timestamp churn, a true no-op. laravelRunUpdatedAtMs is
    // excluded because it is bookkeeping, not content.
    const customChanged =
      JSON.stringify(customWithoutTimestamp(existingCustom)) !==
      JSON.stringify(customWithoutTimestamp(nextCustom));
    const titleChanged = nextTitle !== asString(metadata.title);
    const descriptionChanged = nextDescription !== asString(metadata.description);
    const tagsChanged =
      JSON.stringify(nextTags ?? null) !== JSON.stringify(asStringArray(metadata.tags) ?? null);

    if (!customChanged && !titleChanged && !descriptionChanged && !tagsChanged) {
      return { ok: true, matched: true, skipped: true, reason: "no_op" as const };
    }

    await ctx.runMutation(components.mux.videos.upsertVideoMetadata, payload);

    // Unblock Convex-owned STT caption generation once moderation has passed.
    // With the flag on, moderationPassed only arrives via this sync — after the
    // Mux `video.asset.track.ready` trigger moment that natively kicks off
    // captions has already passed — while Laravel's chapters/key-moments jobs
    // wait on the generated text track: a circular wait (production run 8).
    // Scheduling the existing ensure flow here breaks it, exactly as the native
    // pipeline would. STT stays Convex-owned and ungated; the ensure action is
    // idempotent (its source-track + aiCaptionsGeneratedAtMs guards prevent
    // duplicate subtitle jobs), so scheduling it more than once is safe.
    if (results?.moderation_passed === true) {
      await ctx.scheduler.runAfter(
        0,
        (internal as any).captions.ensureGeneratedCaptionsTrackInternal,
        {
          muxAssetId: args.muxAssetId,
          userId,
          attempt: 0,
        },
      );
    }

    return { ok: true, matched: true, skipped: false };
  },
});

export const laravelSyncHttp = httpAction(async (ctx, request) => {
  // Flag gate: when off, the endpoint behaves as if it does not exist.
  if (!isLaravelOrchestrationEnabled()) {
    return new Response(JSON.stringify({ ok: false, reason: "disabled" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  const secret = process.env.LARAVEL_ORCHESTRATION_SECRET;
  if (!secret) {
    console.error("[laravelSync] LARAVEL_ORCHESTRATION_SECRET is not configured");
    return new Response(JSON.stringify({ ok: false, reason: "server_misconfigured" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  const rawBody = await request.text();
  const provided = request.headers.get("x-robotube-signature") ?? "";
  const expected = await hmacSha256Hex(secret, rawBody);
  if (!provided || !timingSafeEqualHex(provided, expected)) {
    return new Response(JSON.stringify({ ok: false, reason: "invalid_signature" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ ok: false, reason: "invalid_json" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const body = asRecord(parsed) ?? {};
  const muxAssetId = asString(body.mux_asset_id);
  const runId = typeof body.run_id === "number" ? body.run_id : undefined;
  const runStatusRaw = asString(body.run_status);
  const runStatus =
    runStatusRaw === "running" ||
    runStatusRaw === "rejected" ||
    runStatusRaw === "ready" ||
    runStatusRaw === "failed"
      ? runStatusRaw
      : undefined;

  if (!muxAssetId || runId === undefined || runStatus === undefined) {
    return new Response(JSON.stringify({ ok: false, reason: "invalid_payload" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const resultsRecord = asRecord(body.results);
  const translations: {
    type: "captions" | "audio";
    language: string;
    status: "completed" | "failed" | "running";
    mux_job_id: string | null;
  }[] = [];
  if (resultsRecord && Array.isArray(resultsRecord.translations)) {
    for (const raw of resultsRecord.translations) {
      const entry = asRecord(raw);
      if (!entry) continue;
      const type =
        entry.type === "audio" ? "audio" : entry.type === "captions" ? "captions" : undefined;
      const language = asString(entry.language);
      const status =
        entry.status === "completed"
          ? "completed"
          : entry.status === "failed"
            ? "failed"
            : entry.status === "running"
              ? "running"
              : undefined;
      if (!type || !language || !status) continue;
      translations.push({
        type,
        language,
        status,
        mux_job_id: typeof entry.mux_job_id === "string" ? entry.mux_job_id : null,
      });
    }
  }
  const results = resultsRecord
    ? {
        moderation_passed:
          typeof resultsRecord.moderation_passed === "boolean"
            ? resultsRecord.moderation_passed
            : null,
        // The summarize Robots job emits the summary text under `description`
        // (see aiMetadata.ts, which stores outputs.description as the summary),
        // so Laravel's passthrough carries it as `description`, not `summary`.
        // Accept either key — this was why summary stayed empty while the
        // like-named title/tags landed.
        summary:
          asString(resultsRecord.summary) ?? asString(resultsRecord.description) ?? null,
        title: typeof resultsRecord.title === "string" ? resultsRecord.title : null,
        tags: Array.isArray(resultsRecord.tags)
          ? resultsRecord.tags.filter((t): t is string => typeof t === "string")
          : null,
        chapters: Array.isArray(resultsRecord.chapters) ? resultsRecord.chapters : null,
        key_moments: Array.isArray(resultsRecord.key_moments)
          ? resultsRecord.key_moments
          : null,
        translations: translations.length > 0 ? translations : null,
      }
    : null;

  const result = await ctx.runMutation(
    (internal as any).laravelSync.syncRobotRunInternal,
    {
      muxAssetId,
      runId,
      runStatus,
      results,
    },
  );

  // Unknown asset -> 200 with ok:false so Laravel does NOT retry indefinitely.
  if (result && result.matched === false) {
    return new Response(JSON.stringify({ ok: false, reason: "unknown_asset" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});
