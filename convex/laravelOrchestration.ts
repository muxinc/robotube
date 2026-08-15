"use node";

/**
 * Convex -> Laravel orchestration trigger (PRD §22.5 / Loop 4).
 *
 * When USE_LARAVEL_ORCHESTRATION is on, Robotube's Convex backend hands off the
 * Mux Robots pipeline to the Laravel orchestration backend. This action is the
 * outbound half of that handoff: after a Mux asset is `ready` (see
 * convex/uploads.ts), we sign and POST the asset to Laravel, and mirror the
 * returned run id/status into the mounted Mux component's videoMetadata.custom.
 *
 * Env vars (read via process.env; documented in convex/laravelFlag.ts):
 * - USE_LARAVEL_ORCHESTRATION    : master flag ("true"/"1" => on).
 * - LARAVEL_ORCHESTRATION_URL     : base URL of the Laravel backend.
 * - LARAVEL_ORCHESTRATION_SECRET  : HMAC-SHA256 shared secret (== Laravel's
 *   ROBOTUBE_SHARED_SECRET).
 *
 * Contract #1 (start a run) — must not deviate:
 *   POST {LARAVEL_ORCHESTRATION_URL}/api/robotube/robot-runs
 *   Headers: Content-Type: application/json
 *            X-Robotube-Signature: hex(HMAC-SHA256(rawBody, secret))
 *   Body: { mux_asset_id, user_id, title|null, robotube_video_id|null }
 *   Response: { run_id: number, status: string }  (idempotent per mux_asset_id)
 */

import { createHmac } from "node:crypto";
import { v } from "convex/values";

import { normalizeAudioTranslationLanguageCodes } from "../constants/audio-translation-languages";
import { components, internal } from "./_generated/api";
import { action, internalAction } from "./_generated/server";
import { isLaravelOrchestrationEnabled } from "./laravelFlag";
import { upsertVideoMetadataAndSyncFeedReadModel } from "./feedReadModelSync";

const START_RUN_PATH = "/api/robotube/robot-runs";
const TRANSLATIONS_PATH = "/api/robotube/translations";
const MAX_START_ATTEMPTS = 6;

type TranslationJobStatus =
  | "requested"
  | "pending"
  | "processing"
  | "completed"
  | "errored"
  | "cancelled";

/** Map a Laravel translation status onto the typed-table status vocabulary the UI reads. */
function mapLaravelTranslationStatus(status: string | undefined): TranslationJobStatus {
  switch (status) {
    case "completed":
    // A skipped translation means the target-language track already exists on
    // the asset, so the language is available — report it as completed.
    case "skipped":
      return "completed";
    case "failed":
    case "errored":
      return "errored";
    case "cancelled":
      return "cancelled";
    case "running":
    case "processing":
      return "processing";
    default:
      return "pending";
  }
}

function getStartRunRetryDelayMs(nextAttempt: number): number {
  // Bounded exponential-ish backoff: ~2s, 5s, 15s, 30s, 60s.
  if (nextAttempt <= 1) return 2 * 1000;
  if (nextAttempt <= 2) return 5 * 1000;
  if (nextAttempt <= 3) return 15 * 1000;
  if (nextAttempt <= 4) return 30 * 1000;
  return 60 * 1000;
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

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function sign(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

function signedPost(url: string, secret: string, rawBody: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Robotube-Signature": sign(rawBody, secret),
    },
    body: rawBody,
  });
}

/**
 * Recover the upload-requested translation languages for an asset, per job
 * type. Source: videoMetadata.custom, which is seeded from the upload
 * passthrough (convex/uploads.ts). Legacy uploads only wrote
 * audioTranslationLanguageCodes and meant "translate both", so a missing
 * captionTranslationLanguageCodes key falls back to the audio list; a
 * present-but-empty one means captions were explicitly not requested.
 */
async function getRequestedTranslationLanguages(
  ctx: any,
  muxAssetId: string,
  userId: string,
): Promise<{ audio: string[]; captions: string[] }> {
  const video = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
    muxAssetId,
    userId,
  });
  const metadata = getMetadataRecord((video as any)?.metadata);
  const custom = asRecord(metadata.custom) ?? {};
  const audio = normalizeAudioTranslationLanguageCodes(
    asStringArray(custom.audioTranslationLanguageCodes) ?? [],
  );
  const captions = Array.isArray(custom.captionTranslationLanguageCodes)
    ? normalizeAudioTranslationLanguageCodes(
        custom.captionTranslationLanguageCodes.filter(
          (value): value is string => typeof value === "string",
        ),
      )
    : audio;
  return { audio, captions };
}

