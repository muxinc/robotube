import { Image } from "expo-image";
import { StyleSheet, View, type ImageSourcePropType, type StyleProp, type ViewStyle } from "react-native";

const TAB_PAGE_LOGO_SLOT_HEIGHT = 120;

type TabPageLogoProps = {
  source: ImageSourcePropType;
  width: number;
  height: number;
  style?: StyleProp<ViewStyle>;
};

export function TabPageLogo({ source, width, height, style }: TabPageLogoProps) {
  return (
    <View style={[styles.frame, style]}>
      <Image
        source={source}
        contentFit="contain"
        contentPosition="left"
        style={[styles.logo, { width, height }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    height: TAB_PAGE_LOGO_SLOT_HEIGHT,
    justifyContent: "center",
  },
  logo: {
    alignSelf: "flex-start",
    marginLeft: -12,
  },
});
