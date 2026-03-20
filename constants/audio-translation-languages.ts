export const AUDIO_TRANSLATION_LANGUAGE_OPTIONS = [
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "ja", label: "Japanese" },
  { code: "zh", label: "Mandarin Chinese" },
] as const;

export type AudioTranslationLanguageCode =
  (typeof AUDIO_TRANSLATION_LANGUAGE_OPTIONS)[number]["code"];

const SUPPORTED_LANGUAGE_CODES = new Set<string>(
  AUDIO_TRANSLATION_LANGUAGE_OPTIONS.map((language) => language.code),
);

const LABEL_BY_CODE = new Map<string, string>(
  AUDIO_TRANSLATION_LANGUAGE_OPTIONS.map((language) => [language.code, language.label]),
);

export function isAudioTranslationLanguageCode(
  value: string,
): value is AudioTranslationLanguageCode {
  return SUPPORTED_LANGUAGE_CODES.has(value);
}

export function normalizeAudioTranslationLanguageCodes(values: string[]) {
  const seen = new Set<AudioTranslationLanguageCode>();
  const normalized: AudioTranslationLanguageCode[] = [];

  for (const value of values) {
    if (!isAudioTranslationLanguageCode(value) || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }

  return normalized;
}

export function getAudioTranslationLanguageLabel(code: string) {
  return LABEL_BY_CODE.get(code) ?? code;
}
