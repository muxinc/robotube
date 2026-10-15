import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';

const upload = readFileSync(new URL('../app/(tabs)/upload.tsx', import.meta.url), 'utf8');
const editor = readFileSync(new URL('../app/video/[muxAssetId]/edit-captions.tsx', import.meta.url), 'utf8');

test('speaker request defaults off and accessible switch controls only its own state', () => {
  assert.match(upload, /\[includeSpeakers, setIncludeSpeakers\] = useState\(false\)/);
  assert.match(upload, /<Switch\s+accessibilityLabel="Include speaker labels"[\s\S]*?value=\{includeSpeakers\}[\s\S]*?onValueChange=\{setIncludeSpeakers\}/);
});

test('submission snapshots explicit boolean, guards duplicates and releases guard for retry', () => {
  assert.match(upload, /if \(uploadInFlight.current\) return/);
  assert.match(upload, /const requestedIncludeSpeakers = includeSpeakers/);
  assert.match(upload, /includeSpeakers: requestedIncludeSpeakers/);
  assert.match(upload, /finally \{\s+uploadInFlight.current = false/);
  assert.match(upload, /Speaker labels requested: \{lastRequestedIncludeSpeakers/);
});

test('only another upload resets selection, preserving picker, navigation and failed retries', () => {
  assert.equal((upload.match(/setIncludeSpeakers\(false\)/g) ?? []).length, 1);
  assert.match(upload, /const handleStartNewUpload = \(\) => \{\s+setIncludeSpeakers\(false\);\s+setLastRequestedIncludeSpeakers\(false\)/);
});

test('editor derives labels from transcript and guides empty state without automatic edits', () => {
  assert.match(editor, />Speaker names</);
  assert.match(editor, /captionSpeakerLabels\(transcript.cues\).length === 0/);
  assert.match(editor, /For future uploads, enable Include speaker labels/);
  assert.match(editor, /Queue speaker rename/);
});
