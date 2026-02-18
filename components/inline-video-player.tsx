import { useVideoPlayer, VideoView } from "expo-video";
import { memo, useEffect, useRef } from "react";
import { StyleSheet, View } from "react-native";

type InlineVideoPlayerProps = {
  playbackUrl: string;
  isFocused: boolean;
  startAtSeconds?: number;
  onTimeUpdate?: (seconds: number) => void;
  muted?: boolean;
};

export const InlineVideoPlayer = memo(function InlineVideoPlayer({
  playbackUrl,
  isFocused,
  startAtSeconds,
  onTimeUpdate,
  muted = true,
}: InlineVideoPlayerProps) {
  const hasAppliedStartAtRef = useRef(false);
  const focusedRef = useRef(isFocused);

  const player = useVideoPlayer({ uri: playbackUrl, contentType: "hls" }, (player) => {
    player.loop = true;
    player.muted = muted;
    player.playbackRate = 1;
    player.timeUpdateEventInterval = 0.25;
  });

  useEffect(() => {
    player.muted = muted;
  }, [muted, player]);

  useEffect(() => {
    focusedRef.current = isFocused;
  }, [isFocused]);

  useEffect(() => {
    if (startAtSeconds === undefined || hasAppliedStartAtRef.current) return;
    player.currentTime = Math.max(0, startAtSeconds);
    hasAppliedStartAtRef.current = true;
  }, [player, startAtSeconds]);

  useEffect(() => {
    const subscription = player.addListener("timeUpdate", (event) => {
      onTimeUpdate?.(event.currentTime);
    });

    return () => {
      subscription.remove();
    };
  }, [onTimeUpdate, player]);

  useEffect(() => {
    const subscription = player.addListener("statusChange", (event) => {
      if (event.status === "readyToPlay" && focusedRef.current) {
        player.play();
      }
    });

    return () => {
      subscription.remove();
    };
  }, [player]);

  useEffect(() => {
    if (isFocused) {
      if (player.status === "readyToPlay") {
        player.play();
      }
    } else {
      player.pause();
    }
  }, [isFocused, player]);

  return (
    <View style={styles.container}>
      <VideoView
        player={player}
        style={styles.video}
        contentFit="cover"
        nativeControls={false}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  video: {
    flex: 1,
  },
});
