import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, View } from "react-native";
import { Loader, StyledFlatList, StyledSafeAreaView, StyledTitle } from "../../components";
import { useGlobalContext } from "../../context/global-provider";
import useAppTheme from "../../hooks/useAppTheme";
import { FetchVideos, filterVideosByVideoIds, getPlaylist } from "../../lib/appwrite";

const Playlist = () => {
  const { theme } = useAppTheme();
  const { user, allVideos, setAllVideos } = useGlobalContext();
  const [playlistLoading, setPlaylistLoading] = useState(true);
  const [playlistPost, setPlaylistPost] = useState([]);

  const fetchPlaylistAndVideos = async () => {
    try {
      const playlist = await getPlaylist(user?.$id);
      if (playlist.length > 0) {
        const videosData = await filterVideosByVideoIds(allVideos, playlist);
        setPlaylistPost(videosData);
      } else {
        setPlaylistPost([]);
      }
    } catch (error) {
      Alert.alert("Fetch Error", error.message);
    } finally {
      if (allVideos.length === 0) setPlaylistLoading(true);
      else setPlaylistLoading(false);
    }
  };

  useFocusEffect(
    useCallback(() => {
      fetchPlaylistAndVideos();
    }, [user, allVideos]),
  );

  const onRefresh = async () => {
    await FetchVideos(setAllVideos);
  };

  return (
    <StyledSafeAreaView style={{ backgroundColor: theme.background }}>
      <Loader isLoading={playlistLoading} />
      <View className="h-full w-full" style={{ backgroundColor: theme.background }}>
        <StyledTitle
          className="px-4"
          icon={<MaterialCommunityIcons name="playlist-star" size={24} color={theme.icon} />}
          title="My Playlist"
          titleStyle={{ color: theme.text }}
        />
        <StyledFlatList data={playlistPost} onRefresh={onRefresh} />
      </View>
    </StyledSafeAreaView>
  );
};

export default Playlist;
