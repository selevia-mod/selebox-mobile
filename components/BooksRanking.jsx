import { MaterialCommunityIcons } from "@expo/vector-icons";
import { FlashList } from "@shopify/flash-list";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, RefreshControl, Text, TouchableOpacity, View } from "react-native";
import { useDispatch, useSelector } from "react-redux";
import useAppTheme from "../hooks/useAppTheme";
import useResetOnBlur from "../hooks/useResetOnBlur";
import { BooksRankingService } from "../lib/books-rankings";
import tabNavigationEvents from "../lib/tab-navigation-events";
import { setRanking, setRankingCacheEntry, setRankingHasMore, setRankingOffset } from "../store/reducers/books";
import AnimatedSkeleton, { getRandomSkeletonWidth } from "./AnimatedSkeleton";
import BookRankingCard from "./BookRankingCard";

const LIMIT = 20;
const ESTIMATED_CARD_SIZE = 156;
const ALL_TAG_KEY = "__ALL__";
const RANKING_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

const parseTagSetting = (rawValue) => {
  if (!rawValue) return [];

  try {
    const parsed = typeof rawValue === "string" ? JSON.parse(rawValue) : rawValue;
    if (!Array.isArray(parsed)) return [];

    return parsed.map((tag) => String(tag || "").trim()).filter(Boolean);
  } catch {
    return [];
  }
};

const mergeUniqueTags = (...tagGroups) => {
  const seen = new Set();
  const merged = [];

  tagGroups.flat().forEach((tag) => {
    const normalized = String(tag).toLowerCase();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    merged.push(tag);
  });

  return merged;
};

const hasRankingStats = (item) =>
  item?.totalLikes !== undefined && item?.totalLikes !== null && item?.chaptersTotal !== undefined && item?.chaptersTotal !== null;

const normalizeCacheEntry = (entry = {}) => ({
  items: Array.isArray(entry?.items) ? entry.items : [],
  hasMore: Boolean(entry?.hasMore),
  fetchedAt: Number.isFinite(entry?.fetchedAt) ? entry.fetchedAt : null,
  statsHydratedAt: Number.isFinite(entry?.statsHydratedAt) ? entry.statsHydratedAt : null,
});

