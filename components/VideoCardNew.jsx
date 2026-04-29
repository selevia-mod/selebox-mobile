import { router } from "expo-router";
import { useState } from "react";
import { Dimensions, Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import LoaderKit from "react-native-loader-kit";
import useAppTheme from "../hooks/useAppTheme";
import { useGlobalContext } from "../context/global-provider";
import FormatNumber from "../lib/format-number";
import TimeAgo from "../lib/time-ago";
import UserRoleBadgeIcons from "./UserRoleBadgeIcons";

const VideoCardNew = ({ item, customWidth, customHeight, customAvatarSize, customFontSize, hideAvatar = false, ...props }) => {
  const { globalSettings } = useGlobalContext();
  const { theme } = useAppTheme();
  const { width: SCREEN_WIDTH } = Dimensions.get("window");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const avatarUri = item?.uploader?.avatar;
  const cardWidth = customWidth || SCREEN_WIDTH * 0.8;
  const cardHeight = customHeight || cardWidth * 0.56;
  const avatarSize = customAvatarSize || 40;
  const fontSize = customFontSize || 14;
  const titleLineHeight = Math.round(fontSize * 1.35);
  const metaFontSize = Math.max(12, Math.round(fontSize * 0.9));
  const metaLineHeight = Math.round(metaFontSize * 1.35);
  const textStackGap = 2;
  const textBlockHeight = titleLineHeight * 2 + metaLineHeight * 2 + textStackGap;
  const rowHeight = Math.max(avatarSize, textBlockHeight);

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
    <View style={{ width: cardWidth }} className="mb-4 mr-3 space-y-2" {...props}>
      <TouchableOpacity className="space-y-2" activeOpacity={0.7} onPress={() => handlePress("RECOMMENDED")} accessibilityLabel="Play Video">
        <FastImage
          style={{ height: cardHeight, width: cardWidth, borderRadius: 10, backgroundColor: theme.surfaceMuted }}
          source={{ uri: item.thumbnail, priority: FastImage.priority.high }}
          resizeMode={FastImage.resizeMode.contain}
        />
        <View className="flex-row items-start space-x-2" style={{ minHeight: rowHeight }}>
          {!hideAvatar && (
            <View
              className="items-center justify-center overflow-hidden rounded-full"
              style={{
                height: avatarSize,
                width: avatarSize,
                backgroundColor: theme.surfaceMuted,
              }}
            >
              {/* Show fallback if no avatar or error */}
              {(error || !avatarUri) && !loading && (
                <Text className="text-xs font-bold" style={{ fontFamily: "Poppins-Bold", color: theme.text }}>
                  {getInitials(item?.uploader?.name)}
                </Text>
              )}
              {/* Show FastImage if valid and not error */}
              {!error && !!avatarUri && (
                <FastImage
                  source={{ uri: avatarUri, priority: FastImage.priority.high }}
                  style={{ height: avatarSize, width: avatarSize }}
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
                  <LoaderKit style={{ width: avatarSize, height: avatarSize, opacity: 0.5 }} name={"BallScaleMultiple"} color={theme.primary} />
                </View>
              )}
            </View>
          )}
          <View className="flex flex-1 flex-col space-y-0.5" style={{ minHeight: textBlockHeight }}>
            <Text
              className="font-sans font-bold"
              style={{ fontSize: fontSize, lineHeight: titleLineHeight, fontFamily: "Poppins-Bold", color: theme.text }}
              numberOfLines={2}
              ellipsizeMode="tail"
            >
              {item?.title}
            </Text>
            <View className="flex flex-row items-center self-start" style={{ maxWidth: "100%" }}>
              <Text
                className="font-sans"
                style={{ fontSize: metaFontSize, lineHeight: metaLineHeight, fontFamily: "Poppins-Regular", flexShrink: 1, color: theme.textMuted }}
                numberOfLines={1}
              >
                {item?.uploader?.username || "Unknown"}
              </Text>
              <UserRoleBadgeIcons user={item?.uploader} size={15} />
            </View>
            <View className="flex flex-row flex-wrap items-center">
              <Text
                className="font-sans text-xs"
                style={{ fontSize: metaFontSize, lineHeight: metaLineHeight, fontFamily: "Poppins-Regular", color: theme.textMuted }}
                numberOfLines={1}
              >
                {FormatNumber((item?.videoStats?.totalViews || 0) * (Number(globalSettings["VIEWS_MULTIPLIER"]) || 1))} Views
                <Text> • </Text>
                {TimeAgo(item.publishDate ?? item.$createdAt)}
              </Text>
            </View>
          </View>
        </View>
      </TouchableOpacity>
    </View>
  );
};

export default VideoCardNew;
