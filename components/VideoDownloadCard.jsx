// Card on the Videos > Downloads tab. Shows one entry from the user's
// offline library with status (preparing / downloading / completed /
// failed), progress, and play / cancel / remove affordances.
//
// Design language is the same violet-primary system used across Library,
// Recommended Videos, and the unlock modal — soft accent washes, premium
// border radii, status pills. Status colors stay theme-aware (green for
// completed, amber for cancelling, red for failed) so they communicate
// state at a glance, but the surrounding chrome is unified violet.
//
// Local file URI is RESOLVED at render time from a persisted relative path
// via resolveLocalDownloadUri. Persisting absolute URIs broke after iOS
// rotated the app container UUID — the resolver rebases on the current
// documentDirectory each render, so a download taken weeks ago still plays.

import { Ionicons, MaterialCommunityIcons, MaterialIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import { Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import useAppTheme from "../hooks/useAppTheme";
import FormatNumber from "../lib/utils/format-number";
import { formatBytes, resolveLocalDownloadUri } from "../lib/video-downloads";

const statusCopy = {
  preparing: "Preparing",
  downloading: "Downloading",
  cancelling: "Cancelling",
  cancelled: "Cancelled",
  completed: "Downloaded",
  failed: "Failed",
};

const isActiveStatus = (status) => ["preparing", "downloading", "cancelling"].includes(status);

const VideoDownloadCard = ({ entry, onCancel, onRemove }) => {
  const { theme } = useAppTheme();
  if (!entry?.video) return null;

  const { video } = entry;
  const status = entry.status || "completed";

  // Status pills — full violet primary system across all "happy path" states
  // (preparing / downloading / completed) so the entire offline-download flow
  // reads as one premium violet language. Amber stays for cancelling and red
  // for failed because those states genuinely need to communicate caution.
  const statusTint = {
    preparing: { backgroundColor: theme.primarySoft, color: theme.primary },
    downloading: { backgroundColor: theme.primarySoft, color: theme.primary },
    cancelling: { backgroundColor: `${theme.accentAmber}1F`, color: theme.accentAmber },
    cancelled: { backgroundColor: theme.surfaceMuted, color: theme.textSoft },
    completed: { backgroundColor: theme.primarySoft, color: theme.primary },
    failed: { backgroundColor: theme.dangerSoft, color: theme.danger },
  };
  const badgeStyle = statusTint[status] || statusTint.cancelled;

  const progress = Math.max(0, Math.min(1, Number(entry.progress || 0)));
  const progressPct = Math.round(progress * 100);
  const isActive = isActiveStatus(status);

  const resolvedLocalUri = status === "completed" ? resolveLocalDownloadUri(entry) : null;
  const canPlay = status === "completed" && Boolean(resolvedLocalUri);

  const viewsCount = video?.videoStats?.totalViews ?? video?.views ?? 0;
  const likesCount = video?.videoStats?.totalLikes ?? video?.likes ?? 0;
  const commentsCount = video?.commentsCount ?? video?.videoStats?.commentsCount ?? video?.videoStats?.totalComments ?? 0;

  const handleOpen = () => {
    if (!canPlay || !resolvedLocalUri) return;
    router.push({
      pathname: "video-player",
      params: {
        id: video.uri || video.$id,
        docId: video.$id,
        localUri: resolvedLocalUri,
      },
    });
  };

  return (
    <View
      className="mx-2 mb-2.5 overflow-hidden rounded-2xl"
      style={{
        borderWidth: 1,
        borderColor: theme.border,
        backgroundColor: theme.card,
        padding: 12,
        shadowColor: theme.primary,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.1,
        shadowRadius: 10,
        elevation: 2,
      }}
    >
      {!isActive && (
        <View className="absolute right-2.5 top-2.5 z-20">
          <TouchableOpacity
            onPress={() => onRemove?.(entry)}
            activeOpacity={0.8}
            accessibilityLabel="Remove download"
            style={{
              width: 28,
              height: 28,
              borderRadius: 999,
              alignItems: "center",
              justifyContent: "center",
              borderWidth: 1,
              borderColor: theme.border,
              backgroundColor: theme.surfaceMuted,
            }}
          >
            <Ionicons name="trash-outline" size={13} color={theme.danger} />
          </TouchableOpacity>
        </View>
      )}

      <TouchableOpacity activeOpacity={canPlay ? 0.85 : 1} disabled={!canPlay} onPress={handleOpen} className="flex-row" style={{ gap: 12 }}>
        <View
          style={{
            position: "relative",
            borderRadius: 10,
            overflow: "hidden",
            borderWidth: 1,
            borderColor: theme.border,
          }}
        >
          <FastImage
            source={{ uri: video.thumbnail, priority: FastImage.priority.normal }}
            style={{ width: 124, height: 70, backgroundColor: theme.surfaceMuted }}
            resizeMode={FastImage.resizeMode.cover}
          />
          {/* Play badge appears on completed/playable entries — small visual
              cue that the row is tappable, since we don't get a hover state
              on mobile. */}
          {canPlay && (
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                left: 6,
                bottom: 6,
                paddingHorizontal: 5,
                paddingVertical: 1,
                borderRadius: 4,
                backgroundColor: "rgba(0,0,0,0.7)",
                flexDirection: "row",
                alignItems: "center",
              }}
            >
              <Ionicons name="play" size={9} color="#FFFFFF" />
              <Text style={{ color: "#FFFFFF", fontSize: 9, fontWeight: "700", letterSpacing: 0.3, marginLeft: 3 }}>
                OFFLINE
              </Text>
            </View>
          )}
        </View>

        <View className="flex-1 justify-between" style={{ paddingRight: !isActive ? 30 : 0 }}>
          <View>
            <Text
              className="font-bold"
              style={{ color: theme.text, fontSize: 14, lineHeight: 18, letterSpacing: 0.1 }}
              numberOfLines={1}
            >
              {video.title || "Untitled Video"}
            </Text>
            <Text
              className="mt-0.5 font-medium"
              style={{ color: theme.textSoft, fontSize: 11, letterSpacing: 0.1 }}
              numberOfLines={1}
            >
              {video?.uploader?.username || "Unknown"}
            </Text>
          </View>

          <View className="mt-2 flex-row items-center justify-between">
            <View className="flex-row items-center" style={{ gap: 10 }}>
              <View className="flex-row items-center" style={{ gap: 3 }}>
                <Ionicons name="eye-outline" size={11} color={theme.iconMuted} />
                <Text className="font-semibold" style={{ color: theme.textSoft, fontSize: 10 }}>
                  {FormatNumber(viewsCount)}
                </Text>
              </View>
              <View className="flex-row items-center" style={{ gap: 3 }}>
                <Ionicons name="heart-outline" size={11} color={theme.iconMuted} />
                <Text className="font-semibold" style={{ color: theme.textSoft, fontSize: 10 }}>
                  {FormatNumber(likesCount)}
                </Text>
              </View>
              <View className="flex-row items-center" style={{ gap: 3 }}>
                <Ionicons name="chatbubble-outline" size={11} color={theme.iconMuted} />
                <Text className="font-semibold" style={{ color: theme.textSoft, fontSize: 10 }}>
                  {FormatNumber(commentsCount)}
                </Text>
              </View>
            </View>
            <View
              className="rounded-full"
              style={{
                paddingHorizontal: 7,
                paddingVertical: 2,
                backgroundColor: badgeStyle.backgroundColor,
                borderWidth: 0.5,
                borderColor: badgeStyle.color,
              }}
            >
              <Text
                className="font-bold"
                style={{ color: badgeStyle.color, fontSize: 9, letterSpacing: 0.4, textTransform: "uppercase" }}
              >
                {statusCopy[status] || "Pending"}
              </Text>
            </View>
          </View>
        </View>
      </TouchableOpacity>

      {isActive && (
        // In-progress card — violet sheen on the progress bar (matches the
        // unlock modal's countdown bar), prominent percentage, real-time byte
        // counter on the right, destructive Cancel pill at the bottom.
        <View
          className="mt-3 rounded-xl"
          style={{
            paddingHorizontal: 12,
            paddingVertical: 10,
            backgroundColor: theme.primarySoft,
            borderWidth: 1,
            borderColor: theme.primary,
          }}
        >
          <View className="mb-2 flex-row items-center justify-between">
            <View className="flex-row items-center" style={{ gap: 6 }}>
              <MaterialCommunityIcons name="cloud-download-outline" size={13} color={theme.primary} />
              <Text className="font-bold" style={{ color: theme.primary, fontSize: 11, letterSpacing: 0.4, textTransform: "uppercase" }}>
                {progressPct}%
              </Text>
            </View>
            <Text className="font-medium" style={{ color: theme.textSoft, fontSize: 10, letterSpacing: 0.1 }}>
              {entry.bytesWritten ? formatBytes(entry.bytesWritten) : "0 B"}
              {entry.totalBytes ? ` / ${formatBytes(entry.totalBytes)}` : ""}
            </Text>
          </View>
          <View
            style={{
              height: 5,
              borderRadius: 999,
              overflow: "hidden",
              backgroundColor: `${theme.primary}26`,
              borderWidth: 0.5,
              borderColor: `${theme.primary}40`,
            }}
          >
            <View
              style={{
                width: `${progressPct}%`,
                height: "100%",
                backgroundColor: theme.primary,
                shadowColor: theme.primary,
                shadowOffset: { width: 0, height: 0 },
                shadowOpacity: 0.6,
                shadowRadius: 4,
              }}
            />
          </View>
          <View className="mt-2.5 flex-row justify-end">
            <TouchableOpacity
              onPress={() => onCancel?.(entry)}
              activeOpacity={0.85}
              accessibilityLabel="Cancel download"
              className="flex-row items-center rounded-full"
              style={{
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderWidth: 1,
                borderColor: theme.danger,
                backgroundColor: theme.dangerSoft,
              }}
            >
              <MaterialIcons name="close" size={12} color={theme.danger} />
              <Text className="ml-1 font-bold" style={{ color: theme.danger, fontSize: 10, letterSpacing: 0.4, textTransform: "uppercase" }}>
                Cancel
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {status === "failed" && entry.error ? (
        <View
          className="mt-2.5 rounded-xl"
          style={{
            paddingHorizontal: 12,
            paddingVertical: 8,
            backgroundColor: theme.dangerSoft,
            borderWidth: 1,
            borderColor: theme.danger,
          }}
        >
          <View className="flex-row items-start">
            <MaterialIcons name="error-outline" size={13} color={theme.danger} style={{ marginRight: 6, marginTop: 1 }} />
            <Text
              className="flex-1 font-medium"
              style={{ color: theme.danger, fontSize: 11, lineHeight: 15, letterSpacing: 0.1 }}
              numberOfLines={3}
            >
              {entry.error}
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
};

export default VideoDownloadCard;
