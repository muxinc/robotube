import { Image } from "expo-image";
import { Bot } from "lucide-react-native";
import { type ReactNode } from "react";
import { StyleSheet, View, type ImageSourcePropType } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type TabPageLogoHeaderProps = {
  source: ImageSourcePropType;
  width: number;
  height: number;
  includeTopInset?: boolean;
  logoOffset?: number;
  rightAccessory?: ReactNode;
};

export function TabPageLogoHeader({
  source,
  width,
  height,
  includeTopInset = true,
  logoOffset = -12,
  rightAccessory,
}: TabPageLogoHeaderProps) {
  const insets = useSafeAreaInsets();
  const topInset = includeTopInset ? insets.top : 0;

  return (
    <View
      style={[
        styles.header,
        {
          height: 62 + topInset,
          paddingTop: topInset + 6,
        },
      ]}
    >
      <View style={styles.logoWrap}>
        <Image
          source={source}
          contentFit="contain"
          contentPosition="left"
          style={[styles.logo, { width, height, marginLeft: logoOffset }]}
        />
      </View>

      <View style={styles.actions}>
        {rightAccessory ?? (
          <View style={styles.iconButton}>
            <Bot size={22} color="#111111" />
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingLeft: 12,
    paddingRight: 12,
    paddingBottom: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e5e5e5",
    backgroundColor: "#FFFFFF",
  },
  logoWrap: {
    flex: 1,
  },
  logo: {
    alignSelf: "flex-start",
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  iconButton: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 18,
  },
});
