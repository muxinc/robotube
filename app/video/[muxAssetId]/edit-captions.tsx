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
  findNodeHandle,
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
import { captionTimestamp, type CaptionTranscript } from "@/lib/captionTranscript";
import { captionRulesError, captionSpeakerLabels, previewCaptionRules, type CaptionReplacement, type CaptionSpeakerReplacement } from "@/lib/captionRobots";
import { createCaptionSubmissionGate, mobileCaptionJobText, mobileCaptionReviewError } from "@/lib/captionRobotsMobile";
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
    operation?: "manual" | "robots";
    jobId?: string;
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
  if (normalized.includes("related video features") || normalized.includes("refresh") || normalized.includes("recovery")) {
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
  const composerInput = useRef<TextInput>(null);
  const composerSelection = useRef(0);
  const submissionGate = useRef(createCaptionSubmissionGate());
  const cancelConfirmation = useRef<(() => void) | undefined>(undefined);
  const currentAsset = useRef(muxAssetId);
  currentAsset.current = muxAssetId;
  const [draftAsset, setDraftAsset] = useState(muxAssetId);
  const [transcript, setTranscript] = useState<CaptionTranscript | null>(null);
  const [replacements, setReplacements] = useState<CaptionReplacement[]>([]);
  const [speakers, setSpeakers] = useState<CaptionSpeakerReplacement[]>([]);
  const [composer, setComposer] = useState<{ selection: number; cueText: string; find: string; replace: string; caseSensitive: boolean } | null>(null);
  const [speaker, setSpeaker] = useState("");
  const [speakerName, setSpeakerName] = useState("");
  const [censorMode, setCensorMode] = useState<"blank" | "remove" | "mask">("blank");
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
  const saveTranscript = useAction((api as any).captionEditingNode.editCaptionsForAsset);
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
      setValidationMessage("Could not start caption recovery. Check the latest track status. Please try again.");
    } finally { setIsRepairing(false); }
  };
  const latestStatus = state?.latestJob?.status;
  const reconciliationStatus = state?.latestJob?.reconciliationStatus;
  const editActive = Boolean(latestStatus && ACTIVE_STATUSES.has(latestStatus));
  const announcedStatus = useRef<string | undefined>(undefined);
  const transcriptCurrent = transcript?.trackId === state?.sourceTrack?.id && transcript?.captionRevision === state?.captionRevision;
  const formDisabled = draftAsset !== muxAssetId || isSubmitting || editActive || !state?.canEdit || loadingTranscript || !transcript || !transcriptCurrent;
  const preview = previewCaptionRules(transcript?.cues ?? [], replacements, speakers);
  const hasRules = replacements.length > 0 || speakers.length > 0 || autoCensor;
  usePreventRemove(hasRules || composer !== null || speakerName.length > 0, ({ data }) => {
    if (isSubmitting) return;
    Alert.alert("Discard unsaved caption edits?", "Your changes have not been saved.", [
      { text: "Keep editing", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: () => navigation.dispatch(data.action) },
    ]);
  });
  const visibleCues = preview.cues.filter((cue) => `${cue.originalText} ${cue.text}`.toLowerCase().includes(search.toLowerCase()));

  useEffect(() => {
    cancelConfirmation.current?.();
    setDraftAsset(muxAssetId);
    setReplacements([]);
    setSpeakers([]);
    setComposer(null);
    setSpeaker("");
    setSpeakerName("");
    setAutoCensor(false);
    setCensorMode("blank");
    setSearch("");
    setValidationMessage(null);
    return () => { cancelConfirmation.current?.(); };
  }, [muxAssetId]);

  useEffect(() => {
    let cancelled = false;
    setTranscript(null);
    setTranscriptError(null);
    setLoadingTranscript(false);
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
    const message = composer || speakerName ? "Queue or cancel the unfinished correction first." : captionRulesError(replacements, speakers, autoCensor) ?? mobileCaptionReviewError({
      speakerLabels: captionSpeakerLabels(transcript.cues), speakers, changedCueCount: preview.changedCueCount, autoCensor,
    });
    if (message) {
      setValidationMessage(message);
      announce(message);
      return;
    }

    const confirmation = submissionGate.current.open();
    if (!confirmation) return;
    cancelConfirmation.current = confirmation.cancel;
    const gate = submissionGate.current;
    Alert.alert(
      "Replace source captions?",
      `One Mux Robots edit-captions job applies rules to ALL occurrences across the track. Estimated affected cues: ${preview.changedCueCount}. The source is deleted before the edited track is added. Restoration on failure is best effort and may also fail.${autoCensor ? " AI profanity censoring is not previewed and may consume AI usage." : ""}`,

      [
        { text: "Cancel", style: "cancel", onPress: confirmation.cancel },
        {
          text: "Apply edits",
          style: "destructive",
          onPress: () => {
            if (currentAsset.current !== muxAssetId) { confirmation.cancel(); return; }
            if (!confirmation.accept()) return;
            setIsSubmitting(true);
            setValidationMessage(null);
            announce("Applying caption edits.");
            void saveTranscript({
              muxAssetId,
              trackId: transcript.trackId,
              captionRevision: transcript.captionRevision,
              replacements,
              speakerReplacements: speakers,
              ...(autoCensor ? { autoCensorProfanity: { mode: censorMode } } : {}),
            })
              .then((result: { alreadyActive: boolean }) => {
                if (currentAsset.current !== muxAssetId) return;
                if (result.alreadyActive) { setValidationMessage("An existing job is running. Your queued edits were not submitted."); return; }
                setReplacements([]);
                setSpeakers([]);
                setAutoCensor(false);
                announce("Caption edit started successfully.");
              })
              .catch((error: unknown) => {
                if (currentAsset.current !== muxAssetId) return;
                const message = friendlySubmitError(error);
                setValidationMessage(message);
                announce(`Caption editing failed. ${message}`);
              })
              .finally(() => { gate.finish(); setIsSubmitting(false); });
          },
        },
      ],
      { cancelable: true, onDismiss: confirmation.cancel },
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
      ? "Caption edits completed."
      : latestStatus === "errored" || latestStatus === "cancelled"
        ? state?.latestJob?.errorMessage || "The last edit could not be applied. Review your captions and try again."
        : "Read the transcript and queue track-wide rules.";

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

      {state?.latestJob ? <View accessibilityLiveRegion="polite" style={styles.statusCard}>
        {editActive ? <ActivityIndicator color="#B83A8D" /> : null}
        <Text selectable style={styles.statusText}>{mobileCaptionJobText(state.latestJob)}{"\n"}{statusCopy}</Text>
      </View> : null}

      {!muxAssetId ? (
        <StateCard icon="alert-circle" message="This video link is invalid." />
      ) : state === undefined ? (
        <StateCard loading message="Loading caption editor…" />
      ) : state?.latestJob?.canRecoverCensoring ? (
        <View style={styles.stateWrap} accessibilityLiveRegion="polite">
          <Text style={styles.sectionTitle}>Censoring needs attention</Text>
          <Text style={styles.stateText}>This legacy manual-caption job needs recovery. Retry censoring, or finish using the manual captions without censoring.</Text>
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
          message={editActive ? "Caption edits are being applied. Editing is locked until this job finishes." : friendlyUnavailable(state?.unavailableReason)}
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

            <Text style={styles.sectionTitle}>Transcript</Text>
            <Text style={styles.helper}>Corrections affect ALL matching occurrences across the track, not only this timestamp. Select or copy text, then choose Correct wording. Empty replacement text deletes matches.</Text>
            {loadingTranscript ? <ActivityIndicator accessibilityLabel="Loading transcript" color="#B83A8D" /> : transcriptError ? <View style={styles.censorCard}>
              <Text accessibilityLiveRegion="assertive" style={styles.errorText}>{transcriptError}</Text>
              <Pressable accessibilityRole="button" onPress={() => setReload((value) => value + 1)}><Text style={styles.addButtonText}>Retry loading transcript</Text></Pressable>
            </View> : transcript ? <>
              <Field label="Search transcript" value={search} onChangeText={setSearch} placeholder="Find a caption…" />
              <Text style={styles.helper}>{transcript.cues.length} captions · Estimated {preview.changedCueCount} affected cues · {preview.totalReplacementCount} replacements. Estimate only: Mux matching may differ. AI censoring is not previewed.</Text>
              {composer ? <View key={composer.selection} style={styles.censorCard} onLayout={(event) => {
                scrollRef.current?.scrollTo({ y: event.nativeEvent.layout.y, animated: false });
                requestAnimationFrame(() => {
                  composerInput.current?.focus();
                  const target = findNodeHandle(composerInput.current);
                  if (target) AccessibilityInfo.setAccessibilityFocus(target);
                  announce("Track-wide phrase correction opened. Choose a word or phrase from the selected cue.");
                });
              }}>
                <Text style={styles.sectionTitle}>Track-wide phrase correction</Text>
                <Field inputRef={composerInput} maxLength={500} label="Find word or phrase from selected cue" editable={!formDisabled} value={composer.find} onChangeText={(find) => setComposer({ ...composer, find })} />
                <Field maxLength={500} label="Replace with (empty deletes matches)" editable={!formDisabled} value={composer.replace} onChangeText={(replace) => setComposer({ ...composer, replace })} />
                <Text style={styles.helper}>You may shorten the text to a phrase present in the original cue.</Text>
                <Text>Case sensitive</Text><Switch accessibilityLabel="Case sensitive correction" disabled={formDisabled} value={composer.caseSensitive} onValueChange={(caseSensitive) => setComposer({ ...composer, caseSensitive })} />
                <Pressable accessibilityRole="button" disabled={formDisabled} onPress={() => {
                  const rule = { find: composer.find, replace: composer.replace, caseSensitive: composer.caseSensitive };
                  const error = !composer.cueText.includes(composer.find) ? "Choose text present in the selected cue." : captionRulesError([...replacements, rule], speakers, autoCensor);
                  if (error) { setValidationMessage(error); return; }
                  setReplacements([...replacements, rule]); setComposer(null); setValidationMessage(null);
                }}><Text style={styles.addButtonText}>Queue correction</Text></Pressable>
                <Pressable accessibilityRole="button" disabled={formDisabled} onPress={() => setComposer(null)}><Text style={styles.addButtonText}>Cancel correction</Text></Pressable>
              </View> : null}
              {visibleCues.map((cue) => <View key={cue.id} style={styles.cueCard}>
                <Text style={styles.fieldLabel}>{captionTimestamp(cue.startMs)} – {captionTimestamp(cue.endMs)}</Text>
                <Text selectable>Original: {cue.originalText}</Text>
                <Text selectable>Estimated preview: {cue.text || "(empty)"}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel={`Correct wording at ${captionTimestamp(cue.startMs)}`} disabled={formDisabled} onPress={() => setComposer({ selection: ++composerSelection.current, cueText: cue.originalText, find: cue.originalText.slice(0, 500), replace: "", caseSensitive: false })}><Text style={styles.addButtonText}>Correct wording</Text></Pressable>
              </View>)}
              {replacements.map((rule, index) => <View key={index} style={styles.cueCard}>
                <Text selectable>{rule.find} → {rule.replace || "(delete)"} · {rule.caseSensitive ? "Case sensitive" : "Ignore case"}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel={`Remove correction ${index + 1}`} disabled={formDisabled} onPress={() => setReplacements(replacements.filter((_, i) => i !== index))}><Text style={styles.addButtonText}>Remove correction</Text></Pressable>
              </View>)}
              <Text style={styles.sectionTitle}>Speaker names</Text>
              {captionSpeakerLabels(transcript.cues).length === 0 ? <Text style={styles.helper}>No speaker labels were found in these captions. For future uploads, enable Include speaker labels, then name discovered labels here in Edit captions.</Text> : null}
              <Text style={styles.helper}>Only leading labels change, not spoken mentions. Enter names without brackets.</Text>
              {captionSpeakerLabels(transcript.cues).map((label) => <Pressable key={label} accessibilityRole="radio" accessibilityState={{ checked: speaker === label }} disabled={formDisabled} onPress={() => setSpeaker(label)}><Text style={styles.addButtonText}>{speaker === label ? "●" : "○"} {label}</Text></Pressable>)}
              {speaker ? <>
                <Field maxLength={200} label={`New name for ${speaker}`} editable={!formDisabled} value={speakerName} onChangeText={setSpeakerName} />
                <Pressable accessibilityRole="button" disabled={formDisabled} onPress={() => {
                  const next = [...speakers.filter((rule) => rule.find !== speaker), { find: speaker, replace: speakerName }];
                  const error = captionRulesError(replacements, next, autoCensor);
                  if (error) { setValidationMessage(error); return; }
                  setSpeakers(next); setSpeakerName(""); setSpeaker(""); setValidationMessage(null);
                }}><Text style={styles.addButtonText}>Queue speaker rename</Text></Pressable>
                <Pressable accessibilityRole="button" disabled={formDisabled} onPress={() => { setSpeaker(""); setSpeakerName(""); }}><Text style={styles.addButtonText}>Cancel rename</Text></Pressable>
              </> : null}
              {speakers.map((rule) => <View key={rule.find} style={styles.cueCard}><Text>{rule.find} → {rule.replace}</Text><Pressable accessibilityRole="button" accessibilityLabel={`Remove rename for ${rule.find}`} disabled={formDisabled} onPress={() => setSpeakers(speakers.filter((item) => item.find !== rule.find))}><Text style={styles.addButtonText}>Remove rename</Text></Pressable></View>)}
              {!visibleCues.length ? <Text style={styles.helper}>No captions match your search.</Text> : null}
            </> : null}

            <View style={styles.censorCard}>
              <View style={styles.switchRow}>
                <View style={styles.flex}>
                  <Text style={styles.sectionTitle}>Auto-censor profanity</Text>
                  <Text style={styles.helper}>AI detects profanity across the track; results are not previewed. Spoken audio is unchanged.</Text>
                </View>
                <Switch accessibilityLabel="Auto-censor profanity with Mux Robots" disabled={formDisabled} onValueChange={setAutoCensor} value={autoCensor} />
              </View>
            </View>
            {autoCensor ? <View style={styles.censorCard}>{(["blank", "remove", "mask"] as const).map((mode) => <Pressable key={mode} accessibilityRole="radio" accessibilityLabel={`Censor mode ${mode}`} accessibilityState={{ checked: censorMode === mode }} disabled={formDisabled} onPress={() => setCensorMode(mode)}><Text style={styles.addButtonText}>{censorMode === mode ? "●" : "○"} {mode}</Text></Pressable>)}</View> : null}
            <View style={{ height: 12 }} />
          </ScrollView>

          <View style={[styles.submitArea, { paddingBottom: Math.max(insets.bottom, 12) }]}>
            {validationMessage ? <Text accessibilityLiveRegion="assertive" style={styles.errorText}>{validationMessage}</Text> : null}
            <Pressable accessibilityRole="button" accessibilityState={{ disabled: formDisabled || !hasRules }} disabled={formDisabled || !hasRules} onPress={submit} style={({ pressed }) => [styles.submitButton, (formDisabled || !hasRules) && styles.submitDisabled, pressed && styles.pressed]}>
              {isSubmitting || editActive ? <ActivityIndicator color="#FFFFFF" /> : <Ionicons name="sparkles" size={19} color="#FFFFFF" />}
              <Text style={styles.submitText}>{editActive ? "Applying caption edits…" : "Apply caption edits"}</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      )}
    </View>
  );
}

function Field({ label, helper, inputRef, ...props }: React.ComponentProps<typeof TextInput> & { label: string; helper?: string; inputRef?: React.Ref<TextInput> }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {helper ? <Text style={styles.helper}>{helper}</Text> : null}
      <TextInput ref={inputRef} accessibilityLabel={label} {...props} autoCorrect={false} placeholderTextColor="#8290A3" style={[styles.input, props.multiline && styles.multiline]} textAlignVertical={props.multiline ? "top" : "center"} />
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
  statusText: { flex: 1, color: "#4F5868", fontSize: 13, lineHeight: 18 },
  sectionTitle: { fontSize: 17, fontWeight: "700", color: "#17202E" },
  helper: { fontSize: 12, lineHeight: 17, color: "#677386" },
  addButtonText: { fontSize: 13, fontWeight: "700", color: "#B83A8D" },
  cueCard: { padding: 15, gap: 12, borderRadius: 16, borderWidth: 1, borderColor: "#DCE2EA", backgroundColor: "#FFFFFF" },
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
