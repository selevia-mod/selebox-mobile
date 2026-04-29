import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, RefreshControl, ScrollView, Text, TouchableOpacity, View, useWindowDimensions } from "react-native";
import FastImage from "react-native-fast-image";
import { useSelector } from "react-redux";
import useAppTheme from "../hooks/useAppTheme";
import { BookReadService } from "../lib/book-reads";
import { BookService } from "../lib/books";
import { BooksRankingService } from "../lib/books-rankings";
import FormatNumber from "../lib/format-number";
import tabNavigationEvents from "../lib/tab-navigation-events";

const DISCOVER_TAB_OPTIONS = [
  { key: "popular", label: "Popular" },
  { key: "trending", label: "Trending" },
  { key: "new-rising", label: "New & Rising" },
  { key: "readers-choice", label: "Readers' Choice" },
];

const GRID_ITEMS_PER_ROW = 5;
const GRID_LIMIT = GRID_ITEMS_PER_ROW * 3;
const PICKS_LIMIT = 10;
const DISCOVER_TAB_MIN_ITEMS = GRID_LIMIT;
const ALL_TAG_KEY = "__ALL__";
const PICKS_BOOK_SERVICE = new BookService();

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
    const normalized = tag.toLowerCase();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    merged.push(tag);
  });

  return merged;
};

const resolveBook = (item) => item?.book || item || null;
const resolveBookId = (item) => resolveBook(item)?.$id || null;

const dedupeByBookId = (items = []) => {
  const seen = new Set();

  return items.filter((item) => {
    const bookId = resolveBookId(item);
    if (!bookId || seen.has(bookId)) return false;
    seen.add(bookId);
    return true;
  });
};

const mergeUniqueByBookId = (primaryItems = [], fallbackItems = [], limit = 30) => {
  const merged = [];
  const seen = new Set();

  const pushIfUnique = (item) => {
    const bookId = resolveBookId(item);
    if (!bookId || seen.has(bookId)) return;
    seen.add(bookId);
    merged.push(item);
  };

  primaryItems.forEach(pushIfUnique);
  if (merged.length >= limit) return merged.slice(0, limit);

  fallbackItems.forEach((item) => {
    if (merged.length >= limit) return;
    pushIfUnique(item);
  });

  return merged.slice(0, limit);
};

const shuffleItems = (items = []) => {
  const shuffled = [...items];

  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const randomIndex = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[i]];
  }

  return shuffled;
};

const getStatusMeta = (statusValue, theme) => {
  const normalized = String(statusValue || "").toLowerCase();

  if (normalized === "ongoing") {
    return {
      label: "Ongoing",
      icon: "clock-outline",
      iconColor: theme.accentAmber,
      textColor: theme.accentAmber,
    };
  }

  if (normalized === "completed") {
    return {
      label: "Completed",
      icon: "check-circle-outline",
      iconColor: theme.accentGreen,
      textColor: theme.accentGreen,
    };
  }

  return {
    label: statusValue || "Published",
    icon: "book-outline",
    iconColor: theme.iconMuted,
    textColor: theme.textSoft,
  };
};

const chunkIntoRows = (items = [], chunkSize = 2) => {
  const chunks = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
};

const toTimestamp = (...values) => {
  for (const value of values) {
    if (!value) continue;
    const time = new Date(value).getTime();
    if (!Number.isNaN(time) && Number.isFinite(time)) return time;
  }
  return 0;
};

const getAgeInHours = (...values) => {
  const timestamp = toTimestamp(...values);
  if (!timestamp) return Number.POSITIVE_INFINITY;
  return Math.max(0, (Date.now() - timestamp) / (1000 * 60 * 60));
};

const log1pSafe = (value) => Math.log1p(Math.max(0, Number(value) || 0));

const stableHash = (input = "") => {
  let hash = 0;
  const str = String(input);
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash;
};

const toFiniteNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const resolveReadsCount = (item, rankingStats = null) =>
  toFiniteNumber(
    item?.totalReads ?? item?.monthlyReads ?? item?.book?.totalReads ?? item?.book?.reads ?? item?.book?.monthlyReads ?? rankingStats?.totalReads,
    0,
  );

