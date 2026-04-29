import { FontAwesome } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import { FetchVideos } from "../lib/appwrite";
import { VideosService } from "../lib/video";
import StyledFlatList from "./StyledFlatList";
import VideoCardSmall from "./VideoCardSmall";

const ProfileVideosTab = ({
  userId,
  nestedScrollEnabled = false,
  sectionTitle = "Videos",
  listRef,
  contentPaddingTop = 0,
  onScroll,
  onLoadingChange,
  suppressEmptyState = false,
}) => {
  const { user, allVideos, setAllVideos } = useGlobalContext();
  const { theme } = useAppTheme();
  const [videos, setVideos] = useState([]);
  const internalListRef = useRef(null);
  const effectiveListRef = listRef || internalListRef;
  const hasLoadedRef = useRef(false);

  const videosService = new VideosService();
  const isLoggedInUser = user?.$id === userId;

  useFocusEffect(
    useCallback(() => {
      fetchUserVideos();
    }, [userId, allVideos]),
  );

  const fetchUserVideos = async () => {
    if (!hasLoadedRef.current) onLoadingChange?.(true);
    try {
      const videosData = await videosService.fetchVideos({ userId: userId, limit: 100, status: "published" });
      setVideos(videosData.documents);
    } catch (error) {
      console.log("fetchUserVideos: error", error);
    } finally {
      if (!hasLoadedRef.current) {
        hasLoadedRef.current = true;
        onLoadingChange?.(false);
      }
    }
  };

  const onRefresh = async () => {
    await FetchVideos(setAllVideos);
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
        data={videos}
        onRefresh={onRefresh}
        nestedScrollEnabled={nestedScrollEnabled}
        ListHeaderComponent={renderListHeader}
        showsVerticalScrollIndicator={false}
        renderItem={({ item }) => <VideoCardSmall item={item} key={item?.uri} />}
        ListEmptyComponent={
          suppressEmptyState ? null : (
            <View className="flex-1 items-center justify-center px-4 py-12">
              <FontAwesome name="film" size={48} color={theme.textSoft} />
              <Text className="mt-4 font-sans text-lg font-semibold" style={{ fontFamily: "Poppins-SemiBold", color: theme.text }}>
                No Videos Yet
              </Text>
              <Text className="mt-2 text-center font-sans text-sm" style={{ fontFamily: "Poppins-Regular", color: theme.textSoft }}>
                {isLoggedInUser
                  ? "You haven't uploaded any videos yet.\nStart creating and share your first video!"
                  : "This user hasn't uploaded any videos yet."}
              </Text>
            </View>
          )
        }
        scrollToTopStyle={{ bottom: 5 }}
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentContainerStyle={{ paddingBottom: 40 }}
        keyExtractor={(item, index) => item?.uri || item?.$id || index.toString()}
        onScrollToIndexFailed={handleScrollToIndexFailed}
      />
    </View>
  );
};

export default ProfileVideosTab;
