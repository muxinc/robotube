import { Ionicons } from "@expo/vector-icons";
import { Component, type ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import {
  SHORTS_MAX_FONT_SIZE_MULTIPLIER,
  SHORTS_MIN_TOUCH_TARGET_PX,
} from "@/lib/shorts/shorts-accessibility";
import type { ShortsOverlayInsets } from "@/lib/shorts/shorts-viewport";

/**
 * Full-viewport Shorts states.
 *
 * All three are black end to end. An immersive feed that flashes a white
 * skeleton between the tab press and the first poster reads as a bug, so no
 * state here introduces a light surface.
 */

export type ShortsStateScreenProps = {
  insets: ShortsOverlayInsets;
};

export function ShortsLoadingState({ insets }: ShortsStateScreenProps) {
  return (
    <View
      style={[styles.container, { paddingTop: insets.paddingTop }]}
      accessibilityRole="progressbar"
      accessibilityLabel="Loading Shorts"
      accessibilityState={{ busy: true }}
    >
      <ActivityIndicator color="#FFFFFF" />
    </View>
  );
}

export type ShortsEmptyStateProps = ShortsStateScreenProps & {
  onOpenUpload: () => void;
};

export function ShortsEmptyState({ insets, onOpenUpload }: ShortsEmptyStateProps) {
  return (
    <View
      style={[
        styles.container,
        styles.copyContainer,
        { paddingTop: insets.paddingTop, paddingBottom: insets.paddingBottom },
      ]}
    >
      <Ionicons name="phone-portrait-outline" size={44} color="#FFFFFFCC" />
      <Text
        style={styles.title}
        maxFontSizeMultiplier={SHORTS_MAX_FONT_SIZE_MULTIPLIER}
        accessibilityRole="header"
      >
        No Shorts yet
      </Text>
      {/*
        States the requirement exactly. 4:5 and 2:3 uploads are not "close
        enough" — they stay on Home — and saying so here is cheaper than an
        uploader wondering why their portrait video never appeared.
      */}
      <Text
        style={styles.body}
        maxFontSizeMultiplier={SHORTS_MAX_FONT_SIZE_MULTIPLIER}
      >
        Videos with an exact 9:16 aspect ratio show up here. Everything else stays
        on Home.
      </Text>
      <Pressable
        onPress={onOpenUpload}
        accessibilityRole="button"
        accessibilityLabel="Upload a video"
        accessibilityHint="Opens the upload tab"
        hitSlop={8}
        style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
      >
        <Ionicons name="add-circle-outline" size={20} color="#0B0B0F" />
        <Text
          style={styles.primaryButtonText}
          maxFontSizeMultiplier={SHORTS_MAX_FONT_SIZE_MULTIPLIER}
        >
          Upload a video
        </Text>
      </Pressable>
    </View>
  );
}

export type ShortsErrorStateProps = ShortsStateScreenProps & {
  onRetry: () => void;
};

export function ShortsErrorState({ insets, onRetry }: ShortsErrorStateProps) {
  return (
    <View
      style={[
        styles.container,
        styles.copyContainer,
        { paddingTop: insets.paddingTop, paddingBottom: insets.paddingBottom },
      ]}
    >
      <Ionicons name="cloud-offline-outline" size={44} color="#FFFFFFCC" />
      <Text
        style={styles.title}
        maxFontSizeMultiplier={SHORTS_MAX_FONT_SIZE_MULTIPLIER}
        accessibilityRole="header"
      >
        Shorts is unavailable
      </Text>
      <Text
        style={styles.body}
        maxFontSizeMultiplier={SHORTS_MAX_FONT_SIZE_MULTIPLIER}
      >
        We could not load the vertical feed. Check your connection and try again —
        Home is still available.
      </Text>
      <Pressable
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel="Try loading Shorts again"
        hitSlop={8}
        style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
      >
        <Ionicons name="refresh" size={20} color="#0B0B0F" />
        <Text
          style={styles.primaryButtonText}
          maxFontSizeMultiplier={SHORTS_MAX_FONT_SIZE_MULTIPLIER}
        >
          Try again
        </Text>
      </Pressable>
    </View>
  );
}

type ShortsQueryErrorBoundaryProps = {
  /**
   * Changing this remounts the subtree, which is how a retry re-runs a query
   * that threw during render.
   */
  resetKey: number;
  fallback: ReactNode;
  onError?: (message: string) => void;
  children: ReactNode;
};

type ShortsQueryErrorBoundaryState = {
  hasError: boolean;
  resetKey: number;
};

/**
 * Contains a failing Shorts query inside the Shorts tab.
 *
 * Convex's `usePaginatedQuery` re-throws a query error during render, so without
 * a boundary a missing or failing `listVerticalFeedVideosPaginated` would unwind
 * past this screen and take the tab host down with it. Catching it here is what
 * makes "a Shorts query failure has no impact on Home" true, and it is also what
 * lets this screen ship before the vertical query exists server-side.
 */
export class ShortsQueryErrorBoundary extends Component<
  ShortsQueryErrorBoundaryProps,
  ShortsQueryErrorBoundaryState
> {
  state: ShortsQueryErrorBoundaryState = {
    hasError: false,
    resetKey: this.props.resetKey,
  };

  static getDerivedStateFromError(): Partial<ShortsQueryErrorBoundaryState> {
    return { hasError: true };
  }

  static getDerivedStateFromProps(
    props: ShortsQueryErrorBoundaryProps,
    state: ShortsQueryErrorBoundaryState,
  ): Partial<ShortsQueryErrorBoundaryState> | null {
    if (props.resetKey !== state.resetKey) {
      return { hasError: false, resetKey: props.resetKey };
    }
    return null;
  }

  componentDidCatch(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    this.props.onError?.(message);
  }

  render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000000",
    alignItems: "center",
    justifyContent: "center",
  },
  copyContainer: {
    gap: 12,
    paddingHorizontal: 32,
  },
  title: {
    color: "#FFFFFF",
    fontSize: 20,
    fontWeight: "700",
    textAlign: "center",
  },
  body: {
    color: "#FFFFFFB3",
    fontSize: 15,
    lineHeight: 21,
    textAlign: "center",
  },
  primaryButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 8,
    minHeight: SHORTS_MIN_TOUCH_TARGET_PX,
    paddingHorizontal: 22,
    borderRadius: SHORTS_MIN_TOUCH_TARGET_PX / 2,
    backgroundColor: "#FFFFFF",
  },
  primaryButtonText: {
    color: "#0B0B0F",
    fontSize: 15,
    fontWeight: "700",
  },
  pressed: {
    opacity: 0.75,
  },
});
