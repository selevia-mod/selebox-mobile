import { AntDesign, Ionicons, SimpleLineIcons } from "@expo/vector-icons";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, Text, TouchableOpacity, View } from "react-native";
import { Query } from "react-native-appwrite";
import FastImage from "react-native-fast-image";
import { SafeAreaView } from "react-native-safe-area-context";
import Share from "react-native-share";
import { useSelector } from "react-redux";
import { ShareIcon } from "../../assets/svgs";
import {
  BookChaptersModal,
  BookChaptersUnlockModal,
  BookInfoStats,
  BookRating,
  BookRatingModal,
  BookTag,
  ContentNotFound,
  UserRoleBadgeIcons,
} from "../../components";
import AnimatedSkeleton, { getRandomSkeletonWidth } from "../../components/AnimatedSkeleton";
import useAppTheme from "../../hooks/useAppTheme";
import { appwriteConfig, databases } from "../../lib/appwrite";
import { getDownloadedBook, isBookDownloaded, saveDownloadedBook } from "../../lib/book-downloads";
import { BookRatingService } from "../../lib/book-rating";
import { BookUnlocksService } from "../../lib/book-unlocks";
import { BOOK_CHAPTER_LIST_SELECT, BookService, getBookChapterOrder, getBookChapterSectionLabel, isIntroductionChapter } from "../../lib/books";
import { FollowService } from "../../lib/follows";
import secrets from "../../private/secrets";

const normalizeRouteParam = (value) => {
  if (!value) return null;
  if (Array.isArray(value)) return value[0] || null;
  return String(value);
};

