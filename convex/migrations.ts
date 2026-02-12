"use node";

import Mux from "@mux/mux-node";
import { action } from "./_generated/server";
import { components } from "./_generated/api";
import { v } from "convex/values";

function requiredEnv(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function createMuxClient() {
  return new Mux({
    tokenId: requiredEnv(process.env.MUX_TOKEN_ID, "MUX_TOKEN_ID"),
    tokenSecret: requiredEnv(process.env.MUX_TOKEN_SECRET, "MUX_TOKEN_SECRET"),
  });
}

export const backfillMux = action({
  args: {
    maxAssets: v.optional(v.number()),
    defaultUserId: v.optional(v.string()),
    includeVideoMetadata: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const mux = createMuxClient();

    const maxAssets = Math.max(1, Math.floor(args.maxAssets ?? 200));
    const includeVideoMetadata = args.includeVideoMetadata ?? true;

    let scanned = 0;
    let syncedAssets = 0;
    let metadataUpserts = 0;
    let missingUserId = 0;

    for await (const asset of mux.video.assets.list({ limit: 100 })) {
      if (scanned >= maxAssets) break;
      scanned += 1;
      if (!asset.id) continue;

      await ctx.runMutation(components.mux.sync.upsertAssetFromPayloadPublic, {
        asset: asset as unknown as Record<string, unknown>,
      });
      syncedAssets += 1;

      if (!includeVideoMetadata) continue;
      const userId = asset.passthrough ?? args.defaultUserId;
      if (!userId) {
        missingUserId += 1;
        continue;
      }

      await ctx.runMutation(components.mux.videos.upsertVideoMetadata, {
        muxAssetId: asset.id,
        userId,
      });
      metadataUpserts += 1;
    }

    return { scanned, syncedAssets, metadataUpserts, missingUserId };
  },
});

export const createMuxDirectUpload = action({
  args: {
    userId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const mux = createMuxClient();

    const upload = await mux.video.uploads.create({
      cors_origin: "*",
      new_asset_settings: {
        playback_policies: ["public"],
        passthrough: args.userId ?? "mobile-user",
      },
    });

    await ctx.runMutation(components.mux.sync.upsertUploadFromPayloadPublic, {
      upload: upload as unknown as Record<string, unknown>,
    });

    return {
      uploadId: upload.id,
      uploadUrl: upload.url,
      status: upload.status,
    };
  },
});
