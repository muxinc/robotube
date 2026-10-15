import {
  AlertTriangle,
  Captions,
  Check,
  CircleAlert,
  LoaderCircle,
  X,
} from "lucide-react";
import { useAction, useConvexAuth, useQuery } from "convex/react";
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { api } from "../lib/convex";
import { captionTextError, captionTimestamp, captionTranscriptEdits, type CaptionTranscript } from "../../../lib/captionTranscript";

const convexApi = api as any;

export type CaptionJobStatus =
  | "requested"
  | "pending"
  | "processing"
  | "completed"
  | "errored"
  | "cancelled";

export type CaptionEditorState = {
  canEdit: boolean;
  unavailableReason?: string;
  sourceTrack?: {
    id: string;
    languageCode?: string;
    name?: string;
    status: string;
  };
  latestJob?: {
    pipelineStage?: string;
    canRecoverCensoring?: boolean;
    canCheckUploadStatus?: boolean;
    status: CaptionJobStatus;
    jobId?: string;
    uploadedTrackId?: string;
    totalReplacementCount?: number;
    errorMessage?: string;
    reconciliationStatus?: "waiting" | "processing" | "completed" | "errored";
    reconciliationError?: string;
    submissionUncertain?: boolean;
    pollingTimedOut?: boolean;
  };
  captionRevision: number;
};

type CaptionCleanupProps = {
  muxAssetId: string | null | undefined;
  open: boolean;
  onClose: () => void;
  title?: string;
};

const activeStatuses = new Set<CaptionJobStatus>(["requested", "pending", "processing"]);

export function isCaptionEditActive(state: CaptionEditorState | null | undefined) {
  return Boolean(state?.latestJob && activeStatuses.has(state.latestJob.status));
}

export function useOwnCaptionEditorState(muxAssetId: string | null | undefined) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const state = useQuery(
    convexApi.captionEditing.getOwnCaptionEditorState,
    isAuthenticated && muxAssetId ? { muxAssetId } : "skip",
  ) as CaptionEditorState | null | undefined;
  return { state, isAuthenticated, isAuthLoading: isLoading };
}

function friendlyUnavailableReason(reason?: string) {
  const normalized = reason?.toLowerCase() ?? "";
  if (normalized.includes("not found") || normalized.includes("missing") || normalized.includes("deleted"))
    return "This video is no longer available.";
  if (normalized.includes("owner") || normalized.includes("permission") || normalized.includes("unauthorized"))
    return "Only the uploader can edit these captions.";
  if (normalized.includes("prepar") || normalized.includes("processing") || normalized.includes("not ready"))
    return "Captions are still being prepared. This panel will update when they are ready.";
  if (normalized.includes("no track") || normalized.includes("text track"))
    return "This video does not have a caption track to edit.";
  return reason || "Caption cleanup is unavailable for this video.";
}

function friendlySubmitError(cause: unknown) {
  const message = cause instanceof Error ? cause.message.toLowerCase() : "";
  if (message.includes("did not confirm")) return "Mux did not confirm whether caption cleanup started. This page will update automatically if it was accepted.";
  if (message.includes("sign") || message.includes("auth")) return "Your session expired. Sign in again to edit captions.";
  if (message.includes("active") || message.includes("already") || message.includes("progress")) return "Another caption edit is already active. Its status will appear here.";
  if (message.includes("track") || message.includes("stale")) return "The source caption track changed. Close and reopen this panel, then try again.";
  if (message.includes("credential") || message.includes("scope") || message.includes("robots")) return "Caption cleanup is temporarily unavailable. Please try again later.";
  return "Could not start caption cleanup. Please try again.";
}

