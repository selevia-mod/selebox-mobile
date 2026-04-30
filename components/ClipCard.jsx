import { router } from "expo-router";
import React from "react";
import { Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import useAppTheme from "../hooks/useAppTheme";
import TimeAgo from "../lib/utils/time-ago";

const ClipCard = ({ item, customHeight, customWidth, ...props }) => {
  const { theme } = useAppTheme();
  const handlePress = async (view) => {
    try {
      router.push({
        pathname: "clips",
        params: {
          showClip: JSON.stringify(item),
          showClipTrigger: Date.now(),
        },
      });
    } catch (error) {}
  };

  return (
    <TouchableOpacity onPress={handlePress} activeOpacity={0.7} className="m-2" style={{ height: customHeight, width: customWidth }}>
      <View className="w-full">
        <FastImage
          source={{ uri: item.thumbnail, priority: FastImage.priority.normal }}
          className="aspect-[9/16] w-full rounded-md"
          resizeMode={FastImage.resizeMode.cover}
        />
        <View className="mt-1 flex flex-col justify-between">
          <Text className="font-sans text-xs font-bold" style={{ color: theme.text }} numberOfLines={1}>
            {item.title}
          </Text>
          <Text className="font-sans text-xs" style={{ color: theme.textMuted }} numberOfLines={1}>
            {item?.uploader?.username || "Unknown"} • {item?.tags?.join(" • ")} • {TimeAgo(item.created_time)}
          </Text>
          <Text className="font-sans text-xs" style={{ color: theme.textSoft }} numberOfLines={1}>
            {item.description}
          </Text>
        </View>
      </View>
    </TouchableOpacity>
  );
};

export default ClipCard;
