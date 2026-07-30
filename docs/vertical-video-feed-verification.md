# Shorts (9:16 Vertical Feed): Fixtures and Verification Record

Phase 0 fixture record and Phase 6 verification status for
[`vertical-video-feed-prd.md`](./vertical-video-feed-prd.md). Flags, cohorts,
rollback, and dashboards live in
[`vertical-video-feed-operations.md`](./vertical-video-feed-operations.md).

**Status: fixtures and rule-level verification complete; no runtime verification
performed.** Nothing in this document is estimated, extrapolated, or copied from
another project. Every device-measured cell is explicitly `NOT MEASURED`.

- Recorded on: 2026-07-30
- Branch: `herdr/vertical-quality`
- Base commit: `39b2290`
- Node v22.17.1, TypeScript 5.9.3

---

## 1. What exists, and what does not

The vertical feed is a nine-phase project. This branch owns the verification,
observability, fixture, flag, rollout, and documentation slice. It is important
to be blunt about what that means for a verification record:

| PRD phase | State on this branch |
| --- | --- |
| Phase 0 — baseline | Fixtures **done**. Asset-inventory capture and Home baseline **not done** (need production data and a device run). |
| Phase 1 — classification and cache migration | **Not present.** No `aspectRatio` or `feedPlacement` column, no backfill, no audit query. |
| Phase 2 — indexed queries | **Not present.** No `listVerticalFeedVideosPaginated`. |
| Phase 3 — tab and paged screen | **Not present.** No `app/(tabs)/shorts.tsx`. |
| Phase 4 — playback, focus, preload | **Not present**, except the telemetry vocabulary Shorts will emit. |
| Phase 5 — overlay and accessibility | **Not present.** |
| Phase 6 — verification | Rule-level tests, scenarios, and checklists **done**. Every runtime, device, and performance item **not done**. |
| Phase 7 — flags and operations | Flag registry, cohorts, rollback plan, dashboard specs, runbook **done**. Consumption, real dashboards, and rehearsal **not done**. |

Verified at `39b2290` by grepping the whole repository: `feedPlacement`,
`aspect_ratio`, and `shorts` appear in no `.ts`, `.tsx`, or `.mjs` file outside
the modules this branch added.

So: this document can honestly say the *rules* are right. It cannot say anything
about a running app, because there is no Shorts screen to run.

---

## 2. The fixture set

`lib/vertical-video-feed-fixtures.ts`. Hand-authored, order-stable, and free of
wall-clock and random input, so the same 42 cases reach a unit test, a seeded
deployment, and a reviewer.

| Group | Count | Meaning |
| --- | ---: | --- |
| `qualifying` | 12 | Exact or reducible 9:16, fully eligible |
| `nonqualifying_ratio` | 8 | Valid ratio that is not 9:16 |
| `malformed_ratio` | 16 | Missing, malformed, zero, negative, non-integer, or oversized |
| `visibility_excluded` | 6 | Exactly 9:16 but excluded by a section 7.3 rule |
| **Eligible for Shorts** | **12** | |
| **Must never appear in Shorts** | **30** | |

The PRD asks for at least 10 of each. Reproduce the table with:

```bash
node scripts/vertical-video-feed-fixtures.mjs --format markdown
```

### 2.1 Qualifying — exact and reducible 9:16

| Fixture | Source | Why it is here |
| --- | --- | --- |
| `exact-9-16` | `9:16` | Already reduced; the canonical case |
| `hd-1080-1920` | `1080:1920` | Standard phone portrait upload |
| `hd-720-1280` | `720:1280` | 720p portrait |
| `qhd-1440-2560` | `1440:2560` | QHD portrait |
| `sd-540-960` | `540:960` | Half-HD portrait |
| `uhd-2160-3840` | `2160:3840` | 4K portrait |
| `low-360-640` | `360:640` | Low-resolution portrait |
| `odd-1170-2080` | `1170:2080` | Reduces only via a GCD of 130 |
| `odd-450-800` | `450:800` | Reduces via a GCD of 50 |
| `uhd-4320-7680` | `4320:7680` | 8K portrait; largest realistic case |
| `small-288-512` | `288:512` | Reduces via a GCD of 32 |
| `odd-1620-2880` | `1620:2880` | Reduces via a GCD of 180 |

### 2.2 Non-qualifying ratios

