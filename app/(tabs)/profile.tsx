import { Ionicons } from "@expo/vector-icons";
import { useAuthActions } from "@convex-dev/auth/react";
import { useMutation, useQuery } from "convex/react";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useState } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import {
  FeedVideoCard,
  type FeedVideoItem,
} from "@/components/feed-video-card";
import { TabPageScrollLayout } from "@/components/tab-page-scroll-layout";
import { api } from "@/convex/_generated/api";

WebBrowser.maybeCompleteAuthSession();

function getAvatarFallbackLabel(user: {
  username?: string;
  name?: string;
  email?: string;
}) {
  const source = user.name?.trim() || user.username?.trim() || user.email?.trim() || "Robotube";
  return source.charAt(0).toUpperCase() || "R";
}

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
  const [avatarMessage, setAvatarMessage] = useState<string | null>(null);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const updateUsername = useMutation((api as any).users.updateUsername);
  const generateAvatarUploadUrl = useMutation(
    (api as any).users.generateAvatarUploadUrl,
  );
  const updateProfileImage = useMutation((api as any).users.updateProfileImage);
  const currentUser = useQuery((api as any).users.currentUser) as
    | {
        username?: string;
        name?: string;
        email?: string;
        avatarUrl?: string | null;
      }
    | null
    | undefined;
  const uploadedVideos = useQuery((api as any).feed.listCurrentUserUploadedVideos, {
    limit: 12,
  }) as FeedVideoItem[] | undefined;

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

      router.replace("/profile");
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

  const handleOpenProfileMenu = () => {
    if (isSigningOut || isSubmittingProvider) return;

    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ["Cancel", "Sign out"],
          cancelButtonIndex: 0,
          destructiveButtonIndex: 1,
        },
        (buttonIndex) => {
          if (buttonIndex === 1) {
            void handleSignOut();
          }
        },
      );
      return;
    }

    Alert.alert("Profile", "Choose an action", [
      {
        text: "Cancel",
        style: "cancel",
      },
      {
        text: "Sign out",
        style: "destructive",
        onPress: () => {
          void handleSignOut();
        },
      },
    ]);
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

  const handleChangeAvatar = async () => {
    if (!currentUser || isUploadingAvatar) return;

    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setAvatarMessage("Photo library permission is required.");
        Alert.alert(
          "Permission Required",
          "Enable Photos access to choose a profile picture.",
        );
        return;
      }

      const picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.9,
      });

      if (picked.canceled || picked.assets.length === 0) {
        return;
      }

      const asset = picked.assets[0];
      setIsUploadingAvatar(true);
      setAvatarMessage(null);
      setErrorText(null);

      const { uploadUrl } = (await generateAvatarUploadUrl({})) as {
        uploadUrl: string;
      };
      const localImageResponse = await fetch(asset.uri);
      const imageBlob = await localImageResponse.blob();
      const uploadResponse = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          "Content-Type": asset.mimeType ?? imageBlob.type ?? "image/jpeg",
        },
        body: imageBlob,
      });

      if (!uploadResponse.ok) {
        throw new Error("Could not upload your new profile picture.");
      }

      const uploadResult = (await uploadResponse.json()) as {
        storageId?: string;
      };
      if (!uploadResult.storageId) {
        throw new Error("Profile picture upload did not return a storage ID.");
      }

      await updateProfileImage({
        storageId: uploadResult.storageId,
      });
      setAvatarMessage("Profile photo updated.");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not update your profile picture right now.";
      setAvatarMessage(message);
    } finally {
      setIsUploadingAvatar(false);
    }
  };

  if (currentUser === undefined) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#111111" />
      </View>
    );
  }

  if (!currentUser) {
    return (
      <View style={styles.authContainer}>
        <Text style={styles.title}>Welcome to Robotube</Text>
        <Text style={styles.authMetaText}>
          Sign in to upload, search, and manage your profile.
        </Text>

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

  const displayName =
    currentUser.name?.trim() ||
    (currentUser.username ? `@${currentUser.username}` : null) ||
    currentUser.email ||
    "Signed in user";

  return (
    <View style={styles.screen}>
      <TabPageScrollLayout
        includeTopInset
        contentInsetAdjustmentBehavior="never"
        topPaddingOffset={20}
        contentContainerStyle={styles.scrollContent}
        containerStyle={styles.contentContainer}
      >
        <View style={styles.topBar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open profile menu"
            style={({ pressed }) => [
              styles.menuButton,
              pressed && styles.signOutPressed,
              isSigningOut && styles.signOutDisabled,
            ]}
            onPress={handleOpenProfileMenu}
            disabled={isSigningOut}
          >
            <Ionicons name="ellipsis-horizontal" size={22} color="#1B2434" />
          </Pressable>
        </View>

        <View style={styles.heroCard}>
          <Pressable
            style={({ pressed }) => [
              styles.avatarButton,
              pressed && styles.signOutPressed,
              isUploadingAvatar && styles.signOutDisabled,
            ]}
            onPress={() => {
              void handleChangeAvatar();
            }}
            disabled={isUploadingAvatar}
          >
            {currentUser.avatarUrl ? (
              <Image
                source={{ uri: currentUser.avatarUrl }}
                contentFit="cover"
                style={styles.avatarImage}
              />
            ) : (
              <View style={styles.avatarFallback}>
                <Text style={styles.avatarFallbackText}>
                  {getAvatarFallbackLabel(currentUser)}
                </Text>
              </View>
            )}
            <View style={styles.avatarBadge}>
              <Ionicons name="camera" size={16} color="#FFFFFF" />
            </View>
          </Pressable>

          <View style={styles.heroCopy}>
            <Text style={styles.nameText}>{displayName}</Text>
            <Text style={styles.metaText}>{currentUser.email ?? "No email available"}</Text>
            {avatarMessage ? <Text style={styles.handleMessage}>{avatarMessage}</Text> : null}
          </View>
        </View>

        <View style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>Public handle</Text>
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
              styles.secondaryButton,
              pressed && styles.signOutPressed,
              isSavingHandle && styles.signOutDisabled,
            ]}
            onPress={() => {
              void handleSaveHandle();
            }}
            disabled={isSavingHandle}
          >
            <Text style={styles.secondaryButtonText}>
              {isSavingHandle ? "Saving..." : "Save handle"}
            </Text>
          </Pressable>
          {handleMessage ? <Text style={styles.handleMessage}>{handleMessage}</Text> : null}
        </View>

        <View style={styles.uploadsHeader}>
          <View>
            <Text style={styles.sectionTitle}>Your uploads</Text>
          </View>
          <Text style={styles.uploadCountLabel}>
            {uploadedVideos?.length ?? 0} {uploadedVideos?.length === 1 ? "video" : "videos"}
          </Text>
        </View>

        {uploadedVideos === undefined ? (
          <View style={styles.emptyCard}>
            <ActivityIndicator size="small" color="#111111" />
            <Text style={styles.emptyText}>Loading your uploads...</Text>
          </View>
        ) : uploadedVideos.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>No uploads yet</Text>
            <Text style={styles.emptyText}>
              Videos you upload from this account will show up here.
            </Text>
          </View>
        ) : (
          <View style={styles.uploadsList}>
            {uploadedVideos.map((item) => (
              <FeedVideoCard key={item.muxAssetId} item={item} showPlayIcon={false} />
            ))}
          </View>
        )}

        {errorText ? <Text style={styles.errorText}>{errorText}</Text> : null}
      </TabPageScrollLayout>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#FFFFFF",
  },
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FFFFFF",
  },
  authContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 20,
    backgroundColor: "#FFFFFF",
  },
  scrollContent: {
    paddingBottom: 130,
  },
  contentContainer: {
    gap: 18,
  },
  topBar: {
    width: "100%",
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  menuButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1,
    borderColor: "#D4DBE6",
    backgroundColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
  },
  heroCard: {
    borderRadius: 24,
    backgroundColor: "#F6F8FC",
    padding: 20,
    gap: 18,
    alignItems: "center",
  },
  avatarButton: {
    width: 96,
    height: 96,
    borderRadius: 48,
    position: "relative",
  },
  avatarImage: {
    width: "100%",
    height: "100%",
    borderRadius: 48,
  },
  avatarFallback: {
    width: "100%",
    height: "100%",
    borderRadius: 48,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FF4FA7",
  },
  avatarFallbackText: {
    fontSize: 34,
    fontWeight: "800",
    color: "#FFFFFF",
  },
  avatarBadge: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#111827",
    borderWidth: 2,
    borderColor: "#FFFFFF",
  },
  heroCopy: {
    gap: 4,
    alignItems: "center",
  },
  title: {
    fontSize: 24,
    fontWeight: "700",
    color: "#101828",
  },
  nameText: {
    fontSize: 18,
    fontWeight: "700",
    color: "#1B2434",
    textAlign: "center",
  },
  metaText: {
    fontSize: 14,
    color: "#4B5568",
    textAlign: "center",
  },
  authMetaText: {
    fontSize: 14,
    color: "#4B5568",
    textAlign: "center",
  },
  helperText: {
    marginTop: 4,
    fontSize: 13,
    color: "#667085",
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
  sectionCard: {
    gap: 10,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#E5EAF2",
    backgroundColor: "#FFFFFF",
    padding: 18,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#202630",
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
  secondaryButton: {
    alignSelf: "flex-start",
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#D4DBE6",
    paddingHorizontal: 14,
    paddingVertical: 9,
    backgroundColor: "#FFFFFF",
  },
  secondaryButtonText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#1B2434",
  },
  handleMessage: {
    fontSize: 12,
    color: "#5A687F",
  },
  uploadsHeader: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: 12,
  },
  sectionSubtitle: {
    marginTop: 2,
    fontSize: 13,
    color: "#667085",
  },
  uploadCountLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: "#5A687F",
  },
  uploadsList: {
    gap: 0,
  },
  emptyCard: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#E5EAF2",
    backgroundColor: "#FAFBFC",
    paddingHorizontal: 18,
    paddingVertical: 22,
    alignItems: "center",
    gap: 8,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#202630",
  },
  emptyText: {
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
    color: "#667085",
  },
  signOutPressed: {
    opacity: 0.85,
  },
  signOutDisabled: {
    opacity: 0.6,
  },
  errorText: {
    marginTop: 4,
    fontSize: 13,
    lineHeight: 18,
    color: "#A62828",
    textAlign: "center",
  },
});
