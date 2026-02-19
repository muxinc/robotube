"use node";

import Mux from "@mux/mux-node";
import { internalAction } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { v } from "convex/values";

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
    };
  } catch {
    return { userId: raw };
  }
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

    if (eventType.startsWith("video.asset.")) {
      if (eventType.endsWith(".deleted")) {
        await ctx.runMutation(components.mux.sync.markAssetDeletedPublic, {
          muxAssetId: objectId,
        });
      } else {
        await ctx.runMutation(components.mux.sync.upsertAssetFromPayloadPublic, {
          asset: data,
        });

        const metadata = parseMetadataPassthrough(data.passthrough);
        const userId = metadata.userId ?? "default";
        await ctx.runMutation(
          components.mux.videos.upsertVideoMetadata,
          buildMetadataArgs({
            muxAssetId: objectId,
            userId,
            title: metadata.title,
            description: metadata.description,
            tags: metadata.tags,
            visibility: metadata.visibility,
            custom: metadata.custom,
          })
        );

        if (asString(data.status) === "ready") {
          await ctx.scheduler.runAfter(
            0,
            (internal as any).captions.ensureGeneratedCaptionsTrackInternal,
            {
              muxAssetId: objectId,
              userId,
              attempt: 0,
            },
          );

          await ctx.scheduler.runAfter(
            5 * 1000,
            (internal as any).aiMetadata.generateSummaryAndTagsForAssetInternal,
            {
              muxAssetId: objectId,
              userId,
              attempt: 0,
            },
          );

          await ctx.scheduler.runAfter(
            0,
            (internal as any).moderation.moderateAssetInternal,
            {
              muxAssetId: objectId,
              userId,
              attempt: 0,
            },
          );
        }
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
