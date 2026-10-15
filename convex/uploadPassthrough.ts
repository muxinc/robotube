import { normalizeAudioTranslationLanguageCodes } from "../constants/audio-translation-languages";

/** Missing is legacy; a present empty list is an explicit user selection. */
export function readUploadLanguageCodes(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return normalizeAudioTranslationLanguageCodes(value.filter((item): item is string => typeof item === "string"));
}

/** Expand the versioned compact transport for every ingestion/recovery reader. */
export function decodeUploadCustom(parsed: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = parsed.custom;
  const custom = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (parsed.v !== 1) return custom;
  return {
    ...custom,
    audioTranslationLanguageCodes: readUploadLanguageCodes(parsed.a) ?? [],
    captionTranslationLanguageCodes: readUploadLanguageCodes(parsed.c) ?? [],
  };
}
