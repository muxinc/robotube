/**
 * Shorts verification matrix: scenarios, regression checks, and the functional
 * acceptance list from vertical-feed PRD section 12.
 *
 * Device profiles and reference network states are **not** redefined here. They
 * are imported from `feed-performance-scenarios`, because the machine, the
 * phone, and the emulator are the same ones the Home work measured on, and two
 * competing inventories would immediately disagree about which numbers are
 * performance-grade.
 *
 * `measurementValidity` carries the same meaning it does there: a simulator or
 * emulator run is functional-only, and its frame, CPU, memory, and first-frame
 * numbers must never be merged with physical-device results.
 */

import {
  FEED_DEVICE_PROFILES,
  FEED_NETWORK_STATES,
  getDeviceProfile,
  type FeedScenarioCapture,
  type MeasurementValidity,
} from "./feed-performance-scenarios";
import { VERTICAL_STANDARD_SCENARIO_ITEM_COUNT } from "./vertical-video-feed-fixtures";

export {
  FEED_DEVICE_PROFILES,
  FEED_NETWORK_STATES,
  getDeviceProfile,
  VERTICAL_STANDARD_SCENARIO_ITEM_COUNT,
};
export type { FeedScenarioCapture, MeasurementValidity };

export type ShortsScenario = {
  id: string;
  label: string;
  /** PRD Phase 6 bullet or section this scenario exists to cover. */
  prdReference: string;
  steps: readonly string[];
  captures: readonly FeedScenarioCapture[];
  /** Pass/fail conditions that do not need instrumentation to judge. */
  observations: readonly string[];
  /** Section 12 metrics or exit gates this scenario informs. */
  gates: readonly string[];
  /** True when the scenario cannot produce a meaningful result on a simulator. */
  requiresPhysicalDevice: boolean;
};

/**
 * The thirteen Shorts scenarios, in run-sheet order.
 *
 * The list is deliberately one-to-one with the PRD Phase 6 sentence "cold
 * launch, warm launch, slow swipe, fast fling, reverse fling, pagination, tab
 * switch, background/foreground, rotation, detail/back, offline, and recovery
 * scenarios", plus the standard 50-item memory run.
 */
