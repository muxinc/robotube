import { Ionicons } from "@expo/vector-icons";
import {
  AudioSession,
  isLiveKitAvailable,
  isTrackReference,
  LiveKitRoom,
  liveKitUnavailableReason,
  useLocalParticipant,
  useTracks,
  VideoTrack,
} from "@/lib/livekit";
import { useAction } from "convex/react";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  PermissionsAndroid,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Track } from "livekit-client";

import { ThemedText } from "@/components/themed-text";
import { api } from "@/convex/_generated/api";

type BroadcastSession = {
  muxLiveStreamId: string;
  playbackId: string | null;
  livekitUrl: string;
  livekitToken: string;
  livekitRoomName: string;
  broadcasterIdentity: string;
};

function BroadcastPreview({
  onReadyToBroadcast,
}: {
  onReadyToBroadcast: () => void;
}) {
  const didNotifyReadyRef = useRef(false);
  const tracks = useTracks([Track.Source.Camera], { onlySubscribed: false });
  const {
    isCameraEnabled,
    isMicrophoneEnabled,
    cameraTrack,
    microphoneTrack,
  } = useLocalParticipant();

  useEffect(() => {
    if (
      didNotifyReadyRef.current ||
      !isCameraEnabled ||
      !isMicrophoneEnabled ||
      !cameraTrack ||
      !microphoneTrack
    ) {
      return;
    }

    didNotifyReadyRef.current = true;
    onReadyToBroadcast();
  }, [
    cameraTrack,
    isCameraEnabled,
    isMicrophoneEnabled,
    microphoneTrack,
    onReadyToBroadcast,
  ]);

  const firstTrack = tracks[0];

  return (
    <View style={StyleSheet.absoluteFill}>
      {firstTrack && isTrackReference(firstTrack) ? (
        <VideoTrack trackRef={firstTrack} style={StyleSheet.absoluteFill} />
      ) : (
        <View style={styles.previewPlaceholder}>
          <ActivityIndicator color="#ffffff" />
          <ThemedText style={styles.previewPlaceholderText}>
            Connecting camera...
          </ThemedText>
        </View>
      )}
    </View>
  );
}

