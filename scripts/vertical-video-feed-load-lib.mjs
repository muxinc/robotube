/**
 * Loads the `lib/vertical-video-feed*` modules — and the `lib/feed-*` modules
 * they build on — into plain Node so the vertical feed can be tested and
 * scripted without a React Native runtime.
 *
 * This mirrors `scripts/news-feed-load-lib.mjs` deliberately rather than
 * importing from it: the two lanes own separate module lists, and a shared
 * mutable list is a merge conflict waiting to happen. The compile settings are
 * identical, so both loaders type-check their modules the same way.
 *
 * Robotube has no test runner in `package.json` and this work does not add one.
 * The modules are compiled to CommonJS in a temp directory with the TypeScript
 * compiler that is already a dev dependency, then imported dynamically.
 * Compiler options are passed on the command line so the app's `tsconfig.json`
 * (JSX, React Native types, `noEmit`) does not apply.
 *
 * A side effect worth having: every load is also a standalone type check of
 * these modules in isolation from the app.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = resolve(scriptDir, "..");
export const LIB_DIR = join(REPO_ROOT, "lib");

/**
 * Module basenames. Dependency order is irrelevant — tsc compiles them
 * together — but the shared `feed-*` modules must be present because the
 * vertical modules import types and helpers from them.
 */
export const VERTICAL_LIB_MODULES = [
  "feed-performance-events",
  "feed-performance-counters",
  "feed-performance-timeline",
  "feed-performance-test-feed",
  "feed-performance-scenarios",
  "feed-feature-kill-switch",
  "feed-feature-flags",
  "vertical-video-feed-fixtures",
  "vertical-video-feed-audit",
  "vertical-video-feed-scenarios",
  "vertical-video-feed-rollout",
  "vertical-video-feed-dashboards",
  "vertical-video-feed",
];

function resolveTscBin() {
  const local = join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(local)) {
    throw new Error(
      `TypeScript compiler not found at ${local}. Run \`npm ci\` in ${REPO_ROOT} first.`,
    );
  }
  return local;
}

/**
 * Compiles the vertical-feed modules to a fresh temp directory.
 *
 * @returns {{ outDir: string }}
 */
export function compileVerticalLib() {
  const tscBin = resolveTscBin();
  const outDir = mkdtempSync(join(tmpdir(), "robotube-vertical-lib-"));
  const sources = VERTICAL_LIB_MODULES.map((name) => join(LIB_DIR, `${name}.ts`));

  for (const source of sources) {
    if (!existsSync(source)) {
      throw new Error(`Expected vertical-feed module is missing: ${source}`);
    }
  }

  const result = spawnSync(
    process.execPath,
    [
      tscBin,
      ...sources,
      "--outDir",
      outDir,
      "--rootDir",
      LIB_DIR,
      "--module",
      "commonjs",
      "--moduleResolution",
      "node",
      "--target",
      "es2022",
      "--lib",
      "es2022,dom",
      "--strict",
      "--esModuleInterop",
      "--forceConsistentCasingInFileNames",
      "--skipLibCheck",
    ],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );

  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new Error(`Failed to compile vertical-feed modules:\n${output}`);
  }

  return { outDir };
}

/**
 * Compiles and imports every vertical-feed module.
 *
 * @returns {Promise<Record<string, any>>} keyed by module basename
 */
export async function loadVerticalLib() {
  const { outDir } = compileVerticalLib();
  const modules = {};

  for (const name of VERTICAL_LIB_MODULES) {
    const imported = await import(pathToFileURL(join(outDir, `${name}.js`)).href);
    // tsc emits CommonJS here, so `default` is the whole `module.exports`.
    modules[name] = imported.default ?? imported;
  }

  return modules;
}
