import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import useAppTheme from "../hooks/useAppTheme";
// Phase E.9 — tier-aware image transform.
import { optimizedImageUri } from "../lib/utils/image-source";
import { formatTimeAgo } from "../utils/formatTime";

const StoryHeader = ({
  user,
  story,
  storyMusic,
  stories = [],
  currentStoryIndex = 0,
  progressWidth,
  onClose,
  onDelete,
  viewerUserId,
  // May 2026 — mute toggle moved here from the bottom action bar.
  // Sits as a small pill below the avatar so it's reachable with the
  // same thumb that's already on the screen edge for navigation.
  isMuted,
  onMuteToggle,
  // May 2026 — pause toggle moved here from the bottom action bar so
  // it mirrors the mute under-avatar pill on the opposite side. Sits
  // under the close X.
  isPaused,
  onPauseToggle,
}) => {
  const { theme } = useAppTheme();
  const eqAnim = [useRef(new Animated.Value(1)).current, useRef(new Animated.Value(1)).current, useRef(new Animated.Value(1)).current];

  const animateBars = () => {
    eqAnim.forEach((anim, i) => {
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
    if (storyMusic) animateBars();
  }, [storyMusic]);

  const isMyStory = story?.user?.id === viewerUserId;

  return (
    <View style={styles.headerWrapper}>
      {/* Faded top scrim — three stacked rectangles approximate a
          linear-gradient (we don't have expo-linear-gradient available
          in this build). Darker at the very top where the device's
          status bar / notch sits, fading to nearly transparent before
          the secondary toggle row, so the media reads through cleanly
          in the lower half of the header. */}
      <View pointerEvents="none" style={[styles.scrimLayer, styles.scrimTop]} />
      <View pointerEvents="none" style={[styles.scrimLayer, styles.scrimMid]} />
      <View pointerEvents="none" style={[styles.scrimLayer, styles.scrimBottom]} />

      {/* Progress bars */}
      <View style={styles.progressRow}>
        {stories.map((_, idx) => {
          const isCompleted = idx < currentStoryIndex;
          const isCurrent = idx === currentStoryIndex;

          return (
            <View key={idx} style={[styles.progressContainer, { backgroundColor: "rgba(255,255,255,0.35)" }]}>
              {isCompleted && <View style={[styles.progressCompleted, { backgroundColor: theme.primaryContrast }]} />}
              {isCurrent &&
                (progressWidth ? (
                  <Animated.View style={[styles.progressFill, { width: progressWidth, backgroundColor: theme.primaryContrast }]} />
                ) : (
                  <View style={[styles.progressCompleted, { backgroundColor: theme.primaryContrast }]} />
                ))}
            </View>
          );
        })}
      </View>

      {/* Header row — avatar + name/time on left, delete/close on right.
          Avatar stays a clean 42dp circle with name/time vertically
          centered next to it (no more under-avatar column messing up
          the baseline). Mute + Pause moved out to their own row below. */}
      <View style={styles.headerRow}>
        <View style={styles.headerLeft}>
          {user?.avatar && (
            <FastImage source={{ uri: optimizedImageUri(user.avatar, { width: 42 }) }} style={[styles.avatar, { borderColor: theme.accentPurple }]} />
          )}
          <View>
            <Text style={[styles.headerName, { color: theme.primaryContrast }]}>{user?.name ?? "Unknown User"}</Text>
            <Text style={[styles.headerTime, { color: "rgba(255,255,255,0.8)" }]}>{formatTimeAgo(new Date(story?.createdAt))}</Text>
          </View>
        </View>

        <View style={styles.rightArea}>
          {storyMusic && (
            <View style={styles.equalizerWrapper}>
              {[0, 1, 2].map((bar) => (
                <Animated.View key={bar} style={[styles.eqBar, { transform: [{ scaleY: eqAnim[bar] }], backgroundColor: theme.accentPurple }]} />
              ))}
            </View>
          )}

          {isMyStory && (
            <TouchableOpacity style={styles.deleteButton} onPress={onDelete}>
              <Ionicons name="trash-outline" size={20} color={theme.primaryContrast} />
            </TouchableOpacity>
          )}

          <TouchableOpacity style={[styles.closeButton, { backgroundColor: theme.mediaOverlayStrong }]} onPress={onClose}>
            <Ionicons name="close" size={24} color={theme.primaryContrast} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Secondary row — Mute on the far left (under the avatar
          column), Pause on the far right (under the close-X column).
          This row only renders when at least one of the two toggles
          is wired so the header doesn't reserve dead vertical space
          on screens that don't pass the props. Buttons are 32dp now
          (1.2x of the previous 26dp) for better tap-ability. */}
      {(typeof onMuteToggle === "function" || typeof onPauseToggle === "function") ? (
        <View style={styles.secondaryRow}>
          {typeof onMuteToggle === "function" ? (
            <TouchableOpacity
              onPress={onMuteToggle}
              hitSlop={6}
              style={styles.cornerToggle}
              accessibilityRole="button"
              accessibilityLabel={isMuted ? "Unmute audio" : "Mute audio"}
            >
              <Ionicons
                name={isMuted ? "volume-mute" : "volume-high"}
                size={18}
                color={theme.primaryContrast}
              />
            </TouchableOpacity>
          ) : <View style={{ width: 32, height: 32 }} />}

          {typeof onPauseToggle === "function" ? (
            <TouchableOpacity
              onPress={onPauseToggle}
              hitSlop={6}
              style={styles.cornerToggle}
              accessibilityRole="button"
              accessibilityLabel={isPaused ? "Resume" : "Pause"}
            >
              <Ionicons
                name={isPaused ? "play" : "pause"}
                size={18}
                color={theme.primaryContrast}
              />
            </TouchableOpacity>
          ) : <View style={{ width: 32, height: 32 }} />}
        </View>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  headerWrapper: {
    flex: 1,
    paddingHorizontal: 14,
    paddingTop: 6,
    paddingBottom: 6,
    // No solid bg — replaced by stacked faded scrim layers below.
  },
  // Stacked-rectangle gradient (poor man's LinearGradient). Each
  // layer covers a horizontal slice of the header with decreasing
  // opacity from top to bottom. The "step" between layers is
  // imperceptible at runtime because they overlap by 1pt.
  scrimLayer: {
    position: "absolute",
    left: 0,
    right: 0,
  },
  scrimTop: {
    top: 0,
    height: "40%",
    backgroundColor: "rgba(0,0,0,0.42)",
  },
  scrimMid: {
    top: "38%",
    height: "30%",
    backgroundColor: "rgba(0,0,0,0.22)",
  },
  scrimBottom: {
    top: "65%",
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.08)",
  },

  // Progress bars
  progressRow: {
    flexDirection: "row",
    gap: 4,
    marginBottom: 6,
  },
  progressContainer: {
    flex: 1,
    height: 3,
    borderRadius: 999,
    overflow: "hidden",
  },
  progressCompleted: {
    ...StyleSheet.absoluteFillObject,
  },
  progressFill: {
    ...StyleSheet.absoluteFillObject,
  },

  // Main header row
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 4,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 2,
  },
  // Secondary row that stacks under the main header row. Mute on
  // the left, pause on the right, with flex space-between so they
  // hug their respective corners regardless of screen width.
  secondaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 8,
  },
  // 32dp circular toggle for the mute / pause buttons. No fill
  // background — the user wants the dark "black box" gone, just the
  // white icon glyph reading directly off the media. The 18dp glyph
  // gives plenty of contrast on its own without a backing pill.
  // hitSlop on the parent expands the actual tap area beyond 32dp.
  cornerToggle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    // Subtle text-shadow on the icon (handled inline by Ionicons'
    // shadow* props would be ideal, but a tiny rgba background gives
    // the same legibility lift without a hard-edged black pill).
    backgroundColor: "rgba(0,0,0,0.18)",
  },
  headerName: {
    fontSize: 15,
    fontWeight: "600",
  },
  headerTime: {
    fontSize: 11,
    marginTop: 2,
  },

  // Right side
  rightArea: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },

  // Equalizer
  equalizerWrapper: {
    flexDirection: "row",
    alignItems: "flex-end",
  },
  eqBar: {
    width: 3,
    height: 12,
    marginHorizontal: 1,
    borderRadius: 2,
  },
  deleteButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  closeButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
});

export default StoryHeader;