/**
 * Merge Laravel run id/status into videoMetadata.custom without clobbering any
 * existing custom keys (mirrors the read-then-upsert pattern used across the
 * Convex Robots pipeline).
 */
async function storeLaravelRunOnVideo(
  ctx: any,
  args: { muxAssetId: string; userId: string; runId: number; runStatus: string },
) {
  const video = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
    muxAssetId: args.muxAssetId,
    userId: args.userId,
  });
  const metadata = getMetadataRecord((video as any)?.metadata);
  const existingCustom = asRecord(metadata.custom) ?? {};

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
    userId: asString(metadata.userId) ?? args.userId,
    custom: {
      ...existingCustom,
      laravelRunId: args.runId,
      laravelRunStatus: args.runStatus,
      laravelRunUpdatedAtMs: Date.now(),
    },
  };

  const title = asString(metadata.title);
  if (title !== undefined) payload.title = title;
  const description = asString(metadata.description);
  if (description !== undefined) payload.description = description;
  const tags = asStringArray(metadata.tags);
  if (tags !== undefined) payload.tags = tags;
  const visibility = asVisibility(metadata.visibility);
  if (visibility !== undefined) payload.visibility = visibility;

  await upsertVideoMetadataAndSyncFeedReadModel(ctx, payload);
}

export const startLaravelRobotRun = internalAction({
  args: {
    muxAssetId: v.string(),
    userId: v.string(),
    title: v.optional(v.string()),
    robotubeVideoId: v.optional(v.string()),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Flag gate: when off, this is a pure no-op (Laravel owns nothing).
    if (!isLaravelOrchestrationEnabled()) {
      console.log(
        "[laravelOrchestration] startLaravelRobotRun skipped: USE_LARAVEL_ORCHESTRATION is off",
      );
      return { ok: false, skipped: true, reason: "flag_off" as const };
    }

    const baseUrl = process.env.LARAVEL_ORCHESTRATION_URL;
    const secret = process.env.LARAVEL_ORCHESTRATION_SECRET;
    if (!baseUrl || !secret) {
      console.log(
        "[laravelOrchestration] startLaravelRobotRun skipped: LARAVEL_ORCHESTRATION_URL / LARAVEL_ORCHESTRATION_SECRET not configured",
      );
      return { ok: false, skipped: true, reason: "missing_env" as const };
    }

    const attempt = Math.max(0, Math.floor(args.attempt ?? 0));
    const url = `${baseUrl.replace(/\/+$/, "")}${START_RUN_PATH}`;

    const requestedLanguages = await getRequestedTranslationLanguages(
      ctx,
      args.muxAssetId,
      args.userId,
    );
    const bodyObj: Record<string, unknown> = {
      mux_asset_id: args.muxAssetId,
      user_id: args.userId,
      title: args.title ?? null,
      robotube_video_id: args.robotubeVideoId ?? null,
    };
    if (
      requestedLanguages.audio.length > 0 ||
      requestedLanguages.captions.length > 0
    ) {
      bodyObj.translations = {
        audio: requestedLanguages.audio,
        captions: requestedLanguages.captions,
      };
    }
    const rawBody = JSON.stringify(bodyObj);
    const signature = sign(rawBody, secret);

    const scheduleRetry = async (reason: string) => {
      const nextAttempt = attempt + 1;
      const shouldRetry = nextAttempt < MAX_START_ATTEMPTS;
      if (shouldRetry) {
        await ctx.scheduler.runAfter(
          getStartRunRetryDelayMs(nextAttempt),
          (internal as any).laravelOrchestration.startLaravelRobotRun,
          {
            muxAssetId: args.muxAssetId,
            userId: args.userId,
            title: args.title,
            robotubeVideoId: args.robotubeVideoId,
            attempt: nextAttempt,
          },
        );
      } else {
        console.error(
          `[laravelOrchestration] startLaravelRobotRun giving up after ${nextAttempt} attempts (${reason}) for asset ${args.muxAssetId}`,
        );
      }
      return shouldRetry;
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Robotube-Signature": signature,
        },
        body: rawBody,
      });
    } catch (error) {
      const message = getErrorMessage(error);
      const retryScheduled = await scheduleRetry(`network_error: ${message}`);
      return { ok: false, skipped: false, error: message, retryScheduled };
    }

    // Retry transient failures (network already handled above): 5xx + 429.
    if (response.status >= 500 || response.status === 429) {
      const retryScheduled = await scheduleRetry(`http_${response.status}`);
      return {
        ok: false,
        skipped: false,
        error: `laravel_http_${response.status}`,
        retryScheduled,
      };
    }

    // Other non-2xx (e.g. 4xx client errors) are not retryable.
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(
        `[laravelOrchestration] startLaravelRobotRun non-retryable HTTP ${response.status} for asset ${args.muxAssetId}: ${text.slice(0, 500)}`,
      );
      return {
        ok: false,
        skipped: false,
        error: `laravel_http_${response.status}`,
        retryScheduled: false,
      };
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (error) {
      const retryScheduled = await scheduleRetry(`bad_json: ${getErrorMessage(error)}`);
      return { ok: false, skipped: false, error: "bad_json", retryScheduled };
    }

    const body = asRecord(parsed) ?? {};
    const runId = typeof body.run_id === "number" ? body.run_id : undefined;
    const runStatus = asString(body.status) ?? "pending";
    if (runId === undefined) {
      const retryScheduled = await scheduleRetry("missing_run_id");
      return { ok: false, skipped: false, error: "missing_run_id", retryScheduled };
    }

    await storeLaravelRunOnVideo(ctx, {
      muxAssetId: args.muxAssetId,
      userId: args.userId,
      runId,
      runStatus,
    });

    return { ok: true, skipped: false, runId, runStatus };
  },
});

