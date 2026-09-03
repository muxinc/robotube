---
name: mux-robots-directives
description: Design and build Mux Robots Directives — pipelines that combine any Mux Robots AI workflows on an asset, including summarization, moderation, chapters, questions, key moments, caption and audio localization, premium caption generation and editing, scene detection, thumbnail selection, and engagement insights. Use when composing Robots jobs into ordered pipelines, adding a moderation gate before enrichment, auto-running AI workflows on ingest, or chaining resource-producing and resource-consuming workflows.
---

# Mux Robots Directive pipelines

Directives are the orchestration layer for Mux Robots: one declaration runs several AI workflows on an asset in the right order, with no glue code. A Directive can run **any Robots workflow**; the examples below are composition patterns, not an allowlist. This skill teaches how to *compose* workflows — the pipeline patterns and their limits. For the current API shapes, always fetch the directives guide first: https://www.mux.com/docs/guides/robots-directives.md (Robots is in Beta; shapes can change). Fetch the current workflow catalog from https://www.mux.com/docs/guides/robots and the linked per-workflow guide before choosing workflow names, parameters, inputs, or outputs.

## Workflow catalog


| Workflow | What it does |
| --- | --- |
| Summarize | Generate a title, description, and tags. |
| Moderate | Analyze inappropriate content. |
| Generate chapters | Create timestamped chapters. |
| Ask questions | Ask questions about a video and return structured answers. |
| Find key moments | Identify compelling moments. |
| Translate captions | Translate an existing caption track. |
| Translate audio | Dub spoken audio into another language. Experimental. |
| Generate premium captions | Generate high-accuracy captions with optional speaker labels and word-level timestamps. Experimental. |
| Edit captions | Apply static replacements and profanity censoring to an existing caption track. Experimental. |
| Find scenes | Segment a video into ordered, timestamped scenes with structured metadata. Experimental. |
| Find best thumbnails | Sample, score, and rank thumbnail frames. Experimental. |
| Generate engagement insights | Turn viewer engagement data into plain-language insights. Experimental. |

Treat this table as orientation, not a frozen schema. Re-fetch the catalog because workflows and experimental status can change. Fetch the selected workflow's guide for its exact `workflow` identifier, `params`, required or recommended inputs, output shape, and webhook name. Do not infer resource dependencies merely from a workflow's English description.

## The one rule that shapes every pipeline

Directive dependencies are **resource-based, not verdict-based**. A workflow binding can declare `inputs` naming resources (a caption track, shot detection) and the engine orders execution so producers run before consumers. But there is no conditional edge on a workflow's *output*: you cannot express "run summarize only if moderation came back clean" inside a single Directive, because moderation produces a verdict in its job `outputs`, not a resource on the asset.

Consequences:

- **Ordering you can declare**: "chapters needs captions" (resource exists) — the engine handles it.
- **Gating you must build**: "enrichment only if moderation passes" (verdict check) — split into two Directives with a webhook check between them (see the moderation gate pattern below).

Only two resource types exist as of this writing: `video.asset.track` (caption or audio tracks) and `video.asset.shots`. If a dependency isn't one of those, it's not expressible as a Directive edge — re-check the docs page for newly added types before concluding that, though.

## Pattern catalog

### 1. Fan-out (parallel enrichment)

Independent workflows in one Directive, no `inputs` between them — the engine runs them concurrently. Good default for "analyze everything on ingest": summarize + find key moments + find best thumbnails.

### 2. Chain (producer → consumer)

Declare a resource whose `source` is another binding; consumers list it in `inputs`:

```json
{
  "name": "Captions, then translate",
  "subject": { "type": "video.asset" },
  "resources": [
    { "reference_id": "captions_en", "type": "video.asset.track", "kind": "caption",
      "language": "en", "source": { "via": "workflow", "binding": "captions" } }
  ],
  "workflows": [
    { "reference_id": "captions", "workflow": "generate-premium-captions",
      "params": { "language_code": "en" } },
    { "reference_id": "translate_es", "workflow": "translate-captions",
      "inputs": ["captions_en"], "params": { "to_language_code": "es" } }
  ]
}
```

If the producer errors, consumers fast-fail with a diagnostic instead of waiting out the 24-hour resource cap.

### 3. Diamond (one prerequisite, many consumers)

Declare the shared resource once; every consumer lists it in `inputs`. Prefer this over generating captions twice: you pay per workflow run. This example is a full enrichment pipeline — captions auto-generated by the engine (`mux_api`, no Robots workflow needed), then fanned out to chapters, key moments, and summarize:

```json
{
  "name": "enrich-v1",
  "subject": { "type": "video.asset" },
  "resources": [
    { "reference_id": "captions_en", "type": "video.asset.track", "kind": "caption",
      "language": "en", "source": { "via": "mux_api", "action": "generate_subtitles" } }
  ],
  "workflows": [
    { "reference_id": "chapters", "workflow": "generate-chapters",
      "inputs": ["captions_en"] },
    { "reference_id": "key_moments", "workflow": "find-key-moments",
      "inputs": ["captions_en"] },
    { "reference_id": "summary", "workflow": "summarize",
      "inputs": ["captions_en"] }
  ]
}
```