const BooksRanking = ({ isActive = false }) => {
  const { theme } = useAppTheme();
  const dispatch = useDispatch();
  const globalSettings = useSelector((state) => state.app?.globalSettings || {});
  const rankingCacheByTag = useSelector((state) => state.books?.rankingCacheByTag || {});

  const [rankings, setRankings] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedTagKey, setSelectedTagKey] = useState(ALL_TAG_KEY);

  useResetOnBlur(setRefreshing, setIsFetchingMore);

  const lastScrollY = useRef(0);
  const navHiddenRef = useRef(false);
  const listRef = useRef(null);
  const isActiveRef = useRef(isActive);
  const rankingsCacheRef = useRef({});
  const requestTokenRef = useRef(0);

  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  useEffect(() => {
    const normalizedCache = Object.fromEntries(
      Object.entries(rankingCacheByTag || {}).map(([tagKey, entry]) => [tagKey, normalizeCacheEntry(entry)]),
    );
    rankingsCacheRef.current = normalizedCache;
  }, [rankingCacheByTag]);

  const rankingBaseTags = useMemo(
    () => mergeUniqueTags(parseTagSetting(globalSettings?.["RANKING_BOOK_TAGS"])),
    [globalSettings?.["RANKING_BOOK_TAGS"]],
  );

  const availableTags = useMemo(
    () => mergeUniqueTags(parseTagSetting(globalSettings?.["BOOKS_CATEGORIES"]), rankingBaseTags),
    [globalSettings?.["BOOKS_CATEGORIES"], rankingBaseTags],
  );

  const tagOptions = useMemo(() => [{ key: ALL_TAG_KEY, label: "All" }, ...availableTags.map((tag) => ({ key: tag, label: tag }))], [availableTags]);

  const selectedTag = useMemo(() => tagOptions.find((tag) => tag.key === selectedTagKey) || tagOptions[0], [selectedTagKey, tagOptions]);

  const selectedFilterTags = useMemo(() => {
    if (selectedTagKey === ALL_TAG_KEY) return rankingBaseTags;
    return [selectedTagKey];
  }, [rankingBaseTags, selectedTagKey]);

  useEffect(() => {
    if (selectedTagKey === ALL_TAG_KEY) return;

    const hasSelectedTag = availableTags.some((tag) => tag === selectedTagKey);
    if (!hasSelectedTag) {
      setSelectedTagKey(ALL_TAG_KEY);
    }
  }, [availableTags, selectedTagKey]);

  const getTagCache = useCallback((tagKey) => normalizeCacheEntry(rankingsCacheRef.current[tagKey]), []);

  const isCacheFresh = useCallback((entry) => {
    const fetchedAt = Number(entry?.fetchedAt || 0);
    if (!fetchedAt) return false;
    return Date.now() - fetchedAt < RANKING_CACHE_TTL_MS;
  }, []);

  const commitTagCache = useCallback(
    (tagKey, items, more, metadata = {}) => {
      const previousEntry = getTagCache(tagKey);
      const nextEntry = {
        items,
        hasMore: Boolean(more),
        fetchedAt: Number.isFinite(metadata?.fetchedAt) ? metadata.fetchedAt : previousEntry.fetchedAt,
        statsHydratedAt: Number.isFinite(metadata?.statsHydratedAt) ? metadata.statsHydratedAt : previousEntry.statsHydratedAt,
      };
      rankingsCacheRef.current[tagKey] = nextEntry;
      dispatch(setRankingCacheEntry({ tagKey, ...nextEntry }));

      if (tagKey === ALL_TAG_KEY) {
        dispatch(setRanking(items));
        dispatch(setRankingOffset(items.length));
        dispatch(setRankingHasMore(Boolean(more)));
      }
    },
    [dispatch, getTagCache],
  );

  const mergeRankingStats = useCallback(
    (tagKey, items = []) => {
      const nextStatsByBookId = new Map();

      items.forEach((item) => {
        const bookId = item?.book?.$id;
        if (!bookId) return;
        nextStatsByBookId.set(bookId, item);
      });

      if (!nextStatsByBookId.size) return;

      const mergeItems = (currentItems = []) =>
        currentItems.map((item) => {
          const bookId = item?.book?.$id;
          const hydratedItem = bookId ? nextStatsByBookId.get(bookId) : null;
          if (!hydratedItem) return item;

          const nextTotalLikes = hydratedItem?.totalLikes ?? item?.totalLikes;
          const nextChaptersTotal = hydratedItem?.chaptersTotal ?? item?.chaptersTotal;

          if (nextTotalLikes === item?.totalLikes && nextChaptersTotal === item?.chaptersTotal) {
            return item;
          }

          return {
            ...item,
            ...(nextTotalLikes !== undefined ? { totalLikes: nextTotalLikes } : {}),
            ...(nextChaptersTotal !== undefined ? { chaptersTotal: nextChaptersTotal } : {}),
          };
        });

      const currentCache = getTagCache(tagKey);
      const mergedCacheItems = mergeItems(currentCache.items);
      commitTagCache(tagKey, mergedCacheItems, currentCache.hasMore, {
        fetchedAt: currentCache.fetchedAt,
        statsHydratedAt: Date.now(),
      });

      if (tagKey === selectedTagKey) {
        setRankings((currentItems) => mergeItems(currentItems));
      }
    },
    [commitTagCache, getTagCache, selectedTagKey],
  );

  const hydrateRankingStats = useCallback(
    async (tagKey, items = []) => {
      if (!items.length) return;
      if (items.every(hasRankingStats)) {
        const currentCache = getTagCache(tagKey);
        if (!currentCache.statsHydratedAt) {
          commitTagCache(tagKey, currentCache.items, currentCache.hasMore, {
            fetchedAt: currentCache.fetchedAt,
            statsHydratedAt: Date.now(),
          });
        }
        return;
      }

      try {
        const hydratedItems = await BooksRankingService.enrichRankingsWithStats(items);
        mergeRankingStats(tagKey, hydratedItems);
      } catch (error) {
        console.error("hydrateRankingStats error:", error);
      }
    },
    [commitTagCache, getTagCache, mergeRankingStats],
  );

  const fetchRankings = useCallback(
    async ({ forceRefresh = false } = {}) => {
      const requestToken = ++requestTokenRef.current;
      const currentTagKey = selectedTagKey;
      const cached = getTagCache(currentTagKey);
      const cachedItems = cached.items || [];
      const hasCachedItems = cachedItems.length > 0;
      const shouldUseCacheOnly = !forceRefresh && hasCachedItems && isCacheFresh(cached);

      if (!forceRefresh && hasCachedItems) {
        if (requestToken !== requestTokenRef.current) return;

        const initialSlice = BooksRankingService.applyCachedStats(cachedItems.slice(0, LIMIT));
        setRankings(initialSlice);
        setOffset(initialSlice.length);
        setHasMore(cachedItems.length > LIMIT || cached.hasMore);
        setIsLoading(false);
        commitTagCache(currentTagKey, cachedItems, cached.hasMore, {
          fetchedAt: cached.fetchedAt,
          statsHydratedAt: cached.statsHydratedAt,
        });

        if (shouldUseCacheOnly) {
          void hydrateRankingStats(currentTagKey, initialSlice);
          return;
        }
      }

      try {
        if (!hasCachedItems || forceRefresh) {
          setIsLoading(true);
          setRankings([]);
          setOffset(0);
          setHasMore(false);
        }

        const { items, hasMore: more } = await BooksRankingService.getCurrentRankingsByTags({
          tags: selectedFilterTags,
          limit: LIMIT,
          offset: 0,
        });

        if (requestToken !== requestTokenRef.current) return;

        const nextItems = BooksRankingService.applyCachedStats(items);
        setRankings(nextItems);
        setOffset(nextItems.length);
        setHasMore(more);
        commitTagCache(currentTagKey, nextItems, more, {
          fetchedAt: Date.now(),
          statsHydratedAt: nextItems.every(hasRankingStats) ? Date.now() : null,
        });

        void hydrateRankingStats(currentTagKey, nextItems);
      } catch (error) {
        console.error("fetchRankings error:", error);
      } finally {
        if (requestToken === requestTokenRef.current) {
          setIsFetchingMore(false);
          setIsLoading(false);
        }
      }
    },
    [commitTagCache, getTagCache, hydrateRankingStats, selectedFilterTags, selectedTagKey],
  );

  useFocusEffect(
    useCallback(() => {
      void fetchRankings();
    }, [fetchRankings]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetchRankings({ forceRefresh: true });
    } finally {
      setRefreshing(false);
    }
  }, [fetchRankings]);

  const fetchMoreRankings = useCallback(async () => {
    const currentTagKey = selectedTagKey;
    const cached = getTagCache(currentTagKey);
    const cachedItems = cached.items || [];

    if (offset < cachedItems.length) {
      const nextSlice = BooksRankingService.applyCachedStats(cachedItems.slice(offset, offset + LIMIT));
      setRankings((prev) => [...prev, ...nextSlice]);
      setOffset((prev) => prev + nextSlice.length);
      void hydrateRankingStats(currentTagKey, nextSlice);
      return;
    }

    if (isFetchingMore) return;
    if (!hasMore) return;
    if (rankings.length >= BooksRankingService.MAX_RESULTS) return;

    setIsFetchingMore(true);
    const requestToken = ++requestTokenRef.current;

    try {
      const { items, hasMore: more } = await BooksRankingService.getCurrentRankingsByTags({
        tags: selectedFilterTags,
        limit: LIMIT,
        offset: cachedItems.length,
      });

      if (requestToken !== requestTokenRef.current) return;

      const existingIds = new Set(cachedItems.map((item) => item?.$id));
      const newItems = items.filter((item) => !existingIds.has(item?.$id));

      if (newItems.length === 0) {
        setHasMore(false);
        commitTagCache(currentTagKey, cachedItems, false);
        return;
      }

      const newItemsWithCachedStats = BooksRankingService.applyCachedStats(newItems);
      const updatedRanking = [...cachedItems, ...newItemsWithCachedStats];

      commitTagCache(currentTagKey, updatedRanking, more, {
        fetchedAt: Date.now(),
        statsHydratedAt: updatedRanking.every(hasRankingStats) ? Date.now() : null,
      });
      setRankings((prev) => [...prev, ...newItemsWithCachedStats]);
      setOffset((prev) => prev + newItemsWithCachedStats.length);
      setHasMore(more);

      void hydrateRankingStats(currentTagKey, newItemsWithCachedStats);
    } catch (error) {
      console.error("fetchMoreRankings error:", error);
    } finally {
      if (requestToken === requestTokenRef.current) {
        setIsFetchingMore(false);
      }
    }
  }, [commitTagCache, getTagCache, hasMore, hydrateRankingStats, isFetchingMore, offset, rankings.length, selectedFilterTags, selectedTagKey]);

  useEffect(() => {
    const handleScrollToTop = ({ tab }) => {
      if (tab !== "books") return;
      if (!isActiveRef.current) return;
      lastScrollY.current = 0;
      listRef.current?.scrollToOffset?.({ offset: 0, animated: true });
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

  const handleScroll = useCallback((event) => {
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
  }, []);

  const renderItem = useCallback(({ item, index }) => <BookRankingCard item={item} rank={index + 1} />, []);

  const renderTagItem = useCallback(
    ({ item }) => {
      const isSelected = item.key === selectedTag?.key;

      return (
        <TouchableOpacity
          onPress={() => {
            if (isSelected) return;
            setSelectedTagKey(item.key);
            listRef.current?.scrollToOffset?.({ offset: 0, animated: true });
          }}
          activeOpacity={0.85}
          className="mr-2 rounded-full px-4 py-2"
          style={{
            backgroundColor: isSelected ? theme.accentPurpleSoft : theme.surfaceMuted,
            borderWidth: 1,
            borderColor: isSelected ? theme.accentPurple : theme.border,
          }}
        >
          <Text className="text-xs font-semibold" style={{ color: isSelected ? theme.accentPurple : theme.textSoft }}>
            {item.label}
          </Text>
        </TouchableOpacity>
      );
    },
    [selectedTag?.key, theme.accentPurple, theme.accentPurpleSoft, theme.border, theme.surfaceMuted, theme.textSoft],
  );

  const keyExtractor = useCallback((item, index) => `${item?.$id ?? "rank"}-${index}`, []);

  const renderSkeletonItem = (_, index) => (
    <View
      key={`skeleton-${index}`}
      className="mb-3 flex-row items-center rounded-2xl py-2.5"
      style={{ backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}
    >
      <AnimatedSkeleton style={{ width: 90, height: 120, borderRadius: 12 }} />

      <View className="ml-5 flex-1">
        <AnimatedSkeleton style={{ width: getRandomSkeletonWidth(), height: 16, marginBottom: 8 }} />
        <AnimatedSkeleton style={{ width: getRandomSkeletonWidth(), height: 12, marginBottom: 8 }} />
        <AnimatedSkeleton style={{ width: getRandomSkeletonWidth(), height: 10, marginBottom: 8 }} />
        <AnimatedSkeleton style={{ width: 100, height: 10 }} />
      </View>
    </View>
  );

  return (
    <View className="flex-1">
      <View className="pb-2 pt-1">
        <FlatList
          removeClippedSubviews={false}
          horizontal
          data={tagOptions}
          keyExtractor={(item) => `ranking-tag-${item.key}`}
          renderItem={renderTagItem}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingRight: 8 }}
        />
      </View>
      {isLoading ? (
        <View className="px-4 pt-3">{Array.from({ length: 6 }).map(renderSkeletonItem)}</View>
      ) : (
        <FlashList
          data={rankings}
          estimatedItemSize={ESTIMATED_CARD_SIZE}
          refreshing={refreshing}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={{ paddingBottom: 50 }}
          showsVerticalScrollIndicator={false}
          ref={listRef}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          onEndReached={fetchMoreRankings}
          onEndReachedThreshold={0.5}
          ListFooterComponent={isFetchingMore ? <View className="px-4 pt-3">{Array.from({ length: 1 }).map(renderSkeletonItem)}</View> : null}
          ListEmptyComponent={
            <View className="flex-1 items-center justify-center px-4 py-12">
              <MaterialCommunityIcons name="trophy-outline" size={48} color={theme.textSubtle} />
              <Text className="mt-4 text-lg font-semibold" style={{ color: theme.text }}>
                No Rankings Yet
              </Text>
              <Text className="mt-2 text-center text-sm" style={{ color: theme.textSoft }}>
                The rankings will appear here once books start gaining reads this month.
              </Text>
            </View>
          }
          refreshControl={
            <RefreshControl
              tintColor={theme.primary}
              titleColor={theme.primary}
              progressBackgroundColor={theme.surface}
              refreshing={refreshing}
              onRefresh={onRefresh}
            />
          }
        />
      )}
    </View>
  );
};

export default BooksRanking;
