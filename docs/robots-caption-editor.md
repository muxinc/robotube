# Robots caption editor

RoboTube's web and mobile caption editors submit rules to the Mux Robots `edit-captions` workflow. They do not upload a manually rewritten transcript.

The transcript provides context for choosing corrections. A selected word or phrase becomes a replacement rule across the source track, not a change limited to the selected timestamp. Speaker renames target bracketed labels at the start of cues. Profanity censoring runs in the same Robots job when enabled.

These operations follow the [Mux caption-editing guide](https://www.mux.com/docs/guides/robots-edit-captions).

## Preview and submission

Both clients use `lib/captionRobots.ts` to display an estimated preview and affected-cue count. Mux owns the actual matching behavior and operation order. AI profanity changes cannot be previewed locally. The completed job's replacement count is authoritative.

`captionEditingNode.loadOwnCaptionDocument` returns timestamped cues, the source track ID, and the caption revision. The clients pass that track ID and revision to `captionEditingNode.editCaptionsForAsset` with:

- `replacements`, containing `find`, `replace`, and optional `caseSensitive` values.
- `speakerReplacements`, containing speaker names without brackets.
- Optional `autoCensorProfanity`, containing the selected mode.

An empty replacement deletes matching text. Identical find and replacement values remain useful for case-insensitive capitalization normalization. The clients reject rules with no estimated effect unless profanity censoring is enabled.

The server checks ownership, track readiness, the current source track, and revision. A transactional reservation excludes concurrent caption jobs and active translations. The request contains `upload_to_mux: true` and `replace_existing_tracks: "replace"`, without deprecated track-replacement parameters.

The UI retains queued rules after a rejected request or an `alreadyActive` response. A newly accepted job clears the submitted rules. Both editors display the Mux job ID and status. Mobile keeps that status visible while editing is locked.

## Track replacement and failures

Mux deletes the source before adding the edited track. If adding fails, Mux attempts to restore the source under a new track ID. Restoration is best effort. The confirmation screen states this risk, and RoboTube does not promise caption revision history.

A confirmed failed Robots job triggers source reconciliation. RoboTube can recognize a restored source only when the original ID is absent and one ready text track matches the recorded source name and language. The metadata update checks ownership, the latest job, the expected revision, the source ID, and the deletion tombstone in one mutation transaction.

A verified restoration rebinds the track ID without changing the text revision or invalidating dependent AI results. Readiness and transient retrieval failures get up to six additional checks, ten seconds apart. Missing or ambiguous restored sources remain unavailable and require operator recovery. Recovery does not delete tracks.

Ambiguous job creation, including HTTP 408, server errors, and network failures, keeps its reservation. RoboTube does not blindly repeat a potentially accepted Robots POST.

The existing completion workflow refreshes the caption track and dependent data after success. Legacy manual-upload recovery remains available for older jobs, but neither current editor calls `replaceOwnCaptionTrack`. Historical manual-only jobs are labeled as legacy track updates, not Robots jobs.

## Code and regression coverage

- Web UI: `web/src/components/CaptionCleanup.tsx`
- Mobile UI: `app/video/[muxAssetId]/edit-captions.tsx`
- Shared rules and previews: `lib/captionRobots.ts`
- Mobile confirmation lifecycle: `lib/captionRobotsMobile.ts`
- Server actions and job state: `convex/captionEditingNode.ts` and `convex/captionEditing.ts`
- Rules, requests, restoration, and client regressions: `tests/caption-robots-*.test.ts`

The browser regression script exercises the actual web component with mocked Convex hooks. It checks transcript selection, global previews, speaker renaming, profanity options, request payloads, failed submissions, duplicate submission, job progress, refreshed captions, and a narrow viewport. It creates no live Mux jobs.

It requires a Vite development server and a dedicated Chrome remote-debugging instance. The script defaults to `http://localhost:5175` and `http://127.0.0.1:9224`. `ROBOTUBE_WEB_URL` and `CHROME_DEBUG_URL` override those addresses. `ROBOTUBE_SCREENSHOT_PATH` optionally captures the final viewport.

```sh
node scripts/check-caption-robots-browser.mjs
node --experimental-strip-types --test tests/*.test.ts
./node_modules/.bin/tsc --noEmit
npm --prefix web run typecheck
npm --prefix web run build
```

A passing local browser test does not verify Mux billing, live webhook delivery, or native keyboard and screen-reader behavior. Backend deployment and a live owner-account smoke test remain separate rollout steps.
