import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { ClipsIcon } from "../assets/svgs";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import { fetchRandomClips } from "../lib/clips";
import AnimatedSkeleton from "./AnimatedSkeleton";
import ClipCard from "./ClipCard";
import StyledFlatList from "./StyledFlatList";

const PostSuggestedClips = ({ forceUpdate }) => {
  const { allClipsLength, globalSettings } = useGlobalContext();
  const { theme } = useAppTheme();
  const [clips, setClips] = useState([]);
  const POSTS_SUGGESTED_CLIPS_COUNT = Number(globalSettings["POSTS_SUGGESTED_CLIPS_COUNT"] || 6);

  useEffect(() => {
    const fetchDetails = async () => {
      if (!allClipsLength) return;
      try {
        const result = await fetchRandomClips({ limit: POSTS_SUGGESTED_CLIPS_COUNT, allClipsLength });
        setClips(result.documents);
      } catch (err) {
        console.error("fetchClipDetails failed:", err);
      } finally {
      }
    };
    fetchDetails();
  }, [allClipsLength, forceUpdate]);

  const renderSkeleton = () => {
    return (
      <View className="flex-row">
        {[...Array(5)].map((_, index) => (
          <View key={index} className="mr-3" style={{ width: 150, height: 400 }}>
            <AnimatedSkeleton
              style={{
                width: 150,
                height: 300,
                borderRadius: 10,
                backgroundColor: theme.skeletonBase,
              }}
            />
            <AnimatedSkeleton
              style={{
                width: 150,
                height: 30,
                marginTop: 8,
                borderRadius: 5,
                backgroundColor: theme.skeletonBase,
              }}
            />
          </View>
        ))}
      </View>
    );
  };

  return (
    <View style={{ marginTop: 12, height: 400, borderRadius: 8, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}>
      <View className="flex-row items-center px-4 pt-2">
        <ClipsIcon width={24} height={24} color={theme.icon} />
        <Text className="ml-2 font-sans text-lg font-bold" style={{ color: theme.text }}>
          Suggested Clips
        </Text>
      </View>
      <StyledFlatList
        horizontal
        data={clips}
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        renderItem={({ item }) => <ClipCard customWidth={150} customHeight={270} item={{ ...item, created_time: item.$createdAt }} key={item?.$id} />}
        keyExtractor={(item, index) => item.$id ?? index.toString()}
        scrollToTopStyle={{ bottom: 5 }}
        ListFooterComponent={null}
        contentContainerStyle={{ paddingVertical: 10, paddingHorizontal: 10 }}
        refreshControl={null}
        ListEmptyComponent={renderSkeleton}
      />
    </View>
  );
};

export default PostSuggestedClips;
