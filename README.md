![robotube logo](./assets/images/robotube-logo.png)

This is a video streaming app built with Expo and React Native.

We use Mux + Convex + RN to bring a video streaming experience to your fingertips that are for you and your AI agent. Use Mux AI to analyze videos, and more!

This is an [Expo](https://expo.dev) project created with [`create-expo-app`](https://www.npmjs.com/package/create-expo-app).

## Authentication (Convex Auth + OAuth)

Robotube uses [Convex Auth](https://labs.convex.dev/auth) with Google and Apple OAuth.

Install auth dependencies and initialize Convex Auth once:

```bash
npm install @convex-dev/auth @auth/core@0.37.0 expo-secure-store
npx @convex-dev/auth
```

### Backend setup

1. Add required Convex auth env vars:

```bash
npx convex env set SITE_URL robotube://
npx convex env set AUTH_GOOGLE_ID <google-client-id>
npx convex env set AUTH_GOOGLE_SECRET <google-client-secret>
npx convex env set AUTH_APPLE_ID <apple-service-id>
npx convex env set AUTH_APPLE_SECRET <apple-client-secret-jwt>
```

2. OAuth callback URLs (provider dashboards):

- Google: `https://<your-deployment>.convex.site/api/auth/callback/google`
- Apple: `https://<your-deployment>.convex.site/api/auth/callback/apple`

Notes:

- Apple OAuth requires a public HTTPS deployment (no localhost-only flow).
- Apple client secret expires and must be rotated periodically.

## Mux AI features used in this app

Robotube uses [`@mux/ai`](https://www.npmjs.com/package/@mux/ai) with Convex to enrich uploaded videos and power semantic search.

- `getSummaryAndTags`: generates AI summary text (`description`) and tags for each ready video.
- `generateEmbeddings`: generates transcript chunk embeddings used for vector search in Convex.
- `getModerationScores`: runs moderation checks and updates visibility rules for feed inclusion.

### How the pipeline works

1. User uploads a video to Mux via direct upload.
2. When the asset is ready, Convex schedules AI metadata generation.
3. Summary + tags are written to video metadata in Convex.
4. Embeddings are generated and stored in the `videoEmbeddings` table with a vector index.
5. Explore search combines vector similarity and lexical matching (title, summary, tags).

### Backfill commands for existing videos

If you already have videos uploaded before enabling these features, run backfills:

```bash
npx convex run migrations:backfillAiMetadataForReadyAssets '{"maxAssets":500,"defaultUserId":"mobile-user","onlyMissing":true}'
npx convex run migrations:backfillEmbeddingsForReadyAssets '{"maxAssets":500,"defaultUserId":"mobile-user","onlyMissing":true}'
npx convex run migrations:backfillModerationForReadyAssets '{"maxAssets":500,"defaultUserId":"mobile-user","onlyMissing":true}'
```

## Get started

Note: This app is currently running the canary version of Expo. We need this to use the <Activity> Component from React 19.2.

1. Install dependencies

   ```bash
   npm install
   ```

2. Create `.env.local` in the project root with your Convex deployment URL:

   ```bash
   EXPO_PUBLIC_CONVEX_URL=https://<your-deployment>.convex.cloud
   ```

   You can get this value from your Convex dashboard deployment settings (or from `npx convex dev` output).

3. Start the app

   ```bash
   npx expo start
   ```

In the output, you'll find options to open the app in a

- [development build](https://docs.expo.dev/develop/development-builds/introduction/)
- [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/)
- [iOS simulator](https://docs.expo.dev/workflow/ios-simulator/)
- [Expo Go](https://expo.dev/go), a limited sandbox for trying out app development with Expo

You can start developing by editing the files inside the **app** directory. This project uses [file-based routing](https://docs.expo.dev/router/introduction).

## Get a fresh project

When you're ready, run:

```bash
npm run reset-project
```

This command will move the starter code to the **app-example** directory and create a blank **app** directory where you can start developing.
