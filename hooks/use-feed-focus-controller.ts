import { type ViewToken } from "@shopify/flash-list";
import { useCallback, useEffect, useRef, useState } from "react";
import { type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";

const TOP_LOCK_OFFSET_PX = 12;

export function useFeedFocusController<T>() {
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [isScrollSettling, setIsScrollSettling] = useState(false);
  const isScrollSettlingRef = useRef(false);
  const pendingFocusedIndexRef = useRef(0);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollOffsetYRef = useRef(0);

  useEffect(() => {
    isScrollSettlingRef.current = isScrollSettling;
  }, [isScrollSettling]);

  const clearSettleTimer = useCallback(() => {
    if (settleTimerRef.current) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }, []);

  const applyPendingFocus = useCallback(() => {
    const nextFocusedIndex = pendingFocusedIndexRef.current;
    setFocusedIndex((current) =>
      current === nextFocusedIndex ? current : nextFocusedIndex,
    );
  }, []);

  const scheduleFocusSettle = useCallback(
    (delayMs: number) => {
      clearSettleTimer();
      settleTimerRef.current = setTimeout(() => {
        setIsScrollSettling(false);
        applyPendingFocus();
        settleTimerRef.current = null;
      }, delayMs);
    },
    [applyPendingFocus, clearSettleTimer],
  );

  useEffect(
    () => () => {
      clearSettleTimer();
    },
    [clearSettleTimer],
  );

  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken<T>[] }) => {
      const viewableIndexes = viewableItems
        .map((token) => token.index)
        .filter((index): index is number => index !== null)
        .sort((a, b) => a - b);

      if (viewableIndexes.length === 0) return;

      const isNearTop = scrollOffsetYRef.current <= TOP_LOCK_OFFSET_PX;
      const nextFocusedIndex = isNearTop ? 0 : viewableIndexes[0];
      pendingFocusedIndexRef.current = nextFocusedIndex;
      if (!isScrollSettlingRef.current) {
        setFocusedIndex((current) =>
          current === nextFocusedIndex ? current : nextFocusedIndex,
        );
      }
    },
  );

  const viewabilityConfig = useRef({
    itemVisiblePercentThreshold: 65,
    minimumViewTime: 100,
  });

  const onScrollBeginDrag = useCallback(() => {
    clearSettleTimer();
    setIsScrollSettling(true);
  }, [clearSettleTimer]);

  const onScrollEndDrag = useCallback(() => {
    scheduleFocusSettle(140);
  }, [scheduleFocusSettle]);

  const onMomentumScrollBegin = useCallback(() => {
    clearSettleTimer();
    setIsScrollSettling(true);
  }, [clearSettleTimer]);

  const onMomentumScrollEnd = useCallback(() => {
    scheduleFocusSettle(80);
  }, [scheduleFocusSettle]);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollOffsetYRef.current = event.nativeEvent.contentOffset.y;
  }, []);

  return {
    focusedIndex,
    isScrollSettling,
    onViewableItemsChanged: onViewableItemsChanged.current,
    viewabilityConfig: viewabilityConfig.current,
    onScrollBeginDrag,
    onScrollEndDrag,
    onMomentumScrollBegin,
    onMomentumScrollEnd,
    onScroll,
  };
}
