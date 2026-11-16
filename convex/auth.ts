import Google from "@auth/core/providers/google";
import { convexAuth } from "@convex-dev/auth/server";

const ALLOWED_WEB_REDIRECT_ORIGINS = new Set([
  "https://robotube-web.workspace-245068.chatgpt.site",
  "https://robotube.vercel.app",
]);

// Local web dev servers land on whichever port is free (5173, 5175, 5177, ...),
// so any plain-http loopback origin is allowed rather than a fixed port list.
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isAllowedWebRedirect(url: URL) {
  if (ALLOWED_WEB_REDIRECT_ORIGINS.has(url.origin)) return true;
  return url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname);
}

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

      if (isAllowedWebRedirect(redirectUrl)) {
        return redirectUrl.toString();
      }

      throw new Error(
        `Authentication redirect URL is not allowed: ${redirectUrl.origin}`,
      );
    },
  },
});
