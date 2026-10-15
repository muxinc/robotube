export type MuxCaptionEditingStatus =
  | "pending"
  | "processing"
  | "completed"
  | "errored"
  | "cancelled";

export type MuxCaptionEditingJob = {
  id: string;
  status: MuxCaptionEditingStatus;
  [key: string]: unknown;
};

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class MuxCaptionEditingHttpError extends Error {
  status: number;

  constructor(status: number) {
    super(`Mux caption-editing request failed (${status}).`);
    this.name = "MuxCaptionEditingHttpError";
    this.status = status;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function unwrapJob(payload: unknown) {
  const root = asRecord(payload);
  return asRecord(root.data ?? root.job ?? root);
}

function requireJob(payload: unknown): MuxCaptionEditingJob {
  const job = unwrapJob(payload);
  if (typeof job.id !== "string" || !job.id.trim()) {
    throw new Error("Mux caption-editing response did not include a job id.");
  }
  if (
    job.status !== "pending" &&
    job.status !== "processing" &&
    job.status !== "completed" &&
    job.status !== "errored" &&
    job.status !== "cancelled"
  ) {
    throw new Error("Mux caption-editing response included an invalid status.");
  }
  return job as MuxCaptionEditingJob;
}

async function requestJson(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
) {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new MuxCaptionEditingHttpError(response.status);
  return requireJob(await response.json());
}

export function createMuxCaptionEditingJob(
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

export function getMuxCaptionEditingJob(
  fetchImpl: FetchLike,
  url: string,
  authorization: string,
) {
  return requestJson(fetchImpl, url, {
    method: "GET",
    headers: { Authorization: authorization },
  });
}
