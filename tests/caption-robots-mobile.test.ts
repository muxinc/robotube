import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { URL } from "node:url";
import { captionRulesError, captionSpeakerLabels, previewCaptionRules } from "../lib/captionRobots.ts";
import * as helpers from "../lib/captionRobotsMobile.ts";

const screen = readFileSync(new URL("../app/video/[muxAssetId]/edit-captions.tsx", import.meta.url), "utf8");

test("mobile submits one revision-bound Robots request, never a manual upload", () => {
  assert.match(screen, /captionEditingNode\.editCaptionsForAsset/);
  assert.doesNotMatch(screen, /replaceOwnCaptionTrack|deleteOriginalTrack|captionTranscriptEdits/);
  for (const field of ["trackId: transcript.trackId", "captionRevision: transcript.captionRevision", "speakerReplacements: speakers", "autoCensorProfanity: { mode: censorMode }"]) assert.ok(screen.includes(field));
  assert.match(screen, /if \(result.alreadyActive\)[\s\S]*?return;[\s\S]*?setReplacements\(\[\]\)/);
  assert.match(screen, /\.catch\(\(error: unknown\) =>/);
  assert.match(screen, /usePreventRemove\(hasRules \|\| composer !== null/);
  assert.match(screen, /composer.cueText.includes\(composer.find\)/);
  assert.match(screen, /disabled=\{formDisabled\}/);
  assert.match(screen, /restoration is best effort|Restoration on failure is best effort/);
  assert.match(screen, /<Text selectable>Original:/);
  assert.match(screen, /<Text selectable>Estimated preview:/);
});

test("mobile preview helpers count global deletions and leading speaker renames", () => {
  const cues = [
    { id: "1", startMs: 0, endMs: 1000, text: "[A] word WORD" },
    { id: "2", startMs: 1000, endMs: 2000, text: "word A" },
  ];
  assert.deepEqual(captionSpeakerLabels(cues), ["A"]);
  const rules = [{ find: "word", replace: "" }];
  const speakers = [{ find: "A", replace: "Alice" }];
  assert.equal(captionRulesError(rules, speakers, false), undefined);
  const preview = previewCaptionRules(cues, rules, speakers);
  assert.equal(preview.changedCueCount, 2);
  assert.equal(preview.totalReplacementCount, 4);
  assert.equal(preview.cues[1].text, " A");
  assert.equal(preview.cues[0].originalText, cues[0].text);
  assert.equal(preview.cues[1].startMs, 1000);
  assert.ok(captionRulesError([], [{ find: "A", replace: "[Alice]" }], false));
});


test("confirmation callbacks are one-shot even after completion; cancel/dismiss permits retry", () => {
  const gate = helpers.createCaptionSubmissionGate();
  const first = gate.open()!;
  assert.equal(gate.open(), undefined);
  let calls = 0;
  const apply = () => { if (first.accept()) calls++; };
  apply(); apply();
  assert.equal(calls, 1);
  assert.equal(gate.open(), undefined);
  first.cancel(); // Native onDismiss may follow acceptance.
  assert.equal(gate.open(), undefined);
  gate.finish();
  apply();
  assert.equal(calls, 1);
  const cancelled = gate.open()!;
  cancelled.cancel();
  const retry = gate.open()!;
  assert.equal(cancelled.accept(), false);
  assert.equal(retry.accept(), true);
  gate.finish();
  assert.ok(gate.open());
});

test("zero net effect is rejected without censoring; stale speakers are always rejected", () => {
  const cues = [{ id: "a", startMs: 0, endMs: 1, text: "ab" }];
  const result = previewCaptionRules(cues, [{ find: "ab", replace: "b" }, { find: "b", replace: "ab" }], []);
  assert.equal(result.changedCueCount, 0);
  const review = { speakerLabels: [], speakers: [], changedCueCount: result.changedCueCount, autoCensor: false };
  assert.match(helpers.mobileCaptionReviewError(review)!, /no estimated effect/);
  assert.equal(helpers.mobileCaptionReviewError({ ...review, autoCensor: true }), undefined);
  for (const autoCensor of [false, true]) {
    assert.match(helpers.mobileCaptionReviewError({ ...review, speakers: [{ find: "old" }], changedCueCount: 1, autoCensor })!, /no longer/);
  }
});

test("job display survives edit lockout and retains Mux identity/count", () => {
  const text = helpers.mobileCaptionJobText({ status: "processing", jobId: "robot-1", totalReplacementCount: 3 });
  assert.match(text, /processing.*robot-1.*3 replacements/);
  assert.doesNotMatch(helpers.mobileCaptionJobText({ status: "completed", operation: "manual" }), /Mux Robots/);
  assert.match(helpers.mobileCaptionJobText({ status: "completed", operation: "manual", jobId: "censor-1" }), /Mux Robots/);
  assert.ok(screen.indexOf("mobileCaptionJobText(state.latestJob)") < screen.indexOf("!state.canEdit"));
  assert.match(screen, /message=\{editActive \? "Caption edits are being applied/);
});

test("composer is revealed ahead of long transcripts with input and accessibility focus", () => {
  assert.ok(screen.indexOf("{composer ? <View") < screen.indexOf("{visibleCues.map"));
  assert.match(screen, /scrollTo\(\{ y: event.nativeEvent.layout.y/);
  assert.match(screen, /composerInput.current\?\.focus\(\)/);
  assert.match(screen, /AccessibilityInfo.setAccessibilityFocus\(target\)/);
  assert.match(screen, /inputRef=\{composerInput\} maxLength=\{500\}/);
  assert.match(screen, /maxLength=\{200\} label=\{`New name/);
});

test("asset reset is separate from same-asset transcript refresh and invalidates dialogs", () => {
  const reset = screen.slice(screen.indexOf("    cancelConfirmation.current?.();"), screen.indexOf("  }, [muxAssetId]);"));
  for (const call of ['setReplacements([])', 'setSpeakers([])', 'setComposer(null)', 'setAutoCensor(false)', 'setCensorMode("blank")', 'setSpeakerName("")']) assert.ok(reset.includes(call));
  assert.match(screen, /draftAsset !== muxAssetId/);
  assert.match(screen, /currentAsset.current !== muxAssetId/);
  const loadEffect = screen.slice(screen.indexOf("    let cancelled = false;"), screen.indexOf("  }, [muxAssetId, state?.sourceTrack"));
  assert.doesNotMatch(loadEffect, /setReplacements|setSpeakers|setAutoCensor|setComposer/);
});
