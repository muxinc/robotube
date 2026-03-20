import { useEffect, useState } from "react";
import {
  Alert,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import {
  createUploadTask,
  FileSystemUploadType,
} from "expo-file-system/legacy";
import { useVideoPlayer, VideoView } from "expo-video";
import { useAction, useQuery } from "convex/react";

import { AUDIO_TRANSLATION_LANGUAGE_OPTIONS } from "@/constants/audio-translation-languages";
import { api } from "@/convex/_generated/api";
import { TabPageLogo } from "@/components/tab-page-logo";
import { TabPageScrollLayout } from "@/components/tab-page-scroll-layout";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { UploadLoadingIndicator } from "@/components/upload-loading-indicator";

function SelectedVideoThumbnail({
  uri,
  sourceLabel,
  onClear,
  disabled,
}: {
  uri: string;
  sourceLabel: string;
  onClear: () => void;
  disabled?: boolean;
}) {
  const player = useVideoPlayer({ uri }, (videoPlayer) => {
    videoPlayer.loop = false;
    videoPlayer.muted = true;
    videoPlayer.pause();
  });

  return (
    <View style={styles.selectedVideoCard}>
      <View style={styles.selectedVideoFrame}>
        <VideoView
          player={player}
          allowsVideoFrameAnalysis={false}
          contentFit="cover"
          nativeControls={false}
          style={styles.selectedVideoThumbnail}
        />
        <Pressable
          onPress={onClear}
          disabled={disabled}
          style={({ pressed }) => [
            styles.clearSelectedVideoButton,
            pressed && !disabled ? styles.clearSelectedVideoButtonPressed : undefined,
            disabled ? styles.clearSelectedVideoButtonDisabled : undefined,
          ]}
        >
          <Ionicons name="close" size={16} color="#FFFFFF" />
        </Pressable>
      </View>
      <ThemedText style={styles.selectedVideoLabel}>{sourceLabel}</ThemedText>
    </View>
  );
}

export default function HomeScreen() {
  const createMuxDirectUpload = useAction(
    (api as any).uploads.createMuxDirectUpload,
  );
  const [isUploading, setIsUploading] = useState(false);
  const [status, setStatus] = useState("Add a title, record or pick a video, then upload.");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [lastUploadId, setLastUploadId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [selectedVideo, setSelectedVideo] = useState<{
    uri: string;
    mimeType: string | null;
    source: "library" | "camera";
  } | null>(null);
  const [selectedAudioTranslationLanguageCodes, setSelectedAudioTranslationLanguageCodes] =
    useState<string[]>([]);
  const [lastRequestedAudioTranslationLanguageCodes, setLastRequestedAudioTranslationLanguageCodes] =
    useState<string[]>([]);
  const moderationStatus = useQuery(
    (api as any).uploadStatus.getUploadModerationStatus,
    lastUploadId
      ? {
          uploadId: lastUploadId,
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

  const handleSelectedAsset = ({
    uri,
    mimeType,
    source,
  }: {
    uri: string;
    mimeType: string | null;
    source: "library" | "camera";
  }) => {
    if (!uri.startsWith("file://")) {
      throw new Error(
        "Selected video is not accessible as a local file. Please try another video.",
      );
    }

    setSelectedVideo({
      uri,
      mimeType,
      source,
    });
    setStatus(
      source === "camera"
        ? "Recorded video ready to upload."
        : "Video selected. Ready to upload.",
    );
    setUploadProgress(0);
  };

  const handlePickVideo = async () => {
    try {
      const permission =
        await ImagePicker.requestMediaLibraryPermissionsAsync();
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
        shouldDownloadFromNetwork: true,
        preferredAssetRepresentationMode:
          ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
      });

      if (picked.canceled || picked.assets.length === 0) {
        if (!selectedVideo) {
          setStatus("No video selected.");
        }
        return;
      }

      const asset = picked.assets[0];
      handleSelectedAsset({
        uri: asset.uri,
        mimeType: asset.mimeType ?? null,
        source: "library",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not select video";
      const isICloudDownloadError =
        message.includes("PHPhotosErrorDomain") && message.includes("3164");
      const displayMessage = isICloudDownloadError
        ? "That video is in iCloud and could not be downloaded right now. Please open it in Photos first or try again on a stronger network."
        : message;

      setStatus(`Selection failed: ${displayMessage}`);
      Alert.alert("Video Selection Failed", displayMessage);
    }
  };

  const handleRecordVideo = async () => {
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        setStatus("Camera permission is required.");
        Alert.alert(
          "Permission Required",
          "Enable Camera access to record and upload a video.",
        );
        return;
      }

      const recorded = await ImagePicker.launchCameraAsync({
        mediaTypes: ["videos"],
        allowsEditing: false,
        quality: 1,
        videoQuality: ImagePicker.UIImagePickerControllerQualityType.High,
        cameraType: ImagePicker.CameraType.back,
      });

      if (recorded.canceled || recorded.assets.length === 0) {
        if (!selectedVideo) {
          setStatus("Recording canceled.");
        }
        return;
      }

      const asset = recorded.assets[0];
      handleSelectedAsset({
        uri: asset.uri,
        mimeType: asset.mimeType ?? null,
        source: "camera",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not record video";
      setStatus(`Recording failed: ${message}`);
      Alert.alert("Video Recording Failed", message);
    }
  };

  const handleUpload = async () => {
    if (!title.trim()) {
      setStatus("A title is required before upload.");
      Alert.alert("Title Required", "Please add a title before uploading.");
      return;
    }

    if (!selectedVideo) {
      setStatus("Record or pick a video before uploading.");
      Alert.alert("Video Required", "Please record or pick a video before uploading.");
      return;
    }

    try {
      const requestedLanguageCodes = [...selectedAudioTranslationLanguageCodes];
      setIsUploading(true);
      setLastRequestedAudioTranslationLanguageCodes(requestedLanguageCodes);
      setUploadProgress(12);
      setStatus("Creating Mux upload URL...");
      const { uploadId, uploadUrl } = await createMuxDirectUpload({
        title: title.trim() || undefined,
        audioTranslationLanguageCodes: requestedLanguageCodes,
      });

      setUploadProgress(32);
      setStatus("Uploading video to Mux...");
      const uploadTask = createUploadTask(
        uploadUrl,
        selectedVideo.uri,
        {
          httpMethod: "PUT",
          uploadType: FileSystemUploadType.BINARY_CONTENT,
          headers: {
            "Content-Type": selectedVideo.mimeType || "application/octet-stream",
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
      setStatus(
        requestedLanguageCodes.length > 0
          ? "Upload complete. Checking moderation and queueing translated audio and subtitle tracks..."
          : "Upload complete. Checking moderation status...",
      );
      setSelectedVideo(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Upload failed";
      setUploadProgress(0);
      setStatus(`Upload failed: ${message}`);
      Alert.alert("Upload Failed", message);
    } finally {
      setIsUploading(false);
    }
  };

  const toggleAudioTranslationLanguage = (languageCode: string) => {
    setSelectedAudioTranslationLanguageCodes((current) =>
      current.includes(languageCode)
        ? current.filter((code) => code !== languageCode)
        : [...current, languageCode],
    );
  };

  return (
    <ThemedView style={styles.screen}>
      <TabPageScrollLayout
        containerStyle={styles.container}
      >
        <TabPageLogo
          source={require("../../assets/images/upload-logo.png")}
          width={276}
          height={102}
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

        <ThemedView style={styles.inputWrap}>
          <ThemedText type="defaultSemiBold">Translated audio tracks</ThemedText>
          <ThemedText style={styles.supportingText}>
            Select the languages Robotube should prepare after Mux finishes processing the upload.
            Matching translated subtitle tracks will be added to the player too.
          </ThemedText>
          <View style={styles.translationOptions}>
            {AUDIO_TRANSLATION_LANGUAGE_OPTIONS.map((language) => {
              const isSelected = selectedAudioTranslationLanguageCodes.includes(language.code);

              return (
                <Pressable
                  key={language.code}
                  disabled={isUploading}
                  onPress={() => toggleAudioTranslationLanguage(language.code)}
                  style={({ pressed }) => [
                    styles.translationOption,
                    isSelected ? styles.translationOptionActive : undefined,
                    pressed && !isUploading ? styles.buttonPressed : undefined,
                    isUploading ? styles.buttonDisabled : undefined,
                  ]}
                >
                  <Ionicons
                    name={isSelected ? "checkmark-circle" : "ellipse-outline"}
                    size={16}
                    color={isSelected ? "#FFFFFF" : "#CC4C99"}
                  />
                  <ThemedText
                    style={[
                      styles.translationOptionText,
                      isSelected ? styles.translationOptionTextActive : undefined,
                    ]}
                  >
                    {language.label}
                  </ThemedText>
                </Pressable>
              );
            })}
          </View>
          <ThemedText style={styles.supportingText}>
            Leave this empty to upload without translated audio tracks.
          </ThemedText>
        </ThemedView>

        <View style={styles.mediaActions}>
          <Pressable
            disabled={isUploading}
            onPress={handleRecordVideo}
            style={({ pressed }) => [
              styles.mediaActionButton,
              pressed && !isUploading ? styles.buttonPressed : undefined,
              isUploading ? styles.buttonDisabled : undefined,
            ]}
          >
            <Ionicons name="videocam" size={18} color="#CC4C99" />
            <ThemedText type="defaultSemiBold">Record video</ThemedText>
          </Pressable>

          <Pressable
            disabled={isUploading}
            onPress={handlePickVideo}
            style={({ pressed }) => [
              styles.mediaActionButton,
              pressed && !isUploading ? styles.buttonPressed : undefined,
              isUploading ? styles.buttonDisabled : undefined,
            ]}
          >
            <Ionicons name="images" size={18} color="#CC4C99" />
            <ThemedText type="defaultSemiBold">Pick from library</ThemedText>
          </Pressable>
        </View>

        <Pressable
          disabled={isUploading || !selectedVideo || !title.trim()}
          onPress={handleUpload}
          style={({ pressed }) => [
            styles.button,
            pressed && !isUploading && selectedVideo && title.trim()
              ? styles.buttonPressed
              : undefined,
            isUploading || !selectedVideo || !title.trim()
              ? styles.buttonDisabled
              : undefined,
          ]}
        >
          <ThemedText type="defaultSemiBold">
            {isUploading ? "Uploading..." : "Upload video"}
          </ThemedText>
        </Pressable>

        {selectedVideo ? (
          <SelectedVideoThumbnail
            uri={selectedVideo.uri}
            sourceLabel={
              selectedVideo.source === "camera"
                ? "Recorded video ready"
                : "Library video ready"
            }
            disabled={isUploading}
            onClear={() => {
              setSelectedVideo(null);
              setUploadProgress(0);
              setStatus("Video selection cleared.");
            }}
          />
        ) : null}

        <ThemedView style={styles.statusCard}>
          <ThemedText type="defaultSemiBold">Status</ThemedText>
          {uploadComplete ? (
            <View style={styles.doneBadge}>
              <Image
                source={require("../../assets/images/app-icon.png")}
                contentFit="contain"
                style={styles.doneBadgeIcon}
              />
              <ThemedText style={styles.doneBadgeText}>
                Upload complete{moderationPending ? " - moderation in progress" : ""}
              </ThemedText>
            </View>
          ) : null}
          {lastRequestedAudioTranslationLanguageCodes.length > 0 ? (
            <ThemedText style={styles.supportingText}>
              Requested translated audio:{" "}
              {lastRequestedAudioTranslationLanguageCodes
                .map((code) =>
                  AUDIO_TRANSLATION_LANGUAGE_OPTIONS.find((language) => language.code === code)?.label ??
                  code,
                )
                .join(", ")}
            </ThemedText>
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
        </ThemedView>
      </TabPageScrollLayout>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  container: {
    gap: 14,
  },
  mediaActions: {
    gap: 10,
  },
  supportingText: {
    fontSize: 13,
    lineHeight: 18,
    color: "#5E6C82",
  },
  translationOptions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  translationOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#FFC3E8",
    backgroundColor: "#FFF4FB",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  translationOptionActive: {
    backgroundColor: "#FF8FD7",
    borderColor: "#FF8FD7",
  },
  translationOptionText: {
    fontSize: 13,
    lineHeight: 16,
    color: "#CC4C99",
    fontWeight: "600",
  },
  translationOptionTextActive: {
    color: "#FFFFFF",
  },
  mediaActionButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#FFC3E8",
    backgroundColor: "#FFF4FB",
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  button: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#FF8FD7",
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
    backgroundColor: "#FFF0F9",
    borderWidth: 1,
    borderColor: "#FFC3E8",
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
    color: "#CC4C99",
  },
  selectedVideoCard: {
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#D5DDE8",
    backgroundColor: "#FFF7FC",
  },
  selectedVideoFrame: {
    position: "relative",
  },
  selectedVideoThumbnail: {
    width: "100%",
    aspectRatio: 16 / 9,
    backgroundColor: "#111",
  },
  clearSelectedVideoButton: {
    position: "absolute",
    top: 10,
    right: 10,
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#000000A8",
  },
  clearSelectedVideoButtonPressed: {
    opacity: 0.8,
  },
  clearSelectedVideoButtonDisabled: {
    opacity: 0.5,
  },
  selectedVideoLabel: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 13,
    color: "#B24A88",
  },
  inputWrap: {
    gap: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: "#D5DDE8",
    borderRadius: 999,
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 14,
    height: 46,
    fontSize: 15,
  },
});
