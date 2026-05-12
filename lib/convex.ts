import { ConvexReactClient } from "convex/react";

const convexUrl = process.env.EXPO_PUBLIC_CONVEX_URL;

export const convexConfigError = convexUrl
  ? null
  : "Missing EXPO_PUBLIC_CONVEX_URL. Add it to your EAS build environment before creating a production build.";

export const convex = convexUrl ? new ConvexReactClient(convexUrl) : null;
