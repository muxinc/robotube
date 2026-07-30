# Shorts (9:16 Vertical Feed): Observability, Flags, and Operations

Engineering and operational notes for the vertical-feed work described in
[`vertical-video-feed-prd.md`](./vertical-video-feed-prd.md). Verification
status and the fixture set live in
[`vertical-video-feed-verification.md`](./vertical-video-feed-verification.md).

This document covers what is **implemented in this repository today**: the
Shorts telemetry vocabulary, the placement audit helpers, the two rollout flags,
the cohort ladder, the rollback plan, and the dashboard specifications.

It does **not** describe a running Shorts tab. At the time of writing there is
no `app/(tabs)/shorts.tsx`, no `listVerticalFeedVideosPaginated`, and no
`feedPlacement` column — those are Phases 1 through 5 and belong to the data and
UI lanes. Everything here is the scaffolding those phases plug into, plus the
gates they have to pass.

---

## 1. Module map

| Module | Purpose | Lifetime |
| --- | --- | --- |
| `lib/vertical-video-feed.ts` | Single import surface for everything below | Tooling |
| `lib/vertical-video-feed-fixtures.ts` | Fixture set, eligibility oracle, deterministic vertical feed | Test tooling |
| `lib/vertical-video-feed-audit.ts` | Placement distribution, coverage gate, exclusivity audit, backfill counters | Safe to call from a query |
| `lib/vertical-video-feed-scenarios.ts` | Shorts scenario matrix and the three checklists | Documentation data |
| `lib/vertical-video-feed-rollout.ts` | Cohort ladder, rollback plan, Shorts rollout guards | **Removed with the flags** |
| `lib/vertical-video-feed-dashboards.ts` | Saved-query and alert specifications | Until real dashboards exist |
| `lib/feed-performance-events.ts` | **Shared.** Event vocabulary and privacy sanitizer, now covering Shorts | Production-safe |
| `lib/feed-feature-flags.ts` | **Shared.** Flag registry, now including the two vertical flags | Removed with the flags |

Telemetry and flags are deliberately **not** re-exported from
`lib/vertical-video-feed.ts`. Shorts emits through the same
`@/lib/feed-performance` sink and reads the same `@/lib/feed-feature-flags`
registry that Home uses. A second import path for the same emitter is how two
vocabularies start.

---

## 2. Observability

### 2.1 What is reused and what is new

PRD section 13 says to extend the existing telemetry with `screen: "shorts"` and
add events only "where not already represented." That is what happened:

- **Reused verbatim** — `feed_query_started`, `feed_query_received`,
  `feed_first_cards_rendered`, `feed_candidate_changed`, `feed_focus_committed`,
  `feed_player_created`, `feed_player_attached`, `feed_player_detached`,
  `feed_source_replace_started`, `feed_playback_requested`, `feed_source_ready`,
  `feed_first_frame`, `feed_buffering_started`, `feed_buffering_ended`,
  `feed_playback_error`, and the five preload events. All 20 keep their names and
  their meaning; Shorts just tags them `screen: "shorts"`.
- **New, Shorts-only** — the ten names PRD section 13 lists.
- **Newly recognized runtime events** — `feed_playback_paused` and
  `feed_player_released`.

The Home contract is frozen at exactly 20 events and 12 common fields.
`FEED_PERFORMANCE_EVENT_NAMES` still returns those 20;
`ALL_FEED_PERFORMANCE_EVENT_NAMES` returns all 32.

### 2.1.1 The two runtime events that were being dropped

`lib/feed/feed-telemetry.ts` has emitted `feed_playback_paused` and
`feed_player_released` all along, but `trackFeedEvent` forwards an event only
when `isFeedPerformanceEventName` recognizes it — and neither name was in the
vocabulary. Both were **silently discarded before reaching the sink**, so the
lifecycle-pause and player-release signals that both feed PRDs describe as
"reuse the existing events" were never actually arriving.

`FEED_RUNTIME_EVENTS` recognizes them without touching either frozen contract
list. A regression test parses the runtime layer's own `FeedTelemetryEventName`
union and asserts that every name in it survives the filter, so the gap cannot
reopen the next time the runtime adds an event.

