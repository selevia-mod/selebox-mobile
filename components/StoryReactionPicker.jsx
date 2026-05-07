// components/StoryReactionPicker.jsx
//
// Facebook-style 5-emoji reaction picker for the Moments viewer.
// Pops up above the action bar's reaction button. The user can:
//   • Tap an emoji → select it (or remove if it's their current pick)
//   • Tap the backdrop or scrim outside the pill → dismiss without
//     changing reaction
//
// Animation: spring scale-up on mount, individual stagger on each
// emoji so the row "blooms" left-to-right. On dismiss, fade + scale
// down. Uses native driver for transforms + opacity so the animation
// stays smooth on slower phones.
//
// Tap targets are 56dp (well above iOS HIG 44dp minimum) so users
// don't have to hit precisely between emojis. The pill itself sits
// just above the action bar with a soft shadow for separation.

import { useEffect, useRef } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text, View } from "react-native";
import useAppTheme from "../hooks/useAppTheme";

// Reaction registry — Instagram / Threads-style 10-reaction palette.
// Key matches the DB CHECK constraint (see
// 2026-05-07_story_reactions_expand.sql). The picker + StoryActionBar
// reaction row + StoryViewersSheet emoji map all consume this list,
// so adding a new reaction is a one-line change here once the SQL
// constraint is updated.
//
// `accent` colors the active-state ring around the user's current
// pick. They're picked to feel emoji-appropriate (warm for heart/
// fire, cool for cry, etc.) without being distractingly saturated.
//
// Order is the row order shown in the bar: heart first (most-used),
// then a curated mix of warmth → fun → contemplative → celebration.
export const REACTIONS = [
  { key: "heart",      emoji: "❤️", label: "Love",        accent: "#FF3B5C" },
  { key: "fire",       emoji: "🔥", label: "Fire",        accent: "#FF8A3D" },
  { key: "haha",       emoji: "😂", label: "Haha",        accent: "#FFD93D" },
  { key: "love",       emoji: "😍", label: "Adore",       accent: "#FF7AB6" },
  { key: "cry",        emoji: "😭", label: "Crying",      accent: "#7BB7FF" },
  { key: "eyes",       emoji: "👀", label: "Eyes",        accent: "#A8B5C9" },
  { key: "sparkle",    emoji: "✨", label: "Sparkle",     accent: "#F2C94C" },
  { key: "sad",        emoji: "😮", label: "Wow",         accent: "#FFA63D" },
  { key: "mind_blown", emoji: "🤯", label: "Mind blown",  accent: "#9F8BFF" },
  { key: "clap",       emoji: "🙌", label: "Clap",        accent: "#3DD68C" },
];

export default function StoryReactionPicker({ visible, currentReaction, onPick, onDismiss, anchorBottomOffset = 80 }) {
  const { theme } = useAppTheme();

  // Master scale + opacity. Each emoji additionally has its own
  // spring delay below to create the bloom effect.
  const scale = useRef(new Animated.Value(0.6)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const itemAnims = useRef(REACTIONS.map(() => new Animated.Value(0))).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.spring(scale, { toValue: 1, useNativeDriver: true, friction: 7, tension: 80 }),
        Animated.timing(opacity, { toValue: 1, duration: 160, useNativeDriver: true }),
      ]).start();
      // Stagger each emoji's pop-in so the row blooms.
      Animated.stagger(
        40,
        itemAnims.map((anim) =>
          Animated.spring(anim, {
            toValue: 1,
            useNativeDriver: true,
            friction: 6,
            tension: 90,
          }),
        ),
      ).start();
    } else {
      Animated.parallel([
        Animated.timing(scale, { toValue: 0.85, duration: 130, useNativeDriver: true, easing: Easing.in(Easing.cubic) }),
        Animated.timing(opacity, { toValue: 0, duration: 130, useNativeDriver: true }),
      ]).start();
      itemAnims.forEach((a) => a.setValue(0));
    }
  }, [visible, opacity, scale, itemAnims]);

  if (!visible) return null;

  return (
    <>
      {/* Invisible scrim — taps dismiss the picker. We use a Pressable
          that fills the whole screen (positioned absolute). Lower
          z-index than the pill itself so taps on emojis still land. */}
      <Pressable style={StyleSheet.absoluteFillObject} onPress={onDismiss} pointerEvents="auto" />

      {/* Pill — anchored above the bottom action bar. Floats with a
          dark glass background so it stays readable over any media. */}
      <Animated.View
        pointerEvents="box-none"
        style={[
          styles.pill,
          {
            bottom: anchorBottomOffset,
            backgroundColor: theme.mediaOverlayStrong || "rgba(0,0,0,0.85)",
            borderColor: "rgba(255,255,255,0.12)",
            transform: [{ scale }],
            opacity,
          },
        ]}
      >
        {REACTIONS.map((rxn, i) => {
          const isCurrent = currentReaction === rxn.key;
          const itemScale = itemAnims[i].interpolate({
            inputRange: [0, 1],
            outputRange: [0.5, 1],
          });
          const itemTranslateY = itemAnims[i].interpolate({
            inputRange: [0, 1],
            outputRange: [10, 0],
          });
          return (
            <Pressable
              key={rxn.key}
              onPress={() => onPick(rxn.key)}
              style={({ pressed }) => [
                styles.item,
                pressed && { transform: [{ scale: 1.15 }] },
                isCurrent && { backgroundColor: `${rxn.accent}26`, borderColor: rxn.accent },
              ]}
              accessibilityRole="button"
              accessibilityLabel={rxn.label}
              accessibilityState={{ selected: isCurrent }}
            >
              <Animated.Text
                style={{
                  fontSize: 32,
                  transform: [{ scale: itemScale }, { translateY: itemTranslateY }],
                }}
              >
                {rxn.emoji}
              </Animated.Text>
              {isCurrent ? (
                <Text style={[styles.label, { color: rxn.accent }]} numberOfLines={1}>
                  {rxn.label}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </Animated.View>
    </>
  );
}

const styles = StyleSheet.create({
  pill: {
    position: "absolute",
    alignSelf: "center",
    flexDirection: "row",
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 32,
    borderWidth: 1,
    // Drop shadow — extra separation from the action bar below.
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 12,
    left: 16,
    right: 16,
    justifyContent: "space-around",
  },
  item: {
    width: 56,
    height: 56,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 28,
    borderWidth: 1.5,
    borderColor: "transparent",
    marginHorizontal: 2,
  },
  label: {
    position: "absolute",
    bottom: -18,
    fontSize: 11,
    fontWeight: "700",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: "rgba(0,0,0,0.7)",
    overflow: "hidden",
  },
});