The engine generates the caption track once, waits for it to become ready, then dispatches all three consumers concurrently. Note the judgment call on `summary`: captions are a *recommended* input for summarize — listing them in `inputs` trades robustness for quality (better summaries, but summarize now fails if caption generation does, e.g. on a silent video). Drop it from `inputs` if summarize should run regardless. Chapters genuinely requires captions, so its edge is non-negotiable.

### 4. Prerequisite without a workflow (`mux_api` / `external` / `required`)

The resource `source` policy covers prerequisites that aren't Robots workflows:

- `{ "via": "mux_api", "action": "generate_subtitles" }` — engine calls Mux Video to create the resource on demand (also: `create_track`, `request_shots`). Same rules as calling the API yourself: a silent video can't generate subtitles, and dependents fail with the reason in run output.
- `{ "via": "external" }` — wait (up to 24h) for a resource you upload out-of-band, e.g. human-authored captions.
- `{ "via": "required" }` — hard gate on resource *presence*: absent at run start → dependents fail immediately. This is the only gate Directives natively support, and it gates on existence, not on content.

### 5. Moderation gate (two Directives + webhook)

The pattern for "moderate first; run nothing else unless it passes" — the user-facing pipeline `moderate → (summarize, chapters, key moments)`:

1. **Directive A — "gate"**: contains only the `moderate` workflow. Attach it at asset creation (`"directives": [{ "id": "drv_gate" }]` on `POST /video/v1/assets`), so it runs automatically on ingest.
2. **Webhook handler**: subscribe to `robots.job.moderate.completed`. The payload's `data` is the full job object — read the moderation `outputs` directly (fetch `robots-moderate.md` for the current output shape and thresholds). Verify webhook signatures as with any Mux webhook.
3. **On pass**: `POST /robots/v0/directives/{DRV_ENRICH_ID}/runs` with the `asset_id` to trigger **Directive B — "enrich"** (the fan-out/chain of everything else — the diamond example in pattern 3 is exactly this shape). On fail: quarantine the asset app-side (e.g. remove playback IDs) and skip enrichment.

Why this decomposition is right, not a workaround: the gate check is ~10 lines of webhook handler, and it saves real money — enrichment workflows (translation and dubbing especially) never run on content you'd reject. State the split honestly in code comments: Directives handle ordering; the verdict branch is application logic.

### 6. Staged pipelines via multiple Directives

An asset can have several Directives attached (each runs once; attachment is idempotent). Use separate Directives for separable stages — a "gate" stage, an "enrich" stage, a "localize" stage triggered later when the user picks target languages. Note: if two Directives both include the same workflow, it runs twice — dedupe across your Directive set, not within it.

## Design judgment

- **Cheap gates before expensive workflows.** Order the pipeline so low-cost verdict checks (moderate) precede high-cost runs (translate-audio dubbing, premium captions in bulk). Directives are free; you pay per workflow run — check https://www.mux.com/docs/pricing.txt before designing a default-on ingest pipeline.
- **Directives are immutable.** Created config is locked; to change a pipeline, create a new Directive (or duplicate in the Dashboard) and re-attach. Version them in the name (`enrich-v2`) and keep the Directive ID in your app's config, not hardcoded at call sites.
- **One active run per Directive+asset pair** — a second trigger returns 409. Idempotent attach means "attach on every asset-create" is safe.
- **Test with a manual run first.** `POST /robots/v0/directives/{id}/runs` on one representative asset (or "Run on asset" in the Dashboard) before wiring the Directive into asset creation. Check `node_states` on the run for per-binding status.
- **Recommended vs. required inputs**: recommended inputs (captions for summarize) improve quality without blocking; only model a resource as a required `input` when the workflow genuinely can't run without it — every hard edge is a new failure path.

## Track and debug runs

- Subscribe to the run-level events: `robots.directive_run.created` / `.completed` / `.partial` / `.errored`. Individual jobs still fire their own `robots.job.<workflow>.<status>` events — use run-level for pipeline state, job-level for outputs. Multi-word workflows use underscores in event names (`robots.job.find_key_moments.completed`) but hyphens in endpoints.
- A failed binding doesn't kill the run: independent workflows continue; transitive dependents fail with a `reason`. `partial` is a terminal status — treat it as an alert, then read `node_states` (statuses: `dispatched`, `failed`, `waiting_for_resources`, `waiting_for_source_workflow`) to find the broken edge.
- Runs and jobs are retained 30 days — persist any `outputs` you care about.

## Prerequisites and guardrails

- Robots requires a Pay-As-You-Go plan or higher, accepted Robots terms per environment, and an access token with the `robots:*` scope. Check these before debugging "mysterious" 401/403s.
- Never guess workflow `params` or moderation output shapes from memory — fetch the specific `robots-<task>.md` guide. Robots is Beta; this skill's catalog and JSON examples were verified against the docs on 2026-08-07, and the live pages win on any drift.
- Directive runs cost real money per workflow triggered. When building a pipeline for a user, surface the per-ingest workflow count and get sign-off before attaching it to all asset creation.
