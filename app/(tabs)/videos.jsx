import { FlashList } from "@shopify/flash-list";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dimensions, RefreshControl, Text, TouchableOpacity, View } from "react-native";
import PagerView from "react-native-pager-view";
import { useDispatch, useSelector } from "react-redux";
import {
  MainScreensHeader,
  StyledSafeAreaView,
  VideoCardNew,
  VideosContinueWatching,
  VideosFromFollowing,
  VideosLatest,
  VideosMostPeopleWant,
  VideosPerCategory,
  VideosPopularInYourArea,
  VideosSectionsSkeleton,
  VideosSuggestedForYou,
  VideosTrendingWeek,
  VideosYouMightLike,
} from "../../components";
import VideosDownload from "../../components/VideosDownload";
import VideosPlaylist from "../../components/VideosPlaylist";
import { useGlobalContext } from "../../context/global-provider";
import useAppTheme from "../../hooks/useAppTheme";
// Phase E.10 — tier-tuned FlashList window for the Videos tab.
import { getFlashListConfig } from "../../lib/device-tier";

const { height: VIDEOS_SCREEN_HEIGHT } = Dimensions.get("window");
import useResetOnBlur from "../../hooks/useResetOnBlur";
import { ShuffleVideos } from "../../lib/appwrite";
import { FollowService } from "../../lib/follows";
import { listBlockedUsers } from "../../lib/safety";
import tabNavigationEvents from "../../lib/tab-navigation-events";
import { VideosService } from "../../lib/video";
import { setVideosCache } from "../../store/reducers/videos";
import {
  AUDIOBOOK_SECTIONS_CACHE_VERSION,
  AUDIOBOOK_VIDEOS_LIMIT,
  fetchAudiobookVideosForSectionLimit,
  getAudiobookSections,
} from "../../utils/audiobookVideoSections";

const FROM_FOLLOWING_CACHE_VERSION = 3;
const FROM_FOLLOWING_CREATORS_LIMIT = 60;
const FROM_FOLLOWING_TOTAL_LIMIT = 30;
const SECTION_SPACING = 5;
const LIST_PADDING_BOTTOM = 60;
const LIST_PADDING_TOP = 12;
const TAB_TITLES = ["For You", "Playlist", "Downloads"];

// Section height estimate for FlashList. Most carousels render at ~330–360 px,
// Category sections (rows of 2) at ~600–700 px. 420 splits the difference and
// keeps FlashList's drawDistance budget honest. Wrong estimates here are the
// classic cause of "white-on-fast-scroll" because the recycler can't predict
// where the next cell will land.
const SECTION_ESTIMATED_HEIGHT = 420;
const SectionSeparator = () => <View style={{ height: SECTION_SPACING }} />;

const chunkArray = (array, chunkSize) => {
  const result = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    result.push(array.slice(i, i + chunkSize));
  }
  return result;
};

const getSortedCategories = (settings) => {
  try {
    return JSON.parse(settings["SORTED_CATEGORIES"] || "[]");
  } catch {
    return [];
  }
};

const getRandomOffset = (total, limit) => {
  if (!total || total <= limit) return 0;
  const maxOffset = Math.max(0, total - limit);
  return Math.floor(Math.random() * (maxOffset + 1));
};

const mergeUniqueVideos = (videos = []) => {
  const seen = new Set();
  const result = [];
  videos.forEach((video) => {
    const key = video?.$id || video?.id || video?.uri;
    if (!key || seen.has(key)) return;
    seen.add(key);
    result.push(video);
  });
  return result;
};

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

