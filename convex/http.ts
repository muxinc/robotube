import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { auth } from "./auth";
import { laravelSyncHttp } from "./laravelSync";

const http = httpRouter();

auth.addHttpRoutes(http);

http.route({
  path: "/mux/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const rawBody = await request.text();
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const result = await ctx.runAction(internal.muxWebhook.ingestMuxWebhook, {
      rawBody,
      headers,
    });

    return new Response(JSON.stringify(result), {
      headers: { "content-type": "application/json" },
    });
  }),
});

// Laravel -> Convex sync-back receiver (PRD §22.12 / Loop 11). Gated behind
// USE_LARAVEL_ORCHESTRATION inside the handler.
http.route({
  path: "/laravel/sync",
  method: "POST",
  handler: laravelSyncHttp,
});

export default http;
