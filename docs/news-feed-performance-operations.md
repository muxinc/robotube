# News Feed Performance: Architecture and Operations

Engineering and operational notes for the news-feed performance work described
in [`news-feed-performance-architecture-prd.md`](./news-feed-performance-architecture-prd.md).
Measurement results live in
[`news-feed-performance-baseline.md`](./news-feed-performance-baseline.md).

This document covers the parts that are implemented today: the observability
vocabulary, the development counters, the rollout flags, and the preload kill
switch. It does not describe the playback controller or the preloader, which
are Phase 2 and Phase 3 work owned elsewhere.

---

## 1. Module map

| Module | Purpose | Lifetime |
| --- | --- | --- |
| `lib/feed-performance.ts` | Single import surface for everything below | Permanent |
| `lib/feed-performance-events.ts` | Event vocabulary, common fields, privacy sanitizer | Production-safe |
| `lib/feed-performance-timeline.ts` | Focus/playback timestamps, span derivation, p50/p75/p95 | Production-safe |
| `lib/feed-performance-counters.ts` | Development-only gauges, totals, invariant checks | **Temporary — remove in Phase 6** |
| `lib/feed-performance-test-feed.ts` | Deterministic fixtures and the section 7.4 card contract | Test tooling |
| `lib/feed-performance-scenarios.ts` | Device profiles, network states, scenario matrix | Documentation data |
| `lib/feed-feature-flags.ts` | Rollout flags, cohort bucketing, resolution order | Removed with the flags |
| `lib/feed-feature-kill-switch.ts` | Immediate preload kill switch, rollout guards | Kill switch is permanent |

Import from `@/lib/feed-performance` so the Phase 6 cleanup is a change in one
file.

---

## 2. Observability

### 2.1 Emitting an event

```ts
import {
  FEED_PERFORMANCE_EVENTS,
  emitFeedPerformanceEvent,
  hashPlaybackId,
} from "@/lib/feed-performance";

emitFeedPerformanceEvent(FEED_PERFORMANCE_EVENTS.feedFirstFrame, {
  session_id: sessionId,
  screen: "home_feed",
  mux_asset_id: item.muxAssetId,
  playback_id_hash: hashPlaybackId(item.playbackId),
  feed_index: index,
  platform: "ios",
  cache_state: "warm",
  is_preloaded: true,
  elapsed_ms: elapsed,
});
```

Install a sink once, at app start:

```ts
import { setFeedPerformanceSink } from "@/lib/feed-performance";

setFeedPerformanceSink((event) => analytics.track(event.name, event.fields));
```

Sink exceptions are swallowed. Telemetry must never take down playback.

### 2.2 The privacy contract

PRD section 11 forbids logging raw authentication data, signed playback tokens,
private playback URLs, captions, transcripts, and user-provided AI metadata.
`sanitizeFeedEventFields` enforces that at the emit boundary rather than
relying on call-site discipline:

- Keys outside the twelve-field allowlist are **dropped**.
- Allowlisted keys with the wrong type or an out-of-vocabulary enum value are
  **redacted**.
- Any string value that looks like a URL (any scheme), a JWT, a bearer token, a
  signed query parameter, or a media manifest/segment path is **redacted**,
  including under an allowlisted key.
- Any string longer than 200 characters is **redacted** on the assumption that
  it is caption, transcript, or AI copy.
- `error_code` must match `[A-Za-z0-9_.:-]{1,64}`. Free-text error messages are
  redacted, so pass a code, not a message.

An unsafe event degrades into a smaller event, never into a dropped event.

`playback_id_hash` is **pseudonymization, not anonymization**. A 32-bit FNV-1a
digest keeps raw playback IDs — which can be turned into public playback URLs —
out of telemetry and lets two events be correlated to the same media. It is not
a security primitive and must not be used for access control.

`mux_asset_id` is on the allowlist because an asset ID is not directly playable.
A playback ID is, which is why only the hash of it is allowed.

### 2.3 Timing

`FeedTimelineRecorder` records marks per `muxAssetId` and derives the spans the
PRD states its gates in. The clock is injected, so tests and trace replays are
deterministic.

```ts
const recorder = new FeedTimelineRecorder();
recorder.mark(assetId, "focus_committed");
recorder.mark(assetId, "playback_requested");
recorder.mark(assetId, "first_frame");

recorder.spanDuration(assetId, "playbackRequestToFirstFrame");
recorder.summarizeSpan("playbackRequestToFirstFrame"); // count, min, p50, p75, p95, max, mean
```

Two behaviors worth knowing:

- A span whose `to` mark only appears *before* its `from` mark returns `null`,
  not `0`. An out-of-order sequence stays out of the summaries instead of
  contributing a fake zero.
- Percentiles use **nearest rank**, so a reported p75 is always a value that was
  actually measured. `percentile([100, 200], 75)` is `200`, not `175`.

`evaluateFirstFrameGate` returns `warmPasses: null` / `coldPasses: null` when
there are no samples. An unrun scenario can never read as a pass.

