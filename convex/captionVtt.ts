export type CaptionCue = { id: string; startMs: number; endMs: number; text: string };
export type CaptionDocument = { header: string; cues: CaptionCue[]; source: string };

const MAX_BYTES = 5_000_000;
const TIME = /^((?:\d{2,}:)?\d{2}:\d{2}[.,]\d{3})\s+-->\s+((?:\d{2,}:)?\d{2}:\d{2}[.,]\d{3})(?:\s+.*)?$/;

function ms(value: string) {
  const p = value.replace(",", ".").split(":").map(Number);
  if (p.length === 2) p.unshift(0);
  if (p.length !== 3 || p.some((n) => !Number.isFinite(n)) || p[1] >= 60 || p[2] >= 60) throw new Error("Caption timestamps are malformed.");
  return Math.round((p[0] * 3600 + p[1] * 60 + p[2]) * 1000);
}
function id(index: number, start: number, end: number, text: string) {
  let hash = 2166136261;
  for (const char of `${index}|${start}|${end}|${text}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `cue-${index + 1}-${(hash >>> 0).toString(16)}`;
}

export function parseCaptionVtt(source: string): CaptionDocument {
  if (new TextEncoder().encode(source).length > MAX_BYTES) throw new Error("Caption file is too large to edit (5 MB maximum).");
  const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!/^WEBVTT(?:[ \t].*)?(?:\n|$)/.test(normalized)) throw new Error("Caption file is unavailable because it is not valid WebVTT.");
  const lines = normalized.split("\n");
  const cues: CaptionCue[] = [];
  for (let i = 1; i < lines.length;) {
    if (!lines[i].trim()) { i++; continue; }
    if (/^(NOTE|STYLE|REGION)(?:\s|$)/.test(lines[i])) { while (i < lines.length && lines[i].trim()) i++; continue; }
    let timestamp = lines[i];
    if (!timestamp.includes("-->")) { i++; timestamp = lines[i] ?? ""; }
    const match = timestamp.match(TIME);
    if (!match) {
      if (timestamp.includes("-->")) throw new Error("Caption timestamps are malformed.");
      i++; continue;
    }
    const start = ms(match[1]), end = ms(match[2]);
    if (end <= start) throw new Error("Caption file contains an invalid cue duration.");
    i++;
    const text: string[] = [];
    while (i < lines.length && lines[i].trim()) text.push(lines[i++]);
    const value = text.join("\n");
    if (!value.trim()) throw new Error("Caption file contains an empty cue.");
    cues.push({ id: id(cues.length, start, end, value), startMs: start, endMs: end, text: value });
  }
  if (!cues.length) throw new Error("Caption file does not contain any editable cues.");
  const header = lines.slice(0, 1).join("\n") + "\n\n";
  return { header, cues, source: normalized };
}

export function replaceCaptionCueText(source: string, document: CaptionDocument, edits: Record<string, string>) {
  const lines = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  let cueIndex = 0;
  for (let i = 1; i < lines.length && cueIndex < document.cues.length;) {
    if (!lines[i].trim()) { i++; continue; }
    if (/^(NOTE|STYLE|REGION)(?:\s|$)/.test(lines[i])) { while (i < lines.length && lines[i].trim()) i++; continue; }
    if (!TIME.test(lines[i])) { i++; continue; }
    i++; const start = i;
    while (i < lines.length && lines[i].trim()) i++;
    const cue = document.cues[cueIndex++];
    if (edits[cue.id] !== undefined) {
      if (!edits[cue.id].trim()) throw new Error("Caption cue text cannot be empty.");
      lines.splice(start, i - start, ...edits[cue.id].split("\n"));
      i = start + edits[cue.id].split("\n").length;
    }
  }
  return lines.join("\n");
}