```ts
import {
  SHORTS_PERFORMANCE_EVENTS,
  emitFeedPerformanceEvent,
  hashPlaybackId,
} from "@/lib/feed-performance";

emitFeedPerformanceEvent(SHORTS_PERFORMANCE_EVENTS.shortsPageImpression, {
  session_id: sessionId,
  screen: "shorts",
  mux_asset_id: item.muxAssetId,
  playback_id_hash: hashPlaybackId(item.playbackId),
  feed_index: pageIndex,
  feed_placement: "vertical",
  is_muted: isMuted,
  page_height_dp: measuredViewportHeight,
});
```

### 2.2 The Shorts event vocabulary

| Event | Emitted when |
| --- | --- |
| `shorts_tab_opened` | The Shorts tab gains focus. |
| `shorts_page_impression` | A page becomes the committed item. |
| `shorts_manual_pause` | The user taps to pause. |
| `shorts_manual_resume` | The user taps to resume. |
| `shorts_muted` | The user mutes via the sound control. |
| `shorts_unmuted` | The user unmutes via the sound control. |
| `shorts_open_detail` | The user opens `/video/[muxAssetId]` from Shorts. |
| `shorts_retry_playback` | The user taps retry after a recoverable error. |
| `shorts_query_received` | A `listVerticalFeedVideosPaginated` page **resolves or fails**, carrying `query_outcome`. |
| `shorts_empty_state_viewed` | The empty state renders. |

A query failure is reported on `shorts_query_received` with
`query_outcome: "error"` and an `error_code`. It is deliberately *not* folded
into `feed_playback_error`: a page that failed to load and a video that failed
to decode are different incidents with different owners, and counting one as the
other makes both rates meaningless.

### 2.3 Fields

The 12 common fields are unchanged. Shorts adds seven, all bounded:

| Field | Type | Notes |
| --- | --- | --- |
| `feed_placement` | enum | `standard` \| `vertical` \| `unknown` |
| `item_count` | integer 0–10000 | Page size on `shorts_query_received` |
| `is_muted` | boolean | Session mute state |
| `retry_attempt` | integer 0–1000 | Which retry this is |
| `empty_reason` | enum | `no_vertical_assets` \| `query_error` \| `offline` \| `flag_disabled` |
| `page_height_dp` | integer 0–10000 | Measured content viewport, rounded to whole dp |
| `query_outcome` | enum | `success` \| `error`, on `shorts_query_received` |

None of the seven can carry a URL, a token, a title, a caption, or anything a
user typed. `page_height_dp` is rounded on purpose: an exact sub-pixel viewport
height is a needlessly precise device signature and nothing downstream needs it.

### 2.4 The privacy contract

Unchanged and now covering Shorts. `sanitizeFeedEventFields` drops every key
outside the union allowlist and redacts allowlisted keys whose values fail a
shape or privacy check — URLs of any scheme, `token=`/`signature=`/`policy=`
query material, bearer tokens, JWTs, `.m3u8`/`.mpd`/`.mp4`/`.ts`/`.m4s`
references, PEM private keys, and any string over 200 characters.

Adding Shorts adds **no new privacy surface**: every new field is an enum, a
boolean, or a small integer, so there is no new place for free text to hide. The
Shorts suite asserts this directly by feeding forbidden material through the new
field names.

`screen: "shorts"` is now a recognized value, so a Shorts event is not silently
stripped of its screen tag.

### 2.5 Classification diagnostics

PRD section 13 also asks for aggregate diagnostics that are not per-event.
Those come from `lib/vertical-video-feed-audit.ts`, fed by a Convex read-only
audit query (Phase 1, not yet written):

```ts
import { buildPlacementDiagnostics, formatPlacementDiagnostics } from "@/lib/vertical-video-feed";
import { classifyAspectRatio } from "./aspectClassification"; // Phase 1, Convex-side

const diagnostics = buildPlacementDiagnostics({
  rows,                       // from the audit query
  classify: classifyAspectRatio,
  documentedExceptions,       // assets allowed to stay unknown, with reasons
  exclusivity: { homeAssetIds, shortsAssetIds, eligibleAssetIds, exclusivePlacementActive },
  backfill: { scanned, classified, unknown, unchanged, failed },
});

console.log(formatPlacementDiagnostics(diagnostics));
```

