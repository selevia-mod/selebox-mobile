import { useFocusEffect } from "expo-router";
import { useCallback, useRef } from "react";
import { Animated, Dimensions } from "react-native";
import useAppTheme from "../hooks/useAppTheme";

const screenWidth = Dimensions.get("window").width;

// Utility to generate random width between 30% and 80% of screen width
export const getRandomSkeletonWidth = () => {
  const minWidth = screenWidth * 0.3;
  const maxWidth = screenWidth * 0.6;
  return Math.floor(Math.random() * (maxWidth - minWidth + 1) + minWidth) - 32;
};

const AnimatedSkeleton = ({ style, className }) => {
  const { theme } = useAppTheme();
  const opacity = useRef(new Animated.Value(0.3)).current;

  useFocusEffect(
    useCallback(() => {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(opacity, {
            toValue: 1,
            duration: 800,
            useNativeDriver: true,
          }),
          Animated.timing(opacity, {
            toValue: 0.3,
            duration: 800,
            useNativeDriver: true,
          }),
        ]),
      );
      loop.start();

      return () => loop.stop(); // clean up on unmount
    }, []),
  );

  return <Animated.View style={[{ opacity, backgroundColor: theme.skeletonHighlight, borderRadius: 6 }, style]} className={className} />;
};

export default AnimatedSkeleton;
