"use node";

import Mux from "@mux/mux-node";
import { internalAction } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { v } from "convex/values";

import { normalizeAudioTranslationLanguageCodes } from "../constants/audio-translation-languages";

const AUDIO_TRANSLATION_READY_DELAY_MS = 5 * 1000;

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
} {
  const raw = asString(passthrough);
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    const parsedObj = asRecord(parsed);
    if (!parsedObj) return { userId: raw };

    return {
      userId: asString(parsedObj.userId) ?? asString(parsedObj.user_id),
      title: asString(parsedObj.title),
      description: asString(parsedObj.description),
      tags: asStringArray(parsedObj.tags),
      visibility: asVisibility(parsedObj.visibility),
      custom: asRecord(parsedObj.custom),
      audioTranslationLanguageCodes: normalizeAudioTranslationLanguageCodes(
        asStringArray(asRecord(parsedObj.custom)?.audioTranslationLanguageCodes) ?? [],
      ),
    };
  } catch {
    return { userId: raw };
  }
}

function parseRobotsPassthrough(passthrough: unknown): Record<string, unknown> {
  if (passthrough && typeof passthrough === "object" && !Array.isArray(passthrough)) {
    return asRecord(passthrough) ?? {};
  }

  const raw = asString(passthrough);
  if (!raw) {
    return {};
  }

  try {
    return asRecord(JSON.parse(raw)) ?? {};
  } catch {
    return {};
  }
}

function getRobotsWorkflow(eventType: string, data: Record<string, unknown>) {
  const workflow = asString(data.workflow);
  if (workflow) {
    return workflow;
  }

  const parts = eventType.split(".");
  if (parts.length < 4) {
    return undefined;
  }

  return parts[2]?.replace(/_/g, "-");
}

