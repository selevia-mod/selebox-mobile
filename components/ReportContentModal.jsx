// ReportContentModal — the same "Report content" sheet used on the home
// feed safety flow (app/(tabs)/home.jsx). Reason chips + optional notes
// + Submit button with subtitle. Replaces the older free-form-text-only
// `ReportModal.jsx` for surfaces that want the richer reason picker.
//
// Why a new component vs. evolving ReportModal:
//   ReportModal is used on book / video / profile reports today, all
//   with a `reportDetail` single-text-field interface. Changing its
//   shape would force a coordinated migration of every consumer at the
//   same time. Instead we ship this richer one in parallel; consumers
//   migrate piecemeal.
//
// Props:
//   isVisible            — boolean, modal visibility
//   onClose              — close handler (backdrop tap, Back link)
//   onSubmit             — async ({ reason, notes }) => void
//                          Should resolve when the report write completes;
//                          the caller can then close the modal and show
//                          a success message.
//   submitting           — boolean, disables the Submit button + shows spinner
//   theme                — theme object (passed in so we don't double-load
//                          the theme hook in this component; keeps it cheap
//                          to mount/unmount).
//   onModalHideComplete  — optional callback that fires AFTER the modal's
//                          dismiss animation finishes. Useful for the
//                          chat flow which needs to show a system Alert
//                          *after* the modal is gone (modals + alerts
//                          stacked together break touches).

import { useState } from "react";
import { ActivityIndicator, Text, TextInput, TouchableOpacity, View } from "react-native";
import RNModal from "react-native-modal";

const REPORT_REASONS = [
  "Objectionable content",
  "Harassment or bullying",
  "Hate speech",
  "Sexual content or nudity",
  "Spam or scams",
  "Self-harm or violence",
  "Other",
];

const ReportContentModal = ({
  isVisible,
  onClose,
  onSubmit,
  submitting = false,
  theme,
  onModalHideComplete,
}) => {
  const [selectedReason, setSelectedReason] = useState("");
  const [notes, setNotes] = useState("");

  // Reset internal state when the modal closes so re-opening for a new
  // target doesn't show the previous selection. Done in onModalHide
  // (after dismiss animation) rather than on prop change so the chips
  // don't visibly clear before the modal slides off-screen.
  const handleModalHide = () => {
    setSelectedReason("");
    setNotes("");
    onModalHideComplete?.();
  };

  const handleSubmit = async () => {
    if (!selectedReason || submitting) return;
    await onSubmit?.({ reason: selectedReason, notes: notes.trim() || null });
  };

  return (
    <RNModal
      isVisible={isVisible}
      onBackdropPress={onClose}
      onBackButtonPress={onClose}
      onModalHide={handleModalHide}
      backdropOpacity={0.7}
      useNativeDriver
      avoidKeyboard
    >
      <View className="rounded-2xl px-5 py-6" style={{ backgroundColor: theme.surfaceElevated }}>
        <Text className="text-lg font-semibold" style={{ color: theme.text }}>
          Report content
        </Text>
        <Text className="mt-1 text-sm" style={{ color: theme.textMuted }}>
          Tell us what is wrong. We review every report.
        </Text>

        <View className="mt-3 flex-row flex-wrap">
          {REPORT_REASONS.map((reason) => {
            const selected = selectedReason === reason;
            return (
              <TouchableOpacity
                key={reason}
                onPress={() => setSelectedReason(reason)}
                className="mb-2 mr-2 rounded-full border px-3 py-2"
                style={{
                  borderColor: selected ? theme.primary : theme.border,
                  backgroundColor: selected ? theme.primarySoft : theme.surface,
                }}
              >
                <Text
                  className="text-xs font-semibold"
                  style={{ color: selected ? theme.primary : theme.text }}
                >
                  {reason}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <TextInput
          value={notes}
          onChangeText={setNotes}
          placeholder="Add details to help our review (optional)"
          placeholderTextColor={theme.placeholder}
          multiline
          editable={!submitting}
          className="mt-3 rounded-xl px-3 py-2"
          style={{
            minHeight: 70,
            textAlignVertical: "top",
            color: theme.inputText,
            borderWidth: 1,
            borderColor: theme.inputBorder,
            backgroundColor: theme.inputBackground,
          }}
        />

        <TouchableOpacity
          className="mt-4 rounded-xl px-4 py-3"
          style={{
            backgroundColor: !selectedReason || submitting ? theme.surfaceStrong : theme.primary,
          }}
          onPress={handleSubmit}
          disabled={!selectedReason || submitting}
        >
          <View className="flex flex-row items-center justify-center space-x-2">
            {submitting ? <ActivityIndicator size="small" color={theme.primaryContrast} /> : null}
            <Text
              className="text-center text-base font-semibold"
              style={{ color: theme.primaryContrast }}
            >
              {submitting ? "Sending report..." : "Submit report"}
            </Text>
          </View>
          <Text
            className="mt-1 text-center text-xs"
            style={{ color: theme.primaryContrast }}
          >
            We will remove it from your feed immediately.
          </Text>
        </TouchableOpacity>

        <TouchableOpacity className="mt-3 items-center" onPress={onClose} disabled={submitting}>
          <Text className="text-sm" style={{ color: theme.textMuted }}>
            Back
          </Text>
        </TouchableOpacity>
      </View>
    </RNModal>
  );
};

export default ReportContentModal;
