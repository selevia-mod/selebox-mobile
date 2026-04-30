import { Ionicons, MaterialIcons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { useBookStats } from "../context/book-stats-provider";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import { BookReadService } from "../lib/book-reads";
import { BookService } from "../lib/books";
import FormatNumber from "../lib/utils/format-number";
import { consumePostCommentModalResume } from "../lib/post-comment-modal-resume";
import AnimatedSkeleton from "./AnimatedSkeleton";
import BookCommentModal from "./BookCommentModal";
import BookReadingListModal from "./BookReadingListModal";

const BookInfoStats = ({
  book,
  chapters = [],
  chaptersTotal,
  toggleChaptersVisible,
  openComments = false,
  focusCommentId = null,
  focusReplyId = null,
}) => {
  const { theme } = useAppTheme();
  const { user } = useGlobalContext();
  const { getBookStats, updateBookStats, toggleLike } = useBookStats();
  const [bookmarked, setBookmarked] = useState(false);
  const [bookmarkTotal, setBookmarkTotal] = useState(0);
  const [isBookStatsLoading, setIsBookStatsLoading] = useState(true);
  const [isCommentModalVisible, setCommentModalVisible] = useState(false);
  const [commentModalFocus, setCommentModalFocus] = useState({ focusCommentId: null, focusReplyId: null });
  const [commentModalResumeToken, setCommentModalResumeToken] = useState(null);
  const [isReadingListModalVisible, setReadingListModalVisible] = useState(false);
  const [readTotal, setReadTotal] = useState(0);

  const bookService = new BookService();
  const disableActions = book?.status === "Draft";
  const bookId = book?.$id;
  const commentResumeScope = useMemo(() => `book-info-comment:${String(bookId || "unknown")}`, [bookId]);
  const sharedStats = getBookStats(bookId);
  const autoOpenKeyRef = useRef(null);

  useFocusEffect(
    useCallback(() => {
      if (!bookId) return;
      const pendingResume = consumePostCommentModalResume(commentResumeScope);
      if (!pendingResume?.postId) return;
      if (String(pendingResume.postId) !== String(bookId)) return;
      setCommentModalFocus({ focusCommentId: null, focusReplyId: null });
      setCommentModalResumeToken(pendingResume.token || null);
      setCommentModalVisible(true);
    }, [bookId, commentResumeScope]),
  );

  useEffect(() => {
    if (!bookId) return;

    const shouldOpenComments = openComments || Boolean(focusCommentId || focusReplyId);
    if (!shouldOpenComments) return;

    const openKey = `${bookId}:${focusCommentId || ""}:${focusReplyId || ""}`;
    if (autoOpenKeyRef.current === openKey) return;

    autoOpenKeyRef.current = openKey;
    setCommentModalFocus({
      focusCommentId: focusCommentId || null,
      focusReplyId: focusReplyId || null,
    });

    const timer = setTimeout(() => {
      setCommentModalResumeToken(null);
      setCommentModalVisible(true);
    }, 120);

    return () => clearTimeout(timer);
  }, [bookId, focusCommentId, focusReplyId, openComments]);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setIsBookStatsLoading(true);
        await Promise.all([
          fetchIsBookLiked(),
          fetchIsBookmarked(),
          fetchBookLikes(),
          fetchBookBookmarks(),
          fetchBookComments(),
          fetchBookReadTotal(),
        ]);
      } catch (error) {
        console.log("fetchData error", error);
      } finally {
        setIsBookStatsLoading(false);
      }
    };
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, user?.$id]);

  const fetchBookLikes = async () => {
    try {
      const bookLikes = await bookService.getBookLikes({ bookId });
      updateBookStats(bookId, { likeCount: bookLikes.total });
    } catch (error) {
      console.log("fetchBookLikes: error", error);
    }
  };

  const fetchIsBookLiked = async () => {
    try {
      const isLikedData = await bookService.getBookLikeByOwner({ bookId, likeOwner: user?.$id });
      if (isLikedData?.documents?.length > 0) {
        updateBookStats(bookId, { liked: true });
      } else {
        updateBookStats(bookId, { liked: false });
      }
    } catch (error) {
      console.log("fetchIsBookLiked: error", error);
    }
  };

  const fetchBookBookmarks = async () => {
    try {
      const bookBookmarks = await bookService.getBookLibraries({ bookId });
      setBookmarkTotal(bookBookmarks.total);
    } catch (error) {
      console.log("fetchBookBookmarks: error", error);
    }
  };

  const fetchIsBookmarked = async () => {
    try {
      const isBookmarkedData = await bookService.getBookLibrayByUser({ bookId, userId: user?.$id });
      if (isBookmarkedData?.documents?.length > 0) {
        setBookmarked(true);
      } else {
        setBookmarked(false);
      }
    } catch (error) {
      console.log("fetchIsBookmarked: error", error);
    }
  };

  const fetchBookComments = async () => {
    try {
      const bookComments = await bookService.getBookComments({ bookId });
      updateBookStats(bookId, { commentCount: bookComments.total });
    } catch (error) {
      console.log("fetchBookComments: error", error);
    }
  };

  const fetchBookReadTotal = async () => {
    try {
      const bookRead = await BookReadService.fetchBookRead({ bookId });
      setReadTotal(bookRead?.totalReads ?? 0);
    } catch (error) {
      console.log("fetchBookReadTotal: error", error);
    }
  };

  const handleLike = async () => {
    try {
      await toggleLike(bookId, user?.$id);
    } catch (error) {
      console.log("handleLike error", error);
    }
  };

  const handleAddToLibrary = async () => {
    try {
      const existingBookMark = await bookService.getBookLibrayByUser({ bookId, userId: user?.$id });
      if (existingBookMark?.documents?.length > 0) {
        setBookmarked(true);
        return false;
      }

      setBookmarked(true);
      setBookmarkTotal((prev) => prev + 1);
      await bookService.createBookLibrary({ bookId, userId: user?.$id });
      return true;
    } catch (error) {
      setBookmarked(false);
      setBookmarkTotal((prev) => Math.max(0, prev - 1));
      console.log("handleAddToLibrary: error", error);
      throw error;
    }
  };

  return (
    <>
      <View className="mt-4 flex-row justify-between">
        {isBookStatsLoading ? (
          <>
            <View className="flex-1 items-center">
              <AnimatedSkeleton className="h-5 w-5 rounded-md" />
              <AnimatedSkeleton className="mt-1 h-4 w-6 rounded" />
              <AnimatedSkeleton className="mt-1 h-4 w-10 rounded" />
            </View>
            <View className="flex-1 items-center">
              <AnimatedSkeleton className="h-5 w-5 rounded-md" />
              <AnimatedSkeleton className="mt-1 h-4 w-6 rounded" />
              <AnimatedSkeleton className="mt-1 h-4 w-10 rounded" />
            </View>
            <View className="flex-1 items-center">
              <AnimatedSkeleton className="h-5 w-5 rounded-md" />
              <AnimatedSkeleton className="mt-1 h-4 w-6 rounded" />
              <AnimatedSkeleton className="mt-1 h-4 w-10 rounded" />
            </View>
            <View className="flex-1 items-center">
              <AnimatedSkeleton className="h-5 w-5 rounded-md" />
              <AnimatedSkeleton className="mt-1 h-4 w-6 rounded" />
              <AnimatedSkeleton className="mt-1 h-4 w-10 rounded" />
            </View>
            <View className="flex-1 items-center">
              <AnimatedSkeleton className="h-5 w-5 rounded-md" />
              <AnimatedSkeleton className="mt-1 h-4 w-6 rounded" />
              <AnimatedSkeleton className="mt-1 h-4 w-10 rounded" />
            </View>
          </>
        ) : (
          <>
            <TouchableOpacity disabled={true} className="flex-1 items-center">
              <Ionicons name={"eye-outline"} size={20} color={theme.iconMuted} />
              <Text className="text-sm font-bold" style={{ color: theme.textMuted }}>{FormatNumber(readTotal ?? 0)}</Text>
              <Text className="text-xs" style={{ color: theme.textSoft }}>Reads</Text>
            </TouchableOpacity>
            <TouchableOpacity disabled={disableActions} onPress={handleLike} className="flex-1 items-center">
              <Ionicons name={`${sharedStats.liked ? "heart" : "heart-outline"}`} size={20} color={sharedStats.liked ? theme.like : theme.iconMuted} />
              <Text className="text-sm font-bold" style={{ color: theme.textMuted }}>{FormatNumber(sharedStats.likeCount ?? 0)}</Text>
              <Text className="text-xs" style={{ color: theme.textSoft }}>Hearts</Text>
            </TouchableOpacity>
            <TouchableOpacity
              disabled={disableActions}
              onPress={() => {
                setCommentModalFocus({ focusCommentId: null, focusReplyId: null });
                setCommentModalResumeToken(null);
                setCommentModalVisible(true);
              }}
              className="flex-1 items-center"
            >
              <Ionicons name="chatbubble-outline" size={20} color={theme.iconMuted} />
              <Text className="text-sm font-bold" style={{ color: theme.textMuted }}>{FormatNumber(sharedStats.commentCount ?? 0)}</Text>
              <Text className="text-xs" style={{ color: theme.textSoft }}>Comments</Text>
            </TouchableOpacity>
            <TouchableOpacity disabled={disableActions} onPress={() => setReadingListModalVisible(true)} className="flex-1 items-center">
              <MaterialIcons name={`${bookmarked ? "bookmark-added" : "bookmark-add"}`} size={20} color={bookmarked ? theme.accentPurple : theme.iconMuted} />
              <Text className="text-sm font-bold" style={{ color: theme.textMuted }}>{FormatNumber(bookmarkTotal ?? 0)}</Text>
              <Text className="text-xs" style={{ color: theme.textSoft }}>Saves</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={toggleChaptersVisible} className="flex-1 items-center">
              <Ionicons name="list-outline" size={20} color={theme.iconMuted} />
              <Text className="text-sm font-bold" style={{ color: theme.textMuted }}>{chaptersTotal}</Text>
              <Text className="text-xs" style={{ color: theme.textSoft }}>Parts</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
      <BookReadingListModal
        isVisible={isReadingListModalVisible}
        onClose={() => setReadingListModalVisible(false)}
        userId={user?.$id}
        bookId={bookId}
        isBookInLibrary={bookmarked}
        onAddToLibrary={handleAddToLibrary}
      />
      <BookCommentModal
        isVisible={isCommentModalVisible}
        book={book}
        focusCommentId={commentModalFocus.focusCommentId}
        focusReplyId={commentModalFocus.focusReplyId}
        onClose={() => {
          setCommentModalVisible(false);
          setCommentModalFocus({ focusCommentId: null, focusReplyId: null });
          setCommentModalResumeToken(null);
        }}
        resumeScope={commentResumeScope}
        resumeToken={commentModalResumeToken}
      />
    </>
  );
};

export default BookInfoStats;
