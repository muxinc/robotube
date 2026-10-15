import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

const app = readFileSync(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const editor = readFileSync(new URL("../web/src/components/CaptionCleanup.tsx", import.meta.url), "utf8");
const submitSource = app.slice(app.indexOf("  const submit = async (event: FormEvent) =>", app.indexOf("function UploadPage")), app.indexOf("  const startAnotherUpload", app.indexOf("function UploadPage")));

// Execute the production submit handler with inert uploads; no authentication or network.
async function submit(includeSpeakers: boolean, fail = false) {
  const payloads: unknown[] = [];
  const state: Record<string, unknown> = {};
  const bindings: Record<string, unknown> = {
    includeSpeakers, title: " Test ", file: {}, uploading: false, uploadId: null,
    audioLanguages: ["es"], captionLanguages: ["fr"],
    createUpload: async (args: unknown) => { payloads.push(args); return { uploadId: "test", uploadUrl: "inert" }; },
    uploadFileWithProgress: async () => { if (fail) throw new Error("offline"); },
  };
  for (const key of ["SubmittedIncludeSpeakers", "Uploading", "Error", "UploadId", "Progress", "StatusText", "UploadIssued"]) {
    bindings[`set${key}`] = (value: unknown) => { state[key] = value; };
  }
  const js = stripTypeScriptTypes(submitSource);
  const handler = new Function(...Object.keys(bindings), js + "\nreturn submit;")(...Object.values(bindings));
  await handler({ preventDefault() {} });
  return { payloads, state };
}

test("upload defaults off and sends explicit off/on independently of languages", async () => {
  assert.match(app, /sessionStorage\.getItem\("robotube-upload-include-speakers"\) === "true"/);
  assert.match(app, /catch \{ return false; \}/);
  assert.match(app, /sessionStorage\.setItem\("robotube-upload-include-speakers", String\(includeSpeakers\)\)/);
  for (const enabled of [false, true]) {
    const result = await submit(enabled);
    assert.deepEqual(result.payloads, [{ title: "Test", includeSpeakers: enabled, audioTranslationLanguageCodes: ["es"], captionTranslationLanguageCodes: ["fr"] }]);
    assert.equal(result.state.SubmittedIncludeSpeakers, enabled);
  }
});

test("failed transfer retains choice and issued lock for retry; full reset clears both", async () => {
  const result = await submit(true, true);
  assert.equal(result.state.SubmittedIncludeSpeakers, true);
  assert.equal(result.state.UploadIssued, true);
  assert.equal(result.state.Uploading, false);
  assert.match(app, /disabled=\{uploading \|\| uploadIssued \|\| Boolean\(uploadId\)\}/);
  assert.doesNotMatch(submitSource, /setIncludeSpeakers\(/);
  const reset = app.slice(app.indexOf("  const startAnotherUpload"), app.indexOf("  const chooseThumbnail"));
  assert.match(reset, /setIncludeSpeakers\(false\)/);
  assert.match(reset, /setSubmittedIncludeSpeakers\(null\)/);
  assert.match(reset, /setUploadIssued\(false\)/);
  assert.equal((app.match(/setIncludeSpeakers\(false\)/g) ?? []).length, 1);
});

test("speaker naming is ahead of transcript, after optional cleanup, and transcript-authoritative", () => {
  assert.ok(editor.indexOf("Optional AI cleanup</legend>") < editor.indexOf("Speaker names</legend>"));
  assert.ok(editor.indexOf("Speaker names</legend>") < editor.indexOf('aria-label="Caption transcript"'));
  assert.match(editor, /current caption track has no speaker labels/);
  assert.match(editor, /For future uploads, enable Include speaker labels/);
  assert.match(editor, /captionSpeakerLabels\(transcript\?\.cues/);
  assert.match(app, /not confirmation that labels exist/);
  assert.match(editor, /speakerReplacements: speakers/);
});
