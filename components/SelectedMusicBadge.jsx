import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef } from "react";
import { Animated, Image, Text, TouchableOpacity, View } from "react-native";
import useAppTheme from "../hooks/useAppTheme";

export default function SelectedMusicBadge({ selectedMusic, onRemove }) {
  const { theme } = useAppTheme();
  if (!selectedMusic) return null;

  // Equalizer animated bars
  const equalizerAnim = [useRef(new Animated.Value(1)).current, useRef(new Animated.Value(1)).current, useRef(new Animated.Value(1)).current];

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
    animateEqualizer();
  }, []);

  return (
    <View
      className="absolute top-3 z-50 flex-row items-center self-center rounded-2xl px-3 py-2"
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

      {/* Close Button */}
      <TouchableOpacity onPress={onRemove} className="ml-1 rounded-full p-1" style={{ backgroundColor: theme.mediaOverlay }}>
        <Ionicons name="close" size={14} color={theme.primaryContrast} />
      </TouchableOpacity>
    </View>
  );
}
