"use node";

import { Agent, createTool, stepCountIs } from "@convex-dev/agent";
import { openai } from "@ai-sdk/openai";
import { v } from "convex/values";
import { z } from "zod/v4";

import { api, components, internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

type VideoContext = {
  muxAssetId: string;
  title: string;
  durationSeconds: number | null;
  summary: string | null;
  tags: string[];
  chapters: { title: string; startTime: number }[];
  channelName: string;
};

const MUX_ROBOTS_API_BASE_URL = "https://api.mux.com/robots/v1";
const ASK_QUESTIONS_MAX_POLL_ATTEMPTS = 30;
const ASK_QUESTIONS_POLL_INTERVAL_MS = 1000;

type AskQuestionsAnswer = {
  question: string;
  answer: string;
  confidence: number;
  reasoning: string;
};

type AskQuestionsJob = {
  id: string;
  status: "pending" | "processing" | "completed" | "errored" | "cancelled";
  outputs?: {
    answers?: AskQuestionsAnswer[];
  };
  errors?: {
    type?: string;
    message?: string;
  }[];
};

function unwrapAskQuestionsJob(payload: unknown): AskQuestionsJob {
  return ((payload as { data?: AskQuestionsJob } | undefined)?.data ?? payload) as AskQuestionsJob;
}

function requireAskQuestionsJobId(value: unknown) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Mux ask-questions job response did not include an id.");
  }
  return value;
}

function isTerminalAskQuestionsStatus(
  value: unknown,
): value is "completed" | "errored" | "cancelled" {
  return value === "completed" || value === "errored" || value === "cancelled";
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

function formatAskQuestionsErrors(errors: AskQuestionsJob["errors"]) {
  if (!errors || errors.length === 0) {
    return "Unknown Mux ask-questions error.";
  }

  return errors
    .map((error) => error?.message || error?.type || "Unknown error")
    .join("; ");
}

async function createAskQuestionsJob(args: {
  assetId: string;
  question: string;
  answerOptions: string[];
  passthrough?: string;
}): Promise<AskQuestionsJob> {
  const response = await fetch(`${MUX_ROBOTS_API_BASE_URL}/jobs/ask-questions`, {
    method: "POST",
    headers: {
      Authorization: createMuxBasicAuthHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      passthrough: args.passthrough,
      parameters: {
        asset_id: args.assetId,
        questions: [{ question: args.question }],
        answer_options: args.answerOptions,
      },
    }),
  });

  if (!response.ok) {
    const details = await readResponseTextSafe(response);
    throw new Error(
      `Mux ask-questions job creation failed (${response.status})${details ? `: ${details}` : ""}.`,
    );
  }

  return unwrapAskQuestionsJob(await response.json());
}

async function getAskQuestionsJob(jobId: string): Promise<AskQuestionsJob> {
  const normalizedJobId = requireAskQuestionsJobId(jobId);
  const response = await fetch(`${MUX_ROBOTS_API_BASE_URL}/jobs/ask-questions/${normalizedJobId}`, {
    method: "GET",
    headers: {
      Authorization: createMuxBasicAuthHeader(),
    },
  });

  if (!response.ok) {
    const details = await readResponseTextSafe(response);
    throw new Error(
      `Mux ask-questions job lookup failed (${response.status})${details ? `: ${details}` : ""}.`,
    );
  }

  return unwrapAskQuestionsJob(await response.json());
}

async function waitForAskQuestionsCompletion(jobId: string): Promise<AskQuestionsJob> {
  const normalizedJobId = requireAskQuestionsJobId(jobId);

  for (let attempt = 0; attempt < ASK_QUESTIONS_MAX_POLL_ATTEMPTS; attempt += 1) {
    const job = await getAskQuestionsJob(normalizedJobId);
    if (
      job.status === "completed" ||
      job.status === "errored" ||
      job.status === "cancelled"
    ) {
      return job;
    }

    await sleep(ASK_QUESTIONS_POLL_INTERVAL_MS);
  }

  throw new Error("Mux ask-questions job timed out before completion.");
}

function formatChapterList(chapters: VideoContext["chapters"]) {
  if (chapters.length === 0) return "No chapter list is available yet.";
  return chapters
    .map((chapter) => `- ${chapter.title} (${formatDurationLabel(chapter.startTime)})`)
    .join("\n");
}

function formatDurationLabel(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds)) {
    return "unknown";
  }

  const totalSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function buildVideoAgent(video: VideoContext) {
  const askCurrentVideoQuestion = createTool({
    description:
      "Ask Mux AI a structured question about the current video asset. Use this when the user asks about concrete video content and the answer can be constrained to a small set of answer options.",
    args: z.object({
      question: z
        .string()
        .min(1)
        .describe("The question to ask about the current video asset."),
      answerOptions: z
        .array(z.string().min(1))
        .min(2)
        .max(8)
        .optional()
        .describe(
          "Allowed answer values for the Mux job. If omitted, defaults to yes/no/unclear.",
        ),
    }),
    async handler(_ctx, args) {
      const answerOptions =
        args.answerOptions && args.answerOptions.length > 0
          ? args.answerOptions
          : ["yes", "no", "unclear"];

      const createdJob = await createAskQuestionsJob({
        assetId: video.muxAssetId,
        question: args.question,
        answerOptions,
        passthrough: JSON.stringify({
          muxAssetId: video.muxAssetId,
          title: video.title,
        }),
      });
      const job = isTerminalAskQuestionsStatus(createdJob.status)
        ? createdJob
        : await waitForAskQuestionsCompletion(requireAskQuestionsJobId(createdJob.id));
      const jobId = requireAskQuestionsJobId(job.id);

      if (job.status !== "completed") {
        return {
          ok: false,
          jobId,
          status: job.status,
          error: formatAskQuestionsErrors(job.errors),
        };
      }

      const answer = job.outputs?.answers?.[0];
      if (!answer) {
        return {
          ok: false,
          jobId,
          status: job.status,
          error: "Mux completed the job without returning an answer.",
        };
      }

      return {
        ok: true,
        jobId,
        status: job.status,
        question: answer.question,
        answer: answer.answer,
        confidence: answer.confidence,
        reasoning: answer.reasoning,
        answerOptions,
      };
    },
  });

  return new Agent((components as any).agent, {
    name: "Robotube Assistant",
    languageModel: openai.chat("gpt-4o-mini"),
    tools: {
      askCurrentVideoQuestion,
    },
    stopWhen: stepCountIs(4),
    instructions: [
      "You are Robotube Assistant, an AI chat assistant for a single video.",
      "Help the user understand this video using the provided video context, the chat history, and available tools.",
      "Answer direct metadata questions from the provided video context before using any tool.",
      "Examples of direct metadata questions include duration, title, channel, tags, summary, and chapter list.",
      "Use the askCurrentVideoQuestion tool when the user asks about concrete video content and a constrained answer is appropriate.",
      "When you use the tool, summarize the answer clearly and include the tool reasoning in plain language.",
      "If the answer is not supported by the provided context or tool result, say that you do not know yet.",
      "Keep answers concise and useful.",
      "",
      `Video title: ${video.title}`,
      `Channel: ${video.channelName}`,
      `Mux asset id: ${video.muxAssetId}`,
      `Duration: ${formatDurationLabel(video.durationSeconds)}`,
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
    const generationArgs = {
      promptMessageId: args.promptMessageId,
    };
    await agent.generateText(ctx, { threadId: args.threadId }, generationArgs as any);

    return { ok: true };
  },
});
