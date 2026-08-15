export type FeedVideoKeyMomentCue = {
  startMs: number;
  endMs: number;
  text: string;
};

export type FeedVideoKeyMomentVisualConcept = {
  concept: string;
  score: number;
  rationale: string;
};

export type FeedVideoKeyMoment = {
  startMs: number;
  endMs: number;
  cues: FeedVideoKeyMomentCue[];
  overallScore: number | null;
  title: string | null;
  audibleNarrative: string | null;
  notableAudibleConcepts: string[];
  visualNarrative: string | null;
  notableVisualConcepts: FeedVideoKeyMomentVisualConcept[];
};

export type FeedVideoItem = {
  muxAssetId: string;
  playbackId: string;
  playbackUrl: string;
  thumbnailUrl: string;
  title: string;
  summary: string | null;
  tags: string[];
  chapters: Array<{ title: string; startTime: number }>;
  keyMoments: FeedVideoKeyMoment[];
  keyMomentsGeneratedAtMs: number | null;
  keyMomentsUnavailableReason: string | null;
  channelName: string;
  channelAvatarUrl: string | null;
  durationSeconds: number | null;
  createdAtMs: number;
};
