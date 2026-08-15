import Google from "@auth/core/providers/google";
import { convexAuth } from "@convex-dev/auth/server";

const ALLOWED_WEB_REDIRECT_ORIGINS = new Set([
  "https://robotube-web.workspace-245068.chatgpt.site",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Google],
  callbacks: {
    async redirect({ redirectTo }) {
      const configuredSiteUrl = (process.env.SITE_URL ?? "robotube://").replace(
        /\/$/,
        "",
      );

      if (redirectTo.startsWith("?") || redirectTo.startsWith("/")) {
        return `${configuredSiteUrl}${redirectTo}`;
      }

      if (
        redirectTo === configuredSiteUrl ||
        redirectTo.startsWith(`${configuredSiteUrl}/`) ||
        redirectTo.startsWith(`${configuredSiteUrl}?`)
      ) {
        return redirectTo;
      }

      let redirectUrl: URL;
      try {
        redirectUrl = new URL(redirectTo);
      } catch {
        throw new Error("Invalid authentication redirect URL.");
      }

      if (ALLOWED_WEB_REDIRECT_ORIGINS.has(redirectUrl.origin)) {
        return redirectUrl.toString();
      }

      throw new Error("Authentication redirect URL is not allowed.");
    },
  },
});