`lib/vertical-video-feed-audit.ts` has **no runtime imports** — its single
`import type` is erased at compile time — so it is safe to call from a Convex
query. The classifier is injected rather than imported, for two reasons:
importing one would break that property, and defining one would create a second
implementation of section 7.2 that could drift from production. An audit that
disagrees with the thing it audits reports its own bugs as data problems.

The unit suite injects the fixture oracle; the Convex query injects the
production classifier. `findFixtureOracleDisagreements(productionClassifier)`
cross-checks the two against all 42 recorded expectations, so "they agree" is a
test rather than an assumption.

#### What the audit actually checks

- **Placement is re-derived, never trusted.** Every ready row's stored
  `aspectRatio` is re-normalized and compared to its stored `feedPlacement`.
  Mismatches are reported as `placement_disagrees`, `ratio_not_reduced`,
  `ratio_unparseable`, or `placement_without_ratio`. Trusting the column would
  make the audit tautological.
- **An unparseable stored ratio always fails**, even when the placement is
  honestly `unknown`. Section 7.1 types the field as a normalized
  `string | null`, so `aspectRatio: "garbage"` is a contract violation whatever
  the placement says — `unknown` does not launder it. The correct
  representation is `null`.
- **Exceptions are matched by asset id, not counted.** Counting was the earlier
  shape and it was wrong quietly: three entries naming assets that no longer
  exist would fully excuse three real unknown rows nobody had looked at. A wrong
  id now excuses nothing and a duplicated id excuses one row, not two. Stale
  entries are reported for pruning but do not fail the gate, because matching
  already prevents them from doing harm.
- **Duplicate ids fail both gates.** A repeated ready row fails coverage; a feed
  returning the same asset twice fails exclusivity. Collapsing inputs to a `Set`
  first would erase exactly the paging bug PRD section 12's "duplicate or
  cursor-lost cards = 0" metric is about.

Every gate can return `"unmeasured"`, and an unmeasured gate is never a passing
gate. A deployment that has never been scanned and a deployment that is fully
classified must not produce the same verdict.

---

## 3. Feature flags

Two flags, both default-off, both registered in the shared registry alongside
the four news-feed flags.

| Flag | Phase | Owner | Removal date | Kill-switchable | Needs physical Android validation |
| --- | --- | --- | --- | :---: | :---: |
| `shortsTabEnabled` | Vertical feed Phase 7 | vertical-feed | 2026-12-31 | no | **yes** |
| `exclusiveFeedPlacementEnabled` | Vertical feed Phase 7 | vertical-feed-data | 2026-12-31 | no | no |

`findExpiredFeedFeatureFlags(todayIso)` lists flags past their removal date, so
the cleanup gate is checked mechanically rather than remembered.

### 3.1 What each flag controls

**`shortsTabEnabled`** — registers the Shorts native tab and allows its query,
playback, and preload work. Off means the tab is absent and no Shorts query
runs. Home is untouched either way.

**`exclusiveFeedPlacementEnabled`** — moves Home to the placement index with
`feedPlacement == "standard"`. Off means Home keeps its migration query and may
also show exact 9:16 assets, which is the intended state for most of the
rollout.

> **Status.** Both flags exist, resolve, and are tested. Neither is *consumed* by
> a runtime path yet, because the tab and the placement query do not exist. The
> registry half is done; the wiring lands with Phases 3 and 2 respectively.

### 3.2 Resolution order

Strongest last:

1. Registry `defaultValue` (always `false`)
2. Remote config value
3. Deterministic rollout-cohort bucketing
4. Android physical-validation gate
5. Local developer override
6. Preload kill switch
7. **Cross-flag dependency gate**

Two rules bend that ladder, both only ever disabling.