`16:9`, `1920:1080` (→ `16:9`), `4:5`, `2:3`, `10:16` (→ `5:8`), `1:1`, `21:9`
(→ `7:3`), and a second `16:9` asset proving two rows may share a ratio.

`4:5`, `2:3`, and `10:16` are the deliberate traps. Qualification is exact after
reduction; there is no tolerance band, however close a ratio gets.

### 2.3 Malformed and out-of-domain

Absent, `null`, `""`, `0:16`, `9:0`, `-9:16`, `9:-16`, `9.5:16`, `0.5625`,
`9x16`, `9:16:1`, `" 9:16"`, `"9 : 16"`, `9e0:16`,
`9007199254740993:16012798674205320`, and a numeric `0.5625` payload.

Each carries a specific `unknownReason` (`missing`, `not_a_string`, `empty`,
`contains_whitespace`, `malformed`, `non_integer`, `non_positive`,
`unsafe_integer`) so a diagnostic can say *why* an asset went unknown, not just
that it did.

### 2.4 Vertical but excluded by a visibility rule

Status not ready, `isReady: false`, deleted, no playback ID, empty playback ID,
and feed-visibility denied. All six still classify as `vertical` — placement and
eligibility are separate questions, and conflating them is how a deleted asset
ends up back in a feed.

### 2.5 Two contract decisions worth arguing with

Both are written down because the Phase 1 classifier has to match them, and both
lean the same way — toward the PRD rule that a missing or invalid ratio is
`unknown` and is never assumed to be 9:16.

1. **Whitespace is not tolerated.** `" 9:16"` is `unknown`, not `vertical`. Mux
   does not emit padded values, so padding means something upstream reformatted
   the field. Downgrading to `unknown` keeps the asset on Home rather than
   guessing.
2. **Unsafe integers are `unknown`.** Reducing them would run a GCD over values
   that have already lost precision.

### 2.6 Keeping the production classifier honest

`findFixtureOracleDisagreements(classifier)` runs any candidate classifier over
all 42 fixtures and reports disagreements per fixture and per field. When the
Convex classifier lands, the data lane can assert against this set without
importing the module into Convex.

The suite proves the check bites: a deliberately tolerant classifier that maps
`4:5` to `9:16` produces three disagreements on `portrait-4-5`, one for each of
`aspectRatio`, `feedPlacement`, and `eligibleForShorts`.

### 2.7 The deterministic 50-item feed

`createDeterministicVerticalFeed({ count, seed, playbackIds })` produces a
byte-stable page of Shorts cards. Same seed and count, same JSON. It delegates
to the news-feed generator so both feeds share one card contract and one seeding
scheme, then rewrites the thumbnail to a 9:16 smart crop.

**Without `playbackIds` the generator emits `synthetic-not-playable-` IDs that
will not resolve against Mux.** The scroll, memory, and first-frame scenarios
need real exact-9:16 playback IDs passed in. The generator alone does not
satisfy "a deterministic test feed of playable videos."

---

## 3. Reference devices

Shared with the news-feed baseline; not re-surveyed here, because it is the same
machine on the same day. See
[`news-feed-performance-baseline.md`](./news-feed-performance-baseline.md)
sections 2.1 to 2.3 for the full record.

| Profile | Kind | Validity | Availability |
| --- | --- | --- | --- |
| iPhone 14 Pro (`iPhone15,2`), iOS 26.5.2 | physical | performance | **observed** — the Shorts performance reference |
| iOS Simulator (iPhone 17 Pro / iPhone 16e) | simulator | functional-only | observed |
| Android emulator (`Medium_Phone_API_36.1`) | emulator | functional-only | observed |
| Constrained Android emulator | emulator | functional-only | **not configured** |
| Physical Android | physical | performance | **unavailable** |

Re-probe the live state with `node scripts/vertical-video-feed-run-sheet.mjs`,
which reports what the tooling commands actually return rather than what this
table claims.

**No physical Android device is attached.** `shortsTabEnabled` carries
`requiresAndroidPhysicalValidation`, so Android exposure is blocked by the flag
resolver, not by a promise. This is a rollout dependency, not a Phase 0 blocker.

---

## 4. What was verified