export function captionStatusCopy(state: CaptionEditorState | null | undefined) {
  if (state === undefined) return { label: "Checking captions", detail: "Loading the latest caption status…", tone: "loading" };
  if (state === null) return { label: "Unavailable", detail: "Caption cleanup is unavailable for this video.", tone: "unavailable" };
  const job = state.latestJob;
  if (job?.canRecoverCensoring) return { label: "Censoring needs attention", detail: "Your original and manually edited captions are retained. Retry censoring, or finish using the manual track without censoring.", tone: "error" };
  if (job?.submissionUncertain) return { label: "Waiting for Mux confirmation", detail: job.errorMessage || "An operator must review this request before another edit can start.", tone: "error" };
  if (job?.pollingTimedOut) return { label: "Check Mux job status", detail: job.errorMessage || "Mux has not confirmed the final status yet.", tone: "error" };
  if (job && activeStatuses.has(job.status)) return { label: job.pipelineStage?.startsWith("censor") ? "Censoring captions" : "Applying edits", detail: "Your caption cleanup is running. You can leave this page safely.", tone: "active" };
  if (job?.status === "completed") {
    if (job.reconciliationStatus === "errored") {
      return {
        label: "Caption refresh needs attention",
        detail: job.reconciliationError || "The edited track is ready, but related video features still need to refresh.",
        tone: "error",
      };
    }
    const reconciliationActive = job.reconciliationStatus === "waiting" || job.reconciliationStatus === "processing";
    return {
      label: reconciliationActive ? "Finishing caption update" : "Reviewed",
      detail: reconciliationActive
        ? "The edited track uploaded successfully and RoboTube is refreshing caption-based features."
        : "Your updated captions are ready.",
      tone: reconciliationActive ? "active" : "complete",
    };
  }
  if (job?.status === "errored" || job?.status === "cancelled") return { label: "Could not apply edits", detail: job.errorMessage || (job.status === "cancelled" ? "The caption edit was cancelled. You can try again." : "The edit did not complete. You can try again."), tone: "error" };
  if (!state.canEdit) {
    const detail = friendlyUnavailableReason(state.unavailableReason);
    return { label: detail.toLowerCase().includes("prepar") ? "Preparing captions" : "Unavailable", detail, tone: "unavailable" };
  }
  return { label: "Ready to review", detail: "Read the transcript and edit individual captions before publishing.", tone: "ready" };
}

export function CaptionReviewCard({ muxAssetId, onOpen }: { muxAssetId: string; onOpen: () => void }) {
  const { state } = useOwnCaptionEditorState(muxAssetId);
  const status = captionStatusCopy(state);
  return (
    <section className={`caption-review-card caption-review-card--${status.tone}`} aria-labelledby="caption-review-title">
      <span className="caption-review-card__icon"><Captions aria-hidden="true" size={21} /></span>
      <div>
        <h2 id="caption-review-title">Caption cleanup</h2>
        <strong>{status.label}</strong>
        <p>{status.detail}</p>
      </div>
      <button className="button button--outline" type="button" onClick={onOpen} disabled={state === undefined}>
        {state === undefined ? <LoaderCircle className="spin" size={17} /> : <Captions size={17} />}
        Review captions
      </button>
    </section>
  );
}