**A remote `false` is authoritative over a percentage rollout.** Step 3 normally
overwrites step 2, which meant a remote kill could be undone by a rollout
percentage still sitting in config — usually one nobody remembered to zero. An
explicit remote `false` now short-circuits the rollout step and reports
`reason: "…rollout ignored"`. Only a local developer override, which exists for
debugging and never ships enabled, can still turn it on afterwards. This applies
to every flag in the registry, not just the vertical ones.

**The dependency gate runs last and cannot be out-voted.** See 3.4.

`shortsTabEnabled` carries `requiresAndroidPhysicalValidation`, so it resolves
`false` on Android unless `androidPhysicalValidationCompleted: true` is passed
explicitly. No physical Android device is attached to the development machine,
so **that value must stay false**.

`exclusiveFeedPlacementEnabled` is exempt from the Android gate itself — a
Convex placement filter does not depend on Android hardware behavior — but it is
still forced off on Android by the dependency gate, because the tab it depends
on is gated off there.

### 3.3 The preload kill switch does not touch Shorts

Neither vertical flag is `killSwitchControlled`. Engaging the preload kill
switch because of memory pressure relieves preload pressure; it is not a reason
to take away a whole tab. Shorts has its own first-lever rollback, below.

### 3.4 The dependency gate

`FEED_FLAG_DEPENDENCIES` declares one rule:

> `exclusiveFeedPlacementEnabled` requires `shortsTabEnabled` — exclusive
> placement removes exact 9:16 assets from Home, and with no Shorts tab they
> appear in neither feed.

This is **enforced during resolution, not merely reported afterwards**. Any
consumer reading `resolveFeedFeatureFlags` or `isFeedFeatureEnabled` sees
`exclusiveFeedPlacementEnabled` resolve `false` the moment the Shorts tab is
off, whichever step turned the tab off:

| How the tab ends up off | Exclusive placement |
| --- | --- |
| never enabled | `false` (`dependency_gate`) |
| remote `false` | `false` (`dependency_gate`) |
| rollout with no `stableId` | `false` (`dependency_gate`) |
| Android validation gate | `false` (`dependency_gate`) |
| local override off | `false` (`dependency_gate`) |

Reporting a violation would not have been enough. A runtime consumer that reads
the flag without also calling `findFlagCombinationViolations` — which is every
consumer that just wants to know which query to run — would have gone on hiding
exact 9:16 assets from both feeds. The Android case is the sharpest: the gate
turns the tab off *after* exclusive placement has already resolved on, so every
Android install would have hit it.

This is the one thing PRD section 15 forbids: the rollout may temporarily
duplicate a video between Home and Shorts, "but never allows a classified video
to disappear from both feeds."

`findFlagCombinationViolations` still names the combination. It is now defense
in depth for resolutions assembled by hand — a test fixture, a config preview
screen — so the invariant stays written down rather than silently assumed.

---

## 4. Cohort ladder

PRD Phase 7: team → internal beta → small production cohort → staged increase →
100%. Encoded in `SHORTS_COHORT_STAGES`.

| Stage | Mechanism | Percent | Min observation | Exit criteria |
| --- | --- | ---: | ---: | --- |
| `team` | local override | — | 24 h | `team-acceptance`, `team-no-p0-p1`, `team-invariants` |
| `internal-beta` | remote targeting | — | 72 h | `beta-query-errors`, `beta-empty-rate`, `beta-no-crash-memory-regression`, `beta-home-regression` |
| `production-small` | percentage | 5% | 48 h | `small-first-frame`, `small-buffering`, `small-playback-errors`, `small-classification-unknowns`, `small-invariants`, `small-home-regression` |
| `staged-increase` | percentage | 25% | 48 h | `staged-metrics-hold`, `staged-home-regression`, `staged-support-volume` |
| `full` | percentage | 100% | 168 h | `full-week-clean`, `full-exclusivity-audit`, `full-home-regression`, `full-removal-owner` |

Read the full statements from `SHORTS_COHORT_STAGES`; each criterion carries an
id, a statement, and whether it is judged `instrumented`, `observed`, or
`automated`.

The observation windows are **proposals**. They are the thing to argue about
before a ramp, not during one.

iOS-only throughout. Android stays off for the whole ladder until a physical
Android device validates behavior.