export default function GoLiveScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const createLiveStream = useAction((api as any).liveStreams.createLiveStream);
  const startLiveStreamEgress = useAction(
    (api as any).liveStreams.startLiveStreamEgress,
  );
  const endLiveStream = useAction((api as any).liveStreams.endLiveStream);

  const [title, setTitle] = useState("");
  const [session, setSession] = useState<BroadcastSession | null>(null);
  const [hasPermissions, setHasPermissions] = useState(Platform.OS === "ios");
  const [isCreating, setIsCreating] = useState(false);
  const [isStartingRelay, setIsStartingRelay] = useState(false);
  const [isEnding, setIsEnding] = useState(false);
  const [isLive, setIsLive] = useState(false);

  useEffect(() => {
    void AudioSession.startAudioSession();
    return () => {
      void AudioSession.stopAudioSession();
    };
  }, []);

  useEffect(() => {
    async function requestPermissions() {
      if (Platform.OS !== "android") {
        setHasPermissions(true);
        return;
      }

      const results = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.CAMERA,
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      ]);

      setHasPermissions(
        results[PermissionsAndroid.PERMISSIONS.CAMERA] ===
          PermissionsAndroid.RESULTS.GRANTED &&
          results[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO] ===
            PermissionsAndroid.RESULTS.GRANTED,
      );
    }

    void requestPermissions();
  }, []);

  const cleanupLiveStream = useCallback(
    async (muxLiveStreamId: string) => {
      try {
        await endLiveStream({ muxLiveStreamId });
      } catch (error) {
        console.warn("Failed to clean up live stream", error);
      }
    },
    [endLiveStream],
  );

  const handleGoLive = useCallback(async () => {
    if (!title.trim()) {
      Alert.alert("Title required", "Please enter a title for your stream.");
      return;
    }

    setIsCreating(true);
    try {
      const nextSession = await createLiveStream({ title: title.trim() });
      setSession(nextSession);
    } catch (error) {
      Alert.alert(
        "Unable to start live stream",
        error instanceof Error ? error.message : "Something went wrong.",
      );
    } finally {
      setIsCreating(false);
    }
  }, [createLiveStream, title]);

  const handleBroadcastReady = useCallback(async () => {
    if (!session || isLive || isStartingRelay) {
      return;
    }

    setIsStartingRelay(true);
    try {
      await startLiveStreamEgress({ muxLiveStreamId: session.muxLiveStreamId });
      setIsLive(true);
    } catch (error) {
      await cleanupLiveStream(session.muxLiveStreamId);
      setSession(null);
      Alert.alert(
        "Unable to start broadcast",
        error instanceof Error ? error.message : "Failed to relay the stream to Mux.",
      );
    } finally {
      setIsStartingRelay(false);
    }
  }, [cleanupLiveStream, isLive, isStartingRelay, session, startLiveStreamEgress]);

  const handleExit = useCallback(async () => {
    if (!session) {
      router.back();
      return;
    }

    setIsEnding(true);
    await cleanupLiveStream(session.muxLiveStreamId);
    setIsEnding(false);
    router.back();
  }, [cleanupLiveStream, router, session]);

  const handleStopStream = useCallback(() => {
    Alert.alert("End Stream", "Are you sure you want to end the live stream?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "End Stream",
        style: "destructive",
        onPress: () => {
          void handleExit();
        },
      },
    ]);
  }, [handleExit]);

  if (!isLiveKitAvailable) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <View style={styles.permissionContainer}>
          <Ionicons name="construct-outline" size={48} color="#999" />
          <ThemedText style={styles.permissionTitle}>
            Development build required
          </ThemedText>
          <ThemedText style={styles.permissionText}>
            Expo Go does not include the native LiveKit and WebRTC modules used by live streaming.
          </ThemedText>
          {liveKitUnavailableReason ? (
            <ThemedText style={styles.permissionText}>
              {liveKitUnavailableReason}
            </ThemedText>
          ) : null}
          <Pressable
            style={styles.permissionButton}
            onPress={() => {
              router.back();
            }}
          >
            <ThemedText style={styles.permissionButtonText}>Close</ThemedText>
          </Pressable>
        </View>
      </View>
    );
  }

  if (!hasPermissions) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <View style={styles.permissionContainer}>
          <Ionicons name="videocam-off-outline" size={48} color="#999" />
          <ThemedText style={styles.permissionTitle}>
            Camera & Microphone Access
          </ThemedText>
          <ThemedText style={styles.permissionText}>
            Camera and microphone permissions are required to go live.
          </ThemedText>
          <Pressable
            style={styles.permissionButton}
            onPress={() => {
              if (Platform.OS !== "android") {
                setHasPermissions(true);
                return;
              }

              void PermissionsAndroid.requestMultiple([
                PermissionsAndroid.PERMISSIONS.CAMERA,
                PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
              ]).then((results) => {
                setHasPermissions(
                  results[PermissionsAndroid.PERMISSIONS.CAMERA] ===
                    PermissionsAndroid.RESULTS.GRANTED &&
                    results[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO] ===
                      PermissionsAndroid.RESULTS.GRANTED,
                );
              });
            }}
          >
            <ThemedText style={styles.permissionButtonText}>
              Grant Permissions
            </ThemedText>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      {session ? (
        <LiveKitRoom
          serverUrl={session.livekitUrl}
          token={session.livekitToken}
          connect
          audio
          video
          onError={(error) => {
            console.warn("LiveKit connection error", error);
          }}
          onMediaDeviceFailure={(failure) => {
            if (!failure) return;
            Alert.alert(
              "Camera or microphone unavailable",
              String(failure),
            );
          }}
        >
          <BroadcastPreview onReadyToBroadcast={handleBroadcastReady} />
        </LiveKitRoom>
      ) : (
        <View style={styles.idleHero}>
          <Ionicons name="radio-outline" size={72} color="#ffffff" />
          <ThemedText style={styles.idleHeroTitle}>Go live on Robotube</ThemedText>
          <ThemedText style={styles.idleHeroText}>
            Your phone publishes into LiveKit, and LiveKit relays the broadcast to Mux for playback.
          </ThemedText>
        </View>
      )}

      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => void handleExit()} hitSlop={12}>
          <Ionicons name="close" size={28} color="#fff" />
        </Pressable>

        {isLive ? (
          <View style={styles.liveBadge}>
            <View style={styles.liveDot} />
            <ThemedText style={styles.liveBadgeText}>LIVE</ThemedText>
          </View>
        ) : session ? (
          <View style={styles.pendingBadge}>
            <ActivityIndicator color="#fff" size="small" />
            <ThemedText style={styles.pendingBadgeText}>
              Starting...
            </ThemedText>
          </View>
        ) : (
          <View style={styles.badgeSpacer} />
        )}

        <View style={styles.badgeSpacer} />
      </View>

      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 16 }]}>
        {!session ? (
          <>
            <TextInput
              style={styles.titleInput}
              placeholder="Give your stream a title..."
              placeholderTextColor="rgba(255,255,255,0.5)"
              value={title}
              onChangeText={setTitle}
              returnKeyType="done"
              maxLength={100}
            />
            <Pressable
              style={[
                styles.goLiveButton,
                (isCreating || !title.trim()) && styles.goLiveButtonDisabled,
              ]}
              onPress={() => void handleGoLive()}
              disabled={isCreating || !title.trim()}
            >
              {isCreating ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <ThemedText style={styles.goLiveButtonText}>Go Live</ThemedText>
              )}
            </Pressable>
          </>
        ) : isEnding ? (
          <View style={styles.stateCard}>
            <ActivityIndicator color="#fff" size="small" />
            <ThemedText style={styles.stateCardText}>Ending stream...</ThemedText>
          </View>
        ) : isLive ? (
          <Pressable style={styles.stopButton} onPress={handleStopStream}>
            <Ionicons name="stop-circle" size={24} color="#fff" />
            <ThemedText style={styles.stopButtonText}>End Stream</ThemedText>
          </Pressable>
        ) : (
          <View style={styles.stateCard}>
            <ActivityIndicator color="#fff" size="small" />
            <ThemedText style={styles.stateCardText}>
              Connecting LiveKit and starting the Mux relay...
            </ThemedText>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#000",
  },
  previewPlaceholder: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    backgroundColor: "#060606",
  },
  previewPlaceholderText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600",
  },
  idleHero: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 28,
    gap: 16,
  },
  idleHeroTitle: {
    color: "#fff",
    fontSize: 24,
    fontWeight: "800",
    textAlign: "center",
  },
  idleHeroText: {
    color: "rgba(255,255,255,0.72)",
    fontSize: 15,
    lineHeight: 22,
    textAlign: "center",
  },
  permissionContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    gap: 12,
  },
  permissionTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#fff",
    textAlign: "center",
  },
  permissionText: {
    fontSize: 14,
    color: "#aaa",
    textAlign: "center",
    lineHeight: 20,
  },
  permissionButton: {
    marginTop: 8,
    backgroundColor: "#E91E63",
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 24,
  },
  permissionButtonText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 15,
  },
  topBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    zIndex: 10,
  },
  liveBadge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#E91E63",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 4,
    gap: 6,
  },
  pendingBadge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(20,20,20,0.78)",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    gap: 8,
  },
  pendingBadgeText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "700",
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#fff",
  },
  liveBadgeText: {
    color: "#fff",
    fontWeight: "800",
    fontSize: 13,
    letterSpacing: 1,
  },
  badgeSpacer: {
    width: 32,
    height: 32,
  },
  bottomBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 20,
    gap: 12,
    zIndex: 10,
  },
  titleInput: {
    backgroundColor: "rgba(0,0,0,0.56)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    color: "#fff",
    fontSize: 16,
  },
  goLiveButton: {
    backgroundColor: "#E91E63",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  goLiveButtonDisabled: {
    opacity: 0.5,
  },
  goLiveButtonText: {
    color: "#fff",
    fontWeight: "800",
    fontSize: 16,
  },
  stateCard: {
    backgroundColor: "rgba(18,18,18,0.88)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  stateCardText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
  },
  stopButton: {
    backgroundColor: "rgba(220,38,38,0.92)",
    borderRadius: 12,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  stopButtonText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 16,
  },
});
