import { MaterialCommunityIcons, MaterialIcons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, FlatList, RefreshControl, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useDispatch, useSelector } from "react-redux";
import { appendCreatorVideos, removeCreatorVideo, setCreatorVideos, updateCreatorVideo } from "../../store/reducers/creatorVideos";

import { CreatorVideoCard, StyledTitle } from "../../components";
import { useGlobalContext } from "../../context/global-provider";
import useAppTheme from "../../hooks/useAppTheme";
import useResetOnBlur from "../../hooks/useResetOnBlur";
import { VideosService } from "../../lib/video";

const CreatorSection = () => {
  const { theme } = useAppTheme();
  const { user } = useGlobalContext();
  const videosService = new VideosService();

  const dispatch = useDispatch();
  const { videos: userVideos, lastId, hasMore } = useSelector((s) => s.creatorVideos);
  const [refreshing, setRefreshing] = useState(false);

  const [isFetchingMore, setIsFetchingMore] = useState(false);
  useResetOnBlur(setRefreshing, setIsFetchingMore);

  useFocusEffect(
    useCallback(() => {
      fetchUserVideos();
    }, []),
  );

  // -------------------------------
  // FETCH FIRST PAGE
  // -------------------------------
  const fetchUserVideos = async () => {
    try {
      const res = await videosService.fetchVideos({ userId: user.$id, limit: 20 });

      dispatch(
        setCreatorVideos({
          videos: res.documents,
          lastId: res.documents.length ? res.documents.at(-1).$id : null,
          hasMore: res.total > res.documents.length,
        }),
      );
    } catch (err) {
      console.log("creator-section error", err?.message || err);
    }
  };

  // -------------------------------
  // REFRESH
  // -------------------------------
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetchUserVideos();
    } finally {
      setRefreshing(false);
    }
  }, []);

  // -------------------------------
  // PAGINATION
  // -------------------------------
  const fetchMoreVideos = async () => {
    if (!hasMore || isFetchingMore) return;
    setIsFetchingMore(true);

    try {
      const res = await videosService.fetchVideos({ userId: user.$id, limit: 20, lastId });

      dispatch(
        appendCreatorVideos({
          videos: res.documents,
          lastId: res.documents.length ? res.documents.at(-1).$id : lastId,
          hasMore: res.documents.length > 0,
        }),
      );
    } catch (err) {
      console.log("creator-section error", err?.message || err);
    }
    setIsFetchingMore(false);
  };

  const handleVideoDeleted = (id) => dispatch(removeCreatorVideo(id));
  const handleVideoUpdated = (updated) => dispatch(updateCreatorVideo(updated));
  const handleCreateVideo = () => router.push({ pathname: "/studio", params: { type: "video" } });

  // -------------------------------
  // RENDER
  // -------------------------------
  const renderItem = ({ item }) => <CreatorVideoCard item={item} onDeleted={handleVideoDeleted} onUpdated={handleVideoUpdated} />;

  return (
    <SafeAreaView className="flex-1" style={{ backgroundColor: theme.background }}>
      <View className="flex-1 px-1 pb-3">
        <View className="px-4 pb-2 pt-2">
          <View className="flex-row items-center justify-between">
            <StyledTitle
              className="py-0"
              icon={
                <TouchableOpacity onPress={() => router.back()}>
                  <MaterialIcons name="arrow-back" size={24} color={theme.icon} />
                </TouchableOpacity>
              }
              title="Creator Studio"
            />
            <TouchableOpacity activeOpacity={0.9} accessibilityRole="button" accessibilityLabel="Create new video" onPress={handleCreateVideo}>
              <MaterialCommunityIcons name="plus-circle" size={30} color={theme.icon} />
            </TouchableOpacity>
          </View>
        </View>
        <FlatList
          data={userVideos}
          keyExtractor={(item) => item.$id}
          renderItem={renderItem}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 104 }}
          onEndReachedThreshold={0.2}
          initialNumToRender={10}
          onEndReached={fetchMoreVideos}
          refreshControl={<RefreshControl refreshing={refreshing} tintColor={theme.primary} titleColor={theme.text} onRefresh={onRefresh} />}
          ListFooterComponent={
            isFetchingMore ? (
              <View className="items-center py-4">
                <ActivityIndicator size="small" color={theme.primary} />
              </View>
            ) : null
          }
          ListEmptyComponent={
            <View className="flex-1 items-center justify-center px-4 py-12">
              <MaterialCommunityIcons name="video-outline" size={48} color={theme.iconMuted} />
              <Text className="mt-4 text-lg font-semibold" style={{ color: theme.text }}>
                No Videos Yet
              </Text>
              <Text className="mt-2 text-center text-sm" style={{ color: theme.textSoft }}>
                You haven’t uploaded any videos yet.{"\n"}
                Start creating content and publish your first video!
              </Text>
            </View>
          }
        />
      </View>
    </SafeAreaView>
  );
};

export default CreatorSection;