`exclusiveFeedPlacementEnabled` gets no ladder of its own. It ramps only after
Shorts reaches `full` and the exclusivity audit passes
(`EXCLUSIVE_PLACEMENT_PREREQUISITE_STAGE_ID`), because turning it on earlier
removes 9:16 assets from Home for users who cannot see the Shorts tab.

### 4.1 Judging a cohort

```ts
const readiness = evaluateCohortReadiness({
  stageId: "production-small",
  observedHours: 48,
  metrics: {
    emptyStateRateRatio,
    queryErrorRateRatio,
    classificationUnknownCount,
    playerInvariantViolationCount,
    feedOmissionCount,
  },
  criterionAttestations: {
    "small-first-frame": { met: true, note: "run sheet 2026-08-04, warm p75 244 ms" },
    "small-buffering": { met: true, note: "dashboard shorts-buffering, 7-day view" },
    // ... one entry per criterion, each with evidence
  },
});
```

Three independent things must all hold before this reports `ready`:

1. the observation window has been served;
2. every guard metric is supplied, usable, and within threshold;
3. **every** exit criterion has an attestation with a non-empty evidence note.

The third is the one that is easy to skip. Metrics cover first frame, buffering,
playback errors, unknowns, and omissions — but no counter can answer "the Home
regression checklist passed", "no P0 is open", or "migration code has a removal
owner". Without a per-criterion attestation a stage could report `ready` while
nobody had looked at those at all. An attestation with `met: true` and no note
is a checkbox, not evidence, and is treated as missing.

**`blocked` versus `unmeasured`** is consistent across all three inputs, and
neither is ever `ready`, so the function is fail-closed either way:

| Input | Evidence says no → `blocked` | No evidence → `unmeasured` |
| --- | --- | --- |
| observation time | short of the window, or an unusable duration | not supplied |
| guard metrics | breached, unusable value, or unusable threshold | not supplied |
| exit criteria | attested `met: false` | absent, or attested with no note |

### 4.2 Metric and threshold validation

`evaluateShortsRolloutGuards` sorts each metric into one of three buckets:

- **not supplied** → `unmeasuredMetrics`. Never a pass, never a breach.
- **supplied but unusable** → `invalidMetrics`, and the rollout pauses. NaN,
  ±Infinity, negative, a ratio above 1, or a fractional count all land here. A
  pipeline emitting NaN is broken, and ramping on a broken pipeline is ramping
  blind; folding these into "unmeasured" would make a silent instrumentation
  failure indistinguishable from a metric nobody wired up yet.
- **supplied and usable** → compared against its threshold.

**Thresholds are validated too**, and this matters more than it looks. Because
`anything > NaN` is `false`, a single NaN threshold would make its metric
incapable of ever breaching: the dashboard would show a catastrophe and the
guard would report a pass. A threshold that is not finite, is negative, is a
ratio above 1, or is a non-integer count lands in `invalidThresholds`, its
metric is not judged at all, and the rollout pauses.

Two breaches escalate past "pause" to "roll back now":

- **`feed_omissions`** — an asset is in neither feed. Users cannot see content
  that exists.
- **`player_invariant_violations`** — more than one video playing or more than
  one surface attached.

Neither gets better by waiting for the next observation window. Everything else
pauses the ramp. An *invalid* value never triggers automatic rollback — garbage
input is a reason to stop and look, not a reason to act as though the worst case
is confirmed.

Keep feeding the shared `evaluateRolloutGuards` in parallel: it still owns crash
rate, memory-warning rate, playback-error rate, and wrong-video incidents.

---

## 5. Rollback

**Owner: the `vertical-feed` team.** Same owner as `shortsTabEnabled`, because
the first lever is that flag.

### 5.1 The ordered plan

```ts
const plan = buildShortsRollbackPlan(resolveFeedFeatureFlags(context));
```

PRD Phase 7 says: "Roll back by disabling the Shorts tab first; disable
exclusive placement if Home must temporarily show all assets again."

Disabling the tab first is right — it is the lever that stops playback, memory,
and query load immediately, and it does so without touching Home.

