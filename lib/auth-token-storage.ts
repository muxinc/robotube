import type { TokenStorage } from "@convex-dev/auth/react";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

export const authTokenStorage: TokenStorage = {
  getItem(key) {
    if (Platform.OS === "web" && typeof window !== "undefined") {
      return window.localStorage.getItem(key);
    }
    return SecureStore.getItemAsync(key);
  },
  setItem(key, value) {
    if (Platform.OS === "web" && typeof window !== "undefined") {
      window.localStorage.setItem(key, value);
      return;
    }
    return SecureStore.setItemAsync(key, value);
  },
  removeItem(key) {
    if (Platform.OS === "web" && typeof window !== "undefined") {
      window.localStorage.removeItem(key);
      return;
    }
    return SecureStore.deleteItemAsync(key);
  },
};
