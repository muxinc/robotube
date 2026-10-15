import { Ionicons } from "@expo/vector-icons";
import { useNavigation, usePreventRemove } from "@react-navigation/native";
import { useAction, useQuery } from "convex/react";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api } from "@/convex/_generated/api";
import { captionTextError, captionTimestamp, captionTranscriptEdits, type CaptionTranscript } from "@/lib/captionTranscript";
type EditorState = {
  canEdit: boolean;
  unavailableReason?: string;
  sourceTrack?: {
    id: string;
    languageCode?: string;
    name?: string;
    status: string;
  };
  latestJob?: {
    pipelineStage?: string;
    canRecoverCensoring?: boolean;
    canCheckUploadStatus?: boolean;
    status: string;
    totalReplacementCount?: number;
    errorMessage?: string;
    reconciliationStatus?: string;
    reconciliationError?: string;
    submissionUncertain?: boolean;
    pollingTimedOut?: boolean;
  };
  captionRevision: number;
};

const ACTIVE_STATUSES = new Set(["requested", "pending", "processing"]);
function friendlyUnavailable(reason?: string) {
  if (!reason) return "Caption cleanup is unavailable for this video.";
  const normalized = reason.toLowerCase();
  if (normalized.includes("sign") || normalized.includes("auth")) {
    return "Sign in with the uploader account to edit captions.";
  }
  if (normalized.includes("owner") || normalized.includes("permission")) {
    return "Only the uploader can edit this video's captions.";
  }
  if (normalized.includes("prepar") || normalized.includes("not ready")) {
    return "Captions are still preparing. Return here when the source track is ready.";
  }
  if (normalized.includes("related video features") || normalized.includes("refresh")) {
    return reason;
  }
  if (normalized.includes("track") || normalized.includes("caption")) {
    return "This video does not have a ready source caption track yet.";
  }
  if (normalized.includes("missing") || normalized.includes("not found") || normalized.includes("deleted")) {
    return "This video is missing or has been deleted.";
  }
  return reason;
}

function friendlySubmitError(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("did not confirm"))
    return "Mux did not confirm whether caption cleanup started. This screen will update automatically if it was accepted.";
  if (message.includes("sign") || message.includes("auth"))
    return "Your session expired. Sign in again to edit captions.";
  if (message.includes("active") || message.includes("already"))
    return "Another caption edit is already running for this video.";
  if (message.includes("track") || message.includes("stale"))
    return "The source caption track changed. Go back, reopen the editor, and try again.";
  if (message.includes("credential") || message.includes("scope") || message.includes("robots"))
    return "Caption cleanup is temporarily unavailable. Please try again later.";
  return "Could not start caption cleanup. Please try again.";
}

export default function EditCaptionsScreen() {
  return <CaptionEditorForm />;
}

