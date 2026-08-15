#!/usr/bin/env node
/**
 * Unit-test entry point for the feed playback logic.
 *
 *   node scripts/run-tests.mjs
 *
 * The repo has no test framework in `package.json`, so these run on Node's
 * built-in test runner with native TypeScript type stripping. Only pure modules
 * (no React, no react-native imports) are covered here — component and native
 * behaviour stay on the manual/device matrix.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const searchRoots = ["lib", "hooks", "components", "app"];
const skipDirectories = new Set(["node_modules", ".git", ".expo", "dist", "assets"]);

function collectTestFiles(directory, found = []) {
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (skipDirectories.has(entry)) continue;
    const fullPath = join(directory, entry);
    if (statSync(fullPath).isDirectory()) {
      collectTestFiles(fullPath, found);
    } else if (entry.endsWith(".test.ts")) {
      found.push(relative(repoRoot, fullPath));
    }
  }
  return found;
}

const testFiles = searchRoots.flatMap((root) => collectTestFiles(join(repoRoot, root)));

if (testFiles.length === 0) {
  console.error("No *.test.ts files found.");
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    "--no-warnings=ExperimentalWarning",
    "--import",
    "./scripts/register-test-resolver.mjs",
    "--test",
    ...testFiles.sort(),
  ],
  { cwd: repoRoot, stdio: "inherit" },
);

process.exit(result.status ?? 1);
