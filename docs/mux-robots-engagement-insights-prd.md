# Robotube Mux Robots Engagement Insights PRD

> **Status and checkbox rule.** This document defines the product and
> implementation plan. A checked box means the behavior is already evidenced in
> the repository. Unchecked boxes are implementation, verification, or rollout
> work still to be done.

- **Status:** Proposed
- **Last updated:** 2026-09-10
- **Platforms:** React Native iOS and Android; shared Convex backend
- **Mux workflow:** `generate-engagement-insights` (experimental)
- **Primary Mux reference:**
  [Generate engagement insights](https://www.mux.com/docs/guides/robots-generate-engagement-insights)
- **Related Mux reference:**
  [Robots Directives](https://www.mux.com/docs/guides/robots-directives)

## 1. Summary

Add owner-only engagement insights for videos uploaded to Robotube. The signed-in
creator discovers the feature from **Profile → Your uploads**, chooses a video,
and opens a dedicated insights screen. From there they can generate or refresh a
Mux Robots analysis of that video's accumulated Mux Data engagement.

The result presents:

- an overall plain-language summary;
- a short list of engagement trends; and
- notable timestamped moments with a normalized engagement score and explanation.

The Profile list is the right entry point because it already lists the signed-in
user's uploads and contains owner management actions. The full report should not
be embedded in each profile card: it needs loading, empty, error, and timestamp
interaction states that belong on a per-video detail screen.

Guiding statement:

> Give creators an understandable, on-demand retention report for each upload,
> without exposing Mux credentials, charging for empty-data runs, or implying
> that the result is real-time analytics.

## 2. Why this should be on demand

Mux generates these insights from engagement metrics already collected by Mux
Data. A newly uploaded video has no meaningful audience history, and Mux states
that enough completed views must accumulate before the workflow has data to
analyze. Robotube already uses Mux players, so Mux Data collection should happen
automatically for playback through those players; this must still be verified in
the target Mux environment before launch.

Do **not** attach this workflow to the upload-time Robots pipeline in v1:

1. an ingest-time run is too early to contain useful engagement data;
2. every workflow run consumes a paid Robots unit;
3. a Directive cannot express “wait until this asset has enough completed
   views,” because that is a data threshold rather than an asset resource; and
4. the creator benefits more from a recent snapshot they deliberately request.

This remains a one-off Robots job, not a Directive. A future scheduled digest can
reuse the same backend adapter after cost, freshness, and eligibility thresholds
are validated.

## 3. Existing project fit

The repository already provides the main integration seams:

- [x] `app/(tabs)/profile.tsx` requires authentication and renders **Your
  uploads** from `feed.listCurrentUserUploadedVideos`.
- [x] Each profile upload already has an owner management menu.
- [x] `convex/uploads.ts` creates Mux direct uploads with `userId` in asset
  passthrough and processes uploads privately for Robots review.
- [x] `convex/feed.ts` resolves the current user's Mux-component video rows in
  one batched query.
- [x] `convex/http.ts` exposes one `/mux/webhook` endpoint.
- [x] `convex/muxWebhook.ts` verifies Mux signatures, records webhook events,
  extracts the Robots workflow name, asset ID, and passthrough context, and
  dispatches workflow-specific synchronizers.
- [x] `convex/aiMetadata.ts` and `convex/moderation.ts` demonstrate direct REST
  adapters, asynchronous status handling, webhook reconciliation, fallback
  polling, and server-only Mux credentials.
- [ ] No Engagement Insights job table, adapter, query, webhook branch, route,
  or UI currently exists.

## 4. Goals

- Let only the uploader generate and view insights for their own ready video.
- Explain engagement in creator-friendly language rather than raw analytics.
- Let the creator jump from a notable moment to that point in the video.
- Persist the latest completed report so it survives navigation and app restarts.
- Show the age of a report and require an explicit action to spend another unit.
- Prevent duplicate paid jobs from double taps, retries, or webhook replay.
- Reuse the verified Mux webhook endpoint and add bounded fallback polling.
- Keep experimental Mux API shapes isolated in one server adapter.
- Preserve useful prior insights while a refresh is processing or fails.

## 5. Non-goals

- A real-time analytics dashboard or replacement for the Mux Data dashboard.
- Raw retention curves, heatmaps, view counts, completion rates, audience
  dimensions, exports, or cohort comparison.
- Insights for videos uploaded by another user.
- Automatic analysis immediately after upload.
- Automatic daily or weekly refreshes in v1.
- Cross-video recommendations or library-wide benchmarking.
- Feeding insights into public ranking or recommendation logic.
- Editing a video automatically in response to an insight.
- Promising that all ready videos are eligible; adequate completed-view data is
  independently required.
- A Directive solely for this workflow in v1.

## 6. Product decisions

1. **Profile is the discovery surface.** Add **View engagement insights** to the
   existing owner menu on each item under **Your uploads**.
2. **Use a dedicated route.** Proposed route:
   `app/video/[muxAssetId]/engagement-insights.tsx`.
3. **Generation is explicit.** If no report exists, show **Generate insights**.
   If one exists, show it immediately and offer **Refresh insights**.
4. **A report is a snapshot.** Show `Generated <relative time>` and do not call
   it live data.
5. **One active job per asset.** Repeated requests return the existing active
   job state and never start another paid run.
6. **Keep the last good report.** Starting a refresh does not erase completed
   outputs. A failed refresh leaves the old report visible with a warning.
7. **No automatic retry that creates a new job.** Polling may retrieve the same
   job; only a new creator action may create a new paid job.
8. **Rate limit refreshes.** V1 enforces a server-side 24-hour cooldown after a
   successful report. Operators may configure this interval later.
9. **No hard-coded minimum view count.** The current workflow accepts only an
   `asset_id`; the docs do not publish an eligibility/count endpoint or numeric
   threshold. The UI describes the prerequisite and maps Mux's insufficient-data
   error when it occurs.
10. **Server-only credentials.** Clients call authenticated Convex functions;
    only Convex calls the Mux Robots API.
11. **Persist normalized outputs.** Store the fields Robotube renders, the raw
    Mux job ID and status, and a bounded sanitized error. Do not persist entire
    webhook bodies in the product table.
12. **Laravel orchestration compatibility.** When
    `USE_LARAVEL_ORCHESTRATION` is enabled, the owner of Robots webhook
    processing must also own this workflow. Convex must not double-process the
    same event. V1 cannot launch in that mode until the equivalent Laravel
    dispatch/sync contract is implemented or this workflow is explicitly
    exempted from the global handoff.

## 7. User experience

### 7.1 Profile entry point

Update the upload options menu:

```text
Video options
├── View engagement insights
├── Delete video
└── Cancel
```

The action is visible for the signed-in uploader's ready, non-deleted videos.
For a video still processing, it may remain visible but disabled with the label
**Insights available after processing**.

The profile card itself may show a compact non-interactive status chip
(`Ready`, `Analyzing`, or `Needs views`) only if the batched upload query can
return it without an N+1 query. This chip is optional for v1.

### 7.2 Insights screen

The screen contains:

1. Video thumbnail, title, duration, and a back action.
2. Eligibility/status card.
3. Latest report, when available:
   - overall summary;
   - trend bullets;
   - notable moments ordered by `start_ms`;
   - engagement score displayed as a percentage, explicitly labeled
     **relative engagement score**; and
   - generated timestamp.
4. Primary action: **Generate insights**, **Analyzing…**, **Refresh insights**,
   or **Try again**, according to state.
5. A short disclosure: “Generated by Mux Robots from aggregated viewing
   patterns. Results are a snapshot and may change as more people watch.”

Tapping a moment opens the existing video detail route with a seek intent, for
example `router.push({ pathname: "/video/[muxAssetId]", params: {
muxAssetId, startTime: startMs / 1000 } })`. The existing video route must be
extended to validate and honor the optional start time. If deep seeking is
deferred, tapping a moment may copy/show its timestamp, but that is not the
preferred launch experience.

### 7.3 States and messages

| State | User-facing behavior |
|---|---|
| Signed out | Redirect to sign-in or show “Sign in to view creator insights.” |
| Not owner | Show a generic unavailable state; do not reveal report data. |
| Asset missing/deleted | “This video is no longer available.” |
| Asset processing | Disable generation and explain that processing must finish. |
| No prior report | Explain the view prerequisite and offer **Generate insights**. |
| Pending/processing | Show durable progress and disable duplicate submission. |
| Completed | Render the latest normalized report and generated time. |
| Insufficient data | “This video needs more completed views before Mux can analyze engagement.” |
| Other job error | Preserve an older report, show a sanitized warning, and offer retry when allowed. |
| Refresh cooldown | Show when refresh becomes available. |

There is no fake progress percentage: Mux exposes asynchronous job status, not a
percent-complete signal.

### 7.4 Accessibility

- Every action has a descriptive accessibility label including the video title.
- Status transitions are announced with a polite live region where supported.
- Moment rows expose timestamp, relative score, and insight as one coherent
  accessible label.
- Color is never the only indicator of engagement score or job state.
- Scores use text such as `89% relative engagement`, not an unlabeled gauge.

## 8. Live Mux contract (verified 2026-09-10)

Mux marks this workflow experimental. Keep all wire-format parsing in
`convex/engagementInsightsNode.ts` and validate every response defensively.

### 8.1 Create job

```http
POST https://api.mux.com/robots/v0/jobs/generate-engagement-insights
Authorization: Basic <server-side Mux token ID and secret>
Content-Type: application/json
```

```json
{
  "parameters": {
    "asset_id": "MUX_ASSET_ID"
  }
}
```

The request returns immediately with a job in `pending` state and no insights.
The current documented parameter set contains only required `asset_id`.

If Mux accepts `passthrough` for the common Robots job envelope at
implementation time, include compact JSON with `muxAssetId`, `userId`, and the
Robotube job row ID. Do not make correctness depend on passthrough: the webhook
also includes `parameters.asset_id`, and ownership must be resolved server-side
from Robotube/Mux metadata. Verify passthrough against the current API reference
before shipping because it is not shown in this workflow's create example.

### 8.2 Retrieve job

```http
GET https://api.mux.com/robots/v0/jobs/generate-engagement-insights/{JOB_ID}
```

Use this only for bounded reconciliation of the same job when webhook delivery
is delayed. Never turn a lookup failure into a new create request.

### 8.3 Completion webhook

Recommended event:

```text
robots.job.generate_engagement_insights.completed
```

The webhook `data` contains the completed job, so the handler can normalize and
persist it without another API request. Existing `getRobotsWorkflow` converts
underscores in the event name to the hyphenated workflow identifier.

### 8.4 Output to normalize

```ts
type EngagementInsightsOutput = {
  moment_insights: Array<{
    start_ms: number;
    end_ms: number;
    engagement_score: number; // normalized 0..1
    insight: string;
  }>;
  overall_insight: {
    summary: string;
    trends: string[];
  };
};
```

Server validation rules:

- clamp scores to `0..1` only for display after preserving rejection telemetry;
- require finite, non-negative timestamps and enforce `end_ms >= start_ms`;
- trim strings and discard blank trends/moments;
- cap stored insight and summary lengths defensively;
- order moments by `start_ms`;
- accept missing/extra fields without crashing, but mark a completed job with no
  usable output as a reconciliation error;
- never display raw Mux errors or credentials to clients.

## 9. Proposed architecture

```text
Profile upload menu
  → authenticated Convex action
    → verify asset ownership + readiness + cooldown + active-job lock
      → POST Mux Robots job
        → persist job ID/status
          → Mux signed webhook (primary)
             or bounded GET polling (fallback)
              → normalize latest snapshot in Convex
                → reactive owner-only query updates insights screen
```

Use a dedicated table rather than burying the report only in Mux component
metadata. A first-class row supports an active-job uniqueness check, refresh
history, error recovery, indexed owner queries, and future retention cleanup.

### 9.1 Files

| File | Change |
|---|---|
| `convex/schema.ts` | Add `engagementInsightJobs` and indexes. |
| `convex/engagementInsights.ts` | Owner-only query/mutations, locks, cooldown, and normalized persistence. |
| `convex/engagementInsightsNode.ts` | Mux REST create/get adapter, polling, and authenticated public action. |
| `convex/muxWebhook.ts` | Dispatch `generate-engagement-insights` events to the synchronizer. |
| `app/(tabs)/profile.tsx` | Add the owner menu entry and route navigation. |
| `app/video/[muxAssetId]/engagement-insights.tsx` | Add the native report screen. |
| `app/video/[muxAssetId].tsx` | Accept and validate optional timestamp seek intent. |
| `tests/engagement-insights-*.test.ts` | Contract, ownership, idempotency, normalization, and wiring tests. |

### 9.2 Data model

Proposed Convex table:

```ts
engagementInsightJobs: defineTable({
  muxAssetId: v.string(),
  userId: v.string(),
  muxJobId: v.optional(v.string()),
  status: v.union(
    v.literal("requested"),
    v.literal("pending"),
    v.literal("processing"),
    v.literal("completed"),
    v.literal("errored"),
    v.literal("cancelled"),
  ),
  momentInsights: v.optional(v.array(v.object({
    startMs: v.number(),
    endMs: v.number(),
    engagementScore: v.number(),
    insight: v.string(),
  }))),
  overallSummary: v.optional(v.string()),
  trends: v.optional(v.array(v.string())),
  errorCode: v.optional(v.string()),
  errorMessage: v.optional(v.string()),
  requestedAtMs: v.number(),
  completedAtMs: v.optional(v.number()),
  updatedAtMs: v.number(),
})
  .index("by_asset_updated", ["muxAssetId", "updatedAtMs"])
  .index("by_user_updated", ["userId", "updatedAtMs"])
  .index("by_mux_job", ["muxJobId"]);
```

Keep historical rows for audit and debugging, but the owner query returns the
latest active job plus the latest successfully completed report. This lets the
UI retain an older report during refresh. Set a documented retention policy
before launch; a reasonable starting point is the latest 10 attempts per asset
or 90 days of job metadata, while preserving the latest completed snapshot.

### 9.3 Backend functions

- `engagementInsights.getOwnVideoInsights({ muxAssetId })`
  - authenticate;
  - verify ownership without leaking another user's data;
  - return asset display data, readiness, latest active job, latest completed
    report, cooldown, and a stable UI reason code.
- `engagementInsightsNode.generateOwnVideoInsights({ muxAssetId })`
  - authenticate and validate ownership again;
  - require a ready, non-deleted asset;
  - enforce cooldown;
  - atomically acquire one active-job slot;
  - create one Mux job;
  - persist the Mux job ID/status;
  - schedule bounded polling unless globally disabled.
- `engagementInsights.syncJobInternal({ muxAssetId, job })`
  - find by Mux job ID first, then asset plus active status;
  - ignore stale/replayed transitions;
  - normalize terminal output or sanitized error;
  - update timestamps idempotently.
- `engagementInsightsNode.pollJobInternal({ jobId, attempt })`
  - retrieve only the existing Mux job;
  - use bounded exponential/backoff scheduling;
  - stop on terminal state;
  - never create a replacement job.

### 9.4 Ownership

Do not trust a client-supplied user ID or webhook passthrough as authorization.
For interactive calls, obtain the authenticated user with `getAuthUserId` and
resolve the video's owner using the same Mux component metadata/passthrough
precedent already used by `videoMetadata.ts` and deletion. Webhooks are already
signature-verified, but their data should only locate a pre-existing Robotube
job; a webhook must not grant a user access to an asset.

### 9.5 Idempotency and races

- Reserve a `requested` row before calling Mux.
- Use an asset-scoped lock or mutation transaction to reject/reuse an active
  `requested`, `pending`, or `processing` row.
- If Mux creation fails synchronously, terminally mark that reserved row.
- Webhooks and polling call the same idempotent synchronizer.
- Ignore a non-terminal event received after the row is terminal.
- Match by `muxJobId` so a delayed webhook from an older refresh cannot overwrite
  a newer report.
- Select the latest completed report by `completedAtMs`, not arrival order.

## 10. Error taxonomy

Persist stable internal codes and map them to safe copy:

| Code | Meaning | Creator copy |
|---|---|---|
| `not_authenticated` | No signed-in user | Sign in to view creator insights. |
| `not_found_or_not_owner` | Missing asset or ownership mismatch | Insights are unavailable for this video. |
| `asset_not_ready` | Mux asset still processing | Insights can be generated after processing finishes. |
| `insufficient_engagement_data` | Mux cannot analyze current views | This video needs more completed views first. |
| `job_already_active` | Existing paid job is in progress | Engagement analysis is already running. |
| `refresh_cooldown` | Successful report is too recent | Show the next eligible refresh time. |
| `mux_auth_or_scope` | Robots terms, credentials, or scope problem | Insights are temporarily unavailable. |
| `mux_rate_limited` | Mux returned 429 | Try again later; do not auto-create a new job. |
| `mux_job_failed` | Robots job terminal failure | Mux could not generate insights for this video. |
| `invalid_mux_output` | Completed payload cannot be normalized | The report could not be processed. |

Because the guide does not document the exact insufficient-data error payload,
capture representative test-environment failures and add a narrow mapper. Do
not classify every 4xx as insufficient data.

## 11. Security and privacy

- Require authentication on every read and start action.
- Enforce ownership server-side for both report reads and job creation.
- Keep `MUX_TOKEN_ID`, `MUX_TOKEN_SECRET`, and webhook secret in Convex server
  environment variables only.
- Continue using `mux.webhooks.unwrap` before processing any event.
- Treat generated text as untrusted content; render as plain text, never HTML.
- Do not log credentials, full authorization headers, or raw webhook bodies.
- Return generic not-found/not-owner behavior to prevent asset enumeration.
- Bound asset IDs, output strings, array lengths, and timestamps before storage.
- Ensure deleting a video also deletes or tombstones its insight rows.

## 12. Observability and cost controls

Log structured, non-sensitive fields:

- Robotube row ID, Mux job ID, Mux asset ID;
- transition source (`create`, `webhook`, or `poll`);
- old/new status, duration, and normalized error code;
- workflow units consumed when present; and
- duplicate-start and cooldown rejections.

Track launch metrics:

- eligible-screen opens;
- generation and refresh requests;
- completion/error/insufficient-data rate;
- median and p95 time to completion;
- duplicate requests prevented;
- reports opened after completion;
- timestamp moment taps; and
- Robots units consumed per weekly active creator.

Do not attach the workflow to all uploads until a separate PRD establishes a
view-data threshold, refresh cadence, and budget. Directives themselves are
free, but each workflow run is billable.

## 13. Testing

### 13.1 Unit and contract tests

- Normalize a complete documented output.
- Sort moments and reject/clamp invalid numbers safely.
- Handle missing optional fields and extra experimental fields.
- Treat completed-without-usable-output as reconciliation failure.
- Map underscore webhook workflow name to
  `generate-engagement-insights`.
- Verify status monotonicity and replay idempotency.
- Verify an older job cannot replace a newer completed snapshot.
- Verify cooldown math and one-active-job invariant.
- Verify polling retrieves but never recreates a job.

### 13.2 Authorization tests

- Signed-out users cannot read or generate.
- User A cannot read or generate for User B's asset.
- A forged `userId`/passthrough cannot bypass ownership.
- Deleted and missing assets use the same non-enumerating response.

### 13.3 UI tests

- Profile menu routes with the correct `muxAssetId`.
- Every state in section 7.3 renders actionable copy.
- Existing report remains visible during and after a failed refresh.
- Duplicate taps create one request.
- A moment tap sends a seconds-based seek intent.
- Large text, VoiceOver/TalkBack labels, and small-screen scrolling work.

### 13.4 End-to-end verification

Use two representative assets in a non-production Mux environment:

1. a ready video with enough completed views, expected to complete with at least
   an overall insight; and
2. a fresh/no-view video, expected to produce the real insufficient-data path.

Confirm webhook processing, fallback polling with webhook delivery withheld,
app restart recovery, refresh cooldown, owner isolation, timestamp seeking, and
unit consumption in the Mux dashboard.

## 14. Rollout

### Phase 0 — Contract spike

- [ ] Accept Robots terms in the target environment.
- [ ] Confirm the access token has required Robots access.
- [ ] Confirm Robotube player views appear in Mux Data against the same assets.
- [ ] Manually run both positive and insufficient-data test assets.
- [ ] Record real error/status payloads and confirm whether common job
  `passthrough` is accepted by the current endpoint.
- [ ] Confirm current unit pricing and approve the 24-hour refresh policy.

### Phase 1 — Backend behind a flag

- [ ] Add schema, indexes, ownership query, create adapter, normalizer, and sync.
- [ ] Add verified webhook dispatch and fallback polling.
- [ ] Add deletion cleanup and retention behavior.
- [ ] Add unit, authorization, replay, and contract tests.
- [ ] Decide and implement the Laravel orchestration ownership path.

### Phase 2 — Internal UI

- [ ] Add profile menu entry and dedicated report screen behind
  `ENGAGEMENT_INSIGHTS_ENABLED`.
- [ ] Add timestamp seeking to the video detail route.
- [ ] Test with internal creators and real viewing data.
- [ ] Validate accessibility and error copy on iOS and Android.

### Phase 3 — Controlled launch

- [ ] Enable for a small creator cohort.
- [ ] Monitor insufficient-data rate, latency, errors, and units per creator.
- [ ] Tune cooldown and entry-point messaging without changing Mux job semantics.
- [ ] Roll out broadly only after cost and usefulness targets are met.

## 15. Acceptance criteria

- [ ] A signed-in creator can open Engagement Insights from one of their Profile
  uploads.
- [ ] A creator cannot read or start the workflow for another user's asset.
- [ ] A ready asset can start exactly one `generate-engagement-insights` job.
- [ ] Duplicate taps and concurrent calls do not create duplicate paid jobs.
- [ ] The screen reacts to pending, processing, completed, and failed states.
- [ ] A completed report renders overall summary, trends, and valid moment rows.
- [ ] A notable moment can open playback at its start timestamp.
- [ ] The report shows when it was generated and does not claim to be real time.
- [ ] A refresh preserves the last completed report until a newer one succeeds.
- [ ] A fresh/no-view video gets clear insufficient-data guidance.
- [ ] Webhook replay and fallback polling converge idempotently.
- [ ] Refresh cooldown is enforced server-side.
- [ ] Video deletion removes or tombstones related insight records.
- [ ] Mux credentials and raw errors never reach the client.
- [ ] The feature can be disabled without affecting uploads, playback, or the
  existing Robots metadata pipeline.

## 16. Open questions requiring validation, not guesses

1. What exact error type/message does Mux return when completed-view data is
   insufficient in the target environment?
2. Does the current API reference permit top-level `passthrough` for this
   experimental workflow even though the workflow guide's request example omits
   it?
3. What is the approved production refresh cooldown after observed unit cost and
   report usefulness: 24 hours, 72 hours, or manual operator configuration?
4. Should the first web implementation be included? The repository contains a
   separate Vite React app, but the current authenticated Profile flow described
   here is the Expo Router application.
5. When Laravel orchestration is enabled, should Laravel own Engagement Insights
   end to end, or should the global Robots webhook handoff gain a documented
   exception for this creator-triggered workflow?

## 17. Source notes

The live Mux guide was checked on 2026-09-10. It documents that the workflow is
experimental, requires accumulated Mux Data viewing data and enough completed
views, accepts `asset_id`, runs asynchronously, recommends the
`robots.job.generate_engagement_insights.completed` webhook, and returns
timestamped moment insights plus an overall summary and trends.

The Directives guide was also checked on 2026-09-10. Directives can attach to
asset creation and run workflows automatically, but their declared dependencies
are asset resources. That does not solve this feature's “enough audience data
has accumulated” eligibility condition, which is why v1 uses an explicit
one-off job.