const resolveLikesCount = (item, rankingStats = null) =>
  toFiniteNumber(item?.totalLikes ?? item?.book?.totalLikes ?? item?.book?.likes ?? rankingStats?.totalLikes, 0);

const resolveAverageRating = (item, rankingStats = null) =>
  toFiniteNumber(item?.averageRating ?? item?.book?.averageRating ?? item?.book?.rating ?? rankingStats?.averageRating, 0);

const resolveChaptersTotal = (item, rankingStats = null) =>
  toFiniteNumber(item?.chaptersTotal ?? item?.book?.chaptersTotal ?? rankingStats?.chaptersTotal, 0);

const resolveInitialPickStats = (item) => ({
  totalReads: resolveReadsCount(item),
  chaptersTotal: resolveChaptersTotal(item),
});

const selectDiverseFromScored = ({ scored = [], limit = 30, excludedBookIds = new Set(), maxPerAuthor = 2, maxPerTag = 4 }) => {
  const selected = [];
  const seenBookIds = new Set(excludedBookIds);
  const authorCounts = new Map();
  const tagCounts = new Map();

  const tryTake = (entry, { relaxAuthor = false, relaxTag = false } = {}) => {
    if (!entry?.bookId || seenBookIds.has(entry.bookId)) return false;
    if (selected.length >= limit) return false;

    const authorKey = entry.authorKey || "unknown-author";
    const tagKey = entry.primaryTag || "untagged";
    const currentAuthorCount = authorCounts.get(authorKey) || 0;
    const currentTagCount = tagCounts.get(tagKey) || 0;

    if (!relaxAuthor && currentAuthorCount >= maxPerAuthor) return false;
    if (!relaxTag && currentTagCount >= maxPerTag) return false;

    seenBookIds.add(entry.bookId);
    selected.push(entry.item);
    authorCounts.set(authorKey, currentAuthorCount + 1);
    tagCounts.set(tagKey, currentTagCount + 1);
    return true;
  };

  scored.forEach((entry) => tryTake(entry));
  if (selected.length < limit) scored.forEach((entry) => tryTake(entry, { relaxTag: true }));
  if (selected.length < limit) scored.forEach((entry) => tryTake(entry, { relaxTag: true, relaxAuthor: true }));

  return selected.slice(0, limit);
};

