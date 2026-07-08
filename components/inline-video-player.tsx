import {
  MuxVideoView,
  useMuxVideoPlayer,
  type MuxVideoPlayer,
} from "@mux/mux-react-native-player";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { StyleSheet, View } from "react-native";

import { runMuxPlayerCommand } from "@/lib/mux-player-command";

type InlineVideoPlayerProps = {
  playbackId: string;
  muxAssetId?: string;
  title?: string;
  isFocused: boolean;
  startAtSeconds?: number;
  onTimeUpdate?: (seconds: number) => void;
  muted?: boolean;
};

export const InlineVideoPlayer = memo(function InlineVideoPlayer({
  playbackId,
  muxAssetId,
  title,
  isFocused,
  startAtSeconds,
  onTimeUpdate,
  muted = true,
}: InlineVideoPlayerProps) {
  const hasAppliedStartAtRef = useRef(false);
  const focusedRef = useRef(isFocused);

  const source = useMemo(
    () => ({
      playbackId,
      assetId: muxAssetId,
      metadata: {
        playerName: "Robotube feed preview",
        videoId: muxAssetId,
        videoTitle: title,
      },
    }),
    [muxAssetId, playbackId, title],
  );
  const setupPlayer = useCallback(
    (player: MuxVideoPlayer) => {
      runMuxPlayerCommand(player.setLoop(true));
      runMuxPlayerCommand(player.setMuted(muted));
      runMuxPlayerCommand(player.setPlaybackRate(1));
    },
    [muted],
  );
  const player = useMuxVideoPlayer(source, setupPlayer);

  useEffect(() => {
    runMuxPlayerCommand(player.setMuted(muted));
  }, [muted, player]);

  useEffect(() => {
    focusedRef.current = isFocused;
  }, [isFocused]);

  useEffect(() => {
    if (isFocused) {
      runMuxPlayerCommand(player.play());
    } else {
      runMuxPlayerCommand(player.pause());
    }
  }, [isFocused, player]);

  return (
    <View style={styles.container}>
      <MuxVideoView
        player={player}
        style={styles.video}
        contentFit="cover"
        controls="none"
        allowsFullscreen={false}
        timeUpdateEventInterval={0.25}
        onStatusChange={(event) => {
          if (event.status === "ready" && focusedRef.current) {
            runMuxPlayerCommand(player.play());
          }
        }}
        onSourceLoad={() => {
          if (startAtSeconds === undefined || hasAppliedStartAtRef.current) return;
          runMuxPlayerCommand(player.seekTo(Math.max(0, startAtSeconds)));
          hasAppliedStartAtRef.current = true;
        }}
        onTimeUpdate={(event) => {
          onTimeUpdate?.(event.currentTime);
        }}
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
