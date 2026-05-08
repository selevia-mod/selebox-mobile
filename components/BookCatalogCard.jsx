import { Entypo, Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import useAppTheme from "../hooks/useAppTheme";
import { BookChapterCommentsService } from "../lib/book-chapter-comments";
import { BookService } from "../lib/books";
import BookTag from "./BookTag";

// Module-level TTL cache for per-card stat fetches (bookmarks/comments/
// chapters). Without this, a 30-card catalog screen fired ~90 concurrent
// requests every time it mounted — and re-mounted between tab switches
// because the parent FlashList recycler bails after 3 screens. 5min TTL
// is conservative enough that a creator publishing a new chapter sees the
// updated count within a few minutes via natural navigation, but tight
// enough to dedup the burst of identical reads when scrolling a catalog.
const STATS_TTL_MS = 5 * 60 * 1000;
const STATS_CACHE_MAX = 500;
const bookStatsCache = new Map();

const readBookStatsCache = (bookId) => {
  if (!bookId) return null;
  const entry = bookStatsCache.get(bookId);
  if (!entry) return null;
  if (Date.now() - entry.ts > STATS_TTL_MS) {
    bookStatsCache.delete(bookId);
    return null;
  }
  return entry.value;
};

const writeBookStatsCache = (bookId, value) => {
  if (!bookId) return;
  // LRU-ish eviction — drop the oldest insertion when over budget. Map
  // iteration order is insertion order in JS, so the first key is the
  // earliest-inserted (effectively oldest unread).
  if (bookStatsCache.size >= STATS_CACHE_MAX) {
    const oldest = bookStatsCache.keys().next().value;
    if (oldest !== undefined) bookStatsCache.delete(oldest);
  }
  bookStatsCache.set(bookId, { ts: Date.now(), value });
};

const BookCatalogCard = ({
  item,
  handleDeleteBook,
  hideStats = false,
  onPress,
  onEdit,
  onDelete,
  showViewAsReader = true,
  subtitle = "",
  updatedAtLabel = "Last updated",
}) => {
  const { theme } = useAppTheme();
  const [showMenu, setShowMenu] = useState(false);
  const [likeTotal, setLikeTotal] = useState(0);
  const [bookmarkTotal, setBookmarkTotal] = useState(0);
  const [commentTotal, setCommentTotal] = useState(0);
  const [chaptersTotal, setChaptersTotal] = useState(0);
  const [readTotal, setReadTotal] = useState(0);

  const bookService = new BookService();
  const animation = useRef(new Animated.Value(0)).current; // 0 = hidden, 1 = visible
  const opacity = animation;

  useEffect(() => {
    if (hideStats || !item?.$id) return;
    let cancelled = false;

    // Likes come straight off the `item` row — `mapRowToBook` populates
    // `totalLikes` / `likes` from `books.likes_count` (denormalized
    // counter, kept fresh by triggers). The earlier per-card
    // `bookService.getBookLikes` fan-out hit RLS on `book_likes` which
    // only lets a user SELECT their own like row, so the count came back
    // as 1 (the author's own like) instead of the real total. Same
    // pattern as `fetchBookReads` below.
    setLikeTotal(item?.totalLikes ?? item?.likes ?? item?.likes_count ?? 0);
    setReadTotal(item?.totalReads ?? item?.views_count ?? 0);

    // Cache hit — paint immediately, no network. The 5min TTL is enforced
    // inside readBookStatsCache.
    const cached = readBookStatsCache(item.$id);
    if (cached) {
      setBookmarkTotal(cached.bookmarks);
      setCommentTotal(cached.comments);
      setChaptersTotal(cached.chapters);
      return () => {
        cancelled = true;
      };
    }

    const fetchData = async () => {
      try {
        // Comments shown on the catalog card aggregate across every
        // chapter of the book (May 2026) — same source as the book-info
        // Comments button. Falls back to 0 if the aggregator throws or
        // returns nothing, so a transient backend hiccup doesn't blank
        // the card.
        const [bookmarksRes, commentsRes, chaptersRes] = await Promise.all([
          bookService.getBookLibraries({ bookId: item.$id }).catch(() => ({ total: 0 })),
          BookChapterCommentsService.fetchBookAggregatedChapterComments?.({ bookId: item.$id }).catch(() => ({
            total: 0,
          })) ?? Promise.resolve({ total: 0 }),
          bookService.fetchBookChapters({ bookId: item.$id }).catch(() => ({ total: 0 })),
        ]);
        if (cancelled) return;
        const bookmarks = bookmarksRes?.total ?? 0;
        const comments = commentsRes?.total ?? 0;
        const chapters = chaptersRes?.total ?? 0;
        setBookmarkTotal(bookmarks);
        setCommentTotal(comments);
        setChaptersTotal(chapters);
        writeBookStatsCache(item.$id, { bookmarks, comments, chapters });
      } catch (error) {
        console.log("BookCatalogCard fetchData error", error);
      }
    };
    fetchData();

    return () => {
      cancelled = true;
    };
  }, [hideStats, item?.$id, item?.totalLikes, item?.likes, item?.likes_count, item?.totalReads, item?.views_count]);

  // fetchBookLikes / fetchBookReads removed — see useEffect above.
  // - likes_count is denormalized on `books` (kept fresh by triggers); the
  //   earlier per-card SELECT on book_likes was RLS-shadowed to only the
  //   caller's own row, so authors saw "1 like" on their own books.
  // - views_count likewise lives on `books`; the prior fetchBookRead call
  //   was both a wasted round-trip and crashed on draft books (RLS-filtered
  //   to null, caller deref'd null.totalReads inside a silent try/catch).
  // - bookmarks / comments / chapters now go through the bookStatsCache
  //   above so a 30-card catalog only fans out once per stat per 5min
  //   instead of every mount.

  useEffect(() => {
    Animated.timing(animation, {
      toValue: showMenu ? 1 : 0,
      duration: 200,
      easing: Easing.out(Easing.ease),
      useNativeDriver: true,
    }).start();
  }, [showMenu]);

  const translateY = animation.interpolate({
    inputRange: [0, 1],
    outputRange: [-10, 0],
  });

  const handleBookPress = async () => {
    if (onPress) {
      onPress(item);
      return;
    }
    router.push({ pathname: "book-editor", params: { book: JSON.stringify(item) } });
  };

  const handleEdit = () => {
    setShowMenu(false);
    if (onEdit) {
      onEdit(item);
      return;
    }
    router.push({ pathname: "book-editor", params: { book: JSON.stringify(item) } });
  };

  const handleDelete = () => {
    setShowMenu(false);
    if (onDelete) {
      onDelete(item);
      return;
    }
    if (!handleDeleteBook || !item?.$id) return;
    handleDeleteBook(item.$id);
  };

  const handleViewAsReader = () => {
    setShowMenu(false);
    if (!item?.$id) return;
    router.push({ pathname: "book-info", params: { bookId: item.$id } });
  };

  const thumbnailUri = typeof item?.thumbnail === "string" ? item.thumbnail : item?.thumbnail?.uri || "";
  const formattedUpdatedAt = new Date(item.updatedAt || item.$createdAt || Date.now())
    .toLocaleString("en-US", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    })
    .replace(",", "");
  const bookStats = [
    { key: "reads", icon: "eye-outline", iconColor: theme.accentPurple, value: readTotal },
    { key: "likes", icon: "heart-outline", iconColor: theme.danger, value: likeTotal },
    { key: "comments", icon: "chatbubble-outline", iconColor: theme.accentBlue, value: commentTotal },
    { key: "chapters", icon: "list-outline", iconColor: theme.accentPurple, value: chaptersTotal },
    { key: "bookmarks", icon: "bookmark", iconColor: theme.coin, value: bookmarkTotal },
  ];

  return (
    <TouchableOpacity
      onPress={handleBookPress}
      activeOpacity={0.8}
      className="mb-4 rounded-2xl px-4 py-3.5"
      style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}
    >
      <View className="mb-1 flex-row items-center justify-between">
        <View className="flex-row items-center space-x-1.5">
          <Ionicons name="time-outline" size={12} color={theme.iconMuted} />
          <Text className="text-xs font-semibold" style={{ color: theme.textSoft }}>
            {updatedAtLabel}: {formattedUpdatedAt}
          </Text>
        </View>
        <View className="relative">
          <TouchableOpacity
            activeOpacity={0.7}
            className="h-9 w-9 items-center justify-center rounded-full"
            style={{ backgroundColor: theme.surfaceMuted }}
            onPress={() => setShowMenu((prev) => !prev)}
          >
            <Entypo name="dots-three-horizontal" size={17} color={theme.iconMuted} />
          </TouchableOpacity>

          {showMenu && (
            <Animated.View
              className="absolute right-0 top-10 w-40 rounded-xl p-2"
              style={{
                borderWidth: 1,
                borderColor: theme.border,
                backgroundColor: theme.surfaceElevated,
                zIndex: 999,
                opacity,
                transform: [{ translateY }],
              }}
            >
              <TouchableOpacity onPress={handleEdit} className="rounded-lg px-2 py-2">
                <Text className="text-sm font-semibold" style={{ color: theme.text }}>
                  Edit
                </Text>
              </TouchableOpacity>
              {showViewAsReader && item?.$id ? (
                <TouchableOpacity onPress={handleViewAsReader} className="rounded-lg px-2 py-2">
                  <Text className="text-sm font-semibold" style={{ color: theme.text }}>
                    View as reader
                  </Text>
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity onPress={handleDelete} className="rounded-lg px-2 py-2">
                <Text className="text-sm font-semibold" style={{ color: theme.danger }}>
                  Delete
                </Text>
              </TouchableOpacity>
            </Animated.View>
          )}
        </View>
      </View>

      <View className="flex-row items-start" style={{ zIndex: -999 }}>
        {/* Thumbnail */}
        {thumbnailUri ? (
          <FastImage source={{ uri: thumbnailUri, priority: FastImage.priority.normal }} style={{ height: 165, width: 84, borderRadius: 12 }} />
        ) : (
          <View
            className="h-[108px] w-[84px] items-center justify-center rounded-[12px] border border-dashed"
            style={{ borderColor: theme.borderStrong, backgroundColor: theme.surfaceMuted }}
          >
            <Ionicons name="book-outline" size={18} color={theme.iconMuted} />
          </View>
        )}

        {/* Content */}
        <View className="ml-4 flex-1 flex-col justify-between overflow-hidden py-1">
          {/* Title + Status */}
          <View>
            <Text className="text-base font-bold" style={{ color: theme.text }} numberOfLines={2} ellipsizeMode="tail">
              {item.title}
            </Text>
            {item.synopsis ? (
              <Text className="mt-1 text-xs" style={{ color: theme.textSoft }} numberOfLines={2} ellipsizeMode="tail">
                {item.synopsis}
              </Text>
            ) : null}

            {/* Status badge */}
            <View className="mt-2.5 mb-3">
              <BookTag tagName={item.status} />
            </View>
          </View>

          {!hideStats ? (
            <View className="mt-4 flex-row flex-wrap items-center gap-2.5">
              {bookStats.map((stat) => (
                <View
                  key={stat.key}
                  className="min-w-[62px] flex-row items-center justify-center space-x-1 rounded-full px-2.5 py-1.5"
                  style={{ backgroundColor: theme.surfaceMuted }}
                >
                  <Ionicons name={stat.icon} size={14} color={stat.iconColor} />
                  <Text className="text-xs" style={{ color: theme.textSoft }}>
                    {stat.value}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      </View>
    </TouchableOpacity>
  );
};

export default BookCatalogCard;
