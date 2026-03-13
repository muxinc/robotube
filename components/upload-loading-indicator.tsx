import { Image } from "expo-image";
import { useEffect, useMemo, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";

import { useThemeColor } from "@/hooks/use-theme-color";
import { ThemedText } from "@/components/themed-text";

type UploadLoadingIndicatorProps = {
  isActive: boolean;
  status: string;
  progress: number;
};

export function UploadLoadingIndicator({
  isActive,
  status,
  progress,
}: UploadLoadingIndicatorProps) {
  const spinValue = useRef(new Animated.Value(0)).current;
  const clampedProgress = useMemo(
    () => Math.min(100, Math.max(0, progress)),
    [progress],
  );
  const iconWrapBackground = useThemeColor(
    { light: "#FFE7F5", dark: "#3D1E33" },
    "background",
  );
  const statusColor = useThemeColor(
    { light: "#1F2937", dark: "#E5E7EB" },
    "text",
  );
  const percentColor = useThemeColor(
    { light: "#5B6472", dark: "#AAB3C2" },
    "text",
  );
  const trackColor = useThemeColor(
    { light: "#E7EDF5", dark: "#2B3240" },
    "icon",
  );

  useEffect(() => {
    if (!isActive) {
      spinValue.stopAnimation();
      spinValue.setValue(0);
      return;
    }

    const loop = Animated.loop(
      Animated.timing(spinValue, {
        toValue: 1,
        duration: 950,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );

    loop.start();
    return () => loop.stop();
  }, [isActive, spinValue]);

  const spin = spinValue.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });

  return (
    <View style={styles.container}>
      <Animated.View
        style={[
          styles.iconWrap,
          {
            transform: [{ rotate: spin }],
            backgroundColor: iconWrapBackground,
          },
        ]}
      >
        <Image
          source={require("../assets/images/react-logo.png")}
          contentFit="contain"
          style={styles.icon}
        />
      </Animated.View>

      <View style={styles.content}>
        <ThemedText
          numberOfLines={2}
          style={[styles.statusText, { color: statusColor }]}
        >
          {status}
        </ThemedText>

        <View
          accessibilityRole="progressbar"
          accessibilityValue={{
            min: 0,
            max: 100,
            now: Math.round(clampedProgress),
          }}
          style={[styles.track, { backgroundColor: trackColor }]}
        >
          <View style={[styles.fill, { width: `${clampedProgress}%` }]} />
        </View>

        <ThemedText style={[styles.percent, { color: percentColor }]}>
          {Math.round(clampedProgress)}%
        </ThemedText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  iconWrap: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: "center",
    justifyContent: "center",
  },
  icon: {
    width: 48,
    height: 48,
  },
  content: {
    flex: 1,
    gap: 8,
  },
  statusText: {
    fontSize: 14,
    lineHeight: 20,
  },
  track: {
    width: "100%",
    height: 10,
    borderRadius: 999,
    overflow: "hidden",
  },
  fill: {
    height: "100%",
    borderRadius: 999,
    backgroundColor: "#4AA8FF",
  },
  percent: {
    fontSize: 12,
    fontWeight: "600",
    lineHeight: 16,
  },
});
