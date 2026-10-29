export type MuxPremiumCaptionsStatus =
  | "pending"
  | "processing"
  | "completed"
  | "errored"
  | "cancelled";

export type MuxPremiumCaptionsJob = {
  id: string;
  status: MuxPremiumCaptionsStatus;
  outputs?: {
    track_id?: string;
    language_code?: string;
    temporary_srt_url?: string;
    detected_language_code?: string;
    replaced_track_ids?: string[];
  };
  errors?: { message?: string; type?: string }[];
  [key: string]: unknown;
};

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function buildMuxPremiumCaptionsRequest(args: {
  muxAssetId: string;
  userId: string;
}) {
  return {
    passthrough: JSON.stringify(args),
    parameters: {
      asset_id: args.muxAssetId,
      language_code: "en",
      track_name: "English (Premium)",
      replace_existing_tracks: "fail",
      upload_to_mux: true,
    },
  };
}

export class MuxPremiumCaptionsHttpError extends Error {
  status: number;

  constructor(status: number, details?: string) {
    super(
      `Mux Premium Captions request failed (${status})${details ? `: ${details}` : ""}.`,
    );
    this.name = "MuxPremiumCaptionsHttpError";
    this.status = status;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function parseMuxPremiumCaptionsJob(
  payload: unknown,
): MuxPremiumCaptionsJob {
  const root = asRecord(payload);
  const job = asRecord(root.data ?? root.job ?? root);
  if (typeof job.id !== "string" || !job.id.trim()) {
    throw new Error("Mux Premium Captions response did not include a job id.");
  }
  if (
    job.status !== "pending" &&
    job.status !== "processing" &&
    job.status !== "completed" &&
    job.status !== "errored" &&
    job.status !== "cancelled"
  ) {
    throw new Error("Mux Premium Captions response included an invalid status.");
  }
  return job as MuxPremiumCaptionsJob;
}

async function requestJson(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
) {
  const response = await fetchImpl(url, {
    ...init,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const details = (await response.text().catch(() => "")).trim();
    throw new MuxPremiumCaptionsHttpError(response.status, details);
  }
  return parseMuxPremiumCaptionsJob(await response.json());
}

export function createMuxPremiumCaptionsJob(
  fetchImpl: FetchLike,
  url: string,
  authorization: string,
  body: Record<string, unknown>,
) {
  return requestJson(fetchImpl, url, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

export function getMuxPremiumCaptionsJob(
  fetchImpl: FetchLike,
  url: string,
  authorization: string,
) {
  return requestJson(fetchImpl, url, {
    method: "GET",
    headers: { Authorization: authorization },
  });
}