Run on 2026-07-30 against `39b2290` plus this branch's changes.

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | **Pass**, no diagnostics |
| `npm run lint` (`expo lint`) | **Pass**, no findings |
| `node scripts/vertical-video-feed-tests.mjs` | **Pass** — 93/93 |
| `node scripts/news-feed-tests.mjs` | **Pass** — 52/52, unchanged from before this branch |
| `node scripts/run-tests.mjs` | **Pass** — 56/56 across 15 suites |
| `node --experimental-strip-types --test tests/feed-contracts.test.ts` | **Pass** — 22/22 |
| `node scripts/vertical-video-feed-fixtures.mjs` | **Pass** — 42 fixtures, zero oracle disagreements |
| `node scripts/vertical-video-feed-run-sheet.mjs` | **Pass** — probes tooling, emits a blank run sheet |

### 4.1 What the 93 new tests actually cover

- **Classification (6 tests)** — exact and reducible 9:16; valid non-9:16 ratios
  and their reduced forms; near-portrait traps rejected; 21 malformed and
  out-of-domain inputs each mapped to a specific reason; `unknown` never
  becoming `vertical`; purity.
- **Visibility (2)** — each section 7.3 condition excluding independently, and
  all failing conditions reported together.
- **Fixtures (8)** — size floors per group, oracle agreement, unique IDs, an
  intentionally wrong classifier being caught, byte-stability across seeds,
  descending timestamps, 9:16 thumbnails, the eight-field card contract with no
  placement leakage, and synthetic-ID marking.
- **Placement audit (19)** — the module having no runtime imports; the injected
  classifier actually being the one used; placement re-derived rather than
  trusted, with `placement_disagrees`, `ratio_not_reduced`,
  `ratio_unparseable`, and `placement_without_ratio` each caught; an unparseable
  stored ratio failing even under an `unknown` placement and even with a
  documented exception; duplicate ready ids failing coverage; duplicate ids
  within a single feed and within the eligible set failing exclusivity;
  exceptions matched by id so wrong ids excuse nothing and duplicated ids excuse
  one row; stale exceptions reported but not fatal; empty reasons documenting
  nothing; unscanned reporting `unmeasured`; migration duplicates tolerated;
  omissions never tolerated; backfill balance and idempotent reruns; combined
  diagnostics.
- **Telemetry (11)** — the ten Shorts events matching PRD section 13 exactly;
  the Home contract still frozen at 20 events and 12 fields; the two runtime
  lifecycle events now reaching the sink, with a guard that parses the runtime
  layer's own union so the gap cannot reopen; `shorts` accepted as a screen; the
  seven extension fields accepted with correct shapes and rejected otherwise;
  query failures reported on the query event; forbidden material blocked under
  the new field names; emission through the shared sink; the allowlist being a
  disjoint union.
- **Flags (11)** — both flags default-off with owner/removal-date/rollback-note;
  the news-feed flags undisturbed; the Android gate; exclusive placement forced
  off through six independent routes to "tab off"; the dependency declared as
  data; the hand-built illegal state still named; remote `false` outranking a
  configured rollout for every flag; remote `true` still allowing a rollout to
  narrow exposure; the preload kill switch *not* removing the tab; independent
  cohort bucketing.
- **Rollout (17)** — ladder order and linkage; monotonic percentages; structured
  exit criteria with unique ids covering first-frame, buffering, playback
  errors, Home regression, the exclusivity audit, and the removal owner;
  rollback ordering with the unreachable window asserted closed; empty plans;
  guards reporting `unmeasured`; unusable metric values failing rather than
  reading as unmeasured; an unusable threshold failing loudly instead of hiding
  a 500-omission breach; per-kind threshold range and shape checks; the shipped
  defaults being usable; omission and invariant breaches escalating to rollback;
  readiness requiring time, metrics, and an attestation for every criterion at
  every stage; notes being required as evidence; missing observation time
  reporting `unmeasured` while an unusable one blocks; seven partial-evidence
  inputs none of which reach `ready`.
- **Scenarios (5)** — all 13 PRD Phase 6 scenarios defined with steps,
  observations, gates, and references; the 50-item length; no simulator cell
  claiming a performance measurement; checklist completeness.
- **Dashboards (5)** — every Phase 7 subject having a panel; no panel reading a
  dropped event or stripped field; the query-error panel not counting playback
  errors as query failures; the validator catching bad specs; provisional
  thresholds declared as provisional.
- **Barrel (1)** — public surface present, telemetry and flags deliberately not
  re-exported.

### 4.2 Rollout-safety behavior this branch establishes

Each of these is a rule the code enforces, with a regression test behind it.
None of them is evidence about a running app.

