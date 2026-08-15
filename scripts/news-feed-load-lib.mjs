/**
 * Loads the `lib/feed-performance*` and `lib/feed-feature*` modules into plain
 * Node so they can be tested and scripted without a React Native runtime.
 *
 * Robotube has no test runner in `package.json`, and this work is not allowed
 * to add one. Instead the modules are compiled to CommonJS in a temp directory
 * with the TypeScript compiler that is already a dev dependency, then imported
 * dynamically. Compiler options are passed on the command line so the app's
 * `tsconfig.json` (JSX, React Native types, `noEmit`) does not apply.
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

/** Module basenames, dependency order irrelevant — tsc compiles them together. */
export const FEED_LIB_MODULES = [
  "feed-performance-events",
  "feed-performance-counters",
  "feed-performance-timeline",
  "feed-performance-test-feed",
  "feed-performance-scenarios",
  "feed-performance",
  "feed-feature-kill-switch",
  "feed-feature-flags",
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
 * Compiles the feed modules to a fresh temp directory.
 *
 * @returns {{ outDir: string }}
 */
export function compileFeedLib() {
  const tscBin = resolveTscBin();
  const outDir = mkdtempSync(join(tmpdir(), "robotube-feed-lib-"));
  const sources = FEED_LIB_MODULES.map((name) => join(LIB_DIR, `${name}.ts`));

  for (const source of sources) {
    if (!existsSync(source)) {
      throw new Error(`Expected feed module is missing: ${source}`);
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
    throw new Error(`Failed to compile feed modules:\n${output}`);
  }

  return { outDir };
}

/**
 * Compiles and imports every feed module.
 *
 * @returns {Promise<Record<string, any>>} keyed by module basename
 */
export async function loadFeedLib() {
  const { outDir } = compileFeedLib();
  const modules = {};

  for (const name of FEED_LIB_MODULES) {
    const imported = await import(pathToFileURL(join(outDir, `${name}.js`)).href);
    // tsc emits CommonJS here, so `default` is the whole `module.exports`.
    modules[name] = imported.default ?? imported;
  }

  return modules;
}
