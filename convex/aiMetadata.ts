"use node";

import Mux from "@mux/mux-node";
import { v } from "convex/values";

import { components, internal } from "./_generated/api";
import { action, internalAction } from "./_generated/server";

const MAX_ATTEMPTS = 10;
const AI_METADATA_READY_DELAY_MS = 5 * 1000;
const AI_METADATA_SOURCE_CAPTIONS_RETRY_DELAY_MS = 30 * 1000;
const AI_METADATA_FALLBACK_POLL_DELAY_MS = 2 * 60 * 1000;
const MUX_ROBOTS_API_BASE_URL = "https://api.mux.com/robots/v1";
const SUMMARIZE_TONE = "neutral";
const SUMMARIZE_TITLE_LENGTH = 80;
const SUMMARIZE_DESCRIPTION_LENGTH = 320;
const SUMMARIZE_TAG_COUNT = 10;
const SUMMARIZE_MAX_POLL_ATTEMPTS = 30;
const SUMMARIZE_POLL_INTERVAL_MS = 1500;
const GENERATE_CHAPTERS_MAX_POLL_ATTEMPTS = 30;
const GENERATE_CHAPTERS_POLL_INTERVAL_MS = 1500;
const FIND_KEY_MOMENTS_MAX_MOMENTS = 5;
const FIND_KEY_MOMENTS_MAX_POLL_ATTEMPTS = 30;
const FIND_KEY_MOMENTS_POLL_INTERVAL_MS = 1500;

type MuxRobotsJobStatus = "pending" | "processing" | "completed" | "errored" | "cancelled";
type AiRobotsWorkflow = "summarize" | "generate-chapters" | "find-key-moments";

function getRetryDelayMs(nextAttempt: number) {
  if (nextAttempt <= 1) return 5 * 60 * 1000;
  if (nextAttempt === 2) return 30 * 60 * 1000;
  if (nextAttempt === 3) return 2 * 60 * 60 * 1000;
  return 12 * 60 * 60 * 1000;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function isMuxRobotsPollingDisabled() {
  return process.env.DISABLE_MUX_ROBOTS_POLLING === "true";
}

type MuxKeyMomentCue = {
  start_ms: number;
  end_ms: number;
  text: string;
};

type MuxKeyMomentVisualConcept = {
  concept?: string;
  score?: number;
  rationale?: string;
};

type MuxKeyMoment = {
  start_ms?: number;
  end_ms?: number;
  cues?: MuxKeyMomentCue[];
  overall_score?: number;
  title?: string;
  audible_narrative?: string;
  notable_audible_concepts?: string[];
  visual_narrative?: string;
  notable_visual_concepts?: MuxKeyMomentVisualConcept[];
};

type FindKeyMomentsJob = {
  id: string;
  status: MuxRobotsJobStatus;
  outputs?:
    | {
        moments?: MuxKeyMoment[];
      }
    | MuxKeyMoment[];
  errors?: {
    type?: string;
    message?: string;
  }[];
};

type SummarizeJob = {
  id: string;
  status: MuxRobotsJobStatus;
  outputs?: {
    title?: string;
    description?: string;
    tags?: string[];
  };
  errors?: {
    type?: string;
    message?: string;
  }[];
};

type GenerateChaptersJob = {
  id: string;
  status: MuxRobotsJobStatus;
  outputs?: {
    chapters?: Array<{
      start_time?: number;
      title?: string;
    }>;
  };
  errors?: {
    type?: string;
    message?: string;
  }[];
};

type StoredKeyMoment = {
  startMs: number;
  endMs: number;
  cues: Array<{ startMs: number; endMs: number; text: string }>;
  overallScore: number | null;
  title: string | null;
  audibleNarrative: string | null;
  notableAudibleConcepts: string[];
  visualNarrative: string | null;
  notableVisualConcepts: Array<{
    concept: string;
    score: number;
    rationale: string;
  }>;
};

class MuxJobLookupError extends Error {
  retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "MuxJobLookupError";
    this.retryable = retryable;
  }
}

function requiredEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing env var: ${name}`);
  }
  return value;
}

function createMuxBasicAuthHeader() {
  const tokenId = requiredEnv("MUX_TOKEN_ID", process.env.MUX_TOKEN_ID);
  const tokenSecret = requiredEnv("MUX_TOKEN_SECRET", process.env.MUX_TOKEN_SECRET);
  return `Basic ${Buffer.from(`${tokenId}:${tokenSecret}`).toString("base64")}`;
}

function createMuxClient() {
  return new Mux({
    tokenId: requiredEnv("MUX_TOKEN_ID", process.env.MUX_TOKEN_ID),
    tokenSecret: requiredEnv("MUX_TOKEN_SECRET", process.env.MUX_TOKEN_SECRET),
  });
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function readResponseTextSafe(response: Response) {
  try {
    const text = await response.text();
    return text.trim();
  } catch {
    return "";
  }
}

function formatFindKeyMomentsErrors(errors: FindKeyMomentsJob["errors"]) {
  if (!errors || errors.length === 0) {
    return "Unknown Mux find-key-moments error.";
  }

  return errors
    .map((error) => error?.message || error?.type || "Unknown error")
    .join("; ");
}

function formatSummarizeErrors(errors: SummarizeJob["errors"]) {
  if (!errors || errors.length === 0) {
    return "Unknown Mux summarize error.";
  }

  return errors
    .map((error) => error?.message || error?.type || "Unknown error")
    .join("; ");
}

function formatGenerateChaptersErrors(errors: GenerateChaptersJob["errors"]) {
  if (!errors || errors.length === 0) {
    return "Unknown Mux generate-chapters error.";
  }

  return errors
    .map((error) => error?.message || error?.type || "Unknown error")
    .join("; ");
}

function asCustomRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length > 0 ? strings : undefined;
}

function asMuxRobotsJobStatus(value: unknown): MuxRobotsJobStatus | undefined {
  return value === "pending" ||
    value === "processing" ||
    value === "completed" ||
    value === "errored" ||
    value === "cancelled"
    ? value
    : undefined;
}

function isTerminalMuxRobotsJobStatus(
  value: unknown,
): value is "completed" | "errored" | "cancelled" {
  return value === "completed" || value === "errored" || value === "cancelled";
}

function unwrapMuxJob<T>(payload: unknown): T {
  return ((payload as { data?: T } | undefined)?.data ?? payload) as T;
}

function requireMuxJobId(workflow: string, value: unknown) {
  const jobId = asString(value);
  if (!jobId) {
    throw new Error(`Mux ${workflow} job response did not include an id.`);
  }
  return jobId;
}

function asVisibility(
  value: unknown,
): "private" | "unlisted" | "public" | undefined {
  return value === "private" || value === "unlisted" || value === "public"
    ? value
    : undefined;
}

function normalizeLanguageCode(value: unknown) {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase().split("-")[0] ?? "";
  return normalized === "auto" || normalized === "und" ? "" : normalized;
}

function getTrackLanguageCode(track: any) {
  return normalizeLanguageCode(track?.language_code ?? track?.languageCode ?? track?.language);
}

function findPrimaryAudioTrack(asset: any) {
  return (asset?.tracks ?? []).find(
    (track: any) =>
      track?.type === "audio" &&
      !track?.passthrough &&
      !track?.generated_by &&
      !track?.generatedBy,
  ) ?? (asset?.tracks ?? []).find((track: any) => track?.type === "audio");
}

function getSourceCaptionsLanguageCodeFromAsset(asset: any, preferredLanguageCode?: string) {
  const textTracks = (asset?.tracks ?? []).filter(
    (track: any) =>
      track?.type === "text" &&
      track?.status === "ready" &&
      getTrackLanguageCode(track) !== "" &&
      getTrackLanguageCode(track) !== "auto",
  );

  if (textTracks.length === 0) {
    return undefined;
  }

  const generatedTrack = textTracks.find(
    (track: any) =>
      track?.text_source === "generated_vod" ||
      track?.textSource === "generated_vod" ||
      track?.passthrough === "robotube:auto-generated",
  );
  if (generatedTrack) {
    return getTrackLanguageCode(generatedTrack) || undefined;
  }

  const normalizedPreferredLanguageCode = normalizeLanguageCode(preferredLanguageCode);
  if (normalizedPreferredLanguageCode) {
    const matchingTrack = textTracks.find(
      (track: any) => getTrackLanguageCode(track) === normalizedPreferredLanguageCode,
    );
    if (matchingTrack) {
      return normalizedPreferredLanguageCode;
    }
  }

  const primaryAudioLanguageCode = getTrackLanguageCode(findPrimaryAudioTrack(asset));
  if (primaryAudioLanguageCode) {
    const matchingTrack = textTracks.find(
      (track: any) => getTrackLanguageCode(track) === primaryAudioLanguageCode,
    );
    if (matchingTrack) {
      return primaryAudioLanguageCode;
    }
  }

  return getTrackLanguageCode(textTracks[0]) || undefined;
}

function getMetadataRecord(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return asCustomRecord(value[0]);
  return asCustomRecord(value);
}

function buildMetadataArgs(args: {
  muxAssetId: string;
  userId: string;
  title?: string;
  description?: string;
  tags?: string[];
  visibility?: "private" | "unlisted" | "public";
  custom?: Record<string, unknown>;
}) {
  const payload: {
    muxAssetId: string;
    userId: string;
    title?: string;
    description?: string;
    tags?: string[];
    visibility?: "private" | "unlisted" | "public";
    custom?: Record<string, unknown>;
  } = {
    muxAssetId: args.muxAssetId,
    userId: args.userId,
  };

  if (args.title !== undefined) payload.title = args.title;
  if (args.description !== undefined) payload.description = args.description;
  if (args.tags !== undefined) payload.tags = args.tags;
  if (args.visibility !== undefined) payload.visibility = args.visibility;
  if (args.custom !== undefined) payload.custom = args.custom;

  return payload;
}

async function updateAiMetadataTrackingFields(
  ctx: any,
  args: { muxAssetId: string; userId: string },
  fallbackMetadata: Record<string, unknown>,
  customFields: Record<string, unknown>,
) {
  const latestVideo = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
    muxAssetId: args.muxAssetId,
    userId: args.userId,
  });
  const latestMetadata = getMetadataRecord(latestVideo?.metadata);
  const latestCustom = asCustomRecord(latestMetadata.custom);

  await ctx.runMutation(
    components.mux.videos.upsertVideoMetadata,
    buildMetadataArgs({
      muxAssetId: args.muxAssetId,
      userId: args.userId,
      title: asString(latestMetadata.title) ?? asString(fallbackMetadata.title),
      description: asString(latestMetadata.description) ?? asString(fallbackMetadata.description),
      tags: asStringArray(latestMetadata.tags) ?? asStringArray(fallbackMetadata.tags),
      visibility: asVisibility(latestMetadata.visibility) ?? asVisibility(fallbackMetadata.visibility),
      custom: {
        ...latestCustom,
        ...customFields,
      },
    }),
  );
}

async function upsertAiMetadataFields(
  ctx: any,
  args: { muxAssetId: string; userId: string },
  fields: {
    title?: string;
    description?: string;
    tags?: string[];
    custom: Record<string, unknown>;
  },
) {
  const latestVideo = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
    muxAssetId: args.muxAssetId,
    userId: args.userId,
  });
  const latestMetadata = getMetadataRecord(latestVideo?.metadata);
  const latestCustom = asCustomRecord(latestMetadata.custom);

  await ctx.runMutation(
    components.mux.videos.upsertVideoMetadata,
    buildMetadataArgs({
      muxAssetId: args.muxAssetId,
      userId: args.userId,
      title: fields.title ?? asString(latestMetadata.title),
      description: fields.description ?? asString(latestMetadata.description),
      tags: fields.tags ?? asStringArray(latestMetadata.tags),
      visibility: asVisibility(latestMetadata.visibility),
      custom: {
        ...latestCustom,
        ...fields.custom,
      },
    }),
  );

  return {
    latestMetadata,
    latestCustom,
  };
}

function isActiveMuxRobotsJobStatus(value: unknown) {
  return value === "pending" || value === "processing";
}

function getAiMetadataJobId(custom: Record<string, unknown>, workflow: AiRobotsWorkflow) {
  switch (workflow) {
    case "summarize":
      return asString(custom.aiSummaryJobId);
    case "generate-chapters":
      return asString(custom.aiChaptersJobId);
    case "find-key-moments":
      return asString(custom.aiKeyMomentsJobId);
  }
}

function getAiMetadataJobStatus(
  custom: Record<string, unknown>,
  workflow: AiRobotsWorkflow,
): MuxRobotsJobStatus | undefined {
  switch (workflow) {
    case "summarize":
      return asMuxRobotsJobStatus(custom.aiSummaryJobStatus);
    case "generate-chapters":
      return asMuxRobotsJobStatus(custom.aiChaptersJobStatus);
    case "find-key-moments":
      return asMuxRobotsJobStatus(custom.aiKeyMomentsJobStatus);
  }
}

async function scheduleAiMetadataFallbackPoll(
  ctx: any,
  args: { muxAssetId: string; userId: string; workflow: AiRobotsWorkflow; jobId: string; attempt: number },
) {
  await ctx.scheduler.runAfter(
    AI_METADATA_FALLBACK_POLL_DELAY_MS,
    (internal as any).aiMetadata.pollAiMetadataJobStatusInternal,
    args,
  );
}

async function maybeScheduleEmbeddings(ctx: any, args: { muxAssetId: string; userId: string }) {
  const latestVideo = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
    muxAssetId: args.muxAssetId,
    userId: args.userId,
  });
  const latestMetadata = getMetadataRecord(latestVideo?.metadata);
  const latestCustom = asCustomRecord(latestMetadata.custom);

  if (!latestCustom.aiGeneratedAtMs || latestCustom.embeddingsGeneratedAtMs) {
    return;
  }

  await ctx.scheduler.runAfter(
    0,
    (internal as any).videoEmbeddingsNode.generateAssetEmbeddingsInternal,
    {
      muxAssetId: args.muxAssetId,
      userId: args.userId,
      attempt: 0,
    },
  );
}

function parseMetadataPassthrough(passthrough: unknown): {
  userId?: string;
  title?: string;
  description?: string;
  tags?: string[];
  visibility?: "private" | "unlisted" | "public";
  custom?: Record<string, unknown>;
} {
  const raw = asString(passthrough);
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    const parsedObj = asCustomRecord(parsed);
    if (Object.keys(parsedObj).length === 0) {
      return { userId: raw };
    }

    return {
      userId: asString(parsedObj.userId) ?? asString(parsedObj.user_id),
      title: asString(parsedObj.title),
      description: asString(parsedObj.description),
      tags: asStringArray(parsedObj.tags),
      visibility: asVisibility(parsedObj.visibility),
      custom: asCustomRecord(parsedObj.custom),
    };
  } catch {
    return { userId: raw };
  }
}

function normalizeGeneratedTags(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.map((tag) => tag.trim()).filter(Boolean))];
}

function normalizeChapters(value: Array<{ title: string; startTime: number }>) {
  return value
    .filter(
      (chapter) =>
        typeof chapter.title === "string" &&
        chapter.title.trim().length > 0 &&
        Number.isFinite(chapter.startTime),
    )
    .map((chapter) => ({
      title: chapter.title.trim(),
      startTime: Math.max(0, chapter.startTime),
    }))
    .sort((a, b) => a.startTime - b.startTime);
}

function normalizeKeyMoments(value: MuxKeyMoment[] | undefined): StoredKeyMoment[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((moment) => {
      if (
        typeof moment?.start_ms !== "number" ||
        !Number.isFinite(moment.start_ms) ||
        typeof moment?.end_ms !== "number" ||
        !Number.isFinite(moment.end_ms)
      ) {
        return null;
      }

      const cues = Array.isArray(moment.cues)
        ? moment.cues
            .filter(
              (cue) =>
                typeof cue?.start_ms === "number" &&
                Number.isFinite(cue.start_ms) &&
                typeof cue?.end_ms === "number" &&
                Number.isFinite(cue.end_ms) &&
                typeof cue?.text === "string" &&
                cue.text.trim().length > 0,
            )
            .map((cue) => ({
              startMs: Math.max(0, cue.start_ms),
              endMs: Math.max(0, cue.end_ms),
              text: cue.text.trim(),
            }))
        : [];

      const notableVisualConcepts = Array.isArray(moment.notable_visual_concepts)
        ? moment.notable_visual_concepts
            .filter(
              (concept) =>
                typeof concept?.concept === "string" && concept.concept.trim().length > 0,
            )
            .map((concept) => ({
              concept: concept.concept!.trim(),
              score:
                typeof concept.score === "number" && Number.isFinite(concept.score)
                  ? concept.score
                  : 0,
              rationale:
                typeof concept.rationale === "string" ? concept.rationale.trim() : "",
            }))
        : [];

      return {
        startMs: Math.max(0, moment.start_ms),
        endMs: Math.max(0, moment.end_ms),
        cues,
        overallScore:
          typeof moment.overall_score === "number" && Number.isFinite(moment.overall_score)
            ? moment.overall_score
            : null,
        title: typeof moment.title === "string" && moment.title.trim() ? moment.title.trim() : null,
        audibleNarrative:
          typeof moment.audible_narrative === "string" && moment.audible_narrative.trim()
            ? moment.audible_narrative.trim()
            : null,
        notableAudibleConcepts: Array.isArray(moment.notable_audible_concepts)
          ? moment.notable_audible_concepts
              .filter((concept): concept is string => typeof concept === "string")
              .map((concept) => concept.trim())
              .filter(Boolean)
          : [],
        visualNarrative:
          typeof moment.visual_narrative === "string" && moment.visual_narrative.trim()
            ? moment.visual_narrative.trim()
            : null,
        notableVisualConcepts,
      };
    })
    .filter((moment): moment is StoredKeyMoment => moment !== null)
    .sort((a, b) => a.startMs - b.startMs);
}

function getKeyMomentsOutput(value: FindKeyMomentsJob["outputs"]): MuxKeyMoment[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }

  return Array.isArray(value?.moments) ? value.moments : undefined;
}

async function createFindKeyMomentsJob(args: {
  assetId: string;
  maxMoments: number;
  passthrough?: string;
}): Promise<FindKeyMomentsJob> {
  const response = await fetch(`${MUX_ROBOTS_API_BASE_URL}/jobs/find-key-moments`, {
    method: "POST",
    headers: {
      Authorization: createMuxBasicAuthHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      passthrough: args.passthrough,
      parameters: {
        asset_id: args.assetId,
        max_moments: args.maxMoments,
      },
    }),
  });

  if (!response.ok) {
    const details = await readResponseTextSafe(response);
    throw new Error(
      `Mux find-key-moments job creation failed (${response.status})${details ? `: ${details}` : ""}.`,
    );
  }

  return unwrapMuxJob<FindKeyMomentsJob>(await response.json());
}

async function createSummarizeJob(args: {
  assetId: string;
  tone: "neutral" | "playful" | "professional";
  titleLength: number;
  descriptionLength: number;
  tagCount: number;
  passthrough?: string;
}): Promise<SummarizeJob> {
  const response = await fetch(`${MUX_ROBOTS_API_BASE_URL}/jobs/summarize`, {
    method: "POST",
    headers: {
      Authorization: createMuxBasicAuthHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      passthrough: args.passthrough,
      parameters: {
        asset_id: args.assetId,
        tone: args.tone,
        title_length: args.titleLength,
        description_length: args.descriptionLength,
        tag_count: args.tagCount,
      },
    }),
  });

  if (!response.ok) {
    const details = await readResponseTextSafe(response);
    throw new Error(
      `Mux summarize job creation failed (${response.status})${details ? `: ${details}` : ""}.`,
    );
  }

  return unwrapMuxJob<SummarizeJob>(await response.json());
}

async function createGenerateChaptersJob(args: {
  assetId: string;
  fromLanguageCode: string;
  passthrough?: string;
}): Promise<GenerateChaptersJob> {
  const response = await fetch(`${MUX_ROBOTS_API_BASE_URL}/jobs/generate-chapters`, {
    method: "POST",
    headers: {
      Authorization: createMuxBasicAuthHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      passthrough: args.passthrough,
      parameters: {
        asset_id: args.assetId,
        from_language_code: args.fromLanguageCode,
      },
    }),
  });

  if (!response.ok) {
    const details = await readResponseTextSafe(response);
    throw new Error(
      `Mux generate-chapters job creation failed (${response.status})${details ? `: ${details}` : ""}.`,
    );
  }

  return unwrapMuxJob<GenerateChaptersJob>(await response.json());
}

async function getFindKeyMomentsJob(jobId: string): Promise<FindKeyMomentsJob> {
  const normalizedJobId = requireMuxJobId("find-key-moments", jobId);
  const response = await fetch(`${MUX_ROBOTS_API_BASE_URL}/jobs/find-key-moments/${normalizedJobId}`, {
    method: "GET",
    headers: {
      Authorization: createMuxBasicAuthHeader(),
    },
  });

  if (!response.ok) {
    const details = await readResponseTextSafe(response);
    const retryable =
      response.status === 404 ||
      response.status === 408 ||
      response.status === 409 ||
      response.status === 425 ||
      response.status === 429 ||
      response.status >= 500;
    throw new MuxJobLookupError(
      `Mux find-key-moments job lookup failed (${response.status})${details ? `: ${details}` : ""}.`,
      retryable,
    );
  }

  return unwrapMuxJob<FindKeyMomentsJob>(await response.json());
}

async function getSummarizeJob(jobId: string): Promise<SummarizeJob> {
  const normalizedJobId = requireMuxJobId("summarize", jobId);
  const response = await fetch(`${MUX_ROBOTS_API_BASE_URL}/jobs/summarize/${normalizedJobId}`, {
    method: "GET",
    headers: {
      Authorization: createMuxBasicAuthHeader(),
    },
  });

  if (!response.ok) {
    const details = await readResponseTextSafe(response);
    const retryable =
      response.status === 404 ||
      response.status === 408 ||
      response.status === 409 ||
      response.status === 425 ||
      response.status === 429 ||
      response.status >= 500;
    throw new MuxJobLookupError(
      `Mux summarize job lookup failed (${response.status})${details ? `: ${details}` : ""}.`,
      retryable,
    );
  }

  return unwrapMuxJob<SummarizeJob>(await response.json());
}

async function getGenerateChaptersJob(jobId: string): Promise<GenerateChaptersJob> {
  const normalizedJobId = requireMuxJobId("generate-chapters", jobId);
  const response = await fetch(`${MUX_ROBOTS_API_BASE_URL}/jobs/generate-chapters/${normalizedJobId}`, {
    method: "GET",
    headers: {
      Authorization: createMuxBasicAuthHeader(),
    },
  });

  if (!response.ok) {
    const details = await readResponseTextSafe(response);
    const retryable =
      response.status === 404 ||
      response.status === 408 ||
      response.status === 409 ||
      response.status === 425 ||
      response.status === 429 ||
      response.status >= 500;
    throw new MuxJobLookupError(
      `Mux generate-chapters job lookup failed (${response.status})${details ? `: ${details}` : ""}.`,
      retryable,
    );
  }

  return unwrapMuxJob<GenerateChaptersJob>(await response.json());
}

async function waitForFindKeyMomentsCompletion(jobId: string): Promise<FindKeyMomentsJob> {
  if (isMuxRobotsPollingDisabled()) {
    throw new Error("Mux Robots polling is disabled.");
  }

  const normalizedJobId = requireMuxJobId("find-key-moments", jobId);

  for (let attempt = 0; attempt < FIND_KEY_MOMENTS_MAX_POLL_ATTEMPTS; attempt += 1) {
    let job: FindKeyMomentsJob;
    try {
      job = await getFindKeyMomentsJob(normalizedJobId);
    } catch (error) {
      if (
        error instanceof MuxJobLookupError &&
        error.retryable &&
        attempt < FIND_KEY_MOMENTS_MAX_POLL_ATTEMPTS - 1
      ) {
        await sleep(FIND_KEY_MOMENTS_POLL_INTERVAL_MS);
        continue;
      }

      throw error;
    }

    if (
      job.status === "completed" ||
      job.status === "errored" ||
      job.status === "cancelled"
    ) {
      return job;
    }

    await sleep(FIND_KEY_MOMENTS_POLL_INTERVAL_MS);
  }

  throw new Error("Mux find-key-moments job timed out before completion.");
}

async function waitForSummarizeCompletion(jobId: string): Promise<SummarizeJob> {
  if (isMuxRobotsPollingDisabled()) {
    throw new Error("Mux Robots polling is disabled.");
  }

  const normalizedJobId = requireMuxJobId("summarize", jobId);

  for (let attempt = 0; attempt < SUMMARIZE_MAX_POLL_ATTEMPTS; attempt += 1) {
    let job: SummarizeJob;
    try {
      job = await getSummarizeJob(normalizedJobId);
    } catch (error) {
      if (
        error instanceof MuxJobLookupError &&
        error.retryable &&
        attempt < SUMMARIZE_MAX_POLL_ATTEMPTS - 1
      ) {
        await sleep(SUMMARIZE_POLL_INTERVAL_MS);
        continue;
      }

      throw error;
    }

    if (
      job.status === "completed" ||
      job.status === "errored" ||
      job.status === "cancelled"
    ) {
      return job;
    }

    await sleep(SUMMARIZE_POLL_INTERVAL_MS);
  }

  throw new Error("Mux summarize job timed out before completion.");
}

async function waitForGenerateChaptersCompletion(jobId: string): Promise<GenerateChaptersJob> {
  if (isMuxRobotsPollingDisabled()) {
    throw new Error("Mux Robots polling is disabled.");
  }

  const normalizedJobId = requireMuxJobId("generate-chapters", jobId);

  for (let attempt = 0; attempt < GENERATE_CHAPTERS_MAX_POLL_ATTEMPTS; attempt += 1) {
    let job: GenerateChaptersJob;
    try {
      job = await getGenerateChaptersJob(normalizedJobId);
    } catch (error) {
      if (
        error instanceof MuxJobLookupError &&
        error.retryable &&
        attempt < GENERATE_CHAPTERS_MAX_POLL_ATTEMPTS - 1
      ) {
        await sleep(GENERATE_CHAPTERS_POLL_INTERVAL_MS);
        continue;
      }

      throw error;
    }

    if (
      job.status === "completed" ||
      job.status === "errored" ||
      job.status === "cancelled"
    ) {
      return job;
    }

    await sleep(GENERATE_CHAPTERS_POLL_INTERVAL_MS);
  }

  throw new Error("Mux generate-chapters job timed out before completion.");
}

type EnsureAiMetadataArgs = {
  muxAssetId: string;
  defaultUserId?: string;
};

type EnsureAiMetadataResult =
  | { ok: false; skipped: false; error: string }
  | { ok: false; skipped: true; reason: "asset_not_found" }
  | { ok: false; skipped: true; reason: "asset_not_ready"; userId: string }
  | {
      ok: true;
      skipped: boolean;
      scheduledCaptions: boolean;
      scheduledAiMetadata: boolean;
      userId: string;
    };

type AiMetadataLockResult = {
  acquired: boolean;
  startedAtMs: number;
  userId: string;
};

type GenerateSummaryAndTagsResult =
  | { ok: true; skipped: true; reason: "already_running"; runningUserId: string; startedAtMs: number }
  | { ok: true; skipped: true; reason: "already_generated" }
  | { ok: true; skipped: true; reason: "moderation_pending" | "moderation_rejected" }
  | { ok: true; skipped: true; reason: "polling_disabled" }
  | { ok: false; skipped: true; reason: "asset_not_found" }
  | { ok: boolean; skipped: false; retryScheduled: boolean; nextAttempt: number; errors: string[] };

async function ensureAiMetadataForAssetImpl(
  ctx: any,
  args: EnsureAiMetadataArgs,
): Promise<EnsureAiMetadataResult> {
  let video = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
    muxAssetId: args.muxAssetId,
  });

  if (!video?.asset) {
    try {
      const mux = createMuxClient();
      const asset = await mux.video.assets.retrieve(args.muxAssetId);

      await ctx.runMutation(components.mux.sync.upsertAssetFromPayloadPublic, {
        asset: asset as unknown as Record<string, unknown>,
      });
      await ctx.runMutation((internal as any).muxAssetCache.upsertFromPayloadInternal, {
        asset,
      });

      video = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
        muxAssetId: args.muxAssetId,
      });
    } catch (error) {
      return {
        ok: false,
        skipped: false,
        error: getErrorMessage(error),
      };
    }
  }

  const asset = video?.asset as Record<string, unknown> | null | undefined;
  if (!asset) {
    return { ok: false, skipped: true, reason: "asset_not_found" };
  }

  const metadata = getMetadataRecord(video?.metadata);
  const existingCustom = asCustomRecord(metadata.custom);
  const parsedPassthrough = parseMetadataPassthrough(asset.passthrough);
  const mergedCustom = {
    ...(parsedPassthrough.custom ?? {}),
    ...existingCustom,
  };
  const userId =
    asString(metadata.userId) ??
    parsedPassthrough.userId ??
    asString(args.defaultUserId) ??
    "default";

  await ctx.runMutation(
    components.mux.videos.upsertVideoMetadata,
    buildMetadataArgs({
      muxAssetId: args.muxAssetId,
      userId,
      title: asString(metadata.title) ?? parsedPassthrough.title,
      description: asString(metadata.description) ?? parsedPassthrough.description,
      tags: asStringArray(metadata.tags) ?? parsedPassthrough.tags,
      visibility: asVisibility(metadata.visibility) ?? parsedPassthrough.visibility,
      custom: Object.keys(mergedCustom).length > 0 ? mergedCustom : undefined,
    }),
  );

  const refreshedVideo = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
    muxAssetId: args.muxAssetId,
    userId,
  });
  const refreshedMetadata = getMetadataRecord(refreshedVideo?.metadata);
  const refreshedCustom = asCustomRecord(refreshedMetadata.custom);
  const assetStatus =
    asString((refreshedVideo?.asset as Record<string, unknown> | undefined)?.status) ??
    asString(asset.status);

  if (assetStatus !== "ready") {
    return {
      ok: false,
      skipped: true,
      reason: "asset_not_ready",
      userId,
    };
  }

  if (asFiniteNumber(refreshedCustom.moderationCheckedAtMs) === undefined) {
    return {
      ok: true,
      skipped: true,
      scheduledCaptions: false,
      scheduledAiMetadata: false,
      userId,
    };
  }

  if (refreshedCustom.moderationPassed !== true) {
    return {
      ok: true,
      skipped: true,
      scheduledCaptions: false,
      scheduledAiMetadata: false,
      userId,
    };
  }

  const shouldScheduleCaptions =
    !refreshedCustom.aiCaptionsGeneratedAtMs &&
    !refreshedCustom.aiCaptionsUnavailableReason &&
    !refreshedCustom.aiCaptionsRetryScheduled &&
    !refreshedCustom.aiCaptionsRequestedAtMs;
  const missingSummary = !refreshedCustom.aiGeneratedAtMs;
  const missingChapters =
    !refreshedCustom.aiChaptersGeneratedAtMs &&
    !refreshedCustom.aiChaptersUnavailableReason;
  const missingKeyMoments =
    !refreshedCustom.aiKeyMomentsGeneratedAtMs &&
    !refreshedCustom.aiKeyMomentsUnavailableReason;
  const muxRobotsPollingDisabled = isMuxRobotsPollingDisabled();
  const shouldScheduleAiMetadata =
    !muxRobotsPollingDisabled &&
    (missingSummary || missingChapters || missingKeyMoments) &&
    !refreshedCustom.aiMetadataRetryScheduled &&
    !refreshedCustom.aiMetadataRequestedAtMs;

  if (shouldScheduleCaptions || shouldScheduleAiMetadata) {
    await ctx.runMutation(
      components.mux.videos.upsertVideoMetadata,
      buildMetadataArgs({
        muxAssetId: args.muxAssetId,
        userId,
        title: asString(refreshedMetadata.title),
        description: asString(refreshedMetadata.description),
        tags: asStringArray(refreshedMetadata.tags),
        visibility: asVisibility(refreshedMetadata.visibility),
        custom: {
          ...refreshedCustom,
          ...(shouldScheduleCaptions
            ? {
                aiCaptionsRequestedAtMs:
                  asFiniteNumber(refreshedCustom.aiCaptionsRequestedAtMs) ?? Date.now(),
              }
            : {}),
          ...(shouldScheduleAiMetadata
            ? {
                aiMetadataRequestedAtMs:
                  asFiniteNumber(refreshedCustom.aiMetadataRequestedAtMs) ?? Date.now(),
              }
            : {}),
        },
      }),
    );
  }

  if (shouldScheduleCaptions) {
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

  if (shouldScheduleAiMetadata) {
    await ctx.scheduler.runAfter(
      AI_METADATA_READY_DELAY_MS,
      (internal as any).aiMetadata.generateSummaryAndTagsForAssetInternal,
      {
        muxAssetId: args.muxAssetId,
        userId,
        attempt: 0,
      },
    );
  }

  return {
    ok: true,
    skipped: !shouldScheduleCaptions && !shouldScheduleAiMetadata,
    scheduledCaptions: shouldScheduleCaptions,
    scheduledAiMetadata: shouldScheduleAiMetadata,
    userId,
  };
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function scheduleAiMetadataRetry(
  ctx: any,
  args: { muxAssetId: string; userId: string; attempt: number },
) {
  await ctx.scheduler.runAfter(
    getRetryDelayMs(args.attempt),
    (internal as any).aiMetadata.generateSummaryAndTagsForAssetInternal,
    args,
  );
}

async function applyAiMetadataJobUpdate(
  ctx: any,
  args: { muxAssetId: string; userId: string; workflow: AiRobotsWorkflow },
  job: SummarizeJob | GenerateChaptersJob | FindKeyMomentsJob,
) {
  const video = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
    muxAssetId: args.muxAssetId,
    userId: args.userId,
  });

  if (!video?.asset) {
    return { ok: false, skipped: true, reason: "asset_not_found" as const };
  }

  const metadata = getMetadataRecord(video.metadata);
  const existingCustom = asCustomRecord(metadata.custom);
  const currentJobId = getAiMetadataJobId(existingCustom, args.workflow);
  const currentJobStatus = getAiMetadataJobStatus(existingCustom, args.workflow);

  if (currentJobId && currentJobId !== job.id) {
    return { ok: true, skipped: true, reason: "job_replaced" as const };
  }

  if (isActiveMuxRobotsJobStatus(job.status)) {
    const customFields =
      args.workflow === "summarize"
        ? {
            aiSummaryJobId: job.id,
            aiSummaryJobStatus: job.status,
          }
        : args.workflow === "generate-chapters"
          ? {
              aiChaptersJobId: job.id,
              aiChaptersJobStatus: job.status,
            }
          : {
              aiKeyMomentsJobId: job.id,
              aiKeyMomentsJobStatus: job.status,
            };

    await updateAiMetadataTrackingFields(ctx, args, metadata, customFields);
    return { ok: true, skipped: false, status: job.status };
  }

  const nextOverallAttempt =
    currentJobId === job.id && currentJobStatus === job.status
      ? (asFiniteNumber(existingCustom.aiMetadataAttemptCount) ?? 0)
      : (asFiniteNumber(existingCustom.aiMetadataAttemptCount) ?? 0) + 1;

  if (args.workflow === "summarize") {
    const summarizeJob = job as SummarizeJob;
    if (
      summarizeJob.status === "completed" &&
      currentJobId === summarizeJob.id &&
      asFiniteNumber(existingCustom.aiGeneratedAtMs) !== undefined
    ) {
      return { ok: true, skipped: true, reason: "already_generated" as const };
    }

    if (summarizeJob.status === "completed") {
      await upsertAiMetadataFields(ctx, args, {
        description:
          typeof summarizeJob.outputs?.description === "string"
            ? summarizeJob.outputs.description.trim()
            : undefined,
        tags: normalizeGeneratedTags(summarizeJob.outputs?.tags),
        custom: {
          aiSummaryJobId: summarizeJob.id,
          aiSummaryJobStatus: summarizeJob.status,
          aiGeneratedAtMs: Date.now(),
          aiProvider: "mux",
          aiAttemptCount:
            currentJobId === summarizeJob.id && currentJobStatus === summarizeJob.status
              ? (asFiniteNumber(existingCustom.aiAttemptCount) ?? 1)
              : (asFiniteNumber(existingCustom.aiAttemptCount) ?? 0) + 1,
          aiMetadataRetryScheduled: false,
        },
      });
      await maybeScheduleEmbeddings(ctx, args);
      return { ok: true, skipped: false, status: summarizeJob.status };
    }

    const message = formatSummarizeErrors(summarizeJob.errors);
    const shouldRetry =
      !(currentJobId === summarizeJob.id && currentJobStatus === summarizeJob.status) &&
      nextOverallAttempt < MAX_ATTEMPTS;

    await upsertAiMetadataFields(ctx, args, {
      custom: {
        aiSummaryJobId: summarizeJob.id,
        aiSummaryJobStatus: summarizeJob.status,
        aiMetadataFailedAtMs: Date.now(),
        aiMetadataLastError: `summary: ${message}`,
        aiMetadataAttemptCount: nextOverallAttempt,
        aiMetadataRetryScheduled: shouldRetry,
      },
    });

    if (shouldRetry) {
      await scheduleAiMetadataRetry(ctx, {
        muxAssetId: args.muxAssetId,
        userId: args.userId,
        attempt: nextOverallAttempt,
      });
    }

    return {
      ok: false,
      skipped: false,
      error: message,
      retryScheduled: shouldRetry,
      nextAttempt: nextOverallAttempt,
    };
  }

  if (args.workflow === "generate-chapters") {
    const chaptersJob = job as GenerateChaptersJob;
    if (
      chaptersJob.status === "completed" &&
      currentJobId === chaptersJob.id &&
      asFiniteNumber(existingCustom.aiChaptersGeneratedAtMs) !== undefined
    ) {
      return { ok: true, skipped: true, reason: "already_generated" as const };
    }

    if (chaptersJob.status === "completed") {
      const normalizedChapters = normalizeChapters(
        Array.isArray(chaptersJob.outputs?.chapters)
          ? chaptersJob.outputs.chapters.map((chapter) => ({
              title: typeof chapter?.title === "string" ? chapter.title : "",
              startTime:
                typeof chapter?.start_time === "number" && Number.isFinite(chapter.start_time)
                  ? chapter.start_time
                  : -1,
            }))
          : [],
      );

      await upsertAiMetadataFields(ctx, args, {
        custom: {
          aiChaptersJobId: chaptersJob.id,
          aiChaptersJobStatus: chaptersJob.status,
          aiChapters: normalizedChapters,
          aiChaptersGeneratedAtMs: Date.now(),
          aiChaptersProvider: "mux",
          aiChaptersAttemptCount:
            currentJobId === chaptersJob.id && currentJobStatus === chaptersJob.status
              ? (asFiniteNumber(existingCustom.aiChaptersAttemptCount) ?? 1)
              : (asFiniteNumber(existingCustom.aiChaptersAttemptCount) ?? 0) + 1,
          aiChaptersUnavailableReason: null,
        },
      });
      return { ok: true, skipped: false, status: chaptersJob.status };
    }

    const message = formatGenerateChaptersErrors(chaptersJob.errors);
    const shouldRetry =
      !(currentJobId === chaptersJob.id && currentJobStatus === chaptersJob.status) &&
      nextOverallAttempt < MAX_ATTEMPTS;

    await upsertAiMetadataFields(ctx, args, {
      custom: {
        aiChaptersJobId: chaptersJob.id,
        aiChaptersJobStatus: chaptersJob.status,
        ...(shouldRetry ? {} : { aiChaptersUnavailableReason: message }),
        aiMetadataFailedAtMs: Date.now(),
        aiMetadataLastError: `chapters: ${message}`,
        aiMetadataAttemptCount: nextOverallAttempt,
        aiMetadataRetryScheduled: shouldRetry,
      },
    });

    if (shouldRetry) {
      await scheduleAiMetadataRetry(ctx, {
        muxAssetId: args.muxAssetId,
        userId: args.userId,
        attempt: nextOverallAttempt,
      });
    }

    return {
      ok: false,
      skipped: false,
      error: message,
      retryScheduled: shouldRetry,
      nextAttempt: nextOverallAttempt,
    };
  }

  const keyMomentsJob = job as FindKeyMomentsJob;
  const normalizedKeyMoments = normalizeKeyMoments(getKeyMomentsOutput(keyMomentsJob.outputs));
  if (
    keyMomentsJob.status === "completed" &&
    currentJobId === keyMomentsJob.id &&
    asFiniteNumber(existingCustom.aiKeyMomentsGeneratedAtMs) !== undefined &&
    (normalizedKeyMoments.length === 0 ||
      (Array.isArray(existingCustom.aiKeyMoments) && existingCustom.aiKeyMoments.length > 0))
  ) {
    return { ok: true, skipped: true, reason: "already_generated" as const };
  }

  if (keyMomentsJob.status === "completed") {
    await upsertAiMetadataFields(ctx, args, {
      custom: {
        aiKeyMomentsJobId: keyMomentsJob.id,
        aiKeyMomentsJobStatus: keyMomentsJob.status,
        aiKeyMoments: normalizedKeyMoments,
        aiKeyMomentsGeneratedAtMs: Date.now(),
        aiKeyMomentsProvider: "mux",
        aiKeyMomentsAttemptCount:
          currentJobId === keyMomentsJob.id && currentJobStatus === keyMomentsJob.status
            ? (asFiniteNumber(existingCustom.aiKeyMomentsAttemptCount) ?? 1)
            : (asFiniteNumber(existingCustom.aiKeyMomentsAttemptCount) ?? 0) + 1,
        aiKeyMomentsUnavailableReason: null,
      },
    });
    return { ok: true, skipped: false, status: keyMomentsJob.status };
  }

  const message = formatFindKeyMomentsErrors(keyMomentsJob.errors);
  const shouldRetry =
    !(currentJobId === keyMomentsJob.id && currentJobStatus === keyMomentsJob.status) &&
    nextOverallAttempt < MAX_ATTEMPTS;

  await upsertAiMetadataFields(ctx, args, {
    custom: {
      aiKeyMomentsJobId: keyMomentsJob.id,
      aiKeyMomentsJobStatus: keyMomentsJob.status,
      ...(shouldRetry ? {} : { aiKeyMomentsUnavailableReason: message }),
      aiMetadataFailedAtMs: Date.now(),
      aiMetadataLastError: `key moments: ${message}`,
      aiMetadataAttemptCount: nextOverallAttempt,
      aiMetadataRetryScheduled: shouldRetry,
    },
  });

  if (shouldRetry) {
    await scheduleAiMetadataRetry(ctx, {
      muxAssetId: args.muxAssetId,
      userId: args.userId,
      attempt: nextOverallAttempt,
    });
  }

  return {
    ok: false,
    skipped: false,
    error: message,
    retryScheduled: shouldRetry,
    nextAttempt: nextOverallAttempt,
  };
}

export const ensureAiMetadataForAssetInternal = internalAction({
  args: {
    muxAssetId: v.string(),
    defaultUserId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<EnsureAiMetadataResult> => {
    return await ensureAiMetadataForAssetImpl(ctx, args);
  },
});

export const ensureAiMetadataForAsset = action({
  args: {
    muxAssetId: v.string(),
  },
  handler: async (ctx, args): Promise<EnsureAiMetadataResult> => {
    return await ensureAiMetadataForAssetImpl(ctx, args);
  },
});

export const generateSummaryAndTagsForAssetInternal = internalAction({
  args: {
    muxAssetId: v.string(),
    userId: v.string(),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<GenerateSummaryAndTagsResult> => {
    const lock = (await ctx.runMutation((internal as any).aiMetadataLocks.claimAiMetadataLockInternal, {
      muxAssetId: args.muxAssetId,
      userId: args.userId,
    })) as AiMetadataLockResult;
    if (!lock.acquired) {
      return {
        ok: true,
        skipped: true,
        reason: "already_running",
        runningUserId: lock.userId,
        startedAtMs: lock.startedAtMs,
      };
    }

    try {
      const attempt = Math.max(0, Math.floor(args.attempt ?? 0));
      const video = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
        muxAssetId: args.muxAssetId,
        userId: args.userId,
      });

      if (!video || !video.asset) {
        return { ok: false, skipped: true, reason: "asset_not_found" };
      }

      const metadata = getMetadataRecord(video.metadata);
      const existingCustom = asCustomRecord(metadata.custom);
      const moderationCheckedAtMs = asFiniteNumber(existingCustom.moderationCheckedAtMs);
      const sourceCaptionsLanguageCode =
        asString(existingCustom.aiSourceLanguageCode) ??
        getSourceCaptionsLanguageCodeFromAsset(video.asset, asString(existingCustom.aiSourceLanguageCode));

      if (moderationCheckedAtMs === undefined) {
        return { ok: true, skipped: true, reason: "moderation_pending" };
      }

      if (existingCustom.moderationPassed !== true) {
        return { ok: true, skipped: true, reason: "moderation_rejected" };
      }

      const hasSummary = Boolean(existingCustom.aiGeneratedAtMs);
      const hasChapters = Boolean(existingCustom.aiChaptersGeneratedAtMs);
      const hasKeyMoments = Boolean(existingCustom.aiKeyMomentsGeneratedAtMs);
      const captionsRequested =
        Boolean(existingCustom.aiCaptionsRequestedAtMs) ||
        Boolean(existingCustom.aiCaptionsGeneratedAtMs);
      const captionsUnavailable = Boolean(existingCustom.aiCaptionsUnavailableReason);

      if (hasSummary && hasChapters && hasKeyMoments) {
        if (!existingCustom.embeddingsGeneratedAtMs) {
          await ctx.scheduler.runAfter(
            0,
            (internal as any).videoEmbeddingsNode.generateAssetEmbeddingsInternal,
            {
              muxAssetId: args.muxAssetId,
              userId: args.userId,
              attempt: 0,
            },
          );
        }
        return { ok: true, skipped: true, reason: "already_generated" };
      }

      if (isMuxRobotsPollingDisabled()) {
        return { ok: true, skipped: true, reason: "polling_disabled" };
      }

      const errors: string[] = [];
      const nextAttempt = attempt + 1;
      let summaryJobId = asString(existingCustom.aiSummaryJobId);
      let summaryJobStatus = hasSummary
        ? "completed"
        : asMuxRobotsJobStatus(existingCustom.aiSummaryJobStatus);
      let chaptersJobId = asString(existingCustom.aiChaptersJobId);
      let chaptersJobStatus = hasChapters
        ? "completed"
        : asMuxRobotsJobStatus(existingCustom.aiChaptersJobStatus);
      let keyMomentsJobId = asString(existingCustom.aiKeyMomentsJobId);
      let keyMomentsJobStatus = hasKeyMoments
        ? "completed"
        : asMuxRobotsJobStatus(existingCustom.aiKeyMomentsJobStatus);
      const shouldRetryForSourceCaptions =
        (!hasChapters || !hasKeyMoments) &&
        !sourceCaptionsLanguageCode &&
        captionsRequested &&
        !captionsUnavailable;

      if (!hasSummary) {
        try {
          const shouldCreateSummaryJob =
            !summaryJobId || summaryJobStatus === "errored" || summaryJobStatus === "cancelled";
          if (shouldCreateSummaryJob) {
            const createdJob = await createSummarizeJob({
              assetId: args.muxAssetId,
              tone: SUMMARIZE_TONE,
              titleLength: SUMMARIZE_TITLE_LENGTH,
              descriptionLength: SUMMARIZE_DESCRIPTION_LENGTH,
              tagCount: SUMMARIZE_TAG_COUNT,
              passthrough: JSON.stringify({
                muxAssetId: args.muxAssetId,
                userId: args.userId,
                tone: SUMMARIZE_TONE,
              }),
            });
            summaryJobId = requireMuxJobId("summarize", createdJob.id);
            summaryJobStatus = createdJob.status;
            await updateAiMetadataTrackingFields(ctx, args, metadata, {
              aiSummaryJobId: summaryJobId,
              aiSummaryJobStatus: summaryJobStatus,
            });

            if (isTerminalMuxRobotsJobStatus(createdJob.status)) {
              await applyAiMetadataJobUpdate(
                ctx,
                {
                  muxAssetId: args.muxAssetId,
                  userId: args.userId,
                  workflow: "summarize",
                },
                createdJob,
              );
            } else {
              await scheduleAiMetadataFallbackPoll(ctx, {
                muxAssetId: args.muxAssetId,
                userId: args.userId,
                workflow: "summarize",
                jobId: summaryJobId,
                attempt: 0,
              });
            }
          } else if (summaryJobId && isActiveMuxRobotsJobStatus(summaryJobStatus)) {
            await scheduleAiMetadataFallbackPoll(ctx, {
              muxAssetId: args.muxAssetId,
              userId: args.userId,
              workflow: "summarize",
              jobId: summaryJobId,
              attempt: 0,
            });
          }
        } catch (error) {
          errors.push(`summary: ${getErrorMessage(error)}`);
        }
      }

      if (!hasChapters && sourceCaptionsLanguageCode) {
        try {
          const shouldCreateChaptersJob =
            !chaptersJobId || chaptersJobStatus === "errored" || chaptersJobStatus === "cancelled";
          if (shouldCreateChaptersJob) {
            const createdJob = await createGenerateChaptersJob({
              assetId: args.muxAssetId,
              fromLanguageCode: sourceCaptionsLanguageCode,
              passthrough: JSON.stringify({
                muxAssetId: args.muxAssetId,
                userId: args.userId,
                fromLanguageCode: sourceCaptionsLanguageCode,
              }),
            });
            chaptersJobId = requireMuxJobId("generate-chapters", createdJob.id);
            chaptersJobStatus = createdJob.status;
            await updateAiMetadataTrackingFields(ctx, args, metadata, {
              aiChaptersJobId: chaptersJobId,
              aiChaptersJobStatus: chaptersJobStatus,
            });

            if (isTerminalMuxRobotsJobStatus(createdJob.status)) {
              await applyAiMetadataJobUpdate(
                ctx,
                {
                  muxAssetId: args.muxAssetId,
                  userId: args.userId,
                  workflow: "generate-chapters",
                },
                createdJob,
              );
            } else {
              await scheduleAiMetadataFallbackPoll(ctx, {
                muxAssetId: args.muxAssetId,
                userId: args.userId,
                workflow: "generate-chapters",
                jobId: chaptersJobId,
                attempt: 0,
              });
            }
          } else if (chaptersJobId && isActiveMuxRobotsJobStatus(chaptersJobStatus)) {
            await scheduleAiMetadataFallbackPoll(ctx, {
              muxAssetId: args.muxAssetId,
              userId: args.userId,
              workflow: "generate-chapters",
              jobId: chaptersJobId,
              attempt: 0,
            });
          }
        } catch (error) {
          errors.push(`chapters: ${getErrorMessage(error)}`);
        }
      }

      if (!hasKeyMoments && sourceCaptionsLanguageCode) {
        try {
          const shouldCreateKeyMomentsJob =
            !keyMomentsJobId ||
            keyMomentsJobStatus === "errored" ||
            keyMomentsJobStatus === "cancelled";
          if (shouldCreateKeyMomentsJob) {
            const createdJob = await createFindKeyMomentsJob({
              assetId: args.muxAssetId,
              maxMoments: FIND_KEY_MOMENTS_MAX_MOMENTS,
              passthrough: JSON.stringify({
                muxAssetId: args.muxAssetId,
                userId: args.userId,
                maxMoments: FIND_KEY_MOMENTS_MAX_MOMENTS,
              }),
            });
            keyMomentsJobId = requireMuxJobId("find-key-moments", createdJob.id);
            keyMomentsJobStatus = createdJob.status;
            await updateAiMetadataTrackingFields(ctx, args, metadata, {
              aiKeyMomentsJobId: keyMomentsJobId,
              aiKeyMomentsJobStatus: keyMomentsJobStatus,
            });

            if (isTerminalMuxRobotsJobStatus(createdJob.status)) {
              await applyAiMetadataJobUpdate(
                ctx,
                {
                  muxAssetId: args.muxAssetId,
                  userId: args.userId,
                  workflow: "find-key-moments",
                },
                createdJob,
              );
            } else {
              await scheduleAiMetadataFallbackPoll(ctx, {
                muxAssetId: args.muxAssetId,
                userId: args.userId,
                workflow: "find-key-moments",
                jobId: keyMomentsJobId,
                attempt: 0,
              });
            }
          } else if (keyMomentsJobId && isActiveMuxRobotsJobStatus(keyMomentsJobStatus)) {
            await scheduleAiMetadataFallbackPoll(ctx, {
              muxAssetId: args.muxAssetId,
              userId: args.userId,
              workflow: "find-key-moments",
              jobId: keyMomentsJobId,
              attempt: 0,
            });
          }
        } catch (error) {
          errors.push(`key moments: ${getErrorMessage(error)}`);
        }
      }

      const shouldRetry =
        (errors.length > 0 || shouldRetryForSourceCaptions) && nextAttempt < MAX_ATTEMPTS;

      await upsertAiMetadataFields(ctx, args, {
        custom: {
          ...(!hasChapters && captionsUnavailable && existingCustom.aiCaptionsUnavailableReason
            ? {
                aiChaptersUnavailableReason: String(existingCustom.aiCaptionsUnavailableReason),
              }
            : {}),
          ...(!hasKeyMoments && captionsUnavailable && existingCustom.aiCaptionsUnavailableReason
            ? {
                aiKeyMomentsUnavailableReason: String(existingCustom.aiCaptionsUnavailableReason),
              }
            : {}),
          ...(errors.length > 0 || shouldRetryForSourceCaptions
            ? {
                aiMetadataFailedAtMs: Date.now(),
                aiMetadataLastError:
                  errors.length > 0
                    ? errors.join(" | ")
                    : "Waiting for source captions before chapter and key moment generation.",
                aiMetadataAttemptCount: nextAttempt,
                aiMetadataRetryScheduled: shouldRetry,
              }
            : {
                aiMetadataRetryScheduled: false,
              }),
        },
      });

      if (shouldRetry) {
        if (errors.length === 0 && shouldRetryForSourceCaptions) {
          await ctx.scheduler.runAfter(
            AI_METADATA_SOURCE_CAPTIONS_RETRY_DELAY_MS,
            (internal as any).aiMetadata.generateSummaryAndTagsForAssetInternal,
            {
              muxAssetId: args.muxAssetId,
              userId: args.userId,
              attempt: nextAttempt,
            },
          );
        } else {
          await scheduleAiMetadataRetry(ctx, {
            muxAssetId: args.muxAssetId,
            userId: args.userId,
            attempt: nextAttempt,
          });
        }
      }

      await maybeScheduleEmbeddings(ctx, args);

      return {
        ok: errors.length === 0,
        skipped: false,
        retryScheduled: shouldRetry,
        nextAttempt,
        errors,
      };
    } finally {
      await ctx.runMutation((internal as any).aiMetadataLocks.releaseAiMetadataLockInternal, {
        muxAssetId: args.muxAssetId,
      });
    }
  },
});

export const syncAiMetadataJobInternal = internalAction({
  args: {
    muxAssetId: v.string(),
    userId: v.string(),
    workflow: v.union(
      v.literal("summarize"),
      v.literal("generate-chapters"),
      v.literal("find-key-moments"),
    ),
    job: v.any(),
  },
  handler: async (ctx, args) => {
    return await applyAiMetadataJobUpdate(
      ctx,
      {
        muxAssetId: args.muxAssetId,
        userId: args.userId,
        workflow: args.workflow,
      },
      args.job as SummarizeJob | GenerateChaptersJob | FindKeyMomentsJob,
    );
  },
});

export const pollAiMetadataJobStatusInternal = internalAction({
  args: {
    muxAssetId: v.string(),
    userId: v.string(),
    workflow: v.union(
      v.literal("summarize"),
      v.literal("generate-chapters"),
      v.literal("find-key-moments"),
    ),
    jobId: v.string(),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (isMuxRobotsPollingDisabled()) {
      return { ok: false, skipped: true, reason: "polling_disabled" };
    }

    const attempt = Math.max(0, Math.floor(args.attempt ?? 0));
    const video = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
      muxAssetId: args.muxAssetId,
      userId: args.userId,
    });
    const metadata = getMetadataRecord(video?.metadata);
    const custom = asCustomRecord(metadata.custom);
    const currentJobId = getAiMetadataJobId(custom, args.workflow);
    const currentJobStatus = getAiMetadataJobStatus(custom, args.workflow);

    if (currentJobId !== args.jobId) {
      return { ok: false, skipped: true, reason: "job_missing_or_replaced" };
    }

    if (!isActiveMuxRobotsJobStatus(currentJobStatus)) {
      return { ok: true, skipped: true, reason: "already_terminal" };
    }

    try {
      const job =
        args.workflow === "summarize"
          ? await waitForSummarizeCompletion(args.jobId)
          : args.workflow === "generate-chapters"
            ? await waitForGenerateChaptersCompletion(args.jobId)
            : await waitForFindKeyMomentsCompletion(args.jobId);

      return await applyAiMetadataJobUpdate(ctx, args, job);
    } catch (error) {
      const message = getErrorMessage(error);
      const nextAttempt = attempt + 1;
      const retryable = error instanceof MuxJobLookupError ? error.retryable : true;

      if (retryable && nextAttempt < MAX_ATTEMPTS) {
        await scheduleAiMetadataFallbackPoll(ctx, {
          muxAssetId: args.muxAssetId,
          userId: args.userId,
          workflow: args.workflow,
          jobId: args.jobId,
          attempt: nextAttempt,
        });
        return { ok: false, skipped: false, retryScheduled: true };
      }

      const overallAttempt = (asFiniteNumber(custom.aiMetadataAttemptCount) ?? 0) + 1;
      const shouldRetry = overallAttempt < MAX_ATTEMPTS;

      await upsertAiMetadataFields(ctx, args, {
        custom: {
          aiMetadataFailedAtMs: Date.now(),
          aiMetadataLastError: `${args.workflow}: ${message}`,
          aiMetadataAttemptCount: overallAttempt,
          aiMetadataRetryScheduled: shouldRetry,
        },
      });

      if (shouldRetry) {
        await scheduleAiMetadataRetry(ctx, {
          muxAssetId: args.muxAssetId,
          userId: args.userId,
          attempt: overallAttempt,
        });
      }

      return {
        ok: false,
        skipped: false,
        error: message,
        retryScheduled: shouldRetry,
        nextAttempt: overallAttempt,
      };
    }
  },
});
