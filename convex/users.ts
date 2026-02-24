import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";

import { mutation, query } from "./_generated/server";

const USERNAME_PATTERN = /^[a-z0-9_]{3,24}$/;

function normalizeUsername(input: string) {
  return input.trim().toLowerCase();
}

export const currentUser = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    return await ctx.db.get(userId);
  },
});

export const isUsernameAvailable = query({
  args: {
    username: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return {
        available: false,
        reason: "not_authenticated",
      } as const;
    }

    const username = normalizeUsername(args.username);
    if (!USERNAME_PATTERN.test(username)) {
      return {
        available: false,
        reason: "invalid_format",
      } as const;
    }

    const existing = await ctx.db
      .query("users")
      .withIndex("username", (q) => q.eq("username", username))
      .first();

    if (!existing || existing._id === userId) {
      return {
        available: true,
        username,
      } as const;
    }

    return {
      available: false,
      reason: "taken",
    } as const;
  },
});

export const updateUsername = mutation({
  args: {
    username: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("You must be signed in to update your username.");
    }

    const username = normalizeUsername(args.username);
    if (!USERNAME_PATTERN.test(username)) {
      throw new Error(
        "Username must be 3-24 characters and use only lowercase letters, numbers, or underscores.",
      );
    }

    const existing = await ctx.db
      .query("users")
      .withIndex("username", (q) => q.eq("username", username))
      .first();

    if (existing && existing._id !== userId) {
      throw new Error("That username is already taken.");
    }

    await ctx.db.patch(userId, {
      username,
    });

    return {
      ok: true,
      username,
    };
  },
});
