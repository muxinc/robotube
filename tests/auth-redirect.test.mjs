import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../convex/auth.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
});
let redirect;
runInNewContext(outputText, {
  exports: {},
  URL,
  process: { env: { SITE_URL: "robotube://" } },
  require(name) {
    if (name === "@auth/core/providers/google") return { default: {} };
    assert.equal(name, "@convex-dev/auth/server");
    return {
      convexAuth({ callbacks }) {
        redirect = callbacks.redirect;
        return {};
      },
    };
  },
});
assert.equal(typeof redirect, "function");

for (const origin of [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5175",
  "http://127.0.0.1:5175",
  "https://robotube.vercel.app",
  "https://robotube-web.workspace-245068.chatgpt.site",
]) {
  test(`allows a return to ${origin} while preserving path and query`, async () => {
    const redirectTo = `${origin}/watch/asset-1?captions=edit`;
    assert.equal(await redirect({ redirectTo }), redirectTo);
  });
}

for (const redirectTo of [
  "http://localhost:5174/watch/asset-1",
  "http://localhost.evil.example:5175/",
  "http://localhost:5175@evil.example/",
  "https://evil.example/",
]) {
  test(`rejects unapproved redirect ${redirectTo}`, async () => {
    await assert.rejects(redirect({ redirectTo }), /Authentication redirect URL is not allowed/);
  });
}

test("preserves the native application redirect", async () => {
  assert.equal(await redirect({ redirectTo: "robotube://" }), "robotube://");
});
