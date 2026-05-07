// components/StoryRepostSheet.jsx
//
// Bottom sheet shown when the viewer taps the repost button on a
// Moment. Two distinct actions:
//
//   1. Share to direct message — routes to /(message)/share-target
//      (existing chat picker) with the storyId as a payload. The
//      receiver sees the Moment as a chat message bubble. Mirrors
//      the IG "Send to..." flow.
//
//   2. Repost to your Moments — calls StoryService.repostStory which
//      creates a new story row referencing the original via
//      repost_of_id. The repost shows up in the user's own Moments
//      tray with a "Reposted from @user" badge handled by the viewer.
//
// We deliberately split these into two large rows (rather than a
// quick share grid) because each path is a meaningful commitment and
// users should pick deliberately. A grid would imply lightweight
// sharing.

import { Feather, Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import RNModal from "react-native-modal";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import useAppTheme from "../hooks/useAppTheme";

export default function StoryRepostSheet({
  visible,
  onClose,
  onShareToDM,
  onRepost,
  ownerName, // e.g. "@charles" — shown in the "Reposted from" preview
}) {
  const { theme } = useAppTheme();
  const insets = useSafeAreaInsets();

  const [reposting, setReposting] = useState(false);

  const handleRepost = async () => {
    if (reposting) return;
    setReposting(true);
    try {
      await onRepost?.();
    } finally {
      setReposting(false);
    }
  };

  return (
    <RNModal
      isVisible={visible}
      onBackdropPress={onClose}
      onSwipeComplete={onClose}
      swipeDirection={["down"]}
      backdropOpacity={0.55}
      style={{ justifyContent: "flex-end", margin: 0 }}
      useNativeDriver
      hideModalContentWhileAnimating
      animationIn="slideInUp"
      animationOut="slideOutDown"
    >
      <View
        style={{
          borderTopLeftRadius: 28,
          borderTopRightRadius: 28,
          backgroundColor: theme.surfaceElevated,
          paddingHorizontal: 18,
          paddingTop: 10,
          paddingBottom: insets.bottom + 16,
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

        <Text style={{ fontSize: 18, fontWeight: "700", color: theme.text, marginBottom: 4 }}>Share Moment</Text>
        {ownerName ? (
          <Text style={{ fontSize: 12, color: theme.textSoft, marginBottom: 16 }}>
            Originally from {ownerName}
          </Text>
        ) : (
          <View style={{ height: 16 }} />
        )}

        {/* Share to DM */}
        <Pressable
          onPress={() => {
            onClose?.();
            // Defer to next tick so the dismiss animation can start
            // before the share-target modal pushes — feels less jarring.
            setTimeout(() => onShareToDM?.(), 220);
          }}
          style={({ pressed }) => [
            styles.row,
            { backgroundColor: theme.surfaceMuted, opacity: pressed ? 0.85 : 1 },
          ]}
          accessibilityRole="button"
          accessibilityLabel="Share via direct message"
        >
          <View style={[styles.iconBubble, { backgroundColor: theme.accentPurple }]}>
            <Ionicons name="paper-plane" size={20} color="#fff" />
          </View>
          <View style={{ flex: 1, marginLeft: 14 }}>
            <Text style={{ color: theme.text, fontSize: 15, fontWeight: "600" }}>Send to a friend</Text>
            <Text style={{ color: theme.textSoft, fontSize: 12, marginTop: 2 }}>
              Share this Moment in a direct message
            </Text>
          </View>
          <Feather name="chevron-right" size={18} color={theme.iconMuted} />
        </Pressable>

        {/* Repost to own feed */}
        <Pressable
          onPress={handleRepost}
          disabled={reposting}
          style={({ pressed }) => [
            styles.row,
            { backgroundColor: theme.surfaceMuted, opacity: pressed ? 0.85 : reposting ? 0.6 : 1, marginTop: 10 },
          ]}
          accessibilityRole="button"
          accessibilityLabel="Repost to your Moments"
        >
          <View style={[styles.iconBubble, { backgroundColor: "#3DD68C" }]}>
            {reposting ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Feather name="repeat" size={20} color="#fff" />
            )}
          </View>
          <View style={{ flex: 1, marginLeft: 14 }}>
            <Text style={{ color: theme.text, fontSize: 15, fontWeight: "600" }}>
              {reposting ? "Reposting…" : "Repost to my Moments"}
            </Text>
            <Text style={{ color: theme.textSoft, fontSize: 12, marginTop: 2 }}>
              Adds it to your story tray with a credit badge
            </Text>
          </View>
          <Feather name="chevron-right" size={18} color={theme.iconMuted} />
        </Pressable>

        {/* Cancel */}
        <Pressable
          onPress={onClose}
          style={({ pressed }) => ({
            marginTop: 12,
            paddingVertical: 13,
            borderRadius: 14,
            alignItems: "center",
            backgroundColor: pressed ? theme.surfaceMuted : "transparent",
            borderWidth: 1,
            borderColor: theme.border,
          })}
        >
          <Text style={{ color: theme.text, fontSize: 14, fontWeight: "600" }}>Cancel</Text>
        </Pressable>
      </View>
    </RNModal>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderRadius: 16,
  },
  iconBubble: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
  },
});
