import "@videojs/react/video/skin.css";
import "@videojs/react/live-video/skin.css";

import { MuxData, type MuxDataProps } from "@videojs/react/media/mux-data";
import { MuxVideo } from "@videojs/react/media/mux-video";
import { LiveVideoPlayer, LiveVideoSkin } from "@videojs/react/live-video";
import { Video, VideoPlayer, VideoSkin } from "@videojs/react/video";
import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";

type PlayerChapter = {
  title: string;
  startTime: number;
};

type RoboTubePlayerProps = {
  playbackId?: string;
  src?: string;
  title: string;
  posterUrl?: string | null;
  metadata?: MuxDataProps["metadata"];
  streamType?: "live" | "on-demand";
  autoPlay?: boolean;
  /**
   * Defaults to `autoPlay` so unattended autoplay satisfies browser policies.
   * Pass `false` when playback starts from an explicit user gesture (e.g. the
   * Shorts page) and audio should be on.
   */
  muted?: boolean;
  chapters?: PlayerChapter[];
  durationSeconds?: number | null;
};

function formatVttTime(seconds: number) {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function createChaptersVtt(chapters: PlayerChapter[], durationSeconds?: number | null) {
  const ordered = chapters
    .filter((chapter) => Number.isFinite(chapter.startTime) && chapter.startTime >= 0 && chapter.title.trim())
    .sort((left, right) => left.startTime - right.startTime)
    .filter((chapter, index, all) => index === 0 || chapter.startTime > all[index - 1].startTime);

  if (!ordered.length) return null;

  const cues = ordered.map((chapter, index) => {
    const nextStart = ordered[index + 1]?.startTime;
    const fallbackEnd = durationSeconds && durationSeconds > chapter.startTime
      ? durationSeconds
      : chapter.startTime + 86_400;
    const endTime = Math.max(chapter.startTime + 0.001, nextStart ?? fallbackEnd);
    const title = chapter.title.trim().replace(/-->/g, "→").replace(/[\r\n]+/g, " ");
    return `${index + 1}\n${formatVttTime(chapter.startTime)} --> ${formatVttTime(endTime)}\n${title}`;
  });

  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}

function useChaptersTrack(chapters: PlayerChapter[] | undefined, durationSeconds?: number | null) {
  const [trackUrl, setTrackUrl] = useState<string | null>(null);
  const vtt = useMemo(
    () => createChaptersVtt(chapters ?? [], durationSeconds),
    [chapters, durationSeconds],
  );

  useEffect(() => {
    if (!vtt) {
      setTrackUrl(null);
      return;
    }
    const url = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
    setTrackUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [vtt]);

  return trackUrl;
}

const RoboTubePlayer = forwardRef<HTMLVideoElement, RoboTubePlayerProps>(
  function RoboTubePlayer(
    {
      playbackId,
      src,
      title,
      posterUrl,
      metadata,
      streamType = "on-demand",
      autoPlay = false,
      muted = autoPlay,
      chapters,
      durationSeconds,
    },
    ref,
  ) {
    const mediaRef = useRef<HTMLVideoElement | null>(null);
    const attachMedia = useCallback(
      (element: HTMLVideoElement | null) => {
        mediaRef.current = element;
        if (typeof ref === "function") {
          ref(element);
        } else if (ref) {
          ref.current = element;
        }
      },
      [ref],
    );
    const source = useMemo(
      () => (playbackId ? { playbackId } : null),
      [playbackId],
    );
    const chaptersTrackUrl = useChaptersTrack(chapters, durationSeconds);

    useEffect(() => {
      const togglePlaybackWithSpacebar = (event: KeyboardEvent) => {
        if (
          event.defaultPrevented ||
          event.repeat ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.code !== "Space"
        ) {
          return;
        }

        const target = event.target;
        if (
          target instanceof Element &&
          target.closest(
            'input, textarea, select, button, a, [contenteditable="true"], [role="button"], [role="slider"], [role="textbox"]',
          )
        ) {
          return;
        }

        const media = mediaRef.current;
        if (!media) return;

        event.preventDefault();
        if (media.paused || media.ended) {
          void media.play().catch(() => undefined);
        } else {
          media.pause();
        }
      };

      window.addEventListener("keydown", togglePlaybackWithSpacebar);
      return () => window.removeEventListener("keydown", togglePlaybackWithSpacebar);
    }, []);

    const muxMedia = source ? (
      <>
        <MuxVideo
          ref={attachMedia}
          source={source}
          autoPlay={autoPlay}
          muted={muted}
          playsInline
          crossOrigin="anonymous"
          preload="metadata"
        >
          {chaptersTrackUrl ? (
            <track
              default
              kind="chapters"
              label="Chapters"
              src={chaptersTrackUrl}
            />
          ) : null}
        </MuxVideo>
        <MuxData
          playerSoftwareName="RoboTube Web"
          metadata={metadata}
        />
      </>
    ) : null;

    const media = muxMedia ?? (
      <Video
        ref={attachMedia}
        src={src}
        playsInline
        preload="metadata"
      >
        {chaptersTrackUrl ? (
          <track default kind="chapters" label="Chapters" src={chaptersTrackUrl} />
        ) : null}
      </Video>
    );

    if (streamType === "live") {
      return (
        <LiveVideoPlayer title={title} poster={posterUrl ?? undefined}>
          <LiveVideoSkin className="robotube-videojs-player">
            {media}
          </LiveVideoSkin>
        </LiveVideoPlayer>
      );
    }

    return (
      <VideoPlayer title={title} poster={posterUrl ?? undefined}>
        <VideoSkin className="robotube-videojs-player">
          {media}
        </VideoSkin>
      </VideoPlayer>
    );
  },
);

export default RoboTubePlayer;
