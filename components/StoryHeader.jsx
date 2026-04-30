import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import useAppTheme from "../hooks/useAppTheme";
// Phase E.9 — tier-aware image transform.
import { optimizedImageUri } from "../lib/utils/image-source";
import { formatTimeAgo } from "../utils/formatTime";

const StoryHeader = ({ user, story, storyMusic, stories = [], currentStoryIndex = 0, progressWidth, onClose, onDelete, viewerUserId }) => {
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
    <View style={[styles.headerWrapper, { backgroundColor: theme.mediaOverlayStrong }]}>
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

      {/* Header row */}
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

        {/* Right area: Equalizer + Delete + Close */}
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
    </View>
  );
};

const styles = StyleSheet.create({
  headerWrapper: {
    flex: 1,
    paddingHorizontal: 14,
    paddingTop: 6,
    paddingBottom: 6,
    backgroundColor: "rgba(15,23,42,0.55)",
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
