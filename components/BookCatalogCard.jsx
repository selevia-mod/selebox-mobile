import { Entypo, Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import useAppTheme from "../hooks/useAppTheme";
import { BookReadService } from "../lib/book-reads";
import { BookService } from "../lib/books";
import BookTag from "./BookTag";

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

    const fetchData = async () => {
      try {
        await Promise.all([fetchBookLikes(), fetchBookBookmarks(), fetchBookComments(), fetchBookChapters(), fetchBookReads()]);
      } catch (error) {
        console.log("fetchData error", error);
      }
    };
    fetchData();
  }, [hideStats, item?.$id]);

  const fetchBookLikes = async () => {
    try {
      const bookLikes = await bookService.getBookLikes({ bookId: item.$id });
      setLikeTotal(bookLikes.total);
    } catch (error) {
      console.log("fetchBookLikes: error", error);
    }
  };

  const fetchBookBookmarks = async () => {
    try {
      const bookBookmarks = await bookService.getBookLibraries({ bookId: item.$id });
      setBookmarkTotal(bookBookmarks.total);
    } catch (error) {
      console.log("fetchBookBookmarks: error", error);
    }
  };

  const fetchBookComments = async () => {
    try {
      const bookComments = await bookService.getBookComments({ bookId: item.$id });
      setCommentTotal(bookComments.total);
    } catch (error) {
      console.log("fetchBookComments: error", error);
    }
  };

  const fetchBookChapters = async () => {
    try {
      const bookChapters = await bookService.fetchBookChapters({ bookId: item.$id });
      setChaptersTotal(bookChapters.total);
    } catch (error) {
      console.log("fetchBookChapters: error", error);
    }
  };

  // Read count comes straight off the `item` row now — `mapRowToBook`
  // populates `totalReads` from `views_count` already. Used to fire a
  // separate `BookReadService.fetchBookRead` call here, but:
  //   1. It was a redundant round-trip per card on every catalog mount.
  //   2. For DRAFT books (is_public=false), the anon SELECT in
  //      fetchBookRead got RLS-filtered to null and the caller's
  //      `bookReads.totalReads` threw `Cannot read property of null`,
  //      caught silently by the try/catch — leaving readTotal stuck at 0.
  // The `?? 0` fallback covers any older cached item that was hydrated
  // before mapRowToBook started populating the field.
  const fetchBookReads = async () => {
    setReadTotal(item?.totalReads ?? item?.views_count ?? 0);
  };

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
