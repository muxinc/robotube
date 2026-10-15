import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createMuxCaptionEditingJob,
  getMuxCaptionEditingJob,
  MuxCaptionEditingHttpError,
  type MuxCaptionEditingStatus,
} from "../convex/captionEditingMuxAdapter.ts";

const API = "https://api.mux.com/robots/v0/jobs/edit-captions";

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
] satisfies MuxCaptionEditingStatus[]) {
  test(`normalizes a ${status} Mux job response`, async () => {
    const job = await getMuxCaptionEditingJob(
      async () => jsonResponse({ data: { id: `job-${status}`, status } }),
      `${API}/job-${status}`,
      "Basic test",
    );
    assert.equal(job.id, `job-${status}`);
    assert.equal(job.status, status);
  });
}

test("creates a job with server authorization and the supplied request body", async () => {
  let request: { url?: string; init?: RequestInit } = {};
  const body = {
    passthrough: "opaque-request-id",
    parameters: {
      asset_id: "asset-1",
      track_id: "track-1",
      upload_to_mux: true,
      delete_original_track: true,
    },
  };
  const job = await createMuxCaptionEditingJob(
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
  assert.deepEqual(request.init?.headers, {
    Authorization: "Basic server-secret",
    "Content-Type": "application/json",
  });
  assert.deepEqual(JSON.parse(String(request.init?.body)), body);
});

for (const status of [401, 403, 429, 503]) {
  test(`preserves HTTP ${status} for safe caller-side error mapping`, async () => {
    await assert.rejects(
      () =>
        getMuxCaptionEditingJob(
          async () => new Response(null, { status }),
          `${API}/job-1`,
          "Basic test",
        ),
      (error: unknown) =>
        error instanceof MuxCaptionEditingHttpError && error.status === status,
    );
  });
}

test("rejects malformed successful responses", async () => {
  await assert.rejects(
    () =>
      getMuxCaptionEditingJob(
        async () => jsonResponse({ data: { status: "completed" } }),
        `${API}/missing-id`,
        "Basic test",
      ),
    /did not include a job id/,
  );
  await assert.rejects(
    () =>
      getMuxCaptionEditingJob(
        async () => jsonResponse({ data: { id: "job-1", status: "unknown" } }),
        `${API}/bad-status`,
        "Basic test",
      ),
    /invalid status/,
  );
});

test("propagates network failures so polling can schedule a retry", async () => {
  await assert.rejects(
    () =>
      getMuxCaptionEditingJob(
        async () => {
          throw new Error("network unavailable");
        },
        `${API}/job-1`,
        "Basic test",
      ),
    /network unavailable/,
  );
});
