import { Image } from "expo-image";
import { Platform, ScrollView, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Collapsible } from "@/components/ui/collapsible";
import { ExternalLink } from "@/components/external-link";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { Fonts } from "@/constants/theme";

export default function TabTwoScreen() {
  const insets = useSafeAreaInsets();

  return (
    <ThemedView style={styles.screen}>
      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          {
            paddingTop: insets.top + 10,
            paddingBottom: insets.bottom + 110,
          },
        ]}
      >
        <ThemedView style={styles.container}>
          <Image
            source={require("@/assets/images/explore-logo.png")}
            contentFit="contain"
            style={styles.exploreLogo}
          />
        </ThemedView>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 20,
  },
  container: {
    gap: 14,
    width: "100%",
    maxWidth: 760,
    alignSelf: "center",
  },
  exploreLogo: {
    width: 240,
    height: 88,
    alignSelf: "center",
    transform: [{ scale: 1.15 }],
  },
});