function CaptionEditorForm() {
  const { muxAssetId: rawMuxAssetId } = useLocalSearchParams<{
    muxAssetId?: string | string[];
  }>();
  const muxAssetId = Array.isArray(rawMuxAssetId)
    ? rawMuxAssetId[0]
    : rawMuxAssetId;
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  const [transcript, setTranscript] = useState<CaptionTranscript | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [search, setSearch] = useState("");
  const [autoCensor, setAutoCensor] = useState(false);
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRepairing, setIsRepairing] = useState(false);
  const state = useQuery(
    (api as any).captionEditing.getOwnCaptionEditorState,
    muxAssetId ? { muxAssetId } : "skip",
  ) as EditorState | null | undefined;
  const loadTranscript = useAction((api as any).captionEditingNode.loadOwnCaptionDocument);
  const saveTranscript = useAction((api as any).captionEditingNode.replaceOwnCaptionTrack);
  const retryReconciliation = useAction(
    (api as any).captionEditingNode.retryCaptionReconciliationForAsset,
  );
  const retryJobStatus = useAction(
    (api as any).captionEditingNode.retryCaptionJobStatusForAsset,
  );
  const recoverCensoring = useAction((api as any).captionEditingNode.recoverOwnCaptionCensoring);
  const recover = async (useManualTrack: boolean) => {
    if (!muxAssetId || isRepairing) return;
    setIsRepairing(true);
    setValidationMessage(null);
    try {
      const result = await recoverCensoring({ muxAssetId, useManualTrack });
      void AccessibilityInfo.announceForAccessibility(result.restarted ? "Caption recovery started." : "Caption status changed. Review the latest status.");
    } catch {
      setValidationMessage("Could not start caption recovery. Your original captions are retained. Please try again.");
    } finally { setIsRepairing(false); }
  };
  const latestStatus = state?.latestJob?.status;
  const reconciliationStatus = state?.latestJob?.reconciliationStatus;
  const editActive = Boolean(latestStatus && ACTIVE_STATUSES.has(latestStatus));
  const announcedStatus = useRef<string | undefined>(undefined);
  const transcriptCurrent = transcript?.trackId === state?.sourceTrack?.id && transcript?.captionRevision === state?.captionRevision;
  const formDisabled = isSubmitting || editActive || !state?.canEdit || loadingTranscript || !transcript || !transcriptCurrent;
  const edits = transcript ? captionTranscriptEdits(transcript, drafts) : [];
  usePreventRemove(edits.length > 0 && !editActive, ({ data }) => {
    if (isSubmitting) return;
    Alert.alert("Discard unsaved caption edits?", "Your changes have not been saved.", [
      { text: "Keep editing", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: () => navigation.dispatch(data.action) },
    ]);
  });
  const visibleCues = transcript?.cues.filter((cue) => `${cue.text}\n${drafts[cue.id] ?? cue.text}`.toLowerCase().includes(search.toLowerCase())) ?? [];

  useEffect(() => {
    let cancelled = false;
    setTranscript(null);
    setDrafts({});
    setTranscriptError(null);
    if (!muxAssetId || !state?.sourceTrack?.id) return;
    setLoadingTranscript(true);
    void loadTranscript({ muxAssetId, trackId: state.sourceTrack.id }).then((document: CaptionTranscript) => {
      if (!cancelled) setTranscript(document);
    }).catch(() => {
      if (!cancelled) setTranscriptError("Could not load the transcript. Please try again.");
    }).finally(() => {
      if (!cancelled) setLoadingTranscript(false);
    });
    return () => { cancelled = true; };
  }, [muxAssetId, state?.sourceTrack?.id, state?.captionRevision, reload, loadTranscript]);

  useEffect(() => {
    const statusKey = `${latestStatus ?? "none"}:${reconciliationStatus ?? "none"}:${state?.latestJob?.submissionUncertain ? "uncertain" : "confirmed"}:${state?.latestJob?.pollingTimedOut ? "timed-out" : "polling"}`;
    if (!latestStatus || statusKey === announcedStatus.current) return;
    announcedStatus.current = statusKey;
    if (state?.latestJob?.submissionUncertain) {
      void AccessibilityInfo.announceForAccessibility(
        "Mux has not confirmed whether caption cleanup started.",
      );
    } else if (state?.latestJob?.pollingTimedOut) {
      void AccessibilityInfo.announceForAccessibility(
        "Mux has not confirmed the final caption status.",
      );
    } else if (state?.latestJob?.canRecoverCensoring) {
      void AccessibilityInfo.announceForAccessibility("Censoring failed. Retry censoring or finish with your manual captions without censoring.");
    } else if (ACTIVE_STATUSES.has(latestStatus)) {
      void AccessibilityInfo.announceForAccessibility(
        "Caption edits are processing.",
      );
    } else if (latestStatus === "completed") {
      void AccessibilityInfo.announceForAccessibility(
        reconciliationStatus === "errored"
          ? "Caption edits completed, but related video features need to be refreshed."
          : reconciliationStatus === "completed"
            ? "Caption edits completed successfully."
            : "Caption edits completed. Related video features are refreshing.",
      );
    } else if (latestStatus === "errored" || latestStatus === "cancelled") {
      void AccessibilityInfo.announceForAccessibility(
        "Caption editing failed. Review the status and try again.",
      );
    }
  }, [latestStatus, reconciliationStatus, state?.latestJob?.canRecoverCensoring, state?.latestJob?.pollingTimedOut, state?.latestJob?.submissionUncertain]);

  const announce = (message: string) => {
    void AccessibilityInfo.announceForAccessibility(message);
  };

  const submit = () => {
    if (!muxAssetId || !transcript || formDisabled) return;
    const invalidEdit = edits.find((edit) => captionTextError(edit.text));
    const message = invalidEdit
      ? `${captionTimestamp(transcript.cues.find((cue) => cue.id === invalidEdit.id)!.startMs)}: ${captionTextError(invalidEdit.text)}`
      : !edits.length && !autoCensor ? "Edit a caption or turn on auto-censor first." : null;
    if (message) {
      setValidationMessage(message);
      announce(message);
      return;
    }

    Alert.alert(
      "Replace source captions?",
      `${edits.length} caption${edits.length === 1 ? "" : "s"} edited. Timings stay unchanged. After the updated track is ready, the original is permanently deleted. This cannot be undone.${autoCensor ? " Mux Robots will censor profanity across the track and may consume AI usage." : ""}`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Apply edits",
          style: "destructive",
          onPress: () => {
            setIsSubmitting(true);
            setValidationMessage(null);
            announce("Applying caption edits.");
            void saveTranscript({
              muxAssetId,
              trackId: transcript.trackId,
              captionRevision: transcript.captionRevision,
              edits,
              autoCensorProfanity: autoCensor,
            })
              .then(() => {
                setDrafts({});
                setAutoCensor(false);
                announce("Caption edit started successfully.");
              })
              .catch((error: unknown) => {
                const message = friendlySubmitError(error);
                setValidationMessage(message);
                announce(`Caption editing failed. ${message}`);
              })
              .finally(() => setIsSubmitting(false));
          },
        },
      ],
    );
  };

  const repairReconciliation = () => {
    if (!muxAssetId || isRepairing) return;
    setIsRepairing(true);
    void retryReconciliation({ muxAssetId })
      .then((result: any) => {
        announce(
          result?.scheduled
            ? "Caption refresh restarted."
            : "Caption refresh is already running or no longer needs repair.",
        );
      })
      .catch(() => {
        Alert.alert(
          "Could not restart caption refresh",
          "Please check your connection and try again.",
        );
      })
      .finally(() => setIsRepairing(false));
  };

  const checkJobStatus = () => {
    if (!muxAssetId || isRepairing) return;
    setIsRepairing(true);
    void retryJobStatus({ muxAssetId })
      .then((result: any) => {
        announce(
          result?.restarted
            ? "Checking the Mux caption job again."
            : "The caption job is already updating or no longer needs a status check.",
        );
      })
      .catch(() => {
        Alert.alert(
          "Could not check caption status",
          "Please check your connection and try again.",
        );
      })
      .finally(() => setIsRepairing(false));
  };

  const statusCopy = editActive
    ? "Applying edits. You can leave this screen; progress is saved."
    : latestStatus === "completed"
      ? `Reviewed${typeof state?.latestJob?.totalReplacementCount === "number" ? ` · ${state.latestJob.totalReplacementCount} replacements` : ""}`
      : latestStatus === "errored" || latestStatus === "cancelled"
        ? state?.latestJob?.errorMessage || "The last edit could not be applied. Review your captions and try again."
        : "Read the transcript and edit captions in place.";

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable
          accessibilityLabel="Close caption cleanup"
          accessibilityRole="button"
          hitSlop={10}
          disabled={isSubmitting}
          onPress={() => router.back()}
          style={styles.headerButton}
        >
          <Ionicons name="chevron-back" size={26} color="#17202E" />
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>UPLOADER TOOLS</Text>
          <Text style={styles.title}>Edit captions</Text>
        </View>
        <View style={styles.headerButton} />
      </View>

      {!muxAssetId ? (
        <StateCard icon="alert-circle" message="This video link is invalid." />
      ) : state === undefined ? (
        <StateCard loading message="Loading caption editor…" />
      ) : state?.latestJob?.canRecoverCensoring ? (
        <View style={styles.stateWrap} accessibilityLiveRegion="polite">
          <Text style={styles.sectionTitle}>Censoring needs attention</Text>
          <Text style={styles.stateText}>Your original and manually edited captions are retained. Retry censoring, or finish using the manual captions without censoring.</Text>
          <Text style={styles.helper}>Retrying may consume AI usage.</Text>
          <Pressable accessibilityRole="button" disabled={isRepairing} style={styles.stateAction} onPress={() => void recover(false)}>
            {isRepairing ? <ActivityIndicator color="#FFFFFF" /> : null}<Text style={styles.submitText}>Retry censoring</Text>
          </Pressable>
          <Pressable accessibilityRole="button" disabled={isRepairing} style={styles.stateAction} onPress={() => Alert.alert(
            "Finish without censoring?", "Your manual captions will permanently replace the original source track. Profanity will not be censored.",
            [{ text: "Cancel", style: "cancel" }, { text: "Finish without censoring", style: "destructive", onPress: () => void recover(true) }],
          )}><Text style={styles.submitText}>Finish without censoring</Text></Pressable>
          {validationMessage ? <Text style={styles.errorText}>{validationMessage}</Text> : null}
        </View>
      ) : !state || !state.canEdit || !state.sourceTrack ? (
        <StateCard
          icon="logo-closed-captioning"
          message={friendlyUnavailable(state?.unavailableReason)}
          actionLabel={
            state?.latestJob?.pollingTimedOut || state?.latestJob?.canCheckUploadStatus
              ? "Check Mux status"
              : state?.latestJob?.status === "completed" &&
            state.latestJob.reconciliationStatus === "errored"
                ? "Retry caption refresh"
                : undefined
          }
          actionLoading={isRepairing}
          onAction={
            state?.latestJob?.pollingTimedOut || state?.latestJob?.canCheckUploadStatus
              ? checkJobStatus
              : repairReconciliation
          }
        />
      ) : (
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          keyboardVerticalOffset={0}
          style={styles.flex}
        >
          <ScrollView
            ref={scrollRef}
            contentContainerStyle={styles.content}
            keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.sourceCard}>
              <Text style={styles.cardLabel}>SOURCE TRACK</Text>
              <Text style={styles.cardTitle}>{state.sourceTrack.name || "Source captions"}</Text>
              <Text style={styles.meta}>
                {state.sourceTrack.languageCode || "Language not specified"} · {state.sourceTrack.status}
              </Text>
            </View>

            <View accessibilityLiveRegion="polite" style={[styles.statusCard, editActive && styles.statusActive]}>
              {editActive ? <ActivityIndicator color="#B83A8D" /> : <Ionicons name={latestStatus === "completed" ? "checkmark-circle" : "information-circle"} size={21} color={latestStatus === "completed" ? "#248A4D" : "#B83A8D"} />}
              <Text style={styles.statusText}>{statusCopy}</Text>
            </View>

            <Text style={styles.sectionTitle}>Transcript</Text>
            <Text style={styles.helper}>Edit individual captions below. Timings stay unchanged; repeated dialogue elsewhere is not affected.</Text>
            {loadingTranscript ? <ActivityIndicator accessibilityLabel="Loading transcript" color="#B83A8D" /> : transcriptError ? <View style={styles.censorCard}>
              <Text accessibilityLiveRegion="assertive" style={styles.errorText}>{transcriptError}</Text>
              <Pressable accessibilityRole="button" onPress={() => setReload((value) => value + 1)}><Text style={styles.addButtonText}>Retry loading transcript</Text></Pressable>
            </View> : transcript ? <>
              <Field label="Search transcript" value={search} onChangeText={setSearch} placeholder="Find a caption…" />
              <Text style={styles.helper}>{transcript.cues.length} captions · {edits.length} edited</Text>
              {visibleCues.map((cue) => {
                const text = drafts[cue.id] ?? cue.text;
                const changed = text !== cue.text;
                return <View key={cue.id} style={[styles.cueCard, changed && styles.cueEdited]}>
                  <Field label={`${captionTimestamp(cue.startMs)} – ${captionTimestamp(cue.endMs)}`} multiline editable={!formDisabled} maxLength={10_000} value={text} onChangeText={(value) => {
                    setDrafts((current) => ({ ...current, [cue.id]: value }));
                    setValidationMessage(null);
                  }} />
                  {changed ? <>
                    <Text style={styles.helper}>Original: {cue.text}</Text>
                    {captionTextError(text) ? <Text style={styles.errorText}>{captionTextError(text)}</Text> : null}
                    <Pressable accessibilityRole="button" accessibilityLabel={`Undo caption edit at ${captionTimestamp(cue.startMs)}`} disabled={formDisabled} onPress={() => { setDrafts((current) => ({ ...current, [cue.id]: cue.text })); setValidationMessage(null); }}><Text style={styles.addButtonText}>Undo edit</Text></Pressable>
                  </> : null}
                </View>;
              })}
              {!visibleCues.length ? <Text style={styles.helper}>No captions match your search.</Text> : null}
            </> : null}

            <View style={styles.censorCard}>
              <View style={styles.switchRow}>
                <View style={styles.flex}>
                  <Text style={styles.sectionTitle}>Auto-censor profanity</Text>
                  <Text style={styles.helper}>Mux Robots censors the edited track using the blank style. Spoken audio is unchanged.</Text>
                </View>
                <Switch accessibilityLabel="Auto-censor profanity with Mux Robots" disabled={formDisabled} onValueChange={setAutoCensor} value={autoCensor} />
              </View>
            </View>
            <View style={{ height: 12 }} />
          </ScrollView>

          <View style={[styles.submitArea, { paddingBottom: Math.max(insets.bottom, 12) }]}>
            {validationMessage ? <Text accessibilityLiveRegion="assertive" style={styles.errorText}>{validationMessage}</Text> : null}
            <Pressable accessibilityRole="button" accessibilityState={{ disabled: formDisabled || (!edits.length && !autoCensor) }} disabled={formDisabled || (!edits.length && !autoCensor)} onPress={submit} style={({ pressed }) => [styles.submitButton, (formDisabled || (!edits.length && !autoCensor)) && styles.submitDisabled, pressed && styles.pressed]}>
              {isSubmitting || editActive ? <ActivityIndicator color="#FFFFFF" /> : <Ionicons name="sparkles" size={19} color="#FFFFFF" />}
              <Text style={styles.submitText}>{editActive ? "Applying caption edits…" : "Apply caption edits"}</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      )}
    </View>
  );
}

