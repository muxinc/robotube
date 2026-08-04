import { Ionicons } from "@expo/vector-icons";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  createUploadTask,
  FileSystemUploadType,
} from "expo-file-system/legacy";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useVideoPlayer, VideoView } from "expo-video";
import { useEffect, useState } from "react";
import {
  Alert,
  InputAccessoryView,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";

import { TabPageLogoHeader } from "@/components/tab-page-logo-header";
import { TabPageScrollLayout } from "@/components/tab-page-scroll-layout";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { UploadLoadingIndicator } from "@/components/upload-loading-indicator";
import {
  AUDIO_TRANSLATION_LANGUAGE_OPTIONS,
  getAudioTranslationLanguageLabel,
} from "@/constants/audio-translation-languages";
import { api } from "@/convex/_generated/api";

type UploadStep =
  | "media"
  | "robots"
  | "review"
  | "status";

const UPLOAD_STEPS: Exclude<UploadStep, "status">[] = [
  "media",
  "robots",
  "review",
];

const UPLOAD_STEP_TITLES: Record<UploadStep, string> = {
  media: "Choose a video",
  robots: "Robot jobs",
  review: "Review upload",
  status: "Robot draft",
};

const ROBOT_DRAFT_INPUT_ACCESSORY_ID = "robot-draft-input-accessory";

function UploadStepHeader({
  step,
  onBack,
  title,
}: {
  step: UploadStep;
  onBack?: () => void;
  title?: string;
}) {
  const stepIndex = UPLOAD_STEPS.indexOf(
    step as Exclude<UploadStep, "status">,
  );

  return (
    <View style={styles.stepHeaderWrap}>
      <View style={styles.stepTitleRow}>
        {onBack ? (
          <Pressable
            accessibilityLabel="Go to previous upload step"
            hitSlop={10}
            onPress={onBack}
            style={({ pressed }) => [
              styles.backButton,
              pressed ? styles.buttonPressed : undefined,
            ]}
          >
            <Ionicons name="chevron-back" size={27} color="#11181C" />
          </Pressable>
        ) : (
          <View style={styles.backButtonSpacer} />
        )}
        <ThemedText style={styles.stepTitle} type="title">
          {title ?? UPLOAD_STEP_TITLES[step]}
        </ThemedText>
        {stepIndex >= 0 ? (
          <ThemedText style={styles.stepCount}>
            {stepIndex + 1} of {UPLOAD_STEPS.length}
          </ThemedText>
        ) : (
          <View style={styles.stepCountSpacer} />
        )}
      </View>

      {stepIndex >= 0 ? (
        <View
          accessibilityLabel={`Upload step ${stepIndex + 1} of ${UPLOAD_STEPS.length}`}
          accessibilityRole="progressbar"
          style={styles.stepProgress}
        >
          {UPLOAD_STEPS.map((uploadStep, index) => (
            <View
              key={uploadStep}
              style={[
                styles.stepProgressSegment,
                index <= stepIndex
                  ? styles.stepProgressSegmentActive
                  : undefined,
              ]}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function PrimaryButton({
  label,
  onPress,
  disabled,
  icon,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  icon?: keyof typeof Ionicons.glyphMap;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.primaryButton,
        pressed && !disabled ? styles.buttonPressed : undefined,
        disabled ? styles.primaryButtonDisabled : undefined,
      ]}
    >
      {icon ? <Ionicons name={icon} size={19} color="#FFFFFF" /> : null}
      <ThemedText style={styles.primaryButtonText} type="defaultSemiBold">
        {label}
      </ThemedText>
    </Pressable>
  );
}

function ReviewRow({
  icon,
  label,
  value,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.reviewRow,
        pressed ? styles.reviewRowPressed : undefined,
      ]}
    >
      <View style={styles.reviewRowIcon}>
        <Ionicons name={icon} size={21} color="#CC4C99" />
      </View>
      <View style={styles.reviewRowCopy}>
        <ThemedText style={styles.reviewRowLabel}>{label}</ThemedText>
        <ThemedText numberOfLines={2} style={styles.reviewRowValue}>
          {value}
        </ThemedText>
      </View>
      <Ionicons name="chevron-forward" size={21} color="#7A8494" />
    </Pressable>
  );
}

function SelectedVideoThumbnail({
  uri,
  sourceLabel,
  onClear,
  disabled,
  showClear = true,
}: {
  uri: string;
  sourceLabel: string;
  onClear: () => void;
  disabled?: boolean;
  showClear?: boolean;
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
        {showClear ? (
          <Pressable
            accessibilityLabel="Remove selected video"
            onPress={onClear}
            disabled={disabled}
            style={({ pressed }) => [
              styles.clearSelectedVideoButton,
              pressed && !disabled
                ? styles.clearSelectedVideoButtonPressed
                : undefined,
              disabled ? styles.clearSelectedVideoButtonDisabled : undefined,
            ]}
          >
            <Ionicons name="close" size={16} color="#FFFFFF" />
          </Pressable>
        ) : null}
      </View>
      <ThemedText style={styles.selectedVideoLabel}>{sourceLabel}</ThemedText>
    </View>
  );
}

function TranslationLanguagePills({
  selectedCodes,
  onToggle,
  disabled,
}: {
  selectedCodes: string[];
  onToggle: (code: string) => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.translationOptions}>
      {AUDIO_TRANSLATION_LANGUAGE_OPTIONS.map((language) => {
        const isSelected = selectedCodes.includes(language.code);

        return (
          <Pressable
            key={language.code}
            disabled={disabled}
            onPress={() => onToggle(language.code)}
            style={({ pressed }) => [
              styles.translationOption,
              isSelected ? styles.translationOptionActive : undefined,
              pressed && !disabled ? styles.buttonPressed : undefined,
              disabled ? styles.buttonDisabled : undefined,
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
  );
}

type PipelineJob = {
  key: string;
  label: string;
  status: "waiting" | "processing" | "completed" | "errored" | "skipped";
};

export default function HomeScreen() {
  const createMuxDirectUpload = useAction(
    (api as any).uploads.createMuxDirectUpload,
  );
  const updateOwnVideoMetadata = useMutation(
    (api as any).videoMetadata.updateOwnVideoMetadata,
  );
  const regenerateOwnMetadataDraft = useAction(
    (api as any).aiMetadata.regenerateOwnMetadataDraft,
  );
  const [currentStep, setCurrentStep] = useState<UploadStep>("media");
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [status, setStatus] = useState("Choose a video to begin.");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [lastUploadId, setLastUploadId] = useState<string | null>(null);
  const [robotDraftTitle, setRobotDraftTitle] = useState("");
  const [robotDraftDescription, setRobotDraftDescription] = useState("");
  const [robotDraftTags, setRobotDraftTags] = useState<string[]>([]);
  const [newRobotDraftTag, setNewRobotDraftTag] = useState("");
  const [draftMuxAssetId, setDraftMuxAssetId] = useState<string | null>(null);
  const [isSavingMetadata, setIsSavingMetadata] = useState(false);
  const [isRegeneratingMetadata, setIsRegeneratingMetadata] = useState(false);
  const [isPublished, setIsPublished] = useState(false);
  const [draftGeneratedAtMs, setDraftGeneratedAtMs] = useState<number | null>(
    null,
  );
  const [metadataSaveStatus, setMetadataSaveStatus] = useState<string | null>(
    null,
  );
  const [selectedVideo, setSelectedVideo] = useState<{
    uri: string;
    mimeType: string | null;
    source: "library" | "camera";
  } | null>(null);
  const [
    selectedAudioTranslationLanguageCodes,
    setSelectedAudioTranslationLanguageCodes,
  ] = useState<string[]>([]);
  const [
    selectedCaptionTranslationLanguageCodes,
    setSelectedCaptionTranslationLanguageCodes,
  ] = useState<string[]>([]);
  const [
    lastRequestedAudioTranslationLanguageCodes,
    setLastRequestedAudioTranslationLanguageCodes,
  ] = useState<string[]>([]);
  const [
    lastRequestedCaptionTranslationLanguageCodes,
    setLastRequestedCaptionTranslationLanguageCodes,
  ] = useState<string[]>([]);
  const pipelineStatus = useQuery(
    (api as any).uploadStatus.getUploadPipelineStatus,
    lastUploadId
      ? {
          uploadId: lastUploadId,
          audioTranslationLanguageCodes:
            lastRequestedAudioTranslationLanguageCodes,
          captionTranslationLanguageCodes:
            lastRequestedCaptionTranslationLanguageCodes,
        }
      : "skip",
  ) as
    | {
        stage: string;
        done: boolean;
        passed: boolean | null;
        progress: number;
        statusText: string;
        jobs: PipelineJob[];
        muxAssetId?: string;
        generatedMetadata?: {
          summaryReady: boolean;
          generatedAtMs?: number;
          summaryStatus?: string;
          suggestedTitle?: string;
          suggestedDescription?: string;
          suggestedTags: string[];
          appliedTitle?: string;
          appliedDescription?: string;
        };
      }
    | undefined;

  const pipelinePending =
    Boolean(lastUploadId) &&
    (pipelineStatus === undefined || pipelineStatus.done === false);
  const uploadComplete = Boolean(lastUploadId) && !isUploading;
  const canUpload = Boolean(selectedVideo);
  const generatedMetadata = pipelineStatus?.generatedMetadata;
  const robotDraftReady =
    generatedMetadata?.summaryReady === true &&
    typeof pipelineStatus?.muxAssetId === "string";
  const audioTranslationSummary =
    selectedAudioTranslationLanguageCodes.length > 0
      ? selectedAudioTranslationLanguageCodes
          .map(getAudioTranslationLanguageLabel)
          .join(", ")
      : "Not requested";
  const captionTranslationSummary =
    selectedCaptionTranslationLanguageCodes.length > 0
      ? selectedCaptionTranslationLanguageCodes
          .map(getAudioTranslationLanguageLabel)
          .join(", ")
      : "Not requested";

  useEffect(() => {
    if (!lastUploadId || isUploading) return;

    if (pipelineStatus === undefined) {
      setStatus("Checking processing status...");
      return;
    }

    setStatus(pipelineStatus.statusText);
    setUploadProgress(pipelineStatus.progress);
  }, [isUploading, lastUploadId, pipelineStatus]);

  useEffect(() => {
    const muxAssetId = pipelineStatus?.muxAssetId;
    const generatedAtMs = generatedMetadata?.generatedAtMs;
    if (
      !robotDraftReady ||
      !muxAssetId ||
      typeof generatedAtMs !== "number" ||
      (draftMuxAssetId === muxAssetId && draftGeneratedAtMs === generatedAtMs)
    ) {
      return;
    }

    setRobotDraftTitle(
      generatedMetadata?.suggestedTitle ??
        generatedMetadata?.appliedTitle ??
        "",
    );
    setRobotDraftDescription(
      generatedMetadata?.suggestedDescription ??
        generatedMetadata?.appliedDescription ??
        "",
    );
    setRobotDraftTags(generatedMetadata?.suggestedTags ?? []);
    setNewRobotDraftTag("");
    setDraftMuxAssetId(muxAssetId);
    setDraftGeneratedAtMs(generatedAtMs);
    setIsRegeneratingMetadata(false);
    setMetadataSaveStatus(null);
    if (!isPublished) setCurrentStep("review");
  }, [
    draftMuxAssetId,
    draftGeneratedAtMs,
    generatedMetadata,
    isPublished,
    pipelineStatus?.muxAssetId,
    robotDraftReady,
  ]);

  useEffect(() => {
    if (
      isRegeneratingMetadata &&
      (generatedMetadata?.summaryStatus === "errored" ||
        generatedMetadata?.summaryStatus === "cancelled")
    ) {
      setIsRegeneratingMetadata(false);
      setMetadataSaveStatus("Mux Robots could not generate a new draft.");
    }
  }, [generatedMetadata?.summaryStatus, isRegeneratingMetadata]);

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
      const message =
        error instanceof Error ? error.message : "Could not select video";
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
      const message =
        error instanceof Error ? error.message : "Could not record video";
      setStatus(`Recording failed: ${message}`);
      Alert.alert("Video Recording Failed", message);
    }
  };

  const handleUpload = async () => {
    if (!selectedVideo) {
      setStatus("Record or pick a video before uploading.");
      Alert.alert(
        "Video Required",
        "Please record or pick a video before uploading.",
      );
      return;
    }

    try {
      const requestedAudioLanguageCodes = [
        ...selectedAudioTranslationLanguageCodes,
      ];
      const requestedCaptionLanguageCodes = [
        ...selectedCaptionTranslationLanguageCodes,
      ];
      setIsUploading(true);
      setUploadError(null);
      setCurrentStep("status");
      setLastRequestedAudioTranslationLanguageCodes(requestedAudioLanguageCodes);
      setLastRequestedCaptionTranslationLanguageCodes(
        requestedCaptionLanguageCodes,
      );
      setUploadProgress(12);
      setStatus("Creating a private Mux upload...");
      const { uploadId, uploadUrl } = await createMuxDirectUpload({
        useGeneratedTitle: true,
        useGeneratedDescription: true,
        audioTranslationLanguageCodes: requestedAudioLanguageCodes,
        captionTranslationLanguageCodes: requestedCaptionLanguageCodes,
      });

      setUploadProgress(32);
      setStatus("Uploading privately for Mux Robots...");
      const uploadTask = createUploadTask(
        uploadUrl,
        selectedVideo.uri,
        {
          httpMethod: "PUT",
          uploadType: FileSystemUploadType.BINARY_CONTENT,
          headers: {
            "Content-Type":
              selectedVideo.mimeType || "application/octet-stream",
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
      const requestedAudio = requestedAudioLanguageCodes.length > 0;
      const requestedCaptions = requestedCaptionLanguageCodes.length > 0;
      setStatus(
        requestedAudio && requestedCaptions
          ? "Private upload complete. Generating metadata and translated audio and captions..."
          : requestedAudio
            ? "Private upload complete. Generating metadata and translated audio..."
            : requestedCaptions
              ? "Private upload complete. Generating metadata and translated captions..."
              : "Private upload complete. Generating your Robot draft...",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Upload failed";
      setUploadError(message);
      setUploadProgress(0);
      setStatus(`Upload failed: ${message}`);
      Alert.alert("Could Not Create Draft", message);
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

  const toggleCaptionTranslationLanguage = (languageCode: string) => {
    setSelectedCaptionTranslationLanguageCodes((current) =>
      current.includes(languageCode)
        ? current.filter((code) => code !== languageCode)
        : [...current, languageCode],
    );
  };

  const addRobotDraftTag = () => {
    const tag = newRobotDraftTag.replace(/^#+/, "").trim().slice(0, 40);
    if (!tag) return;

    setRobotDraftTags((current) => {
      if (
        current.some(
          (currentTag) =>
            currentTag.toLocaleLowerCase() === tag.toLocaleLowerCase(),
        ) ||
        current.length >= 10
      ) {
        return current;
      }
      return [...current, tag];
    });
    setNewRobotDraftTag("");
    setMetadataSaveStatus(null);
  };

  const removeRobotDraftTag = (tagToRemove: string) => {
    setRobotDraftTags((current) =>
      current.filter((tag) => tag !== tagToRemove),
    );
    setMetadataSaveStatus(null);
  };

  const handleSaveRobotDraft = async () => {
    const muxAssetId = pipelineStatus?.muxAssetId;
    if (!muxAssetId) return;

    try {
      setIsSavingMetadata(true);
      setMetadataSaveStatus(null);
      const result = await updateOwnVideoMetadata({
        muxAssetId,
        title: robotDraftTitle,
        description: robotDraftDescription,
        tags: robotDraftTags,
      });
      setRobotDraftTitle(result.title);
      setRobotDraftDescription(result.description);
      setRobotDraftTags(result.tags);
      setMetadataSaveStatus("Changes saved");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not save changes";
      setMetadataSaveStatus(message);
      Alert.alert("Could Not Save Metadata", message);
    } finally {
      setIsSavingMetadata(false);
    }
  };

  const handleRegenerateRobotDraft = async () => {
    const muxAssetId = pipelineStatus?.muxAssetId;
    if (!muxAssetId || isRegeneratingMetadata) return;

    try {
      setIsRegeneratingMetadata(true);
      setMetadataSaveStatus("Mux Robots is generating a new draft...");
      await regenerateOwnMetadataDraft({ muxAssetId });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not regenerate metadata";
      setIsRegeneratingMetadata(false);
      setMetadataSaveStatus(message);
      Alert.alert("Could Not Regenerate Metadata", message);
    }
  };

  const handlePublishRobotDraft = async () => {
    const muxAssetId = pipelineStatus?.muxAssetId;
    if (!muxAssetId) return;

    try {
      setIsSavingMetadata(true);
      setMetadataSaveStatus(null);
      await updateOwnVideoMetadata({
        muxAssetId,
        title: robotDraftTitle,
        description: robotDraftDescription,
        tags: robotDraftTags,
        publish: true,
      });
      setIsPublished(true);
      setStatus("Your video is published. Remaining Robot jobs will continue in the background.");
      setCurrentStep("status");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not publish video";
      setMetadataSaveStatus(message);
      Alert.alert("Could Not Publish Video", message);
    } finally {
      setIsSavingMetadata(false);
    }
  };

  const handleBack = () => {
    if (isUploading || pipelinePending) return;

    if (currentStep === "robots") {
      setCurrentStep("media");
    } else if (currentStep === "review") {
      setCurrentStep("robots");
    } else if (currentStep === "status" && uploadError) {
      setCurrentStep("review");
      setUploadError(null);
    }
  };

  const handleStartNewUpload = () => {
    setCurrentStep("media");
    setSelectedVideo(null);
    setRobotDraftTitle("");
    setRobotDraftDescription("");
    setRobotDraftTags([]);
    setNewRobotDraftTag("");
    setDraftMuxAssetId(null);
    setIsSavingMetadata(false);
    setIsRegeneratingMetadata(false);
    setIsPublished(false);
    setDraftGeneratedAtMs(null);
    setMetadataSaveStatus(null);
    setSelectedAudioTranslationLanguageCodes([]);
    setSelectedCaptionTranslationLanguageCodes([]);
    setLastRequestedAudioTranslationLanguageCodes([]);
    setLastRequestedCaptionTranslationLanguageCodes([]);
    setLastUploadId(null);
    setUploadError(null);
    setUploadProgress(0);
    setStatus("Choose a video to begin.");
  };

  const headerBackAction =
    currentStep === "media" ||
    (currentStep === "status" && !uploadError) ||
    (currentStep === "review" && Boolean(draftMuxAssetId)) ||
    isUploading ||
    pipelinePending
      ? undefined
      : handleBack;

  return (
    <ThemedView style={styles.screen}>
      <TabPageLogoHeader
        source={require("../../assets/images/upload-logo.png")}
        width={250}
        height={75}
        transparentOnIOS
      />

      <TabPageScrollLayout
        containerStyle={[
          styles.container,
          currentStep !== "status" ? styles.compactStepContainer : undefined,
        ]}
        contentContainerStyle={styles.scrollContent}
        includeTopInset={false}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        topPaddingOffset={14}
      >
        <UploadStepHeader
          step={currentStep}
          onBack={headerBackAction}
          title={
            currentStep === "status"
              ? isPublished
                ? "Published"
                : "Preparing draft"
              : undefined
          }
        />

        {currentStep === "media" ? (
          <>
            {selectedVideo ? (
              <SelectedVideoThumbnail
                uri={selectedVideo.uri}
                sourceLabel={
                  selectedVideo.source === "camera"
                    ? "Recorded video selected"
                    : "Library video selected"
                }
                onClear={() => {
                  setSelectedVideo(null);
                  setUploadProgress(0);
                  setStatus("Video selection cleared.");
                }}
              />
            ) : (
              <View style={styles.mediaPlaceholder}>
                <View style={styles.mediaPlaceholderIcon}>
                  <Ionicons name="cloud-upload" size={34} color="#CC4C99" />
                </View>
                <ThemedText style={styles.mediaPlaceholderTitle} type="defaultSemiBold">
                  No video selected
                </ThemedText>
              </View>
            )}

            <View style={styles.mediaActions}>
              <Pressable
                onPress={handlePickVideo}
                style={({ pressed }) => [
                  styles.mediaChoiceButton,
                  styles.mediaChoiceButtonPrimary,
                  pressed ? styles.buttonPressed : undefined,
                ]}
              >
                <View style={styles.mediaChoiceIconPrimary}>
                  <Ionicons name="images" size={23} color="#FFFFFF" />
                </View>
                <View style={styles.mediaChoiceCopy}>
                  <ThemedText style={styles.mediaChoiceTitle} type="defaultSemiBold">
                    Choose from library
                  </ThemedText>
                </View>
                <Ionicons name="chevron-forward" size={22} color="#CC4C99" />
              </Pressable>

              <Pressable
                onPress={handleRecordVideo}
                style={({ pressed }) => [
                  styles.mediaChoiceButton,
                  pressed ? styles.buttonPressed : undefined,
                ]}
              >
                <View style={styles.mediaChoiceIcon}>
                  <Ionicons name="videocam" size={23} color="#CC4C99" />
                </View>
                <View style={styles.mediaChoiceCopy}>
                  <ThemedText style={styles.mediaChoiceTitle} type="defaultSemiBold">
                    Record a video
                  </ThemedText>
                </View>
                <Ionicons name="chevron-forward" size={22} color="#7A8494" />
              </Pressable>
            </View>

            <PrimaryButton
              disabled={!selectedVideo}
              label="Next: Robot jobs"
              onPress={() => setCurrentStep("robots")}
            />
          </>
        ) : null}

        {currentStep === "robots" ? (
          <>
            <View style={styles.metadataJobCard}>
              <Image
                source={require("../../assets/images/app-icon.png")}
                contentFit="contain"
                style={styles.metadataJobIcon}
              />
              <View style={styles.robotMetadataCopy}>
                <ThemedText type="defaultSemiBold">AI metadata</ThemedText>
                <ThemedText style={styles.supportingText}>
                  Title · Description · Tags
                </ThemedText>
              </View>
              <Ionicons name="checkmark-circle" size={22} color="#2E9E5B" />
            </View>

            <View style={styles.robotJobCard}>
              <View style={styles.robotJobHeading}>
                <View style={styles.robotJobIcon}>
                  <Ionicons name="mic" size={22} color="#CC4C99" />
                </View>
                <View style={styles.robotJobHeadingCopy}>
                  <ThemedText type="defaultSemiBold">Translate audio</ThemedText>
                  <ThemedText style={styles.supportingText}>
                    Add AI-dubbed audio tracks.
                  </ThemedText>
                </View>
              </View>
              <TranslationLanguagePills
                selectedCodes={selectedAudioTranslationLanguageCodes}
                onToggle={toggleAudioTranslationLanguage}
              />
            </View>

            <View style={styles.robotJobCard}>
              <View style={styles.robotJobHeading}>
                <View style={styles.robotJobIcon}>
                  <Ionicons name="logo-closed-captioning" size={22} color="#CC4C99" />
                </View>
                <View style={styles.robotJobHeadingCopy}>
                  <ThemedText type="defaultSemiBold">Translate captions</ThemedText>
                  <ThemedText style={styles.supportingText}>
                    Add translated subtitle tracks.
                  </ThemedText>
                </View>
              </View>
              <TranslationLanguagePills
                selectedCodes={selectedCaptionTranslationLanguageCodes}
                onToggle={toggleCaptionTranslationLanguage}
              />
            </View>

            <PrimaryButton
              label="Next: Review"
              onPress={() => setCurrentStep("review")}
            />
          </>
        ) : null}

        {currentStep === "review" ? (
          <>
            {!draftMuxAssetId ? (
              <>
                <View style={styles.reviewCard}>
                  <ReviewRow
                    icon="sparkles"
                    label="Robot metadata"
                    onPress={() => setCurrentStep("robots")}
                    value="Generated title, description and tags"
                  />
                  <View style={styles.reviewDivider} />
                  <ReviewRow
                    icon="mic"
                    label="Translated audio"
                    onPress={() => setCurrentStep("robots")}
                    value={audioTranslationSummary}
                  />
                  <View style={styles.reviewDivider} />
                  <ReviewRow
                    icon="logo-closed-captioning"
                    label="Translated captions"
                    onPress={() => setCurrentStep("robots")}
                    value={captionTranslationSummary}
                  />
                </View>

                <View style={styles.privateDraftNotice}>
                  <Ionicons name="lock-closed" size={17} color="#5E6C82" />
                  <ThemedText style={styles.privateDraftNoticeText}>
                    Your video stays private while Mux Robots creates the draft.
                  </ThemedText>
                </View>

                <PrimaryButton
                  disabled={!canUpload}
                  icon="sparkles"
                  label="Generate Robot draft"
                  onPress={handleUpload}
                />
              </>
            ) : (
              <>
                <View style={styles.generatedResultsCard}>
                  <View style={styles.generatedResultsHeading}>
                    <Image
                      source={require("../../assets/images/app-icon.png")}
                      contentFit="contain"
                      style={styles.generatedResultsIcon}
                    />
                    <View style={styles.robotMetadataCopy}>
                      <ThemedText type="defaultSemiBold">
                        Mux Robots draft
                      </ThemedText>
                      <ThemedText style={styles.supportingText}>
                        Edit anything before publishing.
                      </ThemedText>
                    </View>
                    <Ionicons name="create-outline" size={20} color="#CC4C99" />
                  </View>

                  <View style={styles.generatedDraftField}>
                    <ThemedText style={styles.generatedResultLabel}>Title</ThemedText>
                    <TextInput
                      editable={!isRegeneratingMetadata}
                      inputAccessoryViewID={
                        Platform.OS === "ios"
                          ? ROBOT_DRAFT_INPUT_ACCESSORY_ID
                          : undefined
                      }
                      maxLength={120}
                      onChangeText={(value) => {
                        setRobotDraftTitle(value);
                        setMetadataSaveStatus(null);
                      }}
                      onSubmitEditing={() => Keyboard.dismiss()}
                      placeholder="Add a title"
                      placeholderTextColor="#7A8494"
                      returnKeyType="done"
                      style={styles.generatedTitleInput}
                      value={robotDraftTitle}
                    />
                  </View>

                  <View style={styles.generatedDraftField}>
                    <ThemedText style={styles.generatedResultLabel}>
                      Description
                    </ThemedText>
                    <TextInput
                      editable={!isRegeneratingMetadata}
                      inputAccessoryViewID={
                        Platform.OS === "ios"
                          ? ROBOT_DRAFT_INPUT_ACCESSORY_ID
                          : undefined
                      }
                      maxLength={500}
                      multiline
                      onChangeText={(value) => {
                        setRobotDraftDescription(value);
                        setMetadataSaveStatus(null);
                      }}
                      placeholder="Add a description"
                      placeholderTextColor="#7A8494"
                      style={styles.generatedDescriptionInput}
                      textAlignVertical="top"
                      value={robotDraftDescription}
                    />
                  </View>

                  <View style={styles.generatedDraftField}>
                    <ThemedText style={styles.generatedResultLabel}>Tags</ThemedText>
                    <ScrollView
                      horizontal
                      contentContainerStyle={styles.generatedTags}
                      showsHorizontalScrollIndicator={false}
                    >
                      {robotDraftTags.map((tag) => (
                        <Pressable
                          accessibilityLabel={`Remove ${tag} tag`}
                          disabled={isRegeneratingMetadata}
                          key={tag}
                          onPress={() => removeRobotDraftTag(tag)}
                          style={styles.generatedTag}
                        >
                          <ThemedText style={styles.generatedTagText}>
                            #{tag.replace(/^#/, "")}
                          </ThemedText>
                          <Ionicons name="close" size={13} color="#B24A88" />
                        </Pressable>
                      ))}
                    </ScrollView>

                    <View style={styles.addTagRow}>
                      <TextInput
                        autoCapitalize="none"
                        editable={!isRegeneratingMetadata}
                        inputAccessoryViewID={
                          Platform.OS === "ios"
                            ? ROBOT_DRAFT_INPUT_ACCESSORY_ID
                            : undefined
                        }
                        maxLength={40}
                        onChangeText={setNewRobotDraftTag}
                        onSubmitEditing={addRobotDraftTag}
                        placeholder="Add a tag"
                        placeholderTextColor="#7A8494"
                        returnKeyType="done"
                        style={styles.addTagInput}
                        value={newRobotDraftTag}
                      />
                      <Pressable
                        accessibilityLabel="Add tag"
                        disabled={
                          isRegeneratingMetadata ||
                          !newRobotDraftTag.trim() ||
                          robotDraftTags.length >= 10
                        }
                        onPress={addRobotDraftTag}
                        style={({ pressed }) => [
                          styles.addTagButton,
                          pressed ? styles.buttonPressed : undefined,
                          isRegeneratingMetadata ||
                          !newRobotDraftTag.trim() ||
                          robotDraftTags.length >= 10
                            ? styles.addTagButtonDisabled
                            : undefined,
                        ]}
                      >
                        <Ionicons name="add" size={22} color="#FFFFFF" />
                      </Pressable>
                    </View>
                  </View>
                </View>

                <View style={styles.draftStatusRow}>
                  <Ionicons
                    name={isRegeneratingMetadata ? "sync" : "checkmark-circle"}
                    size={18}
                    color={isRegeneratingMetadata ? "#CC4C99" : "#2E9E5B"}
                  />
                  <ThemedText numberOfLines={2} style={styles.draftStatusText}>
                    {isRegeneratingMetadata
                      ? "Mux Robots is generating a new draft..."
                      : "Draft ready. The video is still private."}
                  </ThemedText>
                </View>

                {metadataSaveStatus && !isRegeneratingMetadata ? (
                  <ThemedText
                    numberOfLines={2}
                    style={
                      metadataSaveStatus === "Changes saved"
                        ? styles.metadataSaveSuccess
                        : styles.metadataSaveError
                    }
                  >
                    {metadataSaveStatus}
                  </ThemedText>
                ) : null}

                <View style={styles.draftActionRow}>
                  <Pressable
                    disabled={isRegeneratingMetadata || isSavingMetadata}
                    onPress={handleRegenerateRobotDraft}
                    style={({ pressed }) => [
                      styles.draftSecondaryButton,
                      pressed ? styles.buttonPressed : undefined,
                    ]}
                  >
                    <Ionicons name="refresh" size={18} color="#CC4C99" />
                    <ThemedText style={styles.draftSecondaryButtonText}>
                      Regenerate
                    </ThemedText>
                  </Pressable>
                  <Pressable
                    disabled={isRegeneratingMetadata || isSavingMetadata}
                    onPress={handleSaveRobotDraft}
                    style={({ pressed }) => [
                      styles.draftSecondaryButton,
                      pressed ? styles.buttonPressed : undefined,
                    ]}
                  >
                    <Ionicons name="save-outline" size={18} color="#CC4C99" />
                    <ThemedText style={styles.draftSecondaryButtonText}>
                      Save draft
                    </ThemedText>
                  </Pressable>
                </View>

                <PrimaryButton
                  disabled={isRegeneratingMetadata || isSavingMetadata}
                  icon="paper-plane-outline"
                  label={isSavingMetadata ? "Publishing..." : "Publish video"}
                  onPress={handlePublishRobotDraft}
                />
              </>
            )}
          </>
        ) : null}

        {currentStep === "status" ? (
          <>
            {uploadError ? (
              <View style={styles.errorCard}>
                <View style={styles.errorIcon}>
                  <Ionicons name="alert-circle" size={34} color="#C23B4B" />
                </View>
                <ThemedText style={styles.statusTitle} type="subtitle">
                  Upload didn&apos;t finish
                </ThemedText>
                <ThemedText style={styles.bodyText}>{uploadError}</ThemedText>
              </View>
            ) : null}

            {!isPublished &&
            (isUploading || (pipelinePending && !robotDraftReady)) ? (
              <UploadLoadingIndicator
                isActive
                progress={uploadProgress}
                status={status}
              />
            ) : null}

            {isPublished ? (
              <View style={styles.publishedCard}>
                <View style={styles.publishedIcon}>
                  <Ionicons name="checkmark" size={29} color="#FFFFFF" />
                </View>
                <ThemedText style={styles.statusTitle} type="subtitle">
                  Video published
                </ThemedText>
                <ThemedText style={styles.publishedText}>{status}</ThemedText>
              </View>
            ) : null}

            {uploadComplete &&
            !pipelinePending &&
            !robotDraftReady &&
            !uploadError ? (
              <View style={styles.metadataUnavailableCard}>
                <Ionicons
                  name={pipelineStatus?.passed === false ? "alert-circle" : "information-circle"}
                  size={25}
                  color={pipelineStatus?.passed === false ? "#C23B4B" : "#5E6C82"}
                />
                <ThemedText
                  numberOfLines={2}
                  style={styles.metadataUnavailableText}
                >
                  {status}
                </ThemedText>
              </View>
            ) : null}

            {uploadError ? (
              <PrimaryButton label="Back to review" onPress={handleBack} />
            ) : null}
            {(isPublished || (uploadComplete && !pipelinePending)) ? (
              <Pressable
                onPress={handleStartNewUpload}
                style={({ pressed }) => [
                  styles.uploadAnotherButton,
                  pressed ? styles.buttonPressed : undefined,
                ]}
              >
                <Ionicons name="add" size={18} color="#11181C" />
                <ThemedText type="defaultSemiBold">Upload another video</ThemedText>
              </Pressable>
            ) : null}
          </>
        ) : null}
      </TabPageScrollLayout>

      {Platform.OS === "ios" ? (
        <InputAccessoryView nativeID={ROBOT_DRAFT_INPUT_ACCESSORY_ID}>
          <View style={styles.keyboardAccessory}>
            <Pressable
              accessibilityLabel="Finish editing video details"
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => Keyboard.dismiss()}
              style={({ pressed }) => [
                styles.keyboardDoneButton,
                pressed ? styles.buttonPressed : undefined,
              ]}
            >
              <Ionicons name="checkmark-circle" size={21} color="#CC4C99" />
              <ThemedText style={styles.keyboardDoneText}>Done</ThemedText>
            </Pressable>
          </View>
        </InputAccessoryView>
      ) : null}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
  },
  container: {
    gap: 18,
  },
  compactStepContainer: {
    gap: 14,
  },
  stepHeaderWrap: {
    gap: 14,
    marginBottom: 2,
  },
  stepTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 42,
  },
  backButton: {
    width: 38,
    height: 38,
    marginLeft: -8,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 19,
  },
  backButtonSpacer: {
    width: 30,
  },
  stepTitle: {
    flex: 1,
    fontSize: 27,
    lineHeight: 33,
  },
  stepCount: {
    marginLeft: 10,
    fontSize: 13,
    lineHeight: 18,
    color: "#5E6C82",
    fontWeight: "600",
  },
  stepCountSpacer: {
    width: 8,
  },
  stepProgress: {
    flexDirection: "row",
    gap: 6,
  },
  stepProgressSegment: {
    flex: 1,
    height: 4,
    borderRadius: 999,
    backgroundColor: "#E8ECF2",
  },
  stepProgressSegmentActive: {
    backgroundColor: "#FA50B5",
  },
  bodyText: {
    fontSize: 15,
    lineHeight: 22,
    color: "#5E6C82",
  },
  mediaPlaceholder: {
    minHeight: 184,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 24,
    borderRadius: 20,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: "#F3A8D6",
    backgroundColor: "#FFF8FC",
  },
  mediaPlaceholderIcon: {
    width: 58,
    height: 58,
    marginBottom: 4,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 29,
    backgroundColor: "#FFE5F5",
  },
  mediaPlaceholderTitle: {
    fontSize: 17,
    lineHeight: 22,
  },
  mediaActions: {
    gap: 10,
  },
  mediaChoiceButton: {
    minHeight: 62,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#DDE3EB",
    backgroundColor: "#FFFFFF",
  },
  mediaChoiceButtonPrimary: {
    borderColor: "#FFC3E8",
    backgroundColor: "#FFF4FB",
  },
  mediaChoiceIcon: {
    width: 43,
    height: 43,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 13,
    backgroundColor: "#FFF0F9",
  },
  mediaChoiceIconPrimary: {
    width: 43,
    height: 43,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 13,
    backgroundColor: "#FA50B5",
  },
  mediaChoiceCopy: {
    flex: 1,
  },
  mediaChoiceTitle: {
    fontSize: 15,
    lineHeight: 20,
  },
  primaryButton: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 2,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderRadius: 999,
    backgroundColor: "#111111",
  },
  primaryButtonDisabled: {
    backgroundColor: "#C7CCD4",
  },
  primaryButtonText: {
    color: "#FFFFFF",
    fontSize: 16,
    lineHeight: 22,
  },
  buttonPressed: {
    opacity: 0.78,
  },
  buttonDisabled: {
    opacity: 0.5,
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
  robotMetadataCopy: {
    flex: 1,
  },
  metadataJobCard: {
    minHeight: 62,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#CDEBD8",
    backgroundColor: "#F4FBF7",
  },
  metadataJobIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
  },
  robotJobCard: {
    gap: 12,
    padding: 14,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#DDE3EB",
    backgroundColor: "#FFFFFF",
  },
  robotJobHeading: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  robotJobIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FFF0F9",
  },
  robotJobHeadingCopy: {
    flex: 1,
  },
  reviewCard: {
    overflow: "hidden",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#DDE3EB",
    backgroundColor: "#FFFFFF",
  },
  reviewRow: {
    minHeight: 59,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  reviewRowPressed: {
    backgroundColor: "#FFF7FC",
  },
  reviewRowIcon: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    backgroundColor: "#FFF0F9",
  },
  reviewRowCopy: {
    flex: 1,
  },
  reviewRowLabel: {
    fontSize: 12,
    lineHeight: 16,
    color: "#697589",
  },
  reviewRowValue: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: "600",
  },
  reviewDivider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 62,
    backgroundColor: "#DDE3EB",
  },
  privateDraftNotice: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 11,
  },
  privateDraftNoticeText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
    color: "#5E6C82",
  },
  errorCard: {
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 22,
    paddingVertical: 26,
    borderRadius: 18,
    backgroundColor: "#FFF5F6",
  },
  errorIcon: {
    width: 66,
    height: 66,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 33,
    backgroundColor: "#FFE5E9",
  },
  statusTitle: {
    textAlign: "center",
    fontSize: 20,
    lineHeight: 26,
  },
  generatedResultsCard: {
    gap: 10,
    padding: 13,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#FFC3E8",
    backgroundColor: "#FFF8FC",
  },
  generatedResultsHeading: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
  },
  generatedResultsIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
  },
  generatedDraftField: {
    gap: 2,
  },
  generatedResultLabel: {
    fontSize: 11,
    lineHeight: 15,
    color: "#B24A88",
    fontWeight: "700",
    textTransform: "uppercase",
  },
  generatedTitleInput: {
    height: 44,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: "#E0B8D2",
    borderRadius: 12,
    backgroundColor: "#FFFFFF",
    fontSize: 15,
    color: "#11181C",
  },
  generatedDescriptionInput: {
    minHeight: 90,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 10,
    borderWidth: 1,
    borderColor: "#E0B8D2",
    borderRadius: 12,
    backgroundColor: "#FFFFFF",
    fontSize: 14,
    lineHeight: 19,
    color: "#11181C",
  },
  generatedTags: {
    flexDirection: "row",
    gap: 6,
    minHeight: 27,
  },
  generatedTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: "#FFE4F4",
  },
  generatedTagText: {
    fontSize: 12,
    lineHeight: 15,
    color: "#B24A88",
    fontWeight: "600",
  },
  addTagRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 3,
  },
  addTagInput: {
    height: 42,
    flex: 1,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: "#E0B8D2",
    borderRadius: 12,
    backgroundColor: "#FFFFFF",
    fontSize: 14,
    color: "#11181C",
  },
  addTagButton: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    backgroundColor: "#FA50B5",
  },
  addTagButtonDisabled: {
    backgroundColor: "#C7CCD4",
  },
  keyboardAccessory: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    paddingHorizontal: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#E0B8D2",
    backgroundColor: "#FFF8FC",
  },
  keyboardDoneButton: {
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: "#FFE4F4",
  },
  keyboardDoneText: {
    fontSize: 14,
    lineHeight: 19,
    color: "#B24A88",
    fontWeight: "700",
  },
  draftStatusRow: {
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 11,
    paddingVertical: 8,
    borderRadius: 12,
    backgroundColor: "#F7F8FA",
  },
  draftStatusText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 16,
    color: "#5E6C82",
  },
  draftActionRow: {
    flexDirection: "row",
    gap: 10,
  },
  draftSecondaryButton: {
    minHeight: 44,
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#FFC3E8",
    backgroundColor: "#FFF6FC",
  },
  draftSecondaryButtonText: {
    fontSize: 13,
    lineHeight: 18,
    color: "#B24A88",
    fontWeight: "600",
  },
  metadataSaveSuccess: {
    textAlign: "center",
    fontSize: 13,
    lineHeight: 18,
    color: "#2E9E5B",
    fontWeight: "600",
  },
  metadataSaveError: {
    textAlign: "center",
    fontSize: 13,
    lineHeight: 18,
    color: "#C23B4B",
    fontWeight: "600",
  },
  metadataUnavailableCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 14,
    borderRadius: 14,
    backgroundColor: "#F7F8FA",
  },
  metadataUnavailableText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
    color: "#5E6C82",
  },
  publishedCard: {
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 22,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#CDEBD8",
    backgroundColor: "#F4FBF7",
  },
  publishedIcon: {
    width: 50,
    height: 50,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 25,
    backgroundColor: "#2E9E5B",
  },
  publishedText: {
    maxWidth: 420,
    textAlign: "center",
    fontSize: 13,
    lineHeight: 19,
    color: "#5E6C82",
  },
  uploadAnotherButton: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  selectedVideoCard: {
    borderRadius: 18,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#D5DDE8",
    backgroundColor: "#FFFFFF",
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
    paddingVertical: 9,
    fontSize: 13,
    color: "#B24A88",
  },
});
