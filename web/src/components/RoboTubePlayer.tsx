import "@videojs/react/video/skin.css";
import "@videojs/react/live-video/skin.css";

import { MuxData, type MuxDataProps } from "@videojs/react/media/mux-data";
import { MuxVideo } from "@videojs/react/media/mux-video";
import { LiveVideoPlayer, LiveVideoSkin } from "@videojs/react/live-video";
import { Video, VideoPlayer, VideoSkin } from "@videojs/react/video";
import { forwardRef, useMemo } from "react";

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
};

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
    },
    ref,
  ) {
    const source = useMemo(
      () => (playbackId ? { playbackId } : null),
      [playbackId],
    );
    const muxMedia = source ? (
      <>
        <MuxVideo
          ref={ref}
          source={source}
          autoPlay={autoPlay}
          muted={muted}
          playsInline
          crossOrigin="anonymous"
          preload="metadata"
        />
        <MuxData
          playerSoftwareName="RoboTube Web"
          metadata={metadata}
        />
      </>
    ) : null;

    const media = muxMedia ?? (
      <Video
        ref={ref}
        src={src}
        playsInline
        preload="metadata"
      />
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
