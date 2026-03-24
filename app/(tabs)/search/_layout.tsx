import { Platform } from "react-native";
import { Stack } from "expo-router";

export default function SearchLayout() {
  const isIOS = Platform.OS === "ios";

  return (
    <Stack screenOptions={{ headerBackVisible: false }}>
      <Stack.Screen
        name="index"
        options={
          isIOS
            ? {
                title: "",
                headerTransparent: true,
                headerShadowVisible: false,
              }
            : { headerShown: false }
        }
      />
    </Stack>
  );
}