export const SHORTS_SCENARIOS: readonly ShortsScenario[] = [
  {
    id: "shorts-cold-launch",
    label: "Cold launch into Shorts",
    prdReference: "Phase 6 — cold launch; section 12 cold first frame",
    steps: [
      "Force-quit the app and clear the media cache.",
      "Launch, then open the Shorts tab as the first navigation.",
      "Record shorts_tab_opened through shorts_query_received.",
      "Record time from focus commit to the first committed page's first frame.",
    ],
    captures: ["query_timing", "first_frame_samples", "counters_snapshot", "network_bytes"],
    observations: [
      "The first page renders on a black surface with no white flash.",
      "The Mux thumbnail is visible until the first frame arrives.",
    ],
    gates: ["Cold first frame, p75 <= 1.2 s on reference Wi-Fi"],
    requiresPhysicalDevice: true,
  },
  {
    id: "shorts-warm-launch",
    label: "Warm launch into Shorts",
    prdReference: "Phase 6 — warm launch; section 12 warm first frame",
    steps: [
      "Background the app for 10 seconds with Shorts open, then foreground it.",
      "Confirm the previously committed page is still the active page.",
      "Record time to first frame on resume.",
    ],
    captures: ["first_frame_samples", "counters_snapshot"],
    observations: [
      "No offscreen page autoplays on resume.",
      "Mute state from before backgrounding is preserved.",
    ],
    gates: ["Warm/preloaded first frame, p75 <= 300 ms"],
    requiresPhysicalDevice: true,
  },
  {
    id: "shorts-slow-swipe",
    label: "Slow swipe through 50 pages",
    prdReference: "Phase 6 — slow swipe; section 12 dropped frames",
    steps: [
      `Swipe one page at a time, pausing about one second on each, for ${VERTICAL_STANDARD_SCENARIO_ITEM_COUNT} pages.`,
      "Watch for a page that settles between two videos.",
    ],
    captures: [
      "js_frame_rate",
      "ui_frame_rate",
      "dropped_frames",
      "memory",
      "cpu",
      "counters_snapshot",
    ],
    observations: [
      "Every swipe settles on exactly one page.",
      "Only the settled page plays.",
      "No stale poster, title, or channel name appears on a recycled cell.",
    ],
    gates: [
      "Dropped-frame ratio < 2%",
      "Simultaneously playing videos = 0 or 1",
      "Attached player surfaces = 1 during playback",
    ],
    requiresPhysicalDevice: true,
  },
  {
    id: "shorts-fast-fling",
    label: "Fast fling",
    prdReference: "Phase 6 — fast fling; section 12 source replacements",
    steps: [
      "Fling hard enough to cross at least 10 pages per gesture.",
      "Repeat five times without waiting for settle between flings.",
    ],
    captures: ["dropped_frames", "js_frame_rate", "counters_snapshot"],
    observations: [
      "No intermediate page briefly plays or emits audio.",
      "Preload work is suspended for the duration of the fling.",
    ],
    gates: ["Source replacements during fast fling = 0 until focus commits"],
    requiresPhysicalDevice: true,
  },
  {
    id: "shorts-reverse-fling",
    label: "Reverse fling",
    prdReference: "Phase 6 — reverse fling",
    steps: [
      "From page 50, fling back toward the top.",
      "Note any page that re-downloads media it already played.",
      "Confirm the direction-aware preloader followed the direction change.",
    ],
    captures: ["dropped_frames", "memory", "network_bytes", "counters_snapshot"],
    observations: [
      "Reverse paging reuses cached media where available.",
      "Preload for the abandoned direction is cancelled, not left running.",
    ],
    gates: ["Preload window stays bounded to current plus one"],
    requiresPhysicalDevice: true,
  },
  {
    id: "shorts-pagination",
    label: "Pagination during playback",
    prdReference: "Phase 6 — pagination; section 12 duplicate/cursor-lost cards",
    steps: [
      "Page to just before the end of the loaded page while a video plays.",
      "Let the next page load without pausing.",
      "Record the full ordered asset-ID list and check it against the previous page.",
    ],
    captures: ["query_timing", "counters_snapshot", "network_bytes"],
    observations: [
      "No duplicated, skipped, or reordered pages.",
      "Playback of the active page is not interrupted by the fetch.",
      "The end-of-feed footer never becomes a snap target.",
    ],
    gates: ["Duplicate or cursor-lost cards = 0"],
    requiresPhysicalDevice: false,
  },
  {
    id: "shorts-tab-switch",
    label: "Home / Shorts tab switching",
    prdReference: "Phase 6 — tab switch; section 12 one-playing invariant",
    steps: [
      "With a Shorts page playing, switch to Home.",
      "Confirm Shorts pauses immediately and Home does not start unmuted.",
      "Switch back and forth rapidly ten times.",
    ],
    captures: ["counters_snapshot"],
    observations: [
      "Switching never leaves both screens playing.",
      "No audio continues from the tab that lost focus.",
    ],
    gates: [
      "Simultaneously playing videos on the active feed = 0 or 1",
      "Shorts query failure impact on Home = none",
    ],
    requiresPhysicalDevice: false,
  },
  {
    id: "shorts-lifecycle",
    label: "Background, foreground, and sign-out",
    prdReference: "Phase 6 — background/foreground; section 12 lifecycle acceptance",
    steps: [
      "With a page playing, background the app.",
      "Confirm playback pauses and preload work is cancelled.",
      "Foreground, then sign out while Shorts is mounted.",
    ],
    captures: ["counters_snapshot", "memory"],
    observations: [
      "Backgrounding pauses playback within one frame of the lifecycle event.",
      "Sign-out and unmount release the player rather than leaking it.",
    ],
    gates: ["Live player instances return to 0 after unmount"],
    requiresPhysicalDevice: false,
  },
  {
    id: "shorts-rotation",
    label: "Rotation and safe-area change",
    prdReference: "Phase 6 — rotation; section 8.1 measured viewport",
    steps: [
      "With page N committed, rotate to landscape and back to portrait.",
      "Repeat while mid-scroll between two pages.",
      "Change Dynamic Type size and return to Shorts.",
    ],
    captures: ["counters_snapshot"],
    observations: [
      "The active asset is unchanged after rotation.",
      "The list never rests between two pages after a viewport change.",
      "Controls stay inside the safe area in both orientations.",
      "Page height is recomputed from the measured content viewport, not a cached window height.",
    ],
    gates: ["Rotation and safe-area changes do not leave the list between pages"],
    requiresPhysicalDevice: true,
  },
  {
    id: "shorts-detail-handoff",
    label: "Open detail and return",
    prdReference: "Phase 6 — detail/back; section 8.3 restore state",
    steps: [
      "Tap the title or channel area of a playing page to open /video/[muxAssetId].",
      "Confirm the detail screen receives the preview position.",
      "Navigate back.",
    ],
    captures: ["counters_snapshot"],
    observations: [
      "Shorts pauses before the detail screen starts playing.",
      "Returning restores exactly one valid paused-or-playing state.",
      "Mute state survives the round trip.",
    ],
    gates: ["Returning from detail does not produce simultaneous playback"],
    requiresPhysicalDevice: false,
  },
  {
    id: "shorts-offline",
    label: "Offline mid-scroll",
    prdReference: "Phase 6 — offline; section 8.5 offline state",
    steps: [
      "Enable airplane mode while a page is playing.",
      "Attempt to page forward past the loaded window.",
      "Hold offline for at least 30 seconds.",
    ],
    captures: ["counters_snapshot", "network_bytes"],
    observations: [
      "The current poster stays visible instead of collapsing to an error screen.",
      "Retries are paused rather than looping.",
      "Paging within already-loaded pages still works.",
    ],
    gates: ["Offline state is usable and does not spin"],
    requiresPhysicalDevice: false,
  },
  {
    id: "shorts-recovery",
    label: "Recovery and playback-error retry",
    prdReference: "Phase 6 — recovery; section 8.3 retry affordance",
    steps: [
      "Restore connectivity after the offline scenario and confirm the feed recovers.",
      "Force a playback error on one page, for example by revoking its playback ID.",
      "Use the retry affordance, then page past the broken item.",
    ],
    captures: ["counters_snapshot", "first_frame_samples"],
    observations: [
      "Recovery does not require an app restart.",
      "A broken page shows a retry action, not a blank screen.",
      "One broken item does not block paging to the next.",
    ],
    gates: ["Playback failure on one item does not block paging"],
    requiresPhysicalDevice: false,
  },
  {
    id: "shorts-50-item-memory",
    label: `${VERTICAL_STANDARD_SCENARIO_ITEM_COUNT}-item down/up memory run`,
    prdReference: "Phase 6 — standard 50-item memory scenario; section 12 memory target",
    steps: [
      "Record steady-state memory after the first page settles.",
      `Page down through ${VERTICAL_STANDARD_SCENARIO_ITEM_COUNT} items at a steady pace.`,
      "Page back up to the first item.",
      "Idle for 30 seconds, then record memory again.",
    ],
    captures: ["memory", "cpu", "counters_snapshot", "network_bytes"],
    observations: [
      "Memory returns toward steady state rather than ratcheting.",
      "Retained preloaded items never exceed current plus one.",
    ],
    gates: ["Memory after 50-item down/up run returns within 20% of steady state"],
    requiresPhysicalDevice: true,
  },
];

