# News Feed Performance Baseline

Phase 0 baseline record for
[`docs/news-feed-performance-architecture-prd.md`](./news-feed-performance-architecture-prd.md).

**Status: partially populated.** The measurement environment, the test matrix,
and the instrumentation are in place. No physical-device performance run has
been executed, so every device-measured cell below is explicitly marked
`NOT MEASURED`. Nothing in this document is estimated, extrapolated, or copied
from another project.

- Recorded on: 2026-07-30
- Branch: `herdr/news-feed-quality`
- Base commit: `b43be5d`

---

## 1. How to reproduce this environment record

```bash
node scripts/news-feed-run-sheet.mjs            # probes tooling, prints a blank run sheet
node scripts/news-feed-run-sheet.mjs --out /tmp/run-sheet.md
node scripts/news-feed-tests.mjs                # pure unit tests, no device required
```

`scripts/news-feed-run-sheet.mjs` reports only what the underlying commands
return. If a tool is missing it prints that it is missing.

---

## 2. Observed development machine and tooling

Recorded 2026-07-30 from `xcrun devicectl list devices --json-output`,
`xcrun simctl list`, `adb devices -l`, `emulator -list-avds`,
`xcodebuild -version`, `java -version`, and `eas --version`.

| Item | Observation |
| --- | --- |
| Host OS | macOS (Darwin 25.5.0), arm64 |
| Node | v22.17.1 |
| npm | 11.14.1 |
| Xcode | 26.0.1 (build 17A400) |
| Java | OpenJDK 17.0.17 (Zulu 17.62+17-CA) |
| eas-cli | 21.0.1 |
| Android SDK | `~/Library/Android/sdk` (`ANDROID_HOME` set; `ANDROID_SDK_ROOT` unset) |
| Expo CLI | Not installed globally; used via `npx expo` |
| Test runner | None in `package.json`. Pure tests run through `scripts/news-feed-tests.mjs`. |

### 2.1 Physical iOS device (available)

| Property | Observation |
| --- | --- |
| Name | Joshua Alphonse's iPhone |
| Model | iPhone 14 Pro (`iPhone15,2`) |
| iOS version | 26.5.2 (build 23F84) |
| CPU | arm64e |
| Pairing | Paired, `available`, transport `localNetwork` |
| Developer Mode | Enabled |
| Tunnel state | `disconnected` at the time of recording |

This is the primary Phase 0 performance reference named by the PRD.

**Not recorded:** storage state, battery level, and thermal state. The PRD asks
for these, and they are only meaningful at the moment a measured run starts, so
they are captured on the run sheet rather than here.

### 2.2 iOS Simulator (available, functional-only)

- Runtimes installed: iOS 18.6 (22G86) and iOS 26.0 (26.0.1 / 23A8464).
- Devices available include iPhone 17 Pro, iPhone 17, iPhone Air, iPhone 16e
  (iOS 26.0) and iPhone 16 Pro / 16 / 16 Plus / 16e (iOS 18.6).
- Booted at the time of recording: none.

Simulator frame, CPU, memory, and first-frame numbers are not physical-device
results and must never be merged with them.

### 2.3 Android (partially available)

| Item | Observation |
| --- | --- |
| `adb` | Present at `~/Library/Android/sdk/platform-tools/adb` |
| Physical Android devices attached | **None** (`adb devices` returned an empty list) |
| Emulator binary | Present at `~/Library/Android/sdk/emulator/emulator` |
| AVDs defined | `Medium_Phone_API_36.1` (one) |
| Constrained low-RAM/low-CPU AVD | **Does not exist** |
| SDK components present | `build-tools`, `cmake`, `emulator`, `ndk`, `platform-tools`, `platforms`, `sources`, `system-images` |

**Android tooling gap, recorded per the Phase 0 exit gate:**

| Gap | Owner | Target phase |
| --- | --- | --- |
| No constrained (reduced RAM/CPU) AVD profile | news-feed-quality | Phase 0 follow-up, before Phase 5 |
| No physical Android device | news-feed-quality | Before Android rollout exceeds the internal cohort (Phase 6) |
| Android emulator functional run not executed | news-feed-quality | Phase 1 |

How a physical Android device will be obtained is **not yet decided**. The
three candidate routes named by the PRD — borrowed device, cloud
physical-device service, or dedicated test hardware — are all still open. This
is a rollout dependency, not a Phase 0 blocker.

---

## 3. Code state observed at the baseline commit

Grepped across `app/`, `components/`, and `hooks/` at `b43be5d`:

| PRD section 2 claim | Observed at `b43be5d` |
| --- | --- |
| `maxItemsInRecyclePool={0}` on the Home feed | **Not present** |
| `removeClippedSubviews={false}` override | **Not present** |
| `startupBufferDuration={2}` on feed previews | **Not present** |
| Duplicate `poster` on `MuxVideoView` | **Not present** |
| Home-feed usage of `useMuxVideoFeed` | **Not present** |
| Four-player preview window | **Not present.** `app/(tabs)/index.tsx` renders a player for `abs(index - focusedIndex) <= 1`, so up to three cards can mount `InlineVideoPlayer`. |
| Feed focus changes during scroll | **Partially addressed.** `hooks/use-feed-focus-controller.ts` already defers focus with a settle timer (140 ms after drag end, 80 ms after momentum end). |
| Feed query returns detail-page AI metadata | **Present.** `convex/feed.ts` `FeedVideoRow` still carries `summary`, `tags`, `chapters`, `keyMoments`, `keyMomentsGeneratedAtMs`, `keyMomentsUnavailableReason`, and `playbackUrl`. |
| Per-video metadata/uploader/avatar lookups | **Present.** `resolveChannelInfo` runs per row and calls `ctx.storage.getUrl` per uploader. |
| 16-item initial page | **Present.** `INITIAL_FEED_PAGE_SIZE = 16`, `FEED_LOAD_MORE_COUNT = 12`. |
| 1280px thumbnails | **Present.** `convex/feed.ts` builds `thumbnail.jpg?width=1280`. |

The PRD's problem statement describes an earlier state of the Home feed. Several
list-level problems it names have already been removed on this branch. The
data-layer problems it names are still present. Phase 1 scope should be
re-checked against this table before work starts.

Installed player package: `@mux/mux-react-native-player@0.1.10`.

---

## 4. Measurements

### 4.1 Fixture-derived response sizes

**These are measurements of a generated fixture, not of the production Convex
response.** They exist to validate the response-size tooling and to show the
headroom the section 7.4 contract has. They do not satisfy any PRD gate.

Produced from `createDeterministicFeed({ count })` at the default seed
(`20260730`), serialized with `JSON.stringify` and counted as UTF-8 bytes:

| Page | Card-only contract | Bytes per card | Scaled budget | Within budget | With synthetic rich metadata |
| ---: | ---: | ---: | ---: | :---: | ---: |
| 16 cards | 5,388 B | 337 B | 15,360 B | yes | 36,132 B |
| 48 cards | 16,047 B | 334 B | 46,080 B | yes | 108,260 B |

The synthetic rich-metadata column uses two key moments and ten transcript cues
per card. Real AI metadata volume differs; the initial PRD investigation counted
28 key moments and 156 transcript cues across a 16-item page.

### 4.2 Convex feed query

| Measurement | Result |
| --- | --- |
| `listFeedVideosPaginated` response size, 16 items | **NOT MEASURED** |
| `listFeedVideosPaginated` response size, 48 items | **NOT MEASURED** |
| `listFeedVideosPaginated` execution time, 16 items | **NOT MEASURED** |
| `listFeedVideosPaginated` execution time, 48 items | **NOT MEASURED** |

Requires a running Convex deployment with feed content. Not executed.

### 4.3 Physical iPhone (iPhone 14 Pro, iOS 26.5.2)

| Measurement | Result |
| --- | --- |
| JS frame rate, 50-item slow scroll | **NOT MEASURED** |
| UI frame rate, 50-item slow scroll | **NOT MEASURED** |
| Dropped-frame ratio, 50-item slow scroll | **NOT MEASURED** |
| Dropped-frame ratio, fast fling | **NOT MEASURED** |
| Memory after repeated 50-item down/up scroll | **NOT MEASURED** |
| CPU during standard scenario | **NOT MEASURED** |
| Network bytes during standard scenario | **NOT MEASURED** |
| Warm/preloaded time to first frame, p75 | **NOT MEASURED** |
| Cold time to first frame, p75 | **NOT MEASURED** |
| Player creations/releases during fast fling | **NOT MEASURED** |
| Development-build vs release-build comparison | **NOT MEASURED** |

### 4.4 iOS Simulator and Android emulator

| Measurement | Result |
| --- | --- |
| iOS Simulator functional pass | **NOT RUN** |
| Android emulator functional pass | **NOT RUN** |
| Constrained Android emulator stress pass | **NOT RUN** (profile does not exist) |

### 4.5 Physical Android

**NOT MEASURED.** No physical Android device is available. Recorded as a rollout
dependency in section 2.3.

---

## 5. Phase 0 exit gate status

| Gate | Status |
| --- | --- |
| The same test scenario can be run twice with comparable results | Not demonstrated — no scenario has been run |
| Physical-device baseline metrics exist for the available iPhone | Not met — see 4.3 |
| iOS Simulator functional results exist and are labeled non-performance | Not met — see 4.4 |
| Android emulator functional results exist, or the gap is recorded with an owner and target phase | **Met via the recorded gap** — see 2.3 |
| Physical Android validation is scheduled as a rollout dependency and does not block Phase 0 | **Met** — see 2.3 |
| Current player and row counts are observable without reading logs manually | **Met** — `lib/feed-performance-counters.ts` exposes gauges, peaks, totals, and invariant violations, and the development-only Home overlay subscribes to them |

---

## 6. Baseline value revision policy

The PRD says that if a numeric target is not feasible after Phase 0, the target
is updated with the measured baseline, a rationale, and an approved
replacement. No target has been revised, because no baseline measurement
exists yet. When the first physical run happens, record it in section 4.3 and
only then evaluate whether any target needs revising.

The rollout guard thresholds in `lib/feed-feature-kill-switch.ts`
(`DEFAULT_ROLLOUT_GUARD_THRESHOLDS`) are ratios against a Phase 0 production
baseline that does not exist yet. They are placeholders and must be reviewed
before the 10% ramp.
