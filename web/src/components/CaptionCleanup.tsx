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
import { captionTimestamp, type CaptionTranscript } from "../../../lib/shared/captionTranscript";
import { captionRulesError, captionSpeakerLabels, previewCaptionRules, type CaptionReplacement, type CaptionSpeakerReplacement } from "../../../lib/shared/captionRobots";

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
    operation?: "manual" | "robots";
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
  return { label: "Ready to review", detail: "Choose transcript wording to correct across the entire caption track.", tone: "ready" };
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
  const editCaptions = useAction(convexApi.captionEditingNode.editCaptionsForAsset);
  const retryReconciliation = useAction(
    convexApi.captionEditingNode.retryCaptionReconciliationForAsset,
  );
  const retryJobStatus = useAction(
    convexApi.captionEditingNode.retryCaptionJobStatusForAsset,
  );
  const recoverCensoring = useAction(convexApi.captionEditingNode.recoverOwnCaptionCensoring);
  const [transcript, setTranscript] = useState<CaptionTranscript | null>(null);
  const [replacements, setReplacements] = useState<CaptionReplacement[]>([]);
  const [speakers, setSpeakers] = useState<CaptionSpeakerReplacement[]>([]);
  const [find, setFind] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [speaker, setSpeaker] = useState("");
  const [speakerName, setSpeakerName] = useState("");
  const [censorMode, setCensorMode] = useState<"blank" | "remove" | "mask">("blank");
  const wordingRef = useRef<HTMLInputElement>(null);
  const submitLock = useRef(false);
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
      setMessage("Could not start caption recovery. Review the latest track status before trying again.");
    } finally { setRepairing(false); }
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog && !dialog.open) dialog.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open]);

  useEffect(() => {
    setAutoCensor(false);
    setReplacements([]);
    setSpeakers([]);
    setFind("");
    setReplacement("");
    setSpeaker("");
    setSpeakerName("");
    setSearch("");
    setErrors({});
    setSubmitting(false);
    setConfirming(false);
    setMessage(null);
    setConfirmManual(false);
  }, [muxAssetId]);

  useEffect(() => {
    if (confirming) confirmRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { if (confirming) wordingRef.current?.focus(); };
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
  const formDisabled = submitting || active || Boolean(state?.latestJob?.submissionUncertain) || !state?.canEdit || loadingTranscript || !transcript || !transcriptCurrent;
  const preview = previewCaptionRules(transcript?.cues ?? [], replacements, speakers);
  const labels = captionSpeakerLabels(transcript?.cues ?? []);
  const visibleCues = preview.cues.filter((cue) => `${cue.originalText}\n${cue.text}`.toLowerCase().includes(search.toLowerCase()));
  const dirty = Boolean(replacements.length || speakers.length || autoCensor || find || replacement || speakerName);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const rulesError = captionRulesError(replacements, speakers, autoCensor);
  const noEffect = !autoCensor && preview.changedCueCount === 0;
  const chooseWording = (text: string) => {
    setFind(text);
    setReplacement("");
    setConfirming(false);
    wordingRef.current?.focus();
  };
  const queueCorrection = () => {
    const rule = { find, replace: replacement, caseSensitive };
    const error = captionRulesError([...replacements, rule], speakers, autoCensor);
    if (error) { setErrors({ form: error }); return; }
    setReplacements((current) => [...current, rule]);
    setFind("");
    setReplacement("");
    setErrors({});
  };
  const queueSpeaker = () => {
    const rule = { find: speaker, replace: speakerName };
    const error = captionRulesError(replacements, [...speakers, rule], autoCensor);
    if (error || !labels.includes(speaker)) { setErrors({ form: error || "Choose a speaker from the transcript." }); return; }
    setSpeakers((current) => [...current, rule]);
    setSpeakerName("");
    setErrors({});
  };

  useEffect(() => {
    let cancelled = false;
    if (!open || !isAuthenticated || !muxAssetId || !state?.sourceTrack?.id) return;
    setLoadingTranscript(true);
    setTranscriptError(null);
    setTranscript(null);
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
    const error = rulesError || (speakers.some((rule) => !labels.includes(rule.find)) ? "A queued speaker is no longer in this transcript. Remove that rename before submitting." : undefined) || (noEffect ? "These rules have no estimated effect. Adjust them before submitting." : undefined) || (find || replacement || speakerName ? "Queue or clear your unfinished correction first." : undefined);
    setErrors(error ? { form: error } : {});
    return !error;
  };

  const requestConfirmation = (event: FormEvent) => {
    event.preventDefault();
    setMessage(null);
    if (!formDisabled && validate()) setConfirming(true);
  };

  const submit = async () => {
    if (!muxAssetId || !transcript || formDisabled || submitLock.current || !validate()) return;
    submitLock.current = true;
    setSubmitting(true);
    setMessage(null);
    setErrors({});
    try {
      const result = await editCaptions({
        muxAssetId,
        trackId: transcript.trackId,
        captionRevision: transcript.captionRevision,
        replacements,
        speakerReplacements: speakers,
        ...(autoCensor ? { autoCensorProfanity: { mode: censorMode } } : {}),
      });
      if (result.alreadyActive) {
        setMessage(`An existing edit-captions job is active (${result.jobId}, ${result.status}). Your draft was not submitted.`);
      } else {
        setAutoCensor(false);
        setReplacements([]);
        setSpeakers([]);
        setFind("");
        setReplacement("");
        setSpeakerName("");
        setMessage(`edit-captions job ${result.jobId}: ${result.status}. This status will update automatically.`);
      }
      setConfirming(false);
    } catch (cause) {
      setConfirming(false);
      setMessage(friendlySubmitError(cause));
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  };

  const close = () => {
    if (submitting) return;
    if (dirty && !window.confirm("Close with unsaved caption corrections? Your draft will not be submitted.")) return;
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
          <div><span className="eyebrow">Uploader tools</span><h2 id={headingId}>Edit captions</h2><p id={descriptionId}>{title ? `Review captions for ${title}.` : "Choose transcript wording, then review track-wide Robots corrections."}</p></div>
          <button className="caption-dialog__close" type="button" onClick={close} disabled={submitting} aria-label="Close caption cleanup"><X size={20} /></button>
        </header>

        <div className="caption-dialog__body" aria-hidden={confirming} inert={confirming ? true : undefined}>
          {isAuthLoading ? <div className="caption-state"><LoaderCircle className="spin" /> Checking your account…</div> : !isAuthenticated ? <div className="caption-state caption-state--error"><CircleAlert /> Sign in to edit captions.</div> : state === undefined ? <div className="caption-state"><LoaderCircle className="spin" /> Loading caption details…</div> : state === null ? <div className="caption-state caption-state--error"><CircleAlert /> Caption cleanup is unavailable for this video.</div> : (
            <>
              <section className={`caption-job-state caption-job-state--${status.tone}`} aria-live="polite">
                {status.tone === "active" || status.tone === "loading" ? <LoaderCircle className="spin" size={19} /> : status.tone === "complete" ? <Check size={19} /> : status.tone === "error" ? <CircleAlert size={19} /> : <Captions size={19} />}
                <div><strong>{status.label}</strong><p>{status.detail}</p>{state.latestJob ? <p>Workflow: {state.latestJob.operation === "manual" && !state.latestJob.jobId ? "Legacy caption-track update" : `edit-captions · Mux job: ${state.latestJob.jobId || "Awaiting ID"}`} · Status: {state.latestJob.status}{state.latestJob.totalReplacementCount !== undefined ? ` · Actual replacements: ${state.latestJob.totalReplacementCount}` : ""}</p> : null}{state.latestJob?.reconciliationStatus === "errored" ? <p>Captions changed, but some caption-based features could not refresh yet.</p> : null}</div>
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
                  <fieldset className="caption-section" disabled={formDisabled}>
                    <legend>Optional AI cleanup</legend>
                    <label className="caption-switch"><span><strong>Auto-censor profanity with Mux Robots</strong><small>Censor profanity across the track in the same Robots job. Spoken audio is unchanged. AI results cannot be previewed.</small></span><input type="checkbox" role="switch" checked={autoCensor} onChange={(event) => setAutoCensor(event.target.checked)} /><i aria-hidden="true" /></label>
                    {autoCensor ? <label>Profanity mode<select value={censorMode} onChange={(event) => { const mode = event.target.value; if (mode === "blank" || mode === "remove" || mode === "mask") setCensorMode(mode); }}><option value="blank">Blank — bracketed underscores</option><option value="remove">Remove — delete profanity</option><option value="mask">Mask — question marks</option></select></label> : null}
                  </fieldset>

                  <fieldset className="caption-section caption-rules" disabled={formDisabled}>
                    <legend>Speaker names</legend>
                    <p>Assign names to the speaker labels discovered in this transcript. Only labels at the start of cues are renamed; spoken mentions are unchanged. Enter names without brackets.</p>
                    {loadingTranscript ? <p>Loading speaker labels…</p> : transcriptCurrent && !labels.length ? <p>The current caption track has no speaker labels. For future uploads, enable Include speaker labels. Labels do not automatically identify real people.</p> : null}
                    <label>Transcript speaker<select value={speaker} onChange={(event) => setSpeaker(event.target.value)}><option value="">Choose speaker</option>{labels.map((label) => <option key={label} value={label}>{label}</option>)}</select></label>
                    <label>New speaker name<input value={speakerName} onChange={(event) => setSpeakerName(event.target.value)} maxLength={200} /></label>
                    <button className="button button--outline" type="button" onClick={queueSpeaker} disabled={!labels.length}>Queue speaker rename</button>
                    <button className="button button--outline" type="button" onClick={() => setSpeakerName("")}>Clear name</button>
                    <ul>{speakers.map((rule, index) => <li key={rule.find}>{rule.find} → {rule.replace} <button type="button" aria-label={`Remove rename for ${rule.find}`} onClick={() => setSpeakers((current) => current.filter((_, i) => i !== index))}>Remove</button></li>)}</ul>
                  </fieldset>

                  <section className="caption-section" aria-label="Caption transcript">
                    <h3>Transcript</h3>
                    <p>Select a word or phrase in the transcript to correct it, or use a caption’s Correct wording button and narrow the phrase. Every text correction applies everywhere in the track, not just at one timestamp.</p>
                    {transcript && !transcriptCurrent && !loadingTranscript ? <p role="alert">This transcript is stale. Reload before submitting. Your queued rules are retained. <button type="button" onClick={() => setReload((value) => value + 1)}>Reload transcript</button></p> : null}
                    {loadingTranscript ? <p role="status"><LoaderCircle className="spin" size={17} /> Loading transcript…</p> : transcriptError ? <div role="alert"><p>{transcriptError}</p><button className="button button--outline" type="button" onClick={() => setReload((value) => value + 1)}>Retry loading transcript</button></div> : transcript ? <>
                      <label className="caption-transcript-search"><span>Search transcript</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a caption…" /></label>
                      <p role="status">{transcript.cues.length} captions · Estimated: {preview.changedCueCount} affected cues, {preview.totalReplacementCount} replacements</p>
                      <p>Local preview is an estimate, not Mux’s authoritative result. AI profanity results are unknown until the job completes.</p>
                      <div className="caption-transcript">
                        {visibleCues.map((cue) => {
                          const changed = cue.text !== cue.originalText;
                          return <div className={`caption-cue${changed ? " caption-cue--edited" : ""}`} key={cue.id}>
                            <div className="caption-cue__heading"><span>{captionTimestamp(cue.startMs)} – {captionTimestamp(cue.endMs)}</span><button type="button" disabled={formDisabled} aria-label={`Correct wording at ${captionTimestamp(cue.startMs)}`} onClick={() => chooseWording(cue.originalText)}>Correct wording</button></div>
                            <p className="caption-cue__text" onMouseUp={(event) => {
                              if (formDisabled) return;
                              const selection = window.getSelection();
                              if (selection && event.currentTarget.contains(selection.anchorNode) && event.currentTarget.contains(selection.focusNode) && selection.toString().trim()) chooseWording(selection.toString().trim());
                            }}>{cue.originalText}</p>
                            {changed ? <p className="caption-cue__preview"><strong>Estimated preview:</strong> {cue.text || "(empty cue)"}</p> : null}
                          </div>;
                        })}
                        {!visibleCues.length ? <p>No captions match your search.</p> : null}
                      </div>
                    </> : null}
                  </section>

                  <fieldset className="caption-section caption-rules" disabled={formDisabled}>
                    <legend>Correct selected transcript wording</legend>
                    <p>All occurrences in every cue will be replaced. Leave replacement empty to delete the selected text.</p>
                    <label>Selected word or phrase<input ref={wordingRef} value={find} onChange={(event) => setFind(event.target.value)} maxLength={500} /></label>
                    <label>Replace everywhere with<input value={replacement} onChange={(event) => setReplacement(event.target.value)} maxLength={500} /></label>
                    <label><input type="checkbox" checked={caseSensitive} onChange={(event) => setCaseSensitive(event.target.checked)} /> Match case</label>
                    <button className="button button--outline" type="button" onClick={queueCorrection} disabled={!find}>Queue correction</button>
                    <button className="button button--outline" type="button" onClick={() => { setFind(""); setReplacement(""); }}>Clear wording</button>
                    <ul>{replacements.map((rule, index) => <li key={index}>“{rule.find}” → {rule.replace ? `“${rule.replace}”` : "(delete)"} · {rule.caseSensitive ? "case-sensitive" : "any case"} <button type="button" aria-label={`Remove correction ${index + 1}`} onClick={() => setReplacements((current) => current.filter((_, i) => i !== index))}>Remove</button></li>)}</ul>
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
          {state?.canEdit && !active ? <button className="button button--pink" type="submit" form="caption-cleanup-form" disabled={formDisabled || Boolean(rulesError) || noEffect}>{submitting ? <><LoaderCircle className="spin" size={17} /> Starting…</> : "Apply caption edits"}</button> : null}
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
          <div><span><AlertTriangle size={22} /></span><h3 id="caption-confirm-title">Replace the original caption track?</h3><p id="caption-confirm-copy">One Mux Robots edit-captions job will replace the source track and may consume usage. Mux deletes the source before adding the edited track. If adding fails, restoration is best effort and can also fail. RoboTube keeps no caption revision history.</p><p>Estimated: {preview.changedCueCount} affected cues and {preview.totalReplacementCount} replacements. Every text correction applies across the entire track.{autoCensor ? " AI censoring is also requested; its effects are unknown until completion." : " No AI profanity censoring requested."}</p><div className="caption-confirm__actions"><button className="button button--outline" type="button" disabled={submitting} onClick={() => setConfirming(false)} autoFocus>Go back</button><button className="button button--danger" type="button" disabled={formDisabled} onClick={() => void submit()}>{submitting ? "Saving…" : "Replace and apply edits"}</button></div></div>
        </section> : null}
      </div>
    </dialog>
  );
}