export function getShortsScenario(id: string): ShortsScenario | undefined {
  return SHORTS_SCENARIOS.find((scenario) => scenario.id === id);
}

export type ShortsRunCell = {
  scenarioId: string;
  profileId: string;
  networkStateId: string;
  measurementValidity: MeasurementValidity;
  /** True when this cell can only produce a functional pass/fail. */
  functionalOnly: boolean;
};

/**
 * Expands profiles x scenarios x network states into run-sheet cells.
 *
 * A physical-device scenario running on a simulator is still worth a cell — it
 * catches functional breakage — but it is marked `functionalOnly` so its timing
 * numbers never get read as measurements.
 */
export function buildShortsRunMatrix(
  profileIds: readonly string[],
  scenarioIds: readonly string[] = SHORTS_SCENARIOS.map((scenario) => scenario.id),
  networkStateIds: readonly string[] = ["warm-cache", "cold-wifi"],
): ShortsRunCell[] {
  const cells: ShortsRunCell[] = [];

  for (const profileId of profileIds) {
    const profile = getDeviceProfile(profileId);
    if (!profile) continue;

    for (const scenarioId of scenarioIds) {
      const scenario = getShortsScenario(scenarioId);
      if (!scenario) continue;

      for (const networkStateId of networkStateIds) {
        if (!FEED_NETWORK_STATES.some((state) => state.id === networkStateId)) continue;

        cells.push({
          scenarioId,
          profileId,
          networkStateId,
          measurementValidity: profile.measurementValidity,
          functionalOnly:
            profile.measurementValidity === "functional-only" ||
            (scenario.requiresPhysicalDevice && profile.kind !== "physical"),
        });
      }
    }
  }

  return cells;
}