The obvious worry is that doing so while `exclusiveFeedPlacementEnabled` is
still on would strand exact 9:16 assets in no feed at all. **It does not**,
because the dependency gate (section 3.4) makes exclusive placement resolve
`false` in the same pass: Home reverts to the migration query and serves every
ready asset again the moment the tab goes away.

Step 2 therefore exists as **cleanup, not rescue** — it clears the stored config
value so that re-enabling the tab later does not silently restore exclusivity
along with it. Every step still reports `leavesVerticalAssetsUnreachable`, and
the suite asserts it is `false`, so the guarantee is checked rather than
remembered.

| Current state | Steps | Unreachable window |
| --- | --- | :---: |
| Both flags on | 1. disable `shortsTabEnabled` (Home reverts immediately) 2. clear `exclusiveFeedPlacementEnabled` | no |
| Tab on, exclusive off | 1. disable `shortsTabEnabled` | no |
| Both off | none | no |

### 5.2 What rollback costs

- **Disabling `shortsTabEnabled`** — the tab disappears. Every 9:16 asset stays
  reachable through Home (while exclusive placement is off), search, profile,
  and the detail route. No data is lost; no schema changes.
- **Disabling `exclusiveFeedPlacementEnabled`** — Home returns to the migration
  query and shows standard, unknown, *and* vertical placements. The worst case
  is a temporary duplicate between Home and Shorts, never a missing video.

Schema fields (`aspectRatio`, `feedPlacement`, `aspectRatioUpdatedAtMs`) and the
`by_feed_placement_ready_deleted_created` index may remain in place when the
feature is disabled. They are inert when nothing queries them, and removing them
would make re-enabling the feature a migration instead of a flag flip.

### 5.3 Rehearsal

**Not rehearsed.** PRD Phase 7's exit gate "Rollback has been rehearsed without
data loss" requires a deployment with the feature enabled, which does not exist.
The plan above is implemented and unit-tested; it has never been executed
against a real deployment.

---

## 6. Dashboards and saved queries

`SHORTS_DASHBOARD_PANELS` specifies ten panels covering the eight subjects PRD
Phase 7 names, plus exclusivity and engagement depth.

| Panel | Answers | Alert | Severity |
| --- | --- | --- | --- |
| `shorts-tab-opens` | How many sessions reach Shorts | — | — |
| `shorts-query-errors` | Share of Shorts queries that fail | `query_outcome == "error"` >1% over 30 min | page |
| `shorts-empty-rate` | How often Shorts renders empty, and why | any `query_error`, or >20% of opens | ticket |
| `shorts-first-frame` | p50/p75/p95, cold vs. warm | warm p75 >300 ms, cold p75 >1.2 s | ticket |
| `shorts-buffering` | Stall frequency and duration | >20% above Home baseline | watch |
| `shorts-playback-errors` | Error-code distribution and retry recovery | >1.2× Home baseline | page |
| `shorts-classification-unknowns` | Ready assets with unknown placement | any undocumented unknown | ticket |
| `shorts-player-invariants` | More than one playing video or attached surface | any violation | page |
| `shorts-feed-exclusivity` | Assets in both feeds, or in neither | any asset in neither feed | page |
| `shorts-page-impressions` | How many pages a session watches | — | — |

### 6.1 These are specifications, not dashboards

Robotube has no analytics backend wired into `setFeedPerformanceSink`. Nothing
in this module queries anything. Creating the panels in whatever tool the team
picks is an external step, and it is **not** claimed as done.

What the specifications do buy is a machine-checkable definition.
`findDashboardSpecViolations()` proves that every event a panel names exists in
the emitted vocabulary and every field it groups by survives the privacy
sanitizer. That check matters more than it sounds: a dashboard grouping by a
field the sanitizer strips renders one bucket forever, and the failure looks
like "no data" rather than like a bug.

`findUnsanitizableProbeFields()` goes one step further and pushes a
representative value through the real sanitizer for every allowlisted field, so
a field that is allowlisted but shape-checked more strictly than a panel assumes
is caught too.

### 6.1.1 Query errors are not playback errors

