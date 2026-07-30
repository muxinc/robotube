/**
 * The single choke point for video-metadata writes.
 *
 * This module intentionally registers no Convex functions so it can be imported
 * from `"use node"` action files as well as from mutations.
 */

import { components, internal } from "./_generated/api";
import { asNonEmptyString, readChannelNameOverride } from "./feedContracts";

export type VideoMetadataUpsertArgs = {
  muxAssetId: string;
  userId: string;
  title?: string;
  description?: string;
  tags?: string[];
  visibility?: "private" | "unlisted" | "public";
  custom?: Record<string, unknown>;
};

/**
 * Writes video metadata to the Mux component and keeps the feed read model on
 * `muxAssetCache` in step, so the paginated feed query never needs a per-video
 * component subquery to render a card.
 *
 * Mirrors the component's "only write what was provided" semantics: a metadata
 * write without a title must not clobber the denormalized title.
 *
 * Works from both mutation and action contexts; in a mutation the read-model
 * write joins the same transaction.
 */
export async function upsertVideoMetadataAndSyncFeedReadModel(
  ctx: any,
  args: VideoMetadataUpsertArgs,
) {
  const result = await ctx.runMutation(
    components.mux.videos.upsertVideoMetadata,
    args,
  );

  await ctx.runMutation(
    (internal as any).feedReadModel.applyVideoMetadataInternal,
    {
      muxAssetId: args.muxAssetId,
      uploaderUserId: asNonEmptyString(args.userId) ?? undefined,
      title: asNonEmptyString(args.title) ?? undefined,
      channelName: readChannelNameOverride(args.custom),
      applyChannelName: args.custom !== undefined,
    },
  );

  return result;
}
