import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { captionDirectivePlan, provisionCaptionDirectives } from "../scripts/provision-caption-directives.mjs";

function fixture() {
  const rows = [], calls = [], output = [];
  let failed = false;
  const state = { failSecond: false, loseFirstResponse: false, malformedFirstResponse: false };
  const options = {
    create: true,
    env: { MUX_TOKEN_ID: "test", MUX_TOKEN_SECRET: "test" },
    emit: (line) => output.push(line),
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, body: init.body && JSON.parse(init.body) });
      assert.equal(new URL(url).origin, "https://api.mux.com");
      assert.equal(url.includes("/runs"), false);
      if (init.method === "POST") {
        if (state.failSecond && rows.length === 1 && !failed) {
          failed = true;
          return new Response("{}", { status: 503 });
        }
        const row = { ...JSON.parse(init.body), id: `drv_test${rows.length + 1}` };
        rows.push(row);
        if (state.loseFirstResponse && rows.length === 1) throw new Error("Connection lost after acceptance");
        if (state.malformedFirstResponse && rows.length === 1) return new Response("{", { status: 201 });
        return Response.json({ data: row }, { status: 201 });
      }
      if (new URL(url).search) return Response.json({ data: rows });
      return Response.json({ data: rows.find((row) => url.endsWith(`/${row.id}`)) });
    },
  };
  return { rows, calls, output, state, options };
}

test("default provisioning plan needs no credentials or network", async () => {
  const result = await provisionCaptionDirectives({ env: {}, fetchImpl: () => assert.fail("Dry run must not contact Mux") });
  assert.equal(result.mode, "dry-run");
  assert.deepEqual(result.directives.map((entry) => entry.definition.workflows[0].params.include_speakers), [false, true]);
  for (const { definition } of result.directives) {
    assert.equal(definition.workflows.length, 1);
    assert.equal(definition.workflows[0].workflow, "generate-premium-captions");
    assert.equal(definition.workflows[0].params.replace_existing_tracks, "fail");
  }
});

test("real CLI defaults to a JSON dry run", () => {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/provision-caption-directives.mjs"], {
    cwd: new URL("../", import.meta.url), encoding: "utf8", env: { ...process.env, MUX_TOKEN_ID: "", MUX_TOKEN_SECRET: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).mode, "dry-run");
});

test("provisioning creates two definitions, never runs them, and reuses them on rerun", async () => {
  const f = fixture();
  const first = await provisionCaptionDirectives(f.options);
  assert.equal(f.rows.length, 2);
  assert.deepEqual(first.directives.map((entry) => entry.reused), [false, false]);
  const second = await provisionCaptionDirectives(f.options);
  assert.deepEqual(second.directives.map((entry) => entry.reused), [true, true]);
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 2);
  assert.match(f.output[0], /^MUX_CAPTION_DIRECTIVE_WITHOUT_SPEAKERS_ID=drv_/);
  assert.match(f.output[1], /^MUX_CAPTION_DIRECTIVE_WITH_SPEAKERS_ID=drv_/);
});

test("partial provisioning preserves the first ID and reuses it on operator retry", async () => {
  const f = fixture(); f.state.failSecond = true;
  await assert.rejects(provisionCaptionDirectives(f.options), /503/);
  assert.equal(f.rows.length, 1);
  assert.equal(f.output.length, 1);
  await provisionCaptionDirectives(f.options);
  assert.equal(f.rows.length, 2);
  assert.equal(f.calls.filter((call) => call.method === "POST" && call.body.name === f.rows[0].name).length, 1);
});

for (const failure of ["loseFirstResponse", "malformedFirstResponse"]) {
  test(`an accepted request with ${failure} warns before any retry`, async () => {
    const f = fixture(); f.state[failure] = true;
    await assert.rejects(provisionCaptionDirectives(f.options), /creation may have succeeded.*inspect.*before retrying/i);
    assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
    assert.equal(f.rows.length, 1);
  });
}

test("immutable configurations cannot be silently repurposed", async () => {
  const f = fixture();
  const wrong = captionDirectivePlan()[0].definition;
  wrong.workflows[0].params.include_speakers = true;
  f.rows.push({ ...wrong, id: "drv_wrong" });
  await assert.rejects(provisionCaptionDirectives(f.options), /does not match/);
  assert.equal(f.calls.some((call) => call.method === "POST"), false);
});

test("duplicate names and missing credentials fail without creating definitions", async () => {
  const f = fixture();
  const definition = captionDirectivePlan()[0].definition;
  f.rows.push({ ...definition, id: "drv_a" }, { ...definition, id: "drv_b" });
  await assert.rejects(provisionCaptionDirectives(f.options), /Multiple Directives/);
  assert.equal(f.calls.some((call) => call.method === "POST"), false);
  await assert.rejects(provisionCaptionDirectives({ ...f.options, env: {} }), /Set MUX_TOKEN_ID/);
});
