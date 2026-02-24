import { useAuthActions } from "@convex-dev/auth/react";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

WebBrowser.maybeCompleteAuthSession();

export default function SignInScreen() {
  const { signIn } = useAuthActions();
  const [isSubmittingProvider, setIsSubmittingProvider] = useState<
    "google" | "apple" | null
  >(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
    setErrorText(null);
  }, [isSubmittingProvider]);

  const handleOAuthSignIn = async (provider: "google" | "apple") => {
    setIsSubmittingProvider(provider);
    setErrorText(null);

    try {
      const result = await signIn(provider, { redirectTo: "/sign-in" });
      if (Platform.OS === "web" || !result.redirect) {
        return;
      }

      const callbackUrl = Linking.createURL("sign-in");
      const authResult = await WebBrowser.openAuthSessionAsync(
        result.redirect.toString(),
        callbackUrl,
      );

      if (authResult.type !== "success" || !authResult.url) {
        return;
      }

      const callback = new URL(authResult.url);
      const code = callback.searchParams.get("code");
      if (!code) {
        throw new Error("Missing OAuth code from callback.");
      }

      await signIn(provider, { code });
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

  return (
    <View style={styles.screen}>
      <View style={styles.card}>
        <Text style={styles.title}>Welcome to Robotube</Text>
        <Text style={styles.subtitle}>
          Sign in to upload videos, manage your library, and use AI tools.
        </Text>

        <Pressable
          style={({ pressed }) => [
            styles.button,
            isSubmittingProvider === "google" && styles.buttonDisabled,
            pressed && styles.buttonPressed,
          ]}
          onPress={() => void handleOAuthSignIn("google")}
          disabled={isSubmittingProvider !== null}
        >
          {isSubmittingProvider === "google" ? (
            <ActivityIndicator color="#111111" />
          ) : (
            <Text style={styles.buttonText}>Continue with Google</Text>
          )}
        </Pressable>

        <Pressable
          style={({ pressed }) => [
            styles.button,
            isSubmittingProvider === "apple" && styles.buttonDisabled,
            pressed && styles.buttonPressed,
          ]}
          onPress={() => void handleOAuthSignIn("apple")}
          disabled={isSubmittingProvider !== null}
        >
          {isSubmittingProvider === "apple" ? (
            <ActivityIndicator color="#111111" />
          ) : (
            <Text style={styles.buttonText}>Continue with Apple</Text>
          )}
        </Pressable>

        {errorText ? <Text style={styles.errorText}>{errorText}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#F5F7FB",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 20,
  },
  card: {
    width: "100%",
    maxWidth: 420,
    borderRadius: 16,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#DFE6F1",
    paddingHorizontal: 18,
    paddingVertical: 20,
    gap: 12,
  },
  title: {
    fontSize: 24,
    lineHeight: 30,
    fontWeight: "800",
    color: "#121A28",
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 20,
    color: "#4E5C74",
    marginBottom: 6,
  },
  button: {
    height: 48,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#D2DBE8",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FFFFFF",
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    fontSize: 15,
    fontWeight: "700",
    color: "#1A1A1A",
  },
  errorText: {
    marginTop: 4,
    fontSize: 13,
    lineHeight: 18,
    color: "#A62828",
  },
});
