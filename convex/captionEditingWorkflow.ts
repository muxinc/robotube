/** Recovery is safe only after a confirmed terminal response from Robots. */
export function canRecoverCaptionCensor(row: any): boolean {
  return Boolean(row?.operation === "manual" && row.pipelineStage === "censor_failed" &&
    row.intermediateTrackId && ["errored", "cancelled"].includes(row.status) &&
    !row.submissionUncertainAtMs && !row.pollingTimedOutAtMs);
}

export function blocksCaptionEditing(row: any): boolean {
  return Boolean(row && (["requested", "pending", "processing"].includes(row.status) ||
    row.submissionUncertainAtMs || row.pollingTimedOutAtMs || canRecoverCaptionCensor(row) ||
    (row.status === "completed" && row.reconciliationStatus !== "completed")));
}

export function censorRequest(row: any) {
  return {
    passthrough: JSON.stringify({ muxAssetId: row.muxAssetId, userId: row.userId,
      editRequestId: String(row._id), censorAttempt: row.censorAttempt }),
    parameters: { asset_id: row.muxAssetId, track_id: row.intermediateTrackId,
      auto_censor_profanity: { mode: "blank" }, upload_to_mux: true,
      delete_original_track: true, track_name_suffix: `censored-${row.censorAttempt}` },
  };
}

export function acceptsCensorEvent(row: any, jobId: string, passthrough?: string): boolean {
  if (row.operation !== "manual") return true;
  if (!["censor_submitting", "censoring", "censor_failed"].includes(row.pipelineStage)) return false;
  if (row.jobId) return row.jobId === jobId;
  try {
    return JSON.parse(passthrough ?? "{}").censorAttempt === row.censorAttempt;
  } catch { return false; }
}

/** Only a ready final replacement permits deleting the original source. */
export async function deleteReplacedSource(row: any, asset: any,
  removeTrack: (assetId: string, trackId: string) => Promise<unknown>) {
  if (row.operation !== "manual") return;
  const final = asset.tracks?.find((track: any) => track.id === row.uploadedTrackId);
  if (!final || final.type !== "text" || final.status !== "ready") throw new Error("Replacement captions are not ready.");
  if (row.sourceTrackId === row.uploadedTrackId) throw new Error("Replacement must differ from the original source.");
  try { await removeTrack(row.muxAssetId, row.sourceTrackId); }
  catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
  asset.tracks = asset.tracks.filter((track: any) => track.id !== row.sourceTrackId);
}
