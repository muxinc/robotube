export function buildCaptionDirectiveDefinition({ includeSpeakers }: { includeSpeakers: boolean }) {
  return {
    name: includeSpeakers ? "robotube-captions-speakers-v1" : "robotube-captions-plain-v1",
    subject: { type: "video.asset" }, resources: [],
    workflows: [{ reference_id: "premium_captions", workflow: "generate-premium-captions",
      params: { language_code: "en", include_speakers: includeSpeakers, upload_to_mux: true,
        track_name: "English (Premium)", replace_existing_tracks: "fail" } }],
  };
}

export function selectCaptionDirectiveId(includeSpeakers: boolean, env: Record<string, string | undefined>) {
  const key = includeSpeakers ? "MUX_CAPTION_DIRECTIVE_WITH_SPEAKERS_ID" : "MUX_CAPTION_DIRECTIVE_WITHOUT_SPEAKERS_ID";
  const id = env[key]?.trim();
  if (!id) throw new Error(`Missing env var: ${key}`);
  return id;
}
