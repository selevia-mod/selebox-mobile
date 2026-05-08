import { FlashList } from "@shopify/flash-list";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { InteractionManager, PanResponder, RefreshControl, Text, TouchableOpacity, View, useWindowDimensions } from "react-native";
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
  BooksReadingList,
  BooksRecentlyUploaded,
  BooksWeeklyFeatured,
  MainScreensHeader,
  StyledSafeAreaView,
} from "../../components";
import useAppTheme from "../../hooks/useAppTheme";
import useResetOnBlur from "../../hooks/useResetOnBlur";
import { BookService, fetchRandomBook } from "../../lib/books";
import { BooksRankingService } from "../../lib/books-rankings";
// Phase E.10 — tier-tuned FlashList window for the Books tab.
import { getFlashListConfig } from "../../lib/device-tier";
import tabNavigationEvents from "../../lib/tab-navigation-events";
import {
  setCategoryBooks,
  setCompletedExcellent,
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

// takeUniqueContinueReading was removed when continueReading moved out
// of Redux into BooksContinueReading's self-fetched cache. The shelf
// applies its own dedup by user_id+book_id pair.

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

const TAB_TITLES = ["For You", "Discover", "Ranking", "Library", "Reading List"];
const SWIPE_DISTANCE_MIN = 120;
const SWIPE_DISTANCE_FRACTION = 0.3;
const SWIPE_DIRECTION_RATIO = 2;

// Section height estimate for the For You FlashList. Each section is a horizontal
// rail (title ~32 px + BookCard ~280 px + spacing ~8 px ≈ 320 px). Wrong estimates
// here are the classic cause of "blank cells while scrolling fast" on FlashList,
// but for the Books cold-open lag the bigger win is just that virtualization
// means only ~1–2 visible sections mount on first paint instead of all 5+N.
const BOOKS_SECTION_ESTIMATED_HEIGHT = 320;
const BooksSectionSeparator = () => <View style={{ height: 8 }} />;

// Renders its children only once the user has activated this PagerView page at
// least once. Cuts the first-tap-to-Books cost: previously all 5 tab content
// components mounted eagerly (each runs useSelector, useEffect, useResetOnBlur
// etc.). Now only For You mounts up front; the others come online lazily as
// the user swipes/taps to them and stay mounted afterward (so re-visits feel
// instant and we don't lose any in-tab state). The placeholder keeps PagerView's
// child count stable so swipe gestures still work on first render.
const LazyPagerChild = ({ isActive, children }) => {
  const [hasActivated, setHasActivated] = useState(isActive);
  useEffect(() => {
    if (isActive && !hasActivated) setHasActivated(true);
  }, [isActive, hasActivated]);
  return <View className="h-full flex-1">{hasActivated ? children : null}</View>;
};

const Books = () => {
  const { theme } = useAppTheme();
  const [activePage, setActivePage] = useState(0);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  useResetOnBlur(setRefreshing, setIsFetchingMore);
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  // Phase E.10 — tier-tuned FlashList window for sections-of-sections list.
  const flashListConfig = useMemo(() => getFlashListConfig({ screenHeight: windowHeight }), [windowHeight]);
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

    const hasBooks = (categoryName) => (booksState.categories?.[categoryName]?.length ?? 0) > 0;

    const pushNextCategories = (count) => {
      for (let i = 0; i < count && categoryIndex < bookCategories.length; i += 1) {
        const categoryName = bookCategories[categoryIndex];
        if (hasBooks(categoryName)) {
          sections.push({ type: "Category", category: categoryName });
        }
        categoryIndex += 1;
      }
    };

    pushNextCategories(2);
    sections.push({ type: "RecentlyUploaded" });
    pushNextCategories(2);
    pushNextCategories(2);
    pushNextCategories(2);

    while (categoryIndex < bookCategories.length) {
      const categoryName = bookCategories[categoryIndex];
      if (hasBooks(categoryName)) {
        sections.push({ type: "Category", category: categoryName });
      }
      categoryIndex += 1;
    }

    return sections;
  }, [bookCategories, booksState.categories]);

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

    // Note: continueReading was dropped from this emptiness check when
    // the home "Continue Reading" shelf moved to its own self-fetching
    // SWR cache (BooksContinueReading.jsx). The other sections still
    // gate cold-load on Redux being empty.
    const isEmpty =
      !booksState.weeklyFeatured.length &&
      !booksState.freshRead.length &&
      !booksState.completedExcellent.length &&
      !booksState.recentlyUploaded.length;

    const isStale = !booksState.lastFetchedAt || now - booksState.lastFetchedAt > TWELVE_HOURS;

    // Defer the cold-load fetch until after the first paint settles. Without
    // this, refreshBooks fires synchronously inside the mount effect and the
    // dispatch fanout (5 setX actions across 6 sub-section subscribers) runs
    // on the same tick as the tab-tap animation — that's where the tap-to-Books
    // lag came from. runAfterInteractions yields to the JS thread until any
    // active gesture / animation has finished, so the tab paints first, then
    // the network kicks off.
    const runFetch = () => {
      if (isEmpty) {
        refreshBooks();
      } else if (isStale) {
        refreshBooks({ silent: true });
      }
    };

    const handle = InteractionManager.runAfterInteractions(runFetch);
    return () => handle?.cancel?.();
  }, []);

  // Pre-warm the rankings pool after the For You feed has had time to paint, so
  // the Ranking sub-tab is instant the first time the user navigates to it.
  // Was a fixed 2s setTimeout — InteractionManager is more honest because it
  // yields to whatever's actually on the JS thread (animations, list mounts).
  useEffect(() => {
    const handle = InteractionManager.runAfterInteractions(() => {
      BooksRankingService.fetchRankingsPool().catch(() => {});
    });
    return () => handle?.cancel?.();
  }, []);

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
      flatListRef.current?.scrollTo?.({ y: 0, animated: true }) ?? flatListRef.current?.scrollToOffset?.({ offset: 0, animated: true });
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

  const refreshBooks = useCallback(
    async ({ silent = false } = {}) => {
      let shouldStopRefreshing = !silent;

      try {
        if (!silent) {
          setRefreshing(true);
        }

        // Fire EVERYTHING in parallel from the very first tick. Previously fresh
        // had a server-side excludes filter against weekly's $ids, which forced
        // a serial weekly → fresh chain (~+200–400ms on cold load). We instead
        // overfetch fresh by 2× and dedup client-side — same surface result,
        // one fewer round-trip on the critical path.
        // Categories also fire alongside everything else now (was sequential
        // after the For-You dispatch round); the dedup against the For-You set
        // happens once both arrive.
        const weeklyPromise = fetchRandomBook({ limit: 30 });
        const freshPromise = fetchRandomBook({ limit: 60 });
        const completedPromise = fetchRandomBook({ limit: 30, status: "Completed" });
        // continueReading no longer fetched here — the home shelf
        // (components/BooksContinueReading.jsx) self-fetches via
        // BookReadService.fetchRecentReads with its own SWR cache,
        // which keeps the resume row in sync with what
        // useBookProgress shows on book-info.
        const recentlyUploadedPromise = bookService.fetchPublishedBooks({ limit: 120 });
        const categoryPromise = Promise.allSettled(
          bookCategories.map((categoryName) => bookService.fetchPublishedBooks({ limit: 60, category: categoryName })),
        );

        const [weekly, fresh, completed, recently] = await Promise.all([
          weeklyPromise,
          freshPromise,
          completedPromise,
          recentlyUploadedPromise,
        ]);

        const seenBookIds = new Set();
        const dedupedWeekly = takeUniqueBooks({ books: weekly.documents || [], seenBookIds, limit: 30 });
        const dedupedFresh = takeUniqueBooks({ books: fresh.documents || [], seenBookIds, limit: 30 });
        const dedupedCompleted = takeUniqueBooks({ books: completed.documents || [], seenBookIds, limit: 30 });
        const dedupedRecently = takeUniqueBooks({ books: recently.documents || [], seenBookIds, limit: 30 });

        dispatch(setWeeklyFeatured(dedupedWeekly));
        dispatch(setFreshRead(dedupedFresh));
        dispatch(setCompletedExcellent(dedupedCompleted));
        // continueReading dispatch removed — see continueReadingPromise
        // comment above. The shelf reads from its own cache now.
        dispatch(setRecentlyUploaded(dedupedRecently));
        dispatch(setLastFetchedAt(Date.now()));

        if (!silent) {
          shouldStopRefreshing = false;
          setRefreshing(false);
        }

        // Categories were already in flight above — just await the results now.
        const categoryResponses = await categoryPromise;
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
        console.log("refreshBooks error", err?.message || err);
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
        return null;
    }
  }, []);

  // Tells FlashList to recycle each section type into its own pool. Without
  // this, recycler may try to reuse a Category cell for a Weekly cell and
  // briefly flash the wrong content during scroll.
  const getItemType = useCallback((item) => item.type, []);

  const handleTabPress = (index) => {
    pagerRef.current?.setPage(index);
    setActivePage(index);
  };

  const handlePageSelected = (e) => {
    const position = e.nativeEvent.position;
    activePageRef.current = position;
    setActivePage(position);
  };

  const sectionKeyExtractor = useCallback((item, index) => `${item.type}-${item.category ?? index}`, []);

  return (
    <StyledSafeAreaView edges={["top"]} style={{ backgroundColor: theme.background }}>
      <View className="w-full flex-1">
        <View className="px-4 pb-2 pt-1.5">
          <MainScreensHeader title={"books"} />
        </View>
        <View className="flex-1">
          {/* Premium violet pill tabs — matches the home feed and Videos tab language.
              Each pill uses `flex: 1` so the 5 tabs always divide the screen width
              equally and no horizontal scroll is needed on any iPhone size. Labels
              center inside their slot; numberOfLines + ellipsizeMode protects the
              longest label ("Reading List") from overflowing on the smallest phones. */}
          <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 6, paddingTop: 6, paddingBottom: 8 }}>
            {TAB_TITLES.map((title, index) => {
              const isActive = activePage === index;
              const isLast = index === TAB_TITLES.length - 1;
              return (
                <TouchableOpacity
                  key={index}
                  onPress={() => handleTabPress(index)}
                  activeOpacity={0.85}
                  style={{
                    flex: 1,
                    alignItems: "center",
                    paddingVertical: 7,
                    paddingHorizontal: 4,
                    borderRadius: 999,
                    marginRight: isLast ? 0 : 4,
                    backgroundColor: isActive ? theme.primary : "transparent",
                    shadowColor: theme.primary,
                    shadowOffset: { width: 0, height: 4 },
                    shadowOpacity: isActive ? 0.22 : 0,
                    shadowRadius: 8,
                    elevation: isActive ? 3 : 0,
                  }}
                >
                  <Text
                    numberOfLines={1}
                    ellipsizeMode="tail"
                    style={{
                      fontSize: 12,
                      fontWeight: isActive ? "700" : "500",
                      letterSpacing: 0.1,
                      color: isActive ? (theme.primaryContrast ?? "#ffffff") : (theme.textMuted ?? theme.text),
                    }}
                  >
                    {title}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <View className="flex-1" {...pagerPanResponder.panHandlers}>
            <PagerView className="flex-1" initialPage={0} ref={pagerRef} onPageSelected={handlePageSelected} scrollEnabled={false}>
              <View className="h-full flex-1">
                {/* For You list — virtualized via FlashList. Was a ScrollView with
                    .map(), which mounted ALL 5+N sections (~30–60+ BookCards) on
                    cold open and was the actual cause of the 1–2s tap-to-Books
                    lag. Mirrors the Videos tab's FlashList-of-sections approach
                    so only ~1–2 visible sections mount on first paint. */}
                <FlashList
                  ref={flatListRef}
                  data={booksSections}
                  renderItem={renderSection}
                  keyExtractor={sectionKeyExtractor}
                  getItemType={getItemType}
                  estimatedItemSize={BOOKS_SECTION_ESTIMATED_HEIGHT}
                  drawDistance={flashListConfig.drawDistance}
                  removeClippedSubviews={flashListConfig.removeClippedSubviews}
                  onEndReachedThreshold={flashListConfig.onEndReachedThreshold}
                  ItemSeparatorComponent={BooksSectionSeparator}
                  contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 50 }}
                  showsVerticalScrollIndicator={false}
                  onScroll={handleScroll}
                  scrollEventThrottle={16}
                  refreshControl={
                    <RefreshControl
                      tintColor={theme.primary}
                      titleColor={theme.primary}
                      progressBackgroundColor={theme.surface}
                      refreshing={refreshing}
                      onRefresh={refreshBooks}
                    />
                  }
                />
              </View>
              {/* Lazy-mounted: each non-For-You tab waits for its first activation
                  before instantiating, so the cost of opening Books is just the
                  For You feed plus four trivial placeholders. */}
              <LazyPagerChild isActive={activePage === 1}>
                <BooksDiscover isActive={activePage === 1} onRefresh={refreshBooks} refreshing={refreshing} />
              </LazyPagerChild>
              <LazyPagerChild isActive={activePage === 2}>
                <BooksRanking isActive={activePage === 2} />
              </LazyPagerChild>
              <LazyPagerChild isActive={activePage === 3}>
                <BooksLibrary isActive={activePage === 3} />
              </LazyPagerChild>
              <LazyPagerChild isActive={activePage === 4}>
                <BooksReadingList isActive={activePage === 4} />
              </LazyPagerChild>
            </PagerView>
          </View>
        </View>
      </View>
    </StyledSafeAreaView>
  );
};

export default Books;
