/**
 * Shared feature-flag + env helpers for the Laravel orchestration integration
 * (PRD Section 0 scope amendment 2026-07-09, Loops 4 & 11).
 *
 * This module is intentionally dependency-free (no convex/server imports) so it
 * can be imported from both "use node" actions (uploads.ts, muxWebhook.ts,
 * migrations.ts, laravelOrchestration.ts) and default-runtime functions
 * (laravelSync.ts httpAction/mutation).
 *
 * Env vars (set in the Convex deployment, NOT committed):
 * - USE_LARAVEL_ORCHESTRATION : master flag. "true" or "1" => on. Anything else
 *   (or unset) => off, and all Laravel-integration behavior is a no-op so the
 *   app behaves byte-for-byte as it does today (safe rollback path).
 * - LARAVEL_ORCHESTRATION_URL  : base URL of the Laravel orchestration backend.
 * - LARAVEL_ORCHESTRATION_SECRET : HMAC shared secret. MUST match Laravel's
 *   ROBOTUBE_SHARED_SECRET.
 */

/** True when Laravel orchestration is enabled via the deployment env flag. */
export function isLaravelOrchestrationEnabled(): boolean {
  const raw = process.env.USE_LARAVEL_ORCHESTRATION;
  return raw === "true" || raw === "1";
}
