import { useEffect, useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { Image } from "expo-image";
import {
  createUploadTask,
  FileSystemUploadType,
} from "expo-file-system/legacy";
import { useAction, useQuery } from "convex/react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api } from "@/convex/_generated/api";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { UploadLoadingIndicator } from "@/components/upload-loading-indicator";

export default function HomeScreen() {
  const createMuxDirectUpload = useAction(
    (api as any).uploads.createMuxDirectUpload,
  );
  const insets = useSafeAreaInsets();
  const [isUploading, setIsUploading] = useState(false);
  const [status, setStatus] = useState("Pick a video to upload it to Mux.");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [lastUploadId, setLastUploadId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const moderationStatus = useQuery(
    (api as any).uploadStatus.getUploadModerationStatus,
    lastUploadId
      ? {
          uploadId: lastUploadId,
          userId: "mobile-user",
        }
      : "skip",
  ) as
    | {
        stage: string;
        done: boolean;
        passed: boolean | null;
        progress: number;
        statusText: string;
      }
    | undefined;

  const moderationPending =
    Boolean(lastUploadId) &&
    (moderationStatus === undefined || moderationStatus.done === false);
  const uploadComplete = Boolean(lastUploadId) && !isUploading;

  useEffect(() => {
    if (!lastUploadId || isUploading) return;

    if (moderationStatus === undefined) {
      setStatus("Checking moderation status...");
      setUploadProgress((current) => Math.max(current, 96));
      return;
    }

    setStatus(moderationStatus.statusText);
    setUploadProgress(moderationStatus.progress);
  }, [isUploading, lastUploadId, moderationStatus]);

  const handleUpload = async () => {
    try {
      setUploadProgress(2);
      setStatus("Pick a video from your Photos library.");

      const permission =
        await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setUploadProgress(0);
        setStatus("Photo library permission is required.");
        Alert.alert(
          "Permission Required",
          "Enable Photos access to select and upload a video.",
        );
        return;
      }

      const picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["videos"],
        allowsEditing: false,
        quality: 1,
      });

      if (picked.canceled || picked.assets.length === 0) {
        setUploadProgress(0);
        setStatus("No video selected.");
        return;
      }

      const asset = picked.assets[0];
      if (!asset.uri.startsWith("file://")) {
        throw new Error(
          "Selected video is not accessible as a local file. Please try another video.",
        );
      }

      setIsUploading(true);
      setUploadProgress(20);
      setStatus("Creating Mux upload URL...");
      const { uploadId, uploadUrl } = await createMuxDirectUpload({
        userId: "mobile-user",
        title: title.trim() || undefined,
      });

      setUploadProgress(32);
      setStatus("Uploading video to Mux...");
      const uploadTask = createUploadTask(
        uploadUrl,
        asset.uri,
        {
          httpMethod: "PUT",
          uploadType: FileSystemUploadType.BINARY_CONTENT,
          headers: {
            "Content-Type": asset.mimeType || "application/octet-stream",
          },
        },
        (event) => {
          if (event.totalBytesExpectedToSend <= 0) {
            return;
          }
          const fraction =
            event.totalBytesSent / event.totalBytesExpectedToSend;
          const uploadPercent = Math.round(
            Math.min(1, Math.max(0, fraction)) * 65,
          );
          setUploadProgress(32 + uploadPercent);
        },
      );

      const uploadResponse = await uploadTask.uploadAsync();
      if (!uploadResponse) {
        throw new Error("Upload task was interrupted.");
      }

      setUploadProgress(95);
      if (uploadResponse.status < 200 || uploadResponse.status >= 300) {
        throw new Error(
          `Mux upload failed (${uploadResponse.status}): ${uploadResponse.body}`,
        );
      }

      setUploadProgress(100);
      setLastUploadId(uploadId);
      setStatus("Upload complete. Checking moderation status...");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Upload failed";
      setUploadProgress(0);
      setStatus(`Upload failed: ${message}`);
      Alert.alert("Upload Failed", message);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <ThemedView style={styles.screen}>
      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          {
            paddingTop: insets.top + 10,
            paddingBottom: insets.bottom + 110,
          },
        ]}
      >
        <ThemedView style={styles.container}>
          <Image
            source={require("../../assets/images/upload-logo.png")}
            contentFit="contain"
            style={styles.uploadLogo}
          />

          <ThemedView style={styles.inputWrap}>
            <ThemedText type="defaultSemiBold">Title</ThemedText>
            <TextInput
              value={title}
              onChangeText={setTitle}
              placeholder="Give your video a title"
              autoCapitalize="sentences"
              maxLength={120}
              style={styles.input}
            />
          </ThemedView>

          <Pressable
            disabled={isUploading}
            onPress={handleUpload}
            style={({ pressed }) => [
              styles.button,
              pressed && !isUploading ? styles.buttonPressed : undefined,
              isUploading ? styles.buttonDisabled : undefined,
            ]}
          >
            <ThemedText type="defaultSemiBold">
              {isUploading ? "Uploading..." : "Select a video and upload"}
            </ThemedText>
          </Pressable>

          <ThemedView style={styles.statusCard}>
            <ThemedText type="defaultSemiBold">Status</ThemedText>
            {uploadComplete ? (
              <View style={styles.doneBadge}>
                <Image
                  source={require("../../assets/images/robo-kirbutt.png")}
                  contentFit="contain"
                  style={styles.doneBadgeIcon}
                />
                <ThemedText style={styles.doneBadgeText}>
                  Upload complete{moderationPending ? " - moderation in progress" : ""}
                </ThemedText>
              </View>
            ) : null}
            {isUploading || moderationPending ? (
              <UploadLoadingIndicator
                isActive={isUploading || moderationPending}
                status={status}
                progress={uploadProgress}
              />
            ) : (
              <ThemedText>{status}</ThemedText>
            )}
            {lastUploadId ? (
              <ThemedText>Last upload ID: {lastUploadId}</ThemedText>
            ) : null}
          </ThemedView>
        </ThemedView>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 20,
  },
  container: {
    gap: 14,
    width: "100%",
    maxWidth: 760,
    alignSelf: "center",
  },
  uploadLogo: {
    width: 240,
    height: 88,
    alignSelf: "center",
  },
  button: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#4AA8FF",
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: "center",
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  statusCard: {
    marginTop: 8,
    gap: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#D5DDE8",
    padding: 12,
  },
  doneBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 999,
    alignSelf: "flex-start",
    backgroundColor: "#EEF8FF",
    borderWidth: 1,
    borderColor: "#B8DCFF",
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 2,
  },
  doneBadgeIcon: {
    width: 22,
    height: 22,
  },
  doneBadgeText: {
    fontSize: 12,
    lineHeight: 16,
    color: "#1E4F89",
  },
  inputWrap: {
    gap: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: "#D5DDE8",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
});
