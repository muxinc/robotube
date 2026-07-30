import { useEffect, useMemo, useState } from "react";
import {
  AccessibilityInfo,
  AppState,
  PixelRatio,
  useWindowDimensions,
} from "react-native";

import {
  classifyDevice,
  resolveFeedMediaPolicy,
  type FeedMediaPolicy,
  type FeedNetworkClass,
} from "@/lib/feed/feed-adaptive-policy";

export type UseFeedAdaptivePolicyOptions = {
  /**
   * Network classification provider.
   *
   * The app has no network-reachability dependency installed, so the default is
   * `"unknown"`, which resolves to a conservative policy: autoplay stays on,
   * media preload stays off (it requires a confirmed `"wifi"`). Wiring a real
   * provider (NetInfo or an equivalent) is a rollout dependency, not a
   * behavioural change — pass one here and the policy tightens automatically.
   */
  networkClass?: FeedNetworkClass;
  /** Explicit low-data preference when the host app knows one. */
  prefersLowData?: boolean;
};

/**
 * Resolves device class, accessibility preferences, and resource pressure into
 * the feed's media policy.
 */
export function useFeedAdaptivePolicy({
  networkClass = "unknown",
  prefersLowData = false,
}: UseFeedAdaptivePolicyOptions = {}): FeedMediaPolicy {
  const { width, height } = useWindowDimensions();
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [isMemoryPressured, setIsMemoryPressured] = useState(false);

  useEffect(() => {
    let isMounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (isMounted) setPrefersReducedMotion(enabled);
      })
      .catch(() => {
        // Reduced-motion is unavailable on some platforms; keep the default.
      });

    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      (enabled) => setPrefersReducedMotion(enabled),
    );
    return () => {
      isMounted = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener("memoryWarning", () => {
      setIsMemoryPressured(true);
    });
    const changeSubscription = AppState.addEventListener("change", (nextState) => {
      // Returning to the foreground clears the latch so a single transient
      // warning does not disable previews for the rest of the session.
      if (nextState === "active") setIsMemoryPressured(false);
    });
    return () => {
      subscription.remove();
      changeSubscription.remove();
    };
  }, []);

  const pixelRatio = PixelRatio.get();
  const shortestSideDp = Math.min(width, height);

  return useMemo(
    () =>
      resolveFeedMediaPolicy({
        deviceClass: classifyDevice({ shortestSideDp, pixelRatio }),
        networkClass,
        prefersReducedMotion,
        prefersLowData,
        pressure: { memory: isMemoryPressured },
      }),
    [
      isMemoryPressured,
      networkClass,
      pixelRatio,
      prefersLowData,
      prefersReducedMotion,
      shortestSideDp,
    ],
  );
}