`shorts-query-errors` reads **only** `shorts_query_received`, filtered on
`query_outcome == "error"`. It deliberately does not read `feed_playback_error`.
Counting decode failures as query failures would inflate the query-error rate,
hide the real one, and page the wrong owner. Decode failures belong to
`shorts-playback-errors`, and the suite asserts the two panels do not share
event sources.

### 6.2 Provisional thresholds

Four alert thresholds are ratios against a production baseline that does not
exist yet, and they are marked `provisional: true` in the data:
`shorts-query-errors`, `shorts-empty-rate`, `shorts-buffering`,
`shorts-playback-errors`. Review them before the 5% ramp. The rest are absolutes
the PRD states directly (zero unknowns, zero invariant violations, zero
omissions, the section 12 latency targets).

---

## 7. Runbook

### 7.1 Before any ramp

1. Phases 1 through 5 are merged: classification, the indexed query, the tab, the
   playback integration, and the overlay.
2. The Phase 6 verification record has real physical-device numbers in it. See
   [`vertical-video-feed-verification.md`](./vertical-video-feed-verification.md)
   for what is and is not measured today.
3. The backfill has run and `evaluateClassificationCoverageGate` returns `pass`
   — not `unmeasured`.
4. `auditFeedExclusivity` returns `pass` with zero omissions.
5. Dashboard panels exist in the analytics tool and the provisional thresholds
   have been reviewed against real traffic.

### 7.2 Ramping

Follow the ladder in section 4. At each stage:

```ts
const decision = evaluateShortsRolloutGuards(metrics);
if (decision.shouldRollBackImmediately) executeRollback();
else if (decision.shouldPauseRollout) pauseRamp(decision.breachedMetrics);
```

A metric that was not supplied is reported in `unmeasuredMetrics` and never
counts as a pass. Getting a green light by omission is the specific failure mode
this design refuses to allow.

### 7.3 Enabling exclusive placement

Only after Shorts is stable at `full`:

1. Confirm `evaluateClassificationCoverageGate` still returns `pass`.
2. Confirm `auditFeedExclusivity` with `exclusivePlacementActive: false` shows
   the expected duplicates and **zero** omissions.
3. Enable `exclusiveFeedPlacementEnabled` for the team cohort first.
4. Re-run the exclusivity audit with `exclusivePlacementActive: true`. Duplicates
   must now be zero.
5. Ramp on the same ladder.

### 7.4 If something goes wrong

1. Run `buildShortsRollbackPlan` against the current resolved flag state.
2. Execute every step it returns. If `hasUnreachableWindow` is true, execute both
   in one operation — do not stop after step 1.
3. Re-run the exclusivity audit and confirm zero omissions.
4. File the breached metric against the panel that caught it.

---

## 8. Verification

```bash
node scripts/vertical-video-feed-tests.mjs                     # 93 pure unit tests
node scripts/vertical-video-feed-fixtures.mjs                  # fixture summary
node scripts/vertical-video-feed-fixtures.mjs --format markdown
node scripts/vertical-video-feed-run-sheet.mjs                 # tooling probe + blank run sheet
node scripts/news-feed-tests.mjs                               # Home suite, must stay green
node scripts/run-tests.mjs
npm run lint
npx tsc --noEmit
```

`scripts/vertical-video-feed-load-lib.mjs` compiles the vertical modules to
CommonJS in a temp directory using the existing TypeScript dev dependency, so
the tests run on Node's built-in `node:test` with no new packages. Every run is
also a standalone type check of these modules in isolation from the app.

---

## 9. Cleanup checklist

- [ ] Remove `lib/vertical-video-feed-rollout.ts` when both flags are removed.
- [ ] Remove `shortsTabEnabled` and `exclusiveFeedPlacementEnabled` after
      2026-12-31; verify with `findExpiredFeedFeatureFlags`.
- [ ] Remove the migration-only Home query once exclusive placement is at 100%.
- [ ] Keep the Shorts event vocabulary and the sanitizer; they are production
      telemetry, not scaffolding.
- [ ] Keep `lib/vertical-video-feed-audit.ts` as long as the placement audit
      query exists.
- [ ] Fold `lib/vertical-video-feed-fixtures.ts` into whatever test setup the
      repo standardizes on, if one is ever added.
