export type TranscriptCue = { id: string; startMs: number; endMs: number; text: string };
export type CaptionTranscript = {
  trackId: string;
  captionRevision: number;
  cues: TranscriptCue[];
};

export function captionTimestamp(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 3600).toString().padStart(2, "0")}:${Math.floor(seconds / 60 % 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}.${Math.floor(ms % 1000).toString().padStart(3, "0")}`;
}

/** Submit cue IDs, never global replacements: repeated dialogue can differ per cue. */
export function captionTranscriptEdits(document: CaptionTranscript, drafts: Record<string, string>) {
  return document.cues
    .filter((cue) => drafts[cue.id] !== undefined && drafts[cue.id] !== cue.text)
    .map((cue) => ({ id: cue.id, text: drafts[cue.id] }));
}

export function captionTextError(text: string): string | undefined {
  if (!text.trim()) return "Caption text cannot be empty.";
  if (text.length > 10_000) return "Use no more than 10,000 characters per caption.";
  if (/\n\s*\n|-->|\r|\u0000/.test(text)) return "Remove blank lines or timestamp delimiters from the caption text.";
}
