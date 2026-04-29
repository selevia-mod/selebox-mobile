import { MaterialIcons } from "@expo/vector-icons";
import { FlashList } from "@shopify/flash-list";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, PanResponder, RefreshControl, Text, TouchableOpacity, View, useWindowDimensions } from "react-native";
import LoaderKit from "react-native-loader-kit";
import PagerView from "react-native-pager-view";
import { useDispatch, useSelector } from "react-redux";
import {
  BooksCompletedExcellentWorks,
  BooksContinueReading,
  BooksDiscover,
  BooksFreshRead,
  BooksLibrary,
  BooksPerCategory,
  BooksRanking,
  BooksRecentlyUploaded,
  BooksWeeklyFeatured,
  MainScreensHeader,
  StyledSafeAreaView,
} from "../../components";
import BookSearchCard from "../../components/BookSearchCard";
import useAppTheme from "../../hooks/useAppTheme";
import useResetOnBlur from "../../hooks/useResetOnBlur";
import { BookService, fetchRandomBook } from "../../lib/books";
import tabNavigationEvents from "../../lib/tab-navigation-events";
import {
  setCategoryBooks,
  setCompletedExcellent,
  setContinueReading,
  setFreshRead,
  setLastFetchedAt,
  setRecentlyUploaded,
  setWeeklyFeatured,
} from "../../store/reducers/books";

const takeUniqueBooks = ({ books = [], seenBookIds, limit = 30 }) => {
  const uniqueBooks = [];

  for (const book of books) {
    const bookId = book?.$id;
    if (!bookId || seenBookIds.has(bookId)) continue;
    seenBookIds.add(bookId);
    uniqueBooks.push(book);
    if (uniqueBooks.length >= limit) break;
  }

  return uniqueBooks;
};

const takeUniqueContinueReading = ({ entries = [], seenBookIds, limit = 30 }) => {
  const uniqueEntries = [];

  for (const entry of entries) {
    const bookId = entry?.book?.$id;
    if (!bookId || seenBookIds.has(bookId)) continue;
    seenBookIds.add(bookId);
    uniqueEntries.push(entry);
    if (uniqueEntries.length >= limit) break;
  }

  return uniqueEntries;
};

const parseBookCategories = (rawBookCategories) => {
  if (!rawBookCategories) return [];

  try {
    const parsed = JSON.parse(rawBookCategories);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.log("Invalid BOOKS_CATEGORIES setting. Falling back to an empty categories list.");
    return [];
  }
};

const TAB_TITLES = ["For You", "Discover", "Ranking", "Library"];
const SWIPE_DISTANCE_MIN = 120;
const SWIPE_DISTANCE_FRACTION = 0.3;
const SWIPE_DIRECTION_RATIO = 2;

