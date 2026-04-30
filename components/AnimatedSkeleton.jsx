import { useFocusEffect } from "expo-router";
import { useCallback, useRef } from "react";
import { Animated, Dimensions, View } from "react-native";
import useAppTheme from "../hooks/useAppTheme";
// Phase E.7 — gate skeleton pulse animation on low-tier devices.
// PostCardSkeleton mounts 4–6 of these at once (one per skeleton card,
// each with multiple lines), so the cumulative cost of a half-second
// fade loop times N skeletons compounds. Low-tier renders a static
// highlight color instead.
import { prefersReducedMotion } from "../lib/device-tier";

const screenWidth = Dimensions.get("window").width;

// Utility to generate random width between 30% and 80% of screen width
export const getRandomSkeletonWidth = () => {
  const minWidth = screenWidth * 0.3;
  const maxWidth = screenWidth * 0.6;
  return Math.floor(Math.random() * (maxWidth - minWidth + 1) + minWidth) - 32;
};

// Cached at module load — tier doesn't change mid-session, so we don't
// need to call prefersReducedMotion() in render.
const REDUCE_MOTION = prefersReducedMotion();

// Static fallback for low-tier — no animation, no Animated value, no
// useFocusEffect, no useCallback. Plain View with a fixed opacity that
// composites identically to the mid-loop's resting state.
const StaticSkeleton = ({ style, className }) => {
  const { theme } = useAppTheme();
  return <View style={[{ opacity: 0.65, backgroundColor: theme.skeletonHighlight, borderRadius: 6 }, style]} className={className} />;
};

const PulsingSkeleton = ({ style, className }) => {
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
      return () => loop.stop();
    }, []),
  );

  return <Animated.View style={[{ opacity, backgroundColor: theme.skeletonHighlight, borderRadius: 6 }, style]} className={className} />;
};

// Pick the variant once at module load. Component swap (not a runtime
// branch) means low-tier devices never even mount the
// useRef/useFocusEffect/Animated.Value machinery for the pulse —
// React just renders the static View directly.
const AnimatedSkeleton = REDUCE_MOTION ? StaticSkeleton : PulsingSkeleton;

export default AnimatedSkeleton;
