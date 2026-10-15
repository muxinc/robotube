import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { URL } from "node:url";
import { captionRulesError, captionSpeakerLabels, previewCaptionRules } from "../lib/captionRobots.ts";

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
