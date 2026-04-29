import { Ionicons, MaterialIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import { Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import useAppTheme from "../hooks/useAppTheme";
import FormatNumber from "../lib/format-number";
import { formatBytes } from "../lib/video-downloads";

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
  const statusTint = {
    preparing: { backgroundColor: theme.accentBlueSoft, color: theme.accentBlue },
    downloading: { backgroundColor: theme.accentBlueSoft, color: theme.accentBlue },
    cancelling: { backgroundColor: theme.accentAmberSoft, color: theme.accentAmber },
    cancelled: { backgroundColor: theme.surfaceMuted, color: theme.textSoft },
    completed: { backgroundColor: theme.accentGreenSoft, color: theme.accentGreen },
    failed: { backgroundColor: theme.dangerSoft, color: theme.danger },
  };
  const badgeStyle = statusTint[status] || statusTint.cancelled;
  const progress = Math.max(0, Math.min(1, Number(entry.progress || 0)));
  const progressPct = Math.round(progress * 100);
  const isActive = isActiveStatus(status);
  const canPlay = status === "completed" && (entry.localUri || entry.manifestUri);
  const viewsCount = video?.videoStats?.totalViews ?? video?.views ?? 0;
  const likesCount = video?.videoStats?.totalLikes ?? video?.likes ?? 0;
  const commentsCount = video?.commentsCount ?? video?.videoStats?.commentsCount ?? video?.videoStats?.totalComments ?? 0;

  const handleOpen = () => {
    if (!canPlay) return;
    router.push({
      pathname: "video-player",
      params: {
        id: video.uri || video.$id,
        docId: video.$id,
        localUri: entry.localUri || entry.manifestUri,
      },
    });
  };

  return (
    <View className="mx-2 mb-2 overflow-hidden rounded-2xl p-3" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
      {!isActive && (
        <View className="absolute right-2 top-2 z-20">
          <TouchableOpacity
            onPress={() => onRemove?.(entry)}
            activeOpacity={0.8}
            className="h-7 w-7 items-center justify-center rounded-full"
            style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surfaceMuted }}
          >
            <Ionicons name="trash-outline" size={14} color={theme.danger} />
          </TouchableOpacity>
        </View>
      )}

      <TouchableOpacity activeOpacity={canPlay ? 0.8 : 1} disabled={!canPlay} onPress={handleOpen} className="flex-row items-center">
        <FastImage
          source={{ uri: video.thumbnail, priority: FastImage.priority.high }}
          style={{ width: 112, height: 85, borderRadius: 5, backgroundColor: theme.surfaceMuted }}
          resizeMode={FastImage.resizeMode.contain}
        />

        <View className="ml-3 flex-1 justify-between">
          <Text className="mr-5 text-sm font-semibold" style={{ color: theme.text }} numberOfLines={1}>
            {video.title || "Untitled Video"}
          </Text>
          <Text className="mt-1 text-xs" style={{ color: theme.textSoft }} numberOfLines={1}>
            {video?.uploader?.username || "Unknown"}
          </Text>
          <Text className="mt-1 text-xs" style={{ color: theme.textMuted }} numberOfLines={2}>
            {video?.description || "No description available."}
          </Text>

          <View className="mt-2 flex-row items-center justify-between">
            <View className="mr-2 flex-1 flex-row items-center justify-between">
              <View className="flex-row items-center space-x-1">
                <Ionicons name="eye-outline" size={13} color={theme.accentBlue} />
                <Text className="text-[11px]" style={{ color: theme.textMuted }}>
                  {FormatNumber(viewsCount)}
                </Text>
              </View>
              <View className="flex-row items-center space-x-1">
                <Ionicons name="heart-outline" size={13} color={theme.like} />
                <Text className="text-[11px]" style={{ color: theme.textMuted }}>
                  {FormatNumber(likesCount)}
                </Text>
              </View>
              <View className="flex-row items-center space-x-1">
                <Ionicons name="chatbubble-outline" size={13} color={theme.comment} />
                <Text className="text-[11px]" style={{ color: theme.textMuted }}>
                  {FormatNumber(commentsCount)}
                </Text>
              </View>
            </View>
            <View className="rounded-full px-2 py-0.5" style={{ backgroundColor: badgeStyle.backgroundColor }}>
              <Text className="text-[10px] font-semibold" style={{ color: badgeStyle.color }}>
                {statusCopy[status] || "Pending"}
              </Text>
            </View>
          </View>
        </View>
      </TouchableOpacity>

      {isActive && (
        <View className="mt-3 rounded-xl p-3" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surface }}>
          <View className="mb-2 flex-row items-center justify-between">
            <Text className="text-xs font-semibold" style={{ color: theme.text }}>
              {progressPct}%
            </Text>
            <Text className="text-[11px]" style={{ color: theme.textSoft }}>
              {entry.bytesWritten ? formatBytes(entry.bytesWritten) : "0 B"}
              {entry.totalBytes ? ` / ${formatBytes(entry.totalBytes)}` : ""}
            </Text>
          </View>
          <View className="h-2 overflow-hidden rounded-full" style={{ backgroundColor: theme.surfaceStrong }}>
            <View className="h-full rounded-full" style={{ width: `${progressPct}%`, backgroundColor: theme.accentGreen }} />
          </View>
          <View className="mt-3 flex-row justify-end">
            <TouchableOpacity
              onPress={() => onCancel?.(entry)}
              activeOpacity={0.8}
              className="flex-row items-center rounded-full px-3 py-2"
              style={{ borderWidth: 1, borderColor: "rgba(239,68,68,0.3)", backgroundColor: theme.dangerSoft }}
            >
              <MaterialIcons name="close" size={14} color={theme.danger} />
              <Text className="ml-1 text-xs font-semibold" style={{ color: theme.danger }}>
                Cancel
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {status === "failed" && entry.error ? (
        <View className="mt-2 rounded-lg px-3 py-2" style={{ backgroundColor: theme.dangerSoft }}>
          <Text className="text-[11px]" style={{ color: theme.danger }} numberOfLines={2}>
            {entry.error}
          </Text>
        </View>
      ) : null}
    </View>
  );
};

export default VideoDownloadCard;
