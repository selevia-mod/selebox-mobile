import { router } from "expo-router";
import { Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import useAppTheme from "../hooks/useAppTheme";
import TimeAgo from "../lib/time-ago";

const VideoCardSmall = ({ item, isFlexColumn, customHeight, customWidth, ...props }) => {
  const { theme } = useAppTheme();
  const handlePress = async (view) => {
    try {
      router.push({
        pathname: "video-player",
        params: {
          id: item.uri,
          docId: item.$id,
          view: "RECOMMENDED",
        },
      });
    } catch (error) {}
  };

  return (
    <TouchableOpacity activeOpacity={0.7} className={isFlexColumn ? "mx-2" : "m-2"} onPress={handlePress}>
      <View
        className={isFlexColumn ? "flex-column" : "flex-row space-x-2"}
        style={
          isFlexColumn
            ? {
                width: customWidth ?? 150,
              }
            : undefined
        }
      >
        <FastImage
          source={{ uri: item.thumbnail, priority: FastImage.priority.high }}
          className={isFlexColumn ? `rounded-md` : "aspect-video w-[100px] rounded-md"}
          style={
            isFlexColumn
              ? {
                  height: customHeight ?? 100,
                  width: customWidth ?? 150,
                }
              : undefined
          }
          resizeMode={FastImage.resizeMode.contain}
        />
        <View className="flex flex-1 justify-between">
          <Text className="font-sans text-xs font-bold" style={{ color: theme.text }} numberOfLines={1}>
            {item.title}
          </Text>
          <View className="flex flex-row flex-wrap items-center">
            <Text className="font-sans text-xs" style={{ color: theme.textMuted }} numberOfLines={1}>
              {item?.uploader?.username || "Unknown"}

              <Text> • </Text>
              {item?.tags?.map((name, index) => (
                <Text key={name} className="font-sans text-xs" style={{ color: theme.textMuted }}>
                  {name}
                  <Text> • </Text>
                </Text>
              ))}
              {TimeAgo(item.publishDate ?? item.$createdAt)}
            </Text>
          </View>
          <Text className="font-sans text-xs" style={{ color: theme.textSoft }} numberOfLines={1}>
            {item.description}
          </Text>
        </View>
      </View>
    </TouchableOpacity>
  );
};

export default VideoCardSmall;
