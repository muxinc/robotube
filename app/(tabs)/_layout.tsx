import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { Platform } from "react-native";

import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";

export default function TabLayout() {
  const colorScheme = useColorScheme() === "dark" ? "dark" : "light";
  const isDark = colorScheme === "dark";
  const isIOS = Platform.OS === "ios";

  return (
    <NativeTabs
      tintColor={Colors[colorScheme].tint}
      iconColor={{
        default: Colors[colorScheme].tabIconDefault,
        selected: Colors[colorScheme].tabIconSelected,
      }}
      labelStyle={{
        default: { color: Colors[colorScheme].tabIconDefault },
        selected: { color: Colors[colorScheme].tabIconSelected },
      }}
      labelVisibilityMode="unlabeled"
      backgroundColor={isDark ? "rgba(24,24,28,0.9)" : "rgba(255,255,255,0.95)"}
      blurEffect={isDark ? "systemChromeMaterialDark" : "systemChromeMaterialLight"}
      shadowColor={isDark ? "rgba(0,0,0,0.34)" : "rgba(0,0,0,0.16)"}
      disableTransparentOnScrollEdge
    >
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon
          src={
            <NativeTabs.Trigger.VectorIcon
              family={MaterialCommunityIcons}
              name="home-outline"
            />
          }
        />
        <NativeTabs.Trigger.Label hidden>Home</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="upload">
        <NativeTabs.Trigger.Icon
          src={
            <NativeTabs.Trigger.VectorIcon
              family={MaterialCommunityIcons}
              name="upload-outline"
            />
          }
        />
        <NativeTabs.Trigger.Label hidden>Upload</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger
        name="explore"
        role={isIOS ? "search" : undefined}
      >
        <NativeTabs.Trigger.Icon
          src={
            <NativeTabs.Trigger.VectorIcon
              family={MaterialCommunityIcons}
              name={isIOS ? "magnify" : "compass-outline"}
            />
          }
        />
        <NativeTabs.Trigger.Label hidden>
          {isIOS ? "Search" : "Explore"}
        </NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="profile">
        <NativeTabs.Trigger.Icon
          src={
            <NativeTabs.Trigger.VectorIcon
              family={MaterialCommunityIcons}
              name="account-outline"
            />
          }
        />
        <NativeTabs.Trigger.Label hidden>Profile</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
