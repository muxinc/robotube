import type { TranscriptCue } from "./captionTranscript";

export type CaptionReplacement = { find: string; replace: string; caseSensitive?: boolean };
export type CaptionSpeakerReplacement = { find: string; replace: string };
export type CaptionRulePreview = TranscriptCue & { originalText: string; replacementCount: number };

export function captionSpeakerLabels(cues: TranscriptCue[]): string[] {
  return [...new Set(cues.flatMap((cue) => {
    const match = cue.text.match(/^\[([^\[\]\r\n]+)\]/);
    return match ? [match[1]] : [];
  }))];
}

export function captionRulesError(
  replacements: CaptionReplacement[],
  speakers: CaptionSpeakerReplacement[],
  autoCensor: boolean,
): string | undefined {
  if (!replacements.length && !speakers.length && !autoCensor) return "Add a text correction, rename a speaker, or enable profanity censoring.";
  if (replacements.length > 100 || speakers.length > 100) return "Use no more than 100 text corrections and 100 speaker renames.";
  for (const rule of replacements) {
    if (!rule.find.trim()) return "Choose text to replace from the transcript.";
    if (rule.find.length > 500 || rule.replace.length > 500) return "Text corrections must be 500 characters or fewer.";
    if (/[\r\n\u0000]|-->/.test(rule.find + rule.replace)) return "Text corrections cannot contain line breaks or timestamp delimiters.";
    if (rule.find === rule.replace) return "A text correction must change the selected text.";
  }
  const seen = new Set<string>();
  for (const speaker of speakers) {
    if (!speaker.find.trim() || !speaker.replace.trim()) return "Speaker names cannot be empty.";
    if (speaker.find.length > 200 || speaker.replace.length > 200) return "Speaker names must be 200 characters or fewer.";
    if (/[\[\]\r\n\u0000]/.test(speaker.find + speaker.replace)) return "Speaker names cannot contain brackets or line breaks.";
    if (speaker.find === speaker.replace) return "A speaker rename must change the name.";
    if (seen.has(speaker.find)) return "Rename each speaker only once per job.";
    seen.add(speaker.find);
  }
}

/** Local estimate only. Mux owns matching semantics, operation order and AI censoring. */
export function previewCaptionRules(
  cues: TranscriptCue[],
  replacements: CaptionReplacement[],
  speakers: CaptionSpeakerReplacement[],
): { cues: CaptionRulePreview[]; changedCueCount: number; totalReplacementCount: number } {
  const prepared = replacements.filter((rule) => rule.find.length > 0).map((rule) => ({
    pattern: new RegExp(rule.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), rule.caseSensitive ? "g" : "gi"),
    replace: rule.replace,
  }));
  const preview = cues.map((cue) => {
    let replacementCount = 0;
    let text = cue.text;
    const speaker = /^\[([^\[\]\r\n]+)\]/.exec(text);
    const rename = speaker && speakers.find((rule) => rule.find === speaker[1]);
    if (speaker && rename && rename.find !== rename.replace) {
      text = `[${rename.replace}]${text.slice(speaker[0].length)}`;
      replacementCount++;
    }
    for (const rule of prepared) {
      text = text.replace(rule.pattern, () => { replacementCount++; return rule.replace; });
    }
    return { ...cue, text, originalText: cue.text, replacementCount };
  });
  return {
    cues: preview,
    changedCueCount: preview.filter((cue) => cue.text !== cue.originalText).length,
    totalReplacementCount: preview.reduce((count, cue) => count + cue.replacementCount, 0),
  };
}