export type ChecklistItem = {
  id: string;
  statement: string;
  prdReference: string;
  /** How the item is judged: by reading instrumentation, or by watching. */
  evidence: "instrumented" | "observed" | "automated";
};

/**
 * Vertical-feed PRD section 12 functional acceptance, verbatim in intent.
 *
 * Each item is a thing a human or a test signs off, not a thing this module
 * evaluates. Nothing here reports a pass on its own.
 */
export const SHORTS_ACCEPTANCE_CHECKLIST: readonly ChecklistItem[] = [
  {
    id: "accept-9-16-eligible",
    statement:
      "Uploading or backfilling an exact 9:16 asset makes it eligible for Shorts.",
    prdReference: "Section 12 functional acceptance",
    evidence: "automated",
  },
  {
    id: "accept-non-9-16-excluded",
    statement:
      "Uploading a 16:9, 4:5, square, or malformed-ratio asset does not make it eligible for Shorts.",
    prdReference: "Section 12 functional acceptance",
    evidence: "automated",
  },
  {
    id: "accept-exactly-one-feed",
    statement:
      "After the Home cutover, the same ready asset appears in exactly one of Home or Shorts.",
    prdReference: "Section 12 functional acceptance",
    evidence: "instrumented",
  },
  {
    id: "accept-one-page-plays",
    statement: "Swiping settles on one page and only that page plays.",
    prdReference: "Section 12 functional acceptance",
    evidence: "instrumented",
  },
  {
    id: "accept-tap-and-sound",
    statement:
      "Tapping pauses and resumes; the sound control updates actual player state.",
    prdReference: "Section 12 functional acceptance",
    evidence: "observed",
  },
  {
    id: "accept-tab-switch-exclusive",
    statement: "Switching Home to Shorts never leaves both screens playing.",
    prdReference: "Section 12 functional acceptance",
    evidence: "instrumented",
  },
  {
    id: "accept-lifecycle-release",
    statement:
      "Backgrounding, opening detail, signing out, and unmounting pause or release correctly.",
    prdReference: "Section 12 functional acceptance",
    evidence: "instrumented",
  },
  {
    id: "accept-states-usable",
    statement:
      "Pagination, empty state, end state, offline recovery, and playback errors are usable.",
    prdReference: "Section 12 functional acceptance",
    evidence: "observed",
  },
  {
    id: "accept-physical-matrix",
    statement: "iOS and Android pass the manual matrix in portrait and landscape.",
    prdReference: "Section 12 functional acceptance",
    evidence: "observed",
  },
];

