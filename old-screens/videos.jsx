import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Loader, StyledCoinIndicator, StyledSafeAreaView, StyledSearch, StyledSectionList } from "../../components";
import { useGlobalContext } from "../../context/global-provider";
import { FetchVideos, filterVideosByGenre, limitVideos, sortByViews, sortByWeeklyViews } from "../../lib/appwrite";

const Videos = () => {
  const { allVideos, setAllVideos, globalSettings } = useGlobalContext();
  const [homeLoading, setHomeLoading] = useState(true);
  const [homeSections, setHomeSections] = useState([]);

  useEffect(() => {
    fetchPosts();
  }, [allVideos]);

  const fetchPosts = async () => {
    try {
      setHomeSections([
        {
          title: "Latest Videos",
          data: limitVideos(allVideos, Number(globalSettings["LIMIT_VIDEOS_PER_CATEGORY"])),
        },
        {
          title: "Most Viewed Videos",
          data: sortByViews(allVideos, Number(globalSettings["LIMIT_VIDEOS_PER_CATEGORY"])),
        },
        {
          title: "Trending This Week",
          data: sortByWeeklyViews(allVideos, Number(globalSettings["LIMIT_VIDEOS_PER_CATEGORY"])),
        },
        {
          title: "Popular in Romance",
          data: filterVideosByGenre(allVideos, "Romance", Number(globalSettings["LIMIT_VIDEOS_PER_CATEGORY"])),
        },
      ]);
    } catch (error) {
    } finally {
      if (allVideos.length === 0) setHomeLoading(true);
      else setHomeLoading(false);
    }
  };

  const onRefresh = async () => {
    await FetchVideos(setAllVideos);
  };

  return (
    <StyledSafeAreaView>
      <Loader isLoading={homeLoading} />
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
      <StyledSectionList sections={homeSections} onRefresh={onRefresh} />
    </StyledSafeAreaView>
  );
};

export default Videos;
