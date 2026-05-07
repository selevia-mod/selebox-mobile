import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef } from "react";
import { Animated, Image, Text, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import useAppTheme from "../hooks/useAppTheme";

export default function SelectedMusicBadge({ selectedMusic, onRemove }) {
  const { theme } = useAppTheme();
  const insets = useSafeAreaInsets();

  // IMPORTANT: All hooks must run BEFORE any conditional return.
  // The previous version had `if (!selectedMusic) return null` above
  // these useRef + useEffect calls, which meant the hook count
  // changed when selectedMusic flipped from null → object after the
  // music picker resolved. That triggered "Rendered more hooks than
  // during the previous render" and crashed the editor.
  const equalizerAnim = [
    useRef(new Animated.Value(1)).current,
    useRef(new Animated.Value(1)).current,
    useRef(new Animated.Value(1)).current,
  ];

  const animateEqualizer = () => {
    equalizerAnim.forEach((anim, i) => {
      Animated.loop(
        Animated.sequence([
          Animated.timing(anim, {
            toValue: 0.3,
            duration: 300 + i * 80,
            useNativeDriver: true,
          }),
          Animated.timing(anim, {
            toValue: 1,
            duration: 300 + i * 80,
            useNativeDriver: true,
          }),
        ]),
      ).start();
    });
  };

  useEffect(() => {
    if (!selectedMusic) return;
    animateEqualizer();
    // Re-run when the picked track changes — without this dep, a
    // user swapping tracks won't restart the equalizer pulse for
    // the new selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMusic?.$id]);

  // Conditional render moved AFTER all hooks.
  if (!selectedMusic) return null;

  return (
    // Sits BELOW the topActions row (which itself is at insets.top + 6
    // and ~44dp tall) so it clears the Dynamic Island / notch on
    // iPhones AND the editor's close X button. Previously it was at
    // top-3 (12px), which on Pro / Pro Max devices put the badge
    // close button directly under the camera island — unreachable.
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        top: insets.top + 56,
        left: 0,
        right: 0,
        zIndex: 50,
        alignItems: "center",
      }}
    >
      <View
        className="flex-row items-center rounded-2xl px-3 py-2"
        style={{ backgroundColor: theme.mediaOverlayStrong }}
      >
        {/* Thumbnail */}
        {selectedMusic.thumbnailUrl ? (
          <Image source={{ uri: selectedMusic.thumbnailUrl }} className="mr-2 h-8 w-8 rounded-md" />
        ) : (
          <View className="mr-2 h-8 w-8 items-center justify-center rounded-md" style={{ backgroundColor: theme.accentPurpleSoft }}>
            <Ionicons name="musical-notes" size={16} color={theme.accentPurple} />
          </View>
        )}

        {/* Equalizer Animation */}
        <View className="mr-2 flex-row items-end">
          {[0, 1, 2].map((bar) => (
            <Animated.View
              key={bar}
              style={{
                width: 3,
                marginHorizontal: 1,
                borderRadius: 2,
                backgroundColor: theme.accentPurple,
                height: 12,
                transform: [{ scaleY: equalizerAnim[bar] }],
              }}
            />
          ))}
        </View>

        {/* Song Text */}
        <View className="mr-3 max-w-[150px] flex-col">
          <Text className="text-sm font-semibold" style={{ color: theme.primaryContrast }} numberOfLines={1}>
            {selectedMusic.title}
          </Text>
          <Text className="text-xs" style={{ color: "rgba(255,255,255,0.8)" }} numberOfLines={1}>
            {selectedMusic.artist}
          </Text>
        </View>

        {/* Close Button — bigger hit target so it doesn't fight the
            tightly packed badge layout. */}
        <TouchableOpacity
          onPress={onRemove}
          hitSlop={10}
          className="ml-1 h-7 w-7 items-center justify-center rounded-full"
          style={{ backgroundColor: theme.mediaOverlay }}
          accessibilityRole="button"
          accessibilityLabel="Remove music"
        >
          <Ionicons name="close" size={14} color={theme.primaryContrast} />
        </TouchableOpacity>
      </View>
    </View>
  );
}
