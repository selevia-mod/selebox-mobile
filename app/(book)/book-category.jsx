// See-All landing page for every Books section. The same component handles:
//   - "Weekly Featured", "Fresh Reads", "Completed & Excellent Works",
//     "Continue Reading", "Recently Uploaded" — fixed sections with redux-backed seeds
//   - any tag-based category — falls back to BookService.fetchPublishedBooks
//
// Caching is layered three-deep so the page feels instant whenever possible:
//
//   1. Redux selector  — if the books slice already holds the section (the user
//      just came from the Books tab), seed initial state synchronously and skip
//      the network entirely.
//   2. Module TTL cache — for sections that DON'T live in redux, or for repeat
//      visits, a 5-minute LRU cache (createTtlCache) keys on the section name
//      and returns the last fetched array without round-tripping Appwrite.
//   3. Network         — fetched on cache miss or on user-initiated refresh.
//
// Pagination only applies to "Recently Uploaded" and tag categories (the only
// sections backed by stable cursor queries). The random-sampling sections
// (Weekly Featured / Fresh Reads / Completed & Excellent) return a fixed pool;
// pull-to-refresh re-rolls them.

import { AntDesign, MaterialIcons } from "@expo/vector-icons";
import { FlashList } from "@shopify/flash-list";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dimensions, RefreshControl, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useDispatch, useSelector } from "react-redux";
import BookCard from "../../components/BookCard";
import Loader from "../../components/Loader";
import { useGlobalContext } from "../../context/global-provider";
import useAppTheme from "../../hooks/useAppTheme";
import useResetOnBlur from "../../hooks/useResetOnBlur";
import { BookService, fetchRandomBook } from "../../lib/books";
import {
  setCategoryBooks,
  setCompletedExcellent,
  setContinueReading,
  setFreshRead,
  setRecentlyUploaded,
  setWeeklyFeatured,
} from "../../store/reducers/books";
import { createTtlCache } from "../../lib/utils/createTtlCache";

const { width: SCREEN_WIDTH } = Dimensions.get("window");

// 5-minute TTL on ad-hoc category fetches. Long enough that bouncing in/out
// of See All is free; short enough that creators publishing new books surface
// without a force quit.
const BOOK_CATEGORY_CACHE = createTtlCache({ ttlMs: 5 * 60 * 1000, maxEntries: 60 });

const FIXED_SECTIONS = {
  WEEKLY: "Weekly Featured",
  FRESH: "Fresh Reads",
  COMPLETED: "Completed & Excellent Works",
  CONTINUE: "Continue Reading",
  RECENTLY: "Recently Uploaded",
};

const FIXED_SECTION_LABELS = new Set(Object.values(FIXED_SECTIONS));

// Continue Reading items are progress entries (`{ book, bookChapters, ... }`),
// NOT books. Flatten so renderItem just sees a book document either way.
const flattenSectionItems = (items, section) => {
  if (!Array.isArray(items)) return [];
  if (section === FIXED_SECTIONS.CONTINUE) {
    return items.map((entry) => entry?.book).filter((book) => book && book.$id);
  }
  return items;
};

