import "@/lib/polyfills/dom-exception";

import type * as LiveKitReactNative from "@livekit/react-native";

type LiveKitModule = typeof LiveKitReactNative;

let livekitModule: LiveKitModule | null = null;
let livekitLoadError: unknown = null;

try {
  livekitModule = require("@livekit/react-native") as LiveKitModule;
} catch (error) {
  livekitLoadError = error;
}

function unavailableExport(name: string) {
  return () => {
    throw new Error(
      `LiveKit native module is unavailable. ${name} requires an Expo development build, not Expo Go.`,
    );
  };
}

export const isLiveKitAvailable = livekitModule !== null;
export const liveKitUnavailableReason =
  livekitLoadError instanceof Error
    ? livekitLoadError.message
    : livekitLoadError
      ? String(livekitLoadError)
      : null;

export const registerGlobals = ((options?:
  | Parameters<LiveKitModule["registerGlobals"]>[0]
  | undefined) => {
  if (!livekitModule) {
    return;
  }

  return livekitModule.registerGlobals(options);
}) as LiveKitModule["registerGlobals"];

export const AudioSession = (livekitModule?.AudioSession ?? {
  startAudioSession: async () => {},
  stopAudioSession: async () => {},
}) as LiveKitModule["AudioSession"];

export const isTrackReference = (livekitModule?.isTrackReference ??
  unavailableExport("isTrackReference")) as LiveKitModule["isTrackReference"];

export const LiveKitRoom = (livekitModule?.LiveKitRoom ??
  unavailableExport("LiveKitRoom")) as LiveKitModule["LiveKitRoom"];

export const useLocalParticipant = (livekitModule?.useLocalParticipant ??
  unavailableExport("useLocalParticipant")) as LiveKitModule["useLocalParticipant"];

export const useTracks = (livekitModule?.useTracks ??
  unavailableExport("useTracks")) as LiveKitModule["useTracks"];

export const VideoTrack = (livekitModule?.VideoTrack ??
  unavailableExport("VideoTrack")) as LiveKitModule["VideoTrack"];