const Videos = () => {
  const { theme } = useAppTheme();
  const { width } = Dimensions.get("window");
  const { allVideos, setAllVideos, user } = useGlobalContext();
  const dispatch = useDispatch();
  const { globalSettings } = useSelector((state) => state.app);
  const videosCache = useSelector((state) => state.videos);
  const videosServiceRef = useRef(new VideosService());
  const [videosLoading, setVideosLoading] = useState(true);
  const [videosSections, setVideosSections] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  // Phase E.10 — tier-tuned FlashList window. Memoized so prop identity
  // is stable across re-renders (FlashList re-lays-out on prop changes).
  const flashListConfig = useMemo(() => getFlashListConfig({ screenHeight: VIDEOS_SCREEN_HEIGHT }), []);
  useResetOnBlur(setRefreshing);
  const [mostPeopleWant, setMostPeopleWant] = useState([]);
  const [fromFollowing, setFromFollowing] = useState([]);
  const [suggestedForYou, setSuggestedForYou] = useState([]);
  const [continueWatching, setContinueWatching] = useState([]);
  const [trendingWeek, setTrendingWeek] = useState([]);
  const [youMightLike, setYouMightLike] = useState([]);
  const [popularInYourArea, setPopularInYourArea] = useState([]);
  const [latestVideos, setLatestVideos] = useState([]);
  const [categoryVideos, setCategoryVideos] = useState({});
  const [blockedUserIds, setBlockedUserIds] = useState([]);
  const [activePage, setActivePage] = useState(0);
  const flatListRef = useRef(null);
  const lastScrollY = useRef(0);
  const navHiddenRef = useRef(false);
  const pagerRef = useRef(null);
  const activePageRef = useRef(activePage);
  const filterBlocked = useCallback(
    (items = []) => {
      if (!blockedUserIds.length) return items;
      return items.filter((v) => !blockedUserIds.includes(resolveOwnerId(v)));
    },
    [blockedUserIds],
  );

  useEffect(() => {
    const generateSections = () => {
      const tags = getSortedCategories(globalSettings);
      const sections = [];

      let tagIndex = 0;

      sections.push({ type: "MostPeopleWant" });
      sections.push({ type: "VideosFromFollowing" });
      sections.push({ type: "SuggestedForYou" });
      sections.push({ type: "ContinueWatching" });

      // Utility to push next N tags as Category sections
      const pushNextCategories = (count) => {
        for (let i = 0; i < count && tagIndex < tags.length; i++, tagIndex++) {
          sections.push({ type: "Category", category: tags[tagIndex] });
        }
      };

      pushNextCategories(2); // after ContinueWatching
      sections.push({ type: "TrendingWeek" });

      pushNextCategories(2); // after Trending
      sections.push({ type: "YouMightLike" });

      pushNextCategories(2); // after YouMightLike
      sections.push({ type: "PopularInYourArea" });

      pushNextCategories(2); // after Popular
      sections.push({ type: "Latest" });

      // Push remaining categories
      while (tagIndex < tags.length) {
        sections.push({ type: "Category", category: tags[tagIndex++] });
      }

      setVideosSections(sections);
    };

    generateSections();
  }, [globalSettings]);

  const loadVideosData = useCallback(
    async ({ showLoader = true } = {}) => {
      try {
        if (showLoader) setVideosLoading(true);
        const tags = getSortedCategories(globalSettings || {});
        const videoLimit = Number(globalSettings?.["LIMIT_VIDEOS_PER_CATEGORY"]);
        const resolvedSectionLimit = Number.isFinite(videoLimit) && videoLimit > 0 ? videoLimit : AUDIOBOOK_VIDEOS_LIMIT;
        const service = videosServiceRef.current;

        const baseVideosPromise = service.fetchVideos({ limit: 60, status: "published" });
        const audiobookVideosPromise = fetchAudiobookVideosForSectionLimit({
          videosService: service,
          sectionLimit: resolvedSectionLimit,
          filterVideos: filterBlocked,
        });
        const fromFollowingPromise = (async () => {
          try {
            if (!user?.$id) return [];

            const followingResponse = await FollowService.getFollowing({ userId: user.$id, limit: FROM_FOLLOWING_CREATORS_LIMIT });
            const followingIds = [
              ...new Set(
                getDocuments(followingResponse)
                  .map(resolveFollowingId)
                  .filter(Boolean)
                  .filter((id) => id !== user.$id && !blockedUserIds.includes(id)),
              ),
            ];

            if (followingIds.length === 0) return [];

            const response = await service.fetchVideos({
              userId: followingIds,
              limit: FROM_FOLLOWING_TOTAL_LIMIT,
              status: "published",
            });
            return filterBlocked(response?.documents || []);
          } catch (error) {
            console.error("fromFollowing videos error", error);
            return [];
          }
        })();
        const categoryPromises = tags.map(async (category) => {
          const categorizedVideos = await service.fetchVideos({ limit: 60, category: category, status: "published" });
          const chunked = chunkArray(ShuffleVideos(categorizedVideos?.documents || []).slice(0, 30), 2);
          return { category, videos: chunked };
        });

        const [baseVideosResponse, audiobookVideosResponse, fromFollowingVideos, categoryResults] = await Promise.all([
          baseVideosPromise,
          audiobookVideosPromise,
          fromFollowingPromise,
          Promise.all(categoryPromises),
        ]);
        const latestBaseVideos = baseVideosResponse?.documents || [];
        const baseTotal = baseVideosResponse?.total ?? 0;
        const baseOffset = getRandomOffset(baseTotal, 60);
        const randomBaseResponse = baseOffset > 0 ? await service.fetchVideos({ limit: 60, status: "published", offset: baseOffset }) : null;
        const mergedBase = mergeUniqueVideos([...(latestBaseVideos || []), ...(randomBaseResponse?.documents || [])]);
        const baseVideos = filterBlocked(mergedBase);
        const audiobookVideos = audiobookVideosResponse || [];
        const audiobookSections = getAudiobookSections(audiobookVideos, resolvedSectionLimit);
        const latestVideosFiltered = filterBlocked(latestBaseVideos || []);

        const categoriesMap = {};
        const allCategoryVideos = [];
        categoryResults.forEach(({ category, videos }) => {
          const safeFlat = filterBlocked(videos.flat());
          allCategoryVideos.push(...safeFlat);
          categoriesMap[category] = safeFlat.reduce((acc, _, idx, arr) => {
            if (idx % 2 === 0) acc.push(arr.slice(idx, idx + 2));
            return acc;
          }, []);
        });

        const searchableVideos = mergeUniqueVideos([...baseVideos, ...audiobookVideos, ...fromFollowingVideos, ...allCategoryVideos]);

        const payload = {
          baseVideos: searchableVideos,
          audiobookSectionsCacheVersion: AUDIOBOOK_SECTIONS_CACHE_VERSION,
          audiobookSectionsLimit: resolvedSectionLimit,
          mostPeopleWant: audiobookSections.mostPeopleWant,
          fromFollowing: fromFollowingVideos,
          fromFollowingCacheVersion: FROM_FOLLOWING_CACHE_VERSION,
          fromFollowingUserId: user?.$id || null,
          suggestedForYou: audiobookSections.suggestedForYou,
          continueWatching: baseVideos.slice(0, 30),
          trendingWeek: ShuffleVideos(baseVideos),
          youMightLike: ShuffleVideos(baseVideos).slice(0, 30),
          popularInYourArea: ShuffleVideos(baseVideos).slice(0, 30),
          latestVideos: latestVideosFiltered.slice(0, 30),
          categoryVideos: categoriesMap,
          lastFetchedAt: Date.now(),
        };

        setAllVideos(payload.baseVideos);
        setMostPeopleWant(payload.mostPeopleWant);
        setFromFollowing(payload.fromFollowing);
        setSuggestedForYou(payload.suggestedForYou);
        setContinueWatching(payload.continueWatching);
        setTrendingWeek(payload.trendingWeek);
        setYouMightLike(payload.youMightLike);
        setPopularInYourArea(payload.popularInYourArea);
        setLatestVideos(payload.latestVideos);
        setCategoryVideos(payload.categoryVideos);
        dispatch(setVideosCache(payload));
      } catch (error) {
        console.error("loadVideosData error", error);
      } finally {
        setVideosLoading(false);
      }
    },
    [blockedUserIds, dispatch, filterBlocked, globalSettings, setAllVideos, user?.$id],
  );

  useEffect(() => {
    const now = Date.now();
    const TWELVE_HOURS = 12 * 60 * 60 * 1000;
    const hasCache = (videosCache?.baseVideos || []).length > 0;
    const isStale = !videosCache?.lastFetchedAt || now - videosCache.lastFetchedAt > TWELVE_HOURS;
    const videoLimit = Number(globalSettings?.["LIMIT_VIDEOS_PER_CATEGORY"]);
    const resolvedSectionLimit = Number.isFinite(videoLimit) && videoLimit > 0 ? videoLimit : AUDIOBOOK_VIDEOS_LIMIT;
    const needsFromFollowingCache =
      Boolean(user?.$id) &&
      (videosCache?.fromFollowingUserId !== user.$id || videosCache?.fromFollowingCacheVersion !== FROM_FOLLOWING_CACHE_VERSION);
    const needsAudiobookSectionsCache =
      videosCache?.audiobookSectionsCacheVersion !== AUDIOBOOK_SECTIONS_CACHE_VERSION || videosCache?.audiobookSectionsLimit !== resolvedSectionLimit;

    if (hasCache) {
      setAllVideos(filterBlocked(videosCache.baseVideos || []));
      setMostPeopleWant(getAudiobookSections(filterBlocked(videosCache.mostPeopleWant || []), resolvedSectionLimit).mostPeopleWant);
      setFromFollowing(
        videosCache.fromFollowingUserId === user?.$id ? filterBlocked(videosCache.fromFollowing || []).slice(0, FROM_FOLLOWING_TOTAL_LIMIT) : [],
      );
      setSuggestedForYou(getAudiobookSections(filterBlocked((videosCache.suggestedForYou || []).flat()), resolvedSectionLimit).suggestedForYou);
      setContinueWatching(filterBlocked(videosCache.continueWatching || []));
      setTrendingWeek(filterBlocked(videosCache.trendingWeek || []));
      setYouMightLike(filterBlocked(videosCache.youMightLike || []));
      setPopularInYourArea(filterBlocked(videosCache.popularInYourArea || []));
      setLatestVideos(filterBlocked(videosCache.latestVideos || []));
      const filteredCategories = {};
      Object.entries(videosCache.categoryVideos || {}).forEach(([key, pairs]) => {
        filteredCategories[key] = (pairs || []).map((pair) => filterBlocked(pair));
      });
      setCategoryVideos(filteredCategories);
      setVideosLoading(false);
    }

    if (!hasCache) {
      loadVideosData({ showLoader: true });
    } else if (isStale || needsFromFollowingCache || needsAudiobookSectionsCache) {
      loadVideosData({ showLoader: false });
    }
  }, [filterBlocked, globalSettings, loadVideosData, setAllVideos, user?.$id, videosCache]);

  const refreshVideos = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadVideosData({ showLoader: false });
    } finally {
      setRefreshing(false);
    }
  }, [loadVideosData]);

  const handleScroll = (event) => {
    const y = event?.nativeEvent?.contentOffset?.y ?? 0;
    const delta = y - lastScrollY.current;

    if (y <= 0) {
      if (navHiddenRef.current) {
        navHiddenRef.current = false;
        tabNavigationEvents.emit("tabBarVisibility", { visible: true });
      }
      lastScrollY.current = y;
      return;
    }

    if (Math.abs(delta) < 6) {
      lastScrollY.current = y;
      return;
    }

    if (delta > 12 && y > 60 && !navHiddenRef.current) {
      navHiddenRef.current = true;
      tabNavigationEvents.emit("tabBarVisibility", { visible: false });
    } else if (delta < -12 && navHiddenRef.current) {
      navHiddenRef.current = false;
      tabNavigationEvents.emit("tabBarVisibility", { visible: true });
    }

    lastScrollY.current = y;
  };

  useEffect(() => {
    if (!user?.$id) return;
    listBlockedUsers({ blockerId: user.$id })
      .then((ids) => setBlockedUserIds(ids || []))
      .catch(() => {});
  }, [user?.$id]);

  useFocusEffect(
    useCallback(() => {
      navHiddenRef.current = false;
      tabNavigationEvents.emit("tabBarVisibility", { visible: true });
      return () => {
        navHiddenRef.current = false;
        tabNavigationEvents.emit("tabBarVisibility", { visible: true });
      };
    }, []),
  );

  useEffect(() => {
    const handleScrollToTop = ({ tab }) => {
      if (tab !== "videos") return;
      lastScrollY.current = 0;
      flatListRef.current?.scrollToOffset?.({ offset: 0, animated: true });
      if (navHiddenRef.current) {
        navHiddenRef.current = false;
        tabNavigationEvents.emit("tabBarVisibility", { visible: true });
      }
    };

    tabNavigationEvents.on("scrollToTop", handleScrollToTop);
    return () => {
      tabNavigationEvents.off("scrollToTop", handleScrollToTop);
    };
  }, []);

  // Memoized so FlashList can recycle cells. Without useCallback this is a
  // fresh fn ref every render and FlashList re-mounts visible cells on any
  // parent state change — that's the white-on-scroll-down bug. Closes over
  // the section data slices directly so we don't need extraData on the list.
  const renderSection = useCallback(
    ({ item }) => {
      switch (item.type) {
        case "MostPeopleWant":
          return <VideosMostPeopleWant videos={mostPeopleWant} />;
        case "VideosFromFollowing":
          return <VideosFromFollowing videos={fromFollowing} />;
        case "SuggestedForYou":
          return <VideosSuggestedForYou videos={suggestedForYou} />;
        case "ContinueWatching":
          return <VideosContinueWatching videos={continueWatching} />;
        case "TrendingWeek":
          return <VideosTrendingWeek videos={trendingWeek} />;
        case "YouMightLike":
          return <VideosYouMightLike videos={youMightLike} />;
        case "PopularInYourArea":
          return <VideosPopularInYourArea videos={popularInYourArea} />;
        case "Latest":
          return <VideosLatest videos={latestVideos} />;
        case "Category":
          return <VideosPerCategory category={item.category} videos={categoryVideos[item.category] || []} />;
        default:
          return <VideoCardNew item={item} customWidth={width - 32} />;
      }
    },
    [
      mostPeopleWant,
      fromFollowing,
      suggestedForYou,
      continueWatching,
      trendingWeek,
      youMightLike,
      popularInYourArea,
      latestVideos,
      categoryVideos,
      width,
    ],
  );

  // Tells FlashList to recycle each section type into its own pool. Without
  // this, FlashList may try to reuse a Category cell (tall) for a TrendingWeek
  // cell (short) and cause a measurement+layout pass that flashes blank.
  const getItemType = useCallback((item) => item.type, []);

  const handleTabPress = (index) => {
    pagerRef.current?.setPage(index);
    setActivePage(index);
  };

  const handlePageSelected = (e) => {
    const position = e.nativeEvent.position;
    activePageRef.current = position;
    setActivePage(position);
  };

  const keyExtractor = useCallback((item, index) => `${item.type}-${item.category ?? index}`, []);

  // Show the inline skeleton only on first cold load — once we have any
  // section data ready we drop the placeholder and render the real list,
  // even if a background refresh is still running. Mirrors how the home
  // feed handles PostCardSkeleton via FlashList's ListEmptyComponent.
  const hasAnyVideoSectionData =
    mostPeopleWant.length > 0 ||
    fromFollowing.length > 0 ||
    suggestedForYou.length > 0 ||
    continueWatching.length > 0 ||
    trendingWeek.length > 0 ||
    youMightLike.length > 0 ||
    popularInYourArea.length > 0 ||
    latestVideos.length > 0 ||
    Object.keys(categoryVideos).length > 0;
  const showVideosSkeleton = videosLoading && !hasAnyVideoSectionData;

  return (
    <StyledSafeAreaView edges={["top"]} style={{ backgroundColor: theme.background }}>
      <View className="w-full flex-1 pb-4">
        <View className="px-4 pb-2 pt-1.5">
          <MainScreensHeader title="videos" />
        </View>
        <View className="flex-1">
          {/* Premium violet pill tabs — matches the home feed and Books tab language. */}
          <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingTop: 8, paddingBottom: 10 }}>
            {TAB_TITLES.map((title, index) => {
              const isActive = activePage === index;
              return (
                <TouchableOpacity
                  key={index}
                  onPress={() => handleTabPress(index)}
                  activeOpacity={0.85}
                  style={{
                    paddingVertical: 8,
                    paddingHorizontal: 16,
                    borderRadius: 999,
                    marginRight: 6,
                    backgroundColor: isActive ? theme.primary : "transparent",
                    shadowColor: theme.primary,
                    shadowOffset: { width: 0, height: 4 },
                    shadowOpacity: isActive ? 0.25 : 0,
                    shadowRadius: 8,
                    elevation: isActive ? 3 : 0,
                  }}
                >
                  <Text
                    style={{
                      fontSize: 13,
                      fontWeight: isActive ? "700" : "500",
                      letterSpacing: 0.1,
                      color: isActive ? (theme.primaryContrast ?? "#ffffff") : (theme.textMuted ?? theme.text),
                    }}
                  >
                    {title}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <View className="flex-1">
            <PagerView className="flex-1" initialPage={0} ref={pagerRef} onPageSelected={handlePageSelected} scrollEnabled={false}>
              <View className="h-full flex-1">
                {showVideosSkeleton ? (
                  // Inline skeleton stack during cold load — same pattern as
                  // PostCardSkeleton on the home feed and EditProfileSkeleton
                  // on settings. Replaces the previous full-screen <Loader>
                  // modal so the loading state feels native to the screen
                  // instead of a blocking overlay.
                  <VideosSectionsSkeleton count={4} />
                ) : (
                  <FlashList
                    data={videosSections}
                    renderItem={renderSection}
                    keyExtractor={keyExtractor}
                    getItemType={getItemType}
                    contentContainerStyle={{ paddingHorizontal: 12 }}
                    estimatedItemSize={SECTION_ESTIMATED_HEIGHT}
                    drawDistance={flashListConfig.drawDistance}
                    removeClippedSubviews={flashListConfig.removeClippedSubviews}
                    onEndReachedThreshold={flashListConfig.onEndReachedThreshold}
                    ItemSeparatorComponent={SectionSeparator}
                    showsVerticalScrollIndicator={false}
                    onScroll={handleScroll}
                    scrollEventThrottle={16}
                    ref={flatListRef}
                    ListFooterComponent={SectionSeparator}
                    refreshControl={
                      <RefreshControl
                        tintColor={theme.primary}
                        titleColor={theme.primary}
                        progressBackgroundColor={theme.surface}
                        refreshing={refreshing}
                        onRefresh={refreshVideos}
                      />
                    }
                  />
                )}
              </View>
              <VideosPlaylist />
              <VideosDownload />
            </PagerView>
          </View>
        </View>
      </View>
    </StyledSafeAreaView>
  );
};

export default Videos;
