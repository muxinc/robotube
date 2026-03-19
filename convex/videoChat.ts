import { getAuthUserId } from "@convex-dev/auth/server";
import { createThread, listUIMessages, saveMessage } from "@convex-dev/agent";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";

import { api, components, internal } from "./_generated/api";
import {
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";

async function requireAuthUserId(ctx: QueryCtx | MutationCtx) {
  const authUserId = await getAuthUserId(ctx);
  if (!authUserId) {
    throw new Error("You must be signed in to use video chat.");
  }
  return authUserId;
}

async function getVideoContext(ctx: QueryCtx | MutationCtx, muxAssetId: string) {
  const video = await ctx.runQuery((api as any).feed.getFeedVideoByMuxAssetId, {
    muxAssetId,
  });

  if (!video) {
    throw new Error("Video not found for chat.");
  }

  return video;
}

async function getAuthorizedVideoThreadByThreadId(ctx: QueryCtx | MutationCtx, threadId: string) {
  const authUserId = await requireAuthUserId(ctx);
  const thread = await ctx.db
    .query("videoChatThreads")
    .withIndex("by_thread", (q) => q.eq("threadId", threadId))
    .unique();

  if (!thread || thread.userId !== authUserId) {
    throw new Error("Chat thread not found.");
  }

  return thread;
}

export const getThreadForVideo = query({
  args: { muxAssetId: v.string() },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      return null;
    }

    const existing = await ctx.db
      .query("videoChatThreads")
      .withIndex("by_user_video", (q) =>
        q.eq("userId", authUserId).eq("muxAssetId", args.muxAssetId),
      )
      .unique();

    return existing?.threadId ?? null;
  },
});

export const ensureThreadForVideo = mutation({
  args: { muxAssetId: v.string() },
  handler: async (ctx, args) => {
    const authUserId = await requireAuthUserId(ctx);
    const existing = await ctx.db
      .query("videoChatThreads")
      .withIndex("by_user_video", (q) =>
        q.eq("userId", authUserId).eq("muxAssetId", args.muxAssetId),
      )
      .unique();

    if (existing) {
      return { threadId: existing.threadId };
    }

    const video = await getVideoContext(ctx, args.muxAssetId);
    const threadId = await createThread(ctx, (components as any).agent, {
      userId: authUserId,
      title: `Video chat: ${video.title}`,
      summary: `Robotube assistant chat for video ${video.muxAssetId}`,
    });

    await ctx.db.insert("videoChatThreads", {
      userId: authUserId,
      muxAssetId: args.muxAssetId,
      threadId,
      createdAtMs: Date.now(),
    });

    return { threadId };
  },
});

export const listThreadMessages = query({
  args: {
    threadId: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await getAuthorizedVideoThreadByThreadId(ctx, args.threadId);
    return await listUIMessages(ctx, (components as any).agent, {
      threadId: args.threadId,
      paginationOpts: args.paginationOpts,
    });
  },
});

export const sendMessage = mutation({
  args: {
    threadId: v.string(),
    prompt: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserId = await requireAuthUserId(ctx);
    const thread = await getAuthorizedVideoThreadByThreadId(ctx, args.threadId);
    const prompt = args.prompt.trim();

    if (!prompt) {
      throw new Error("Message cannot be empty.");
    }

    const { messageId } = await saveMessage(ctx, (components as any).agent, {
      threadId: args.threadId,
      prompt,
      userId: authUserId,
    });

    await ctx.scheduler.runAfter(0, (internal as any).videoChatNode.generateResponseAsync, {
      threadId: args.threadId,
      muxAssetId: thread.muxAssetId,
      promptMessageId: messageId,
    });

    return { ok: true };
  },
});

export const getThreadRecordByThreadIdInternal = internalQuery({
  args: { threadId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("videoChatThreads")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .unique();
  },
});