| Rule | Why it exists |
| --- | --- |
| `exclusiveFeedPlacementEnabled` resolves `false` whenever `shortsTabEnabled` is `false` | Reporting a violation is not enough; a consumer that just reads the flag would hide exact 9:16 from both feeds. The Android gate makes this reachable on every Android install. |
| A remote `false` outranks a configured percentage rollout | A stale rollout percentage must not undo an operator's emergency off switch. |
| An unparseable stored `aspectRatio` fails the coverage gate | Section 7.1 types it as a normalized `string \| null`; `unknown` placement does not make storing `"garbage"` acceptable. |
| Coverage exceptions match asset ids | Counting let wrong or duplicated ids excuse real unknown rows nobody had inspected. |
| Duplicate ids fail coverage and exclusivity | `Set`-based comparison erases the paging bug section 12 is about. |
| Placement is re-derived from the stored ratio | Trusting the column makes the audit tautological. |
| The audit has no runtime imports and takes an injected classifier | Keeps it callable from a Convex query and prevents a second, drifting implementation of section 7.2. |
| NaN, infinite, negative, out-of-range, and wrong-shape metrics fail | A broken pipeline must not look like an unwired one. |
| Thresholds are validated as well as values | `x > NaN` is `false`, so a NaN threshold silently makes its metric unbreachable. |
| `evaluateCohortReadiness` requires an attested, noted criterion for each exit gate | No counter can answer "the Home regression checklist passed" or "migration code has a removal owner". |
| `feed_playback_paused` and `feed_player_released` are recognized | Both were emitted by the runtime and silently dropped before the sink. |
| Query failures are reported on `shorts_query_received`, not `feed_playback_error` | Counting decode failures as query failures inflates one rate, hides the other, and pages the wrong owner. |

### 4.3 Fixture-derived response sizes

**Measurements of a generated fixture, not of a production Convex response.**
They validate the tooling and show the contract's headroom. They satisfy no PRD
gate.

Produced from `createDeterministicVerticalFeed({ count })` at the default seed,
serialized with `JSON.stringify`, counted as UTF-8 bytes:

| Page | Bytes | Bytes per card | Scaled budget | Within budget |
| ---: | ---: | ---: | ---: | :---: |
| 16 cards | 5,868 | 367 | 15,360 | yes |
| 48 cards | 17,487 | 364 | 46,080 | yes |
| 50 cards | 18,203 | 364 | 48,000 | yes |

Slightly larger per card than the Home fixtures (337 B) because the 9:16
thumbnail URL carries `height` and `fit_mode` parameters.

---

## 5. What was NOT verified

Everything below requires a running Shorts screen, a Convex deployment with
classified content, or a physical device. None of it has been done, and none of
it should be read as done.

### 5.1 Needs the data lane (Phases 1–2)

| Item | Status |
| --- | --- |
| Ready-asset count and aspect-ratio distribution in any deployment | **NOT CAPTURED** |
| Classification of real Mux payloads through `normalizeMuxAssetPayload` | **NOT IMPLEMENTED** |
| Backfill execution and its scanned/classified/unknown/unchanged/failed counts | **NOT RUN** |
| Zero-unknown coverage gate against real data | **NOT MEASURED** |
| `listVerticalFeedVideosPaginated` correctness, cursors, and multi-page behavior | **NOT IMPLEMENTED** |
| Query response size and execution time for 16 and 48 Shorts cards | **NOT MEASURED** |
| Home/Shorts exclusivity audit against real rows | **NOT RUN** |
| Convex contract tests for the vertical query | **DO NOT EXIST** |

### 5.2 Needs the UI lane (Phases 3–5)

| Item | Status |
| --- | --- |
| Cold launch, warm launch, slow swipe, fast fling, reverse fling | **NOT RUN** |
| Pagination during playback, tab switch, background/foreground | **NOT RUN** |
| Rotation and safe-area change, detail handoff and return | **NOT RUN** |
| Offline and recovery | **NOT RUN** |
| 50-item down/up memory run | **NOT RUN** |
| Player, surface, and source-replacement counters under real scroll | **NOT OBSERVED** |
| VoiceOver / TalkBack, touch targets, contrast, dynamic type | **NOT TESTED** |

### 5.3 Needs a physical device

