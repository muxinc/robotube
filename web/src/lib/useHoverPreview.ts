import { useEffect, useRef, useState } from "react";

const PREVIEW_HOVER_DELAY_MS = 600;

/**
 * Hover-to-play preview state for feed cards. `previewing` mounts the video
 * after a short hover delay; `previewPlaying` flips once frames render so the
 * thumbnail can crossfade out.
 */
export function useHoverPreview() {
  const [previewing, setPreviewing] = useState(false);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current !== null) clearTimeout(hoverTimerRef.current);
    };
  }, []);

  const startPreview = () => {
    if (hoverTimerRef.current !== null) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null;
      setPreviewing(true);
    }, PREVIEW_HOVER_DELAY_MS);
  };

  const stopPreview = () => {
    if (hoverTimerRef.current !== null) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setPreviewing(false);
    setPreviewPlaying(false);
  };

  return {
    previewing,
    previewPlaying,
    previewRef,
    startPreview,
    stopPreview,
    onPreviewPlaying: () => setPreviewPlaying(true),
    getPreviewTime: () => previewRef.current?.currentTime ?? 0,
  };
}
