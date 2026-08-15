import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import {
  feedPerformanceCounters,
  type FeedCountersSnapshot,
} from "@/lib/feed-performance-counters";

const isDevelopment = typeof __DEV__ !== "undefined" && __DEV__;

export function FeedPerformanceDebugOverlay() {
  const [snapshot, setSnapshot] = useState<FeedCountersSnapshot>(() =>
    feedPerformanceCounters.snapshot(),
  );

  useEffect(
    () => feedPerformanceCounters.subscribe(setSnapshot),
    [],
  );

  if (!isDevelopment || !snapshot.enabled) return null;

  const { gauges, peaks, counters, invariantViolations } = snapshot;

  return (
    <View pointerEvents="none" style={styles.overlay}>
      <Text style={styles.text}>
        rows {gauges.mountedFeedRows}/{peaks.mountedFeedRows} · surfaces{" "}
        {gauges.attachedPlayerSurfaces} · players {gauges.livePlayerInstances} ·
        playing {gauges.playingFeedVideos}
      </Text>
      <Text style={styles.text}>
        source swaps {counters.sourceReplacements} · preload{" "}
        {counters.preloadStarts}/{counters.preloadCancellations}/
        {counters.preloadCacheHits}
      </Text>
      {invariantViolations.length > 0 ? (
        <Text style={styles.violation}>
          invariant:{" "}
          {invariantViolations
            .map((item) => `${item.invariant}=${item.observed}`)
            .join(", ")}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
    zIndex: 100,
    top: 84,
    right: 8,
    maxWidth: "88%",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
    backgroundColor: "#000000C8",
  },
  text: {
    color: "#FFFFFF",
    fontSize: 10,
    lineHeight: 14,
  },
  violation: {
    color: "#FF9B9B",
    fontSize: 10,
    lineHeight: 14,
    fontWeight: "700",
  },
});