const BookCategory = () => {
  const { theme } = useAppTheme();
  const { category } = useLocalSearchParams();
  const sectionLabel = typeof category === "string" ? category : "";
  const isFixedSection = FIXED_SECTION_LABELS.has(sectionLabel);
  const { user } = useGlobalContext();
  const dispatch = useDispatch();
  const booksState = useSelector((state) => state.books);
  const bookServiceRef = useRef(new BookService());
  const flatListRef = useRef(null);

  // Compute initial seed synchronously so the very first render shows real
  // content — no spinner — whenever the user is coming straight from the
  // Books tab.
  const initialSeed = useMemo(() => {
    if (!sectionLabel) return [];

    if (sectionLabel === FIXED_SECTIONS.WEEKLY) return flattenSectionItems(booksState.weeklyFeatured, sectionLabel);
    if (sectionLabel === FIXED_SECTIONS.FRESH) return flattenSectionItems(booksState.freshRead, sectionLabel);
    if (sectionLabel === FIXED_SECTIONS.COMPLETED) return flattenSectionItems(booksState.completedExcellent, sectionLabel);
    if (sectionLabel === FIXED_SECTIONS.CONTINUE) return flattenSectionItems(booksState.continueReading, sectionLabel);
    if (sectionLabel === FIXED_SECTIONS.RECENTLY) return flattenSectionItems(booksState.recentlyUploaded, sectionLabel);

    // Tag category — first try redux, then the in-memory TTL cache.
    const fromRedux = booksState.categories?.[sectionLabel];
    if (Array.isArray(fromRedux) && fromRedux.length > 0) return fromRedux;

    const fromMemoryCache = BOOK_CATEGORY_CACHE.get(sectionLabel);
    if (Array.isArray(fromMemoryCache) && fromMemoryCache.length > 0) return fromMemoryCache;

    return [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [books, setBooks] = useState(initialSeed);
  const [loading, setLoading] = useState(initialSeed.length === 0);
  const [refreshing, setRefreshing] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [lastId, setLastId] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [showScrollUp, setShowScrollUp] = useState(false);
  useResetOnBlur(setRefreshing, setIsFetchingMore);

  // Pagination is only meaningful for sections backed by stable cursor queries.
  const supportsPagination = sectionLabel === FIXED_SECTIONS.RECENTLY || (!isFixedSection && sectionLabel.length > 0);

  const persistToRedux = useCallback(
    (label, fetched) => {
      if (label === FIXED_SECTIONS.WEEKLY) dispatch(setWeeklyFeatured(fetched));
      else if (label === FIXED_SECTIONS.FRESH) dispatch(setFreshRead(fetched));
      else if (label === FIXED_SECTIONS.COMPLETED) dispatch(setCompletedExcellent(fetched));
      else if (label === FIXED_SECTIONS.CONTINUE) dispatch(setContinueReading(fetched));
      else if (label === FIXED_SECTIONS.RECENTLY) dispatch(setRecentlyUploaded(fetched));
      else dispatch(setCategoryBooks({ category: label, books: fetched }));
    },
    [dispatch],
  );

  const fetchSection = useCallback(
    async ({ background = false } = {}) => {
      if (!sectionLabel) return;

      try {
        if (!background) setLoading(true);

        const bookService = bookServiceRef.current;
        let fetched = [];
        let nextLastId = null;
        let nextHasMore = false;

        if (sectionLabel === FIXED_SECTIONS.WEEKLY) {
          const res = await fetchRandomBook({ limit: 30 });
          fetched = res?.documents || [];
        } else if (sectionLabel === FIXED_SECTIONS.FRESH) {
          const res = await fetchRandomBook({ limit: 30 });
          fetched = res?.documents || [];
        } else if (sectionLabel === FIXED_SECTIONS.COMPLETED) {
          const res = await fetchRandomBook({ limit: 60, status: "Completed" });
          fetched = res?.documents || [];
        } else if (sectionLabel === FIXED_SECTIONS.CONTINUE) {
          const res = await bookService.fetchContinueReadingBooks({ userId: user?.$id });
          fetched = res?.documents || [];
        } else if (sectionLabel === FIXED_SECTIONS.RECENTLY) {
          const res = await bookService.fetchPublishedBooks({ limit: 60 });
          fetched = res?.documents || [];
          nextLastId = fetched.length > 0 ? (fetched[fetched.length - 1]?.$id ?? null) : null;
          nextHasMore = fetched.length >= 60;
        } else {
          // Tag-based category.
          const res = await bookService.fetchPublishedBooks({ category: sectionLabel, limit: 60 });
          fetched = res?.documents || [];
          nextLastId = fetched.length > 0 ? (fetched[fetched.length - 1]?.$id ?? null) : null;
          nextHasMore = fetched.length >= 60;
        }

        const flat = flattenSectionItems(fetched, sectionLabel);
        setBooks(flat);
        setLastId(nextLastId);
        setHasMore(nextHasMore);

        // Write through both caches: redux (cold-start hydration) + module
        // (re-entry within TTL renders synchronously).
        persistToRedux(sectionLabel, fetched);
        BOOK_CATEGORY_CACHE.set(sectionLabel, flat);
      } catch (err) {
        console.log("book-category fetch error", err?.message || err);
      } finally {
        if (!background) setLoading(false);
      }
    },
    [persistToRedux, sectionLabel, user?.$id],
  );

  const loadMore = useCallback(async () => {
    if (!supportsPagination || !hasMore || isFetchingMore || !lastId) return;
    setIsFetchingMore(true);
    try {
      const bookService = bookServiceRef.current;
      const res = await bookService.fetchPublishedBooks({
        ...(isFixedSection ? {} : { category: sectionLabel }),
        lastId,
        limit: 30,
      });
      const next = res?.documents || [];
      if (next.length === 0) {
        setHasMore(false);
        return;
      }

      setBooks((prev) => {
        const existingIds = new Set(prev.map((b) => b?.$id).filter(Boolean));
        const merged = [...prev, ...next.filter((b) => b?.$id && !existingIds.has(b.$id))];
        // Refresh the module cache so re-entry renders the merged list, not
        // just the first page.
        BOOK_CATEGORY_CACHE.set(sectionLabel, merged);
        return merged;
      });
      setLastId(next[next.length - 1]?.$id ?? null);
      setHasMore(next.length >= 30);
    } catch (err) {
      console.log("book-category loadMore error", err?.message || err);
    } finally {
      setIsFetchingMore(false);
    }
  }, [hasMore, isFetchingMore, isFixedSection, lastId, sectionLabel, supportsPagination]);

  useEffect(() => {
    // If the seed populated synchronously from redux/memory we still kick off
    // a background refresh so the page picks up newly published books, but we
    // skip the loader so the user sees instant content.
    if (initialSeed.length > 0) {
      fetchSection({ background: true });
    } else {
      fetchSection();
    }
  }, [fetchSection, initialSeed.length]);

  const onPullToRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetchSection({ background: true });
    } finally {
      setRefreshing(false);
    }
  }, [fetchSection]);

  const handleScroll = useCallback((event) => {
    const offsetY = event?.nativeEvent?.contentOffset?.y ?? 0;
    setShowScrollUp(offsetY > 500);
  }, []);

  const scrollToTop = useCallback(() => {
    if (!flatListRef.current) return;
    flatListRef.current.scrollToOffset?.({ offset: 0, animated: true });
  }, []);

  const keyExtractor = useCallback((item, index) => `${item?.$id ?? "book"}-${index}`, []);

  // 3-column grid sized to fit the screen with the same 16px outer padding
  // the rest of the app uses. The 2px between-card margin already lives on
  // BookCard (the hairline gap), so we just need the column gap to match.
  const gridCardWidth = useMemo(() => {
    const horizontalPadding = 32; // px-4 on each side
    const interItemGap = 2 * 2; // matches BookCard marginRight × (cols - 1)
    return Math.floor((SCREEN_WIDTH - horizontalPadding - interItemGap) / 3);
  }, []);

  const renderItem = useCallback(
    ({ item }) => {
      return <BookCard item={item} customWidth={gridCardWidth} />;
    },
    [gridCardWidth],
  );

  return (
    <SafeAreaView className="flex-1" style={{ backgroundColor: theme.background }}>
      <Loader isLoading={loading && books.length === 0} />
      <View className="flex-1 px-4">
        <View className="h-[50px] flex-row items-center justify-between">
          <View className="flex-row items-center">
            <TouchableOpacity onPress={() => router.back()} accessibilityLabel="Go back">
              <MaterialIcons name="arrow-back" size={24} color={theme.icon} />
            </TouchableOpacity>
            <Text className="ml-2 font-sans text-2xl font-bold" style={{ color: theme.text }} numberOfLines={1}>
              {sectionLabel || "Books"}
            </Text>
          </View>
        </View>

        {showScrollUp && (
          <TouchableOpacity
            activeOpacity={0.7}
            className="absolute bottom-[10] right-3 z-50 rounded-full p-3"
            style={{ backgroundColor: theme.surfaceElevated, borderWidth: 1, borderColor: theme.border }}
            onPress={scrollToTop}
            accessibilityLabel="Scroll to top"
          >
            <AntDesign name="arrowup" size={18} color={theme.icon} />
          </TouchableOpacity>
        )}

        <FlashList
          ref={flatListRef}
          data={books}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          numColumns={3}
          estimatedItemSize={gridCardWidth * 1.5 + 80}
          contentContainerStyle={{ paddingTop: 4, paddingBottom: 50 }}
          showsVerticalScrollIndicator={false}
          onScroll={handleScroll}
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          refreshControl={
            <RefreshControl
              tintColor={theme.primary}
              titleColor={theme.primary}
              progressBackgroundColor={theme.surface}
              refreshing={refreshing}
              onRefresh={onPullToRefresh}
            />
          }
          ListEmptyComponent={
            !loading ? (
              <View className="items-center justify-center px-4 py-12">
                <MaterialIcons name="menu-book" size={64} color={theme.textSubtle} />
                <Text className="mt-4 text-lg font-semibold" style={{ color: theme.text }}>
                  No books here yet
                </Text>
                <Text className="mt-2 text-center text-base" style={{ color: theme.textSoft }}>
                  Pull down to refresh, or check back soon.
                </Text>
              </View>
            ) : null
          }
          ListFooterComponent={
            isFetchingMore ? (
              <View className="items-center py-6">
                <Text style={{ color: theme.textSoft, fontSize: 12 }}>Loading more…</Text>
              </View>
            ) : null
          }
        />
      </View>
    </SafeAreaView>
  );
};

export default BookCategory;
