import { Tabs } from "expo-router";
import React from "react";
import { Platform, StyleSheet, View } from "react-native";
import { BlurView } from "expo-blur";
import { Compass, House, Upload, User, Search } from "lucide-react-native";

import { HapticTab } from "@/components/haptic-tab";
import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";

export default function TabLayout() {
  const colorScheme = useColorScheme() === "dark" ? "dark" : "light";
  const isDark = colorScheme === "dark";

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: Colors[colorScheme].tint,
        tabBarInactiveTintColor: Colors[colorScheme].tabIconDefault,
        headerShown: false,
        tabBarButton: HapticTab,
        tabBarShowLabel: false,
        tabBarStyle: {
          position: "absolute",
          left: 14,
          right: 14,
          bottom: 16,
          height: 64,
          paddingTop: 10,
          paddingBottom: 10,
          borderRadius: 24,
          borderTopWidth: 0,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: isDark
            ? "rgba(255,255,255,0.2)"
            : "rgba(255,255,255,0.85)",
          backgroundColor: "transparent",
          overflow: "hidden",
          shadowColor: "#000",
          shadowOpacity: isDark ? 0.3 : 0.12,
          shadowRadius: 18,
          shadowOffset: { width: 0, height: 8 },
          elevation: 0,
        },
        tabBarBackground: () => (
          <View style={StyleSheet.absoluteFill}>
            <BlurView
              tint={
                isDark
                  ? "systemChromeMaterialDark"
                  : "systemChromeMaterialLight"
              }
              intensity={60}
              style={StyleSheet.absoluteFill}
              experimentalBlurMethod={
                Platform.OS === "android" ? "dimezisBlurView" : undefined
              }
            />
            <View
              pointerEvents="none"
              style={[
                StyleSheet.absoluteFill,
                {
                  backgroundColor: isDark
                    ? "rgba(24,24,28,0.2)"
                    : "rgba(255,255,255,0.16)",
                },
              ]}
            />
            <View
              pointerEvents="none"
              style={[
                styles.topHighlight,
                {
                  backgroundColor: isDark
                    ? "rgba(255,255,255,0.15)"
                    : "rgba(255,255,255,0.95)",
                },
              ]}
            />
          </View>
        ),
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          tabBarIcon: ({ color, size }) => (
            <House size={size} color={color} strokeWidth={2.25} />
          ),
        }}
      />
      <Tabs.Screen
        name="upload"
        options={{
          title: "Upload",
          tabBarIcon: ({ color, size }) => (
            <Upload size={size} color={color} strokeWidth={2.25} />
          ),
        }}
      />
      <Tabs.Screen
        name="explore"
        options={{
          title: "Explore",
          tabBarIcon: ({ color, size }) => (
            <Search size={size} color={color} strokeWidth={2.25} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: "Profile",
          tabBarIcon: ({ color, size }) => (
            <User size={size} color={color} strokeWidth={2.25} />
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  topHighlight: {
    position: "absolute",
    top: 0,
    left: 10,
    right: 10,
    height: StyleSheet.hairlineWidth,
  },
});
