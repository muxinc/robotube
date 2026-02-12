/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as feed from "../feed.js";
import type * as http from "../http.js";
import type * as migrations from "../migrations.js";
import type * as muxWebhook from "../muxWebhook.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  feed: typeof feed;
  http: typeof http;
  migrations: typeof migrations;
  muxWebhook: typeof muxWebhook;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  mux: {
    catalog: {
      getAssetByMuxId: FunctionReference<
        "query",
        "internal",
        { muxAssetId: string },
        any
      >;
      getLiveStreamByMuxId: FunctionReference<
        "query",
        "internal",
        { muxLiveStreamId: string },
        any
      >;
      getUploadByMuxId: FunctionReference<
        "query",
        "internal",
        { muxUploadId: string },
        any
      >;
      listAssets: FunctionReference<
        "query",
        "internal",
        { limit?: number },
        any
      >;
      listLiveStreams: FunctionReference<
        "query",
        "internal",
        { limit?: number },
        any
      >;
      listRecentEvents: FunctionReference<
        "query",
        "internal",
        { limit?: number },
        any
      >;
      listUploads: FunctionReference<
        "query",
        "internal",
        { limit?: number },
        any
      >;
    };
    sync: {
      markAssetDeletedPublic: FunctionReference<
        "mutation",
        "internal",
        { muxAssetId: string },
        any
      >;
      markLiveStreamDeletedPublic: FunctionReference<
        "mutation",
        "internal",
        { muxLiveStreamId: string },
        any
      >;
      markUploadDeletedPublic: FunctionReference<
        "mutation",
        "internal",
        { muxUploadId: string },
        any
      >;
      recordWebhookEventPublic: FunctionReference<
        "mutation",
        "internal",
        { event: Record<string, any>; verified: boolean },
        any
      >;
      upsertAssetFromPayloadPublic: FunctionReference<
        "mutation",
        "internal",
        { asset: Record<string, any> },
        any
      >;
      upsertLiveStreamFromPayloadPublic: FunctionReference<
        "mutation",
        "internal",
        { liveStream: Record<string, any> },
        any
      >;
      upsertUploadFromPayloadPublic: FunctionReference<
        "mutation",
        "internal",
        { upload: Record<string, any> },
        any
      >;
    };
    videos: {
      getVideoByMuxAssetId: FunctionReference<
        "query",
        "internal",
        { muxAssetId: string; userId?: string },
        any
      >;
      listVideosForUser: FunctionReference<
        "query",
        "internal",
        { limit?: number; userId: string },
        any
      >;
      upsertVideoMetadata: FunctionReference<
        "mutation",
        "internal",
        {
          custom?: Record<string, any>;
          description?: string;
          muxAssetId: string;
          tags?: Array<string>;
          title?: string;
          userId: string;
          visibility?: "private" | "unlisted" | "public";
        },
        any
      >;
    };
  };
};
