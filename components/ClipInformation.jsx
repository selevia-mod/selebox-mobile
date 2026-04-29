import { AntDesign, FontAwesome } from "@expo/vector-icons";
import { router } from "expo-router";
import { memo, useEffect, useState } from "react";
import { Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useClipsStats } from "../context/clip-stats-provider";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import FormatNumber from "../lib/format-number";
import useIsOffline from "../hooks/useIsOffline";
import StyledDivider from "./StyledDivider";

const BOTTOM_TAB_BAR_HEIGHT = Platform.OS === "ios" ? 83 : 50;

const ClipInformation = ({ item, onCommentPress, onSharePress, showControls, variant }) => {
  const clipID = item?.$id;
  const { globalSettings, user } = useGlobalContext();
  const { theme } = useAppTheme();
  const isOffline = useIsOffline();
  const { getClipStats, loadLikeStatus, toggleLike } = useClipsStats();

  useEffect(() => {
    if (clipID && user?.$id) loadLikeStatus(clipID, user.$id);
  }, [clipID, user?.$id]);

  const stats = getClipStats(clipID);
  const liked = stats.liked ?? false;
  const likeCount = stats.likeCount ?? item.clipLikes ?? 0;
  const commentCount = stats.commentCount ?? item.clipComments ?? 0;

  const [showFullDescription, setShowFullDescription] = useState(false);
  const insets = useSafeAreaInsets();
  const collapsedNumberOfLines = 3;
  const maxCharacters = 100;
  const maxHeight = 200;
  const bottomSpacing = showControls ? 75 : 25;

  const handleShare = async () => onSharePress(item);

  const handleCreatorProfilePressed = () => {
    if (isOffline) return;
    if (user?.$id === item?.uploader?.$id) router.push("/profile");
    else router.push({ pathname: "/creator-profile", params: { userId: item?.uploader?.$id } });
  };

  // === UI VARIANTS ===
  if (variant === "feed") {
    return (
      <View className="flex flex-col space-y-2 px-4 pb-2">
        {/* Likes and comments count */}
        <View className="flex flex-row items-center space-x-2 self-end">
          <TouchableOpacity>
            <Text className="font-sans text-xs font-medium" style={{ color: theme.textMuted }}>
              {FormatNumber((likeCount || 0) * (Number(globalSettings["LIKES_MULTIPLIER"]) || 1))} likes
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => onCommentPress(item)}>
            <Text className="font-sans text-xs font-medium" style={{ color: theme.textMuted }}>
              {commentCount ?? 0} comments
            </Text>
          </TouchableOpacity>
        </View>

        <StyledDivider color={theme.divider} className="mb-0" />

        {/* Buttons */}
        <View className="flex flex-row items-center justify-between space-x-2">
          <TouchableOpacity
            onPress={() => toggleLike(item, user)}
            activeOpacity={1.0}
            className="flex-1 flex-row items-center justify-center space-x-1 px-3 py-2 opacity-80"
          >
            <AntDesign name="like1" size={15} color={liked ? theme.primary : theme.icon} />
            <Text className="font-sans text-sm font-medium" style={{ color: liked ? theme.primary : theme.text }}>
              {liked ? "Liked" : "Like"}
            </Text>
          </TouchableOpacity>

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

  return (
    <View className="absolute bottom-0 justify-end" style={{ paddingBottom: BOTTOM_TAB_BAR_HEIGHT + insets.bottom + bottomSpacing }}>
      <View className="w-full flex-row justify-between px-2">
        {/* Left: Caption and user info */}
        <View className="mb-4 mr-4 flex-1 justify-end">
          {/* Avatar and uploader name */}
          <TouchableOpacity activeOpacity={0.7} onPress={handleCreatorProfilePressed}>
            <View className="mb-1 flex-row items-center">
              <FastImage source={{ uri: item?.uploader?.avatar }} className="mr-2 h-9 w-9 rounded-full" />
              <Text
                className="font-semibold"
                style={{
                  color: theme.primaryContrast,
                  textShadowColor: "rgba(0, 0, 0, 0.9)",
                  textShadowOffset: { width: 0, height: 2 },
                  textShadowRadius: 4,
                  elevation: 5,
                  shadowColor: "black",
                  shadowOffset: { width: 0, height: 3 },
                  shadowOpacity: 0.5,
                  shadowRadius: 5,
                }}
              >
                {item?.uploader?.username}
              </Text>
            </View>
          </TouchableOpacity>

          {((item.title && item.title.replace(/\s/g, "") !== "") || (item.description && item.description.replace(/\s/g, "") !== "")) && (
            <View className="mt-2">
              {/* Title */}
              {item.title ? (
                <Text style={[styles.textShadow, { color: theme.primaryContrast }]} className="font-semibold">
                  {item.title}
                </Text>
              ) : null}

              {/* Description */}
              {item.description ? (
                <View className="mt-1">
                  {showFullDescription ? (
                    <View style={{ maxHeight }}>
                      <ScrollView nestedScrollEnabled showsVerticalScrollIndicator={false}>
                        <Text style={[styles.textShadow, { color: theme.primaryContrast }]}>{item.description}</Text>
                      </ScrollView>
                    </View>
                  ) : (
                    <Text style={[styles.textShadow, { color: theme.primaryContrast }]} numberOfLines={collapsedNumberOfLines} ellipsizeMode="tail">
                      {item.description}
                    </Text>
                  )}

                  {/* See more / See less */}
                  {item.description.length > maxCharacters && (
                    <Text
                      onPress={() => setShowFullDescription(!showFullDescription)}
                      className="mt-1"
                      style={{ color: theme.primaryContrast, opacity: 0.8 }}
                    >
                      {showFullDescription ? "See less" : "See more"}
                    </Text>
                  )}
                </View>
              ) : null}
            </View>
          )}
        </View>

        {/* Right: Action buttons */}
        <View className="items-center justify-end space-y-4 pb-5">
          <TouchableOpacity onPress={() => toggleLike(item, user)}>
            <View style={[styles.iconShadow, { backgroundColor: theme.mediaOverlayStrong }]}>
              <FontAwesome name="heart" size={20} color={liked ? theme.like : theme.primaryContrast} />
            </View>
            <Text style={[styles.textShadow, { color: theme.primaryContrast }]} className="mt-1 text-center text-xs">
              {FormatNumber((likeCount || 0) * (Number(globalSettings["LIKES_MULTIPLIER"]) || 1))}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onCommentPress}>
            <View style={[styles.iconShadow, { backgroundColor: theme.mediaOverlayStrong }]}>
              <FontAwesome name="comment" size={20} color={theme.primaryContrast} />
            </View>
            <Text style={[styles.textShadow, { color: theme.primaryContrast }]} className="mt-1 text-center text-xs">
              {FormatNumber(commentCount || 0)}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={handleShare}>
            <View style={[styles.iconShadow, { backgroundColor: theme.mediaOverlayStrong }]}>
              <FontAwesome name="mail-forward" size={20} color={theme.primaryContrast} />
            </View>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  textShadow: {
    textShadowColor: "rgba(0, 0, 0, 0.85)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
    elevation: 3,
    shadowColor: "black",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 3,
  },
  iconShadow: {
    borderRadius: 100,
    backgroundColor: "rgba(0, 0, 0, 0.4)",
    height: 40,
    width: 40,
    alignItems: "center",
    justifyContent: "center",
  },
});

export default memo(ClipInformation);
