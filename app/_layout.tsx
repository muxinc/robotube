import {
  DarkTheme,
  DefaultTheme,
  ThemeProvider,
} from "@react-navigation/native";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Platform } from "react-native";
import "react-native-reanimated";

import { useColorScheme } from "@/hooks/use-color-scheme";
import { authTokenStorage } from "@/lib/auth-token-storage";
import { convex } from "@/lib/convex";

export const unstable_settings = {
  anchor: "(tabs)",
};

export default function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <ConvexAuthProvider
      client={convex}
      storage={authTokenStorage}
      shouldHandleCode={Platform.OS === "web"}
    >
      <ThemeProvider value={colorScheme === "dark" ? DarkTheme : DefaultTheme}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="modal" options={{ presentation: "modal" }} />
          <Stack.Screen name="category/[category]" />
          <Stack.Screen name="search/[query]" />
          <Stack.Screen name="video/[muxAssetId]" />
          <Stack.Screen name="sign-in" />
        </Stack>

        <StatusBar style="auto" />
      </ThemeProvider>
    </ConvexAuthProvider>
  );
}
