import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { memo, useEffect, useMemo, useState } from "react";
import { Dimensions, Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import useAppTheme from "../hooks/useAppTheme";
import { BookReadService } from "../lib/book-reads";
import FormatNumber from "../lib/utils/format-number";

const { width: SCREEN_WIDTH } = Dimensions.get("window");

// 5min TTL + 500-entry LRU cap. Previously bare `new Map()` that never
// expired — author publishes a new chapter, average rating updates from
// new readers, but cards rendered from the cache stayed stuck at the
// pre-OTA snapshot until app relaunch. 5min matches BookCatalogCard so
// the two card types feel consistent.
const STATS_TTL_MS = 5 * 60 * 1000;
const STATS_CACHE_MAX = 500;
const BOOK_STATS_CACHE = new Map();
const BOOK_STATS_INFLIGHT = new Map();

const readStatsCache = (bookId) => {
  if (!bookId) return null;
  const entry = BOOK_STATS_CACHE.get(bookId);
  if (!entry) return null;
  if (Date.now() - entry.ts > STATS_TTL_MS) {
    BOOK_STATS_CACHE.delete(bookId);
    return null;
  }
  return entry.value;
};

const writeStatsCache = (bookId, value) => {
  if (!bookId) return;
  if (BOOK_STATS_CACHE.size >= STATS_CACHE_MAX) {
    const oldest = BOOK_STATS_CACHE.keys().next().value;
    if (oldest !== undefined) BOOK_STATS_CACHE.delete(oldest);
  }
  BOOK_STATS_CACHE.set(bookId, { ts: Date.now(), value });
};

const toFiniteNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const getInlineStats = (book) => ({
  averageRating: toFiniteNumber(book?.averageRating ?? book?.rating, 0),
  totalReads: toFiniteNumber(book?.totalReads ?? book?.reads ?? book?.monthlyReads, 0),
});

const fetchBookStatsCached = async (bookId) => {
  if (!bookId) return { averageRating: 0, totalReads: 0 };
  const cached = readStatsCache(bookId);
  if (cached) return cached;

  if (BOOK_STATS_INFLIGHT.has(bookId)) {
    return BOOK_STATS_INFLIGHT.get(bookId);
  }

  const request = (async () => {
    try {
      const statsDoc = await BookReadService.fetchBookRead({ bookId });
      const payload = {
        averageRating: toFiniteNumber(statsDoc?.averageRating, 0),
        totalReads: toFiniteNumber(statsDoc?.totalReads, 0),
      };
      writeStatsCache(bookId, payload);
      return payload;
    } catch (error) {
      return { averageRating: 0, totalReads: 0 };
    } finally {
      BOOK_STATS_INFLIGHT.delete(bookId);
    }
  })();

  BOOK_STATS_INFLIGHT.set(bookId, request);
  return request;
};

const BookCard = ({ item, progress, customWidth, customHeight, customFontSize, hideAvatar = false, ...props }) => {
  const { theme } = useAppTheme();
  const cardWidth = customWidth || Math.max(SCREEN_WIDTH * 0.32, 122);
  const cardHeight = customHeight || cardWidth * 1.5;
  const fontSize = customFontSize || 12;
  const titleLineHeight = Math.round(fontSize * 1.35);
  const titleBlockHeight = titleLineHeight * 2;
  const inlineStats = useMemo(() => getInlineStats(item), [item]);
  const [stats, setStats] = useState(inlineStats);
  // Tracks FastImage load failures so we can swap to the placeholder. Reset whenever
  // the underlying thumbnail URL changes (e.g. the user replaces the cover).
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    setLoadFailed(false);
  }, [item?.thumbnail]);

  useEffect(() => {
    setStats(inlineStats);
  }, [inlineStats]);

  useEffect(() => {
    let cancelled = false;
    const bookId = item?.$id;
    if (!bookId) return;

    const hasInlineStats = inlineStats.averageRating > 0 || inlineStats.totalReads > 0;
    if (hasInlineStats && !readStatsCache(bookId)) {
      writeStatsCache(bookId, inlineStats);
    }

    if (hasInlineStats) return;

    fetchBookStatsCached(bookId).then((payload) => {
      if (cancelled) return;
      setStats(payload);
    });

    return () => {
      cancelled = true;
    };
  }, [inlineStats, item?.$id]);

  const rateValue = toFiniteNumber(stats?.averageRating, 0);
  const readsValue = toFiniteNumber(stats?.totalReads, 0);
  // A book is "Paid" if either the book-level lock threshold
  // (lock_from_chapter > 0 → item.isLocked) is set, OR any chapter on
  // the row carries the legacy per-chapter `is_locked` flag. Card
  // views typically don't carry chapter data, so legacy-locked books
  // (lock set per-chapter, lock_from_chapter still null) will fall
  // through and render as "Free" until the database is backfilled
  // (see notes — `lock_from_chapter` should be populated to the
  // lowest is_locked chapter_number for every legacy book that uses
  // per-chapter locking). The detail page does have chapters and
  // computes the correct label.
  const cardChaptersCheck =
    Array.isArray(item?.chapters) && item.chapters.some((c) => c?.is_locked || c?.isLocked);
  const accessLabel = item?.isLocked || cardChaptersCheck ? "Paid" : "Free";
  // Fully opaque so iOS can compute the shadow efficiently. The previous
  // rgba(…, 0.95) made the view non-opaque, which forced the rasterizer to
  // walk the subview tree on every layout pass — that's where the 150+
  // "(ADVICE) View has a shadow set but cannot calculate shadow efficiently"
  // log spam was coming from on the Books tab.
  const sashBackgroundColor = item?.isLocked || cardChaptersCheck ? "#8b5cf6" : "#10b981";
  const sashTextColor = theme.primaryContrast;
  const rateLabel = rateValue.toFixed(1);
  const readsLabel = FormatNumber(readsValue);

  const handlePress = () => {
    router.push({
      pathname: "book-info",
      params: {
        bookId: item?.$id,
      },
    });
  };

  const getProgressPercentage = () => {
    const currentProgress = Number(progress?.lastChapter?.order);
    const totalProgress = Number(progress?.bookChapters);

    if (!Number.isFinite(currentProgress) || !Number.isFinite(totalProgress) || totalProgress <= 0) {
      return 0;
    }

    const pct = Math.round((currentProgress / totalProgress) * 100);
    return Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0;
  };

  // Tight 2px hairline gap between covers — premium gallery-rail spacing.
  return (
    <View style={{ width: cardWidth, marginRight: 2 }} className="mb-4 overflow-hidden rounded-xl" {...props}>
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={handlePress}
        accessibilityLabel={`Read book: ${item?.title ?? "Untitled"}`}
        className="rounded-xl"
        style={{ backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}
      >
        {/* Thumbnail. Renders a book-outline placeholder if the source is missing OR
            if FastImage hits onError (dead URL, deleted storage file, network failure).
            Previously a perpetual ActivityIndicator was shown when thumbnail was empty,
            which made missing covers look like infinite loading. */}
        <View className="relative">
          {item?.thumbnail && !loadFailed ? (
            <FastImage
              style={{
                height: cardHeight,
                width: cardWidth,
                borderTopLeftRadius: 12,
                borderTopRightRadius: 12,
                backgroundColor: theme.surfaceMuted,
              }}
              source={{ uri: item.thumbnail, priority: FastImage.priority.normal }}
              resizeMode={FastImage.resizeMode.cover}
              onError={() => setLoadFailed(true)}
            />
          ) : (
            <View
              style={{
                height: cardHeight,
                width: cardWidth,
                borderTopLeftRadius: 12,
                borderTopRightRadius: 12,
                backgroundColor: theme.surfaceMuted,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Ionicons name="book-outline" size={Math.max(28, Math.floor(cardWidth * 0.22))} color={theme.iconMuted} />
            </View>
          )}

          <View
            pointerEvents="none"
            // shouldRasterizeIOS flattens the rotated sash to a bitmap so the
            // shadow doesn't re-compute every frame as the parent card
            // animates / scrolls. Combined with the opaque backgroundColor
            // above, this kills the iOS "(ADVICE)" shadow warnings.
            shouldRasterizeIOS
            style={{
              position: "absolute",
              top: 8,
              right: -28,
              width: 90,
              paddingVertical: 3,
              backgroundColor: sashBackgroundColor,
              transform: [{ rotate: "40deg" }],
              alignItems: "center",
              justifyContent: "center",
              shadowColor: theme.isDark ? "black" : theme.textSoft,
              shadowOpacity: 0.22,
              shadowRadius: 4,
              shadowOffset: { width: 0, height: 2 },
              elevation: 4,
            }}
          >
            <Text
              style={{ color: sashTextColor, letterSpacing: 0.6 }}
              className="text-[9px] text-center font-bold"
              numberOfLines={1}
              ellipsizeMode="clip"
            >
              {accessLabel}
            </Text>
          </View>
        </View>

        {progress && (
          <View className="h-1 flex-row">
            <View style={{ backgroundColor: theme.accentPurple, width: getProgressPercentage() }} />
            <View style={{ backgroundColor: theme.surfaceStrong, width: "100%" }} />
          </View>
        )}

        {/* Content */}
        <View className="p-2">
          <View style={{ height: titleBlockHeight, marginBottom: 8 }}>
            <Text
              className="font-sans font-bold"
              style={{ fontSize, lineHeight: titleLineHeight, color: theme.text }}
              numberOfLines={2}
              ellipsizeMode="tail"
            >
              {item?.title || "Untitled"}
            </Text>
          </View>

          <View className="mt-1 flex-row flex-wrap items-center gap-1.5">
            <View className="flex-row items-center rounded-full bg-yellow-400/20 px-2 py-0.5">
              <Ionicons name="star" size={10} color={theme.accentAmber} />
              <Text className="ml-1 text-[10px] font-semibold" style={{ color: theme.accentAmber }}>
                {rateLabel}
              </Text>
            </View>

            <View className="flex-row items-center rounded-full bg-indigo-400/20 px-2 py-0.5">
              <Ionicons name="eye-outline" size={10} color={theme.primary} />
              <Text className="ml-1 text-[10px] font-semibold" style={{ color: theme.primary }}>
                {readsLabel}
              </Text>
            </View>
          </View>
        </View>
      </TouchableOpacity>
    </View>
  );
};

export default memo(BookCard);
