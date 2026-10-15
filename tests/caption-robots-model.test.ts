import assert from "node:assert/strict";
import { test } from "node:test";
import { captionRulesError, captionSpeakerLabels, previewCaptionRules } from "../lib/captionRobots.ts";

const cues = [
  { id: "a", startMs: 0, endMs: 1000, text: "[speaker_0] Mucks and Mucks." },
  { id: "b", startMs: 1000, endMs: 2000, text: "[speaker_1] MUCKS, speaker_0 is here." },
];

test("text corrections preview every matching cue while preserving IDs and timing", () => {
  const result = previewCaptionRules(cues, [{ find: "Mucks", replace: "Mux" }], []);
  assert.equal(result.changedCueCount, 2);
  assert.equal(result.totalReplacementCount, 3);
  assert.equal(result.cues[0].text, "[speaker_0] Mux and Mux.");
  assert.equal(result.cues[1].startMs, 1000);
  assert.equal(result.cues[0].originalText, cues[0].text);
  assert.equal(previewCaptionRules(cues, [{ find: "Mucks", replace: "Mux", caseSensitive: true }], []).totalReplacementCount, 2);
});

test("speaker renames affect leading labels, not names in dialogue", () => {
  assert.deepEqual(captionSpeakerLabels(cues), ["speaker_0", "speaker_1"]);
  const result = previewCaptionRules(cues, [], [{ find: "speaker_0", replace: "Alice" }]);
  assert.equal(result.cues[0].text, "[Alice] Mucks and Mucks.");
  assert.equal(result.cues[1].text, cues[1].text);
  assert.equal(result.changedCueCount, 1);
});

test("regex characters and replacement dollars are literal; deletions are supported", () => {
  const source = [{ id: "c", startMs: 0, endMs: 1000, text: "A+B? A+B?" }];
  assert.equal(previewCaptionRules(source, [{ find: "A+B?", replace: "$&" }], []).cues[0].text, "$& $&");
  assert.equal(previewCaptionRules(source, [{ find: "A+B?", replace: "" }], []).cues[0].text, " ");
  assert.equal(previewCaptionRules(source, [{ find: "", replace: "bad" }], []).changedCueCount, 0);
});

test("rules reject empty jobs, malformed labels, duplicate speakers and invalid corrections", () => {
  assert.ok(captionRulesError([], [], false));
  assert.equal(captionRulesError([], [], true), undefined);
  assert.ok(captionRulesError([{ find: "", replace: "x" }], [], false));
  assert.ok(captionRulesError([{ find: "x", replace: "x" }], [], false));
  assert.ok(captionRulesError([{ find: "x", replace: "bad\n\ntext" }], [], false));
  assert.ok(captionRulesError([], [{ find: "speaker_0", replace: "[Alice]" }], false));
  assert.ok(captionRulesError([], [{ find: "speaker_0", replace: "Alice" }, { find: "speaker_0", replace: "Bob" }], false));
  assert.equal(captionRulesError([{ find: "x", replace: "" }], [], false), undefined);
});
