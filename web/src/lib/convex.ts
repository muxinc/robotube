import { ConvexReactClient } from "convex/react";
import { anyApi } from "convex/server";

// The web app intentionally uses dynamic Convex references. Importing the
// generated root API here makes a standalone web build type-check every backend
// module and therefore require the native app's full dependency tree.
export const api = anyApi;

const convexUrl =
  import.meta.env.VITE_CONVEX_URL?.trim() ||
  import.meta.env.EXPO_PUBLIC_CONVEX_URL?.trim();

export const convexConfigError = convexUrl
  ? null
  : "Missing Convex client URL. Set VITE_CONVEX_URL or EXPO_PUBLIC_CONVEX_URL.";

export const convex = convexUrl ? new ConvexReactClient(convexUrl) : null;
