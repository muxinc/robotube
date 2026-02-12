"use node";

import Mux from "@mux/mux-node";
import { internalAction } from "./_generated/server";
import { components } from "./_generated/api";
import { v } from "convex/values";

function requiredEnv(value: string | undefined, name: string): string {
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

function normalizeHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
}

export const ingestMuxWebhook = internalAction({
  args: {
    rawBody: v.string(),
    headers: v.record(v.string(), v.string()),
  },
  handler: async (ctx, args) => {
    const mux = new Mux({
      webhookSecret: requiredEnv(
        process.env.MUX_WEBHOOK_SECRET,
        "MUX_WEBHOOK_SECRET",
      ),
    });
    const event = mux.webhooks.unwrap(
      args.rawBody,
      normalizeHeaders(args.headers),
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
        await ctx.runMutation(
          components.mux.sync.upsertAssetFromPayloadPublic,
          {
            asset: data,
          },
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
          },
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
        await ctx.runMutation(
          components.mux.sync.upsertUploadFromPayloadPublic,
          {
            upload: data,
          },
        );
      }
      return { skipped: false };
    }

    return { skipped: true, reason: "unsupported_event" };
  },
});
