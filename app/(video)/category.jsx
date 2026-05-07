import { AntDesign, MaterialIcons } from "@expo/vector-icons";
import { FlashList } from "@shopify/flash-list";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Dimensions, RefreshControl, Text, TouchableOpacity, View } from "react-native";
import { useSelector } from "react-redux";
import { SafeAreaView } from "react-native-safe-area-context";
import { Loader, VideoCardNew } from "../../components";
import { useGlobalContext } from "../../context/global-provider";
import useAppTheme from "../../hooks/useAppTheme";
import useResetOnBlur from "../../hooks/useResetOnBlur";
import { FetchVideos, filterVideosByVideoIds, getHistory, ShuffleVideos } from "../../lib/appwrite";
import { FollowService } from "../../lib/follows";
import { listBlockedUsers } from "../../lib/safety";
import { VideosService } from "../../lib/video";
import { fetchAudiobookVideosForSectionLimit, getAudiobookVideoGroups } from "../../utils/audiobookVideoSections";

const FROM_FOLLOWING_CATEGORY = "From Creators You Follow";
const FROM_FOLLOWING_CREATORS_LIMIT = 100;

const resolveOwnerId = (video) =>
  video?.uploader?.$id || video?.uploader?.id || video?.creatorId || video?.userId || video?.ownerId || video?.uploaderId || null;

const resolveFollowingId = (follow) => {
  const id =
    follow?.followingId?.$id ||
    follow?.followingId?.id ||
    follow?.followingId ||
    follow?.following?.$id ||
    follow?.following?.id ||
    follow?.following ||
    null;

  return typeof id === "string" ? id : null;
};

const getDocuments = (response) => {
  if (Array.isArray(response)) return response;
  return Array.isArray(response?.documents) ? response.documents : [];
};

const flattenCachedVideos = (videos = []) => {
  if (!Array.isArray(videos)) return [];

  return videos.reduce((acc, item) => {
    if (Array.isArray(item)) {
      acc.push(...item.filter(Boolean));
    } else if (item) {
      acc.push(item);
    }

    return acc;
  }, []);
};

const getCachedSectionVideos = ({ category, videosCache, userId }) => {
  const hasLoadedCache = Boolean(videosCache?.lastFetchedAt);
  const resolveCachedVideos = (videos) => {
    const flattenedVideos = flattenCachedVideos(videos);
    return hasLoadedCache || flattenedVideos.length > 0 ? flattenedVideos : null;
  };

  if (category === "Most People Want") return resolveCachedVideos(videosCache?.mostPeopleWant);
  if (category === "Suggested For You") return resolveCachedVideos(videosCache?.suggestedForYou);
  if (category === "Continue Watching") return resolveCachedVideos(videosCache?.continueWatching);
  if (category === "Trending this Week") return resolveCachedVideos(videosCache?.trendingWeek);
  if (category === "Videos you might like") return resolveCachedVideos(videosCache?.youMightLike);
  if (category === "Popular in your area") return resolveCachedVideos(videosCache?.popularInYourArea);
  if (category === "Latest videos") return resolveCachedVideos(videosCache?.latestVideos);

  if (category === FROM_FOLLOWING_CATEGORY) {
    if (!userId) return hasLoadedCache ? [] : null;
    if (videosCache?.fromFollowingUserId !== userId) return null;
    return resolveCachedVideos(videosCache?.fromFollowing);
  }

  const categoryVideos = videosCache?.categoryVideos || {};
  if (Object.prototype.hasOwnProperty.call(categoryVideos, category)) {
    return flattenCachedVideos(categoryVideos[category]);
  }

  return null;
};

