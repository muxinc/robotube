"use node";

import Mux from "@mux/mux-node";
import { StreamOutput, StreamProtocol } from "@livekit/protocol";
import { getAuthUserId } from "@convex-dev/auth/server";
import { AccessToken, EgressClient, RoomServiceClient } from "livekit-server-sdk";
import { v } from "convex/values";

import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action } from "./_generated/server";

type CreateLiveStreamResult = {
  liveStreamDocId: Id<"liveStreams">;
  muxLiveStreamId: string;
  playbackId: string | null;
  livekitUrl: string;
  livekitToken: string;
  livekitRoomName: string;
  broadcasterIdentity: string;
};

type StoredLiveStream = {
  userId: Id<"users">;
  muxLiveStreamId: string;
  livekitRoomName: string;
  broadcasterIdentity: string;
  livekitEgressId?: string;
  streamKey: string;
};

function requiredEnv(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function getLiveKitHost(): string {
  const explicitHost = process.env.LIVEKIT_HOST;
  if (explicitHost) return explicitHost;

  const clientUrl = requiredEnv(
    "EXPO_PUBLIC_LIVEKIT_URL",
    process.env.EXPO_PUBLIC_LIVEKIT_URL,
  );
  if (clientUrl.startsWith("wss://")) {
    return `https://${clientUrl.slice("wss://".length)}`;
  }
  if (clientUrl.startsWith("ws://")) {
    return `http://${clientUrl.slice("ws://".length)}`;
  }
  return clientUrl;
}

function getLiveKitWebSocketUrl(): string {
  const explicitUrl = process.env.LIVEKIT_URL ?? process.env.EXPO_PUBLIC_LIVEKIT_URL;
  if (explicitUrl) return explicitUrl;

  const host = getLiveKitHost();
  if (host.startsWith("https://")) {
    return `wss://${host.slice("https://".length)}`;
  }
  if (host.startsWith("http://")) {
    return `ws://${host.slice("http://".length)}`;
  }
  return host;
}

function getLiveKitApiKey(): string {
  return requiredEnv("LIVEKIT_API_KEY", process.env.LIVEKIT_API_KEY);
}

function getLiveKitApiSecret(): string {
  return requiredEnv("LIVEKIT_API_SECRET", process.env.LIVEKIT_API_SECRET);
}

function createMuxClient() {
  return new Mux({
    tokenId: requiredEnv("MUX_TOKEN_ID", process.env.MUX_TOKEN_ID),
    tokenSecret: requiredEnv("MUX_TOKEN_SECRET", process.env.MUX_TOKEN_SECRET),
  });
}

function createRoomServiceClient() {
  return new RoomServiceClient(
    getLiveKitHost(),
    getLiveKitApiKey(),
    getLiveKitApiSecret(),
  );
}

function createEgressClient() {
  return new EgressClient(
    getLiveKitHost(),
    getLiveKitApiKey(),
    getLiveKitApiSecret(),
  );
}

async function createBroadcasterToken(
  roomName: string,
  identity: string,
): Promise<string> {
  const token = new AccessToken(getLiveKitApiKey(), getLiveKitApiSecret(), {
    identity,
    name: "Robotube Broadcaster",
    ttl: "2h",
  });

  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: false,
    canPublishData: false,
  });

  return await token.toJwt();
}

async function getStoredLiveStream(
  ctx: any,
  muxLiveStreamId: string,
): Promise<StoredLiveStream | null> {
  return await ctx.runQuery(
    (internal as any).liveStreamQueries.getLiveStreamByMuxIdInternal,
    { muxLiveStreamId },
  );
}

