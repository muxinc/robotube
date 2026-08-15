import {
  DarkTheme,
  DefaultTheme,
  ThemeProvider,
} from "@react-navigation/native";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexProvider } from "convex/react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Platform, StyleSheet, View } from "react-native";
import "react-native-reanimated";

import { ThemedText } from "@/components/themed-text";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { FeedFeatureFlagsProvider } from "@/hooks/use-feed-feature-flags";
import { registerGlobals } from "@/lib/livekit";
import { authTokenStorage } from "@/lib/auth-token-storage";
import { convex, convexConfigError } from "@/lib/convex";

registerGlobals();

export const unstable_settings = {
  anchor: "(tabs)",
};

export default function RootLayout() {
  const colorScheme = useColorScheme();

  if (!convex) {
    return (
      <View style={styles.errorScreen}>
        <ThemedText type="title" style={styles.errorTitle}>
          App configuration error
        </ThemedText>
        <ThemedText style={styles.errorText}>{convexConfigError}</ThemedText>
        <ThemedText style={styles.errorText}>
          This build is missing its Convex client URL. Rebuild after setting
          `EXPO_PUBLIC_CONVEX_URL` in EAS.
        </ThemedText>
      </View>
    );
  }

  return (
    <ConvexProvider client={convex}>
      <ConvexAuthProvider
        client={convex}
        storage={authTokenStorage}
        shouldHandleCode={Platform.OS === "web"}
      >
        <FeedFeatureFlagsProvider>
          <ThemeProvider
            value={colorScheme === "dark" ? DarkTheme : DefaultTheme}
          >
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="modal" options={{ presentation: "modal" }} />
              <Stack.Screen name="search/[query]" />
              <Stack.Screen name="video/[muxAssetId]" />
              <Stack.Screen
                name="live/go-live"
                options={{ presentation: "fullScreenModal" }}
              />
              <Stack.Screen name="live/watch/[muxLiveStreamId]" />
              <Stack.Screen name="sign-in" />
            </Stack>

            <StatusBar style="auto" />
          </ThemeProvider>
        </FeedFeatureFlagsProvider>
      </ConvexAuthProvider>
    </ConvexProvider>
  );
}

const styles = StyleSheet.create({
  errorScreen: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 24,
    gap: 12,
  },
  errorTitle: {
    textAlign: "center",
  },
  errorText: {
    textAlign: "center",
  },
});
