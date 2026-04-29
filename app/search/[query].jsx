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
    await FetchVideos(setAllVideos);
    const queried_videos = await SearchVideos(query, videos);
    setSearchedVideos(queried_videos);
  };

  useEffect(() => {
    setLoading(true);
    SearchVideos(query, allVideos).then((videos) => setSearchedVideos(videos));
    setLoading(false);
  }, [query]);

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
