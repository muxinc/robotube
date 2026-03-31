![app icon](./assets/images/app-icon.png)

![demo gif](./assets/images/demo-robotube.gif)

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

Robotube uses [Convex Auth](https://labs.convex.dev/auth) with Google and Apple OAuth.

If you are setting up a new deployment, initialize Convex Auth once:

```bash
npx @convex-dev/auth
```

Then add the required auth env vars:

```bash
npx convex env set SITE_URL robotube://
npx convex env set AUTH_GOOGLE_ID <google-client-id>
npx convex env set AUTH_GOOGLE_SECRET <google-client-secret>
npx convex env set AUTH_APPLE_ID <apple-service-id>
npx convex env set AUTH_APPLE_SECRET <apple-client-secret-jwt>
```

OAuth callback URLs for your provider dashboards:

- Google: `https://<your-deployment>.convex.site/api/auth/callback/google`
- Apple: `https://<your-deployment>.convex.site/api/auth/callback/apple`

Notes:

- Apple OAuth requires a public HTTPS deployment (no localhost-only flow).
- Apple client secret expires and must be rotated periodically.

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

## Get a fresh project

When you're ready, run:

```bash
npm run reset-project
```

This command will move the starter code to the **app-example** directory and create a blank **app** directory where you can start developing.

![robotube](./assets/images/robotube-logo.png)
