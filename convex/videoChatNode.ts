"use node";

import { Agent } from "@convex-dev/agent";
import { openai } from "@ai-sdk/openai";
import { v } from "convex/values";

import { api, components, internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

type VideoContext = {
  muxAssetId: string;
  title: string;
  summary: string | null;
  tags: string[];
  chapters: { title: string; startTime: number }[];
  channelName: string;
};

function formatChapterList(chapters: VideoContext["chapters"]) {
  if (chapters.length === 0) return "No chapter list is available yet.";
  return chapters
    .map((chapter) => `- ${chapter.title} (${chapter.startTime}s)`)
    .join("\n");
}

function buildVideoAgent(video: VideoContext) {
  return new Agent((components as any).agent, {
    name: "Robotube Assistant",
    languageModel: openai.chat("gpt-4o-mini"),
    instructions: [
      "You are Robotube Assistant, an AI chat assistant for a single video.",
      "Help the user understand this video using only the provided video context and the chat history.",
      "If the answer is not supported by the provided context, say that you do not know yet.",
      "Keep answers concise and useful.",
      "",
      `Video title: ${video.title}`,
      `Channel: ${video.channelName}`,
      `Mux asset id: ${video.muxAssetId}`,
      `Summary: ${video.summary ?? "No summary available yet."}`,
      `Tags: ${video.tags.length > 0 ? video.tags.join(", ") : "No tags available yet."}`,
      "Chapters:",
      formatChapterList(video.chapters),
    ].join("\n"),
  });
}

export const generateResponseAsync = internalAction({
  args: {
    threadId: v.string(),
    muxAssetId: v.string(),
    promptMessageId: v.string(),
  },
  handler: async (ctx, args) => {
    const thread = await ctx.runQuery(
      (internal as any).videoChat.getThreadRecordByThreadIdInternal,
      { threadId: args.threadId },
    );
    if (!thread || thread.muxAssetId !== args.muxAssetId) {
      throw new Error("Chat thread not found.");
    }

    const video = (await ctx.runQuery((api as any).feed.getFeedVideoByMuxAssetId, {
      muxAssetId: args.muxAssetId,
    })) as VideoContext | null;
    if (!video) {
      throw new Error("Video not found for chat.");
    }

    const agent = buildVideoAgent(video);
    await agent.generateText(ctx, { threadId: args.threadId }, {
      promptMessageId: args.promptMessageId,
    });

    return { ok: true };
  },
});
