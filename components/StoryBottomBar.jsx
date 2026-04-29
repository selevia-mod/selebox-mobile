// components/StoryBottomBar.jsx
import { Ionicons } from "@expo/vector-icons";
import { Platform, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import useAppTheme from "../hooks/useAppTheme";

const StoryBottomBar = ({ isOwnStory, totalViews = 0, totalLikes = 0, hasLiked, onToggleLike }) => {
  const { theme } = useAppTheme();
  return (
    <SafeAreaView edges={["bottom"]} style={styles.safeWrapper}>
      {isOwnStory ? (
        <View style={styles.myStatsRow}>
          <View style={[styles.statsPill, { backgroundColor: theme.mediaOverlayStrong }]}>
            <Ionicons name="eye-outline" size={20} color={theme.primaryContrast} />
            <Text style={[styles.statsText, { color: theme.primaryContrast }]}>{totalViews}</Text>
          </View>

          <View style={[styles.statsPill, { backgroundColor: theme.mediaOverlayStrong }]}>
            <Ionicons name="heart" size={20} color={theme.like} />
            <Text style={[styles.statsText, { color: theme.primaryContrast }]}>{totalLikes}</Text>
          </View>
        </View>
      ) : (
        <TouchableOpacity onPress={onToggleLike} activeOpacity={0.8}>
          <View style={[styles.likeButton, { backgroundColor: theme.mediaOverlayStrong }]}>
            <Ionicons name={hasLiked ? "heart" : "heart-outline"} size={28} color={hasLiked ? theme.like : theme.primaryContrast} />
          </View>
        </TouchableOpacity>
      )}
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safeWrapper: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",

    // Ensures bottom bar never sits under the home indicator
    paddingBottom: Platform.OS === "android" ? 30 : 0,
  },

  myStatsRow: {
    flexDirection: "row",
    gap: 20,
  },
  statsPill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(15,23,42,0.8)",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
  },
  statsText: {
    fontSize: 14,
    marginLeft: 6,
  },

  likeButton: {
    width: 55,
    height: 55,
    borderRadius: 999,
    backgroundColor: "rgba(15,23,42,0.9)",
    alignItems: "center",
    justifyContent: "center",
  },
});

export default StoryBottomBar;
