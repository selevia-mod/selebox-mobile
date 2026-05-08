import { createContext, useCallback, useContext, useRef, useState } from "react";
import { BookChapterCommentsService } from "../lib/book-chapter-comments";
import { BookService } from "../lib/books";

// Comment counts (May 2026 onward) come from the chapter-comments
// aggregator across every chapter of the book, NOT from the legacy
// book_comments table. Centralized here so every consumer of book
// stats (BookInfoStats, BookCatalogCard, BookCard via context) sees
// the same number.
const fetchAggregatedCommentCount = async (bookId) => {
  try {
    const result = await BookChapterCommentsService.fetchBookAggregatedChapterComments?.({ bookId });
    return result?.total || 0;
  } catch (error) {
    console.warn("[book-stats-provider] aggregated comment count failed:", error?.message);
    return 0;
  }
};

const BookStatsContext = createContext();

export const BookStatsProvider = ({ children }) => {
  const [stats, setStats] = useState({}); // { book_<id>: { liked, likeCount, commentCount, inLibrary } }
  const bookService = new BookService();
  const statsRef = useRef(stats);
  const debounceTimersRef = useRef(new Map());

  statsRef.current = stats;

  const updateBookStats = useCallback((bookId, data) => {
    setStats((prev) => ({
      ...prev,
      [bookId]: { ...(prev[bookId] || {}), ...data },
    }));
  }, []);

  const getBookStats = useCallback(
    (bookId) =>
      stats[bookId] || {
        liked: false,
        likeCount: 0,
        commentCount: 0,
        inLibrary: false,
      },
    [stats],
  );

  const syncBookLike = async (bookId, userId) => {
    try {
      const current = statsRef.current[bookId] || {};
      if (current.liked) {
        const existing = await bookService.getBookLikeByOwner({ bookId, likeOwner: userId });
        if (existing?.documents?.length === 0) await bookService.createBookLike({ bookId, likeOwner: userId });
      } else {
        const existing = await bookService.getBookLikeByOwner({ bookId, likeOwner: userId });
        // Pass bookId + likeOwner so the dual-write side can delete by
        // composite (book_id, user_id). The bookLikeId alone wouldn't help
        // Supabase since its rows have UUIDs, not Appwrite hex strings.
        if (existing?.documents?.length > 0)
          await bookService.deleteBookLike({ bookLikeId: existing.documents[0].$id, bookId, likeOwner: userId });
      }
    } catch (error) {
      console.error("syncBookLike error:", error);
    }
  };

  const toggleLike = useCallback(
    (bookId, userId) => {
      const current = stats[bookId] || {};
      const optimisticLiked = !current.liked;
      const optimisticLikeCount = optimisticLiked ? (current.likeCount || 0) + 1 : Math.max((current.likeCount || 1) - 1, 0);

      updateBookStats(bookId, { liked: optimisticLiked, likeCount: optimisticLikeCount });

      if (debounceTimersRef.current.has(bookId)) clearTimeout(debounceTimersRef.current.get(bookId));
      debounceTimersRef.current.set(
        bookId,
        setTimeout(() => syncBookLike(bookId, userId), 500),
      );
    },
    [stats, updateBookStats],
  );

  /**
   * Optimistically increment the comment count when a comment is added.
   */
  const addComment = useCallback(
    (bookId) => {
      const current = stats[bookId] || {};
      updateBookStats(bookId, {
        commentCount: (current.commentCount || 0) + 1,
      });
    },
    [updateBookStats],
  );

  /**
   * Fetch the actual comment count from Appwrite to ensure it's up to date.
   * Can be called whenever the book info screen is focused or modal is opened.
   */
  const syncBookComments = useCallback(
    async (bookId) => {
      const total = await fetchAggregatedCommentCount(bookId);
      updateBookStats(bookId, { commentCount: total });
    },
    [updateBookStats],
  );

  /**
   * Load all book stats (likes, comments, liked status) in parallel.
   * Used to initialize stats when a book appears in the feed.
   */
  const loadBookStats = useCallback(
    async (bookId, userId) => {
      if (!bookId || !userId) return;

      // Skip if already loaded (optimization)
      if (stats[bookId]?.likeCount !== undefined) {
        return;
      }

      try {
        // Comment count fans out to the chapter-comments aggregator;
        // the other two stay on the bookService since they're book-row
        // direct (likes_count column / per-user like-status row).
        const [likeCountRes, actualCommentCount, likeStatusRes] = await Promise.all([
          bookService.getBookLikes({ bookId }),
          fetchAggregatedCommentCount(bookId),
          bookService.getBookLikeByOwner({ bookId, likeOwner: userId }),
        ]);

        const actualLikeCount = likeCountRes?.total || 0;
        const isLiked = likeStatusRes?.documents?.length > 0;

        updateBookStats(bookId, {
          liked: isLiked,
          likeCount: actualLikeCount,
          commentCount: actualCommentCount,
        });
      } catch (error) {
        console.warn("loadBookStats error:", error);
      }
    },
    [updateBookStats, stats],
  );

  return (
    <BookStatsContext.Provider
      value={{
        stats,
        getBookStats,
        updateBookStats,
        toggleLike,
        addComment,
        syncBookComments,
        loadBookStats,
      }}
    >
      {children}
    </BookStatsContext.Provider>
  );
};

export const useBookStats = () => useContext(BookStatsContext);
