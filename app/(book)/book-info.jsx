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
import axios from "axios";
import {
  BookChaptersModal,
  BookChaptersUnlockModal,
  BookInfoStats,
  BookRating,
  BookRatingModal,
  BookTag,
  ContentNotFound,
  ReportModal,
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
  const [showReportModal, setShowReportModal] = useState(false);
  const [reportDetail, setReportDetail] = useState("");
  const [reportLoading, setReportLoading] = useState(false);

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

  const handleOpenReport = () => {
    setShowReportModal(true);
  };

  const handleCloseReport = () => setShowReportModal(false);

  // Mirrors the email-based report flow used by StyledPlaylistButton (videos)
  // and ProfileActionsMenu (users). Lands in the admin inbox via the existing
  // appwrite.global function until Phase 5 unifies all reports under
  // contentReportsCollection.
  const handleSubmitReport = async (reportDetails) => {
    Alert.alert(
      "Report book",
      "Are you sure you want to report this book? Confirming will submit your report for review by our team.",
      [
        { text: "No", style: "cancel" },
        {
          text: "Yes",
          onPress: async () => {
            setReportLoading(true);
            try {
              const adminEmails = (() => {
                try {
                  return JSON.parse(globalSettings?.["ADMIN_EMAILS"] || "[]").join(",");
                } catch {
                  return "";
                }
              })();
              const bccEmails = (() => {
                try {
                  return JSON.parse(globalSettings?.["BCC_EMAILS"] || "[]").join(",");
                } catch {
                  return "";
                }
              })();
              const response = await axios.post("https://67e9284815c6fe834817.appwrite.global", {
                from: "selebox.dev@gmail.com",
                to: adminEmails,
                cc: user?.email,
                bcc: bccEmails,
                subject: `${user?.username} | Selebox | Reported Book`,
                html: `
                  <p><strong>Dear Selebox Team,</strong></p>
                  <p>I am writing to report this book <b><u>${secrets.WEBSITE}/books/${book?.$id}</u></b> ("${book?.title}"). Please find this report for your review.</p>
                  <p><strong>Report Detail:</strong></p>
                  <p>${reportDetails}</p>
                  <p>Thank you for your time and consideration.</p>
                  <p>Best regards,<br>
                  ${user?.username}<br>
                  ${user?.accountId}<br>
                  ${user?.email}<br>
                  ${new Date(user?.$createdAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</p>`,
              });
              if (response.data?.success) {
                setReportDetail("");
                setShowReportModal(false);
                Alert.alert("Success", "Your report has been submitted for review.");
              } else {
                Alert.alert("Error", "There was an error submitting your report. Please try again.");
              }
            } catch (error) {
              Alert.alert("Error", error?.message || "Failed to submit report.");
            }
            setReportLoading(false);
          },
        },
      ],
      { cancelable: true },
    );
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
      {/* HEADER — premium icon pills matching the MainScreensHeader / Books-pill
          design language: 36×36 surfaceMuted disc, subtle border, 18px icon.
          Each action is now a self-contained pill with consistent hit area and
          obvious affordance, replacing the bare-icon row. The flag now opens
          the existing ReportModal flow (mirrors video / profile reports). */}
      <View className="flex-row items-center justify-between px-4 py-3">
        <TouchableOpacity
          onPress={() => router.back()}
          accessibilityLabel="Back"
          style={{
            height: 36,
            width: 36,
            borderRadius: 18,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: theme.surfaceMuted,
            borderWidth: 1,
            borderColor: theme.border,
          }}
        >
          <Ionicons name="arrow-back" size={18} color={theme.icon} />
        </TouchableOpacity>
        <View className="flex-row" style={{ gap: 8, opacity: book ? 1 : 0 }}>
          <TouchableOpacity
            onPress={handleDownload}
            disabled={isDownloading || isDownloaded}
            accessibilityLabel={isDownloaded ? "Downloaded" : "Download book"}
            style={{
              height: 36,
              width: 36,
              borderRadius: 18,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: theme.surfaceMuted,
              borderWidth: 1,
              borderColor: theme.border,
              opacity: isDownloading || isDownloaded ? 0.7 : 1,
            }}
          >
            {isDownloading ? (
              <ActivityIndicator size="small" color={theme.primary} />
            ) : (
              <Ionicons
                name={isDownloaded ? "checkmark-circle" : "download-outline"}
                size={18}
                color={isDownloaded ? theme.accentGreen : theme.icon}
              />
            )}
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleSharePress}
            accessibilityLabel="Share book"
            style={{
              height: 36,
              width: 36,
              borderRadius: 18,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: theme.surfaceMuted,
              borderWidth: 1,
              borderColor: theme.border,
            }}
          >
            <ShareIcon width={18} height={18} color={theme.icon} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleOpenReport}
            accessibilityLabel="Report book"
            style={{
              height: 36,
              width: 36,
              borderRadius: 18,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: theme.surfaceMuted,
              borderWidth: 1,
              borderColor: theme.border,
            }}
          >
            <Ionicons name="flag-outline" size={18} color={theme.icon} />
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

      <ReportModal
        type="Book"
        isVisible={showReportModal}
        onClose={handleCloseReport}
        handleSubmitReport={handleSubmitReport}
        reportDetail={reportDetail}
        setReportDetail={setReportDetail}
        reportLoading={reportLoading}
      />
    </SafeAreaView>
  );
};

export default BookInfo;
