import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, RefreshControl, ScrollView, Text, TouchableOpacity, View, useWindowDimensions } from "react-native";
import FastImage from "react-native-fast-image";
import { useSelector } from "react-redux";
import useAppTheme from "../hooks/useAppTheme";
import { BookReadService } from "../lib/book-reads";
import { BookService, hydrateDiscoverStats } from "../lib/books";
import { BooksRankingService } from "../lib/books-rankings";
import FormatNumber from "../lib/utils/format-number";
import tabNavigationEvents from "../lib/tab-navigation-events";
import UserRoleBadgeIcons from "./UserRoleBadgeIcons";

const DISCOVER_TAB_OPTIONS = [
  { key: "popular", label: "Popular" },
  { key: "trending", label: "Trending" },
  { key: "new-rising", label: "New & Rising" },
  { key: "readers-choice", label: "Readers' Choice" },
  // Hidden Gem rewards books with a strong like-rate but a small reader base — the kind of
  // story that's clearly resonating with the few people who found it. Daily Picks is a
  // mixed engagement+freshness+quality lens that rotates each day so the tab feels alive.
  { key: "hidden-gem", label: "Hidden Gem" },
  { key: "daily-picks", label: "Daily Picks" },
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
  // Track image load failures so we can swap to a placeholder when the URL is dead
  // (deleted storage file, expired preview, network failure). Reset on URL change.
  const [thumbnailFailed, setThumbnailFailed] = useState(false);

  useEffect(() => {
    setStats(resolveInitialPickStats(item));
  }, [item]);

  useEffect(() => {
    setThumbnailFailed(false);
  }, [book?.thumbnail]);

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
        {book?.thumbnail && !thumbnailFailed ? (
          <FastImage
            source={{ uri: book.thumbnail, priority: FastImage.priority.normal }}
            style={{
              height: 118,
              width: 84,
              borderRadius: 10,
              backgroundColor: theme.surfaceMuted,
            }}
            resizeMode={FastImage.resizeMode.cover}
            onError={() => setThumbnailFailed(true)}
          />
        ) : (
          <View
            style={{
              height: 118,
              width: 84,
              borderRadius: 10,
              backgroundColor: theme.surfaceMuted,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Ionicons name="book-outline" size={28} color={theme.iconMuted} />
          </View>
        )}
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

// Grid card extracted as a memoized component (was an inline render fn in BooksDiscover).
//
// Layout (matches the high-end iOS reference):
//   ┌──────────┬──────────────────────────┐
//   │          │  Title (2 lines, 15pt)   │
//   │  Cover   │  Author + role badge     │
//   │  fills   │                          │
//   │  full    │  🔥 1.6K Views           │
//   │  card    │  ✓ Completed             │
//   │  height  │  ─────────────────────   │
//   │          │  Tag 1                   │
//   │          │  Tag 2                   │
//   │          │  Tag 3                   │
//   └──────────┴──────────────────────────┘
//
// Why this shape (vs the previous 88×132 absolute-positioned cover inside
// a 156-tall card):
//
//   * On narrow phones the old layout cramped the right column to ~72dp of
//     usable text width — titles wrapped mid-word, "Views" and "Completed"
//     ran off the edge. iOS happened to render larger so it fit; Android
//     low/mid devices clipped.
//   * Cover now fills the full card height (~32% width) and the right
//     column gets the rest, with comfortable padding. Title scales up
//     to 15pt, status / views / tags get one row each with breathing room.
//   * Card aspect goes from ~0.78:1 (wide-short) to ~1:1.45 (tall-portrait),
//     which is also closer to the natural 2:3 book-cover aspect.
//
// The cover image is `resizeMode: cover` — a 2:3 source filling a
// taller-than-2:3 slot will crop top/bottom. That's intentional: it
// matches how Wattpad/Inkitt render full-bleed covers in the same shape.
const DiscoverGridCard = memo(({ cardItem, cardWidth, cardHeight, onPressBook }) => {
  const { theme } = useAppTheme();
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const book = cardItem?.book;

  useEffect(() => {
    setThumbnailFailed(false);
  }, [book?.thumbnail]);

  if (!book?.$id) return null;

  const safeTags = Array.isArray(book?.tags) ? book.tags.filter(Boolean).slice(0, 3) : [];
  const statusMeta = getStatusMeta(book?.status, theme);
  // Cover takes ~33% of card width. On a 184dp card that's ~60dp, on a
  // 200dp card ~66dp — proportional to card size so narrow and wide
  // phones both leave the right column with meaningful text room
  // (cardWidth - coverWidth - 24dp padding).
  const coverWidth = Math.floor(cardWidth * 0.33);

  return (
    <TouchableOpacity
      onPress={() => onPressBook(book.$id)}
      activeOpacity={0.9}
      className="mr-2 flex-row overflow-hidden rounded-xl"
      style={{ width: cardWidth, height: cardHeight, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}
    >
      {/* Cover — full card height, fixed cover-width on the left. */}
      {book?.thumbnail && !thumbnailFailed ? (
        <FastImage
          source={{ uri: book.thumbnail, priority: FastImage.priority.normal }}
          style={{
            width: coverWidth,
            height: cardHeight,
            backgroundColor: theme.surfaceMuted,
          }}
          resizeMode={FastImage.resizeMode.cover}
          onError={() => setThumbnailFailed(true)}
        />
      ) : (
        <View
          style={{
            width: coverWidth,
            height: cardHeight,
            backgroundColor: theme.surfaceMuted,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Ionicons name="book-outline" size={Math.max(28, Math.floor(coverWidth * 0.4))} color={theme.iconMuted} />
        </View>
      )}

      {/* Right column — title + author block on top, stats in the middle,
          tags pinned to the bottom. justify-between distributes the
          three so the card never has dead vertical space. */}
      <View className="flex-1 justify-between px-3 py-3">
        <View>
          <Text className="text-[15px] font-bold leading-[19px]" style={{ color: theme.text }} numberOfLines={2}>
            {book?.title || "Untitled"}
          </Text>
          <View className="mt-1 flex-row items-center">
            <Text className="text-[12px]" style={{ color: theme.textSoft }} numberOfLines={1}>
              {book?.uploader?.username}
            </Text>
            <UserRoleBadgeIcons user={book?.uploader} size={11} />
          </View>
        </View>

        <View>
          <View className="flex-row items-center">
            <Ionicons name="flame" size={14} color={theme.accentAmber} />
            <Text className="ml-1.5 text-[12px] font-medium" style={{ color: theme.accentPurple }} numberOfLines={1}>
              {FormatNumber(cardItem?.totalReads || 0)} Views
            </Text>
          </View>

          <View className="mt-1 flex-row items-center">
            <MaterialCommunityIcons name={statusMeta.icon} size={14} color={statusMeta.iconColor} />
            <Text className="ml-1.5 text-[12px]" style={{ color: statusMeta.textColor }} numberOfLines={1}>
              {statusMeta.label}
            </Text>
          </View>
        </View>

        <View>
          <View className="mb-1.5 border-t" style={{ borderColor: theme.divider }} />
          {safeTags.length > 0 ? (
            safeTags.map((tag, index) => (
              <Text
                key={`${cardItem.id}-tag-${index}`}
                className="text-[12px] leading-[16px]"
                style={{ color: theme.textSoft }}
                numberOfLines={1}
              >
                {tag}
              </Text>
            ))
          ) : (
            <Text className="text-[12px] leading-[16px]" style={{ color: theme.textSubtle }} numberOfLines={1}>
              General
            </Text>
          )}
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
  // Once-per-session guard for the full-pool fetch. Replaces the previous
  // "skip if discoverRankings already populated" check, which had a bug — users
  // with persisted (stale) ranking cache would never pick up the wider pool
  // because length > 0 already from the persistence hydrate.
  const hasFetchedFullPoolRef = useRef(false);

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
      // Fire once per session unless explicitly refreshed. Persisted-cache
      // hydration (above) provides instant content while this runs.
      if (!forceRefresh && hasFetchedFullPoolRef.current) return;

      try {
        setIsLoading(true);
        // Pull from the FULL books catalogue, not just the rankings collection.
        // Most published books don't have ranking entries yet (no engagement data),
        // so the rankings-only pool was capped well below what 6 sub-tabs need.
        // Now we pull up to 500 published books and hydrate their stats in batch.
        // Books without engagement still appear — they just score low on tabs that
        // weight engagement, and surface naturally in tabs that bias on metadata
        // (New & Rising rewards recency, Daily Picks rotates by date, etc.).
        const pool = await PICKS_BOOK_SERVICE.fetchDiscoverPool({ limit: 500 });
        const enriched = await hydrateDiscoverStats(pool);
        setDiscoverRankings(enriched);
        hasFetchedFullPoolRef.current = true;
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
    // Previously this filtered to entries with reads > 0, which collapsed the pool to
    // whatever tiny slice had ranking data. With the full books-collection pool now
    // hydrated, books without engagement still participate in scoring — they just
    // score low on engagement-weighted tabs (Popular, Trending, Reader's Choice) and
    // surface naturally on metadata-weighted tabs (New & Rising, Daily Picks).
    const readQualifiedCandidates = scoredCandidates;

    if (!readQualifiedCandidates.length) {
      return {
        popular: [],
        trending: [],
        "new-rising": [],
        "readers-choice": [],
        "hidden-gem": [],
        "daily-picks": [],
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

    // ────────────────────────────────────────────────────────────────────────────
    // Discover scoring algos — Wattpad-flavoured.
    //
    // Wattpad's public surfaces (What's Hot, Trending, What's New, Editor's Picks)
    // each express a different signal of the same underlying engagement data. We
    // mirror the spirit, not the literal numbers — the constants are tuned for our
    // smaller catalog.
    //
    //   • likes  ≅ Wattpad votes — the strongest single intent signal.
    //   • reads  ≅ Wattpad reads — high volume but lower intent. Log-scaled so
    //              a 1M-read story isn't 1000× more "popular" than a 1k-read one.
    //   • rating ≅ Wattpad's average rating where present (we don't have comments).
    //   • recencyHours / chaptersTotal / status ≅ Wattpad freshness + commitment.
    // ────────────────────────────────────────────────────────────────────────────

    // POPULAR — Wattpad "What's Hot" spirit. Long-tail vote-weighted accumulator with a
    // gentle recency multiplier so months-old hits stay visible but the very freshest
    // entries get a small lift. Half-life on the recency factor is ~90 days.
    const popularScored = withScore(readQualifiedCandidates, "popular", (entry) => {
      const { reads, likes, rating, chaptersTotal, recencyHours } = entry.metrics;
      const voteWeight = log1pSafe(likes) * 2.4;
      const readWeight = log1pSafe(reads) * 1.2;
      const ratingWeight = rating * 0.6;
      const chaptersWeight = log1pSafe(chaptersTotal) * 0.25;
      const recencyDecay = Math.pow(0.5, recencyHours / (24 * 90)); // 90-day half-life
      return (voteWeight + readWeight + ratingWeight + chaptersWeight) * (0.7 + 0.3 * recencyDecay);
    });

    // TRENDING — Wattpad "Hot Now" spirit. Velocity-driven: how fast is this book
    // accumulating engagement *right now*. Vote velocity weighted 4× read velocity
    // (votes are higher-intent). Recency pulse uses an exponential 48-hour half-life
    // so books published / updated this week dominate.
    const trendingScored = withScore(readQualifiedCandidates, "trending", (entry) => {
      const { reads, likes, rating, recencyHours } = entry.metrics;
      const ageDays = Math.max(0.5, recencyHours / 24);
      const voteVelocity = likes / Math.sqrt(ageDays + 1);
      const readVelocity = (reads / Math.sqrt(ageDays + 1)) * 0.05;
      const recencyPulse = Math.pow(0.5, recencyHours / 48); // 48-hour half-life
      const ongoingBoost = entry.status === "ongoing" ? 0.6 : 0;
      return voteVelocity * 4 + readVelocity + recencyPulse * 8 + rating * 0.6 + ongoingBoost;
    });

    // NEW & RISING — Wattpad "What's New" + "Rising" spirit. Spotlight recently-
    // published books showing early traction signals. Eligibility window tightened to
    // 90 days (Wattpad's What's New is roughly that recent), with an underdog escape
    // hatch for low-read books past the cutoff.
    const newAndRisingPool = readQualifiedCandidates.filter((entry) => {
      const ageDays = entry.metrics.recencyHours / 24;
      return ageDays <= 90 || entry.metrics.reads <= 8000;
    });

    const risingScored = withScore(newAndRisingPool, "new-rising", (entry) => {
      const { reads, likes, rating, recencyHours } = entry.metrics;
      const ageDays = Math.max(0.5, recencyHours / 24);
      const earlyVoteRate = likes / Math.max(1, ageDays); // votes per day since publish
      const earlyReadRate = reads / Math.max(1, ageDays); // reads per day since publish
      const freshnessLift = Math.max(0, 1 - ageDays / 30); // linear decay over 30 days
      const underdogBoost = 1 / (1 + log1pSafe(reads) * 0.8); // boost low-read books
      const ongoingBoost = entry.status === "ongoing" ? 0.5 : 0;
      return earlyVoteRate * 4 + earlyReadRate * 0.08 + freshnessLift * 6 + rating * 0.7 + underdogBoost * 1.5 + ongoingBoost;
    });

    // READER'S CHOICE — Wattpad "Editor's Picks" spirit. Quality-driven, rewarding
    // books with strong vote-to-read ratios (the cleanest single "did people love this"
    // signal), substantive chapter counts, and completed status. Vote rate weighted
    // very heavily (220×) because it's the most reliable quality discriminator we have.
    const readersChoiceScored = withScore(readQualifiedCandidates, "readers-choice", (entry) => {
      const { reads, likes, rating, chaptersTotal } = entry.metrics;
      const voteRate = likes / Math.max(1, reads);
      const ratingWeight = rating * 3;
      const voteFloor = log1pSafe(likes) * 1.4; // prevents single-reader 5-stars dominating
      const completedBoost = entry.status === "completed" ? 1.5 : 0;
      const chaptersBoost = log1pSafe(chaptersTotal) * 0.4;
      return voteRate * 220 + ratingWeight + voteFloor + completedBoost + chaptersBoost;
    });

    // ────────────────────────────────────────────────────────────────────────────
    // Tab selection — strict no-overlap chain across all six tabs.
    //   Popular         → no exclusion (the entry point)
    //   Trending        → excludes Popular
    //   New & Rising    → excludes Popular + Trending
    //   Reader's Choice → excludes Popular + Trending + New & Rising
    //   Hidden Gem      → excludes the four above
    //   Daily Picks     → excludes the five above
    //
    // The PRIMARY pass enforces the strict chain with 2-per-author / 4-per-tag caps,
    // so each tab gets a visually distinct slate of books drawn from the same scored
    // pool. With the 200-rankings cap on getCurrentRankingsByTags, the candidate pool
    // is ~200 stats-bearing books — comfortably larger than the 90 minimum unique
    // books needed to fill all six grids without overlap.
    //
    // A FALLBACK pass kicks in only if a tab comes up short (rare with the big pool).
    // It PRESERVES the cross-tab exclusion and only relaxes diversity caps to 3-per-
    // author / 6-per-tag, so when it fires it pulls books that were skipped earlier
    // due to author/tag caps — never books that are already showing on another tab.
    // ────────────────────────────────────────────────────────────────────────────
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

    const trendingPrimaryList = selectDiverseFromScored({
      scored: trendingScored,
      limit: 30,
      excludedBookIds: popularTopIds,
      maxPerAuthor: 2,
      maxPerTag: 4,
    });
    const trendingList =
      trendingPrimaryList.length >= DISCOVER_TAB_MIN_ITEMS
        ? trendingPrimaryList
        : mergeUniqueByBookId(
            trendingPrimaryList,
            selectDiverseFromScored({
              scored: trendingScored,
              limit: 30,
              // Preserve cross-tab exclusion (books on Popular still won't show here).
              // Only relax diversity caps to find more eligible candidates.
              excludedBookIds: new Set([...popularTopIds, ...trendingPrimaryList.map((item) => resolveBookId(item)).filter(Boolean)]),
              maxPerAuthor: 3,
              maxPerTag: 6,
            }),
            30,
          );
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
      maxPerAuthor: 2,
      maxPerTag: 4,
    });
    const newRisingList =
      newRisingPrimaryList.length >= DISCOVER_TAB_MIN_ITEMS
        ? newRisingPrimaryList
        : mergeUniqueByBookId(
            newRisingPrimaryList,
            selectDiverseFromScored({
              scored: risingScored,
              limit: 30,
              excludedBookIds: new Set([
                ...popularTopIds,
                ...trendingTopIds,
                ...newRisingPrimaryList.map((item) => resolveBookId(item)).filter(Boolean),
              ]),
              maxPerAuthor: 3,
              maxPerTag: 6,
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
              excludedBookIds: new Set([
                ...popularTopIds,
                ...trendingTopIds,
                ...newRisingTopIds,
                ...readersChoicePrimaryList.map((item) => resolveBookId(item)).filter(Boolean),
              ]),
              maxPerAuthor: 3,
              maxPerTag: 6,
            }),
            30,
          );

    // Continue the strict no-overlap chain into Hidden Gem and Daily Picks. After this
    // block, the same book will not appear in any two tabs of the six.
    const readersChoiceTopIds = new Set(
      readersChoiceList
        .slice(0, GRID_LIMIT)
        .map((item) => resolveBookId(item))
        .filter(Boolean),
    );

    // Hidden Gem: high engagement (like-rate, rating, raw likes) weighted up by an
    // "obscurity" factor that rewards low read counts. A book with 200 reads, 80 likes,
    // and a 4.6 average outranks a 50k-read book with the same like-rate.
    //
    // The effortScore tail surfaces under-discovered works with substantial chapter
    // counts even when they have zero engagement yet — these are the literal "hidden
    // gems" of an early-stage catalogue. Multiplied by obscurityFactor so already-
    // engaged books still dominate when there's a real signal to compare against.
    const hiddenGemScored = withScore(readQualifiedCandidates, "hidden-gem", (entry) => {
      const { reads, likes, rating, chaptersTotal } = entry.metrics;
      const likeRate = likes / Math.max(1, reads);
      const obscurityFactor = 1 / (1 + log1pSafe(reads) * 0.5);
      const engagement = rating * 1.8 + log1pSafe(likes) * 1.2 + likeRate * 65;
      const effortScore = log1pSafe(chaptersTotal) * 0.6;
      return engagement * obscurityFactor + likeRate * 25 + effortScore * obscurityFactor;
    });

    const hiddenGemExcluded = new Set([...popularTopIds, ...trendingTopIds, ...newRisingTopIds, ...readersChoiceTopIds]);
    const hiddenGemPrimaryList = selectDiverseFromScored({
      scored: hiddenGemScored,
      limit: 30,
      excludedBookIds: hiddenGemExcluded,
      maxPerAuthor: 2,
      maxPerTag: 4,
    });
    const hiddenGemList =
      hiddenGemPrimaryList.length >= DISCOVER_TAB_MIN_ITEMS
        ? hiddenGemPrimaryList
        : mergeUniqueByBookId(
            hiddenGemPrimaryList,
            selectDiverseFromScored({
              scored: hiddenGemScored,
              limit: 30,
              excludedBookIds: new Set([
                ...popularTopIds,
                ...trendingTopIds,
                ...newRisingTopIds,
                ...readersChoiceTopIds,
                ...hiddenGemPrimaryList.map((item) => resolveBookId(item)).filter(Boolean),
              ]),
              maxPerAuthor: 3,
              maxPerTag: 6,
            }),
            30,
          );
    const hiddenGemTopIds = new Set(
      hiddenGemList
        .slice(0, GRID_LIMIT)
        .map((item) => resolveBookId(item))
        .filter(Boolean),
    );

    // Daily Picks: a mix of engagement, freshness, and quality. The tabKey embeds today's
    // date so the deterministic per-entry jitter inside withScore rotates the picks daily —
    // same algorithm, fresh ordering each calendar day.
    const todayKey = new Date().toISOString().slice(0, 10);
    const dailyPicksScored = withScore(readQualifiedCandidates, `daily-picks:${todayKey}`, (entry) => {
      const { reads, likes, rating, recencyHours } = entry.metrics;
      const likeRate = likes / Math.max(1, reads);
      const ageDays = Math.max(0.5, recencyHours / 24);
      const freshnessLift = 1 / Math.sqrt(ageDays + 0.5);
      const engagement = log1pSafe(likes) * 1.4 + likeRate * 50;
      const quality = rating * 2.4;
      return engagement + freshnessLift * 2 + quality + log1pSafe(reads) * 0.25;
    });

    const dailyPicksExcluded = new Set([...popularTopIds, ...trendingTopIds, ...newRisingTopIds, ...readersChoiceTopIds, ...hiddenGemTopIds]);
    const dailyPicksPrimaryList = selectDiverseFromScored({
      scored: dailyPicksScored,
      limit: 30,
      excludedBookIds: dailyPicksExcluded,
      maxPerAuthor: 2,
      maxPerTag: 4,
    });
    const dailyPicksList =
      dailyPicksPrimaryList.length >= DISCOVER_TAB_MIN_ITEMS
        ? dailyPicksPrimaryList
        : mergeUniqueByBookId(
            dailyPicksPrimaryList,
            selectDiverseFromScored({
              scored: dailyPicksScored,
              limit: 30,
              excludedBookIds: new Set([
                ...popularTopIds,
                ...trendingTopIds,
                ...newRisingTopIds,
                ...readersChoiceTopIds,
                ...hiddenGemTopIds,
                ...dailyPicksPrimaryList.map((item) => resolveBookId(item)).filter(Boolean),
              ]),
              maxPerAuthor: 3,
              maxPerTag: 6,
            }),
            30,
          );

    return {
      popular: popularList,
      trending: trendingList,
      "new-rising": newRisingList,
      "readers-choice": readersChoiceList,
      "hidden-gem": hiddenGemList,
      "daily-picks": dailyPicksList,
    };
  }, [completedExcellent, discoverRankings, freshRead, recentlyUploaded, scoredCandidates]);

  const selectedDiscoverItems = useMemo(() => {
    const source = discoverSources[selectedTabKey] || [];

    // Drop the strict reads > 0 gate. With the full-catalogue pool now hydrated,
    // each tab's scoring already biases on the right signals — books with no
    // engagement just sort to the bottom of engagement-heavy tabs, and bubble up
    // on tabs that prize recency or metadata.
    return source.map(toDiscoverCard).filter(Boolean);
  }, [discoverSources, selectedTabKey, toDiscoverCard]);

  const gridItems = useMemo(() => selectedDiscoverItems.slice(0, GRID_LIMIT), [selectedDiscoverItems]);
  const gridRows = useMemo(() => chunkIntoRows(gridItems, GRID_ITEMS_PER_ROW), [gridItems]);
  // Tall portrait card — matches the iOS reference design.
  //
  //   width  = screen / 2.05 → fits two cards comfortably side-by-side
  //            with the 8dp gap (`mr-2`) and 8dp ScrollView paddingRight.
  //            On a 360dp phone (Galaxy A-series) that's ~175dp; on a
  //            393dp iPhone, ~191dp. Both leave the right column enough
  //            room for the 15pt title without mid-word wraps.
  //
  //   height = width × 1.45 → 1:1.45 portrait aspect, same ratio as the
  //            high-end design. On 175dp wide → ~254dp tall; on 191dp →
  //            ~277dp tall. Tall enough that title (2 lines), author,
  //            views, status, and 3 tag rows all fit with breathing room.
  //
  // Lower bound 180dp on width (tiny phones) and 250dp on height
  // (proportional fallback) so the card never collapses below
  // legibility on rare small viewports.
  const gridCardWidth = useMemo(() => Math.max(180, Math.floor(windowWidth / 2.05)), [windowWidth]);
  const gridCardHeight = useMemo(() => Math.max(250, Math.floor(gridCardWidth * 1.45)), [gridCardWidth]);
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

  const renderDiscoverGridCard = (cardItem) => (
    <DiscoverGridCard key={cardItem.id} cardItem={cardItem} cardWidth={gridCardWidth} cardHeight={gridCardHeight} onPressBook={handlePressBook} />
  );

  const renderPickCard = ({ item }) => <DiscoverPickCard item={item} onPressBook={handlePressBook} />;

  const headerComponent = (
    <View className="pb-3">
      {/* Underline-style sub-tabs. Padded so the first label doesn't hug the screen edge,
          sized down to 13px so they feel quieter than the primary pill tabs above. */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 4, paddingVertical: 6 }}>
        {DISCOVER_TAB_OPTIONS.map((tab) => {
          const isSelected = tab.key === selectedTabKey;
          return (
            <TouchableOpacity
              key={tab.key}
              onPress={() => setSelectedTabKey(tab.key)}
              activeOpacity={0.85}
              className="mr-4 border-b-2 pb-1"
              style={{ borderColor: isSelected ? theme.primary : "transparent" }}
            >
              <Text
                style={{
                  fontSize: 13,
                  fontWeight: isSelected ? "700" : "500",
                  letterSpacing: 0.1,
                  color: isSelected ? theme.text : theme.textSoft,
                }}
              >
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
