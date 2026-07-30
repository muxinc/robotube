/**
 * Generates a Phase 0 measurement run sheet for the news feed.
 *
 *   node scripts/news-feed-run-sheet.mjs
 *   node scripts/news-feed-run-sheet.mjs --out docs/news-feed-run-sheet.md
 *
 * Two halves:
 *
 *   1. Tooling inventory — probes the machine for real devices, simulators,
 *      emulators, and build tooling. It only reports what the commands return.
 *      Missing tooling is printed as missing, never as an assumption.
 *   2. Blank result tables — one row per scenario x network state, with the
 *      measurement-validity label attached so simulator and emulator numbers
 *      cannot be silently merged into physical-device results.
 *
 * The generator never fills in a measurement. Every result cell ships empty.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

import { loadFeedLib } from "./news-feed-load-lib.mjs";

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
  const iosRuntimes = probe("xcrun", ["simctl", "list", "runtimes", "available"]);
  const bootedSimulators = probe("xcrun", ["simctl", "list", "devices", "booted"]);
  const xcode = probe("xcodebuild", ["-version"]);
  const adbDevices = probe("adb", ["devices", "-l"]);
  const avds = androidHome
    ? probe(`${androidHome}/emulator/emulator`, ["-list-avds"])
    : { ok: false, output: "ANDROID_HOME is not set" };
  const java = probe("java", ["-version"]);
  const eas = probe("eas", ["--version"]);

  return [
    { label: "Node", detail: globalThis.process.version },
    { label: "Xcode", detail: xcode.ok ? firstLine(xcode.output) : "not found" },
    {
      label: "Physical iOS devices",
      detail: physicalIos.ok ? physicalIos.output || "none" : "xcrun devicectl unavailable",
      block: true,
    },
    {
      label: "Installed iOS runtimes",
      detail: iosRuntimes.ok ? iosRuntimes.output || "none" : "unavailable",
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
    // `java -version` writes to stderr on most JDKs, so a non-zero read still
    // carries the version string.
    { label: "Java", detail: firstLine(java.ok ? java.output : java.output) || "not found" },
    { label: "eas-cli", detail: eas.ok ? firstLine(eas.output) : "not found" },
  ];
}

function renderInventory(inventory) {
  const lines = ["## Observed tooling", ""];
  for (const entry of inventory) {
    if (entry.block && entry.detail.includes("\n")) {
      lines.push(`- **${entry.label}:**`, "", "  ```text", ...entry.detail.split("\n").map((l) => `  ${l}`), "  ```", "");
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
    "| Profile | Platform | Kind | Measurement validity | Availability | Note |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const profile of scenarios.FEED_DEVICE_PROFILES) {
    lines.push(
      `| ${profile.id} | ${profile.platform} | ${profile.kind} | ${profile.measurementValidity} | ${profile.availability} | ${profile.note} |`,
    );
  }
  lines.push("");
  return lines;
}

function renderScenarioTables(scenarios, profileIds) {
  const lines = ["## Run sheet", ""];

  for (const profileId of profileIds) {
    const profile = scenarios.getDeviceProfile(profileId);
    if (!profile) continue;

    lines.push(`### ${profile.label}`, "");
    if (profile.measurementValidity === "functional-only") {
      lines.push(
        "> Functional-only profile. Record pass/fail and defects here. Do not record frame, CPU, memory, or first-frame numbers as performance results.",
        "",
      );
    }

    lines.push(
      "| Scenario | Network state | Run 1 | Run 2 | Comparable? | Counters snapshot | Notes |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    );

    for (const cell of scenarios.buildRunMatrix([profileId])) {
      const scenario = scenarios.getScenario(cell.scenarioId);
      const network = scenarios.FEED_NETWORK_STATES.find((s) => s.id === cell.networkStateId);
      lines.push(
        `| ${scenario.label} | ${network.label} |  |  |  |  |  |`,
      );
    }
    lines.push("");
  }

  return lines;
}

function renderScenarioDetail(scenarios) {
  const lines = ["## Scenario steps", ""];
  for (const scenario of scenarios.FEED_SCENARIOS) {
    lines.push(`### ${scenario.label} (\`${scenario.id}\`)`, "");
    for (const step of scenario.steps) lines.push(`1. ${step}`);
    lines.push("", `**Captures:** ${scenario.captures.join(", ")}`, "");
    lines.push(`**Feeds gates:** ${scenario.gates.join("; ")}`, "");
  }
  return lines;
}

function renderNetworkStates(scenarios) {
  const lines = ["## Reference network states", ""];
  for (const state of scenarios.FEED_NETWORK_STATES) {
    lines.push(`- **${state.label}** (\`${state.id}\`, expects ${state.expectedCacheState} cache): ${state.setup}`);
  }
  lines.push("");
  return lines;
}

const lib = await loadFeedLib();
const scenarios = lib["feed-performance-scenarios"];

const profileIds = scenarios.FEED_DEVICE_PROFILES.filter(
  (profile) => profile.availability === "observed",
).map((profile) => profile.id);

const output = [
  "# News feed performance run sheet",
  "",
  "Generated by `scripts/news-feed-run-sheet.mjs`. Every result cell starts empty:",
  "fill it in from an actual run or leave it blank.",
  "",
  `Standard scroll scenario length: ${scenarios.STANDARD_SCENARIO_ITEM_COUNT} items.`,
  "",
  ...renderInventory(collectInventory()),
  ...renderProfiles(scenarios),
  ...renderNetworkStates(scenarios),
  ...renderScenarioTables(scenarios, profileIds),
  ...renderScenarioDetail(scenarios),
].join("\n");

const argv = globalThis.process.argv.slice(2);
const outIndex = argv.indexOf("--out");

if (outIndex !== -1 && argv[outIndex + 1]) {
  writeFileSync(argv[outIndex + 1], `${output}\n`, "utf8");
  globalThis.console.log(`Wrote ${argv[outIndex + 1]}`);
} else {
  globalThis.console.log(output);
}