const Books = () => {
  const { theme } = useAppTheme();
  const [activePage, setActivePage] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [searchLastId, setSearchLastId] = useState(null);
  const [filteredBooks, setFilteredBooks] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  useResetOnBlur(setRefreshing, setIsFetchingMore);
  const { width: windowWidth } = useWindowDimensions();
  const flatListRef = useRef(null);
  const lastScrollY = useRef(0);
  const navHiddenRef = useRef(false);
  const pagerRef = useRef(null);
  const activePageRef = useRef(activePage);
  const bookServiceRef = useRef(new BookService());
  const bookService = bookServiceRef.current;
  const { user } = useSelector((state) => state.auth);
  const { globalSettings } = useSelector((state) => state.app);
  const booksState = useSelector((state) => state.books);
  const dispatch = useDispatch();
  const swipeDistanceThreshold = Math.max(SWIPE_DISTANCE_MIN, Math.round(windowWidth * SWIPE_DISTANCE_FRACTION));
  const bookCategories = useMemo(() => parseBookCategories(globalSettings?.["BOOKS_CATEGORIES"]), [globalSettings?.["BOOKS_CATEGORIES"]]);
  const booksSections = useMemo(() => {
    const sections = [];

    let categoryIndex = 0;

    sections.push({ type: "BooksWeeklyFeatured" });
    sections.push({ type: "FreshRead" });
    sections.push({ type: "CompletedAndExcellentWorks" });
    sections.push({ type: "ContinueReading" });

    const pushNextCategories = (count) => {
      for (let i = 0; i < count && categoryIndex < bookCategories.length; i += 1) {
        sections.push({ type: "Category", category: bookCategories[categoryIndex] });
        categoryIndex += 1;
      }
    };

    pushNextCategories(2);
    sections.push({ type: "RecentlyUploaded" });
    pushNextCategories(2);
    pushNextCategories(2);
    pushNextCategories(2);

    while (categoryIndex < bookCategories.length) {
      sections.push({ type: "Category", category: bookCategories[categoryIndex] });
      categoryIndex += 1;
    }

    return sections;
  }, [bookCategories]);

  const pagerPanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_event, gestureState) => {
          const { dx, dy } = gestureState;
          const isHorizontal = Math.abs(dx) > Math.abs(dy) * SWIPE_DIRECTION_RATIO;
          const isIntentional = Math.abs(dx) > swipeDistanceThreshold;
          return isHorizontal && isIntentional;
        },
        onPanResponderRelease: (_event, gestureState) => {
          const { dx, dy } = gestureState;
          const isHorizontal = Math.abs(dx) > Math.abs(dy) * SWIPE_DIRECTION_RATIO;
          const isIntentional = Math.abs(dx) > swipeDistanceThreshold;
          if (!isHorizontal || !isIntentional) return;

          const direction = dx < 0 ? 1 : -1;
          const currentPage = activePageRef.current;
          const nextPage = Math.max(0, Math.min(currentPage + direction, TAB_TITLES.length - 1));
          if (nextPage !== currentPage) {
            pagerRef.current?.setPage(nextPage);
          }
        },
      }),
    [swipeDistanceThreshold],
  );

  useEffect(() => {
    const now = Date.now();
    const TWELVE_HOURS = 12 * 60 * 60 * 1000;

    const isEmpty =
      !booksState.weeklyFeatured.length &&
      !booksState.freshRead.length &&
      !booksState.completedExcellent.length &&
      !booksState.continueReading.length &&
      !booksState.recentlyUploaded.length;

    const isStale = !booksState.lastFetchedAt || now - booksState.lastFetchedAt > TWELVE_HOURS;

    if (isEmpty) {
      console.log("📚 First visit — fetching books…");
      refreshBooks();
    } else if (isStale) {
      console.log("📚 Cache stale — refreshing books in background…");
      refreshBooks({ silent: true });
    } else {
      console.log("📚 Loaded instantly from MMKV cache");
    }
  }, []);

  useEffect(() => {
    const delaySearch = setTimeout(async () => {
      if (!searchQuery.trim()) {
        setFilteredBooks([]);
        setIsSearching(false);
        setSearchHasMore(false);
        setSearchLastId(null);
        return;
      }

      setSearchLoading(true);
      setIsSearching(true);

      const { documents, hasMore } = await bookService.searchBooks({ searchQuery, limit: 20 });
      setFilteredBooks(documents);
      setSearchLastId(documents[documents.length - 1]?.$id || null);
      setSearchHasMore(hasMore);
      setSearchLoading(false);
    }, 1000);

    return () => clearTimeout(delaySearch);
  }, [searchQuery]);

  useFocusEffect(
    useCallback(() => {
      navHiddenRef.current = false;
      tabNavigationEvents.emit("tabBarVisibility", { visible: true });
      return () => {
        navHiddenRef.current = false;
        tabNavigationEvents.emit("tabBarVisibility", { visible: true });
      };
    }, []),
  );

  useEffect(() => {
    const handleScrollToTop = ({ tab }) => {
      if (tab !== "books") return;
      if (activePageRef.current !== 0) return;
      lastScrollY.current = 0;
      flatListRef.current?.scrollToOffset?.({ offset: 0, animated: true });
      if (navHiddenRef.current) {
        navHiddenRef.current = false;
        tabNavigationEvents.emit("tabBarVisibility", { visible: true });
      }
    };

    tabNavigationEvents.on("scrollToTop", handleScrollToTop);
    return () => {
      tabNavigationEvents.off("scrollToTop", handleScrollToTop);
    };
  }, []);

  useEffect(() => {
    activePageRef.current = activePage;
    if (activePage !== 0 && navHiddenRef.current) {
      navHiddenRef.current = false;
      tabNavigationEvents.emit("tabBarVisibility", { visible: true });
    }
  }, [activePage]);

  const fetchMoreSearchResults = async () => {
    if (!searchHasMore || searchLoading || !searchLastId) return;

    setSearchLoading(true);
    setIsFetchingMore(true);
    try {
      const { documents, hasMore } = await bookService.searchBooks({
        searchQuery,
        cursorId: searchLastId,
        limit: 20,
      });

      setFilteredBooks((prev) => [...prev, ...documents]);
      setSearchLastId(documents[documents.length - 1]?.$id || null);
      setSearchHasMore(hasMore);
    } catch (error) {
      console.log("fetchMoreSearchResults: error", error);
    } finally {
      setSearchLoading(false);
      setIsFetchingMore(false);
    }
  };

  const refreshBooks = useCallback(
    async ({ silent = false } = {}) => {
      let shouldStopRefreshing = !silent;

      try {
        if (!silent) {
          setRefreshing(true);
        }

        const weeklyPromise = fetchRandomBook({ limit: 30 });
        const completedPromise = fetchRandomBook({
          limit: 30,
          status: "Completed",
        });
        const continueReadingPromise = bookService.fetchContinueReadingBooks({ userId: user?.$id });
        const recentlyUploadedPromise = bookService.fetchPublishedBooks({ limit: 120 });

        const weekly = await weeklyPromise;
        const excludedBookIds = new Set((weekly.documents || []).map((book) => book?.$id).filter(Boolean));

        const fresh = await fetchRandomBook({ limit: 30, excludeIds: Array.from(excludedBookIds) });
        (fresh.documents || []).forEach((book) => {
          if (book?.$id) excludedBookIds.add(book.$id);
        });

        const [completed, continueRead, recently] = await Promise.all([completedPromise, continueReadingPromise, recentlyUploadedPromise]);

        const seenBookIds = new Set();
        const dedupedWeekly = takeUniqueBooks({ books: weekly.documents || [], seenBookIds, limit: 30 });
        const dedupedFresh = takeUniqueBooks({ books: fresh.documents || [], seenBookIds, limit: 30 });
        const dedupedCompleted = takeUniqueBooks({ books: completed.documents || [], seenBookIds, limit: 30 });
        const dedupedContinueReading = takeUniqueContinueReading({
          entries: continueRead.documents || [],
          seenBookIds,
          limit: 30,
        });
        const dedupedRecently = takeUniqueBooks({ books: recently.documents || [], seenBookIds, limit: 30 });

        dispatch(setWeeklyFeatured(dedupedWeekly));
        dispatch(setFreshRead(dedupedFresh));
        dispatch(setCompletedExcellent(dedupedCompleted));
        dispatch(setContinueReading(dedupedContinueReading));
        dispatch(setRecentlyUploaded(dedupedRecently));
        dispatch(setLastFetchedAt(Date.now()));

        if (!silent) {
          shouldStopRefreshing = false;
          setRefreshing(false);
        }

        const categoryResponses = await Promise.allSettled(
          bookCategories.map((categoryName) => bookService.fetchPublishedBooks({ limit: 60, category: categoryName })),
        );

        bookCategories.forEach((categoryName, index) => {
          const categoryResult = categoryResponses[index];
          if (categoryResult?.status === "rejected") {
            console.log(`Offline category: ${categoryName}`);
          }

          const categoryBooks = categoryResult?.status === "fulfilled" ? categoryResult.value.documents || [] : [];
          const dedupedCategoryBooks = takeUniqueBooks({
            books: categoryBooks,
            seenBookIds,
            limit: 30,
          });

          dispatch(setCategoryBooks({ category: categoryName, books: dedupedCategoryBooks }));
        });
      } catch (err) {
        console.log(err);
        console.log("Offline – using cached books data");
      } finally {
        if (shouldStopRefreshing) {
          setRefreshing(false);
        }
      }
    },
    [bookCategories, bookService, dispatch, user?.$id],
  );

  const handleScroll = useCallback((event) => {
    const y = event?.nativeEvent?.contentOffset?.y ?? 0;
    const delta = y - lastScrollY.current;

    if (y <= 0) {
      if (navHiddenRef.current) {
        navHiddenRef.current = false;
        tabNavigationEvents.emit("tabBarVisibility", { visible: true });
      }
      lastScrollY.current = y;
      return;
    }

    if (Math.abs(delta) < 6) {
      lastScrollY.current = y;
      return;
    }

    if (delta > 12 && y > 60 && !navHiddenRef.current) {
      navHiddenRef.current = true;
      tabNavigationEvents.emit("tabBarVisibility", { visible: false });
    } else if (delta < -12 && navHiddenRef.current) {
      navHiddenRef.current = false;
      tabNavigationEvents.emit("tabBarVisibility", { visible: true });
    }

    lastScrollY.current = y;
  }, []);

  const renderSection = useCallback(({ item }) => {
    switch (item.type) {
      case "BooksWeeklyFeatured":
        return <BooksWeeklyFeatured />;
      case "FreshRead":
        return <BooksFreshRead />;
      case "CompletedAndExcellentWorks":
        return <BooksCompletedExcellentWorks />;
      case "RecentlyUploaded":
        return <BooksRecentlyUploaded />;
      case "ContinueReading":
        return <BooksContinueReading />;
      case "Category":
        return <BooksPerCategory category={item.category} />;
      default:
        return <BookSearchCard item={item} />;
    }
  }, []);

  const handleTabPress = (index) => {
    pagerRef.current?.setPage(index);
    setActivePage(index);
  };

  const handlePageSelected = (e) => {
    const position = e.nativeEvent.position;
    activePageRef.current = position;
    setActivePage(position);
  };

  const keyExtractor = useCallback((item, index) => item?.$id || `${item.type}-${item.category ?? index}`, []);

  return (
    <StyledSafeAreaView edges={["top"]} style={{ backgroundColor: theme.background }}>
      <View className="w-full flex-1">
        <View className="px-4 pb-2 pt-1.5">
          <MainScreensHeader title={"books"} searchPlaceholder={"Search Books."} searchQuery={searchQuery} setSearchQuery={setSearchQuery} />
        </View>
        <View className="flex-1">
          <View
            className="my-2 flex flex-row justify-between overflow-hidden rounded-lg"
            style={{ backgroundColor: theme.surfaceMuted, borderWidth: 1, borderColor: theme.border }}
          >
            {TAB_TITLES.map((title, index) => (
              <TouchableOpacity
                className="flex-1 flex-row justify-center p-1.5"
                key={index}
                onPress={() => handleTabPress(index)}
                style={{ backgroundColor: activePage === index ? theme.surfaceElevated : "transparent" }}
              >
                <Text
                  className={`text-center text-sm ${activePage === index ? "font-bold" : ""}`}
                  style={{ color: activePage === index ? theme.text : theme.textSoft }}
                >
                  {title}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <View className="flex-1" {...pagerPanResponder.panHandlers}>
            <PagerView className="flex-1" initialPage={0} ref={pagerRef} onPageSelected={handlePageSelected} scrollEnabled={false}>
              <View className="h-full flex-1">
                <FlashList
                  data={isSearching ? filteredBooks : booksSections}
                  renderItem={renderSection}
                  keyExtractor={keyExtractor}
                  estimatedItemSize={300}
                  removeClippedSubviews={false}
                  contentContainerStyle={{ paddingBottom: 50 }}
                  showsVerticalScrollIndicator={false}
                  onRefresh={refreshBooks}
                  onScroll={handleScroll}
                  scrollEventThrottle={16}
                  onEndReached={isSearching ? fetchMoreSearchResults : undefined}
                  ref={flatListRef}
                  refreshing={refreshing}
                  refreshControl={
                    <RefreshControl
                      tintColor={theme.primary}
                      titleColor={theme.primary}
                      progressBackgroundColor={theme.surface}
                      refreshing={refreshing}
                      onRefresh={refreshBooks}
                    />
                  }
                  ListFooterComponent={
                    isFetchingMore ? (
                      <View className="items-center py-4">
                        <ActivityIndicator size="small" color={theme.primary} />
                      </View>
                    ) : null
                  }
                  ListEmptyComponent={
                    searchLoading ? (
                      <View className="items-center justify-center px-4 py-12">
                        <LoaderKit style={{ width: 50, height: 50 }} name="LineScalePulseOutRapid" color={theme.primary} />
                        <Text className="mt-4 text-lg font-semibold" style={{ color: theme.text }}>
                          Searching
                        </Text>
                      </View>
                    ) : (
                      <View className="items-center justify-center px-4 py-12">
                        <MaterialIcons name="search-off" size={64} color={theme.textSubtle} />
                        <Text className="mt-4 text-lg font-semibold" style={{ color: theme.text }}>
                          No Results Found
                        </Text>
                        <Text className="mt-2 text-center text-base" style={{ color: theme.textSoft }}>
                          We couldn’t find anything matching your search.{"\n"}Try different keywords.
                        </Text>
                      </View>
                    )
                  }
                />
              </View>
              <BooksDiscover isActive={activePage === 1} onRefresh={refreshBooks} refreshing={refreshing} />
              <BooksRanking isActive={activePage === 2} />
              <BooksLibrary isActive={activePage === 3} />
            </PagerView>
          </View>
        </View>
      </View>
    </StyledSafeAreaView>
  );
};

export default Books;