export function CaptionCleanup({ muxAssetId, open, onClose, title }: CaptionCleanupProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const confirmRef = useRef<HTMLElement>(null);
  const headingId = useId();
  const descriptionId = useId();
  const { state, isAuthenticated, isAuthLoading } = useOwnCaptionEditorState(muxAssetId);
  const loadTranscript = useAction(convexApi.captionEditingNode.loadOwnCaptionDocument);
  const saveTranscript = useAction(convexApi.captionEditingNode.replaceOwnCaptionTrack);
  const retryReconciliation = useAction(
    convexApi.captionEditingNode.retryCaptionReconciliationForAsset,
  );
  const retryJobStatus = useAction(
    convexApi.captionEditingNode.retryCaptionJobStatusForAsset,
  );
  const recoverCensoring = useAction(convexApi.captionEditingNode.recoverOwnCaptionCensoring);
  const [transcript, setTranscript] = useState<CaptionTranscript | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [search, setSearch] = useState("");
  const [autoCensor, setAutoCensor] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmManual, setConfirmManual] = useState(false);

  const recover = async (useManualTrack: boolean) => {
    if (!muxAssetId || repairing) return;
    setRepairing(true);
    setMessage(null);
    try {
      const result = await recoverCensoring({ muxAssetId, useManualTrack });
      setConfirmManual(false);
      setMessage(result.restarted ? (useManualTrack ? "Finishing with your manually edited captions." : "Censoring restarted. Progress is saved.") : "Caption status changed. Review the latest status before trying again.");
    } catch {
      setMessage("Could not start caption recovery. Your original captions are retained. Please try again.");
    } finally { setRepairing(false); }
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog && !dialog.open) dialog.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open]);

  useEffect(() => {
    setAutoCensor(false);
    setSearch("");
    setErrors({});
    setSubmitting(false);
    setConfirming(false);
    setMessage(null);
    setConfirmManual(false);
  }, [muxAssetId]);

  useEffect(() => {
    if (confirming) confirmRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [confirming]);

  useEffect(() => {
    if (
      state?.latestJob?.status === "completed" &&
      state.latestJob.reconciliationStatus === "completed"
    ) {
      setSubmitting(false);
      setConfirming(false);
      setMessage("Caption edits were applied successfully.");
    } else if (state?.latestJob?.status === "errored" || state?.latestJob?.status === "cancelled") {
      setSubmitting(false);
      setMessage(state.latestJob.errorMessage || "The caption edit did not complete. You can try again.");
    }
  }, [
    state?.latestJob?.status,
    state?.latestJob?.errorMessage,
    state?.latestJob?.reconciliationStatus,
  ]);

  const active = isCaptionEditActive(state);
  const status = captionStatusCopy(state);
  const transcriptCurrent = transcript?.trackId === state?.sourceTrack?.id && transcript?.captionRevision === state?.captionRevision;
  const formDisabled = submitting || active || !state?.canEdit || loadingTranscript || !transcript || !transcriptCurrent;
  const edits = transcript ? captionTranscriptEdits(transcript, drafts) : [];
  const visibleCues = transcript?.cues.filter((cue) => `${cue.text}\n${drafts[cue.id] ?? cue.text}`.toLowerCase().includes(search.toLowerCase())) ?? [];

  useEffect(() => {
    let cancelled = false;
    if (!open || !isAuthenticated || !muxAssetId || !state?.sourceTrack?.id) return;
    setLoadingTranscript(true);
    setTranscriptError(null);
    setTranscript(null);
    setDrafts({});
    setConfirming(false);
    void loadTranscript({ muxAssetId, trackId: state.sourceTrack.id }).then((document: CaptionTranscript) => {
      if (!cancelled) setTranscript(document);
    }).catch(() => {
      if (!cancelled) setTranscriptError("Could not load the transcript. Please try again.");
    }).finally(() => {
      if (!cancelled) setLoadingTranscript(false);
    });
    return () => { cancelled = true; };
  }, [open, isAuthenticated, muxAssetId, state?.sourceTrack?.id, state?.captionRevision, reload, loadTranscript]);

  const repair = async () => {
    if (!muxAssetId || repairing) return;
    setRepairing(true);
    setMessage(null);
    try {
      const result = await retryReconciliation({ muxAssetId }) as {
        scheduled?: boolean;
      };
      setMessage(
        result.scheduled
          ? "Caption refresh restarted. This status will update automatically."
          : "The caption refresh is already running or no longer needs repair.",
      );
    } catch {
      setMessage("Could not restart the caption refresh. Please try again.");
    } finally {
      setRepairing(false);
    }
  };

  const checkJobStatus = async () => {
    if (!muxAssetId || repairing) return;
    setRepairing(true);
    setMessage(null);
    try {
      const result = await retryJobStatus({ muxAssetId }) as {
        restarted?: boolean;
      };
      setMessage(
        result.restarted
          ? "Checking the Mux caption job again."
          : "The caption job is already updating or no longer needs a status check.",
      );
    } catch {
      setMessage("Could not check the Mux caption job. Please try again.");
    } finally {
      setRepairing(false);
    }
  };

  const validate = () => {
    const nextErrors: Record<string, string> = {};
    for (const edit of edits) {
      const error = captionTextError(edit.text);
      if (error) nextErrors[edit.id] = error;
    }
    if (Object.keys(nextErrors).length) nextErrors.form = "Check the highlighted captions. Clear your search to see all captions.";
    if (!edits.length && !autoCensor) nextErrors.form = "Edit a caption or turn on auto-censor first.";
    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const requestConfirmation = (event: FormEvent) => {
    event.preventDefault();
    setMessage(null);
    if (!formDisabled && validate()) setConfirming(true);
  };

  const submit = async () => {
    if (!muxAssetId || !transcript || formDisabled) return;
    setSubmitting(true);
    setMessage(null);
    setErrors({});
    try {
      await saveTranscript({
        muxAssetId,
        trackId: transcript.trackId,
        captionRevision: transcript.captionRevision,
        edits,
        autoCensorProfanity: autoCensor,
      });
      setAutoCensor(false);
      setDrafts({});
      setConfirming(false);
      setMessage("Caption cleanup started. This status will update automatically.");
    } catch (cause) {
      setConfirming(false);
      setMessage(friendlySubmitError(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const close = () => {
    if (submitting) return;
    if (edits.length && !active && !window.confirm("Discard your unsaved caption edits?")) return;
    setConfirming(false);
    onClose();
  };

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key === "Escape" && submitting) event.preventDefault();
  };

  return (
    <dialog ref={dialogRef} className="caption-dialog" aria-labelledby={headingId} aria-describedby={descriptionId} onCancel={(event) => { event.preventDefault(); close(); }} onClose={() => { if (open) onClose(); }} onKeyDown={handleDialogKeyDown}>
      <div className="caption-dialog__shell">
        <header className="caption-dialog__header" aria-hidden={confirming} inert={confirming ? true : undefined}>
          <div><span className="eyebrow">Uploader tools</span><h2 id={headingId}>Edit captions</h2><p id={descriptionId}>{title ? `Review captions for ${title}.` : "Read the transcript and edit captions in place."}</p></div>
          <button className="caption-dialog__close" type="button" onClick={close} disabled={submitting} aria-label="Close caption cleanup"><X size={20} /></button>
        </header>

        <div className="caption-dialog__body" aria-hidden={confirming} inert={confirming ? true : undefined}>
          {isAuthLoading ? <div className="caption-state"><LoaderCircle className="spin" /> Checking your account…</div> : !isAuthenticated ? <div className="caption-state caption-state--error"><CircleAlert /> Sign in to edit captions.</div> : state === undefined ? <div className="caption-state"><LoaderCircle className="spin" /> Loading caption details…</div> : state === null ? <div className="caption-state caption-state--error"><CircleAlert /> Caption cleanup is unavailable for this video.</div> : (
            <>
              <section className={`caption-job-state caption-job-state--${status.tone}`} aria-live="polite">
                {status.tone === "active" || status.tone === "loading" ? <LoaderCircle className="spin" size={19} /> : status.tone === "complete" ? <Check size={19} /> : status.tone === "error" ? <CircleAlert size={19} /> : <Captions size={19} />}
                <div><strong>{status.label}</strong><p>{status.detail}</p>{state.latestJob?.reconciliationStatus === "errored" ? <p>Captions changed, but some caption-based features could not refresh yet.</p> : null}</div>
              </section>

              {state.latestJob?.canRecoverCensoring ? <section className="caption-section" aria-label="Recover caption censoring">
                <p>Censoring may consume AI usage. Finishing without censoring keeps your manual edits and does not censor profanity.</p>
                {confirmManual ? <div role="alert" className="caption-confirm__actions">
                  <p>Use the manual captions without censoring? This permanently replaces the original source track once the manual track is ready.</p>
                  <button className="button button--outline" type="button" disabled={repairing} onClick={() => setConfirmManual(false)}>Go back</button>
                  <button className="button button--danger" type="button" disabled={repairing} onClick={() => void recover(true)}>Confirm: finish without censoring</button>
                </div> : <div className="caption-confirm__actions">
                  <button className="button button--pink" type="button" disabled={repairing} onClick={() => void recover(false)}>{repairing ? "Starting…" : "Retry censoring"}</button>
                  <button className="button button--outline" type="button" disabled={repairing} onClick={() => setConfirmManual(true)}>Finish without censoring</button>
                </div>}
              </section> : null}

              <section className="caption-source" aria-label="Source caption track">
                <div><span>Source track</span><strong>{state.sourceTrack?.name || "Source captions"}</strong></div>
                <div><span>Language</span><strong>{state.sourceTrack?.languageCode || "Not specified"}</strong></div>
                <div><span>Readiness</span><strong>{state.sourceTrack?.status || (state.canEdit ? "ready" : "unavailable")}</strong></div>
                <div><span>Revision</span><strong>{state.captionRevision ?? 0}</strong></div>
              </section>

              {state.canEdit ? (
                <form id="caption-cleanup-form" onSubmit={requestConfirmation} noValidate>
                  <section className="caption-section" aria-label="Caption transcript">
                    <h3>Transcript</h3>
                    <p>Edit any caption below. Timings stay unchanged, and only the lines you edit are updated.</p>
                    {loadingTranscript ? <p role="status"><LoaderCircle className="spin" size={17} /> Loading transcript…</p> : transcriptError ? <div role="alert"><p>{transcriptError}</p><button className="button button--outline" type="button" onClick={() => setReload((value) => value + 1)}>Retry loading transcript</button></div> : transcript ? <>
                      <label className="caption-transcript-search"><span>Search transcript</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a caption…" /></label>
                      <p role="status">{transcript.cues.length} captions · {edits.length} edited</p>
                      <div className="caption-transcript">
                        {visibleCues.map((cue) => {
                          const text = drafts[cue.id] ?? cue.text;
                          const changed = text !== cue.text;
                          return <div className={`caption-cue${changed ? " caption-cue--edited" : ""}`} key={cue.id}>
                            <div className="caption-cue__heading"><label htmlFor={`caption-${cue.id}`}>{captionTimestamp(cue.startMs)} – {captionTimestamp(cue.endMs)}</label>{changed ? <button type="button" disabled={formDisabled} onClick={() => { setDrafts((current) => ({ ...current, [cue.id]: cue.text })); setErrors({}); }}>Undo edit</button> : null}</div>
                            <textarea id={`caption-${cue.id}`} rows={2} maxLength={10_000} disabled={formDisabled} value={text} onChange={(event) => { setDrafts((current) => ({ ...current, [cue.id]: event.target.value })); setErrors({}); }} aria-invalid={Boolean(errors[cue.id])} aria-describedby={errors[cue.id] ? `error-${cue.id}` : undefined} />
                            {changed ? <p className="caption-cue__original">Original: {cue.text}</p> : null}
                            {errors[cue.id] ? <p className="caption-field-error" id={`error-${cue.id}`}>{errors[cue.id]}</p> : null}
                          </div>;
                        })}
                        {!visibleCues.length ? <p>No captions match your search.</p> : null}
                      </div>
                    </> : null}
                  </section>

                  <fieldset className="caption-section" disabled={formDisabled}>
                    <legend>Optional AI cleanup</legend>
                    <label className="caption-switch"><span><strong>Auto-censor profanity with Mux Robots</strong><small>After saving your edits, censor profanity across the caption track. Uses the blank style; spoken audio is unchanged.</small></span><input type="checkbox" role="switch" checked={autoCensor} onChange={(event) => setAutoCensor(event.target.checked)} /><i aria-hidden="true" /></label>
                  </fieldset>
                  {errors.form ? <p className="caption-form-message caption-form-message--error" role="alert">{errors.form}</p> : null}
                </form>
              ) : <div className="caption-unavailable"><CircleAlert size={20} /><p>{friendlyUnavailableReason(state.unavailableReason)}</p></div>}
              {message ? <p className={`caption-form-message ${state.latestJob?.status === "errored" || state.latestJob?.reconciliationStatus === "errored" || state.latestJob?.submissionUncertain ? "caption-form-message--error" : ""}`} role="status">{message}</p> : null}
            </>
          )}
        </div>

        <footer className="caption-dialog__footer" aria-hidden={confirming} inert={confirming ? true : undefined}>
          <button className="button button--outline" type="button" onClick={close} disabled={submitting || repairing}>{active ? "Close" : "Cancel"}</button>
          {state?.latestJob?.status === "completed" && state.latestJob.reconciliationStatus === "errored" ? (
            <button className="button button--pink" type="button" onClick={() => void repair()} disabled={repairing}>
              {repairing ? <><LoaderCircle className="spin" size={17} /> Restarting…</> : "Retry caption refresh"}
            </button>
          ) : null}
          {state?.latestJob?.pollingTimedOut || state?.latestJob?.canCheckUploadStatus ? (
            <button className="button button--pink" type="button" onClick={() => void checkJobStatus()} disabled={repairing}>
              {repairing ? <><LoaderCircle className="spin" size={17} /> Checking…</> : "Check Mux status"}
            </button>
          ) : null}
          {state?.canEdit && !active ? <button className="button button--pink" type="submit" form="caption-cleanup-form" disabled={formDisabled || (!edits.length && !autoCensor)}>{submitting ? <><LoaderCircle className="spin" size={17} /> Starting…</> : "Apply caption edits"}</button> : null}
        </footer>

        {confirming ? <section ref={confirmRef} className="caption-confirm" role="alertdialog" aria-modal="true" aria-labelledby="caption-confirm-title" aria-describedby="caption-confirm-copy" onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!submitting) setConfirming(false); return; }
          if (event.key !== "Tab") return;
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
          const first = buttons[0];
          const last = buttons[buttons.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}>
          <div><span><AlertTriangle size={22} /></span><h3 id="caption-confirm-title">Replace the original caption track?</h3><p id="caption-confirm-copy">After the edited track uploads successfully, the original source track will be permanently deleted. RoboTube does not keep caption revision history, and this cannot be undone.</p><p>{edits.length} caption{edits.length === 1 ? "" : "s"} edited. Timing stays unchanged.{autoCensor ? " Mux Robots will then censor profanity across the track and may consume AI usage." : " No Robots cleanup requested."}</p><div className="caption-confirm__actions"><button className="button button--outline" type="button" disabled={submitting} onClick={() => setConfirming(false)} autoFocus>Go back</button><button className="button button--danger" type="button" disabled={formDisabled} onClick={() => void submit()}>{submitting ? "Saving…" : "Replace and apply edits"}</button></div></div>
        </section> : null}
      </div>
    </dialog>
  );
}
