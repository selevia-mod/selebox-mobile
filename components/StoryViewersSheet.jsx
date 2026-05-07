// components/StoryViewersSheet.jsx
//
// Owner-only bottom sheet showing who viewed the current Moment.
// Surfaced from the action bar's "viewers" button (only rendered for
// the story's owner). Mimics the IG/TikTok pattern: avatar + name
// row, sorted by recency, with each viewer's reaction emoji shown
// next to their name if they reacted.
//
// Props:
//   • visible        — boolean
//   • onClose        — () => void
//   • storyId        — uuid of the active Moment
//   • totalViews     — number to show in the header
//   • totalReactions — number to show in the header (for the count chip)
//
// Loads viewers via StoryService.getStoryViewers on first open per
// storyId. The sheet caches the list locally so re-opening within the
// same session is instant. We don't realtime-subscribe — viewer
// activity is a slow signal and a manual refresh button covers most
// cases.

import { Feather } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import RNModal from "react-native-modal";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import useAppTheme from "../hooks/useAppTheme";
import { StoryService } from "../lib/story-service";
import { REACTIONS } from "./StoryReactionPicker";

// Map reaction key → emoji for quick lookups when rendering rows.
// Avoids re-deriving in every renderItem.
const REACTION_EMOJI = REACTIONS.reduce((acc, r) => {
  acc[r.key] = r.emoji;
  return acc;
}, {});

const formatRelative = (iso) => {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return "1d ago";
};

export default function StoryViewersSheet({ visible, onClose, storyId, totalViews = 0, totalReactions = 0 }) {
  const { theme } = useAppTheme();
  const insets = useSafeAreaInsets();

  const [viewers, setViewers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    if (!storyId) return;
    setLoading(true);
    try {
      const list = await StoryService.getStoryViewers(storyId, { limit: 100 });
      setViewers(list || []);
    } catch (e) {
      console.log("[viewers sheet] load error:", e?.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (visible) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, storyId]);

  const renderItem = ({ item }) => {
    const reactionEmoji = item.reaction ? REACTION_EMOJI[item.reaction] : null;
    return (
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingVertical: 10,
          paddingHorizontal: 4,
        }}
      >
        {item.avatar ? (
          <Image
            source={{ uri: item.avatar }}
            style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: theme.surfaceMuted }}
          />
        ) : (
          <View
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: theme.accentPurpleSoft,
            }}
          >
            <Feather name="user" size={20} color={theme.accentPurple} />
          </View>
        )}
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text numberOfLines={1} style={{ color: theme.text, fontSize: 15, fontWeight: "600" }}>
            {item.username}
          </Text>
          <Text style={{ color: theme.textSoft, fontSize: 12, marginTop: 2 }}>{formatRelative(item.viewedAt)}</Text>
        </View>
        {reactionEmoji ? <Text style={{ fontSize: 22, marginLeft: 8 }}>{reactionEmoji}</Text> : null}
      </View>
    );
  };

  return (
    <RNModal
      isVisible={visible}
      onBackdropPress={onClose}
      onSwipeComplete={onClose}
      swipeDirection={["down"]}
      propagateSwipe
      backdropOpacity={0.55}
      style={{ justifyContent: "flex-end", margin: 0 }}
      useNativeDriver
      hideModalContentWhileAnimating
      animationIn="slideInUp"
      animationOut="slideOutDown"
    >
      <View
        style={{
          height: "78%",
          borderTopLeftRadius: 28,
          borderTopRightRadius: 28,
          overflow: "hidden",
          backgroundColor: theme.surfaceElevated,
          paddingHorizontal: 18,
          paddingTop: 10,
          paddingBottom: insets.bottom + 12,
        }}
      >
        {/* Drag handle */}
        <View
          style={{
            alignSelf: "center",
            width: 40,
            height: 4,
            borderRadius: 2,
            backgroundColor: theme.border,
            marginBottom: 14,
          }}
        />

        {/* Header — title + counts + close + refresh */}
        <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 20, fontWeight: "700", color: theme.text }}>Activity</Text>
            <Text style={{ fontSize: 12, color: theme.textSoft, marginTop: 2 }}>
              {totalViews} {totalViews === 1 ? "view" : "views"}
              {totalReactions > 0 ? `  ·  ${totalReactions} ${totalReactions === 1 ? "reaction" : "reactions"}` : ""}
            </Text>
          </View>
          <TouchableOpacity
            onPress={() => {
              setRefreshing(true);
              load();
            }}
            hitSlop={10}
            style={[styles.iconBtn, { backgroundColor: theme.surfaceMuted, marginRight: 8 }]}
            accessibilityRole="button"
            accessibilityLabel="Refresh"
          >
            {refreshing ? (
              <ActivityIndicator size="small" color={theme.icon} />
            ) : (
              <Feather name="refresh-cw" size={16} color={theme.icon} />
            )}
          </TouchableOpacity>
          <Pressable
            onPress={onClose}
            hitSlop={10}
            style={[styles.iconBtn, { backgroundColor: theme.surfaceMuted }]}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <Feather name="x" size={16} color={theme.icon} />
          </Pressable>
        </View>

        {loading && viewers.length === 0 ? (
          <View style={{ alignItems: "center", paddingVertical: 40 }}>
            <ActivityIndicator color={theme.accentPurple} />
          </View>
        ) : (
          <FlatList
            data={viewers}
            keyExtractor={(item) => item.viewerId}
            renderItem={renderItem}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 24 }}
            initialNumToRender={10}
            maxToRenderPerBatch={10}
            windowSize={5}
            ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: theme.border, marginLeft: 56 }} />}
            ListEmptyComponent={
              <View style={{ alignItems: "center", paddingVertical: 40 }}>
                <View
                  style={{
                    width: 64,
                    height: 64,
                    borderRadius: 32,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: theme.surfaceMuted,
                    marginBottom: 12,
                  }}
                >
                  <Feather name="eye-off" size={26} color={theme.iconMuted} />
                </View>
                <Text style={{ color: theme.text, fontSize: 14, fontWeight: "600", marginBottom: 4 }}>No views yet</Text>
                <Text style={{ color: theme.textSoft, fontSize: 12, textAlign: "center", maxWidth: 240 }}>
                  When someone watches your Moment, they'll appear here with their reaction.
                </Text>
              </View>
            }
          />
        )}
      </View>
    </RNModal>
  );
}

const styles = StyleSheet.create({
  iconBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
});
