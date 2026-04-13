import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";

import { mutation, query } from "./_generated/server";

const USERNAME_PATTERN = /^[a-z0-9_]{3,24}$/;

function normalizeUsername(input: string) {
  return input.trim().toLowerCase();
}

async function resolveAvatarUrl(
  ctx: any,
  avatarStorageId: unknown,
  fallbackImage: unknown,
) {
  if (typeof avatarStorageId === "string" && avatarStorageId.length > 0) {
    const storageUrl = await ctx.storage.getUrl(avatarStorageId);
    if (storageUrl) {
      return storageUrl;
    }
  }

  return typeof fallbackImage === "string" && fallbackImage.length > 0
    ? fallbackImage
    : null;
}

export const currentUser = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    const user = await ctx.db.get(userId);
    if (!user) return null;

    return {
      ...user,
      avatarUrl: await resolveAvatarUrl(ctx, (user as any).avatarStorageId, user.image),
    };
  },
});

export const generateAvatarUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("You must be signed in to change your profile picture.");
    }

    return {
      uploadUrl: await ctx.storage.generateUploadUrl(),
    };
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

export const updateProfileImage = mutation({
  args: {
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("You must be signed in to change your profile picture.");
    }

    const user = await ctx.db.get(userId);
    if (!user) {
      throw new Error("Could not find your user profile.");
    }

    const previousAvatarStorageId = (user as any).avatarStorageId;
    if (
      typeof previousAvatarStorageId === "string" &&
      previousAvatarStorageId.length > 0 &&
      previousAvatarStorageId !== args.storageId
    ) {
      await ctx.storage.delete(previousAvatarStorageId);
    }

    await ctx.db.patch(userId, {
      avatarStorageId: args.storageId,
    });

    return {
      ok: true,
      avatarUrl: await ctx.storage.getUrl(args.storageId),
    };
  },
});
