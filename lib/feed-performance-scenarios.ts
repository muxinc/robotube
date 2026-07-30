/**
 * Test matrix for the news-feed performance work (PRD Phase 0).
 *
 * Device profiles, reference network states, and the standard scenario list
 * live here as data so the run-sheet generator, the docs, and any future
 * automation all describe the same matrix.
 *
 * `measurementValidity` is the load-bearing field. Simulator and emulator runs
 * are functional-only: their frame, CPU, memory, and first-frame numbers must
 * never be merged with physical-device results, and the run sheet stamps that
 * on every page it prints.
 */

export type MeasurementValidity = "performance" | "functional-only";

export type ProfileAvailability =
  /** Observed present on the development machine. */
  | "observed"
  /** Tooling exists but this specific profile has not been created yet. */
  | "not_configured"
  /** No hardware or tooling available at all. */
  | "unavailable";

export type FeedDeviceProfile = {
  id: string;
  label: string;
  platform: "ios" | "android";
  kind: "physical" | "simulator" | "emulator";
  measurementValidity: MeasurementValidity;
  availability: ProfileAvailability;
  /** What was actually seen on the machine, or why the profile is missing. */
  note: string;
};

/**
 * Recorded from the development machine on 2026-07-30 using
 * `xcrun devicectl list devices`, `xcrun simctl list devices`,
 * `adb devices -l`, and `emulator -list-avds`. Re-run
 * `scripts/news-feed-devices.mjs` to refresh; do not hand-edit availability.
 */
export const FEED_DEVICE_PROFILES: readonly FeedDeviceProfile[] = [
  {
    id: "ios-physical-reference",
    label: "iPhone 14 Pro (iPhone15,2), iOS 26.5.2 (23F84)",
    platform: "ios",
    kind: "physical",
    measurementValidity: "performance",
    availability: "observed",
    note: "Paired over local network, Developer Mode enabled. Primary Phase 0 performance reference.",
  },
  {
    id: "ios-simulator-functional",
    label: "iOS Simulator (iPhone 17 Pro, iOS 26.0)",
    platform: "ios",
    kind: "simulator",
    measurementValidity: "functional-only",
    availability: "observed",
    note: "iOS 18.6 and iOS 26.0 runtimes installed. Functional repetition only.",
  },
  {
    id: "android-emulator-functional",
    label: "Android emulator (AVD Medium_Phone_API_36.1)",
    platform: "android",
    kind: "emulator",
    measurementValidity: "functional-only",
    availability: "observed",
    note: "Single AVD present in the Android SDK. Not booted during Phase 0 authoring.",
  },
  {
    id: "android-emulator-constrained",
    label: "Constrained Android emulator (reduced RAM/CPU)",
    platform: "android",
    kind: "emulator",
    measurementValidity: "functional-only",
    availability: "not_configured",
    note: "No reduced-resource AVD exists yet. Must be created before coarse stress testing; all results stay emulator-only.",
  },
  {
    id: "android-physical-reference",
    label: "Mid-tier physical Android device",
    platform: "android",
    kind: "physical",
    measurementValidity: "performance",
    availability: "unavailable",
    note: "No Android device attached (`adb devices` empty). Required before any external Android rollout; a rollout dependency, not a Phase 0 blocker.",
  },
];

export function getDeviceProfile(id: string): FeedDeviceProfile | undefined {
  return FEED_DEVICE_PROFILES.find((profile) => profile.id === id);
}

export function getPerformanceGradeProfiles(): FeedDeviceProfile[] {
  return FEED_DEVICE_PROFILES.filter(
    (profile) =>
      profile.measurementValidity === "performance" && profile.availability === "observed",
  );
}

export type FeedNetworkState = {
  id: string;
  label: string;
  /** Steps required to reach this state before a run starts. */
  setup: string;
  expectedCacheState: "cold" | "warm" | "mixed";
};

export const FEED_NETWORK_STATES: readonly FeedNetworkState[] = [
  {
    id: "warm-cache",
    label: "Warm media cache on reference Wi-Fi",
    setup: "Run the target scenario once, then repeat without clearing app storage.",
    expectedCacheState: "warm",
  },
  {
    id: "cold-wifi",
    label: "Cold media cache on reference Wi-Fi",
    setup: "Delete and reinstall the build, or clear app storage, then launch on Wi-Fi.",
    expectedCacheState: "cold",
  },
  {
    id: "constrained",
    label: "Constrained network",
    setup:
      "iOS: Network Link Conditioner (3G profile) from the Developer settings. Android emulator: `telnet localhost 5554` then `network speed edge`.",
    expectedCacheState: "cold",
  },
  {
    id: "offline-recovery",
    label: "Offline then recovery",
    setup: "Enable airplane mode mid-scroll, hold for 10 seconds, then restore connectivity.",
    expectedCacheState: "mixed",
  },
];

export type FeedScenarioCapture =
  | "js_frame_rate"
  | "ui_frame_rate"
  | "dropped_frames"
  | "memory"
  | "cpu"
  | "network_bytes"
  | "counters_snapshot"
  | "first_frame_samples"
  | "query_timing";

export type FeedScenario = {
  id: string;
  label: string;
  steps: readonly string[];
  captures: readonly FeedScenarioCapture[];
  /** PRD gates this scenario feeds. */
  gates: readonly string[];
};