export const createLiveStream = action({
  args: {
    title: v.string(),
  },
  handler: async (ctx, args): Promise<CreateLiveStreamResult> => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("You must be signed in to start a live stream.");
    }

    const mux = createMuxClient();
    const roomClient = createRoomServiceClient();
    const createdAtMs = Date.now();
    const livekitRoomName = `robotube-live-${authUserId}-${createdAtMs}`;
    const broadcasterIdentity = `host-${authUserId}`;

    const liveStream = await mux.video.liveStreams.create({
      playback_policies: ["public"],
      new_asset_settings: {
        playback_policies: ["public"],
      },
      latency_mode: "low",
    });

    const streamKey = liveStream.stream_key;
    const playbackId = liveStream.playback_ids?.[0]?.id;
    const muxLiveStreamId = liveStream.id;

    if (!streamKey || !muxLiveStreamId) {
      throw new Error("Failed to create live stream: missing stream key or ID.");
    }

    await roomClient.createRoom({
      name: livekitRoomName,
      emptyTimeout: 10 * 60,
      departureTimeout: 30,
      maxParticipants: 8,
      metadata: JSON.stringify({ muxLiveStreamId, title: args.title.trim() || "Untitled Stream" }),
    });

    const livekitToken = await createBroadcasterToken(
      livekitRoomName,
      broadcasterIdentity,
    );

    await ctx.runMutation(components.mux.sync.upsertLiveStreamFromPayloadPublic, {
      liveStream: liveStream as unknown as Record<string, unknown>,
    });

    const docId: Id<"liveStreams"> = await ctx.runMutation(
      (internal as any).liveStreamMutations.insertLiveStreamInternal,
      {
        userId: authUserId,
        title: args.title.trim() || "Untitled Stream",
        muxLiveStreamId,
        livekitRoomName,
        broadcasterIdentity,
        streamKey,
        playbackId: playbackId ?? undefined,
        status: "idle" as const,
        createdAtMs,
      },
    );

    return {
      liveStreamDocId: docId,
      muxLiveStreamId,
      playbackId: playbackId ?? null,
      livekitUrl: getLiveKitWebSocketUrl(),
      livekitToken,
      livekitRoomName,
      broadcasterIdentity,
    };
  },
});

export const startLiveStreamEgress = action({
  args: {
    muxLiveStreamId: v.string(),
  },
  handler: async (ctx, args): Promise<{ ok: true; egressId: string }> => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("You must be signed in to start a live stream.");
    }

    const stream = await getStoredLiveStream(ctx, args.muxLiveStreamId);
    if (!stream) {
      throw new Error("Live stream not found.");
    }
    if (stream.userId !== authUserId) {
      throw new Error("You can only start your own live stream.");
    }
    if (stream.livekitEgressId) {
      return { ok: true, egressId: stream.livekitEgressId };
    }

    const egressClient = createEgressClient();
    const rtmpOutputUrl = `rtmp://global-live.mux.com:5222/app/${stream.streamKey}`;
    const egress = await egressClient.startParticipantEgress(
      stream.livekitRoomName,
      stream.broadcasterIdentity,
      {
        stream: new StreamOutput({
          protocol: StreamProtocol.RTMP,
          urls: [rtmpOutputUrl],
        }),
      },
    );

    await ctx.runMutation((internal as any).liveStreamMutations.patchLiveStreamInternal, {
      muxLiveStreamId: args.muxLiveStreamId,
      livekitEgressId: egress.egressId,
    });

    return { ok: true, egressId: egress.egressId };
  },
});

export const endLiveStream = action({
  args: {
    muxLiveStreamId: v.string(),
  },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("You must be signed in to end a live stream.");
    }

    const stream = await getStoredLiveStream(ctx, args.muxLiveStreamId);
    if (!stream) {
      throw new Error("Live stream not found.");
    }
    if (stream.userId !== authUserId) {
      throw new Error("You can only end your own live stream.");
    }

    const egressClient = createEgressClient();
    const roomClient = createRoomServiceClient();
    const mux = createMuxClient();

    if (stream.livekitEgressId) {
      try {
        await egressClient.stopEgress(stream.livekitEgressId);
      } catch (error) {
        console.warn("Failed to stop LiveKit egress", error);
      }
    }

    try {
      await mux.video.liveStreams.complete(args.muxLiveStreamId);
    } catch (error) {
      console.warn("Failed to complete Mux live stream", error);
    }

    try {
      await roomClient.deleteRoom(stream.livekitRoomName);
    } catch (error) {
      console.warn("Failed to delete LiveKit room", error);
    }

    await ctx.runMutation((internal as any).liveStreamMutations.patchLiveStreamInternal, {
      muxLiveStreamId: args.muxLiveStreamId,
      status: "idle" as const,
      endedAtMs: Date.now(),
    });

    return { ok: true };
  },
});