### 2.4 Development counters

Temporary, `__DEV__`-gated, and removed in Phase 6.

```ts
import { feedPerformanceCounters, formatFeedCountersSnapshot } from "@/lib/feed-performance";

feedPerformanceCounters.adjustGauge("mountedFeedRows", 1);
feedPerformanceCounters.increment("sourceReplacements");
feedPerformanceCounters.subscribe((snapshot) => setDebugText(formatFeedCountersSnapshot(snapshot)));
```

Gauges (with retained peaks): `mountedFeedRows`, `attachedPlayerSurfaces`,
`livePlayerInstances`, `playingFeedVideos`, `preloadedItemsRetained`.

Totals: `playerCreations`, `playerReleases`, `surfaceAttachments`,
`surfaceDetachments`, `sourceReplacements`, `preloadStarts`,
`preloadCompletions`, `preloadCancellations`, `preloadCacheHits`,
`preloadPromotions`, `rowMounts`, `rowUnmounts`.

`getInvariantViolations()` returns the currently broken guarantees:

| Invariant | Limit | Configurable |
| --- | --- | --- |
| `at_most_one_attached_surface` | 1 | No |
| `at_most_one_playing_video` | 1 | No |
| `at_most_one_live_player` | 1 | Yes — raise to 2 only with `feedStandbyPlayerFallback` |
| `bounded_preload_window` | 2 | Yes |

This is what satisfies the Phase 0 gate "current player and row counts are
observable without reading logs manually". **It is not yet wired to a UI
surface** — that belongs with the Phase 1/2 feed work.

---

## 3. Feature flags

Four independent flags, all default-off.

| Flag | Phase | Owner | Removal date | Kill-switchable | Needs physical Android validation |
| --- | --- | --- | --- | :---: | :---: |
| `feedSharedPlayer` | Phase 2 | news-feed-playback | 2026-12-31 | no | yes |
| `feedPredictivePreload` | Phase 3 | news-feed-playback | 2026-12-31 | **yes** | yes |
| `feedLightweightQuery` | Phase 4 | news-feed-data | 2026-12-31 | no | no |
| `feedStandbyPlayerFallback` | Phase 3 fallback | news-feed-playback | 2026-09-30 | **yes** | yes |

`findExpiredFeedFeatureFlags(todayIso)` lists flags past their removal date, so
the Phase 6 cleanup gate can be checked mechanically rather than remembered.

### 3.1 Resolution order

Strongest last:

1. Registry `defaultValue` (always `false`)
2. Remote config value
3. Deterministic rollout-cohort bucketing
4. Android physical-validation gate
5. Local developer override
6. Preload kill switch

```ts
const resolved = resolveFeedFeatureFlags({
  platform: "ios",
  stableId: installId,
  remote: remoteConfig.feedFlags,
  rollout: { feedSharedPlayer: { ios: { percent: 10 } } },
});

if (resolved.feedSharedPlayer.enabled) { /* ... */ }
```

Each resolution carries a `source` and a human-readable `reason`, so a support
question about why a user is on the old path is answerable without guessing.

### 3.2 Cohort bucketing

`rolloutBucket(flagKey, stableId)` returns a stable 0-99 bucket. The flag key is
mixed into the hash, so a user in the first 10% for one flag is not
automatically in the first 10% for the others and the flags ramp independently.

**A rollout configured without a `stableId` resolves to `false`.** Random
per-launch assignment would flip a user between architectures mid-session, so
the safe read is off.

### 3.3 The Android gate

PRD Phase 6: *"Keep Android rollout disabled if only emulator results are
available; iOS rollout may proceed independently after its own gates pass."*

Flags marked `requiresAndroidPhysicalValidation` resolve to `false` on Android
unless `androidPhysicalValidationCompleted: true` is passed explicitly. The
default is `false`. As of the baseline record no physical Android device exists,
so **that value must stay false**.

`feedLightweightQuery` is exempt: a Convex response-shape change does not depend
on Android hardware validation.

### 3.4 Illegal combinations

`findFlagCombinationViolations(resolved)` names combinations that must not ship:

- `feedStandbyPlayerFallback` alongside `feedPredictivePreload` — section 7.2
  allows the standby slot as a *substitute*, not a supplement.
- `feedPredictivePreload` without `feedSharedPlayer` — preloaded media has no
  single active player to be promoted into.
- `feedStandbyPlayerFallback` without `feedSharedPlayer` — the standby slot is
  defined relative to the shared active player.

---

## 4. The preload kill switch

### 4.1 Operating it

```ts
import {
  applyRemotePreloadKillSwitchPayload,
  engagePreloadKillSwitch,
  isPreloadKillSwitchEngaged,
  subscribeToPreloadKillSwitch,
} from "@/lib/feed-feature-kill-switch";

// From a remote config poll:
applyRemotePreloadKillSwitchPayload({
  preloadDisabled: true,
  reason: "memory warnings up on iOS 26",
  updatedAtMs: Date.now(),
});

// From an in-app incident path:
engagePreloadKillSwitch("device reported memory pressure");
```

