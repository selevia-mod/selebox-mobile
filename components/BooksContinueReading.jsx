// BooksContinueReading — Wattpad-style "Continue Reading" shelf.
//
// History
// -------
// v1 read from Redux state.books.continueReading, populated elsewhere by
// a separate getContinueReadingBook fetcher per book on the books tab
// load. That decoupled the read path from the write path: the shelf
// could show a stale chapter for several minutes after the user
// finished reading a chapter on book-reading.jsx.
//
// v2 (this) reads directly from BookReadService.fetchRecentReads with
// stale-while-revalidate caching. The fetcher embeds book metadata via
// a Supabase JOIN, so one query renders the whole shelf — no N+1 per-
// book fetches. The cache is keyed by userId so signing-in/out resets
// it cleanly.
//
// Refresh triggers
// ----------------
// • Mount — first paint hydrates from the module cache, then refetches
//   in the background unless TTL is fresh.
// • useFocusEffect — every time the home tab regains focus we refetch
//   so a chapter just finished elsewhere shows up here too.
// • The hook's invalidateBookProgress is fired by book-reading.jsx on
//   blur, so by the time the home tab refocuses the cache is empty
//   and we'll refetch regardless.

import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import { memo, useCallback, useEffect, useState } from "react";
import { FlatList, Text, View, useWindowDimensions } from "react-native";
import { useSelector } from "react-redux";
import useAppTheme from "../hooks/useAppTheme";
import { BookReadService } from "../lib/book-reads";
import BookCard from "./BookCard";
import BooksSectionTitle from "./BooksSectionTitle";

// 5min TTL — same as useBookProgress so book-info CTA and shelf agree.
const TTL_MS = 5 * 60 * 1000;
const CACHE = new Map(); // key: userId → { data, cachedAt }

// Map a book_reads row (with embedded book join) into the shape BookCard
// expects. The books-supabase mapRowToBook helper does the same thing,
// but importing it here would create a heavy dep — easier to inline a
// minimal shaper that produces the fields BookCard reads:
//   $id, title, thumbnail, status, isLocked, totalReads, averageRating
const shapeRow = (row) => {
  const book = row.book;
  if (!book) return null;
  // Prefer legacy_appwrite_id for $id so existing book-info routing
  // (which expects the legacy hex form for some Appwrite-migrated
  // books) keeps working. New books without a legacy id fall back
  // to the Supabase UUID.
  const $id = book.legacy_appwrite_id || book.id;
  return {
    book: {
      $id,
      id: book.id,
      legacy_appwrite_id: book.legacy_appwrite_id,
      title: book.title,
      thumbnail: book.thumbnail,
      status: book.status,
      isLocked: !!book.is_locked,
      bookChapterLockStart: Number(book.lock_from_chapter) || undefined,
      totalReads: Number(book.views_count) || 0,
      averageRating: Number(book.ratings_avg) || 0,
      ratingsCount: Number(book.ratings_count) || 0,
    },
    progress: {
      // Shape that BookCard's hasWattpadProgress branch consumes.
      lastChapterNumber: Number.isFinite(Number(row.last_chapter_number))
        ? Number(row.last_chapter_number)
        : null,
      lastScrollPct: Number.isFinite(Number(row.last_scroll_pct)) ? Number(row.last_scroll_pct) : 0,
      lastReadAt: row.last_read_at || null,
    },
    $id,
  };
};

const BooksContinueReading = () => {
  const { theme } = useAppTheme();
  const { width } = useWindowDimensions();
  const user = useSelector((state) => state.auth.user);
  const userId = user?.$id;

  const [items, setItems] = useState(() => {
    const cached = CACHE.get(userId || "");
    return cached?.data || [];
  });

  const refetch = useCallback(async () => {
    if (!userId) {
      setItems([]);
      return;
    }
    try {
      const rows = await BookReadService.fetchRecentReads?.({ userId, limit: 20 });
      const shaped = (rows || []).map(shapeRow).filter(Boolean);
      CACHE.set(userId, { data: shaped, cachedAt: Date.now() });
      setItems(shaped);
    } catch (error) {
      console.warn("[BooksContinueReading] fetch failed:", error?.message);
      // Don't blow away cached items on transient failure — better to
      // show a stale shelf than an empty one.
    }
  }, [userId]);

  // SWR on mount: paint cache instantly, refresh in background if stale.
  useEffect(() => {
    if (!userId) return;
    const cached = CACHE.get(userId);
    if (cached?.data) {
      setItems(cached.data);
      if (Date.now() - cached.cachedAt < TTL_MS) return;
    }
    refetch();
  }, [refetch, userId]);

  // Refetch when the home tab regains focus — covers the case where the
  // user was just reading a chapter and walked back to home. The
  // book-reading flush on blur primes book_reads with the latest
  // last_chapter_id, so the next focus pull renders the new state.
  useFocusEffect(
    useCallback(() => {
      refetch();
    }, [refetch]),
  );

  const renderItem = useCallback(({ item }) => {
    return <BookCard item={item.book} progress={item.progress} />;
  }, []);
  const keyExtractor = useCallback((item, index) => item?.$id || `continue-${index}`, []);

  return (
    <View className="space-y-2">
      <BooksSectionTitle title={"Continue Reading"} />
      <FlatList
        removeClippedSubviews={false}
        horizontal
        showsHorizontalScrollIndicator={false}
        keyExtractor={keyExtractor}
        data={items}
        renderItem={renderItem}
        initialNumToRender={6}
        maxToRenderPerBatch={6}
        windowSize={5}
        ListEmptyComponent={
          <View style={{ width }} className="flex-1 items-center justify-center px-4 py-12">
            <MaterialCommunityIcons name="book-open-page-variant" size={48} color={theme.textSubtle} />
            <Text className="mt-4 text-lg font-semibold" style={{ color: theme.text }}>
              Nothing to continue yet
            </Text>
            <Text className="mt-2 text-center text-sm" style={{ color: theme.textSoft }}>
              Books you start reading will show up here so you can{"\n"}
              jump back in right where you left off.
            </Text>
          </View>
        }
      />
    </View>
  );
};

export default memo(BooksContinueReading);