| Item | Status |
| --- | --- |
| Warm/preloaded first frame, p50/p75/p95 | **NOT MEASURED** |
| Cold first frame, p50/p75/p95 | **NOT MEASURED** |
| JS and UI frame rates, dropped-frame ratio | **NOT MEASURED** |
| CPU, memory, network bytes | **NOT MEASURED** |
| Memory return within 20% of steady state after the 50-item run | **NOT MEASURED** |
| Physical iOS test matrix | **NOT COMPLETED** |
| Physical Android test matrix | **NOT POSSIBLE** — no device attached |
| Home baseline re-run for regression comparison | **NOT RUN** — the original Home baseline was never measured either |

### 5.4 Needs production or an external system

| Item | Status |
| --- | --- |
| Mux Data metadata identifying the Shorts player and video | **NOT VERIFIED** |
| Dashboard panels created in an analytics tool | **NOT CREATED** — specifications only |
| Cohort observation windows | **NOT OBSERVED** |
| Rollback rehearsal against a real deployment | **NOT REHEARSED** |
| Product, placement, and audio decisions accepted by the project owner | **NOT RECORDED** |
| Removal of migration-only legacy Home behavior | **NOT APPLICABLE YET** — nothing to remove |

### 5.5 Provisional numbers

`DEFAULT_SHORTS_ROLLOUT_THRESHOLDS` contains two ratio thresholds
(`maxEmptyStateRateRatio`, `maxQueryErrorRateRatio`) with no production baseline
behind them. Four dashboard alert thresholds are marked `provisional: true` for
the same reason. Review all six before the 5% ramp. The remaining thresholds are
zero-tolerance absolutes the PRD states directly.

---

## 6. Checklists

Every box below is unchecked, and none should be checked from a code review.
Generate a fresh copy with `node scripts/vertical-video-feed-run-sheet.mjs`.

### 6.1 Functional acceptance (PRD section 12)

- [ ] Uploading or backfilling an exact 9:16 asset makes it eligible for Shorts.
- [ ] Uploading a 16:9, 4:5, square, or malformed-ratio asset does not make it eligible for Shorts.
- [ ] After the Home cutover, the same ready asset appears in exactly one of Home or Shorts.
- [ ] Swiping settles on one page and only that page plays.
- [ ] Tapping pauses and resumes; the sound control updates actual player state.
- [ ] Switching Home to Shorts never leaves both screens playing.
- [ ] Backgrounding, opening detail, signing out, and unmounting pause or release correctly.
- [ ] Pagination, empty state, end state, offline recovery, and playback errors are usable.
- [ ] iOS and Android pass the manual matrix in portrait and landscape.

### 6.2 Home regression

Run before and after any change to a shared hook, controller, or policy. PRD
section 11: shared primitives may be extracted, but Home must not regress as a
side effect.

- [ ] Home warm and cold first-frame p75 are within the pre-change baseline, or the delta is explained.
- [ ] Home dropped-frame ratio in the 50-item scroll has not increased.
- [ ] Home memory after the 50-item down/up run has not increased.
- [ ] Home player, surface, and source-replacement counters still satisfy the one-player invariants.
- [ ] The Home card response still matches the eight-field contract with no rich metadata.
- [ ] Home pagination still produces no duplicate, skipped, or reordered cards.
- [ ] Home still shows every asset it showed before, including unknown-placement legacy rows, while exclusive placement is off.
- [ ] A failing or disabled Shorts query has no effect on Home rendering or playback.

### 6.3 Accessibility

- [ ] Screen-reader labels include video title, channel, playback state, sound state, and action names.
- [ ] Every control meets minimum touch-target size and contrast requirements.
- [ ] Reduced motion disables autoplay but still permits manual playback and paging.
- [ ] Dynamic type does not push essential controls outside the safe area.
- [ ] No local-only like count or otherwise nonfunctional action is displayed.

---

## 7. Reproducing this record

```bash
npm ci
npx tsc --noEmit
npm run lint
node scripts/vertical-video-feed-tests.mjs
node scripts/news-feed-tests.mjs
node scripts/run-tests.mjs
node --experimental-strip-types --no-warnings=ExperimentalWarning \
  --import ./scripts/register-test-resolver.mjs --test tests/feed-contracts.test.ts
node scripts/vertical-video-feed-fixtures.mjs
node scripts/vertical-video-feed-run-sheet.mjs --out /tmp/shorts-run-sheet.md
```

## 8. Revision policy

No PRD target has been revised, because no baseline measurement exists yet. When
the first physical run happens, record it in section 5.3 and only then evaluate
whether any target needs revising. The provisional thresholds in section 5.5 are
placeholders and must be reviewed against real traffic before the 5% ramp — not
quietly adopted because they were already written down.
