import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildMuxPremiumCaptionsRequest,
  createMuxPremiumCaptionsJob,
  getMuxPremiumCaptionsJob,
  MuxPremiumCaptionsHttpError,
  parseMuxPremiumCaptionsJob,
  type MuxPremiumCaptionsStatus,
} from "../convex/premiumCaptionsMuxAdapter.ts";

const API = "https://api.mux.com/robots/v1/jobs/generate-premium-captions";

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

for (const status of [
  "pending",
  "processing",
  "completed",
  "errored",
  "cancelled",
] satisfies MuxPremiumCaptionsStatus[]) {
  test(`normalizes a ${status} Premium Captions job response`, () => {
    const job = parseMuxPremiumCaptionsJob({
      data: { id: `job-${status}`, status },
    });
    assert.equal(job.id, `job-${status}`);
    assert.equal(job.status, status);
  });
}

test("creates English Premium Captions and uploads the track to Mux", async () => {
  let request: { url?: string; init?: RequestInit } = {};
  const body = buildMuxPremiumCaptionsRequest({
    muxAssetId: "asset-1",
    userId: "owner",
  });

  const job = await createMuxPremiumCaptionsJob(
    async (url, init) => {
      request = { url: String(url), init };
      return jsonResponse({ data: { id: "job-1", status: "pending" } });
    },
    API,
    "Basic server-secret",
    body,
  );

  assert.equal(job.id, "job-1");
  assert.equal(request.url, API);
  assert.equal(request.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(request.init?.body)), body);
  assert.deepEqual(body.parameters, {
    asset_id: "asset-1",
    language_code: "en",
    track_name: "English (Premium)",
    replace_existing_tracks: "fail",
    upload_to_mux: true,
  });
});

test("reads the uploaded track from a completed job", async () => {
  const job = await getMuxPremiumCaptionsJob(
    async () =>
      jsonResponse({
        data: {
          id: "job-1",
          status: "completed",
          outputs: { track_id: "track-en", language_code: "en" },
        },
      }),
    `${API}/job-1`,
    "Basic server-secret",
  );

  assert.equal(job.outputs?.track_id, "track-en");
  assert.equal(job.outputs?.language_code, "en");
});

test("preserves the HTTP status and response details", async () => {
  await assert.rejects(
    () =>
      getMuxPremiumCaptionsJob(
        async () => new Response("missing Robots scope", { status: 403 }),
        `${API}/job-1`,
        "Basic test",
      ),
    (error: unknown) =>
      error instanceof MuxPremiumCaptionsHttpError &&
      error.status === 403 &&
      error.message.includes("missing Robots scope"),
  );
});
