![app icon](./assets/images/app-icon.png)

![demo gif](./assets/images/robotube-demo.gif)

This is robotube, a video streaming app built with Mux, Convex, Expo and React Native.

This applicaiton uses Mux Robots, the latest video intelligence API by Mux.

Heres the breakdown of the stack:

Mux:

- Video storage, streaming and delivery

- Mux Robots gives this app the ability to:
  - Generate summary and tags
  - Moderate a videos
  - Generate a video's chapters
  - Generate a video's key moments
  - Translate captions
  - Ask questions about a video

Expo:

- [Expo video player](https://docs.expo.dev/versions/latest/sdk/video/)
- [Expo Native Tabs](https://docs.expo.dev/router/advanced/native-tabs/)

Convex:
Convex is our database of choice with a bunch of added feqtures below

- [Mux Convex Component](https://www.convex.dev/components/mux/convex)
- [Convex Auth](https://docs.convex.dev/auth/convex-auth)
- [Convex Agent](https://docs.convex.dev/agents/getting-started)
- [Vector Search](https://docs.convex.dev/search/vector-search)

This is an [Expo](https://expo.dev) project created with [`create-expo-app`](https://www.npmjs.com/package/create-expo-app).

## React web app

The browser-native React 19 app lives in `web/`. It shares this repository's
existing Convex backend and generated API instead of creating a separate
deployment.

```bash
npm --prefix web install
npm run web:react
```

The web client reads `EXPO_PUBLIC_CONVEX_URL` from the root environment for
local development. Hosted environments can provide the same public deployment
URL as `VITE_CONVEX_URL`.

Convex Auth keeps the native `robotube://` callback and explicitly allows the
production web origin plus local Vite origins.

## Get started

This project uses Expo SDK 55 and React 19.2, so the `<Activity>` component is available.

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create `.env.local` in the project root:

   ```bash
   EXPO_PUBLIC_CONVEX_URL=https://<your-deployment>.convex.cloud
   EXPO_PUBLIC_CONVEX_SITE_URL=https://<your-convex-site-url>.convex.site
   CONVEX_DEPLOYMENT=dev:<your-convex-deployment>
   ```

   You can get these values from your Convex dashboard, or from the first `npx convex dev` run.

3. Start Convex in one terminal:

   ```bash
   npx convex dev
   ```

4. Start the app in another terminal:

   ```bash
   npx expo start
   ```

In the Expo output, you'll find options to open the app in a:

- [development build](https://docs.expo.dev/develop/development-builds/introduction/)
- [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/)
- [iOS simulator](https://docs.expo.dev/workflow/ios-simulator/)
- [Expo Go](https://expo.dev/go), a limited sandbox for trying out app development with Expo

You can start developing by editing the files inside the **app** directory. This project uses [file-based routing](https://docs.expo.dev/router/introduction).

## Authentication (Convex Auth + OAuth)

Robotube uses [Convex Auth](https://labs.convex.dev/auth) with Google OAuth.

If you are setting up a new deployment, initialize Convex Auth once:

```bash
npx @convex-dev/auth
```

Then add the required auth env vars:

```bash
npx convex env set SITE_URL robotube://
npx convex env set AUTH_GOOGLE_ID <google-client-id>
npx convex env set AUTH_GOOGLE_SECRET <google-client-secret>
```

OAuth callback URLs for your provider dashboards:

- Google: `https://<your-deployment>.convex.site/api/auth/callback/google`

## Mux AI features used in this app

Robotube uses [`@mux/ai`](https://www.npmjs.com/package/@mux/ai) with Convex to enrich uploaded videos and power semantic search.

- `generateEmbeddings`: generates transcript chunk embeddings used for vector search in Convex.

### How the pipeline works

1. User uploads a video to Mux via direct upload.
2. When the asset is ready, Convex schedules AI metadata generation.
3. Summary + tags are written to video metadata in Convex.
4. Embeddings are generated and stored in the `videoEmbeddings` table with a vector index.
5. Explore search combines vector similarity and lexical matching (title, summary, tags).

### Backfill existing videos

If you uploaded videos before enabling these features, run the backfills after your app and Convex deployment are set up:

```bash
npx convex run migrations:backfillAiMetadataForReadyAssets '{"maxAssets":500,"defaultUserId":"mobile-user","onlyMissing":true}'
npx convex run migrations:backfillEmbeddingsForReadyAssets '{"maxAssets":500,"defaultUserId":"mobile-user","onlyMissing":true}'
npx convex run migrations:backfillModerationForReadyAssets '{"maxAssets":500,"defaultUserId":"mobile-user","onlyMissing":true}'
```

## News feed performance architecture

The Home feed's playback path is being rebuilt around a recyclable list, one
attached active player, bounded preloading, and a card-sized Convex response.

- [News Feed Performance Architecture PRD](./docs/news-feed-performance-architecture-prd.md) — phases, exit gates, and success metrics
- [9:16 Vertical Video Feed PRD](./docs/vertical-video-feed-prd.md) — phased plan for an exclusive TikTok-style Shorts tab
- [Architecture and operations notes](./docs/news-feed-performance-operations.md) — event vocabulary, dev counters, rollout flags, preload kill switch, rollout runbook
- [Phase 0 baseline](./docs/news-feed-performance-baseline.md) — measurement environment and what has and has not been measured

Instrumentation and rollout controls live in:

- `lib/feed-performance.ts` — single import surface for the modules below
- `lib/feed-performance-events.ts` — event vocabulary and the privacy sanitizer that keeps tokens, playback URLs, captions, and transcripts out of telemetry; covers both the Home feed and Shorts
- `lib/feed-performance-timeline.ts` — focus/playback timestamps and the p50/p75/p95 first-frame gates
- `lib/feed-performance-counters.ts` — development-only counters and playback invariant checks (removed in Phase 6)
- `lib/feed-feature-flags.ts` — default-off rollout flags with owners, removal dates, and deterministic cohort bucketing
- `lib/feed-feature-kill-switch.ts` — immediate remote kill switch for predictive preloading

Verification (no test runner is installed; these run on Node's built-in one):

```bash
node scripts/news-feed-tests.mjs        # pure unit tests, no device or network
node scripts/news-feed-run-sheet.mjs    # probe local devices/tooling, print a blank measurement run sheet
npm run lint
npx tsc --noEmit
```

## Shorts: the 9:16 vertical feed

A default-off fifth native tab presenting a full-viewport, vertically paged feed
containing only ready, visible videos whose normalized display aspect ratio is
exactly `9:16`. Classification, indexed queries, the Shorts UI/playback layer,
telemetry, and remote rollout controls are implemented. Home keeps its legacy
query until `exclusiveFeedPlacementEnabled` is turned on, after which it uses
the indexed `standard` placement.

The configured development deployment was backfilled and audited on 2026-07-30:
72 playable assets classified as 68 standard and 4 vertical, with zero playable
unknowns, overlaps, omissions, inconsistent classifications, or duplicate IDs.
Runtime flags remain fail-closed; physical-device performance and Android
validation are still rollout gates.

- [9:16 Vertical Video Feed PRD](./docs/vertical-video-feed-prd.md) — phases, exit gates, and the eligibility contract
- [Observability, flags, and operations](./docs/vertical-video-feed-operations.md) — Shorts event vocabulary, rollout flags, cohort ladder, rollback plan, dashboard specifications, runbook
- [Fixtures and verification record](./docs/vertical-video-feed-verification.md) — the fixture set and an explicit list of what has and has not been verified

Tooling:

- `convex/aspectClassification.ts` and `convex/feedPlacement.ts` — canonical
  classification, resumable audit, and exclusivity/coverage gate
- `convex/feed.ts` — indexed standard and vertical paginated card queries
- `convex/feedRuntimeConfig.ts` — atomic, reactive remote flag state
- `app/(tabs)/shorts.tsx` — paged Shorts route, states, playback, and telemetry
- `hooks/use-feed-feature-flags.tsx` — one app-wide resolved rollout snapshot
- `lib/vertical-video-feed.ts` — single import surface for the modules below
- `lib/vertical-video-feed-fixtures.ts` — 42 deterministic classification and visibility fixtures, plus the PRD section 7.2/7.3 eligibility oracle the production classifier must agree with
- `lib/vertical-video-feed-audit.ts` — placement distribution, coverage gate, Home/Shorts exclusivity audit, backfill counter checks
- `lib/vertical-video-feed-scenarios.ts` — the 13 Phase 6 scenarios and the acceptance, Home-regression, and accessibility checklists
- `lib/vertical-video-feed-rollout.ts` — cohort ladder, ordered rollback plan, Shorts rollout guards
- `lib/vertical-video-feed-dashboards.ts` — saved-query and alert specifications, validated against the live event vocabulary

Two default-off flags in the shared registry gate the rollout: `shortsTabEnabled`
(hides the tab and its query/playback work) and `exclusiveFeedPlacementEnabled`
(moves Home to `feedPlacement == "standard"`). The second **resolves false
whenever the first is off**, enforced in `resolveFeedFeatureFlags` rather than
merely reported, because otherwise exact 9:16 assets would appear in neither
feed. A remote `false` also outranks any percentage rollout still configured, so
an emergency off switch cannot be undone by a stale ramp value.

```bash
node scripts/vertical-video-feed-tests.mjs                    # 93 pure unit tests
node scripts/vertical-video-feed-fixtures.mjs                 # fixture summary; --format markdown|json, --feed N
node scripts/vertical-video-feed-run-sheet.mjs                # probe tooling, print a blank Shorts run sheet
node --experimental-strip-types --test tests/aspect-classification.test.ts tests/vertical-feed-data.test.ts tests/vertical-feed-data-backfill.test.ts tests/vertical-feed-runtime-wiring.test.ts
```

## Get a fresh project

When you're ready, run:

```bash
npm run reset-project
```

This command will move the starter code to the **app-example** directory and create a blank **app** directory where you can start developing.

![robotube](./assets/images/robotube-logo.png)
