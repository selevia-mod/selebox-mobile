import { AntDesign, FontAwesome, MaterialIcons } from "@expo/vector-icons";
import { useEffect } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import Share from "react-native-share";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import { useVideosStats } from "../context/video-stats-provider";
import FormatNumber from "../lib/format-number";
import { resolveVideoCommentCount } from "../lib/video";
import secrets from "../private/secrets";
import StyledDivider from "./StyledDivider";

export default function StyledLikeCommentShare({
  item,
  following,
  downloaded,
  downloading = false,
  downloadDisabled = false,
  downloadLabel,
  variant = "default",
  onCommentPress,
  onSharePress,
  onDownloadPress,
  onFollowPress,
  showCommentButton = false,
  showDownloadButton = false,
  showFollowButton = false,
  ...props
}) {
  const videoID = item?.$id;
  const { user, globalSettings } = useGlobalContext();
  const { theme } = useAppTheme();
  const { getVideoStats, loadVideoStats, toggleLike, updateVideoStats } = useVideosStats();
  const initialCommentCount = resolveVideoCommentCount(item);

  useEffect(() => {
    if (!videoID) return;

    const existing = getVideoStats(videoID);

    if (
      initialCommentCount !== null &&
      existing.commentsCount !== initialCommentCount &&
      (existing.commentsCount === undefined || (existing.commentsCount === 0 && initialCommentCount > 0))
    ) {
      updateVideoStats(videoID, { commentsCount: initialCommentCount });
    }

    if (user?.$id) {
      if (existing.videoLikes !== undefined) return;
      loadVideoStats(videoID, user.$id);
    }
  }, [getVideoStats, initialCommentCount, loadVideoStats, updateVideoStats, user?.$id, videoID]);

  const stats = getVideoStats(videoID);
  const liked = stats.liked ?? false;
  const likeCount = stats.videoLikes ?? 0;
  const commentsCount = stats.commentsCount ?? initialCommentCount ?? 0;

  const likeColor = theme.like;
  const commentColor = theme.comment;

  const handleShare = async () => {
    try {
      if (onSharePress) return onSharePress(item);
      await Share.open({
        message: `Check out this video!`,
        url: `${secrets.WEBSITE}${item.uri}`,
        title: item.title,
        type: "url",
      });
    } catch (e) {
      // User dismissed the share sheet
    }
  };

  // === Feed Variant ===
  if (variant === "feed") {
    return (
      <View className="flex flex-col space-y-2 px-4 pb-2">
        {/* Like + Comment counts */}
        <View className="flex flex-row items-center space-x-2 self-end pt-3 pb-1.5">
          <TouchableOpacity className="flex-row items-center space-x-1 rounded-full px-3 py-1" style={{ backgroundColor: theme.likeSoft }}>
            <FontAwesome name="heart" size={14} color={likeColor} />
            <Text className="text-sm font-semibold" style={{ color: likeColor }}>
              {FormatNumber(likeCount)}
            </Text>
          </TouchableOpacity>

          {showCommentButton && (
            <TouchableOpacity
              onPress={() => onCommentPress?.(item)}
              className="flex-row items-center space-x-1 rounded-full px-3 py-1"
              style={{ backgroundColor: theme.commentSoft }}
            >
              <FontAwesome name="comment" size={14} color={commentColor} />
              <Text className="text-sm font-semibold" style={{ color: commentColor }}>
                {commentsCount}
              </Text>
            </TouchableOpacity>
          )}
        </View>

        <StyledDivider color={theme.divider} className="mb-0" />

        {/* Buttons row */}
        <View className="flex flex-row items-center justify-between space-x-2">
          <TouchableOpacity
            onPress={() => toggleLike(item, user)}
            activeOpacity={1.0}
            className="flex-1 flex-row items-center justify-center space-x-1 px-3 py-2 opacity-80"
          >
            <AntDesign name="like1" size={15} color={liked ? theme.accentGreen : theme.icon} />
            <Text className="font-sans text-sm font-medium" style={{ color: liked ? theme.accentGreen : theme.text }}>
              {liked ? "Liked" : "Like"}
            </Text>
          </TouchableOpacity>

          {showCommentButton && (
            <TouchableOpacity
              onPress={onCommentPress}
              activeOpacity={1.0}
              className="flex-1 flex-row items-center justify-center space-x-1 px-3 py-2 opacity-80"
            >
              <FontAwesome name="comments" size={15} color={theme.icon} />
              <Text className="font-sans text-sm font-medium" style={{ color: theme.text }}>
                Comment
              </Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity
            onPress={handleShare}
            activeOpacity={1.0}
            className="flex-1 flex-row items-center justify-center space-x-1 px-3 py-2 opacity-80"
          >
            <FontAwesome name="share" size={15} color={theme.icon} />
            <Text className="font-sans text-sm font-medium" style={{ color: theme.text }}>
              Share
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // === Default Variant (Player Overlay Style) ===
  return (
    <View className="flex flex-row items-center space-x-2" {...props}>
      {showFollowButton && (
        <TouchableOpacity
          onPress={onFollowPress}
          activeOpacity={1.0}
          className="flex flex-row items-center space-x-1 rounded-full px-3 py-2 opacity-70"
          style={{ backgroundColor: theme.surfaceStrong }}
        >
          <MaterialIcons name={following ? "person-remove" : "person-add"} size={12} color={following ? theme.accentPurple : theme.icon} />
          <Text className="font-sans text-sm font-medium" style={{ color: following ? theme.accentPurple : theme.text }}>
            {following ? "Following" : "Follow"}
          </Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity
        onPress={() => toggleLike(item, user)}
        activeOpacity={1.0}
        className="flex flex-row items-center space-x-1 rounded-full px-3 py-2 opacity-70"
        style={{ backgroundColor: theme.surfaceStrong }}
      >
        {liked ? <AntDesign name="heart" size={12} color={theme.accentPurple} /> : <AntDesign name="like1" size={12} color={theme.icon} />}
        <Text className="font-sans text-sm font-medium" style={{ color: liked ? theme.accentPurple : theme.text }}>
          {liked ? "Liked" : "Like"}
        </Text>
      </TouchableOpacity>

      {showCommentButton && (
        <TouchableOpacity
          onPress={onCommentPress}
          activeOpacity={1.0}
          className="flex flex-row items-center space-x-1 rounded-full px-3 py-2 opacity-70"
          style={{ backgroundColor: theme.surfaceStrong }}
        >
          <FontAwesome name="comments" size={12} color={theme.icon} />
          <Text className="font-sans text-sm font-medium" style={{ color: theme.text }}>
            Comment
          </Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity
        onPress={handleShare}
        activeOpacity={1.0}
        className="flex flex-row items-center space-x-1 rounded-full px-3 py-2 opacity-70"
        style={{ backgroundColor: theme.surfaceStrong }}
      >
        <FontAwesome name="share" size={12} color={theme.icon} />
        <Text className="font-sans text-sm font-medium" style={{ color: theme.text }}>
          Share
        </Text>
      </TouchableOpacity>

      {showDownloadButton && (
        <TouchableOpacity
          onPress={onDownloadPress}
          disabled={downloadDisabled}
          activeOpacity={1.0}
          className={`flex flex-row items-center space-x-1 rounded-full px-3 py-2 ${downloadDisabled ? "opacity-40" : "opacity-70"}`}
          style={{ backgroundColor: theme.surfaceStrong }}
        >
          <FontAwesome name="download" size={12} color={downloaded || downloading ? theme.accentPurple : theme.icon} />
          <Text className="font-sans text-sm font-medium" style={{ color: downloaded || downloading ? theme.accentPurple : theme.text }}>
            {downloadLabel || (downloading ? "Downloading..." : downloaded ? "Downloaded" : "Download")}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}
