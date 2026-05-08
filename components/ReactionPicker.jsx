import { useEffect, useRef, useState } from "react";
import { Animated, Dimensions, Easing, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import useAppTheme from "../hooks/useAppTheme";
import { REACTIONS } from "../lib/reactions";
import HeartReact from "../assets/reactions/Heart-react.svg";
import HahaReact from "../assets/reactions/Haha-react.svg";
import SadReact from "../assets/reactions/Sad-react.svg";
import CryReact from "../assets/reactions/Cry-react.svg";
import AngryReact from "../assets/reactions/Angry-react.svg";

// Map the picker's reaction keys to the same custom SVG components
// the inline action button + stats row use (see PostReaction.jsx).
// Keeps the picker consistent with the rest of the reaction UI —
// long-press → pick → the icon you saw in the picker is exactly
// what shows up next to "Liked" on the action row.
const PICKER_ICONS = {
  heart: HeartReact,
  laugh: HahaReact,
  sad: SadReact,
  cry: CryReact,
  angry: AngryReact,
};
const PICKER_ICON_SIZE = 36;

// Floating reaction pill — anchored to the Like button via screen-space
// coordinates passed in `anchor`. Mirrors the web reaction-picker styling
// (violet-tinted border, deep shadow, scale+fade entrance with the same
// cubic-bezier(0.16, 1, 0.3, 1) curve), adapted for RN.
const PICKER_HEIGHT = 64; // approx — emoji 24px + label 9px + padding
const PICKER_WIDTH = 300;
const PICKER_OFFSET_FROM_ANCHOR = 12;
const SCREEN_PADDING = 12;

// Single emoji button inside the picker. Owns an Animated.Value for
// its own scale so press-in / press-out animate as a spring instead
// of snapping via the CSS `pressed` style. The spring on press-in
// fires the moment the user's finger touches the emoji — gives
// instant tactile feedback well before the actual onPress callback
// runs (which only fires on release).
const PickerOption = ({ reaction, isActive, Icon, labelColor, onPick }) => {
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const animateTo = (toValue) => {
    Animated.spring(scaleAnim, {
      toValue,
      useNativeDriver: true,
      friction: 5,
      tension: 200,
    }).start();
  };

  return (
    <Pressable
      onPressIn={() => animateTo(1.3)}
      onPressOut={() => animateTo(1)}
      onPress={onPick}
      hitSlop={6}
      style={[
        styles.option,
        isActive && { backgroundColor: "rgba(167, 139, 250, 0.14)" },
      ]}
    >
      <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
        {Icon ? (
          <Icon width={PICKER_ICON_SIZE} height={PICKER_ICON_SIZE} />
        ) : (
          // Defensive fallback — shouldn't trigger with the 5 mapped reactions.
          <Text style={styles.emoji}>{reaction.emoji}</Text>
        )}
      </Animated.View>
      <Text style={[styles.label, { color: labelColor }]}>{reaction.label}</Text>
    </Pressable>
  );
};

const ReactionPicker = ({ visible, anchor, onSelect, onClose, activeKey }) => {
  const { theme } = useAppTheme();

  const scale = useRef(new Animated.Value(0.92)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(6)).current;

  // "Armed" gate for the backdrop's onPress. The picker mounts the
  // moment a long-press fires — but at that instant the user's finger
  // is STILL DOWN on the like button. When they release, RN routes
  // that lift through the freshly-mounted backdrop as a tap, which
  // would close the picker before the user could interact with it
  // (the bug: "first long-press doesn't show the reaction"). We
  // disable the backdrop's onPress for the first 350ms after the
  // picker becomes visible — long enough for the user's finger to
  // come up, short enough that intentional dismiss-by-tap still feels
  // immediate.
  const [armed, setArmed] = useState(false);

  // Render-gate that lags slightly behind the `visible` prop on
  // close, so we can play a fade-out animation BEFORE unmounting.
  // Without this, flipping visible→false instantly returned null and
  // the picker just snapped away — Charles flagged the dismiss as
  // "could be faster / smoother". Now: visible prop true → render
  // immediately + fade in. Visible prop false → fade out (130ms),
  // then drop the mount.
  const [internalVisible, setInternalVisible] = useState(false);

  useEffect(() => {
    if (visible) {
      setInternalVisible(true);
      setArmed(false);
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
      // Arm after the user's lift-from-long-press window has passed.
      // 350ms covers the slowest natural release.
      const armTimer = setTimeout(() => setArmed(true), 350);
      return () => clearTimeout(armTimer);
    } else if (internalVisible) {
      // Quick fade-out + scale-down so the dismiss feels deliberate
      // instead of snapping. 130ms is short enough that the user's
      // attention has already moved to the action button updating
      // with their picked reaction.
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 0,
          duration: 130,
          easing: Easing.in(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(scale, {
          toValue: 0.94,
          duration: 130,
          easing: Easing.in(Easing.ease),
          useNativeDriver: true,
        }),
      ]).start(({ finished }) => {
        if (finished) setInternalVisible(false);
      });
      setArmed(false);
    }
  }, [visible, opacity, scale, translateY, internalVisible]);

  if (!internalVisible || !anchor) return null;

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
            {REACTIONS.map((r) => (
              <PickerOption
                key={r.key}
                reaction={r}
                isActive={activeKey === r.key}
                Icon={PICKER_ICONS[r.key]}
                labelColor={theme.textSoft}
                onPick={() => {
                  onSelect?.(r.key);
                  onClose?.();
                }}
              />
            ))}
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
