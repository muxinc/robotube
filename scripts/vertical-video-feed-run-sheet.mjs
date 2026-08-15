/**
 * Generates the Shorts verification run sheet.
 *
 *   node scripts/vertical-video-feed-run-sheet.mjs
 *   node scripts/vertical-video-feed-run-sheet.mjs --out /tmp/shorts-run-sheet.md
 *   node scripts/vertical-video-feed-run-sheet.mjs --profile ios-physical-reference
 *
 * Three halves, in the sense that documents have three halves:
 *
 *   1. Tooling inventory — probes the machine for real devices, simulators,
 *      emulators, and build tooling, reporting only what the commands return.
 *      Missing tooling prints as missing, never as an assumption.
 *   2. Blank result tables — one row per scenario x network state, each stamped
 *      with its measurement validity so a simulator number can never be filed
 *      as a physical-device result.
 *   3. Checklists — acceptance, Home regression, and accessibility, all
 *      unchecked.
 *
 * The generator never fills in a result. Every cell and every box ships empty.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

import { loadVerticalLib } from "./vertical-video-feed-load-lib.mjs";

function probe(command, args) {
  try {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 20_000 });
    if (result.error || result.status !== 0) {
      return { ok: false, output: (result.stderr || result.error?.message || "").trim() };
    }
    // Some tools (notably `java -version`) exit 0 and write to stderr.
    return { ok: true, output: (result.stdout || result.stderr || "").trim() };
  } catch (error) {
    return { ok: false, output: String(error?.message ?? error) };
  }
}

function firstLine(text) {
  return text.split("\n")[0]?.trim() ?? "";
}

function collectInventory() {
  const androidHome =
    globalThis.process.env.ANDROID_HOME || globalThis.process.env.ANDROID_SDK_ROOT || "";

  const physicalIos = probe("xcrun", ["devicectl", "list", "devices"]);
  const bootedSimulators = probe("xcrun", ["simctl", "list", "devices", "booted"]);
  const xcode = probe("xcodebuild", ["-version"]);
  const adbDevices = probe("adb", ["devices", "-l"]);
  const avds = androidHome
    ? probe(`${androidHome}/emulator/emulator`, ["-list-avds"])
    : { ok: false, output: "ANDROID_HOME is not set" };

  return [
    { label: "Node", detail: globalThis.process.version },
    { label: "Xcode", detail: xcode.ok ? firstLine(xcode.output) : "not found" },
    {
      label: "Physical iOS devices",
      detail: physicalIos.ok ? physicalIos.output || "none" : "xcrun devicectl unavailable",
      block: true,
    },
    {
      label: "Booted simulators",
      detail: bootedSimulators.ok
        ? bootedSimulators.output.split("\n").slice(1).join("\n").trim() || "none booted"
        : "unavailable",
      block: true,
    },
    { label: "Android SDK", detail: androidHome || "ANDROID_HOME not set" },
    {
      label: "Physical Android devices",
      detail: adbDevices.ok
        ? adbDevices.output.split("\n").slice(1).filter(Boolean).join("\n") || "none attached"
        : "adb unavailable",
      block: true,
    },
    { label: "Android AVDs", detail: avds.ok ? avds.output || "none" : avds.output, block: true },
  ];
}

function renderInventory(inventory) {
  const lines = ["## Observed tooling", ""];
  for (const entry of inventory) {
    if (entry.block && entry.detail.includes("\n")) {
      lines.push(
        `- **${entry.label}:**`,
        "",
        "  ```text",
        ...entry.detail.split("\n").map((line) => `  ${line}`),
        "  ```",
        "",
      );
    } else {
      lines.push(`- **${entry.label}:** ${entry.detail.replace(/\n/g, " ")}`);
    }
  }
  lines.push("");
  return lines;
}

function renderProfiles(scenarios) {
  const lines = [
    "## Device profiles",
    "",
    "Shared with the news-feed run sheet: the same machine, the same phone, the",
    "same emulator. The `availability` column is a recorded claim in",
    "`lib/feed-performance-scenarios.ts`; the *Observed tooling* section above is",
    "what this machine actually reported just now. Trust the latter when they differ.",
    "",
    "| Profile | Platform | Kind | Measurement validity | Availability |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const profile of scenarios.FEED_DEVICE_PROFILES) {
    lines.push(
      `| ${profile.id} | ${profile.platform} | ${profile.kind} | ${profile.measurementValidity} | ${profile.availability} |`,
    );
  }
  lines.push("");
  return lines;
}

function renderNetworkStates(scenarios) {
  const lines = ["## Reference network states", ""];
  for (const state of scenarios.FEED_NETWORK_STATES) {
    lines.push(
      `- **${state.label}** (\`${state.id}\`, expects ${state.expectedCacheState} cache): ${state.setup}`,
    );
  }
  lines.push("");
  return lines;
}

function renderRunTables(scenarios, profileIds) {
  const lines = ["## Run sheet", ""];

  for (const profileId of profileIds) {
    const profile = scenarios.getDeviceProfile(profileId);
    if (!profile) continue;

    lines.push(`### ${profile.label}`, "");
    if (profile.measurementValidity === "functional-only") {
      lines.push(
        "> Functional-only profile. Record pass/fail and defects here. Do not record",
        "> frame, CPU, memory, or first-frame numbers as performance results.",
        "",
      );
    }

    lines.push(
      "| Scenario | Network state | Validity | Run 1 | Run 2 | Counters snapshot | Defects |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    );

    for (const cell of scenarios.buildShortsRunMatrix([profileId])) {
      const scenario = scenarios.getShortsScenario(cell.scenarioId);
      const network = scenarios.FEED_NETWORK_STATES.find(
        (state) => state.id === cell.networkStateId,
      );
      const validity = cell.functionalOnly ? "functional-only" : "performance";
      lines.push(`| ${scenario.label} | ${network.label} | ${validity} |  |  |  |  |`);
    }
    lines.push("");
  }

  return lines;
}

function renderScenarioDetail(scenarios) {
  const lines = ["## Scenario steps", ""];
  for (const scenario of scenarios.SHORTS_SCENARIOS) {
    lines.push(`### ${scenario.label} (\`${scenario.id}\`)`, "");
    lines.push(`_${scenario.prdReference}_`, "");
    for (const step of scenario.steps) lines.push(`1. ${step}`);
    lines.push("", "**Watch for:**", "");
    for (const observation of scenario.observations) lines.push(`- [ ] ${observation}`);
    lines.push(
      "",
      `**Captures:** ${scenario.captures.join(", ")}`,
      "",
      `**Feeds gates:** ${scenario.gates.join("; ")}`,
      "",
      `**Requires physical device:** ${scenario.requiresPhysicalDevice ? "yes" : "no"}`,
      "",
    );
  }
  return lines;
}

function renderChecklist(title, items) {
  const lines = [`### ${title}`, ""];
  for (const item of items) {
    lines.push(`- [ ] ${item.statement}  <br>_${item.prdReference} — ${item.evidence}_`);
  }
  lines.push("");
  return lines;
}

function renderChecklists(scenarios) {
  return [
    "## Checklists",
    "",
    "Every box starts unchecked. Check one only from an observed run.",
    "",
    ...renderChecklist("Functional acceptance (PRD section 12)", scenarios.SHORTS_ACCEPTANCE_CHECKLIST),
    ...renderChecklist("Home regression", scenarios.HOME_REGRESSION_CHECKLIST),
    ...renderChecklist("Accessibility", scenarios.SHORTS_ACCESSIBILITY_CHECKLIST),
  ];
}

function renderFixtureSummary(fixtures) {
  const groups = [
    ["qualifying", "Exact or reducible 9:16, eligible"],
    ["nonqualifying_ratio", "Valid ratio, not 9:16"],
    ["malformed_ratio", "Missing, malformed, or out-of-domain"],
    ["visibility_excluded", "9:16 but excluded by a visibility rule"],
  ];

  const lines = [
    "## Fixture set",
    "",
    "From `lib/vertical-video-feed-fixtures.ts`. Deterministic and hand-authored:",
    "no wall-clock, no randomness, stable order.",
    "",
    "| Group | Count | Meaning |",
    "| --- | ---: | --- |",
  ];

  for (const [group, meaning] of groups) {
    lines.push(`| \`${group}\` | ${fixtures.getVerticalFeedFixtures(group).length} | ${meaning} |`);
  }

  lines.push(
    "",
    `Eligible for Shorts: ${fixtures.getShortsEligibleFixtures().length}. ` +
      `Must never appear in Shorts: ${fixtures.getShortsIneligibleFixtures().length}.`,
    "",
    "Export the full table with `node scripts/vertical-video-feed-fixtures.mjs --format markdown`.",
    "",
  );

  return lines;
}

const lib = await loadVerticalLib();
const scenarios = lib["vertical-video-feed-scenarios"];
const fixtures = lib["vertical-video-feed-fixtures"];

const argv = globalThis.process.argv.slice(2);
const profileIndex = argv.indexOf("--profile");
const requestedProfile = profileIndex !== -1 ? argv[profileIndex + 1] : null;

const profileIds = requestedProfile
  ? [requestedProfile]
  : scenarios.FEED_DEVICE_PROFILES.filter(
      (profile) => profile.availability === "observed",
    ).map((profile) => profile.id);

const output = [
  "# Shorts (9:16 vertical feed) verification run sheet",
  "",
  "Generated by `scripts/vertical-video-feed-run-sheet.mjs`. Every result cell and",
  "every checkbox starts empty: fill them in from an actual run or leave them blank.",
  "",
  `Standard scroll and memory scenario length: ${scenarios.VERTICAL_STANDARD_SCENARIO_ITEM_COUNT} items.`,
  "",
  ...renderInventory(collectInventory()),
  ...renderProfiles(scenarios),
  ...renderNetworkStates(scenarios),
  ...renderFixtureSummary(fixtures),
  ...renderRunTables(scenarios, profileIds),
  ...renderScenarioDetail(scenarios),
  ...renderChecklists(scenarios),
].join("\n");

const outIndex = argv.indexOf("--out");

if (outIndex !== -1 && argv[outIndex + 1]) {
  writeFileSync(argv[outIndex + 1], `${output}\n`, "utf8");
  globalThis.console.log(`Wrote ${argv[outIndex + 1]}`);
} else {
  globalThis.console.log(output);
}
