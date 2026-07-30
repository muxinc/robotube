import { useQuery } from "convex/react";
import {
  createContext,
  useContext,
  useMemo,
  type PropsWithChildren,
} from "react";
import { Platform } from "react-native";

import { api } from "@/convex/_generated/api";
import {
  resolveFeedFeatureFlags,
  type FeedFeatureFlagContext,
  type FeedFeatureFlagKey,
  type FeedFeatureFlagResolutions,
} from "@/lib/feed-feature-flags";

type VerticalFeedFlagSnapshot = {
  shortsTabEnabled: boolean;
  exclusiveFeedPlacementEnabled: boolean;
  resolutions: FeedFeatureFlagResolutions | null;
};

const DISABLED_SNAPSHOT: VerticalFeedFlagSnapshot = {
  shortsTabEnabled: false,
  exclusiveFeedPlacementEnabled: false,
  resolutions: null,
};

const FeedFeatureFlagsContext =
  createContext<VerticalFeedFlagSnapshot>(DISABLED_SNAPSHOT);

function runtimePlatform(): FeedFeatureFlagContext["platform"] {
  if (Platform.OS === "ios" || Platform.OS === "android") return Platform.OS;
  return "other";
}

function readDevelopmentOverride(
  value: string | undefined,
): boolean | undefined {
  if (typeof __DEV__ === "undefined" || !__DEV__) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/**
 * One Convex subscription and one resolved snapshot for the entire app.
 *
 * Keeping the tab, Home query, and Shorts route on the same context value avoids
 * a transient state where one consumer has received a rollback and another has
 * not. The provider fails closed while the remote row is loading or absent.
 */
export function FeedFeatureFlagsProvider({
  children,
}: PropsWithChildren) {
  const remote = useQuery(
    (api as any).feedRuntimeConfig.getVerticalFeedFlags,
    {},
  ) as
    | {
        shortsTabEnabled: boolean;
        exclusiveFeedPlacementEnabled: boolean;
        androidPhysicalValidationCompleted: boolean;
      }
    | undefined;

  const value = useMemo<VerticalFeedFlagSnapshot>(() => {
    const overrides: Partial<Record<FeedFeatureFlagKey, boolean>> = {};
    const shortsOverride = readDevelopmentOverride(
      process.env.EXPO_PUBLIC_SHORTS_TAB_ENABLED,
    );
    const exclusiveOverride = readDevelopmentOverride(
      process.env.EXPO_PUBLIC_EXCLUSIVE_FEED_PLACEMENT_ENABLED,
    );
    if (shortsOverride !== undefined) {
      overrides.shortsTabEnabled = shortsOverride;
    }
    if (exclusiveOverride !== undefined) {
      overrides.exclusiveFeedPlacementEnabled = exclusiveOverride;
    }

    const resolutions = resolveFeedFeatureFlags({
      platform: runtimePlatform(),
      remote:
        remote === undefined
          ? undefined
          : {
              shortsTabEnabled: remote.shortsTabEnabled === true,
              exclusiveFeedPlacementEnabled:
                remote.exclusiveFeedPlacementEnabled === true,
            },
      overrides,
      androidPhysicalValidationCompleted:
        remote?.androidPhysicalValidationCompleted === true,
    });

    return {
      shortsTabEnabled: resolutions.shortsTabEnabled.enabled,
      // Defense in depth: even if a future resolver regresses its dependency
      // gate, the client never selects exclusive Home without a reachable tab.
      exclusiveFeedPlacementEnabled:
        resolutions.shortsTabEnabled.enabled &&
        resolutions.exclusiveFeedPlacementEnabled.enabled,
      resolutions,
    };
  }, [remote]);

  return (
    <FeedFeatureFlagsContext.Provider value={value}>
      {children}
    </FeedFeatureFlagsContext.Provider>
  );
}

export function useFeedFeatureFlags(): VerticalFeedFlagSnapshot {
  return useContext(FeedFeatureFlagsContext);
}