/**
 * On-demand translation request routed through Laravel (contract #2 endpoint).
 *
 * There is no pre-existing app-facing action that creates a translation Robots
 * job on demand today (upload-selected languages travel via the start-run
 * payload above; the native pipeline created translations automatically after
 * moderation). This action is the Laravel-owned replacement for that on-demand
 * surface: the Expo app can call it to request one caption/audio translation.
 *
 * Flag OFF => this is a Laravel-only route with no native equivalent, so it
 * no-ops (nothing called it before, so behavior is unchanged). Flag ON => sign
 * and POST {LARAVEL_ORCHESTRATION_URL}/api/robotube/translations, then mirror
 * the returned robot_job_id + status into the typed translation table the UI
 * reads (audioTranslationJobs / captionTranslationJobs).
 */
export const requestTranslationViaLaravel = action({
  args: {
    muxAssetId: v.string(),
    type: v.union(v.literal("captions"), v.literal("audio")),
    language: v.string(),
    userId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!isLaravelOrchestrationEnabled()) {
      return { ok: false, skipped: true, reason: "flag_off" as const };
    }

    const baseUrl = process.env.LARAVEL_ORCHESTRATION_URL;
    const secret = process.env.LARAVEL_ORCHESTRATION_SECRET;
    if (!baseUrl || !secret) {
      return { ok: false, skipped: true, reason: "missing_env" as const };
    }

    const url = `${baseUrl.replace(/\/+$/, "")}${TRANSLATIONS_PATH}`;
    const rawBody = JSON.stringify({
      mux_asset_id: args.muxAssetId,
      type: args.type,
      language: args.language,
    });

    let response: Response;
    try {
      response = await signedPost(url, secret, rawBody);
    } catch (error) {
      return { ok: false, error: getErrorMessage(error) };
    }

    // 404 => no run exists for the asset yet (contract #2). Surface to caller.
    if (response.status === 404) {
      return { ok: false, reason: "no_run" as const };
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(
        `[laravelOrchestration] requestTranslationViaLaravel HTTP ${response.status} for asset ${args.muxAssetId} (${args.type}/${args.language}): ${text.slice(0, 300)}`,
      );
      return { ok: false, error: `laravel_http_${response.status}` };
    }

    const body = asRecord(await response.json().catch(() => null)) ?? {};
    const robotJobId = asString(body.robot_job_id);
    const status = mapLaravelTranslationStatus(asString(body.status));

    const upsert =
      args.type === "audio"
        ? (internal as any).audioTranslations.upsertLaravelTranslationInternal
        : (internal as any).captionTranslations.upsertLaravelTranslationInternal;
    await ctx.runMutation(upsert, {
      muxAssetId: args.muxAssetId,
      userId: args.userId,
      languageCode: args.language,
      status,
      jobId: robotJobId,
    });

    return { ok: true, robotJobId: robotJobId ?? null, status };
  },
});
