import { Ionicons } from "@expo/vector-icons";
import { useUIMessages } from "@convex-dev/agent/react";
import { useMutation, useQuery } from "convex/react";
import { Image } from "expo-image";
import { StatusBar } from "expo-status-bar";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { type SubtitleTrack, useVideoPlayer, VideoView } from "expo-video";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Animated,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  FeedVideoCard,
  type FeedVideoKeyMoment,
  type FeedVideoKeyMomentCue,
  type FeedVideoItem,
  formatDuration,
  formatPublished,
} from "@/components/feed-video-card";
import { api } from "@/convex/_generated/api";

function getPreferredSubtitleTrack(tracks: SubtitleTrack[]) {
  return tracks.find((track) => track.isDefault || track.autoSelect) ?? tracks[0] ?? null;
}

function FullVideoPlayer({
  playbackUrl,
  startAtSeconds,
  seekToSeconds,
  onSeekHandled,
  onTimeUpdate,
}: {
  playbackUrl: string;
  startAtSeconds?: number;
  seekToSeconds?: number | null;
  onSeekHandled?: () => void;
  onTimeUpdate?: (seconds: number) => void;
}) {
  const didSeekToStartRef = useRef(false);

  const player = useVideoPlayer(
    { uri: playbackUrl, contentType: "hls" },
    (videoPlayer) => {
      videoPlayer.loop = false;
      videoPlayer.play();
    },
  );

  useEffect(() => {
    if (didSeekToStartRef.current) return;
    if (startAtSeconds === undefined || Number.isNaN(startAtSeconds)) return;

    player.currentTime = Math.max(0, startAtSeconds);
    didSeekToStartRef.current = true;
  }, [player, startAtSeconds]);

  useEffect(() => {
    if (seekToSeconds === undefined || seekToSeconds === null || Number.isNaN(seekToSeconds)) {
      return;
    }

    player.currentTime = Math.max(0, seekToSeconds);
    onSeekHandled?.();
  }, [onSeekHandled, player, seekToSeconds]);

  useEffect(() => {
    const subscription = player.addListener("timeUpdate", (event) => {
      onTimeUpdate?.(event.currentTime);
    });

    return () => {
      subscription.remove();
    };
  }, [onTimeUpdate, player]);

  useEffect(() => {
    const ensureSubtitleTrack = (tracks: SubtitleTrack[]) => {
      if (player.subtitleTrack || tracks.length === 0) {
        return;
      }

      const nextTrack = getPreferredSubtitleTrack(tracks);
      if (!nextTrack) {
        return;
      }

      player.subtitleTrack = nextTrack;
    };

    ensureSubtitleTrack(player.availableSubtitleTracks);

    const sourceLoadSubscription = player.addListener("sourceLoad", (event) => {
      ensureSubtitleTrack(event.availableSubtitleTracks);
    });
    const availableSubtitleTracksSubscription = player.addListener(
      "availableSubtitleTracksChange",
      (event) => {
        ensureSubtitleTrack(event.availableSubtitleTracks);
      },
    );

    return () => {
      sourceLoadSubscription.remove();
      availableSubtitleTracksSubscription.remove();
    };
  }, [player]);

  return (
    <VideoView
      player={player}
      nativeControls
      contentFit="contain"
      allowsVideoFrameAnalysis={false}
      style={styles.video}
    />
  );
}

