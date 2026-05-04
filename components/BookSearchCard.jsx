import { router } from "expo-router";
import React, { memo } from "react";
import { ActivityIndicator, Dimensions, Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import useAppTheme from "../hooks/useAppTheme";
import UserRoleBadgeIcons from "./UserRoleBadgeIcons";

const { width: SCREEN_WIDTH } = Dimensions.get("window");

const BookSearchCard = ({ item, customWidth, customHeight, customFontSize, hideAvatar = false, ...props }) => {
  const { theme } = useAppTheme();
  const thumbnailWidth = customWidth || SCREEN_WIDTH * 0.25;
  const thumbnailHeight = customHeight || thumbnailWidth * 1.5;
  const fontSize = customFontSize || 14;

  const handlePress = () => {
    router.push({
      pathname: "book-info",
      params: {
        bookId: item.$id,
      },
    });
  };

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={handlePress}
      accessibilityLabel={`Read book: ${item?.title ?? "Untitled"}`}
      className="mb-4 flex-row rounded-xl p-2"
      style={{ backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}
      {...props}
    >
      {/* Thumbnail */}
      <FastImage
        style={{
          height: thumbnailHeight,
          width: thumbnailWidth,
          borderRadius: 10,
          backgroundColor: theme.surfaceMuted,
        }}
        source={item?.thumbnail ? { uri: item.thumbnail, priority: FastImage.priority.normal } : null}
        resizeMode={FastImage.resizeMode.cover}
      >
        {!item?.thumbnail && (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator size="small" color={theme.primary} />
          </View>
        )}
      </FastImage>

      {/* Right column content */}
      <View className="flex-1 flex-col justify-between space-y-2 px-3 py-1">
        {/* Title */}
        <View>
          <Text className="font-sans font-bold" style={{ fontSize, color: theme.text }} numberOfLines={2} ellipsizeMode="tail">
            {item?.title || "Untitled"}
          </Text>

          {/* Author */}
          <View className="mt-1 flex-row items-center">
            <Text className="text-sm" style={{ color: theme.textMuted }} numberOfLines={1}>
              {`by ${item?.uploader?.username}`}
            </Text>
            <UserRoleBadgeIcons user={item?.uploader} size={12} />
          </View>
        </View>

        {/* Tags */}
        {item?.tags?.length > 0 && (
          <View className="mt-2 flex-row flex-wrap gap-1">
            {item.tags.slice(0, 2).map((tag, index) => (
              <View key={`${item?.$id ?? "tag"}-${index}`} className="rounded-full px-2 py-0.5" style={{ backgroundColor: theme.surfaceMuted }}>
                <Text className="text-xs font-medium" style={{ color: theme.text }} numberOfLines={1}>
                  {tag}
                </Text>
              </View>
            ))}
          </View>
        )}

        {/* Stats (votes + comments) */}
        {(item?.votes || item?.comments) && (
          <View className="mt-2 flex-row items-center space-x-4">
            {item?.votes !== undefined && (
              <Text className="text-xs" style={{ color: theme.textMuted }}>
                {`${item.votes} votes`}
              </Text>
            )}
            {item?.comments !== undefined && (
              <Text className="text-xs" style={{ color: theme.textMuted }}>
                {`${item.comments} comments`}
              </Text>
            )}
          </View>
        )}
      </View>
    </TouchableOpacity>
  );
};

export default memo(BookSearchCard);
