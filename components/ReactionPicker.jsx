import { useEffect, useRef } from "react";
import { Animated, Dimensions, Easing, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import useAppTheme from "../hooks/useAppTheme";
import { REACTIONS } from "../lib/reactions";

// Floating reaction pill — anchored to the Like button via screen-space
// coordinates passed in `anchor`. Mirrors the web reaction-picker styling
// (violet-tinted border, deep shadow, scale+fade entrance with the same
// cubic-bezier(0.16, 1, 0.3, 1) curve), adapted for RN.
const PICKER_HEIGHT = 64; // approx — emoji 24px + label 9px + padding
const PICKER_WIDTH = 300;
const PICKER_OFFSET_FROM_ANCHOR = 12;
const SCREEN_PADDING = 12;

const ReactionPicker = ({ visible, anchor, onSelect, onClose, activeKey }) => {
  const { theme } = useAppTheme();

  const scale = useRef(new Animated.Value(0.92)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(6)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 1,
          duration: 180,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(scale, {
          toValue: 1,
          duration: 220,
          easing: Easing.bezier(0.16, 1, 0.3, 1),
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: 0,
          duration: 220,
          easing: Easing.bezier(0.16, 1, 0.3, 1),
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      opacity.setValue(0);
      scale.setValue(0.92);
      translateY.setValue(6);
    }
  }, [visible, opacity, scale, translateY]);

  if (!visible || !anchor) return null;

  // Position the picker centered horizontally over the Like button, sitting
  // just above it. Caller supplies anchor.x (left edge of Like in window
  // coords), anchor.width (Like width), anchor.y (top of Like in window).
  // Clamp horizontally so the pill stays inside the viewport even when the
  // Like button is near the screen edge.
  const screenWidth = Dimensions.get("window").width;
  const desiredCenterX = anchor.x + anchor.width / 2;
  const minCenterX = SCREEN_PADDING + PICKER_WIDTH / 2;
  const maxCenterX = screenWidth - SCREEN_PADDING - PICKER_WIDTH / 2;
  const centerX = Math.max(minCenterX, Math.min(desiredCenterX, maxCenterX));
  const top = anchor.y - PICKER_HEIGHT - PICKER_OFFSET_FROM_ANCHOR;

  return (
    <Modal transparent visible={visible} onRequestClose={onClose} animationType="none" statusBarTranslucent>
      <Pressable style={StyleSheet.absoluteFillObject} onPress={onClose}>
        <View pointerEvents="box-none" style={[StyleSheet.absoluteFillObject]}>
          <Animated.View
            pointerEvents="auto"
            style={[
              styles.picker,
              {
                top,
                left: centerX,
                transform: [{ translateX: -PICKER_WIDTH / 2 }, { translateY }, { scale }],
                opacity,
                backgroundColor: theme.surfaceElevated,
                borderColor: "rgba(139, 92, 246, 0.20)",
              },
            ]}
          >
            {REACTIONS.map((r) => {
              const isActive = activeKey === r.key;
              return (
                <Pressable
                  key={r.key}
                  onPress={() => {
                    onSelect?.(r.key);
                    onClose?.();
                  }}
                  style={({ pressed }) => [
                    styles.option,
                    isActive && { backgroundColor: "rgba(167, 139, 250, 0.14)" },
                    pressed && { transform: [{ scale: 1.35 }, { translateY: -3 }] },
                  ]}
                >
                  <Text style={styles.emoji}>{r.emoji}</Text>
                  <Text style={[styles.label, { color: theme.textSoft }]}>{r.label}</Text>
                </Pressable>
              );
            })}
          </Animated.View>
        </View>
      </Pressable>
    </Modal>
  );
};

const styles = StyleSheet.create({
  picker: {
    position: "absolute",
    width: PICKER_WIDTH,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    shadowColor: "#000",
    shadowOpacity: 0.45,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 12 },
    elevation: 14,
  },
  option: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 4,
    paddingHorizontal: 4,
    borderRadius: 10,
  },
  emoji: {
    fontSize: 26,
    // lineHeight at 1.3× fontSize so emoji descenders (heart bottom, cry tear)
    // don't get clipped by the line box. Was 30 (1.15×) which cropped the heart.
    lineHeight: 34,
  },
  label: {
    fontSize: 9,
    letterSpacing: 0.2,
    marginTop: 2,
  },
});

export default ReactionPicker;