function DraggableSheetModal({
  visible,
  title,
  subtitle,
  closeAccessibilityLabel,
  playerSectionHeight,
  sheetHeight,
  bottomInset,
  onClose,
  children,
}: {
  visible: boolean;
  title: string;
  subtitle: string;
  closeAccessibilityLabel: string;
  playerSectionHeight: number;
  sheetHeight: number;
  bottomInset: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const translateY = useRef(new Animated.Value(sheetHeight)).current;
  const isClosingRef = useRef(false);
  const wasVisibleRef = useRef(visible);

  const snapOpen = useCallback(() => {
    translateY.stopAnimation();
    translateY.setValue(sheetHeight);
    Animated.spring(translateY, {
      toValue: 0,
      damping: 24,
      stiffness: 260,
      mass: 0.9,
      useNativeDriver: true,
    }).start();
  }, [sheetHeight, translateY]);

  const snapClosed = useCallback(() => {
    if (isClosingRef.current) return;

    isClosingRef.current = true;
    translateY.stopAnimation();
    Animated.timing(translateY, {
      toValue: sheetHeight,
      duration: 180,
      useNativeDriver: true,
    }).start(({ finished }) => {
      isClosingRef.current = false;
      if (finished) {
        onClose();
      }
    });
  }, [onClose, sheetHeight, translateY]);

  const resetPosition = useCallback(() => {
    translateY.stopAnimation();
    Animated.spring(translateY, {
      toValue: 0,
      damping: 24,
      stiffness: 260,
      mass: 0.9,
      useNativeDriver: true,
    }).start();
  }, [translateY]);

  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      snapOpen();
    }

    if (!visible) {
      translateY.setValue(sheetHeight);
    }

    wasVisibleRef.current = visible;
  }, [sheetHeight, snapOpen, translateY, visible]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponderCapture: () => true,
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponderCapture: (_, gestureState) =>
          gestureState.dy > 4 && Math.abs(gestureState.dy) > Math.abs(gestureState.dx),
        onMoveShouldSetPanResponder: (_, gestureState) =>
          gestureState.dy > 4 && Math.abs(gestureState.dy) > Math.abs(gestureState.dx),
        onPanResponderGrant: () => {
          translateY.stopAnimation();
        },
        onPanResponderMove: (_, gestureState) => {
          translateY.setValue(Math.max(0, gestureState.dy));
        },
        onPanResponderRelease: (_, gestureState) => {
          const shouldClose =
            gestureState.dy > Math.min(120, sheetHeight * 0.2) || gestureState.vy > 1;

          if (shouldClose) {
            snapClosed();
            return;
          }

          resetPosition();
        },
        onPanResponderTerminate: () => {
          resetPosition();
        },
      }),
    [resetPosition, sheetHeight, snapClosed, translateY],
  );

  if (!visible) {
    return null;
  }

  return (
    <Modal
      transparent
      animationType="fade"
      presentationStyle="overFullScreen"
      statusBarTranslucent
      visible={visible}
      onRequestClose={snapClosed}
    >
      <View style={styles.sheetOverlay}>
        <Pressable
          style={[styles.sheetBackdrop, { height: playerSectionHeight }]}
          onPress={snapClosed}
        />
        <Animated.View
          style={[
            styles.sheetCard,
            {
              height: sheetHeight,
              paddingBottom: bottomInset,
              transform: [{ translateY }],
            },
          ]}
        >
          <View style={styles.sheetHeader}>
            <View style={styles.sheetDragArea} {...panResponder.panHandlers}>
              <View style={styles.sheetHandle} />
              <View style={styles.sheetHeadingBlock}>
                <Text style={styles.sheetTitle}>{title}</Text>
                <Text style={styles.sheetVideoTitle}>{subtitle}</Text>
              </View>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={closeAccessibilityLabel}
              onPress={snapClosed}
              style={({ pressed }) => [
                styles.sheetCloseButton,
                styles.sheetCloseButtonFloating,
                pressed && styles.sheetCloseButtonPressed,
              ]}
            >
              <Ionicons name="close" size={20} color="#162033" />
            </Pressable>
          </View>

          {children}
        </Animated.View>
      </View>
    </Modal>
  );
}

