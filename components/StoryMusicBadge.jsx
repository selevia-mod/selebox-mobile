import { useEffect, useRef } from "react";
import { Animated, Text, View } from "react-native";
import useAppTheme from "../hooks/useAppTheme";

export default function StoryMusicBadge({ title, artist }) {
  const { theme } = useAppTheme();
  const bar1 = useRef(new Animated.Value(0)).current;
  const bar2 = useRef(new Animated.Value(0)).current;
  const bar3 = useRef(new Animated.Value(0)).current;

  const animateBar = (bar, delay) => {
    return Animated.loop(
      Animated.sequence([
        Animated.timing(bar, { toValue: 1, duration: 300, delay, useNativeDriver: true }),
        Animated.timing(bar, { toValue: 0, duration: 300, useNativeDriver: true }),
      ]),
    ).start();
  };

  useEffect(() => {
    animateBar(bar1, 0);
    animateBar(bar2, 150);
    animateBar(bar3, 300);
  }, []);

  const barStyle = (bar) => ({
    transform: [
      {
        scaleY: bar.interpolate({
          inputRange: [0, 1],
          outputRange: [0.4, 1.4],
        }),
      },
    ],
  });

  return (
    <View className="mt-1 flex-row items-center">
      {/* equalizer */}
      <View className="mr-2 flex-row">
        <Animated.View className="mx-[1px] h-[10px] w-[3px] rounded-[1px]" style={[barStyle(bar1), { backgroundColor: theme.primaryContrast }]} />
        <Animated.View className="mx-[1px] h-[10px] w-[3px] rounded-[1px]" style={[barStyle(bar2), { backgroundColor: theme.primaryContrast }]} />
        <Animated.View className="mx-[1px] h-[10px] w-[3px] rounded-[1px]" style={[barStyle(bar3), { backgroundColor: theme.primaryContrast }]} />
      </View>

      {/* text */}
      <Text className="text-xs font-semibold" style={{ color: theme.primaryContrast }} numberOfLines={1}>
        {title} <Text style={{ color: "rgba(255,255,255,0.6)" }}>— {artist}</Text>
      </Text>
    </View>
  );
}