/**
 * Home must not regress as a side effect of extracting shared feed primitives
 * (PRD section 11: "the implementation may extract shared feed primitives, but
 * Home behavior must not regress as a side effect").
 *
 * This list is the Home-side counterweight to the Shorts scenarios: run it
 * before and after any change to a shared hook, controller, or policy.
 */
export const HOME_REGRESSION_CHECKLIST: readonly ChecklistItem[] = [
  {
    id: "regress-home-first-frame",
    statement:
      "Home warm and cold first-frame p75 are within the pre-change baseline, or the delta is explained.",
    prdReference: "Phase 6 — re-run the Home baseline",
    evidence: "instrumented",
  },
  {
    id: "regress-home-dropped-frames",
    statement: "Home dropped-frame ratio in the 50-item scroll has not increased.",
    prdReference: "Phase 6 — re-run the Home baseline",
    evidence: "instrumented",
  },
  {
    id: "regress-home-memory",
    statement: "Home memory after the 50-item down/up run has not increased.",
    prdReference: "Phase 6 — re-run the Home baseline",
    evidence: "instrumented",
  },
  {
    id: "regress-home-invariants",
    statement:
      "Home player, surface, and source-replacement counters still satisfy the one-player invariants.",
    prdReference: "Phase 6 — verify counters remain within invariants",
    evidence: "instrumented",
  },
  {
    id: "regress-home-card-contract",
    statement:
      "The Home card response still matches the eight-field contract with no rich metadata.",
    prdReference: "Section 10.3 shared card data",
    evidence: "automated",
  },
  {
    id: "regress-home-pagination",
    statement: "Home pagination still produces no duplicate, skipped, or reordered cards.",
    prdReference: "Section 12 duplicate or cursor-lost cards",
    evidence: "instrumented",
  },
  {
    id: "regress-home-visibility",
    statement:
      "Home still shows every asset it showed before, including unknown-placement legacy rows, while exclusive placement is off.",
    prdReference: "Section 3 decision 8; section 15 rollout sequence",
    evidence: "automated",
  },
  {
    id: "regress-home-independent-of-shorts",
    statement:
      "A failing or disabled Shorts query has no effect on Home rendering or playback.",
    prdReference: "Section 12 — Shorts query failure impact on Home",
    evidence: "observed",
  },
];

export const SHORTS_ACCESSIBILITY_CHECKLIST: readonly ChecklistItem[] = [
  {
    id: "a11y-labels",
    statement:
      "Screen-reader labels include video title, channel, playback state, sound state, and action names.",
    prdReference: "Section 8.5",
    evidence: "observed",
  },
  {
    id: "a11y-touch-targets",
    statement: "Every control meets minimum touch-target size and contrast requirements.",
    prdReference: "Section 8.5",
    evidence: "observed",
  },
  {
    id: "a11y-reduced-motion",
    statement:
      "Reduced motion disables autoplay but still permits manual playback and paging.",
    prdReference: "Section 8.5",
    evidence: "observed",
  },
  {
    id: "a11y-dynamic-type",
    statement: "Dynamic type does not push essential controls outside the safe area.",
    prdReference: "Section 8.5",
    evidence: "observed",
  },
  {
    id: "a11y-no-fake-actions",
    statement:
      "No local-only like count or otherwise nonfunctional action is displayed.",
    prdReference: "Section 8.4; section 5 non-goals",
    evidence: "observed",
  },
];

/** Every checklist, keyed for the run-sheet generator. */
export const SHORTS_CHECKLISTS = {
  acceptance: SHORTS_ACCEPTANCE_CHECKLIST,
  homeRegression: HOME_REGRESSION_CHECKLIST,
  accessibility: SHORTS_ACCESSIBILITY_CHECKLIST,
} as const;

export type ShortsChecklistName = keyof typeof SHORTS_CHECKLISTS;
