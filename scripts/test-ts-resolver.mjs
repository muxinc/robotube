/**
 * Node module-resolution hook for the repo's unit tests.
 *
 * The test files are plain TypeScript run by Node's built-in test runner with
 * `--experimental-strip-types`. Node's ESM resolver requires explicit file
 * extensions, but the repo's `tsconfig.json` does not enable
 * `allowImportingTsExtensions`, so sources import each other extensionless.
 * This hook bridges the two: an extensionless relative specifier resolves to the
 * sibling `.ts` file, and `@/…` resolves against the repo root the same way the
 * Metro/TypeScript `paths` alias does.
 *
 * Used by `scripts/run-tests.mjs`. Nothing in the app bundle imports it.
 */
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const hasKnownExtension = /\.[cm]?[jt]sx?$|\.json$|\.node$/;

function resolveTypeScriptFile(basePathUrl) {
  for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    const candidate = new URL(`${basePathUrl.href}${suffix}`);
    if (existsSync(fileURLToPath(candidate))) return candidate;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const base = pathToFileURL(resolvePath(repoRoot, specifier.slice(2)));
    const matched = hasKnownExtension.test(specifier)
      ? base
      : (resolveTypeScriptFile(base) ?? base);
    return { url: matched.href, format: "module-typescript", shortCircuit: true };
  }

  if (specifier.startsWith(".") && !hasKnownExtension.test(specifier) && context.parentURL) {
    const matched = resolveTypeScriptFile(new URL(specifier, context.parentURL));
    if (matched) {
      return { url: matched.href, format: "module-typescript", shortCircuit: true };
    }
  }

  return nextResolve(specifier, context);
}