const Category = () => {
  const { theme } = useAppTheme();
  const { category } = useLocalSearchParams();
  const { width } = Dimensions.get("window");
  const { user, allVideos, setAllVideos, globalSettings } = useGlobalContext();
  const videosCache = useSelector((state) => state.videos);
  const [categoryLoading, setCategoryLoadiing] = useState(true);
  const [categorizedVideos, setCategorizedVideos] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  useResetOnBlur(setRefreshing);
  const [showScrollUp, setShowScrollUp] = useState(false);
  const flatListRef = useRef(null);
  const videoLimit = Number(globalSettings["LIMIT_VIDEOS_PER_CATEGORY"]);
  const resolvedVideoLimit = Number.isFinite(videoLimit) && videoLimit > 0 ? videoLimit : 100;
  const videosServiceRef = useRef(new VideosService());

  const fetchCateegorizedVideos = useCallback(
    async ({ preferCache = true, showLoader = true } = {}) => {
      try {
        if (showLoader) setCategoryLoadiing(true);

        if (preferCache) {
          const cachedVideos = getCachedSectionVideos({
            category,
            videosCache,
            userId: user?.$id,
          });

          if (cachedVideos) {
            setCategorizedVideos(cachedVideos.slice(0, resolvedVideoLimit));
            return;
          }
        }

        const videosService = videosServiceRef.current;

        if (category === "Most People Want") {
          const audiobookVideos = await fetchAudiobookVideosForSectionLimit({
            videosService,
            sectionLimit: resolvedVideoLimit,
          });
          setCategorizedVideos(getAudiobookVideoGroups(audiobookVideos).mostPeopleWant.slice(0, resolvedVideoLimit));
        } else if (category === "Suggested For You") {
          const audiobookVideos = await fetchAudiobookVideosForSectionLimit({
            videosService,
            sectionLimit: resolvedVideoLimit,
          });
          setCategorizedVideos(ShuffleVideos(getAudiobookVideoGroups(audiobookVideos).suggestedForYou).slice(0, resolvedVideoLimit));
        } else if (category === "Videos you might like" || category === "Popular in your area") {
          const fetchedVideos = await videosService.fetchVideos({ limit: 100, status: "published" });
          const suggestedVideos = ShuffleVideos(fetchedVideos.documents).slice(0, resolvedVideoLimit);
          setCategorizedVideos(suggestedVideos);
        } else if (category === "Continue Watching") {
          const userHistory = await getHistory(user?.$id);
          if (userHistory.length > 0) {
            const videosData = await filterVideosByVideoIds(allVideos, userHistory);
            setCategorizedVideos(videosData);
          }
        } else if (category === FROM_FOLLOWING_CATEGORY) {
          if (!user?.$id) {
            setCategorizedVideos([]);
            return;
          }

          const [followingResponse, blockedIds] = await Promise.all([
            FollowService.getFollowing({ userId: user.$id, limit: FROM_FOLLOWING_CREATORS_LIMIT }),
            listBlockedUsers({ blockerId: user.$id }).catch(() => []),
          ]);
          const followingIds = [
            ...new Set(
              getDocuments(followingResponse)
                .map(resolveFollowingId)
                .filter(Boolean)
                .filter((id) => id !== user.$id && !blockedIds.includes(id)),
            ),
          ];

          if (followingIds.length === 0) {
            setCategorizedVideos([]);
            return;
          }

          const followingVideos = await videosService.fetchVideos({
            userId: followingIds,
            limit: resolvedVideoLimit,
            status: "published",
          });
          setCategorizedVideos((followingVideos?.documents || []).filter((video) => !blockedIds.includes(resolveOwnerId(video))));
        } else if (category === "Trending this Week") {
          const fetchedVideos = await videosService.fetchVideos({ limit: 100, status: "published" });
          setCategorizedVideos(ShuffleVideos(fetchedVideos.documents).slice(0, resolvedVideoLimit));
        } else if (category === "Latest videos") {
          const latestVideos = await videosService.fetchVideos({ limit: 100, status: "published" });
          setCategorizedVideos(latestVideos.documents.slice(0, resolvedVideoLimit));
        } else {
          const categorizedVideosByGenre = (await videosService.fetchVideos({ category: category, limit: 100, status: "published" })) || [];
          setCategorizedVideos(categorizedVideosByGenre.documents.slice(0, resolvedVideoLimit));
        }
      } catch (error) {
        console.log("fetchCateegorizedVideos: error", error);
      } finally {
        if (showLoader) setCategoryLoadiing(false);
      }
    },
    [allVideos, category, resolvedVideoLimit, user?.$id, videosCache],
  );

  useEffect(() => {
    fetchCateegorizedVideos();
  }, [fetchCateegorizedVideos]);

  const refreshCategorizedVideos = useCallback(async () => {
    setRefreshing(true);
    try {
      await FetchVideos(setAllVideos);
      await fetchCateegorizedVideos({ preferCache: false, showLoader: false });
    } finally {
      setRefreshing(false);
    }
  }, [fetchCateegorizedVideos, setAllVideos]);

  const handleScroll = (event) => {
    const offsetY = event.nativeEvent.contentOffset.y;
    setShowScrollUp(offsetY > 500);
  };

  const scrollToTop = () => {
    if (flatListRef.current && categorizedVideos.length > 0) {
      flatListRef.current.scrollToOffset({ offset: 0, animated: true });
    }
  };

  const keyExtractor = useCallback((item, index) => `${item.$id}-${index}`, []);

  const renderItem = useCallback(({ item }) => {
    return <VideoCardNew item={item} customWidth={width - 32} />;
  }, []);

  return (
    <SafeAreaView className="flex-1" style={{ backgroundColor: theme.background }}>
      <Loader isLoading={categoryLoading} />
      <View className="flex-1 px-4">
        <View className="h-[50px] flex-row items-center justify-between">
          <View className="flex-row items-center">
            <TouchableOpacity onPress={() => router.back()}>
              <MaterialIcons name="arrow-back" size={24} color={theme.icon} />
            </TouchableOpacity>
            <Text className="ml-2 font-sans text-2xl font-bold" style={{ color: theme.text }}>
              {category}
            </Text>
          </View>
        </View>

        {showScrollUp && (
          <TouchableOpacity
            activeOpacity={0.7}
            className="absolute bottom-[10] right-3 z-50 rounded-full p-3"
            style={{ backgroundColor: theme.surfaceElevated, borderWidth: 1, borderColor: theme.border }}
            onPress={scrollToTop}
          >
            <AntDesign name="arrowup" size={18} color={theme.icon} />
          </TouchableOpacity>
        )}

        <FlashList
          data={categorizedVideos}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          estimatedItemSize={300}
          contentContainerStyle={{ paddingBottom: 50 }}
          showsVerticalScrollIndicator={false}
          onRefresh={refreshCategorizedVideos}
          onScroll={handleScroll}
          ref={flatListRef}
          refreshing={refreshing}
          refreshControl={
            <RefreshControl
              tintColor={theme.primary}
              titleColor={theme.primary}
              progressBackgroundColor={theme.surface}
              refreshing={refreshing}
              onRefresh={refreshCategorizedVideos}
            />
          }
          ListEmptyComponent={
            <View className="items-center justify-center px-4 py-12">
              <MaterialIcons name="search-off" size={64} color={theme.textSubtle} />
              <Text className="mt-4 text-lg font-semibold" style={{ color: theme.text }}>
                No Results Found
              </Text>
              <Text className="mt-2 text-center text-base" style={{ color: theme.textSoft }}>
                We couldn’t find anything matching your search.{"\n"}Try different keywords.
              </Text>
            </View>
          }
        />
      </View>
    </SafeAreaView>
  );
};

export default Category;
