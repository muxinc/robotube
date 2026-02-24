import { useAuthActions } from "@convex-dev/auth/react";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "expo-router";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { api } from "@/convex/_generated/api";

WebBrowser.maybeCompleteAuthSession();

export default function ProfileScreen() {
  const router = useRouter();
  const { signIn, signOut } = useAuthActions();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [isSubmittingProvider, setIsSubmittingProvider] = useState<
    "google" | "apple" | null
  >(null);
  const [handleInput, setHandleInput] = useState("");
  const [isSavingHandle, setIsSavingHandle] = useState(false);
  const [handleMessage, setHandleMessage] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const updateUsername = useMutation((api as any).users.updateUsername);
  const currentUser = useQuery((api as any).users.currentUser) as
    | {
        username?: string;
        name?: string;
        email?: string;
      }
    | null
    | undefined;

  useEffect(() => {
    setErrorText(null);
  }, [isSigningOut, isSubmittingProvider]);

  useEffect(() => {
    setHandleInput(currentUser?.username ?? "");
  }, [currentUser?.username]);

  const handleOAuthSignIn = async (provider: "google" | "apple") => {
    if (isSubmittingProvider || isSigningOut) return;
    setIsSubmittingProvider(provider);
    setErrorText(null);

    try {
      const result = await signIn(provider, { redirectTo: "/profile" });
      if (Platform.OS !== "web" && result.redirect) {
        const callbackUrl = Linking.createURL("profile");
        const authResult = await WebBrowser.openAuthSessionAsync(
          result.redirect.toString(),
          callbackUrl,
        );

        if (authResult.type === "success" && authResult.url) {
          const callback = new URL(authResult.url);
          const code = callback.searchParams.get("code");
          if (!code) {
            throw new Error("Missing OAuth code from callback.");
          }
          await signIn(provider, { code });
        }
      }

      router.replace("/");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not complete sign in. Please try again.";
      setErrorText(message);
    } finally {
      setIsSubmittingProvider(null);
    }
  };

  const handleSignOut = async () => {
    if (isSigningOut || isSubmittingProvider) return;
    setIsSigningOut(true);
    try {
      await signOut();
    } finally {
      setIsSigningOut(false);
    }
  };

  const handleSaveHandle = async () => {
    if (!currentUser || isSavingHandle) return;

    const trimmed = handleInput.trim();
    if (trimmed.length === 0) {
      setHandleMessage("Handle cannot be empty.");
      return;
    }

    setIsSavingHandle(true);
    setHandleMessage(null);
    try {
      const result = (await updateUsername({ username: trimmed })) as {
        username: string;
      };
      setHandleInput(result.username);
      setHandleMessage("Handle updated.");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not update handle right now.";
      setHandleMessage(message);
    } finally {
      setIsSavingHandle(false);
    }
  };

  if (currentUser === undefined) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#111111" />
      </View>
    );
  }

  if (!currentUser) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Welcome to Robotube</Text>
        <Text style={styles.metaText}>Sign in to upload, search, and use AI tools.</Text>

        <Pressable
          style={({ pressed }) => [
            styles.authButton,
            pressed && styles.signOutPressed,
            isSubmittingProvider === "google" && styles.signOutDisabled,
          ]}
          onPress={() => {
            void handleOAuthSignIn("google");
          }}
          disabled={Boolean(isSubmittingProvider) || isSigningOut}
        >
          <Text style={styles.authButtonText}>
            {isSubmittingProvider === "google"
              ? "Connecting Google..."
              : "Continue with Google"}
          </Text>
        </Pressable>

        <Pressable
          style={({ pressed }) => [
            styles.authButton,
            pressed && styles.signOutPressed,
            isSubmittingProvider === "apple" && styles.signOutDisabled,
          ]}
          onPress={() => {
            void handleOAuthSignIn("apple");
          }}
          disabled={Boolean(isSubmittingProvider) || isSigningOut}
        >
          <Text style={styles.authButtonText}>
            {isSubmittingProvider === "apple"
              ? "Connecting Apple..."
              : "Continue with Apple"}
          </Text>
        </Pressable>

        {errorText ? <Text style={styles.errorText}>{errorText}</Text> : null}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Profile</Text>
      <Text style={styles.metaText}>{currentUser.name ?? "Signed in user"}</Text>
      <Text style={styles.metaText}>{currentUser.email ?? "No email available"}</Text>

      <View style={styles.handleSection}>
        <Text style={styles.handleLabel}>Public handle</Text>
        <View style={styles.handleInputRow}>
          <Text style={styles.handlePrefix}>@</Text>
          <TextInput
            value={handleInput}
            onChangeText={setHandleInput}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="your_handle"
            placeholderTextColor="#8A94A8"
            style={styles.handleInput}
          />
        </View>
        <Pressable
          style={({ pressed }) => [
            styles.handleSaveButton,
            pressed && styles.signOutPressed,
            isSavingHandle && styles.signOutDisabled,
          ]}
          onPress={() => {
            void handleSaveHandle();
          }}
          disabled={isSavingHandle}
        >
          <Text style={styles.handleSaveButtonText}>
            {isSavingHandle ? "Saving..." : "Save handle"}
          </Text>
        </Pressable>
        {handleMessage ? <Text style={styles.handleMessage}>{handleMessage}</Text> : null}
      </View>

      <Pressable
        style={({ pressed }) => [
          styles.signOutButton,
          pressed && styles.signOutPressed,
          isSigningOut && styles.signOutDisabled,
        ]}
        onPress={() => {
          void handleSignOut();
        }}
        disabled={isSigningOut}
      >
        <Text style={styles.signOutText}>
          {isSigningOut ? "Signing out..." : "Sign out"}
        </Text>
      </Pressable>

      {errorText ? <Text style={styles.errorText}>{errorText}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: "700",
  },
  metaText: {
    fontSize: 14,
    color: "#4B5568",
    textAlign: "center",
  },
  authButton: {
    marginTop: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#D4DBE6",
    paddingHorizontal: 18,
    paddingVertical: 12,
    backgroundColor: "#FFFFFF",
    minWidth: 220,
    alignItems: "center",
  },
  authButtonText: {
    fontSize: 14,
    fontWeight: "700",
    color: "#1B2434",
  },
  handleSection: {
    marginTop: 10,
    width: "100%",
    maxWidth: 360,
    alignItems: "center",
    gap: 8,
  },
  handleLabel: {
    fontSize: 13,
    fontWeight: "700",
    color: "#3D4A63",
  },
  handleInputRow: {
    width: "100%",
    minHeight: 46,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#D4DBE6",
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
  },
  handlePrefix: {
    fontSize: 16,
    lineHeight: 20,
    fontWeight: "700",
    color: "#41506B",
    marginRight: 4,
  },
  handleInput: {
    flex: 1,
    fontSize: 15,
    color: "#1B2434",
    paddingVertical: 0,
  },
  handleSaveButton: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#D4DBE6",
    paddingHorizontal: 14,
    paddingVertical: 9,
    backgroundColor: "#FFFFFF",
  },
  handleSaveButtonText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#1B2434",
  },
  handleMessage: {
    fontSize: 12,
    color: "#5A687F",
    textAlign: "center",
  },
  signOutButton: {
    marginTop: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#D4DBE6",
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: "#FFFFFF",
  },
  signOutPressed: {
    opacity: 0.85,
  },
  signOutDisabled: {
    opacity: 0.6,
  },
  signOutText: {
    fontSize: 14,
    fontWeight: "700",
    color: "#1B2434",
  },
  errorText: {
    marginTop: 4,
    fontSize: 13,
    lineHeight: 18,
    color: "#A62828",
    textAlign: "center",
  },
});
