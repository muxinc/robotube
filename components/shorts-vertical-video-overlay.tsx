import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { memo, useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { formatDuration, type FeedVideoItem } from "@/components/feed-video-card";
import {
  SHORTS_MAX_FONT_SIZE_MULTIPLIER,
  SHORTS_MIN_TOUCH_TARGET_PX,
  buildShortsExpandTitleCopy,
  buildShortsOpenDetailCopy,
  buildShortsRetryCopy,
  buildShortsSoundControlCopy,
} from "@/lib/shorts/shorts-accessibility";
import type { ShortsOverlayInsets } from "@/lib/shorts/shorts-viewport";

const MUX_CONTROLS_CLEARANCE_PX = 58;

export type ShortsVerticalVideoOverlayProps = {
  item: FeedVideoItem;
  /** Safe-area and tab-bar aware padding for the overlay band. */
  insets: ShortsOverlayInsets;
  isMuted: boolean;
  hasError: boolean;
  /** True when the end of the feed has been reached on this page. */
  isFeedExhausted: boolean;
  onToggleMute: () => void;
  onRetry: () => void;
  onOpenDetail: () => void;
};

/**
 * The v1 Shorts content overlay: channel identity, title, sound, and a route
 * into video detail. Mux's custom UI owns transport and timeline controls.
 *
 * Every control here maps to real Robotube behaviour. There is deliberately no
 * like, comment, follow, share, or view count: those need persistent backends,
 * and a local-only counter would be fake engagement.
 */
function ShortsVerticalVideoOverlayComponent({
  item,
  insets,
  isMuted,
  hasError,
  isFeedExhausted,
  onToggleMute,
  onRetry,
  onOpenDetail,
}: ShortsVerticalVideoOverlayProps) {
  /*
    Expansion is per-video, and this component is inside a recycled cell. Without
    resetting on the asset id, scrolling onto a reused cell would inherit the
    previous video's expanded title. Deriving it during render rather than in an
    effect means the reused cell never paints one frame in the wrong state.
  */
  const [titleState, setTitleState] = useState({
    muxAssetId: item.muxAssetId,
    isExpanded: false,
  });
  const isTitleExpanded =
    titleState.muxAssetId === item.muxAssetId && titleState.isExpanded;
  if (titleState.muxAssetId !== item.muxAssetId) {
    setTitleState({ muxAssetId: item.muxAssetId, isExpanded: false });
  }
  const toggleTitle = useCallback(
    () =>
      setTitleState((current) => ({
        muxAssetId: item.muxAssetId,
        isExpanded:
          current.muxAssetId === item.muxAssetId ? !current.isExpanded : true,
      })),
    [item.muxAssetId],
  );

  const soundCopy = buildShortsSoundControlCopy(isMuted);
  const detailCopy = buildShortsOpenDetailCopy(item.title);
  const retryCopy = buildShortsRetryCopy();
  const expandCopy = buildShortsExpandTitleCopy(isTitleExpanded);
  const durationLabel = formatDuration(item.durationSeconds);
  const channelInitial = item.channelName.trim().charAt(0).toUpperCase() || "R";

  return (
    <View style={styles.root} pointerEvents="box-none">
      {/*
        The gradient is the contrast floor for the white overlay text over an
        arbitrary video frame. It must not intercept touches: the media surface
        underneath owns tap-to-pause.
      */}
      <LinearGradient
        colors={["transparent", "rgba(0,0,0,0.35)", "rgba(0,0,0,0.82)"]}
        locations={[0, 0.45, 1]}
        style={styles.gradient}
        pointerEvents="none"
      />

      {hasError ? (
        <View style={styles.errorLayer} pointerEvents="box-none">
          <Text
            style={styles.errorText}
            maxFontSizeMultiplier={SHORTS_MAX_FONT_SIZE_MULTIPLIER}
          >
            This video could not be played.
          </Text>
          <Pressable
            onPress={onRetry}
            accessibilityRole="button"
            accessibilityLabel={retryCopy.label}
            accessibilityHint={retryCopy.hint}
            hitSlop={8}
            style={pressedStyle(styles.retryButton)}
          >
            <Ionicons name="refresh" size={18} color="#0B0B0F" />
            <Text
              style={styles.retryText}
              maxFontSizeMultiplier={SHORTS_MAX_FONT_SIZE_MULTIPLIER}
            >
              Retry
            </Text>
          </Pressable>
        </View>
      ) : null}

      {/*
        Mux's custom controls intentionally do not include a sound button.
        Preserve the session-scoped mute action without duplicating a Mux
        transport control.
      */}
      <Pressable
        onPress={onToggleMute}
        accessibilityRole="button"
        accessibilityLabel={soundCopy.label}
        accessibilityHint={soundCopy.hint}
        accessibilityValue={{ text: soundCopy.value }}
        accessibilityState={{ selected: !isMuted }}
        hitSlop={8}
        style={({ pressed }) => [
          styles.soundButton,
          { top: insets.paddingTop },
          pressed && styles.pressed,
        ]}
      >
        <Ionicons
          name={isMuted ? "volume-mute" : "volume-high"}
          size={22}
          color="#FFFFFF"
        />
      </Pressable>

      <View
        style={[
          styles.metaBand,
          { paddingBottom: insets.paddingBottom + MUX_CONTROLS_CLEARANCE_PX },
        ]}
        pointerEvents="box-none"
      >
        {isFeedExhausted ? (
          <View style={styles.exhaustedPill} pointerEvents="none">
            <Text
              style={styles.exhaustedText}
              maxFontSizeMultiplier={SHORTS_MAX_FONT_SIZE_MULTIPLIER}
            >
              You&apos;re all caught up
            </Text>
          </View>
        ) : null}

        <Pressable
          onPress={onOpenDetail}
          accessibilityRole="button"
          accessibilityLabel={detailCopy.label}
          accessibilityHint={detailCopy.hint}
          style={pressedStyle(styles.channelRow)}
        >
          <View style={styles.avatar}>
            {item.channelAvatarUrl ? (
              <Image
                source={{ uri: item.channelAvatarUrl }}
                recyclingKey={item.muxAssetId}
                contentFit="cover"
                cachePolicy="memory-disk"
                transition={0}
                style={styles.avatarImage}
              />
            ) : (
              <Text
                style={styles.avatarText}
                maxFontSizeMultiplier={SHORTS_MAX_FONT_SIZE_MULTIPLIER}
              >
                {channelInitial}
              </Text>
            )}
          </View>
          <Text
            numberOfLines={1}
            ellipsizeMode="tail"
            style={styles.channelName}
            maxFontSizeMultiplier={SHORTS_MAX_FONT_SIZE_MULTIPLIER}
          >
            {item.channelName}
          </Text>
          {durationLabel ? (
            <Text
              style={styles.duration}
              maxFontSizeMultiplier={SHORTS_MAX_FONT_SIZE_MULTIPLIER}
            >
              {durationLabel}
            </Text>
          ) : null}
        </Pressable>

        {/*
          The title is its own control so a long title can be expanded without
          opening detail, and so screen readers get a title action separate from
          the channel/detail action.
        */}
        <Pressable
          onPress={toggleTitle}
          accessibilityRole="button"
          accessibilityLabel={expandCopy.label}
          accessibilityHint={expandCopy.hint}
          accessibilityState={{ expanded: isTitleExpanded }}
          style={styles.titleButton}
        >
          <Text
            numberOfLines={isTitleExpanded ? 6 : 2}
            style={styles.title}
            maxFontSizeMultiplier={SHORTS_MAX_FONT_SIZE_MULTIPLIER}
          >
            {item.title}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const pressedStyle =
  (base: object) =>
  ({ pressed }: { pressed: boolean }) => [base, pressed && styles.pressed];

export const ShortsVerticalVideoOverlay = memo(ShortsVerticalVideoOverlayComponent);

ShortsVerticalVideoOverlay.displayName = "ShortsVerticalVideoOverlay";

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
  },
  gradient: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: "42%",
  },
  errorLayer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    paddingHorizontal: 32,
    backgroundColor: "#000000A6",
  },
  errorText: {
    color: "#FFFFFF",
    fontSize: 15,
    lineHeight: 21,
    textAlign: "center",
    fontWeight: "600",
  },
  retryButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    minHeight: SHORTS_MIN_TOUCH_TARGET_PX,
    paddingHorizontal: 20,
    borderRadius: SHORTS_MIN_TOUCH_TARGET_PX / 2,
    backgroundColor: "#FFFFFF",
  },
  retryText: {
    color: "#0B0B0F",
    fontSize: 15,
    fontWeight: "700",
  },
  soundButton: {
    position: "absolute",
    right: 12,
    width: SHORTS_MIN_TOUCH_TARGET_PX,
    height: SHORTS_MIN_TOUCH_TARGET_PX,
    borderRadius: SHORTS_MIN_TOUCH_TARGET_PX / 2,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#00000099",
  },
  pressed: {
    opacity: 0.72,
  },
  metaBand: {
    position: "absolute",
    left: 0,
    bottom: 0,
    // The Mux timeline/time/settings row owns the bottom of the player.
    right: 16,
    paddingLeft: 16,
    gap: 8,
  },
  exhaustedPill: {
    alignSelf: "flex-start",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: "#000000A6",
  },
  exhaustedText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "600",
  },
  channelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: SHORTS_MIN_TOUCH_TARGET_PX,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#FF4FA7",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#FFFFFF66",
  },
  avatarImage: {
    width: "100%",
    height: "100%",
  },
  avatarText: {
    color: "#FFFFFF",
    fontWeight: "700",
    fontSize: 15,
  },
  channelName: {
    flexShrink: 1,
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "700",
    textShadowColor: "#000000B3",
    textShadowRadius: 4,
  },
  duration: {
    color: "#FFFFFFD9",
    fontSize: 12,
    fontWeight: "600",
    textShadowColor: "#000000B3",
    textShadowRadius: 4,
  },
  titleButton: {
    paddingBottom: 4,
  },
  title: {
    color: "#FFFFFF",
    fontSize: 14,
    lineHeight: 19,
    fontWeight: "500",
    textShadowColor: "#000000B3",
    textShadowRadius: 4,
  },
});
