import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { Alert, Text, View } from "react-native";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import { getPlaylist } from "../lib/appwrite";
import { VideosService } from "../lib/video";
import StyledFlatList from "./StyledFlatList";
import VideoCardSmall from "./VideoCardSmall";

const ProfilePlaylistTab = ({
  userId,
  nestedScrollEnabled = false,
  sectionTitle = "Playlist",
  listRef,
  contentPaddingTop = 0,
  onScroll,
  onLoadingChange,
  suppressEmptyState = false,
}) => {
  const { user } = useGlobalContext();
  const { theme } = useAppTheme();
  const [playlistPost, setPlaylistPost] = useState([]);
  const internalListRef = useRef(null);
  const effectiveListRef = listRef || internalListRef;
  const hasLoadedRef = useRef(false);

  const videosService = useMemo(() => new VideosService(), []);
  const isLoggedInUser = user?.$id === userId;

  const fetchPlaylistAndVideos = async () => {
    if (!hasLoadedRef.current) onLoadingChange?.(true);
    try {
      // Get playlist video URIs
      const playlist = await getPlaylist(userId);

      if (playlist.length > 0) {
        // Fetch videos by their URIs (could be from any user)
        const videoPromises = playlist.map((videoUri) => videosService.searchVideo({ uri: videoUri }));
        const videoResults = await Promise.all(videoPromises);

        // Extract videos from results (filter out null/undefined)
        const videos = videoResults.map((result) => result.documents[0]).filter((video) => video && video.status === "published");

        setPlaylistPost(videos);
      } else {
        setPlaylistPost([]);
      }
    } catch (error) {
      Alert.alert("Fetch Error", error.message);
    } finally {
      if (!hasLoadedRef.current) {
        hasLoadedRef.current = true;
        onLoadingChange?.(false);
      }
    }
  };

  useFocusEffect(
    useCallback(() => {
      fetchPlaylistAndVideos();
    }, [userId]),
  );

  const onRefresh = async () => {
    await fetchPlaylistAndVideos();
  };

  const handleScrollToIndexFailed = useCallback(({ averageItemLength, index }) => {
    const offset = Math.max(0, averageItemLength * index);
    effectiveListRef.current?.scrollToOffset?.({ offset, animated: true });
  }, []);

  const renderListHeader = () => (
    <View style={{ paddingTop: contentPaddingTop }}>
      {sectionTitle ? (
        <Text className="mb-2 text-xl font-bold" style={{ color: theme.text }}>
          {sectionTitle}
        </Text>
      ) : null}
    </View>
  );

  return (
    <View className="flex-1">
      <StyledFlatList
        ref={effectiveListRef}
        data={playlistPost}
        onRefresh={onRefresh}
        nestedScrollEnabled={nestedScrollEnabled}
        ListHeaderComponent={renderListHeader}
        renderItem={({ item }) => <VideoCardSmall item={item} onRefresh={onRefresh} />}
        ListEmptyComponent={
          suppressEmptyState ? null : (
            <View className="flex-1 items-center justify-center px-4 py-12">
              <MaterialCommunityIcons name="playlist-music" size={48} color={theme.textSoft} />
              <Text className="mt-4 font-sans text-lg font-semibold" style={{ fontFamily: "Poppins-SemiBold", color: theme.text }}>
                No Playlist Yet
              </Text>
              <Text className="mt-2 text-center font-sans text-sm" style={{ fontFamily: "Poppins-Regular", color: theme.textSoft }}>
                {isLoggedInUser
                  ? "You haven't added any videos to your playlist yet.\nStart building your collection by adding videos!"
                  : "This user hasn't added any videos to their playlist yet."}
              </Text>
            </View>
          )
        }
        scrollToTopStyle={{ bottom: 5 }}
        showsVerticalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentContainerStyle={{ paddingBottom: 40 }}
        keyExtractor={(item, index) => item?.uri || item?.$id || index.toString()}
        onScrollToIndexFailed={handleScrollToIndexFailed}
      />
    </View>
  );
};

export default ProfilePlaylistTab;
