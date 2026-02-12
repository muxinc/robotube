import { useState } from "react";
import { Alert, Pressable, StyleSheet } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { FileSystemUploadType, uploadAsync } from "expo-file-system/legacy";
import { useAction } from "convex/react";

import { api } from "@/convex/_generated/api";
import ParallaxScrollView from "@/components/parallax-scroll-view";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";

export default function HomeScreen() {
  const createMuxDirectUpload = useAction(api.migrations.createMuxDirectUpload);
  const [isUploading, setIsUploading] = useState(false);
  const [status, setStatus] = useState("Pick a video to upload it to Mux.");
  const [lastUploadId, setLastUploadId] = useState<string | null>(null);

  const handleUpload = async () => {
    try {
      setIsUploading(true);
      setStatus("Pick a video from your Photos library.");

      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
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
        setStatus("No video selected.");
        return;
      }

      const asset = picked.assets[0];
      if (!asset.uri.startsWith("file://")) {
        throw new Error(
          "Selected video is not accessible as a local file. Please try another video.",
        );
      }

      setStatus("Creating Mux upload URL...");
      const { uploadId, uploadUrl } = await createMuxDirectUpload({
        userId: "mobile-user",
      });

      setStatus("Uploading video to Mux...");
      const uploadResponse = await uploadAsync(uploadUrl, asset.uri, {
        httpMethod: "PUT",
        uploadType: FileSystemUploadType.BINARY_CONTENT,
        headers: {
          "Content-Type": asset.mimeType || "application/octet-stream",
        },
      });

      if (uploadResponse.status < 200 || uploadResponse.status >= 300) {
        throw new Error(
          `Mux upload failed (${uploadResponse.status}): ${uploadResponse.body}`,
        );
      }

      setLastUploadId(uploadId);
      setStatus(
        "Upload complete. Mux processing started. Convex will sync updates.",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Upload failed";
      setStatus(`Upload failed: ${message}`);
      Alert.alert("Upload Failed", message);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <ParallaxScrollView
      headerBackgroundColor={{ light: "#F0F7FF", dark: "#123347" }}
      headerImage={<ThemedView />}
    >
      <ThemedView style={styles.container}>
        <ThemedText type="title">Upload To Mux</ThemedText>
        <ThemedText>
          Choose a video and upload directly to Mux. Your Convex tables are
          updated by the Mux sync component.
        </ThemedText>

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
            {isUploading ? "Uploading..." : "Select From Photos And Upload"}
          </ThemedText>
        </Pressable>

        <ThemedView style={styles.statusCard}>
          <ThemedText type="defaultSemiBold">Status</ThemedText>
          <ThemedText>{status}</ThemedText>
          {lastUploadId ? (
            <ThemedText>Last upload ID: {lastUploadId}</ThemedText>
          ) : null}
        </ThemedView>
      </ThemedView>
    </ParallaxScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 14,
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
});
