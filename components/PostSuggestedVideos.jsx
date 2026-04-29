import { FontAwesome } from "@expo/vector-icons";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import { ShuffleVideos } from "../lib/appwrite";
import StyledFlatList from "./StyledFlatList";
import VideoCardSmall from "./VideoCardSmall";

const PostSuggestedVideos = () => {
  const { allVideos, globalSettings } = useGlobalContext();
  const { theme } = useAppTheme();
  const POSTS_SUGGESTED_VIDEOS_COUNT = Number(globalSettings["POSTS_SUGGESTED_VIDEOS_COUNT"] || 6);

  const videos = useMemo(() => {
    if (!allVideos || allVideos.length === 0) return [];
    const randomVideos = ShuffleVideos(allVideos).slice(0, POSTS_SUGGESTED_VIDEOS_COUNT);
    return randomVideos;
  }, [allVideos]);

  return (
    <View
      style={{
        flex: 1,
        marginTop: 12,
        paddingBottom: 10,
        borderRadius: 8,
        backgroundColor: theme.card,
        borderWidth: 1,
        borderColor: theme.border,
      }}
    >
      <View className="flex-row items-center px-4 py-2">
        <FontAwesome name="film" size={20} color={theme.icon} />
        <Text className="ml-2 font-sans text-lg font-bold" style={{ color: theme.text }}>
          Suggested Videos
        </Text>
      </View>
      <StyledFlatList
        horizontal={true}
        key={"videoHomeTab"}
        data={videos}
        renderItem={({ item }) => <VideoCardSmall customHeight={180} customWidth={280} isFlexColumn={true} item={item} key={item?.uri} />}
        ListFooterComponent={null}
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        scrollToTopStyle={{ bottom: 5 }}
        contentContainerStyle={{ paddingVertical: 10, paddingHorizontal: 10 }}
        refreshControl={null}
      />
    </View>
  );
};

export default PostSuggestedVideos;