const BookInfo = () => {
  const { theme } = useAppTheme();
  const previewChaptersLimit = 5;
  const { user } = useSelector((state) => state.auth);
  const { globalSettings } = useSelector((state) => state.app);
  const params = useLocalSearchParams();
  const resolvedBookId = useMemo(() => normalizeRouteParam(params.bookId || params.id), [params.bookId, params.id]);
  const focusCommentIdParam = useMemo(
    () => normalizeRouteParam(params.focusCommentId || params.commentId || params.comment),
    [params.comment, params.commentId, params.focusCommentId],
  );
  const focusReplyIdParam = useMemo(() => normalizeRouteParam(params.focusReplyId || params.replyId), [params.focusReplyId, params.replyId]);
  const openCommentsParam = useMemo(() => {
    const raw = normalizeRouteParam(params.openComments);
    return raw === "1" || raw === "true";
  }, [params.openComments]);
  const booksState = useSelector((state) => state.books);
  const [book, setBook] = useState(null);
  const [chapters, setChapters] = useState([]);
  const [previewChapters, setPreviewChapters] = useState([]);
  const [chaptersTotal, setChaptersTotal] = useState(0);
  const [unlocks, setUnlocks] = useState(null);
  const [loading, setLoading] = useState(true);
  const [chaptersVisible, setChaptersVisible] = useState(false);
  const [chapterUnlockVisible, setChapterUnlockVisible] = useState(false);
  const [selectedChapter, setSelectedChapter] = useState(null);
  const [continueReadingChapter, setContinueReadingChapter] = useState(null);
  const [isFollowing, setIsFollowing] = useState(false);
  const [ratingVisible, setRatingVisible] = useState(false);
  const displayedChaptersTotal = useMemo(() => {
    const hasIntroduction = Array.isArray(chapters) && chapters.some((chapter, index) => isIntroductionChapter(chapter, index));
    return Math.max(Number(chaptersTotal || 0) - (hasIntroduction ? 1 : 0), 0);
  }, [chapters, chaptersTotal]);
  const displayedPreviewChapters = useMemo(() => {
    if (previewChapters.length) return previewChapters;

    return [...chapters]
      .filter((chapter, index) => !isIntroductionChapter(chapter, index))
      .sort((a, b) => getBookChapterOrder(b) - getBookChapterOrder(a))
      .slice(0, previewChaptersLimit);
  }, [chapters, previewChapters, previewChaptersLimit]);
  const [userRating, setUserRating] = useState(null);
  const [ratingSubmitting, setRatingSubmitting] = useState(false);
  const [averageRating, setAverageRating] = useState(null);
  const [isDownloaded, setIsDownloaded] = useState(false);
  const [isOfflineMode, setIsOfflineMode] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);

  const bookService = new BookService();
  const bookUnlockService = new BookUnlocksService();
  const bookChapterLockStart = globalSettings["BOOKS_CHAPTER_LOCK_START"];

  const cachedContinueReading = useMemo(() => {
    return booksState?.continueReading?.find((entry) => entry?.book?.$id === resolvedBookId) || null;
  }, [booksState?.continueReading, resolvedBookId]);
  const cachedAllRanking = useMemo(() => {
    const allRankingCache = booksState?.rankingCacheByTag?.__ALL__?.items;
    if (Array.isArray(allRankingCache) && allRankingCache.length > 0) {
      return allRankingCache;
    }
    return booksState?.ranking || [];
  }, [booksState?.ranking, booksState?.rankingCacheByTag]);

  const findCachedBook = useCallback(() => {
    const aggregated = [
      ...(booksState?.weeklyFeatured || []),
      ...(booksState?.freshRead || []),
      ...(booksState?.completedExcellent || []),
      ...(booksState?.recentlyUploaded || []),
      ...cachedAllRanking,
    ];

    const directMatch = aggregated.find((cachedBook) => cachedBook?.$id === resolvedBookId);
    if (directMatch) return directMatch;

    const categoryMatch = Object.values(booksState?.categories || {})
      .flat()
      .find((cachedBook) => cachedBook?.$id === resolvedBookId);
    if (categoryMatch) return categoryMatch;

    const continueMatch = booksState?.continueReading?.find((entry) => entry?.book?.$id === resolvedBookId)?.book;
    if (continueMatch) return continueMatch;

    const libraryMatch = booksState?.library?.find((entry) => entry?.book?.$id === resolvedBookId)?.book;
    if (libraryMatch) return libraryMatch;

    return null;
  }, [booksState, cachedAllRanking, resolvedBookId]);

  useEffect(() => {
    if (resolvedBookId) {
      setIsDownloaded(isBookDownloaded(resolvedBookId));
    }
  }, [resolvedBookId]);

  useFocusEffect(
    useCallback(() => {
      if (!resolvedBookId) {
        setBook(null);
        setChapters([]);
        setPreviewChapters([]);
        setChaptersTotal(0);
        setUnlocks(null);
        setContinueReadingChapter(null);
        setLoading(false);
        return;
      }
      const downloadedEntry = resolvedBookId ? getDownloadedBook(resolvedBookId) : null;
      const cachedBook = downloadedEntry?.book || findCachedBook();

      if (cachedBook) {
        setBook(cachedBook);
        if (cachedContinueReading) setContinueReadingChapter(cachedContinueReading);
      } else if (!downloadedEntry) {
        setBook(null);
        setChapters([]);
        setPreviewChapters([]);
        setChaptersTotal(0);
        setUnlocks(null);
        setContinueReadingChapter(null);
      }

      if (downloadedEntry?.chapters?.length) {
        setChapters(downloadedEntry.chapters);
        setPreviewChapters([]);
        setChaptersTotal(downloadedEntry.chapters.length);
        setUnlocks({ chapters: downloadedEntry.chapterIds || downloadedEntry.chapters.map((chapter) => chapter.$id) });
        setIsDownloaded(true);
      } else {
        setChapters([]);
        setPreviewChapters([]);
        setChaptersTotal(0);
        setUnlocks(null);
      }

      setIsOfflineMode(false);
      setLoading(!cachedBook && !downloadedEntry);

      const fetchBook = async () => {
        try {
          const [booksData, unlocksData, chaptersData, previewChaptersData, bookProgressResponse, averageRes, ratingRes] = await Promise.all([
            bookService.fetchBook({ bookId: resolvedBookId }),
            bookUnlockService.getBookUnlockByUser({ book: resolvedBookId, unlockBy: user?.$id }),
            bookService.fetchBookChapters({
              bookId: resolvedBookId,
              status: "Publish",
              limit: previewChaptersLimit,
              select: BOOK_CHAPTER_LIST_SELECT,
            }),
            databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.booksChaptersCollectionId, [
              Query.equal("book", resolvedBookId),
              Query.equal("status", "Publish"),
              Query.orderDesc("order"),
              Query.limit(previewChaptersLimit),
              Query.select(BOOK_CHAPTER_LIST_SELECT),
            ]),
            bookService.getContinueReadingBook({ userId: user?.$id, bookId: resolvedBookId }),
            BookRatingService.getBookRatings({ bookId: resolvedBookId }),
            BookRatingService.getUserRating({ bookId: resolvedBookId, userId: user?.$id }),
          ]);

          setBook(booksData);
          setAverageRating(averageRes?.averageRating || 0);
          if (ratingRes) setUserRating(ratingRes);
          if (unlocksData.documents.length > 0) setUnlocks(unlocksData.documents[0]);
          setChapters(chaptersData.documents);
          setPreviewChapters(
            (previewChaptersData?.documents || []).filter((chapter, index) => !isIntroductionChapter(chapter, index)).slice(0, previewChaptersLimit),
          );
          setChaptersTotal(chaptersData.total);
          if (bookProgressResponse.documents.length > 0) setContinueReadingChapter(bookProgressResponse.documents[0]);

          if (booksData?.uploader?.$id) {
            const followingResponse = await FollowService.isFollowing({ followerId: user?.$id, followingId: booksData?.uploader?.$id });
            setIsFollowing(followingResponse);
          } else {
            setIsFollowing(false);
          }
          setIsOfflineMode(false);
        } catch (err) {
          const offlineDownload = resolvedBookId ? getDownloadedBook(resolvedBookId) : null;
          const offlineBook = offlineDownload?.book || findCachedBook();

          if (!offlineBook) {
            console.error(err);
            return;
          }

          setBook(offlineBook);
          if (cachedContinueReading) setContinueReadingChapter(cachedContinueReading);

          if (offlineDownload?.chapters?.length) {
            setChapters(offlineDownload.chapters);
            setPreviewChapters([]);
            setChaptersTotal(offlineDownload.chapters.length);
            setUnlocks({ chapters: offlineDownload.chapterIds || offlineDownload.chapters.map((chapter) => chapter.$id) });
            setIsDownloaded(true);
          } else {
            setChapters([]);
            setPreviewChapters([]);
            setChaptersTotal(0);
            setUnlocks(null);
          }
          setIsOfflineMode(true);
        } finally {
          setLoading(false);
        }
      };
      fetchBook();
    }, [resolvedBookId, user?.$id, cachedContinueReading, findCachedBook]),
  );

  if (loading) {
    return (
      <SafeAreaView edges={["top"]} className="flex-1" style={{ backgroundColor: theme.background }}>
        <View className="flex-row items-center justify-between px-4 py-3">
          <AnimatedSkeleton className="h-6 w-6 rounded-full" />
          <View className="flex-row space-x-4">
            <AnimatedSkeleton className="h-5 w-5 rounded-full" />
            <AnimatedSkeleton className="h-5 w-5 rounded-full" />
            <AnimatedSkeleton className="h-5 w-5 rounded-full" />
          </View>
        </View>

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 50 }}>
          <View className="items-center px-4 pb-1">
            <AnimatedSkeleton className="h-64 w-44 rounded-lg" />
          </View>

          <View className="mt-3 items-center space-y-3 px-4">
            <AnimatedSkeleton className="h-6 w-32 rounded" />
            <AnimatedSkeleton className="h-4 w-24 rounded" />
            <View className="flex-row items-center space-x-3">
              <AnimatedSkeleton className="h-6 w-6 rounded-full" />
              <AnimatedSkeleton className="h-4 w-20 rounded" />
              <AnimatedSkeleton className="h-6 w-16 rounded" />
            </View>
          </View>

          <View className="mt-6 px-4">
            <AnimatedSkeleton className="h-12 w-full rounded-full" />
          </View>

          <View className="mt-4 flex-row space-x-2 px-4">
            {Array.from({ length: 3 }).map((_, idx) => (
              <AnimatedSkeleton key={idx} className="h-8 flex-1 rounded-full" />
            ))}
          </View>

          <View className="mt-4 px-4">
            <AnimatedSkeleton className="h-5 rounded" style={{ width: getRandomSkeletonWidth() }} />
            <AnimatedSkeleton className="mt-2 h-5 rounded" style={{ width: getRandomSkeletonWidth() }} />
            <AnimatedSkeleton className="mt-2 h-5 rounded" style={{ width: getRandomSkeletonWidth() }} />
          </View>

          <View
            className="mx-4 mt-3 space-y-2 rounded-lg px-2 py-4"
            style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}
          >
            {Array.from({ length: 4 }).map((_, idx) => (
              <AnimatedSkeleton key={idx} className="h-4 w-full rounded" />
            ))}
          </View>

          <View
            className="mx-4 mt-3 space-y-3 rounded-lg px-2 pt-4"
            style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}
          >
            {Array.from({ length: 3 }).map((_, idx) => (
              <View key={idx} className="flex-row items-center justify-between">
                <AnimatedSkeleton className="h-4 w-40 rounded" />
                <AnimatedSkeleton className="h-3 w-24 rounded" />
              </View>
            ))}
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  const onChapterSelect = (chapter, index) => {
    const isChapterLocked = BookUnlocksService.isChapterLocked({
      book,
      bookChapterLockStart,
      chapter,
      index,
      unlocks,
      currentUserId: user?.$id,
    });

    if (isChapterLocked) {
      setSelectedChapter(chapter);
      setChapterUnlockVisible(true);
    } else {
      router.push({
        pathname: "book-reading",
        params: {
          chapterId: chapter.$id,
        },
      });
      setChaptersVisible(false);
    }
  };

  const toggleChaptersVisible = () => {
    setChaptersVisible((prev) => !prev);
  };

  const toggleChapterUnlockVisible = () => {
    setChapterUnlockVisible((prev) => !prev);
  };

  const handleGoToStore = () => {
    setChaptersVisible(false);
    setChapterUnlockVisible(false);
    router.push("/store");
  };

  const handleProceedToChapter = () => {
    setChaptersVisible(false);
    setChapterUnlockVisible(false);
    router.push({
      pathname: "book-reading",
      params: {
        chapterId: selectedChapter.$id,
      },
    });
  };

  const handleSubmitRating = async (ratingValue) => {
    try {
      setRatingSubmitting(true);
      await BookRatingService.createRating({
        bookId: resolvedBookId,
        userId: user?.$id,
        rating: ratingValue,
      });

      // Refresh average rating after submission
      const updatedAvg = await BookRatingService.getBookRatings({ bookId: resolvedBookId });
      setAverageRating(updatedAvg?.average || ratingValue);
      setUserRating({ rating: ratingValue });
      Alert.alert("Success", "Thanks for rating this book!");
    } catch (err) {
      console.error(err);
      Alert.alert("Error", "Failed to submit rating. Please try again.");
    }
  };

  const handleSharePress = async () => {
    await Share.open({
      message: `Check out this book!`,
      url: `${secrets.WEBSITE}/books/${book?.$id}`,
      title: `${book.title}`,
      type: "url",
    });
  };

  const ensureBookInLibrary = async () => {
    if (!book?.$id || !user?.$id) return null;
    try {
      const existing = await bookService.getBookLibrayByUser({ bookId: book.$id, userId: user.$id });
      if (existing?.documents?.length > 0) return existing.documents[0];
      return await bookService.createBookLibrary({ bookId: book.$id, userId: user.$id });
    } catch (error) {
      console.log("ensureBookInLibrary: error", error);
      return null;
    }
  };

  const fetchAllBookChapters = async () => {
    const response = await bookService.fetchAllBookChapters({
      bookId: resolvedBookId,
      status: "Publish",
      limit: 50,
    });

    return { chapters: response.documents || [], total: response.total ?? response.documents?.length ?? 0 };
  };

  const handleDownload = async () => {
    if (!resolvedBookId || !book || isDownloading) return;
    if (isDownloaded) {
      Alert.alert("Already downloaded", "This book is available offline.");
      return;
    }
    if (book?.isLocked && (bookChapterLockStart === undefined || bookChapterLockStart === null)) {
      Alert.alert("Please wait", "Book settings are still loading. Try again in a moment.");
      return;
    }

    try {
      setIsDownloading(true);
      const unlocksData = await bookUnlockService.getBookUnlockByUser({ book: resolvedBookId, unlockBy: user?.$id });
      const unlockDocument = unlocksData?.documents?.[0];
      const { chapters: allChapters } = await fetchAllBookChapters();

      if (!allChapters.length) {
        Alert.alert("No chapters available", "There are no published chapters to download yet.");
        return;
      }

      const readableChapters = [];
      allChapters.forEach((chapter, index) => {
        const isLocked = BookUnlocksService.isChapterLocked({
          book,
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
        bookId: resolvedBookId,
        book,
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

  const handleAuthorPressed = () => {
    if (user?.$id === book?.uploader?.$id) router.push("/profile");
    else router.push({ pathname: "/creator-profile", params: { userId: book?.uploader?.$id } });
  };

  const handleStartReading = () => {
    if (continueReadingChapter?.lastChapter?.$id) {
      router.push({
        pathname: "book-reading",
        params: {
          chapterId: continueReadingChapter.lastChapter.$id,
        },
      });
    } else if (chapters[0]?.$id) {
      router.push({
        pathname: "book-reading",
        params: {
          chapterId: chapters[0]?.$id,
        },
      });
    } else {
      Alert.alert("No chapters available", "This book has no readable chapters yet.");
    }
  };

  const TAGS = [book?.status, book?.contentRating || "Rated PG", book?.isLocked ? "Paid" : "Free", isDownloaded ? "Downloaded" : null].filter(
    Boolean,
  );

  return (
    <SafeAreaView edges={["top"]} className="flex-1" style={{ backgroundColor: theme.background }}>
      {/* HEADER */}
      <View className="flex-row items-center justify-between px-4 py-3">
        <TouchableOpacity onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color={theme.icon} />
        </TouchableOpacity>
        <View className="flex-row space-x-4" style={{ opacity: book ? 1 : 0 }}>
          <TouchableOpacity
            onPress={handleDownload}
            disabled={isDownloading || isDownloaded}
            className={isDownloading || isDownloaded ? "opacity-50" : ""}
          >
            {isDownloading ? (
              <ActivityIndicator size="small" color={theme.primary} />
            ) : (
              <Ionicons
                name={isDownloaded ? "checkmark-circle" : "download-outline"}
                size={22}
                color={isDownloaded ? theme.accentGreen : theme.icon}
              />
            )}
          </TouchableOpacity>
          <TouchableOpacity onPress={handleSharePress}>
            <ShareIcon width={22} height={22} color={theme.icon} />
          </TouchableOpacity>
          <TouchableOpacity>
            <Ionicons name="flag-outline" size={22} color={theme.icon} />
          </TouchableOpacity>
        </View>
      </View>

      {!book ? (
        <ContentNotFound type={"Book"} iconName={"book-remove-outline"} />
      ) : (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 50 }}>
          {/* BOOK COVER */}
          <View className="items-center px-4 pb-1">
            <View className="relative">
              <FastImage
                source={{ uri: book?.thumbnail, priority: FastImage.priority.high }}
                className="h-64 w-44 rounded-lg"
                style={{ backgroundColor: theme.surfaceMuted }}
                resizeMode={"cover"}
              />

              {/* Rate this Book */}
              {!userRating && (
                <TouchableOpacity
                  disabled={ratingSubmitting}
                  onPress={() => setRatingVisible(true)}
                  className="absolute -bottom-0 -right-6 flex-row items-center rounded-full px-3 py-1 shadow-lg"
                  style={{
                    backgroundColor: ratingSubmitting ? theme.surfaceStrong : theme.coin,
                    elevation: 5, // Android shadow
                  }}
                >
                  {ratingSubmitting ? (
                    <ActivityIndicator color={theme.primaryContrast} />
                  ) : (
                    <SimpleLineIcons name="like" size={20} color={theme.textInverse} />
                  )}
                </TouchableOpacity>
              )}
            </View>
          </View>

          {/* BOOK RATING */}
          <TouchableOpacity disabled={!!userRating || ratingSubmitting} onPress={() => setRatingVisible(true)}>
            <BookRating rating={averageRating || 0} starSize={20} spacing={5} />
          </TouchableOpacity>

          {/* TITLE + UPLOADER */}
          <View className="mt-3 items-center">
            <Text className="px-2.5 text-center text-2xl font-bold" style={{ color: theme.text }}>
              {book?.title}
            </Text>
            <TouchableOpacity onPress={handleAuthorPressed} className="mt-2 flex-row items-center space-x-2">
              <Text className="text-sm font-medium" style={{ color: theme.textMuted }}>
                by{" "}
              </Text>
              <FastImage source={{ uri: book?.uploader?.avatar }} className="h-6 w-6 rounded-full" />
              <View className="flex-row items-center">
                <Text className="text-sm font-bold" style={{ color: theme.textMuted }}>
                  {book?.uploader?.username}
                </Text>
                <UserRoleBadgeIcons user={book?.uploader} size={16} />
              </View>
              <View className="rounded-lg border px-2" style={{ borderColor: theme.accentPurple, backgroundColor: theme.accentPurpleSoft }}>
                <Text className="text-xs" style={{ color: theme.accentPurple }}>
                  {isFollowing ? "Following" : "Follow"}
                </Text>
              </View>
            </TouchableOpacity>
          </View>

          {/* STATS */}
          <BookInfoStats
            book={book}
            chaptersTotal={displayedChaptersTotal}
            toggleChaptersVisible={toggleChaptersVisible}
            openComments={openCommentsParam}
            focusCommentId={focusCommentIdParam}
            focusReplyId={focusReplyIdParam}
          />

          {/* START READING */}
          <View className="mt-6 px-4">
            <TouchableOpacity
              onPress={handleStartReading}
              className="flex-row items-center justify-center rounded-full py-3"
              style={{ backgroundColor: theme.accentPurple }}
            >
              <Ionicons name="book-outline" size={20} color={theme.primaryContrast} />
              <Text className="ml-2 font-semibold" style={{ color: theme.primaryContrast }}>
                {`${continueReadingChapter ? "Continue" : "Start"} Reading ${continueReadingChapter ? `: ${getBookChapterSectionLabel(continueReadingChapter?.lastChapter)}` : ""}`}
              </Text>
            </TouchableOpacity>
          </View>

          <View className="mt-4 flex-row px-4">
            {TAGS.map((tag, index) => (
              <BookTag tagName={tag} key={index} />
            ))}
          </View>

          {/* TAGS */}
          <View className="mt-2 flex-row flex-wrap px-4">
            {book?.tags?.map((tag, i) => (
              <View key={i} className="mb-2 mr-2 rounded-full px-3 py-1" style={{ backgroundColor: theme.surfaceMuted }}>
                <Text className="text-xs" style={{ color: theme.text }}>
                  {tag}
                </Text>
              </View>
            ))}
          </View>

          {/* SYNOPSIS */}
          <View className="mx-4 mt-3 rounded-lg px-2 py-4" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
            <Text className="text-base" style={{ color: theme.textMuted }}>
              {book?.synopsis}
            </Text>
          </View>

          {/* PARTS LIST */}
          <View className="mx-4 mt-3 rounded-lg px-2 pt-4" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
            <View className="mb-3 flex-row items-center justify-between">
              <View className="flex-row items-center space-x-2">
                <AntDesign name="bars" color={theme.icon} size={25} />
                <Text className="text-lg font-semibold" style={{ color: theme.text }}>
                  {displayedChaptersTotal} Parts
                </Text>
              </View>
              <TouchableOpacity onPress={toggleChaptersVisible}>
                <Text className="text-sm" style={{ color: theme.primary }}>
                  See all
                </Text>
              </TouchableOpacity>
            </View>

            {displayedPreviewChapters.map((c, idx) => (
              <TouchableOpacity key={c.$id} onPress={() => onChapterSelect(c, idx)} className="mb-3 flex-row items-start">
                <Text className="flex-1 pr-3 text-base" style={{ color: theme.textMuted }}>
                  {c.title}
                </Text>
                <Text className="shrink-0 text-right text-xs" style={{ color: theme.textSoft }}>
                  {new Date(c.$createdAt).toDateString()}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>
      )}
      <BookChaptersModal
        isVisible={chaptersVisible}
        onClose={toggleChaptersVisible}
        chapters={chapters}
        book={book}
        unlocks={unlocks}
        onSelect={onChapterSelect}
        useInitialChaptersOnly={isOfflineMode}
      />
      <BookChaptersUnlockModal
        isVisible={chapterUnlockVisible}
        onClose={toggleChapterUnlockVisible}
        chapters={chapters}
        chaptersTotal={chaptersTotal}
        book={book}
        unlocks={unlocks}
        selectedChapter={selectedChapter}
        onSelect={onChapterSelect}
        handleGoToStore={handleGoToStore}
        onSuccessUnlock={handleProceedToChapter}
      />

      <BookRatingModal isVisible={ratingVisible} onClose={() => setRatingVisible(false)} onSubmit={handleSubmitRating} />
    </SafeAreaView>
  );
};

export default BookInfo;
