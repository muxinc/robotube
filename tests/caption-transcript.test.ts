import assert from "node:assert/strict";
import { test } from "node:test";
import { captionTextError, captionTimestamp, captionTranscriptEdits } from "../lib/captionTranscript.ts";
import { parseCaptionVtt, replaceCaptionCueText } from "../convex/captionVtt.ts";

const source = `WEBVTT

STYLE
::cue { color: white; }

NOTE Keep this --> comment

first
00:01.200 --> 00:03.000 align:start position:10%
Hello world

second
00:00:04.000 --> 00:00:06.000
Hello world

third
00:00:07.000 --> 00:00:09.000
Two lines
of dialogue
`;

test("transcript edits target a cue ID, not every occurrence of the same dialogue", () => {
  const document = parseCaptionVtt(source);
  assert.equal(document.cues.length, 3);
  assert.equal(document.cues[0].startMs, 1200);
  const transcript = { trackId: "track", captionRevision: 1, cues: document.cues };
  const edits = captionTranscriptEdits(transcript, { [document.cues[0].id]: "Hello Mux" });
  assert.deepEqual(edits, [{ id: document.cues[0].id, text: "Hello Mux" }]);
  const updated = replaceCaptionCueText(source, document, Object.fromEntries(edits.map((edit) => [edit.id, edit.text])));
  assert.equal(updated, source.replace("Hello world", "Hello Mux"));
  assert.deepEqual(parseCaptionVtt(updated).cues.map((cue) => cue.text), ["Hello Mux", "Hello world", "Two lines\nof dialogue"]);
});

test("unchanged, undone, and unrelated drafts are not submitted", () => {
  const document = parseCaptionVtt(source);
  const transcript = { trackId: "track", captionRevision: 0, cues: document.cues };
  assert.deepEqual(captionTranscriptEdits(transcript, {}), []);
  assert.deepEqual(captionTranscriptEdits(transcript, { [document.cues[0].id]: "Hello world", obsolete: "changed" }), []);
});

test("validate edited caption text without trimming or flattening multiline dialogue", () => {
  assert.equal(captionTextError(" Hello\nworld "), undefined);
  for (const text of ["", "   ", "line\n\nline", "line\n \nline", "-->", "\u0000", "\r", "a".repeat(10_001)]) {
    assert.ok(captionTextError(text), JSON.stringify(text));
  }
});

test("display exact timestamps including hours and milliseconds", () => {
  assert.equal(captionTimestamp(0), "00:00:00.000");
  assert.equal(captionTimestamp(3_661_205), "01:01:01.205");
});

test("WebVTT parsing retains CRLF content and rejects malformed timestamps", () => {
  const document = parseCaptionVtt("\uFEFF" + source.replaceAll("\n", "\r\n"));
  assert.equal(document.cues.length, 3);
  assert.equal(replaceCaptionCueText(document.source, document, {}), source);
  assert.throws(() => parseCaptionVtt(source.replace("00:03.000", "00:63.000")), /malformed/);
  assert.throws(() => parseCaptionVtt(source.replace("00:03.000", "not-a-time")), /malformed/);
  assert.throws(() => parseCaptionVtt(source.replace("00:03.000", "00:00.000")), /duration/);
});
