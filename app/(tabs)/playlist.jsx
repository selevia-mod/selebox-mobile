import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
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

  // Mirror `allVideos` into a ref so the focus callback can read the
  // freshest array without going into the focus-effect's dep list.
  // Putting `allVideos` directly in the useCallback deps caused a
  // refresh loop: any other surface (home, video-player) calling
  // setAllVideos created a new array reference → the callback re-
  // identified → useFocusEffect treated that as a re-mount and
  // re-fetched the playlist immediately, which on accounts where the
  // home/videos tab was actively prefetching meant a continuous
  // re-fetch cycle. The ref reads the latest value at call-time
  // without forcing the callback to recreate.
  const allVideosRef = useRef(allVideos);
  useEffect(() => {
    allVideosRef.current = allVideos;
  }, [allVideos]);

  const fetchPlaylistAndVideos = useCallback(async () => {
    if (!user?.$id) {
      setPlaylistPost([]);
      setPlaylistLoading(false);
      return;
    }
    try {
      setPlaylistLoading(true);
      const playlist = await getPlaylist(user.$id);
      if (!playlist || playlist.length === 0) {
        setPlaylistPost([]);
        return;
      }
      // Hydrate the videos cache on demand if it's empty. Without
      // any videos in memory there's nothing to filter against, so
      // the playlist would render empty even when the user has
      // saved items. FetchVideos populates the global context;
      // we read the latest from the ref right after.
      let videos = allVideosRef.current || [];
      if (videos.length === 0) {
        await FetchVideos(setAllVideos);
        videos = allVideosRef.current || [];
      }
      const videosData = await filterVideosByVideoIds(videos, playlist);
      setPlaylistPost(videosData);
    } catch (error) {
      Alert.alert("Fetch Error", error?.message || "Couldn't load your playlist.");
    } finally {
      // Always release the loader. Earlier this branched on
      // allVideos.length and KEPT loading=true when it was 0, which
      // hid the empty-state UI behind a forever-spinner.
      setPlaylistLoading(false);
    }
  }, [user?.$id, setAllVideos]);

  useFocusEffect(
    // Use the primitive user id as the dep so the callback's identity
    // is stable across context re-renders. The previous version put
    // the whole `user` object in deps, which re-identifies whenever
    // the global provider's value object changes — same loop story
    // as the allVideos one above.
    useCallback(() => {
      fetchPlaylistAndVideos();
    }, [fetchPlaylistAndVideos]),
  );

  const onRefresh = async () => {
    await FetchVideos(setAllVideos);
    await fetchPlaylistAndVideos();
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
