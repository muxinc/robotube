import { ConvexReactClient } from "convex/react";

export { api } from "../../../convex/_generated/api";

const convexUrl =
  import.meta.env.VITE_CONVEX_URL?.trim() ||
  import.meta.env.EXPO_PUBLIC_CONVEX_URL?.trim();

export const convexConfigError = convexUrl
  ? null
  : "Missing Convex client URL. Set VITE_CONVEX_URL or EXPO_PUBLIC_CONVEX_URL.";

export const convex = convexUrl ? new ConvexReactClient(convexUrl) : null;
