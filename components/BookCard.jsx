import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { memo, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Dimensions, Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import useAppTheme from "../hooks/useAppTheme";
import { BookReadService } from "../lib/book-reads";
import FormatNumber from "../lib/format-number";

const { width: SCREEN_WIDTH } = Dimensions.get("window");

const BOOK_STATS_CACHE = new Map();
const BOOK_STATS_INFLIGHT = new Map();

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
  if (BOOK_STATS_CACHE.has(bookId)) return BOOK_STATS_CACHE.get(bookId);

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
      BOOK_STATS_CACHE.set(bookId, payload);
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

  useEffect(() => {
    setStats(inlineStats);
  }, [inlineStats]);

  useEffect(() => {
    let cancelled = false;
    const bookId = item?.$id;
    if (!bookId) return;

    const hasInlineStats = inlineStats.averageRating > 0 || inlineStats.totalReads > 0;
    if (hasInlineStats && !BOOK_STATS_CACHE.has(bookId)) {
      BOOK_STATS_CACHE.set(bookId, inlineStats);
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
  const accessLabel = item?.isLocked ? "Paid" : "Free";
  const sashBackgroundColor = item?.isLocked ? "rgba(139, 92, 246, 0.95)" : "rgba(16, 185, 129, 0.95)";
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
    const currentProgress = progress?.lastChapter?.order;
    const totalProgress = progress?.bookChapters;

    return Math.min(100, Math.round((currentProgress / totalProgress) * 100));
  };

  return (
    <View style={{ width: cardWidth }} className="mb-4 mr-3 overflow-hidden rounded-xl" {...props}>
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={handlePress}
        accessibilityLabel={`Read book: ${item?.title ?? "Untitled"}`}
        className="rounded-xl"
        style={{ backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}
      >
        {/* Thumbnail */}
        <View className="relative">
          <FastImage
            style={{
              height: cardHeight,
              width: cardWidth,
              borderTopLeftRadius: 12,
              borderTopRightRadius: 12,
              backgroundColor: theme.surfaceMuted,
            }}
            source={item?.thumbnail ? { uri: item.thumbnail, priority: FastImage.priority.high } : null}
            resizeMode={FastImage.resizeMode.cover}
          >
            {!item?.thumbnail && (
              <View className="flex-1 items-center justify-center">
                <ActivityIndicator size="small" color={theme.primary} />
              </View>
            )}
          </FastImage>

          <View
            pointerEvents="none"
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
              className="text-[9px] text-center font-bold uppercase"
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