/** The nine scenarios named in Phase 0, in the order the run sheet lists them. */
export const FEED_SCENARIOS: readonly FeedScenario[] = [
  {
    id: "cold-launch",
    label: "Cold launch",
    steps: [
      "Force-quit the app and clear the media cache.",
      "Launch and start a stopwatch at the launch tap.",
      "Record feed_query_started through feed_first_cards_rendered.",
      "Record time to the first committed card's first frame.",
    ],
    captures: ["query_timing", "first_frame_samples", "counters_snapshot", "network_bytes"],
    gates: ["Cold time to first frame, p75 <= 1.2 s", "Feed response for 16 cards <= 15 KB"],
  },
  {
    id: "warm-launch",
    label: "Warm launch",
    steps: [
      "Background the app for 10 seconds, then foreground it.",
      "Confirm no stale offscreen card autoplays.",
      "Record time to the first committed card's first frame.",
    ],
    captures: ["first_frame_samples", "counters_snapshot"],
    gates: ["Warm/preloaded time to first frame, p75 <= 300 ms"],
  },
  {
    id: "slow-scroll",
    label: "Slow scroll through 50 items",
    steps: [
      "Scroll one card at a time, pausing about one second on each card.",
      "Continue until 50 items have been visited.",
    ],
    captures: [
      "js_frame_rate",
      "ui_frame_rate",
      "dropped_frames",
      "memory",
      "cpu",
      "counters_snapshot",
    ],
    gates: ["Dropped-frame ratio < 2%", "Attached feed player surfaces = 1 during playback"],
  },
  {
    id: "fast-fling",
    label: "Fast fling",
    steps: [
      "Fling hard enough to cross at least 10 cards per gesture.",
      "Repeat five times without waiting for settle between flings.",
    ],
    captures: ["dropped_frames", "js_frame_rate", "counters_snapshot"],
    gates: [
      "Player creation/release during fast fling = 0 until focus is committed",
      "Fast flings do not briefly play intermediate cards",
    ],
  },
  {
    id: "reverse-scroll",
    label: "Reverse scroll",
    steps: [
      "From item 50, scroll back to the top at a steady pace.",
      "Note any card that re-downloads media it already played.",
    ],
    captures: ["dropped_frames", "memory", "network_bytes", "counters_snapshot"],
    gates: ["Reverse scrolling reuses cached media when available"],
  },
  {
    id: "pagination",
    label: "Pagination during playback",
    steps: [
      "Start playback on a card near the end of the loaded page.",
      "Trigger the next page load without stopping playback.",
      "Check for duplicated, missing, or reordered cards.",
    ],
    captures: ["query_timing", "counters_snapshot", "network_bytes"],
    gates: [
      "Feed pagination has no duplicated or missing cards",
      "Pagination does not interrupt the active player",
    ],
  },
  {
    id: "tab-switch",
    label: "Tab switch",
    steps: [
      "With a preview playing, switch to another tab.",
      "Confirm playback pauses immediately.",
      "Return to Home and confirm exactly one video resumes.",
    ],
    captures: ["counters_snapshot"],
    gates: ["Simultaneously playing feed videos = 0 or 1"],
  },
  {
    id: "background-foreground",
    label: "Background and foreground",
    steps: [
      "With a preview playing, background the app.",
      "Confirm playback pauses and preload work is cancelled.",
      "Foreground and confirm no offscreen card autoplays.",
    ],
    captures: ["counters_snapshot", "memory"],
    gates: ["Backgrounding pauses playback and cancels unnecessary preload work"],
  },
  {
    id: "open-detail-back",
    label: "Open detail and return",
    steps: [
      "Tap a playing card and confirm the detail page receives the preview position.",
      "Navigate back and confirm no simultaneous audio or video playback.",
    ],
    captures: ["counters_snapshot"],
    gates: [
      "Opening a video passes the current preview time to the detail page",
      "Returning from detail does not produce simultaneous playback",
    ],
  },
];

export function getScenario(id: string): FeedScenario | undefined {
  return FEED_SCENARIOS.find((scenario) => scenario.id === id);
}

/** The 50-item scroll target that Phase 0 and the memory gate are stated against. */
export const STANDARD_SCENARIO_ITEM_COUNT = 50;

export type ScenarioRunCell = {
  scenarioId: string;
  profileId: string;
  networkStateId: string;
  measurementValidity: MeasurementValidity;
};

/**
 * Expands profiles x scenarios x network states into the cells a run sheet
 * must cover. Offline recovery is only meaningful where the PRD asks for it,
 * so it is limited to the scenarios that describe a network transition.
 */
export function buildRunMatrix(
  profileIds: readonly string[],
  scenarioIds: readonly string[] = FEED_SCENARIOS.map((scenario) => scenario.id),
  networkStateIds: readonly string[] = ["warm-cache", "cold-wifi"],
): ScenarioRunCell[] {
  const cells: ScenarioRunCell[] = [];

  for (const profileId of profileIds) {
    const profile = getDeviceProfile(profileId);
    if (!profile) continue;

    for (const scenarioId of scenarioIds) {
      if (!getScenario(scenarioId)) continue;

      for (const networkStateId of networkStateIds) {
        if (!FEED_NETWORK_STATES.some((state) => state.id === networkStateId)) continue;
        cells.push({
          scenarioId,
          profileId,
          networkStateId,
          measurementValidity: profile.measurementValidity,
        });
      }
    }
  }

  return cells;
}
