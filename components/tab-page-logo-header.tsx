import { Image } from "expo-image";
import { type ReactNode } from "react";
import { Platform, StyleSheet, View, type ImageSourcePropType } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export const TAB_PAGE_LOGO_HEADER_HORIZONTAL_PADDING = 12;
export const TAB_PAGE_LOGO_HEADER_HEIGHT = 62;
export const TAB_PAGE_LOGO_HEADER_BOTTOM_PADDING = 8;
export const TAB_PAGE_LOGO_HEADER_TOP_PADDING = 6;
export const TAB_PAGE_LOGO_HEADER_BORDER_COLOR = "#e5e5e5";
export const TAB_PAGE_LOGO_HEADER_ICON_SIZE = 36;
export const TAB_PAGE_LOGO_OFFSET = -12;

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
  headerHeight = TAB_PAGE_LOGO_HEADER_HEIGHT,
  includeTopInset = true,
  logoOffset = TAB_PAGE_LOGO_OFFSET,
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
          paddingTop: topInset + TAB_PAGE_LOGO_HEADER_TOP_PADDING,
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
    paddingLeft: TAB_PAGE_LOGO_HEADER_HORIZONTAL_PADDING,
    paddingRight: TAB_PAGE_LOGO_HEADER_HORIZONTAL_PADDING,
    paddingBottom: TAB_PAGE_LOGO_HEADER_BOTTOM_PADDING,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: TAB_PAGE_LOGO_HEADER_BORDER_COLOR,
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
    width: TAB_PAGE_LOGO_HEADER_ICON_SIZE,
    height: TAB_PAGE_LOGO_HEADER_ICON_SIZE,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: TAB_PAGE_LOGO_HEADER_ICON_SIZE / 2,
  },
  iconImage: {
    width: 22,
    height: 22,
    borderRadius: 11,
  },
});
