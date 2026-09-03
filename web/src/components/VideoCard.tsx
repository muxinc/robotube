import { memo, useMemo } from "react";
import { MuxVideo } from "@videojs/react/media/mux-video";
import { Play } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";

import { useHoverPreview } from "../lib/useHoverPreview";
import type { FeedVideoItem } from "../types";

export type VideoCardProps = {
  video: FeedVideoItem;
};

function formatDuration(durationSeconds: number | null) {
  if (durationSeconds === null || !Number.isFinite(durationSeconds))
    return null;

  const totalSeconds = Math.max(0, Math.floor(durationSeconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatPublished(createdAtMs: number) {
  const elapsedMs = Math.max(0, Date.now() - createdAtMs);
  const days = Math.floor(elapsedMs / 86_400_000);

  if (days < 1) return "Today";
  if (days < 7) return `${days}d ago`;

  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;

  return `${Math.floor(days / 365)}y ago`;
}

export const VideoCard = memo(function VideoCard({ video }: VideoCardProps) {
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
  const watchPath = `/watch/${encodeURIComponent(video.muxAssetId)}`;

  // Playback handoff: a plain left click while the preview is rolling carries
  // its position to the watch page as a ?t= start-time deep link. Modified
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
    navigate(`${watchPath}?t=${seconds.toFixed(1)}`);
  };

  const duration = useMemo(
    () => formatDuration(video.durationSeconds),
    [video.durationSeconds],
  );
  const published = formatPublished(video.createdAtMs);
  const publishedDate = new Date(video.createdAtMs);
  const channelInitial =
    video.channelName.trim().charAt(0).toUpperCase() || "R";

  return (
    <article className="video-card">
      <Link
        className="video-card__link"
        to={watchPath}
        onClick={handleLinkClick}
        aria-label={`Watch ${video.title} by ${video.channelName}`}
      >
        <div
          className="video-card__media"
          onMouseEnter={startPreview}
          onMouseLeave={stopPreview}
        >
          <img
            className="video-card__thumbnail"
            src={video.thumbnailUrl}
            alt=""
            loading="lazy"
          />
          {previewing ? (
            <MuxVideo
              ref={previewRef}
              className={`video-card__preview${previewPlaying ? " video-card__preview--playing" : ""}`}
              source={previewSource}
              autoPlay
              muted
              loop
              playsInline
              onPlaying={onPreviewPlaying}
            />
          ) : null}
          <span className="video-card__play" aria-hidden="true">
            <Play size={22} fill="currentColor" />
          </span>
          {duration ? (
            <span className="video-card__duration">{duration}</span>
          ) : null}
        </div>

        <div className="video-card__body">
          <div className="video-card__avatar" aria-hidden="true">
            {video.channelAvatarUrl ? (
              <img
                className="video-card__avatar-image"
                src={video.channelAvatarUrl}
                alt=""
                loading="lazy"
              />
            ) : (
              <span className="video-card__avatar-fallback">
                {channelInitial}
              </span>
            )}
          </div>

          <div className="video-card__copy">
            <h3 className="video-card__title">{video.title}</h3>
            <p className="video-card__meta">
              <span className="video-card__channel">{video.channelName}</span>
              <span className="video-card__separator" aria-hidden="true">
                ·
              </span>
              <time
                className="video-card__age"
                dateTime={publishedDate.toISOString()}
                title={publishedDate.toLocaleString()}
              >
                {published}
              </time>
            </p>
          </div>
        </div>
      </Link>
    </article>
  );
});