function getMessageText(message: any) {
  if (Array.isArray(message?.parts)) {
    const text = message.parts
      .map((part: any) => {
        if (part?.type === "text" && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .join("")
      .trim();

    if (text) {
      return text;
    }
  }

  return typeof message?.content === "string" ? message.content : "";
}

function formatMomentRange(startMs: number, endMs: number) {
  const startLabel = formatDuration(startMs / 1000) ?? "0:00";
  const endLabel = formatDuration(endMs / 1000) ?? startLabel;
  return `${startLabel} - ${endLabel}`;
}

function getCuePreview(cues: FeedVideoKeyMomentCue[] | undefined) {
  if (!cues || cues.length === 0) {
    return null;
  }

  const text = cues
    .map((cue) => cue.text?.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return text.length > 0 ? text : null;
}

function VideoAssistantThread({ threadId }: { threadId: string }) {
  const sendMessage = useMutation((api as any).videoChat.sendMessage);
  const { results, status, loadMore } = useUIMessages(
    (api as any).videoChat.listThreadMessages,
    { threadId },
    { initialNumItems: 20 },
  );
  const scrollRef = useRef<ScrollView | null>(null);
  const [draft, setDraft] = useState("");
  const [isSending, setIsSending] = useState(false);

  const scrollToLatestMessage = useCallback((animated = true) => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollToEnd({ animated });
    });
  }, []);

  useEffect(() => {
    if (results.length === 0) {
      return;
    }

    scrollToLatestMessage(false);
  }, [results.length, scrollToLatestMessage]);

  const handleSend = useCallback(async () => {
    const prompt = draft.trim();
    if (!prompt || isSending) {
      return;
    }

    try {
      setIsSending(true);
      setDraft("");
      await sendMessage({ threadId, prompt });
    } catch (error) {
      setDraft(prompt);
      const message =
        error instanceof Error ? error.message : "Could not send chat message.";
      Alert.alert("Chat Unavailable", message);
    } finally {
      setIsSending(false);
    }
  }, [draft, isSending, sendMessage, threadId]);

  return (
    <View style={styles.chatSheetBody}>
      <ScrollView
        ref={scrollRef}
        style={styles.chatMessagesScroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.chatMessagesContent}
        onContentSizeChange={() => {
          if (draft.length > 0 || isSending) {
            scrollToLatestMessage(false);
          }
        }}
      >
        {status === "CanLoadMore" || status === "LoadingMore" ? (
          <Pressable
            onPress={() => loadMore(12)}
            disabled={status === "LoadingMore"}
            style={({ pressed }) => [
              styles.chatLoadMoreButton,
              pressed && status !== "LoadingMore" ? styles.chapterRowPressed : undefined,
            ]}
          >
            <Text style={styles.chatLoadMoreText}>
              {status === "LoadingMore" ? "Loading earlier messages..." : "Load earlier messages"}
            </Text>
          </Pressable>
        ) : null}

        {status === "LoadingFirstPage" ? (
          <View style={styles.chatEmptyState}>
            <Text style={styles.summaryPending}>Loading chat...</Text>
          </View>
        ) : null}

        {results.length === 0 && status !== "LoadingFirstPage" ? (
          <View style={styles.chatEmptyState}>
            <Text style={styles.sheetSummary}>
              Ask about this video and Robotube will reply in this thread.
            </Text>
            <Text style={styles.summaryPending}>
              For now the assistant knows the current video metadata, summary, tags, and chapters.
            </Text>
          </View>
        ) : null}

        {results.map((message: any, index) => {
          const isUser = message.role === "user";
          const text = getMessageText(message) || (isUser ? "Sent a message." : "Thinking...");

          return (
            <View
              key={message.id ?? `${message.order}-${message.stepOrder}-${index}`}
              style={[
                styles.chatBubble,
                isUser ? styles.chatBubbleUser : styles.chatBubbleAssistant,
              ]}
            >
              <Text
                style={[
                  styles.chatBubbleText,
                  isUser ? styles.chatBubbleTextUser : styles.chatBubbleTextAssistant,
                ]}
              >
                {text}
              </Text>
            </View>
          );
        })}
      </ScrollView>

      <View style={styles.chatComposer}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onFocus={() => {
            scrollToLatestMessage(true);
          }}
          placeholder="Ask about this video"
          multiline
          maxLength={600}
          style={styles.chatInput}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send chat message"
          disabled={!draft.trim() || isSending}
          onPress={handleSend}
          style={({ pressed }) => [
            styles.chatSendButton,
            (!draft.trim() || isSending) && styles.chatSendButtonDisabled,
            pressed && draft.trim() && !isSending ? styles.buttonPressed : undefined,
          ]}
        >
          <Ionicons name="arrow-up" size={18} color="#FFFFFF" />
        </Pressable>
      </View>
    </View>
  );
}

export default function VideoDetailPage() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const { muxAssetId: rawMuxAssetId, startAt: rawStartAt } =
    useLocalSearchParams<{
      muxAssetId?: string | string[];
      startAt?: string | string[];
    }>();

  const muxAssetId = Array.isArray(rawMuxAssetId)
    ? rawMuxAssetId[0]
    : rawMuxAssetId;
  const startAtParam = Array.isArray(rawStartAt) ? rawStartAt[0] : rawStartAt;
  const startAtSeconds = startAtParam ? Number(startAtParam) : undefined;

  const selectedVideo = useQuery(
    (api as any).feed.getFeedVideoByMuxAssetId,
    muxAssetId ? { muxAssetId } : "skip",
  ) as FeedVideoItem | null | undefined;

  const feedVideos = useQuery((api as any).feed.listFeedVideos, {
    limit: 20,
  }) as FeedVideoItem[] | undefined;

  const relatedVideos = useMemo(
    () =>
      (feedVideos ?? []).filter((video) => video.muxAssetId !== muxAssetId),
    [feedVideos, muxAssetId],
  );
  const ensureVideoChatThread = useMutation((api as any).videoChat.ensureThreadForVideo);
  const summary = selectedVideo?.summary ?? null;
  const tags = useMemo(() => selectedVideo?.tags ?? [], [selectedVideo?.tags]);
  const previewTags = useMemo(() => tags.slice(0, 3), [tags]);
  const chapters = useMemo(() => selectedVideo?.chapters ?? [], [selectedVideo?.chapters]);
  const keyMoments = useMemo(() => selectedVideo?.keyMoments ?? [], [selectedVideo?.keyMoments]);
  const [seekToSeconds, setSeekToSeconds] = useState<number | null>(null);
  const [currentTimeSeconds, setCurrentTimeSeconds] = useState(0);
  const [isDetailsSheetVisible, setIsDetailsSheetVisible] = useState(false);
  const [isKeyMomentsSheetVisible, setIsKeyMomentsSheetVisible] = useState(false);
  const [isChaptersSheetVisible, setIsChaptersSheetVisible] = useState(false);
  const [isAssistantSheetVisible, setIsAssistantSheetVisible] = useState(false);
  const [assistantThreadId, setAssistantThreadId] = useState<string | null>(null);
  const [isPreparingAssistantThread, setIsPreparingAssistantThread] = useState(false);
  const [assistantKeyboardHeight, setAssistantKeyboardHeight] = useState(0);
  const summaryPreview = useMemo(
    () => summary ?? "AI summary is not ready yet for this video.",
    [summary],
  );
  const playerSectionHeight = useMemo(
    () => insets.top + (windowWidth * 9) / 16,
    [insets.top, windowWidth],
  );
  const sheetHeight = useMemo(
    () => Math.max(windowHeight - playerSectionHeight, 240),
    [playerSectionHeight, windowHeight],
  );
  const assistantSheetHeight = useMemo(
    () =>
      Math.max(
        sheetHeight - Math.max(0, assistantKeyboardHeight - insets.bottom),
        260,
      ),
    [assistantKeyboardHeight, insets.bottom, sheetHeight],
  );

  const activeChapterStartTime = useMemo(() => {
    if (chapters.length === 0) return null;
    let active = chapters[0]?.startTime ?? 0;
    for (const chapter of chapters) {
      if (chapter.startTime <= currentTimeSeconds) {
        active = chapter.startTime;
      } else {
        break;
      }
    }
    return active;
  }, [chapters, currentTimeSeconds]);

  useEffect(() => {
    setCurrentTimeSeconds(startAtSeconds ?? 0);
    setSeekToSeconds(null);
  }, [selectedVideo?.muxAssetId, startAtSeconds]);

  useEffect(() => {
    setIsDetailsSheetVisible(false);
    setIsKeyMomentsSheetVisible(false);
    setIsChaptersSheetVisible(false);
    setIsAssistantSheetVisible(false);
    setAssistantThreadId(null);
    setIsPreparingAssistantThread(false);
    setAssistantKeyboardHeight(0);
  }, [selectedVideo?.muxAssetId]);

  useEffect(() => {
    if (!isAssistantSheetVisible) {
      setAssistantKeyboardHeight(0);
      return;
    }

    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

    const showSubscription = Keyboard.addListener(showEvent, (event) => {
      setAssistantKeyboardHeight(event.endCoordinates.height);
    });
    const hideSubscription = Keyboard.addListener(hideEvent, () => {
      setAssistantKeyboardHeight(0);
    });

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, [isAssistantSheetVisible]);

  const openAssistantChat = useCallback(async () => {
    if (!selectedVideo || isPreparingAssistantThread) {
      return;
    }

    setIsDetailsSheetVisible(false);
    setIsKeyMomentsSheetVisible(false);
    setIsChaptersSheetVisible(false);
    setIsAssistantSheetVisible(true);

    if (assistantThreadId) {
      return;
    }

    try {
      setIsPreparingAssistantThread(true);
      const result = await ensureVideoChatThread({
        muxAssetId: selectedVideo.muxAssetId,
      });
      setAssistantThreadId(result.threadId);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not start the video assistant chat.";
      setIsAssistantSheetVisible(false);
      Alert.alert("Chat Unavailable", message);
    } finally {
      setIsPreparingAssistantThread(false);
    }
  }, [assistantThreadId, ensureVideoChatThread, isPreparingAssistantThread, selectedVideo]);

  const openKeyMomentsSheet = useCallback(() => {
    setIsDetailsSheetVisible(false);
    setIsChaptersSheetVisible(false);
    setIsAssistantSheetVisible(false);
    setIsKeyMomentsSheetVisible(true);
  }, []);

  if (!muxAssetId) {
    return (
      <View style={styles.stateContainer}>
        <Stack.Screen options={{ headerShown: false }} />
        <Text style={styles.stateTitle}>Invalid video link</Text>
      </View>
    );
  }

  if (selectedVideo === undefined) {
    return (
      <View style={styles.stateContainer}>
        <Stack.Screen options={{ headerShown: false }} />
        <Text style={styles.stateTitle}>Loading video...</Text>
      </View>
    );
  }

  if (!selectedVideo) {
    return (
      <View style={styles.stateContainer}>
        <Stack.Screen options={{ headerShown: false }} />
        <Text style={styles.stateTitle}>Video not found</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <StatusBar style="light" backgroundColor="#000000" translucent={false} />
      <Stack.Screen options={{ headerShown: false }} />
      <View style={{ height: insets.top, backgroundColor: "#000" }} />
      <View style={styles.videoWrap}>
        <FullVideoPlayer
          key={selectedVideo.muxAssetId}
          playbackUrl={selectedVideo.playbackUrl}
          startAtSeconds={startAtSeconds}
          seekToSeconds={seekToSeconds}
          onSeekHandled={() => setSeekToSeconds(null)}
          onTimeUpdate={setCurrentTimeSeconds}
        />
      </View>

      <View
        style={[
          styles.mainSheet,
          {
            height: sheetHeight,
            paddingBottom: Math.max(insets.bottom, 18),
          },
        ]}
      >
        <FlatList
          data={relatedVideos}
          keyExtractor={(item) => item.muxAssetId}
          renderItem={({ item }) => (
            <FeedVideoCard
              item={item}
              onPress={(video, startAt) =>
                router.replace({
                  pathname: "/video/[muxAssetId]",
                  params: {
                    muxAssetId: video.muxAssetId,
                    startAt: String(startAt ?? 0),
                  },
                })
              }
            />
          )}
          ListHeaderComponent={
            <View>
              <View style={styles.metaWrap}>
                <View style={styles.titleRow}>
                  <Text style={styles.title}>{selectedVideo.title}</Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Open key moments"
                    onPress={openKeyMomentsSheet}
                    style={({ pressed }) => [
                      styles.iconPillButton,
                      pressed ? styles.chaptersButtonPressed : undefined,
                    ]}
                  >
                    <Ionicons name="key-outline" size={18} color="#1A2332" />
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Open video assistant chat"
                    onPress={() => {
                      void openAssistantChat();
                    }}
                    style={({ pressed }) => [
                      styles.iconPillButton,
                      styles.robotIconBadge,
                      pressed ? styles.chaptersButtonPressed : undefined,
                    ]}
                  >
                    <Image
                      source={require("../../assets/images/app-icon.png")}
                      contentFit="contain"
                      style={styles.robotIconImage}
                    />
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Open video chapters"
                    disabled={chapters.length === 0}
                    onPress={() => {
                      setIsDetailsSheetVisible(false);
                      setIsKeyMomentsSheetVisible(false);
                      setIsChaptersSheetVisible(true);
                    }}
                    style={({ pressed }) => [
                      styles.iconPillButton,
                      chapters.length === 0 && styles.chaptersButtonDisabled,
                      pressed && chapters.length > 0 && styles.chaptersButtonPressed,
                    ]}
                  >
                    <Ionicons name="book-outline" size={18} color="#1A2332" />
                  </Pressable>
                </View>
                <Text style={styles.meta}>
                  {selectedVideo.channelName} ·{" "}
                  {formatPublished(selectedVideo.createdAtMs)}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Open video details"
                  onPress={() => {
                    setIsKeyMomentsSheetVisible(false);
                    setIsChaptersSheetVisible(false);
                    setIsDetailsSheetVisible(true);
                  }}
                  style={({ pressed }) => [
                    styles.detailsCard,
                    pressed && styles.detailsCardPressed,
                  ]}
                >
                  <View style={styles.detailsCardHeader}>
                    <Text style={styles.detailsCardTitle}>Description</Text>
                    <Text style={styles.detailsCardMore}>more</Text>
                  </View>
                  <Text numberOfLines={2} style={summary ? styles.summary : styles.summaryPending}>
                    {summaryPreview}
                  </Text>
                  {previewTags.length > 0 ? (
                    <View style={styles.tagsWrap}>
                      {previewTags.map((tag) => (
                        <View key={`${selectedVideo.muxAssetId}-${tag}`} style={styles.tagPill}>
                          <Text style={styles.tagText}>#{tag}</Text>
                        </View>
                      ))}
                    </View>
                  ) : null}
                </Pressable>
              </View>
              <Text style={styles.upNextTitle}>Up next</Text>
            </View>
          }
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Text style={styles.emptyText}>
                {feedVideos === undefined
                  ? "Loading recommendations..."
                  : "No more videos right now"}
              </Text>
            </View>
          }
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.mainSheetContent}
        />
      </View>

      <DraggableSheetModal
        visible={isDetailsSheetVisible}
        title="Description"
        subtitle={selectedVideo.title}
        closeAccessibilityLabel="Close video details"
        playerSectionHeight={playerSectionHeight}
        sheetHeight={sheetHeight}
        bottomInset={Math.max(insets.bottom, 18)}
        onClose={() => setIsDetailsSheetVisible(false)}
      >
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.sheetContent}
        >
          <Text style={styles.sheetMeta}>
            {selectedVideo.channelName} · {formatPublished(selectedVideo.createdAtMs)}
          </Text>
          <Text style={summary ? styles.sheetSummary : styles.summaryPending}>
            {summaryPreview}
          </Text>

          {tags.length > 0 ? (
            <View style={styles.sheetSection}>
              <Text style={styles.sheetSectionTitle}>Tags</Text>
              <View style={styles.tagsWrap}>
                {tags.map((tag) => (
                  <View key={`${selectedVideo.muxAssetId}-${tag}`} style={styles.tagPill}>
                    <Text style={styles.tagText}>#{tag}</Text>
                  </View>
                ))}
              </View>
            </View>
          ) : null}
        </ScrollView>
      </DraggableSheetModal>

      <DraggableSheetModal
        visible={isKeyMomentsSheetVisible}
        title="Key Moments"
        subtitle={selectedVideo.title}
        closeAccessibilityLabel="Close key moments"
        playerSectionHeight={playerSectionHeight}
        sheetHeight={sheetHeight}
        bottomInset={Math.max(insets.bottom, 18)}
        onClose={() => setIsKeyMomentsSheetVisible(false)}
      >
        {selectedVideo.keyMomentsUnavailableReason ? (
          <View style={styles.keyMomentsState}>
            <Text style={styles.sheetSummary}>{selectedVideo.keyMomentsUnavailableReason}</Text>
          </View>
        ) : keyMoments.length > 0 ? (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.keyMomentsScrollContent}
          >
            {keyMoments.map((moment: FeedVideoKeyMoment, index) => {
              const cuePreview = getCuePreview(moment.cues);
              const visualConcepts =
                moment.notableVisualConcepts.slice(0, 2).map((item) => item.concept) ?? [];
              const conceptPills = [
                ...moment.notableAudibleConcepts.slice(0, 3),
                ...visualConcepts,
              ].slice(0, 4);

              return (
                <Pressable
                  key={`${selectedVideo.muxAssetId}-${moment.startMs}-${index}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Jump to key moment ${index + 1}`}
                  onPress={() => {
                    setSeekToSeconds(moment.startMs / 1000);
                  }}
                  style={({ pressed }) => [
                    styles.keyMomentCard,
                    pressed ? styles.detailsCardPressed : undefined,
                  ]}
                >
                  <View style={styles.keyMomentHeader}>
                    <Text style={styles.keyMomentTime}>
                      {formatMomentRange(moment.startMs, moment.endMs)}
                    </Text>
                    {typeof moment.overallScore === "number" ? (
                      <View style={styles.keyMomentScorePill}>
                        <Text style={styles.keyMomentScoreText}>
                          {Math.round(moment.overallScore * 100)}%
                        </Text>
                      </View>
                    ) : null}
                  </View>
                  <Text style={styles.keyMomentTitle}>
                    {moment.title?.trim() || `Moment ${index + 1}`}
                  </Text>
                  {moment.audibleNarrative ? (
                    <Text style={styles.keyMomentNarrative}>{moment.audibleNarrative}</Text>
                  ) : null}
                  {moment.visualNarrative ? (
                    <Text style={styles.keyMomentVisual}>{moment.visualNarrative}</Text>
                  ) : null}
                  {cuePreview ? (
                    <Text style={styles.keyMomentCuePreview} numberOfLines={3}>
                      {cuePreview}
                    </Text>
                  ) : null}
                  {conceptPills.length > 0 ? (
                    <View style={styles.tagsWrap}>
                      {conceptPills.map((concept) => (
                        <View
                          key={`${moment.startMs}-${concept}`}
                          style={styles.keyMomentConceptPill}
                        >
                          <Text style={styles.keyMomentConceptText}>{concept}</Text>
                        </View>
                      ))}
                    </View>
                  ) : null}
                </Pressable>
              );
            })}
          </ScrollView>
        ) : (
          <View style={styles.keyMomentsState}>
            <Text style={styles.summaryPending}>
              {selectedVideo.keyMomentsGeneratedAtMs
                ? "No key moments were returned for this video."
                : "Key moments are not ready yet for this video."}
            </Text>
          </View>
        )}
      </DraggableSheetModal>

      <DraggableSheetModal
        visible={isAssistantSheetVisible}
        title="Ask Robotube"
        subtitle={selectedVideo.title}
        closeAccessibilityLabel="Close video assistant"
        playerSectionHeight={playerSectionHeight}
        sheetHeight={assistantSheetHeight}
        bottomInset={Math.max(insets.bottom, 18)}
        onClose={() => setIsAssistantSheetVisible(false)}
      >
        <KeyboardAvoidingView
          style={styles.chatKeyboardAvoider}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          keyboardVerticalOffset={0}
        >
          {isPreparingAssistantThread && !assistantThreadId ? (
            <View style={styles.chatLoadingState}>
              <Text style={styles.summaryPending}>Starting chat...</Text>
            </View>
          ) : assistantThreadId ? (
            <VideoAssistantThread threadId={assistantThreadId} />
          ) : (
            <View style={styles.chatLoadingState}>
              <Text style={styles.summaryPending}>Chat is unavailable right now.</Text>
            </View>
          )}
        </KeyboardAvoidingView>
      </DraggableSheetModal>

      <DraggableSheetModal
        visible={isChaptersSheetVisible}
        title="Chapters"
        subtitle={selectedVideo.title}
        closeAccessibilityLabel="Close video chapters"
        playerSectionHeight={playerSectionHeight}
        sheetHeight={sheetHeight}
        bottomInset={Math.max(insets.bottom, 18)}
        onClose={() => setIsChaptersSheetVisible(false)}
      >
        <View style={styles.chapterSheetBody}>
          {chapters.length > 0 ? (
            <View style={styles.chapterSheetCard}>
              <ScrollView
                showsVerticalScrollIndicator={false}
                contentContainerStyle={styles.chapterSheetScrollContent}
              >
                {chapters.map((chapter) => {
                  const isActive = activeChapterStartTime === chapter.startTime;
                  const timeLabel = formatDuration(chapter.startTime) ?? "0:00";

                  return (
                    <Pressable
                      key={`${selectedVideo.muxAssetId}-${chapter.startTime}-${chapter.title}`}
                      onPress={() => {
                        setSeekToSeconds(chapter.startTime);
                      }}
                      style={({ pressed }) => [
                        styles.chapterRow,
                        isActive && styles.chapterRowActive,
                        pressed && styles.chapterRowPressed,
                      ]}
                    >
                      <Text style={styles.chapterTime}>{timeLabel}</Text>
                      <Text style={styles.chapterLabel}>{chapter.title}</Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            </View>
          ) : (
            <View style={styles.chapterSheetEmptyState}>
              <Text style={styles.summaryPending}>
                Chapters are not ready yet for this video.
              </Text>
            </View>
          )}
        </View>
      </DraggableSheetModal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#FFFFFF",
  },
  mainSheet: {
    flexShrink: 0,
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 10,
  },
  mainSheetContent: {
    paddingBottom: 24,
  },
  videoWrap: {
    width: "100%",
    aspectRatio: 16 / 9,
    backgroundColor: "#000",
    position: "relative",
  },
  video: {
    width: "100%",
    height: "100%",
  },
  metaWrap: {
    paddingHorizontal: 14,
    paddingTop: 12,
    gap: 10,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
  },
  title: {
    flex: 1,
    fontSize: 18,
    lineHeight: 24,
    fontWeight: "700",
    color: "#111111",
  },
  iconPillButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#F3F6FB",
  },
  robotIconBadge: {
    overflow: "hidden",
  },
  robotIconImage: {
    width: 22,
    height: 22,
    borderRadius: 11,
  },
  chaptersButtonDisabled: {
    opacity: 0.45,
  },
  chaptersButtonPressed: {
    opacity: 0.8,
  },
  buttonPressed: {
    opacity: 0.8,
  },
  meta: {
    fontSize: 14,
    color: "#606060",
  },
  summary: {
    fontSize: 14,
    lineHeight: 20,
    color: "#232323",
  },
  summaryPending: {
    fontSize: 13,
    lineHeight: 18,
    color: "#7D7D7D",
  },
  detailsCard: {
    backgroundColor: "#F5F7FB",
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 8,
  },
  detailsCardPressed: {
    opacity: 0.86,
  },
  detailsCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  detailsCardTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#202B3D",
  },
  detailsCardMore: {
    fontSize: 13,
    fontWeight: "700",
    color: "#202B3D",
    textTransform: "lowercase",
  },
  tagsWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  tagPill: {
    borderRadius: 999,
    backgroundColor: "#FFE4F4",
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  tagText: {
    fontSize: 12,
    lineHeight: 16,
    color: "#FF33B7",
    fontWeight: "600",
  },
  upNextTitle: {
    marginTop: 18,
    marginBottom: 8,
    paddingHorizontal: 14,
    fontSize: 16,
    fontWeight: "700",
    color: "#151515",
  },
  chapterRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#F5D0E5",
    backgroundColor: "#FFFFFF",
  },
  chapterRowActive: {
    backgroundColor: "#FFF0F8",
  },
  chapterRowPressed: {
    opacity: 0.8,
  },
  chapterTime: {
    width: 46,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "700",
    color: "#D6368B",
  },
  chapterLabel: {
    flex: 1,
    fontSize: 14,
    lineHeight: 18,
    color: "#1A2332",
    fontWeight: "600",
  },
  emptyWrap: {
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  emptyText: {
    fontSize: 14,
    color: "#666",
  },
  sheetOverlay: {
    flex: 1,
    justifyContent: "flex-start",
  },
  sheetBackdrop: {
    backgroundColor: "transparent",
  },
  sheetCard: {
    flexShrink: 0,
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 10,
  },
  sheetHandle: {
    width: 42,
    height: 5,
    borderRadius: 999,
    backgroundColor: "#D6DDE8",
    alignSelf: "center",
  },
  sheetHeader: {
    position: "relative",
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 10,
  },
  sheetDragArea: {
    width: "100%",
    minHeight: 56,
  },
  sheetHeadingBlock: {
    gap: 4,
    paddingRight: 52,
  },
  sheetTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: "#121A2A",
  },
  sheetVideoTitle: {
    fontSize: 15,
    lineHeight: 21,
    fontWeight: "600",
    color: "#1A2332",
  },
  sheetCloseButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#F3F6FB",
  },
  sheetCloseButtonFloating: {
    position: "absolute",
    top: 12,
    right: 16,
  },
  sheetCloseButtonPressed: {
    opacity: 0.8,
  },
  sheetContent: {
    paddingHorizontal: 16,
    paddingTop: 4,
    gap: 14,
  },
  sheetMeta: {
    fontSize: 13,
    color: "#5A6475",
  },
  sheetSummary: {
    fontSize: 15,
    lineHeight: 22,
    color: "#1A2332",
  },
  sheetSection: {
    gap: 10,
  },
  sheetSectionTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#344055",
  },
  chapterSheetBody: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 6,
  },
  chapterSheetCard: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#F5D0E5",
    borderRadius: 16,
    backgroundColor: "#FFFFFF",
    overflow: "hidden",
  },
  chapterSheetScrollContent: {
    paddingBottom: 12,
  },
  chapterSheetEmptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  keyMomentsState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
    gap: 12,
  },
  keyMomentsScrollContent: {
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 20,
    gap: 12,
  },
  keyMomentCard: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#F5D0E5",
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 14,
    paddingVertical: 14,
    gap: 10,
  },
  keyMomentHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  keyMomentTime: {
    flex: 1,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "700",
    color: "#D6368B",
  },
  keyMomentScorePill: {
    borderRadius: 999,
    backgroundColor: "#FFF0F8",
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  keyMomentScoreText: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "700",
    color: "#D6368B",
  },
  keyMomentTitle: {
    fontSize: 16,
    lineHeight: 22,
    fontWeight: "800",
    color: "#121A2A",
  },
  keyMomentNarrative: {
    fontSize: 14,
    lineHeight: 20,
    color: "#1A2332",
  },
  keyMomentVisual: {
    fontSize: 13,
    lineHeight: 18,
    color: "#5A6475",
  },
  keyMomentCuePreview: {
    fontSize: 13,
    lineHeight: 19,
    color: "#435066",
  },
  keyMomentConceptPill: {
    borderRadius: 999,
    backgroundColor: "#FFF0F8",
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  keyMomentConceptText: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "600",
    color: "#344055",
  },
  chatSheetBody: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 6,
    gap: 10,
  },
  chatKeyboardAvoider: {
    flex: 1,
  },
  chatMessagesScroll: {
    flex: 1,
  },
  chatMessagesContent: {
    flexGrow: 1,
    paddingTop: 4,
    paddingBottom: 8,
    gap: 10,
  },
  chatEmptyState: {
    gap: 8,
    paddingVertical: 12,
  },
  chatLoadMoreButton: {
    alignSelf: "center",
    borderRadius: 999,
    backgroundColor: "#F3F6FB",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chatLoadMoreText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#344055",
  },
  chatBubble: {
    maxWidth: "88%",
    flexShrink: 1,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  chatBubbleUser: {
    alignSelf: "flex-end",
    backgroundColor: "#FF33B7",
  },
  chatBubbleAssistant: {
    alignSelf: "flex-start",
    backgroundColor: "#F3F6FB",
  },
  chatBubbleText: {
    fontSize: 14,
    lineHeight: 20,
    flexShrink: 1,
  },
  chatBubbleTextUser: {
    color: "#FFFFFF",
  },
  chatBubbleTextAssistant: {
    color: "#1A2332",
  },
  chatComposer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 10,
    paddingBottom: 4,
  },
  chatInput: {
    flex: 1,
    minHeight: 46,
    maxHeight: 120,
    borderWidth: 1,
    borderColor: "#D5DDE8",
    borderRadius: 18,
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14,
    color: "#1A2332",
  },
  chatSendButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FF8FD7",
  },
  chatSendButtonDisabled: {
    opacity: 0.45,
  },
  chatLoadingState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  stateContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff",
    paddingHorizontal: 20,
  },
  stateTitle: {
    fontSize: 18,
    fontWeight: "600",
    color: "#161616",
    textAlign: "center",
  },
});
