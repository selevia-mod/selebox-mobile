// components/BookRatingModal.jsx
//
// Premium rating bottom-sheet. Replaces the earlier centered-card RN
// Modal that several users reported as "Rate button not working" —
// part of the issue was the modal's design read like an accidental
// pop-up: tiny stars, weak Submit button, no clear hierarchy.
//
// New shape:
//   • Slide-up bottom sheet (react-native-modal, same look as
//     BalanceRecoveryBanner / Payment-Info request-edit modal).
//   • Drag handle pill at top.
//   • Title + subtitle copy explaining the action.
//   • Large 44pt star row with press-feedback scale + active-fill
//     animation for unambiguous tap feedback.
//   • Live label below the row ("Tap to rate" / "Loved it!" / etc.)
//     so users know what their stars mean before submitting.
//   • Premium primary action button (deep accent, top-half highlight,
//     glass border, soft accent shadow, letter-spaced 700 label) —
//     same treatment as the Request-edit button on Payment Info.
//   • Cancel as a clean ghost button alongside Submit, never alone.
//
// Wiring is the existing contract: parent passes isVisible, onClose,
// onSubmit(rating). No prop changes — drop-in replacement.

import { Feather, Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { Pressable, Text, TouchableOpacity, View } from "react-native";
import RNModal from "react-native-modal";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import useAppTheme from "../hooks/useAppTheme";

const RATING_LABELS = {
  0: "Tap a star to rate",
  1: "Not for me",
  2: "It was okay",
  3: "Pretty good",
  4: "Really enjoyed it",
  5: "Loved it",
};

const BookRatingModal = ({ isVisible, onClose, onSubmit }) => {
  const { theme } = useAppTheme();
  const insets = useSafeAreaInsets();
  const [selectedRating, setSelectedRating] = useState(0);

  // Reset selection on open so a re-opened modal doesn't carry over
  // a previous selection that was never submitted.
  useEffect(() => {
    if (!isVisible) return;
    setSelectedRating(0);
  }, [isVisible]);

  const handleRate = (value) => setSelectedRating(value);

  const handleSubmit = () => {
    if (selectedRating <= 0) return;
    // Capture, close, then notify parent. Closing first feels snappier
    // and the parent's Alert.alert("Thanks for rating") slides in
    // cleanly behind the dismiss animation.
    const v = selectedRating;
    onSubmit?.(v);
    onClose?.();
  };

  const isDisabled = selectedRating === 0;

  return (
    <RNModal
      isVisible={isVisible}
      onBackdropPress={onClose}
      onSwipeComplete={onClose}
      swipeDirection={["down"]}
      backdropOpacity={0.5}
      style={{ justifyContent: "flex-end", margin: 0 }}
      useNativeDriver
      hideModalContentWhileAnimating
      animationIn="slideInUp"
      animationOut="slideOutDown"
      avoidKeyboard
    >
      <View
        style={{
          backgroundColor: theme.surfaceElevated || theme.background,
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
          paddingHorizontal: 18,
          paddingTop: 12,
          paddingBottom: insets.bottom + 22,
        }}
      >
        {/* Drag handle */}
        <View
          style={{
            alignSelf: "center",
            width: 40,
            height: 4,
            borderRadius: 2,
            backgroundColor: theme.border,
            marginBottom: 16,
          }}
        />

        <Text style={{ color: theme.text, fontSize: 20, fontWeight: "700", textAlign: "center" }}>
          Rate this Book
        </Text>
        <Text
          style={{
            color: theme.textSoft,
            fontSize: 12,
            textAlign: "center",
            marginTop: 4,
            marginBottom: 22,
            lineHeight: 16,
          }}
        >
          Your rating helps other readers find great books — and helps the author know what landed.
        </Text>

        {/* Star row — 44pt taps, scale-on-press, color-fill on active */}
        <View style={{ flexDirection: "row", justifyContent: "center", marginBottom: 10 }}>
          {[1, 2, 3, 4, 5].map((star) => {
            const isActive = star <= selectedRating;
            return (
              <Pressable
                key={star}
                onPress={() => handleRate(star)}
                accessibilityRole="button"
                accessibilityLabel={`Rate ${star} ${star === 1 ? "star" : "stars"}`}
                style={({ pressed }) => ({
                  paddingHorizontal: 4,
                  paddingVertical: 6,
                  transform: [{ scale: pressed ? 1.18 : 1 }],
                })}
                hitSlop={6}
              >
                <Ionicons
                  name={isActive ? "star" : "star-outline"}
                  size={42}
                  color={isActive ? theme.coin : theme.iconMuted || theme.textSubtle}
                  style={{
                    textShadowColor: isActive ? "rgba(0,0,0,0.18)" : "transparent",
                    textShadowOffset: { width: 0, height: 2 },
                    textShadowRadius: 4,
                  }}
                />
              </Pressable>
            );
          })}
        </View>

        {/* Live label — tells the user what their pick means before
            they commit. "Tap a star to rate" / "Loved it" etc. */}
        <Text
          style={{
            color: selectedRating > 0 ? theme.text : theme.textSoft,
            fontSize: 13,
            fontWeight: selectedRating > 0 ? "600" : "400",
            textAlign: "center",
            marginBottom: 22,
            minHeight: 18,
          }}
        >
          {RATING_LABELS[selectedRating]}
        </Text>

        {/* Action row */}
        <View style={{ flexDirection: "row", gap: 8 }}>
          <TouchableOpacity
            onPress={onClose}
            activeOpacity={0.85}
            style={{
              flex: 1,
              paddingVertical: 14,
              borderRadius: 16,
              alignItems: "center",
              borderWidth: 1,
              borderColor: theme.border,
            }}
          >
            <Text style={{ color: theme.text, fontSize: 14, fontWeight: "600" }}>Cancel</Text>
          </TouchableOpacity>

          {/* Premium Submit — same treatment as the Request-edit button
              on Payment Info: deep accent, white-tint top half (gradient
              fake), glass-tinted inner border, soft accent shadow,
              letter-spaced 700 label. Disabled state dims to ~50% via
              opacity but keeps the styling intact so it reads as
              "waiting for input" rather than "broken". */}
          <TouchableOpacity
            onPress={handleSubmit}
            disabled={isDisabled}
            activeOpacity={0.92}
            style={{
              flex: 1.4,
              borderRadius: 16,
              overflow: "hidden",
              backgroundColor: theme.accentPurple || theme.primary,
              borderWidth: 1,
              borderColor: "rgba(255,255,255,0.18)",
              shadowColor: theme.accentPurple || theme.primary,
              shadowOffset: { width: 0, height: 6 },
              shadowOpacity: isDisabled ? 0.0 : 0.32,
              shadowRadius: 12,
              elevation: isDisabled ? 0 : 6,
              opacity: isDisabled ? 0.55 : 1,
            }}
          >
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                height: "55%",
                backgroundColor: "rgba(255,255,255,0.10)",
              }}
            />
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                paddingVertical: 14,
                paddingHorizontal: 18,
              }}
            >
              <View
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 11,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: "rgba(255,255,255,0.22)",
                  marginRight: 8,
                }}
              >
                <Feather name="send" size={12} color={theme.primaryContrast || "#fff"} />
              </View>
              <Text
                style={{
                  color: theme.primaryContrast || "#fff",
                  fontSize: 14,
                  fontWeight: "700",
                  letterSpacing: 0.4,
                }}
              >
                {isDisabled ? "Tap to rate" : "Submit"}
              </Text>
            </View>
          </TouchableOpacity>
        </View>
      </View>
    </RNModal>
  );
};

export default BookRatingModal;
