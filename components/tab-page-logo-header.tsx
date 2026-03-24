import { Image } from "expo-image";
import { type ReactNode } from "react";
import { Platform, StyleSheet, View, type ImageSourcePropType } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type TabPageLogoHeaderProps = {
  source: ImageSourcePropType;
  width: number;
  height: number;
  headerHeight?: number;
  includeTopInset?: boolean;
  logoOffset?: number;
  rightAccessory?: ReactNode;
  transparentOnIOS?: boolean;
};

export function TabPageLogoHeader({
  source,
  width,
  height,
  headerHeight = 62,
  includeTopInset = true,
  logoOffset = -12,
  rightAccessory,
  transparentOnIOS = false,
}: TabPageLogoHeaderProps) {
  const insets = useSafeAreaInsets();
  const topInset = includeTopInset ? insets.top : 0;
  const isIOS = Platform.OS === "ios";

  return (
    <View
      style={[
        styles.header,
        isIOS && transparentOnIOS ? styles.headerIOS : null,
        {
          height: headerHeight + topInset,
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
            <Image
              source={require("../assets/images/app-icon.png")}
              contentFit="contain"
              style={styles.iconImage}
            />
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
  headerIOS: {
    borderBottomWidth: 0,
    backgroundColor: "transparent",
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
  iconImage: {
    width: 22,
    height: 22,
    borderRadius: 11,
  },
});
