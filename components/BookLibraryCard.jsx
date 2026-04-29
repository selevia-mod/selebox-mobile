import { Entypo, Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Animated, Easing, Text, TouchableOpacity, TouchableWithoutFeedback, View } from "react-native";
import FastImage from "react-native-fast-image";
import useAppTheme from "../hooks/useAppTheme";
import Share from "react-native-share";
import { useGlobalContext } from "../context/global-provider";
import { isBookDownloaded, saveDownloadedBook } from "../lib/book-downloads";
import { BookReadService } from "../lib/book-reads";
import { BookUnlocksService } from "../lib/book-unlocks";
import { BookService } from "../lib/books";
import FormatNumber from "../lib/format-number";
import secrets from "../private/secrets";
import BookTag from "./BookTag";

const BookLibraryCard = React.memo(({ item, hideRemove, hideSettings, hideStats, handleRemoveFromLibrary, customStyle }) => {
  const { theme } = useAppTheme();
  const [showMenu, setShowMenu] = useState(false);
  const [likeTotal, setLikeTotal] = useState(0);
  const [bookmarkTotal, setBookmarkTotal] = useState(0);
  const [commentTotal, setCommentTotal] = useState(0);
  const [chaptersTotal, setChaptersTotal] = useState(0);
  const [readTotal, setReadTotal] = useState(0);
  const [isBookStatsLoading, setIsBookStatsLoading] = useState(true);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isDownloaded, setIsDownloaded] = useState(false);
  const animation = useRef(new Animated.Value(0)).current;

  const { user, globalSettings } = useGlobalContext();
  const bookChapterLockStart = globalSettings["BOOKS_CHAPTER_LOCK_START"];
  const bookService = new BookService();
  const bookUnlockService = useRef(new BookUnlocksService()).current;

  useEffect(() => {
    const fetchData = async () => {
      try {
        setIsBookStatsLoading(true);
        await Promise.all([fetchBookLikes(), fetchBookBookmarks(), fetchBookComments(), fetchBookChapters(), fetchBookReads()]);
      } catch (error) {
        console.log("fetchData error", error);
      } finally {
        setIsBookStatsLoading(false);
      }
    };
    fetchData();
  }, []);

  useEffect(() => {
    if (item?.$id) {
      setIsDownloaded(isBookDownloaded(item.$id));
    }
  }, [item?.$id]);

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
      const bookChapters = await bookService.fetchBookChapters({ bookId: item.$id, status: "Publish" });
      setChaptersTotal(bookChapters.total);
    } catch (error) {
      console.log("fetchBookChapters: error", error);
    }
  };

  const fetchBookReads = async () => {
    try {
      const bookReads = await BookReadService.fetchBookRead({ bookId: item.$id });
      setReadTotal(bookReads.totalReads);
    } catch (error) {
      console.log("fetchBookReads: error", error);
    }
  };

  // Animate menu open/close
  useEffect(() => {
    Animated.timing(animation, {
      toValue: showMenu ? 1 : 0,
      duration: 180,
      easing: Easing.out(Easing.ease),
      useNativeDriver: true,
    }).start();
  }, [showMenu]);

  const opacity = animation;
  const translateY = animation.interpolate({
    inputRange: [0, 1],
    outputRange: [-8, 0],
  });

  const formattedDate = useMemo(() => {
    return new Date(item?.$createdAt)
      .toLocaleString("en-US", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      })
      .replace(",", "");
  }, [item?.$createdAt]);

  const handleBookPress = () => router.push({ pathname: "book-info", params: { bookId: item.$id } });

  const handleShare = async () => {
    setShowMenu(false);
    await Share.open({
      message: `Check out this book!`,
      url: `${secrets.WEBSITE}/books/${item?.$id}`,
      title: `${item.title}`,
      type: "url",
    });
  };

  const handleRemove = () => {
    setShowMenu(false);
    handleRemoveFromLibrary();
  };

  const handleReport = () => {
    setShowMenu(false);
  };

  const fetchAllBookChapters = async () => {
    const response = await bookService.fetchAllBookChapters({
      bookId: item.$id,
      status: "Publish",
      limit: 50,
    });

    return { chapters: response.documents || [], total: response.total ?? response.documents?.length ?? 0 };
  };

  const ensureBookInLibrary = async () => {
    if (!user?.$id || !item?.$id) return null;
    try {
      const existing = await bookService.getBookLibrayByUser({ bookId: item.$id, userId: user.$id });
      if (existing?.documents?.length > 0) return existing.documents[0];
      return await bookService.createBookLibrary({ bookId: item.$id, userId: user.$id });
    } catch (error) {
      console.log("ensureBookInLibrary: error", error);
      return null;
    }
  };

  const handleDownload = async () => {
    if (!item?.$id || isDownloading) return;
    if (isDownloaded) {
      Alert.alert("Already downloaded", "This book is available offline.");
      return;
    }
    if (item?.isLocked && (bookChapterLockStart === undefined || bookChapterLockStart === null)) {
      Alert.alert("Please wait", "Book settings are still loading. Try again in a moment.");
      return;
    }

    try {
      setIsDownloading(true);
      const unlocksData = await bookUnlockService.getBookUnlockByUser({ book: item.$id, unlockBy: user?.$id });
      const unlockDocument = unlocksData?.documents?.[0];
      const { chapters } = await fetchAllBookChapters();

      if (!chapters.length) {
        Alert.alert("No chapters available", "There are no published chapters to download yet.");
        return;
      }

      const readableChapters = [];
      chapters.forEach((chapter, index) => {
        const isLocked = BookUnlocksService.isChapterLocked({
          book: item,
          bookChapterLockStart,
          chapter,
          index,
          unlocks: unlockDocument,
          currentUserId: user?.$id,
        });

        if (!isLocked) {
          readableChapters.push(chapter);
        }
      });

      if (!readableChapters.length) {
        Alert.alert("Locked book", "Only locked chapters are available right now.");
        return;
      }

      saveDownloadedBook({
        bookId: item.$id,
        book: item,
        chapters: readableChapters,
      });

      setIsDownloaded(true);
      await ensureBookInLibrary();
    } catch (error) {
      console.log("handleDownload: error", error);
      Alert.alert("Download failed", "We couldn’t download this book. Please try again.");
    } finally {
      setIsDownloading(false);
    }
  };

  if (!item) return null;

  return (
    <TouchableWithoutFeedback onPress={() => setShowMenu(false)}>
      <View
        className="mb-5 overflow-hidden rounded-lg"
        style={[customStyle, { position: "relative", backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }]}
      >
        {isDownloading && (
          <View className="absolute inset-0 z-20 h-full w-full items-center justify-center" style={{ backgroundColor: theme.overlayStrong }}>
            <ActivityIndicator size="large" color={theme.primaryContrast} />
            <Text className="mt-2 text-sm font-semibold" style={{ color: theme.primaryContrast }}>
              Downloading...
            </Text>
          </View>
        )}
        {/* Header Row */}
        {!hideSettings && (
          <View className="mb-2 flex-row items-center justify-between">
            <Text className="text-xs" style={{ color: theme.textSoft }}>
              Last updated: {formattedDate}
            </Text>
            <View className="flex-row items-center space-x-3">
              <TouchableOpacity
                hitSlop={12}
                onPress={handleDownload}
                disabled={isDownloading || isDownloaded}
                activeOpacity={0.7}
                className={isDownloading || isDownloaded ? "opacity-50" : ""}
              >
                <Ionicons name={isDownloaded ? "checkmark-circle" : "download-outline"} size={18} color={isDownloaded ? theme.accentGreen : theme.textSubtle} />
              </TouchableOpacity>
              <View className="relative">
                <TouchableOpacity hitSlop={12} onPress={() => setShowMenu((prev) => !prev)} activeOpacity={0.7}>
                  <Entypo name="dots-three-horizontal" size={18} color={theme.textSubtle} />
                </TouchableOpacity>

                {showMenu && (
                  <Animated.View
                    className="absolute right-0 top-6 w-[90] rounded-lg p-2 shadow-lg"
                    style={{ zIndex: 999, opacity, transform: [{ translateY }], backgroundColor: theme.surfaceElevated, borderWidth: 1, borderColor: theme.border }}
                  >
                    <TouchableOpacity onPress={handleShare} className="rounded px-2 py-1 hover:bg-gray-800">
                      <Text style={{ color: theme.text }}>Share</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={handleReport} className="rounded px-2 py-1 hover:bg-gray-800">
                      <Text style={{ color: theme.text }}>Report</Text>
                    </TouchableOpacity>
                    {!hideRemove && (
                      <TouchableOpacity onPress={handleRemove} className="rounded px-2 py-1 hover:bg-gray-800">
                        <Text style={{ color: theme.danger }}>Remove</Text>
                      </TouchableOpacity>
                    )}
                  </Animated.View>
                )}
              </View>
            </View>
          </View>
        )}

        {/* Book Row */}
        <TouchableOpacity onPress={handleBookPress} activeOpacity={0.8} className="flex-row items-center p-1" style={{ zIndex: -999 }}>
          {/* Thumbnail */}
          <FastImage
            source={{
              uri: item?.thumbnail,
              priority: FastImage.priority.high,
            }}
            style={{
              height: 110,
              width: 80,
              borderRadius: 10,
              backgroundColor: theme.surfaceMuted,
            }}
            resizeMode={FastImage.resizeMode.cover}
          />

          {/* Book Details */}
          <View className="ml-4 flex-1 justify-between">
            <View>
              <Text className="text-base font-semibold" style={{ color: theme.text }} numberOfLines={1}>
                {item?.title}
              </Text>
              <Text className="mt-1 text-xs" style={{ color: theme.textMuted }} numberOfLines={2}>
                {item?.synopsis || "No synopsis available."}
              </Text>

              {/* Status Badge */}
              <View className="mt-2 flex-row items-center justify-between">
                <BookTag tagName={item?.status} />
                {isDownloaded && (
                  <View className="flex-row items-center rounded-full bg-emerald-500/20 px-2 py-0.5">
                    <Ionicons name="download-outline" size={12} color={theme.accentGreen} />
                    <Text className="ml-1 text-[10px] font-semibold" style={{ color: theme.accentGreen }}>
                      Downloaded
                    </Text>
                  </View>
                )}
              </View>
            </View>

            {/* Stats Row */}
            {!hideStats && (
              <View className="mt-3 flex-row items-center justify-between">
                <View className="flex-row items-center space-x-1">
                  <Ionicons name="eye-outline" size={14} color="#5f59dbe2" />
                  <Text className="text-xs" style={{ color: theme.textSoft }}>
                    {FormatNumber(readTotal)}
                  </Text>
                </View>
                <View className="flex-row items-center space-x-1">
                  <Ionicons name="heart-outline" size={14} color="#f87171" />
                  <Text className="text-xs" style={{ color: theme.textSoft }}>
                    {FormatNumber(likeTotal)}
                  </Text>
                </View>
                <View className="flex-row items-center space-x-1">
                  <Ionicons name="chatbubble-outline" size={14} color="#38bdf8" />
                  <Text className="text-xs" style={{ color: theme.textSoft }}>
                    {FormatNumber(commentTotal)}
                  </Text>
                </View>
                <View className="flex-row items-center space-x-1">
                  <Ionicons name="bookmark" size={14} color="#facc15" />
                  <Text className="text-xs" style={{ color: theme.textSoft }}>
                    {FormatNumber(bookmarkTotal)}
                  </Text>
                </View>
                <View className="flex-row items-center space-x-1">
                  <Ionicons name="list-outline" size={14} color="#a78bfa" />
                  <Text className="text-xs" style={{ color: theme.textSoft }}>
                    {chaptersTotal}
                  </Text>
                </View>
              </View>
            )}
          </View>
        </TouchableOpacity>
      </View>
    </TouchableWithoutFeedback>
  );
});

export default BookLibraryCard;