Remote payload shape:

```json
{ "preloadDisabled": true, "reason": "short operator note", "updatedAtMs": 1767225600000 }
```

### 4.2 Guarantees

- **Immediate.** Subscribers are notified synchronously inside `engage()`, so
  in-flight preload work can be cancelled in the same tick — not on the next
  render and not on the next config poll.
- **Cheap to read.** `isPreloadKillSwitchEngaged()` is a plain boolean read,
  safe on a hot path.
- **Fails closed.** A payload that is not an object, or is missing a boolean
  `preloadDisabled`, **engages** the switch. Losing preloading costs first-frame
  latency; running it blind costs memory and bandwidth on devices we cannot see.
- **Monotonic.** A payload with an older `updatedAtMs` than the current state is
  ignored, so out-of-order delivery cannot resurrect preloading that a newer
  payload disabled.
- **Only ever disables.** It cannot turn preloading on where a flag or cohort
  has it off.
- **Does not revert the rest.** Killing preload leaves `feedSharedPlayer` and
  `feedLightweightQuery` alone, matching PRD section 13.

### 4.3 Rollback posture

Per PRD section 13, a rollback must preserve feed readability: thumbnail cards
and tap-to-open stay available even with autoplay disabled. Each flag's
`rollbackNote` in the registry records what turning it off actually costs.

---

## 5. Rollout runbook

1. **Before any ramp** — Phase 0 baseline populated with real physical-iPhone
   numbers, and `DEFAULT_ROLLOUT_GUARD_THRESHOLDS` reviewed against them. Both
   are outstanding today.
2. **Internal cohort** — `overrides` on internal builds. No cohort percentages.
3. **10% iOS** — `rollout: { <flag>: { ios: { percent: 10 } } }` with a
   `stableId`. Monitor first-frame time, buffering, crashes, memory warnings,
   playback errors, and dropped frames for the agreed observation window.
4. **50% iOS**, then **100% iOS** — each after its observation window.
5. **Android** — blocked until a physical Android device validates behavior and
   performance. Until then leave `androidPhysicalValidationCompleted` false.

At every stage, feed observed rates into `evaluateRolloutGuards`:

```ts
const decision = evaluateRolloutGuards({
  crashRateRatioToBaseline,
  memoryWarningRateRatioToBaseline,
  playbackErrorRateRatioToBaseline,
  wrongVideoIncidentCount,
});

if (decision.shouldPauseRollout) pauseRamp(decision.breachedMetrics);
if (decision.shouldEngagePreloadKillSwitch) engagePreloadKillSwitch("rollout guard breach");
```

Metrics that are not supplied are treated as **not measured** and never count as
a pass. An unobserved rollout is an unmonitored one, and the operator has to say
so explicitly rather than getting a green light by omission.

Memory-warning and playback-error breaches pull the preload switch, because
preloading is the thing that relieves them. A crash-rate breach pauses the ramp
but does not pull the preload switch — disabling preload does not fix a crash
regression.

---

## 6. Test tooling

```bash
node scripts/news-feed-tests.mjs        # 52 pure unit tests
node scripts/news-feed-run-sheet.mjs    # tooling probe + blank run sheet
npm run lint
npx tsc --noEmit
```

There is no test runner in `package.json` and this work did not add one.
`scripts/news-feed-load-lib.mjs` compiles the feed modules to CommonJS in a temp
directory using the existing TypeScript dev dependency and imports them, so the
tests run on Node's built-in `node:test` with no new packages. A side benefit:
every run also type-checks these modules in isolation from the app.

### 6.1 Deterministic fixtures

`createDeterministicFeed({ count, seed, playbackIds })` produces a byte-stable
feed. Same seed and count, same JSON — a scroll scenario run today and the same
run next week exercise identical data.

Without a `playbackIds` array the generator emits IDs prefixed
`synthetic-not-playable-`, which **will not resolve against Mux**. Pass real
playback IDs to make the fixture feed actually playable. The PRD's
"deterministic test feed with at least 50 playable videos" is not satisfied by
the generator alone.

### 6.2 The card contract as an executable check

`findFeedCardContractViolations(page)` validates a feed response against PRD
section 7.4 and reports every violation, classified as `missing_field`,
`wrong_type`, `unexpected_field`, or `forbidden_field`. Phase 4 should call it
from a Convex response-shape test so rich metadata cannot quietly return to the
card query.

`projectFeedCard(row)` narrows an arbitrary row to the eight contract fields.

---

## 7. Phase 6 cleanup checklist

- [ ] Remove `lib/feed-performance-counters.ts` and every call site.
- [ ] Remove the four flags once each removal date passes; verify with
      `findExpiredFeedFeatureFlags`.
- [ ] Keep `lib/feed-performance-events.ts` and
      `lib/feed-performance-timeline.ts` as production telemetry.
- [ ] Keep the preload kill switch as long as preloading ships.
- [ ] Delete the old multi-player feed path after the rollback window closes.
