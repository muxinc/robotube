# Configure upload caption Directives

Use this procedure to enable the upload-time **Include speaker labels** option. RoboTube needs two Mux Directive IDs in its Convex environment before it accepts new uploads through this implementation.

## Inspect the definitions without contacting Mux

Run this command from the repository root with Node 24:

```sh
node --experimental-strip-types scripts/provision-caption-directives.mjs
```

The command prints two definitions. It does not read credentials, contact Mux, or start jobs.

Both definitions contain one `generate-premium-captions` workflow. The plain variant sets `include_speakers: false`; the speaker variant sets `include_speakers: true`. They use English, upload the generated track, and fail on existing-track conflicts rather than delete captions. Neither definition contains `edit-captions`.

## Create the definitions after approval

Confirm that your Mux credentials belong to the intended environment and have Robots access. Accept the applicable Robots terms before setup.

The next command creates remote configuration. It does not run a Directive or upload an asset. Run it only after approving that change, with `MUX_TOKEN_ID` and `MUX_TOKEN_SECRET` available in the shell environment:

```sh
node --experimental-strip-types scripts/provision-caption-directives.mjs --create
```

The command prints these environment-variable assignments:

```text
MUX_CAPTION_DIRECTIVE_WITHOUT_SPEAKERS_ID=drv_...
MUX_CAPTION_DIRECTIVE_WITH_SPEAKERS_ID=drv_...
```

Save both IDs. The command reuses an existing Directive only when its name and configuration match exactly. It refuses duplicate names or mismatched configurations.

If the command fails after creating one variant, retain its printed ID. Inspect the Mux Dashboard before retrying, especially after a network timeout. Do not run concurrent copies of the provisioning command.

## Configure and deploy Convex

Select the intended development deployment explicitly. Set both variables to the IDs from the previous step, without swapping them. For example:

```sh
CONVEX_DEPLOYMENT=dev:YOUR_DEV_DEPLOYMENT npx convex env set MUX_CAPTION_DIRECTIVE_WITHOUT_SPEAKERS_ID drv_PLAIN_ID
CONVEX_DEPLOYMENT=dev:YOUR_DEV_DEPLOYMENT npx convex env set MUX_CAPTION_DIRECTIVE_WITH_SPEAKERS_ID drv_SPEAKER_ID
```

After approval, deploy the backend from the same checkout as the new clients:

```sh
CONVEX_DEPLOYMENT=dev:YOUR_DEV_DEPLOYMENT npx convex dev --once --typecheck enable --tail-logs disable
```

Do not attach these Directives to the asset at upload creation. RoboTube starts the selected Directive after moderation passes. Attaching it earlier bypasses that gate and can duplicate caption generation.

Existing assets without the upload speaker-choice marker retain the legacy caption-generation path. New uploads default to speaker labels off, including requests from older clients that omit the optional field.

## Verify both upload choices

The next checks create billable workflow runs. Use approved test assets and perform them only after approval.

1. Upload a video with **Include speaker labels** off.
2. Confirm moderation passes before the plain Directive starts.
3. Confirm one premium-caption job supplies the ready source track.
4. Upload a multi-speaker video with the option on.
5. Confirm the speaker Directive starts and its premium job has `include_speakers: true`.
6. Open **Edit captions**, then **Speaker names**. Inspect the labels actually present in the transcript.
7. Queue a name for a discovered label and confirm the edit. Confirm a separate Robots `edit-captions` job runs.

The option requests speaker labels, not identification of real people. The editor does not invent labels when the returned track has none. Renames apply across matching leading labels, not to one timestamp.

Each generated caption track incurs the applicable premium-caption usage. A later confirmed rename incurs edit-caption usage. Directives have no separate orchestration charge.

## Check failures without repeating submissions

If an existing caption track conflicts with generation, inspect it before deciding whether to regenerate. This pipeline does not delete that track automatically.

If Directive submission has an unknown outcome, inspect Mux runs for the asset and the `captionDirectiveClaims` row. Do not delete the claim and retry blindly. Mux may already have accepted the request. Operator recovery must verify the asset, owner, selected variant, and matching run before changing local state.

A polling timeout is not proof that Mux failed. Reconcile the existing run when its job or output track becomes ready; do not create a second run.

## Run local regression checks

```sh
node --experimental-strip-types --test tests/*.test.ts tests/*.test.mjs
./node_modules/.bin/tsc --noEmit
npm --prefix web run typecheck
```

With a Vite server and a dedicated Chrome debugging endpoint, run the browser checks. These scripts replace Convex actions and upload transfer in their test tabs, so they do not create Mux jobs:

```sh
ROBOTUBE_WEB_URL=http://localhost:5177 node scripts/check-speaker-upload-browser.mjs
ROBOTUBE_WEB_URL=http://localhost:5177 node scripts/check-caption-robots-browser.mjs
```

The scripts default to Chrome debugging port `9224`. Set `CHROME_DEBUG_URL` to use another endpoint. Browser-width tests do not replace native-device tests or live Mux verification.

Sources: [Mux Directives](https://www.mux.com/docs/guides/robots-directives), [premium-caption parameters](https://www.mux.com/docs/guides/robots-generate-premium-captions#parameters), and [speaker replacements](https://www.mux.com/docs/guides/robots-edit-captions#speaker-replacements).
