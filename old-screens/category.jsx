import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Loader, StyledCoinIndicator, StyledSafeAreaView, StyledSearch, StyledSectionList } from "../../components";
import { useGlobalContext } from "../../context/global-provider";
import { FetchVideos, filterVideosByGenre } from "../../lib/appwrite";

const Category = () => {
  const { globalSettings, allVideos, setAllVideos } = useGlobalContext();
  const [categoryLoading, setCategoryLoading] = useState(true);
  const [categorySections, setCategorySections] = useState([]);

  useEffect(() => {
    fetchPosts();
  }, [allVideos]);

  const fetchPosts = async () => {
    try {
      const sections = [];
      const tags = JSON.parse(globalSettings["SORTED_CATEGORIES"]);
      for (const tag of tags) {
        sections.push({
          title: tag,
          data: filterVideosByGenre(allVideos, tag, Number(globalSettings["LIMIT_VIDEOS_PER_CATEGORY"])) || [],
        });
      }
      setCategorySections(sections);
    } catch (error) {
    } finally {
      if (allVideos.length === 0) setCategoryLoading(true);
      else setCategoryLoading(false);
    }
  };

  const onRefresh = async () => {
    await FetchVideos(setAllVideos);
  };

  return (
    <StyledSafeAreaView>
      <Loader isLoading={categoryLoading} />
      <View className="w-full flex-row items-center space-x-2 border-white p-2">
        <View className="h-[40px] w-full flex-1 flex-row items-center space-x-2">
          <View className="h-full items-center justify-center rounded-lg border border-white/50 px-2">
            <Text className="-mb-[8px] text-center font-pextrabold text-[16px] text-white">SELEBOX</Text>
            <Text className="text-center font-pextralight text-[11px] -tracking-[0.5px] text-white">Entertainment</Text>
          </View>
          <StyledSearch className="h-full flex-1" />
        </View>
        <StyledCoinIndicator
          onPress={() => {
            router.push("/store");
          }}
          className="h-[40px] rounded-lg px-1"
        />
      </View>
      <StyledSectionList sections={categorySections} onRefresh={onRefresh} />
    </StyledSafeAreaView>
  );
};

export default Category;