function Field({ label, helper, ...props }: React.ComponentProps<typeof TextInput> & { label: string; helper?: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {helper ? <Text style={styles.helper}>{helper}</Text> : null}
      <TextInput accessibilityLabel={label} {...props} autoCorrect={false} placeholderTextColor="#8290A3" style={[styles.input, props.multiline && styles.multiline]} textAlignVertical={props.multiline ? "top" : "center"} />
    </View>
  );
}

function StateCard({
  loading,
  icon,
  message,
  actionLabel,
  actionLoading,
  onAction,
}: {
  loading?: boolean;
  icon?: keyof typeof Ionicons.glyphMap;
  message: string;
  actionLabel?: string;
  actionLoading?: boolean;
  onAction?: () => void;
}) {
  return (
    <View style={styles.stateWrap}>
      {loading ? <ActivityIndicator color="#B83A8D" size="large" /> : <Ionicons name={icon || "information-circle"} size={42} color="#B83A8D" />}
      <Text accessibilityLiveRegion="polite" style={styles.stateText}>{message}</Text>
      {actionLabel && onAction ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: actionLoading }}
          disabled={actionLoading}
          onPress={onAction}
          style={({ pressed }) => [
            styles.stateAction,
            actionLoading && styles.submitDisabled,
            pressed && styles.pressed,
          ]}
        >
          {actionLoading ? <ActivityIndicator color="#FFFFFF" /> : null}
          <Text style={styles.submitText}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#F7F8FB" },
  flex: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#D9DFE8", backgroundColor: "#FFFFFF" },
  headerButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  headerCopy: { flex: 1, alignItems: "center" },
  eyebrow: { fontSize: 10, fontWeight: "800", letterSpacing: 1.1, color: "#B83A8D" },
  title: { fontSize: 20, lineHeight: 25, fontWeight: "800", color: "#17202E" },
  content: { padding: 16, gap: 14 },
  sourceCard: { padding: 16, borderRadius: 16, backgroundColor: "#202838", gap: 3 },
  cardLabel: { color: "#F3A9D6", fontSize: 10, fontWeight: "800", letterSpacing: 1 },
  cardTitle: { color: "#FFFFFF", fontSize: 17, fontWeight: "700" },
  meta: { color: "#CDD5E1", fontSize: 13 },
  statusCard: { flexDirection: "row", alignItems: "center", gap: 9, padding: 13, borderRadius: 13, backgroundColor: "#FFF2FA" },
  statusActive: { backgroundColor: "#FCEAF6" },
  statusText: { flex: 1, color: "#4F5868", fontSize: 13, lineHeight: 18 },
  sectionTitle: { fontSize: 17, fontWeight: "700", color: "#17202E" },
  helper: { fontSize: 12, lineHeight: 17, color: "#677386" },
  addButtonText: { fontSize: 13, fontWeight: "700", color: "#B83A8D" },
  cueCard: { padding: 15, gap: 12, borderRadius: 16, borderWidth: 1, borderColor: "#DCE2EA", backgroundColor: "#FFFFFF" },
  cueEdited: { borderColor: "#B83A8D", backgroundColor: "#FFF2FA" },
  field: { gap: 5 },
  fieldLabel: { fontSize: 13, fontWeight: "700", color: "#313B4B" },
  input: { height: 46, paddingHorizontal: 12, borderWidth: 1, borderColor: "#C9D1DC", borderRadius: 11, backgroundColor: "#FFFFFF", color: "#11181C", fontSize: 15 },
  multiline: { height: 76, paddingTop: 11 },
  switchRow: { minHeight: 42, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  censorCard: { padding: 15, gap: 12, borderRadius: 16, borderWidth: 1, borderColor: "#DCE2EA", backgroundColor: "#FFFFFF" },
  submitArea: { paddingTop: 11, paddingHorizontal: 16, gap: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#D9DFE8", backgroundColor: "#FFFFFF" },
  submitButton: { minHeight: 52, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderRadius: 26, backgroundColor: "#D63B9D" },
  submitDisabled: { backgroundColor: "#AAB1BC" },
  submitText: { color: "#FFFFFF", fontSize: 16, fontWeight: "800" },
  errorText: { color: "#B42E40", textAlign: "center", fontSize: 13, lineHeight: 18 },
  pressed: { opacity: 0.78 },
  stateWrap: { flex: 1, alignItems: "center", justifyContent: "center", gap: 14, paddingHorizontal: 34 },
  stateText: { maxWidth: 380, textAlign: "center", color: "#4F5B6D", fontSize: 16, lineHeight: 23 },
  stateAction: { minHeight: 48, paddingHorizontal: 22, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderRadius: 24, backgroundColor: "#D63B9D" },
});
