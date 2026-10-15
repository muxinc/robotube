export function mobileCaptionReviewError({ speakerLabels, speakers, changedCueCount, autoCensor }: {
  speakerLabels: string[];
  speakers: { find: string }[];
  changedCueCount: number;
  autoCensor: boolean;
}): string | undefined {
  if (speakers.some((rule) => !speakerLabels.includes(rule.find))) {
    return "A queued speaker is no longer in this transcript. Remove or review that rename.";
  }
  if (!autoCensor && changedCueCount === 0) {
    return "These rules have no estimated effect. Review your corrections before submitting.";
  }
}

/** Each confirmation owns a one-shot callback; old dialogs cannot submit after cancellation. */
export function createCaptionSubmissionGate() {
  let confirmation: symbol | undefined;
  let submitting = false;
  return {
    open() {
      if (confirmation || submitting) return;
      const token = Symbol();
      confirmation = token;
      return {
        cancel() { if (confirmation === token) confirmation = undefined; },
        accept() {
          if (confirmation !== token || submitting) return false;
          confirmation = undefined;
          submitting = true;
          return true;
        },
      };
    },
    finish() { submitting = false; },
  };
}

export function mobileCaptionJobText(job: { status: string; jobId?: string; totalReplacementCount?: number }) {
  return `Mux Robots · edit-captions · ${job.status}${job.jobId ? ` · Mux job ${job.jobId}` : ""}${typeof job.totalReplacementCount === "number" ? ` · ${job.totalReplacementCount} replacements` : ""}`;
}
