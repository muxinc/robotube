import { memo, useMemo } from "react";
import { MuxVideo } from "@videojs/react/media/mux-video";
import { Link, useNavigate } from "react-router-dom";

import { useHoverPreview } from "../lib/useHoverPreview";
import type { FeedVideoItem } from "../types";

export type ShortsCardProps = {
  video: FeedVideoItem;
};

export const ShortsCard = memo(function ShortsCard({ video }: ShortsCardProps) {
  const {
    previewing,
    previewPlaying,
    previewRef,
    startPreview,
    stopPreview,
    onPreviewPlaying,
    getPreviewTime,
  } = useHoverPreview();
  const navigate = useNavigate();
  const previewSource = useMemo(
    () => ({ playbackId: video.playbackId }),
    [video.playbackId],
  );
  const shortsPath = `/shorts/${encodeURIComponent(video.muxAssetId)}`;

  // Playback handoff: a plain left click while the preview is rolling carries
  // its position to the shorts page as a ?t= start-time deep link. Modified
  // clicks (new tab, etc.) keep the Link's default behavior.
  const handleLinkClick = (event: React.MouseEvent) => {
    const seconds = getPreviewTime();
    if (seconds <= 0) return;
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    navigate(`${shortsPath}?t=${seconds.toFixed(1)}`);
  };

  return (
    <article className="shorts-card">
      <Link
        className="shorts-card__link"
        to={shortsPath}
        onClick={handleLinkClick}
        aria-label={`Watch ${video.title} by ${video.channelName}`}
      >
        <div
          className="shorts-card__media"
          onMouseEnter={startPreview}
          onMouseLeave={stopPreview}
        >
          <img
            className="shorts-card__thumbnail"
            src={video.thumbnailUrl}
            alt=""
            loading="lazy"
          />
          {previewing ? (
            <MuxVideo
              ref={previewRef}
              className={`shorts-card__preview${previewPlaying ? " shorts-card__preview--playing" : ""}`}
              source={previewSource}
              autoPlay
              muted
              loop
              playsInline
              onPlaying={onPreviewPlaying}
            />
          ) : null}
        </div>
        <h3 className="shorts-card__title">{video.title}</h3>
        <p className="shorts-card__channel">{video.channelName}</p>
      </Link>
    </article>
  );
});