const DiscoverPickCard = memo(({ item, onPressBook }) => {
  const { theme } = useAppTheme();
  const book = item?.book;
  const [stats, setStats] = useState(() => resolveInitialPickStats(item));

  useEffect(() => {
    setStats(resolveInitialPickStats(item));
  }, [item]);

  useEffect(() => {
    let cancelled = false;
    const bookId = book?.$id;
    if (!bookId) return;

    const fetchBookInfoStats = async () => {
      try {
        const [chaptersData, bookRead] = await Promise.all([
          PICKS_BOOK_SERVICE.fetchBookChapters({ bookId, status: "Publish", limit: 5 }),
          BookReadService.fetchBookRead({ bookId }),
        ]);

        if (cancelled) return;

        setStats({
          totalReads: toFiniteNumber(bookRead?.totalReads ?? bookRead?.reads ?? bookRead?.monthlyReads, 0),
          chaptersTotal: toFiniteNumber(chaptersData?.total ?? chaptersData?.documents?.length, 0),
        });
      } catch (error) {
        if (__DEV__) {
          console.log("DiscoverPickCard fetchBookInfoStats error", error);
        }
      }
    };

    void fetchBookInfoStats();

    return () => {
      cancelled = true;
    };
  }, [book?.$id]);

  if (!book?.$id) return null;

  const statusMeta = getStatusMeta(book?.status, theme);

  return (
    <TouchableOpacity
      onPress={() => onPressBook(book.$id)}
      activeOpacity={0.92}
      className="mb-3 rounded-xl p-2.5"
      style={{ backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}
    >
      <View className="flex-row">
        <FastImage
          source={book?.thumbnail ? { uri: book.thumbnail, priority: FastImage.priority.high } : null}
          style={{
            height: 118,
            width: 84,
            borderRadius: 10,
            backgroundColor: theme.surfaceMuted,
          }}
          resizeMode={FastImage.resizeMode.cover}
        />
        <View className="ml-3 flex-1">
          <Text className="text-xl font-bold" style={{ color: theme.text }} numberOfLines={2}>
            {book?.title || "Untitled"}
          </Text>
          <Text className="mt-1.5 text-sm leading-5" style={{ color: theme.textSoft }} numberOfLines={3}>
            {book?.synopsis || "No synopsis available yet."}
          </Text>
        </View>
      </View>

      <View className="mt-3 flex-row items-center justify-between">
        <View className="flex-row items-center">
          <Ionicons name="flame" size={16} color={theme.accentAmber} />
          <Text className="ml-1.5 text-base font-medium" style={{ color: theme.accentPurple }}>
            {FormatNumber(stats?.totalReads || 0)} Views
          </Text>
        </View>
        <View className="flex-row items-center">
          <MaterialCommunityIcons name={statusMeta.icon} size={17} color={statusMeta.iconColor} />
          <Text className="ml-1.5 text-base" style={{ color: statusMeta.textColor }}>
            {statusMeta.label}
          </Text>
        </View>
        <View className="flex-row items-center">
          <Ionicons name="list-outline" size={16} color={theme.iconMuted} />
          <Text className="ml-1.5 text-base" style={{ color: theme.textMuted }}>
            {stats?.chaptersTotal || 0} parts
          </Text>
        </View>
      </View>
    </TouchableOpacity>
  );
});

const BooksDiscover = ({ isActive = false, onRefresh, refreshing = false }) => {
  const { theme } = useAppTheme();
  const { width: windowWidth } = useWindowDimensions();
  const { globalSettings } = useSelector((state) => state.app || {});
  const {
    weeklyFeatured = [],
    freshRead = [],
    completedExcellent = [],
    recentlyUploaded = [],
    ranking: rankingFromStore = [],
    rankingCacheByTag = {},
  } = useSelector((state) => state.books || {});
  const persistedRanking = useMemo(() => {
    const allRankingCache = rankingCacheByTag?.[ALL_TAG_KEY]?.items;
    if (Array.isArray(allRankingCache) && allRankingCache.length > 0) {
      return allRankingCache;
    }
    return rankingFromStore;
  }, [rankingCacheByTag, rankingFromStore]);

  const [selectedTabKey, setSelectedTabKey] = useState(DISCOVER_TAB_OPTIONS[0].key);
  const [discoverRankings, setDiscoverRankings] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const listRef = useRef(null);
  const lastScrollY = useRef(0);
  const navHiddenRef = useRef(false);
  const isActiveRef = useRef(isActive);

  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  const rankingBaseTags = useMemo(
    () => mergeUniqueTags(parseTagSetting(globalSettings?.["RANKING_BOOK_TAGS"])),
    [globalSettings?.["RANKING_BOOK_TAGS"]],
  );
  const discoverTags = useMemo(
    () => mergeUniqueTags(parseTagSetting(globalSettings?.["BOOKS_CATEGORIES"]), rankingBaseTags).filter((tag) => tag !== ALL_TAG_KEY),
    [globalSettings?.["BOOKS_CATEGORIES"], rankingBaseTags],
  );

  useEffect(() => {
    if (discoverRankings.length > 0) return;
    if (!persistedRanking?.length) return;
    setDiscoverRankings(persistedRanking);
  }, [discoverRankings.length, persistedRanking]);

  const fetchDiscoverRankings = useCallback(
    async ({ forceRefresh = false } = {}) => {
      if (!forceRefresh && discoverRankings.length > 0) return;

      try {
        setIsLoading(true);
        const { items } = await BooksRankingService.getCurrentRankingsByTags({
          tags: discoverTags,
          limit: 30,
          offset: 0,
        });

        setDiscoverRankings(Array.isArray(items) ? items : []);
      } catch (error) {
        console.error("fetchDiscoverRankings error:", error);
      } finally {
        setIsLoading(false);
      }
    },
    [discoverRankings.length, discoverTags],
  );

  useEffect(() => {
    if (!isActive) return;
    fetchDiscoverRankings();
  }, [fetchDiscoverRankings, isActive]);

  const refreshDiscover = useCallback(async () => {
    setIsRefreshing(true);
    try {
      if (typeof onRefresh === "function") {
        await onRefresh();
      }
      await fetchDiscoverRankings({ forceRefresh: true });
    } finally {
      setIsRefreshing(false);
    }
  }, [fetchDiscoverRankings, onRefresh]);

  const statsByBookId = useMemo(() => {
    const map = new Map();

    discoverRankings.forEach((entry) => {
      const bookId = resolveBookId(entry);
      if (!bookId) return;
      map.set(bookId, {
        totalReads: resolveReadsCount(entry),
        totalLikes: resolveLikesCount(entry),
        averageRating: resolveAverageRating(entry),
        chaptersTotal: resolveChaptersTotal(entry),
      });
    });

    return map;
  }, [discoverRankings]);

  const toDiscoverCard = useCallback(
    (item) => {
      const book = resolveBook(item);
      if (!book?.$id) return null;

      const stats = statsByBookId.get(book.$id) || {};
      return {
        id: item?.$id || book.$id,
        book,
        totalReads: resolveReadsCount(item, stats),
        totalLikes: resolveLikesCount(item, stats),
        averageRating: resolveAverageRating(item, stats),
        chaptersTotal: resolveChaptersTotal(item, stats),
      };
    },
    [statsByBookId],
  );

  const discoverCandidatePool = useMemo(() => {
    return dedupeByBookId([...discoverRankings, ...freshRead, ...recentlyUploaded, ...weeklyFeatured, ...completedExcellent]);
  }, [completedExcellent, discoverRankings, freshRead, recentlyUploaded, weeklyFeatured]);

  const getBookMetrics = useCallback(
    (item) => {
      const book = resolveBook(item);
      const bookId = book?.$id;
      const rankingStats = bookId ? statsByBookId.get(bookId) : null;

      const reads = resolveReadsCount(item, rankingStats);
      const likes = resolveLikesCount(item, rankingStats);
      const rating = resolveAverageRating(item, rankingStats);
      const chaptersTotal = resolveChaptersTotal(item, rankingStats);
      const recencyHours = getAgeInHours(book?.$createdAt, book?.$updatedAt, item?.$createdAt, item?.$updatedAt);

      return {
        reads,
        likes,
        rating,
        chaptersTotal,
        recencyHours,
      };
    },
    [statsByBookId],
  );

  const scoredCandidates = useMemo(() => {
    return discoverCandidatePool
      .map((item) => {
        const book = resolveBook(item);
        if (!book?.$id) return null;

        const metrics = getBookMetrics(item);
        const uploader = book?.uploader;
        const authorKey = String(uploader?.$id || uploader?.username || uploader || book?.author || "unknown-author").toLowerCase();
        const primaryTag = String(Array.isArray(book?.tags) && book.tags[0] ? book.tags[0] : "untagged").toLowerCase();
        const status = String(book?.status || "").toLowerCase();

        return {
          item,
          bookId: book.$id,
          authorKey,
          primaryTag,
          status,
          metrics,
        };
      })
      .filter(Boolean);
  }, [discoverCandidatePool, getBookMetrics]);

  const discoverSources = useMemo(() => {
    const readQualifiedCandidates = scoredCandidates.filter((entry) => entry.metrics.reads > 0);

    if (!readQualifiedCandidates.length) {
      return {
        popular: [],
        trending: [],
        "new-rising": [],
        "readers-choice": [],
      };
    }

    const withScore = (entries, tabKey, scorer) =>
      entries
        .map((entry) => {
          const score = scorer(entry);
          const jitter = (stableHash(`${tabKey}:${entry.bookId}`) % 1000) / 1_000_000;
          return { ...entry, score: score + jitter };
        })
        .sort((a, b) => b.score - a.score);

    const popularScored = withScore(readQualifiedCandidates, "popular", (entry) => {
      const { reads, likes, rating, chaptersTotal, recencyHours } = entry.metrics;
      const recencyLift = 1 / (1 + recencyHours / (24 * 21));
      return log1pSafe(reads) * 1.55 + log1pSafe(likes) * 1.85 + rating * 0.8 + log1pSafe(chaptersTotal) * 0.22 + recencyLift * 0.35;
    });

    const trendingScored = withScore(readQualifiedCandidates, "trending", (entry) => {
      const { reads, likes, rating, recencyHours } = entry.metrics;
      const ageDays = Math.max(0.25, recencyHours / 24);
      const velocity = (likes * 2.6 + reads * 0.42) / Math.sqrt(ageDays + 1.5);
      const recencyPulse = 1 / (1 + recencyHours / 36);
      const ongoingBoost = entry.status === "ongoing" ? 0.4 : 0;
      return velocity * 1.45 + recencyPulse * 2 + log1pSafe(reads) * 0.45 + rating * 0.45 + ongoingBoost;
    });

    const newAndRisingPool = readQualifiedCandidates.filter((entry) => {
      const ageHours = entry.metrics.recencyHours;
      return ageHours <= 24 * 180 || entry.metrics.reads <= 15000;
    });

    const risingScored = withScore(newAndRisingPool, "new-rising", (entry) => {
      const { reads, likes, rating, recencyHours } = entry.metrics;
      const freshness = Math.max(0, 1 - recencyHours / (24 * 120));
      const underdogBoost = 1 / (1 + log1pSafe(reads) * 0.85);
      const traction = (log1pSafe(likes) * 1.25 + log1pSafe(reads) * 0.8 + rating * 0.55) * (1 + underdogBoost);
      const ongoingBoost = entry.status === "ongoing" ? 0.35 : 0;
      return freshness * 4 + traction + ongoingBoost;
    });

    const readersChoiceScored = withScore(readQualifiedCandidates, "readers-choice", (entry) => {
      const { reads, likes, rating } = entry.metrics;
      const likeRate = likes / Math.max(1, reads);
      const completedBoost = entry.status === "completed" ? 0.35 : 0;
      return rating * 2.45 + likeRate * 145 + log1pSafe(likes) * 0.95 + log1pSafe(reads) * 0.3 + completedBoost;
    });

    const popularList = selectDiverseFromScored({
      scored: popularScored,
      limit: 30,
      maxPerAuthor: 2,
      maxPerTag: 4,
    });
    const popularTopIds = new Set(
      popularList
        .slice(0, GRID_LIMIT)
        .map((item) => resolveBookId(item))
        .filter(Boolean),
    );

    const trendingList = selectDiverseFromScored({
      scored: trendingScored,
      limit: 30,
      excludedBookIds: popularTopIds,
      maxPerAuthor: 1,
      maxPerTag: 3,
    });
    const trendingTopIds = new Set(
      trendingList
        .slice(0, GRID_LIMIT)
        .map((item) => resolveBookId(item))
        .filter(Boolean),
    );

    const newRisingExcluded = new Set([...popularTopIds, ...trendingTopIds]);
    const newRisingPrimaryList = selectDiverseFromScored({
      scored: risingScored,
      limit: 30,
      excludedBookIds: newRisingExcluded,
      maxPerAuthor: 1,
      maxPerTag: 3,
    });
    const newRisingList =
      newRisingPrimaryList.length >= DISCOVER_TAB_MIN_ITEMS
        ? newRisingPrimaryList
        : mergeUniqueByBookId(
            newRisingPrimaryList,
            selectDiverseFromScored({
              scored: risingScored,
              limit: 30,
              excludedBookIds: new Set(newRisingPrimaryList.map((item) => resolveBookId(item)).filter(Boolean)),
              maxPerAuthor: 2,
              maxPerTag: 4,
            }),
            30,
          );
    const newRisingTopIds = new Set(
      newRisingList
        .slice(0, GRID_LIMIT)
        .map((item) => resolveBookId(item))
        .filter(Boolean),
    );

    const readersChoiceExcluded = new Set([...popularTopIds, ...trendingTopIds, ...newRisingTopIds]);
    const readersChoicePrimaryList = selectDiverseFromScored({
      scored: readersChoiceScored,
      limit: 30,
      excludedBookIds: readersChoiceExcluded,
      maxPerAuthor: 2,
      maxPerTag: 4,
    });
    const readersChoiceList =
      readersChoicePrimaryList.length >= DISCOVER_TAB_MIN_ITEMS
        ? readersChoicePrimaryList
        : mergeUniqueByBookId(
            readersChoicePrimaryList,
            selectDiverseFromScored({
              scored: readersChoiceScored,
              limit: 30,
              excludedBookIds: new Set(readersChoicePrimaryList.map((item) => resolveBookId(item)).filter(Boolean)),
              maxPerAuthor: 2,
              maxPerTag: 4,
            }),
            30,
          );

    return {
      popular: popularList,
      trending: trendingList,
      "new-rising": newRisingList,
      "readers-choice": readersChoiceList,
    };
  }, [completedExcellent, discoverRankings, freshRead, recentlyUploaded, scoredCandidates]);

  const selectedDiscoverItems = useMemo(() => {
    const source = discoverSources[selectedTabKey] || [];

    return source.map(toDiscoverCard).filter((item) => {
      if (!item) return false;
      return Number(item.totalReads) > 0;
    });
  }, [discoverSources, selectedTabKey, toDiscoverCard]);

  const gridItems = useMemo(() => selectedDiscoverItems.slice(0, GRID_LIMIT), [selectedDiscoverItems]);
  const gridRows = useMemo(() => chunkIntoRows(gridItems, GRID_ITEMS_PER_ROW), [gridItems]);
  const gridCardWidth = useMemo(() => Math.max(128, Math.floor(windowWidth / 2.3)), [windowWidth]);
  const gridCardHeight = useMemo(() => Math.max(160, Math.min(188, Math.floor(gridCardWidth * 1.02))), [gridCardWidth]);
  const gridBookIds = useMemo(() => new Set(gridItems.map((item) => item?.book?.$id).filter(Boolean)), [gridItems]);

  const picksForYouSource = useMemo(() => {
    const tabSource = dedupeByBookId(discoverSources[selectedTabKey] || []);
    const fallbackSource = dedupeByBookId([...weeklyFeatured, ...freshRead, ...completedExcellent, ...recentlyUploaded, ...discoverRankings]);
    const combinedCandidates = mergeUniqueByBookId(tabSource, fallbackSource, 120);
    const nonDuplicateCandidates = combinedCandidates.filter((item) => !gridBookIds.has(resolveBookId(item)));

    const randomizedCandidates = shuffleItems(nonDuplicateCandidates.length > 0 ? nonDuplicateCandidates : combinedCandidates);
    return randomizedCandidates.slice(0, PICKS_LIMIT);
  }, [completedExcellent, discoverRankings, discoverSources, freshRead, gridBookIds, recentlyUploaded, selectedTabKey, weeklyFeatured]);

  const picksForYou = useMemo(() => {
    return picksForYouSource.map(toDiscoverCard).filter(Boolean);
  }, [picksForYouSource, toDiscoverCard]);

  const handlePressBook = (bookId) => {
    if (!bookId) return;
    router.push({
      pathname: "book-info",
      params: {
        bookId,
      },
    });
  };

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

  const renderDiscoverGridCard = (cardItem) => {
    const book = cardItem?.book;
    if (!book?.$id) return null;

    const safeTags = Array.isArray(book?.tags) ? book.tags.filter(Boolean).slice(0, 3) : [];
    const statusMeta = getStatusMeta(book?.status, theme);

    return (
      <TouchableOpacity
        key={cardItem.id}
        onPress={() => handlePressBook(book.$id)}
        activeOpacity={0.9}
        className="mr-2 overflow-hidden rounded-xl"
        style={{ width: gridCardWidth, height: gridCardHeight, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}
      >
        <View className="relative h-full flex-row">
          <FastImage
            source={book?.thumbnail ? { uri: book.thumbnail, priority: FastImage.priority.high } : null}
            style={{
              position: "absolute",
              top: 8,
              bottom: 8,
              left: 8,
              width: 74,
              borderRadius: 8,
              backgroundColor: theme.surfaceMuted,
            }}
            resizeMode={FastImage.resizeMode.cover}
          />
          <View className="h-full flex-1 px-2 py-2 space-y-2" style={{ paddingLeft: 90 }}>
            <View>
              <Text className="text-[13px] font-bold" style={{ color: theme.text }} numberOfLines={2}>
                {book?.title || "Untitled"}
              </Text>
              <Text className="mt-0.5 text-[11px]" style={{ color: theme.textSoft }} numberOfLines={1}>
                {book?.uploader?.username}
              </Text>
            </View>

            <View>
              <View className="mt-1 flex-row items-center">
                <Ionicons name="flame" size={12} color={theme.accentAmber} />
                <Text className="ml-1 text-[11px] font-medium" style={{ color: theme.accentPurple }}>
                  {FormatNumber(cardItem?.totalReads || 0)} Views
                </Text>
              </View>

              <View className="mt-1 flex-row items-center">
                <MaterialCommunityIcons name={statusMeta.icon} size={13} color={statusMeta.iconColor} />
                <Text className="ml-1 text-[11px]" style={{ color: statusMeta.textColor }}>
                  {statusMeta.label}
                </Text>
              </View>
            </View>
            <View>
              <View className="my-1 border-t" style={{ borderColor: theme.divider }} />

              {safeTags.length > 0 ? (
                safeTags.map((tag, index) => (
                  <Text key={`${cardItem.id}-tag-${index}`} className="text-[11px] leading-4" style={{ color: theme.textSoft }} numberOfLines={1}>
                    {tag}
                  </Text>
                ))
              ) : (
                <Text className="text-[11px] leading-4" style={{ color: theme.textSubtle }} numberOfLines={1}>
                  General
                </Text>
              )}
            </View>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  const renderPickCard = ({ item }) => <DiscoverPickCard item={item} onPressBook={handlePressBook} />;

  const headerComponent = (
    <View className="pb-3">
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingVertical: 6 }}>
        {DISCOVER_TAB_OPTIONS.map((tab) => {
          const isSelected = tab.key === selectedTabKey;
          return (
            <TouchableOpacity
              key={tab.key}
              onPress={() => setSelectedTabKey(tab.key)}
              activeOpacity={0.85}
              className="mr-5 border-b-2 pb-1"
              style={{ borderColor: isSelected ? theme.accentPurple : "transparent" }}
            >
              <Text className={`text-base ${isSelected ? "font-semibold" : ""}`} style={{ color: isSelected ? theme.text : theme.textSoft }}>
                {tab.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {isLoading && selectedDiscoverItems.length === 0 ? (
        <View className="items-center py-6">
          <ActivityIndicator size="small" color={theme.primary} />
        </View>
      ) : null}

      {!isLoading && gridItems.length === 0 ? (
        <View className="items-center py-8">
          <MaterialCommunityIcons name="book-open-page-variant" size={42} color={theme.textSubtle} />
          <Text className="mt-3 text-base font-semibold" style={{ color: theme.text }}>
            No books available
          </Text>
        </View>
      ) : (
        <View className="mt-1">
          {gridRows.map((row, rowIndex) => (
            <ScrollView
              key={`discover-row-${rowIndex}`}
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingRight: 8 }}
              className="mb-2"
            >
              {row.map((rowItem) => renderDiscoverGridCard(rowItem))}
            </ScrollView>
          ))}
        </View>
      )}

      <Text className="mt-3 text-2xl font-bold" style={{ color: theme.text }}>
        Picks for you
      </Text>
    </View>
  );

  return (
    <View className="flex-1">
      <FlatList
        removeClippedSubviews={false}
        ref={listRef}
        data={picksForYou}
        keyExtractor={(item, index) => item?.id || item?.book?.$id || `pick-${index}`}
        renderItem={renderPickCard}
        ListHeaderComponent={headerComponent}
        ListEmptyComponent={
          isLoading ? null : (
            <View className="items-center py-8">
              <MaterialCommunityIcons name="book-open-page-variant" size={42} color={theme.textSubtle} />
              <Text className="mt-3 text-base font-semibold" style={{ color: theme.text }}>
                No picks available yet
              </Text>
            </View>
          )
        }
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 56 }}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        refreshControl={
          <RefreshControl
            tintColor={theme.primary}
            titleColor={theme.primary}
            progressBackgroundColor={theme.surface}
            refreshing={Boolean(refreshing || isRefreshing)}
            onRefresh={refreshDiscover}
          />
        }
      />
    </View>
  );
};

export default memo(BooksDiscover);