function getRobotsAssetId(args: {
  data: Record<string, unknown>;
  parameters: Record<string, unknown>;
  resources: Record<string, unknown>;
  passthrough: Record<string, unknown>;
}) {
  return (
    asString(args.parameters.mux_asset_id) ??
    asString(args.parameters.asset_id) ??
    asString(args.data.asset_id) ??
    asString(args.resources.mux_asset_id) ??
    asString(args.resources.asset_id) ??
    asString(args.passthrough.muxAssetId) ??
    asString(args.passthrough.mux_asset_id)
  );
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
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

export const ingestMuxWebhook = internalAction({
  args: {
    rawBody: v.string(),
    headers: v.record(v.string(), v.string()),
  },
  handler: async (ctx, args) => {
    const mux = new Mux({
      webhookSecret: requiredEnv(
        "MUX_WEBHOOK_SECRET",
        process.env.MUX_WEBHOOK_SECRET
      ),
    });
    const event = mux.webhooks.unwrap(
      args.rawBody,
      normalizeHeaders(args.headers)
    ) as unknown as Record<string, unknown>;

    await ctx.runMutation(components.mux.sync.recordWebhookEventPublic, {
      event,
      verified: true,
    });

    const eventType = asString(event.type) ?? "";
    const data = asRecord(event.data);
    const objectId = asString(data?.id);

    if (!objectId || !data) {
      return { skipped: true, reason: "missing_data" };
    }

    if (eventType.startsWith("robots.job.")) {
      const workflow = getRobotsWorkflow(eventType, data);
      const passthrough = parseRobotsPassthrough(data.passthrough);
      const parameters = asRecord(data.parameters) ?? {};
      const resources = asRecord(data.resources) ?? {};
      const muxAssetId = getRobotsAssetId({
        data,
        parameters,
        resources,
        passthrough,
      });
      const userId = asString(passthrough.userId) ?? asString(passthrough.user_id);
      const languageCode =
        asString(passthrough.languageCode) ??
        asString(passthrough.language_code) ??
        asString(parameters.to_language_code);

      if (workflow === "moderate") {
        if (!muxAssetId || !userId) {
          return { skipped: true, reason: "missing_robot_job_context" };
        }

        await ctx.scheduler.runAfter(0, (internal as any).moderation.syncModerationJobInternal, {
          muxAssetId,
          userId,
          job: data,
        });
        return { skipped: false, reason: "robots_moderate_event" };
      }

      if (
        workflow === "summarize" ||
        workflow === "generate-chapters" ||
        workflow === "find-key-moments"
      ) {
        if (!muxAssetId || !userId) {
          return { skipped: true, reason: "missing_robot_job_context" };
        }

        await ctx.scheduler.runAfter(0, (internal as any).aiMetadata.syncAiMetadataJobInternal, {
          muxAssetId,
          userId,
          workflow,
          job: data,
        });
        return { skipped: false, reason: "robots_ai_metadata_event" };
      }

      if (workflow === "translate-captions") {
        if (!muxAssetId || !languageCode) {
          return { skipped: true, reason: "missing_robot_translation_context" };
        }

        await ctx.scheduler.runAfter(
          0,
          (internal as any).captionTranslationsNode.syncCaptionTranslationJobInternal,
          {
            muxAssetId,
            languageCode,
            job: data,
          },
        );
        return { skipped: false, reason: "robots_caption_translation_event" };
      }

      if (workflow === "translate-audio") {
        if (!muxAssetId || !languageCode) {
          return { skipped: true, reason: "missing_robot_translation_context" };
        }

        await ctx.scheduler.runAfter(
          0,
          (internal as any).audioTranslationsNode.syncAudioTranslationJobInternal,
          {
            muxAssetId,
            languageCode,
            job: data,
          },
        );
        return { skipped: false, reason: "robots_audio_translation_event" };
      }

      return { skipped: true, reason: "unsupported_robots_workflow" };
    }

    if (eventType.startsWith("video.asset.static_rendition.")) {
      const assetId = asString(data.asset_id) ?? asString(data.assetId);
      if (!assetId) {
        return { skipped: true, reason: "missing_asset_id" };
      }

      if (eventType === "video.asset.static_rendition.ready") {
        const resolution = asString(data.resolution) ?? asString(data.resolution_tier);
        const name = asString(data.name);
        const isAudioOnlyRendition =
          resolution === "audio-only" || name === "audio.m4a";

        if (!isAudioOnlyRendition) {
          return { skipped: false, reason: "non_audio_static_rendition" };
        }

        const video = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
          muxAssetId: assetId,
        });
        const metadata = asRecord((video as any)?.metadata);
        const custom = asRecord(metadata?.custom);
        const languageCodes = normalizeAudioTranslationLanguageCodes(
          asStringArray(custom?.audioTranslationLanguageCodes) ?? [],
        );
        const userId = asString(metadata?.userId) ?? "default";
        const title = asString(metadata?.title);

        if (languageCodes.length === 0) {
          return { skipped: false, reason: "no_audio_translation_languages" };
        }

        await ctx.scheduler.runAfter(
          AUDIO_TRANSLATION_READY_DELAY_MS,
          (internal as any).audioTranslationsNode.ensureAudioTranslationsForAssetInternal,
          {
            muxAssetId: assetId,
            userId,
            languageCodes,
            title,
            attempt: 0,
          },
        );
      }

      return { skipped: false };
    }

    if (eventType.startsWith("video.asset.track.")) {
      return { skipped: false, reason: "asset_track_event" };
    }

    if (eventType.startsWith("video.asset.")) {
      if (eventType.endsWith(".deleted")) {
        await ctx.runMutation(components.mux.sync.markAssetDeletedPublic, {
          muxAssetId: objectId,
        });
        await ctx.runMutation((internal as any).muxAssetCache.markDeletedInternal, {
          muxAssetId: objectId,
        });
      } else {
        await ctx.runMutation(components.mux.sync.upsertAssetFromPayloadPublic, {
          asset: data,
        });
        await ctx.runMutation((internal as any).muxAssetCache.upsertFromPayloadInternal, {
          asset: data,
        });

        const metadata = parseMetadataPassthrough(data.passthrough);
        const userId = metadata.userId ?? "default";
        const existingVideo = await ctx.runQuery(components.mux.videos.getVideoByMuxAssetId, {
          muxAssetId: objectId,
          userId,
        });
        const existingMetadata = asRecord((existingVideo as any)?.metadata) ?? {};
        const existingCustom = asRecord(existingMetadata.custom) ?? {};
        await ctx.runMutation(
          components.mux.videos.upsertVideoMetadata,
          buildMetadataArgs({
            muxAssetId: objectId,
            userId,
            title: asString(existingMetadata.title) ?? metadata.title,
            description: asString(existingMetadata.description) ?? metadata.description,
            tags: asStringArray(existingMetadata.tags) ?? metadata.tags,
            visibility: asVisibility(existingMetadata.visibility) ?? metadata.visibility,
            custom: {
              ...(metadata.custom ?? {}),
              ...existingCustom,
            },
          })
        );

      }
      return { skipped: false };
    }

    if (eventType.startsWith("video.live_stream.")) {
      if (eventType.endsWith(".deleted")) {
        await ctx.runMutation(components.mux.sync.markLiveStreamDeletedPublic, {
          muxLiveStreamId: objectId,
        });
      } else {
        await ctx.runMutation(
          components.mux.sync.upsertLiveStreamFromPayloadPublic,
          {
            liveStream: data,
          }
        );
      }
      return { skipped: false };
    }

    if (eventType.startsWith("video.upload.")) {
      if (eventType.endsWith(".deleted")) {
        await ctx.runMutation(components.mux.sync.markUploadDeletedPublic, {
          muxUploadId: objectId,
        });
      } else {
        await ctx.runMutation(components.mux.sync.upsertUploadFromPayloadPublic, {
          upload: data,
        });
      }
      return { skipped: false };
    }

    return { skipped: true, reason: "unsupported_event" };
  },
});
