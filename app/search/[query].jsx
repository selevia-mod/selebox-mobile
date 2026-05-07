import { Foundation, MaterialIcons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { TouchableOpacity, View } from "react-native";
import { Loader, StyledFlatList, StyledSafeAreaView, StyledSearch, StyledTitle } from "../../components";
import { useGlobalContext } from "../../context/global-provider";
import { FetchVideos, SearchVideos } from "../../lib/appwrite";

const Search = () => {
  const { query } = useLocalSearchParams();
  const { allVideos, setAllVideos } = useGlobalContext();
  const [searchedVideos, setSearchedVideos] = useState([]);
  const [loading, setLoading] = useState(true);

  const refetch = async () => {
    setLoading(true);
    try {
      await FetchVideos(setAllVideos);
      const queried_videos = await SearchVideos(query, allVideos);
      setSearchedVideos(queried_videos);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    SearchVideos(query, allVideos)
      .then((results) => {
        if (!cancelled) setSearchedVideos(results);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query, allVideos]);

  return (
    <StyledSafeAreaView>
      <Loader isLoading={loading} />
      <View className="h-full w-full">
        <View className="flex-row items-center justify-between p-2">
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={() => {
              router.back();
            }}
          >
            <MaterialIcons name="arrow-back" size={24} color="white" />
          </TouchableOpacity>
        </View>

        <View className="h-full w-full">
          <View className="flex px-2">
            <StyledTitle className="p-2" icon={<Foundation name="results" size={20} color="white" />} title="Search Results" />
            <StyledSearch className="my-2 p-2" initialQuery={query} refetch={refetch} />
          </View>
          <StyledFlatList data={searchedVideos} onRefresh={refetch} />
        </View>
      </View>
    </StyledSafeAreaView>
  );
};

export default Search;
