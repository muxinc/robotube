import { ScrollView, StyleSheet, type ScrollViewProps, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ThemedView } from "@/components/themed-view";

const TAB_PAGE_HORIZONTAL_PADDING = 20;
const TAB_PAGE_TOP_PADDING = 24;
const TAB_PAGE_BOTTOM_PADDING = 110;
const TAB_PAGE_MAX_WIDTH = 760;

type TabPageScrollLayoutProps = Omit<ScrollViewProps, "contentContainerStyle"> & {
  children: React.ReactNode;
  containerStyle?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  topPaddingOffset?: number;
  bottomPaddingOffset?: number;
};

export function TabPageScrollLayout({
  children,
  containerStyle,
  contentContainerStyle,
  topPaddingOffset = TAB_PAGE_TOP_PADDING,
  bottomPaddingOffset = TAB_PAGE_BOTTOM_PADDING,
  ...scrollViewProps
}: TabPageScrollLayoutProps) {
  const insets = useSafeAreaInsets();

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentContainerStyle={[
        styles.scrollContent,
        {
          paddingTop: insets.top + topPaddingOffset,
          paddingBottom: insets.bottom + bottomPaddingOffset,
        },
        contentContainerStyle,
      ]}
      {...scrollViewProps}
    >
      <ThemedView style={[styles.container, containerStyle]}>{children}</ThemedView>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: TAB_PAGE_HORIZONTAL_PADDING,
  },
  container: {
    width: "100%",
    maxWidth: TAB_PAGE_MAX_WIDTH,
    alignSelf: "center",
  },
});
