import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { test } from "node:test";
import { captionSpeakerLabels, previewCaptionRules } from "../lib/captionRobots.ts";

const source = readFileSync(new URL("../web/src/components/CaptionCleanup.tsx", import.meta.url), "utf8");

test("web submits one revision-bound Robots request, never a manual track", () => {
  assert.match(source, /useAction\(convexApi\.captionEditingNode\.editCaptionsForAsset\)/);
  assert.doesNotMatch(source, /replaceOwnCaptionTrack|deleteOriginalTrack|<textarea/);
  assert.match(source, /trackId: transcript\.trackId/);
  assert.match(source, /captionRevision: transcript\.captionRevision/);
  assert.match(source, /speakerReplacements: speakers/);
  assert.match(source, /autoCensorProfanity: \{ mode: censorMode \}/);
  assert.match(source, /if \(result\.alreadyActive\)/);
  assert.match(source, /submitLock\.current = true/);
});

test("transcript correction wiring uses shared estimates and accessible wording action", () => {
  assert.match(source, /previewCaptionRules\(transcript\?\.cues/);
  assert.match(source, /captionSpeakerLabels\(transcript\?\.cues/);
  assert.match(source, /captionRulesError\(replacements, speakers, autoCensor\)/);
  assert.match(source, /Correct wording at/);
  assert.match(source, /selection\.toString\(\)/);
  assert.match(source, /best effort and can also fail/);
  assert.match(source, /AI profanity results are unknown/);
});

test("web helper semantics cover global deletion and leading labels only", () => {
  const cues = [
    { id: "a", startMs: 0, endMs: 1000, text: "[Host] Um hello Host" },
    { id: "b", startMs: 1000, endMs: 2000, text: "um [Guest] hello" },
  ];
  assert.deepEqual(captionSpeakerLabels(cues), ["Host"]);
  const preview = previewCaptionRules(cues, [{ find: "um", replace: "" }], [{ find: "Host", replace: "Alice" }]);
  assert.equal(preview.changedCueCount, 2);
  assert.equal(preview.totalReplacementCount, 3);
  assert.equal(preview.cues[0].text, "[Alice]  hello Host");
  assert.equal(preview.cues[1].text, " [Guest] hello");
  assert.equal(preview.cues[0].originalText, cues[0].text);
  assert.equal(preview.cues[1].startMs, 1000);
});
