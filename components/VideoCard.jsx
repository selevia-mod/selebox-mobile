import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import LoaderKit from "react-native-loader-kit";
import useAppTheme from "../hooks/useAppTheme";
import { useGlobalContext } from "../context/global-provider";
import { useVideosStats } from "../context/video-stats-provider";
import { getBunnyImageUrl } from "../lib/bunny-image-url";
import FormatNumber from "../lib/utils/format-number";
import TimeAgo from "../lib/utils/time-ago";
import StyledLikeCommentShare from "./StyledLikeCommentShare";

const VideoCard = ({ item, ...props }) => {
  const { globalSettings, user } = useGlobalContext();
  const { theme } = useAppTheme();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const avatarUri = item?.uploader?.avatar;
  // Live engagement counts via the shared provider; identical pattern to
  // VideoCardNew + VideoCardSmall. Falls back to the static counts on
  // item.videoStats so first-paint isn't blocked.
  const { getVideoStats, batchLoadVideoStats } = useVideosStats();
  const videoId = item?.$id;
  useEffect(() => {
    if (!videoId || !user?.$id) return;
    batchLoadVideoStats([videoId], user.$id);
  }, [videoId, user?.$id, batchLoadVideoStats]);
  const liveStats = getVideoStats(videoId);
  const liveViews = liveStats.videoViews ?? item?.videoStats?.totalViews ?? 0;
  const liveLikes = liveStats.videoLikes ?? item?.videoStats?.totalLikes ?? 0;

  const handlePress = async (view) => {
    try {
      router.push({
        pathname: "video-player",
        params: {
          id: item.uri,
          docId: item.$id,
          view: view,
        },
      });
    } catch (error) {}
  };

  const getInitials = (name) => {
    if (!name) return "?";
    const words = name.trim().split(" ");
    const initials = words
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join("");
    return initials || "?";
  };

  return (
    <View className="mx-2 mb-7 space-y-2" {...props}>
      <TouchableOpacity className="space-y-2" activeOpacity={0.7} onPress={() => handlePress("RECOMMENDED")} accessibilityLabel="Play Video">
        <FastImage
          source={{
            // VideoCard renders full-width feed thumbnails (16:9). Cap at
            // 720pt — the helper applies pixel ratio internally so a 3×
            // device still gets a 2160px source. That's plenty for a
            // tile that physically renders at most 1080px wide.
            uri: getBunnyImageUrl(item.thumbnail, { width: 720 }),
            priority: FastImage.priority.normal,
          }}
          className="aspect-video rounded-lg"
          style={{ backgroundColor: theme.surfaceMuted }}
          resizeMode={FastImage.resizeMode.contain}
        />
        <View className="flex flex-row space-x-2">
          <View className="h-10 w-10 items-center justify-center overflow-hidden rounded-full" style={{ backgroundColor: theme.surfaceMuted }}>
            {/* Show fallback if no avatar or error */}
            {(error || !avatarUri) && !loading && (
              <Text className="text-xs font-bold" style={{ color: theme.text }}>
                {getInitials(item?.uploader?.name)}
              </Text>
            )}
            {/* Show FastImage if valid and not error */}
            {!error && !!avatarUri && (
              <FastImage
                source={{ uri: avatarUri, priority: FastImage.priority.normal }}
                style={{ height: 40, width: 40 }}
                resizeMode={FastImage.resizeMode.cover}
                onLoadStart={() => {
                  setLoading(true);
                  setError(false);
                }}
                onLoad={() => setLoading(false)}
                onError={() => {
                  setLoading(false);
                  setError(true);
                }}
              />
            )}
            {/* Show loading spinner on top */}
            {loading && (
              <View className="absolute inset-0 items-center justify-center">
                <LoaderKit style={{ width: 20, height: 20, opacity: 0.5 }} name={"LineScalePulseOutRapid"} color={theme.primary} />
              </View>
            )}
          </View>
          <View className="flex flex-1 flex-col">
            <Text className="font-sans text-sm font-bold" style={{ color: theme.text }} numberOfLines={2}>
              {item.title}
            </Text>
            <View className="flex flex-row flex-wrap items-center">
              <Text className="font-sans text-sm" style={{ color: theme.textMuted }} numberOfLines={2}>
                {item?.uploader?.username || "Unknown"}
                <Text> • </Text>
                {item?.tags?.map((name, index) => (
                  <Text key={name} className="font-sans text-sm" style={{ color: theme.textMuted }}>
                    {name}
                    <Text> • </Text>
                  </Text>
                ))}
                {TimeAgo(item.$createdAt)}
              </Text>
            </View>
          </View>
        </View>
      </TouchableOpacity>
      <View className="flex flex-col items-end space-y-2">
        <View className="flex flex-row items-center">
          <Text className="font-sans text-sm" style={{ color: theme.textMuted }}>
            {FormatNumber((liveViews || 0) * (Number(globalSettings["VIEWS_MULTIPLIER"]) || 1))} Views
          </Text>
          <Text className="font-sans text-sm" style={{ color: theme.textMuted }}>
            {" "}
            •{" "}
          </Text>
          <Text className="font-sans text-sm" style={{ color: theme.textMuted }}>
            {FormatNumber((liveLikes || 0) * (Number(globalSettings["LIKES_MULTIPLIER"]) || 1))} Likes
          </Text>
        </View>
        <StyledLikeCommentShare showCommentButton={true} handleComment={() => handlePress("COMMENTS")} item={item} />
      </View>
    </View>
  );
};

export default VideoCard;
