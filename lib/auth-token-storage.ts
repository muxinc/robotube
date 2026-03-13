import type { TokenStorage } from "@convex-dev/auth/react";
import { Platform } from "react-native";

type SecureStoreModule = typeof import("expo-secure-store");

let secureStoreModule: SecureStoreModule | null | undefined;
let hasWarnedAboutSecureStore = false;
const memoryStorage = new Map<string, string>();

function isMissingNativeModuleError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("ExpoSecureStore") ||
    error.message.includes("native module")
  );
}

function warnAndDisableSecureStore() {
  secureStoreModule = null;
  if (!hasWarnedAboutSecureStore) {
    hasWarnedAboutSecureStore = true;
    console.warn(
      "expo-secure-store native module is unavailable; using in-memory auth token storage."
    );
  }
}

async function getSecureStore() {
  if (secureStoreModule !== undefined) {
    return secureStoreModule;
  }

  try {
    secureStoreModule = await import("expo-secure-store");
    return secureStoreModule;
  } catch {
    warnAndDisableSecureStore();
    return null;
  }
}

export const authTokenStorage: TokenStorage = {
  async getItem(key) {
    if (Platform.OS === "web" && typeof window !== "undefined") {
      return window.localStorage.getItem(key);
    }

    const secureStore = await getSecureStore();
    if (!secureStore) {
      return memoryStorage.get(key) ?? null;
    }

    try {
      return await secureStore.getItemAsync(key);
    } catch (error) {
      if (!isMissingNativeModuleError(error)) {
        throw error;
      }

      warnAndDisableSecureStore();
      return memoryStorage.get(key) ?? null;
    }
  },

  async setItem(key, value) {
    if (Platform.OS === "web" && typeof window !== "undefined") {
      window.localStorage.setItem(key, value);
      return;
    }

    const secureStore = await getSecureStore();
    if (!secureStore) {
      memoryStorage.set(key, value);
      return;
    }

    try {
      return await secureStore.setItemAsync(key, value);
    } catch (error) {
      if (!isMissingNativeModuleError(error)) {
        throw error;
      }

      warnAndDisableSecureStore();
      memoryStorage.set(key, value);
    }
  },

  async removeItem(key) {
    if (Platform.OS === "web" && typeof window !== "undefined") {
      window.localStorage.removeItem(key);
      return;
    }

    const secureStore = await getSecureStore();
    if (!secureStore) {
      memoryStorage.delete(key);
      return;
    }

    try {
      return await secureStore.deleteItemAsync(key);
    } catch (error) {
      if (!isMissingNativeModuleError(error)) {
        throw error;
      }

      warnAndDisableSecureStore();
      memoryStorage.delete(key);
    }
  },
};
