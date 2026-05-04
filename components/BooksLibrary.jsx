import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, RefreshControl, Text, TouchableOpacity, View } from "react-native";
import { useDispatch, useSelector } from "react-redux";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import { BookService } from "../lib/books";
import tabNavigationEvents from "../lib/tab-navigation-events";
import { appendLibrary, setLibrary, setLibraryHasMore, setLibraryLastId } from "../store/reducers/books";
import useResetOnBlur from "../hooks/useResetOnBlur";
import BookLibraryCard from "./BookLibraryCard";

const BooksLibrary = ({ isActive = false }) => {
  const { theme } = useAppTheme();
  const { user } = useGlobalContext();
  const [userLibrary, setUserLibrary] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [lastId, setLastId] = useState();
  const [hasMore, setHasMore] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  useResetOnBlur(setRefreshing, setIsFetchingMore);
  const [localCursor, setLocalCursor] = useState();
  const library = useSelector((state) => state.books.library);
  const lastScrollY = useRef(0);
  const navHiddenRef = useRef(false);
  const listRef = useRef(null);
  const isActiveRef = useRef(isActive);

  const dispatch = useDispatch();
  const PAGE_SIZE = 15;

  const bookServiceRef = useRef(new BookService());
  const bookService = bookServiceRef.current;

  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  useFocusEffect(
    useCallback(() => {
      // Stale-while-revalidate: paint Redux cache immediately for instant
      // first render, then ALWAYS refetch from the server in the
      // background. Previously this was cache-first/never-revalidate,
      // which meant cross-platform writes (e.g. a bookmark added on web)
      // never showed up — Library would render whatever was in MMKV
      // since the last fetch and skip the network entirely. The post-
      // USE_SUPABASE_BOOKS-flip world makes this acutely visible because
      // web and mobile finally share the same backing table.
      if (library.length > 0) {
        setUserLibrary(library.slice(0, PAGE_SIZE));
      }
      fetchUserLibrary();
    }, []),
  );

  const fetchUserLibrary = async () => {
    try {
      const bookLibraryData = await bookService.fetchBookLibraryByUser({ userId: user.$id });
      const docs = bookLibraryData?.documents || [];
      const total = Number.isFinite(bookLibraryData?.total) ? bookLibraryData.total : docs.length;
      setUserLibrary(docs);
      // Guard against the previous .documents[-1].$id crash when the user
      // has zero bookmarks — accessing index -1 on an empty array returns
      // undefined and the .$id read threw.
      const cursor = docs.length > 0 ? docs[docs.length - 1].$id : null;
      setLastId(cursor);
      setHasMore(docs.length < total);
      dispatch(setLibraryLastId(cursor));
      dispatch(setLibraryHasMore(docs.length < total));
      dispatch(setLibrary(docs));
    } catch (error) {
      console.log("fetchUserLibrary: error", error);
    }
  };

  const fetchMoreUserLibrary = async () => {
    if (localCursor < library.length) {
      const nextSlice = library.slice(localCursor, localCursor + PAGE_SIZE);

      setUserLibrary((prev) => [...prev, ...nextSlice]);
      setLocalCursor(localCursor + PAGE_SIZE);
      return;
    }

    try {
      if (!lastId || !hasMore) return;
      setIsFetchingMore(true);
      const bookLibraryData = await bookService.fetchBookLibraryByUser({ userId: user.$id, lastId: lastId });
      const uniqueBook = bookLibraryData.documents.filter((book) => !userLibrary.some((existing) => existing.$id === book.$id));
      if (uniqueBook.length === 0) {
        setHasMore(false);
        setIsFetchingMore(false);
        return;
      }
      const updatedFetchedUserLibrary = [...userLibrary, ...uniqueBook];
      setUserLibrary(updatedFetchedUserLibrary);
      setLastId(bookLibraryData.documents[bookLibraryData.documents.length - 1].$id);
      dispatch(appendLibrary(uniqueBook));
      dispatch(setLibraryLastId(bookLibraryData.documents[bookLibraryData.documents.length - 1].$id));
      if (updatedFetchedUserLibrary.length >= bookLibraryData.total) setHasMore(false);
    } catch (error) {
      console.log("fetchMoreUserBooks: error", error);
    } finally {
      setIsFetchingMore(false);
    }
  };

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetchUserLibrary();
    } finally {
      setRefreshing(false);
    }
  }, []);

  const renderItem = ({ item }) => {
    const handleRemoveFromLibrary = () => {
      try {
        Alert.alert(
          "Confirm Deletion",
          "Are you sure you want to remove this book from your library? There is no going back!",
          [
            {
              text: "No",
              style: "cancel",
            },
            {
              text: "Yes",
              onPress: async () => {
                // Pass bookId + userId so the dual-write side can drop
                // the (book_id, user_id) row from Supabase. Library record
                // shape: item.$id is the library doc id, item.book.$id is
                // the book id (relation expanded).
                const bookIdForDelete = item?.book?.$id || item?.book;
                await bookService.deleteBookLibrary({ bookLibraryId: item.$id, bookId: bookIdForDelete, userId: user?.$id });
                fetchUserLibrary();
              },
              style: "destructive",
            },
          ],
          { cancelable: true },
        );
      } catch (error) {
        console.log("handleRemoveFromLibrary: error", error);
      }
    };
    return <BookLibraryCard item={item.book} handleRemoveFromLibrary={handleRemoveFromLibrary} />;
  };

  useEffect(() => {
    const handleScrollToTop = ({ tab }) => {
      if (tab !== "books") return;
      if (!isActiveRef.current) return;
      lastScrollY.current = 0;
      listRef.current?.scrollToOffset?.({ offset: 0, animated: true });
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

  // Library count + section header pinned at the top of the list. Mirrors
  // the language used by the Recommended-videos block under the player:
  // small violet chip + uppercase letter-spaced label, count badge on the
  // right. Reads as part of the same accent system as the rest of the app.
  const libraryCount = userLibrary?.length || 0;
  const renderHeader = () => (
    <View className="mb-3 flex-row items-center justify-between px-4 pt-2">
      <View className="flex-row items-center">
        <View
          style={{
            width: 26,
            height: 26,
            borderRadius: 8,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: theme.primarySoft,
            borderWidth: 1,
            borderColor: theme.primary,
            marginRight: 10,
            shadowColor: theme.primary,
            shadowOffset: { width: 0, height: 3 },
            shadowOpacity: 0.3,
            shadowRadius: 6,
            elevation: 2,
          }}
        >
          <Ionicons name="bookmark" size={13} color={theme.primary} />
        </View>
        <Text className="font-psemibold" style={{ color: theme.text, fontSize: 13, letterSpacing: 1.6, textTransform: "uppercase" }}>
          Your Library
        </Text>
      </View>
      {libraryCount > 0 ? (
        <View
          className="rounded-full"
          style={{
            paddingHorizontal: 8,
            paddingVertical: 2,
            backgroundColor: theme.surfaceMuted,
            borderWidth: 1,
            borderColor: theme.border,
          }}
        >
          <Text className="text-[10px] font-bold" style={{ color: theme.textMuted, letterSpacing: 0.4 }}>
            {libraryCount} {libraryCount === 1 ? "BOOK" : "BOOKS"}
          </Text>
        </View>
      ) : null}
    </View>
  );

  return (
    <View className="flex-1">
      <FlatList
        removeClippedSubviews={false}
        data={userLibrary}
        refreshing={refreshing}
        keyExtractor={(item, index) => item?.$id || `${item.type}-${index}`}
        renderItem={renderItem}
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 50 }}
        showsVerticalScrollIndicator={false}
        ref={listRef}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        onRefresh={handleRefresh}
        onEndReached={fetchMoreUserLibrary}
        ListHeaderComponent={renderHeader}
        ListFooterComponent={
          isFetchingMore ? (
            <View className="items-center py-4">
              <ActivityIndicator size="small" color={theme.primary} />
            </View>
          ) : null
        }
        ListEmptyComponent={
          /* Premium empty state — matches the violet-accent language used
             on the From-Creators-You-Follow card and the choice modal. The
             previous copy ("You haven't published any books yet") was wrong:
             the Library tab holds books the user SAVED, not authored.
             "Find books to read" CTA routes back to Discover so the empty
             state is actionable instead of a dead end. */
          <View className="flex-1 items-center px-6 py-12">
            <View
              style={{
                height: 64,
                width: 64,
                borderRadius: 999,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: theme.primarySoft,
                borderWidth: 1,
                borderColor: theme.primary,
                marginBottom: 16,
              }}
            >
              <MaterialCommunityIcons name="bookmark-multiple-outline" size={28} color={theme.primary} />
            </View>
            <Text className="text-base font-bold" style={{ color: theme.text, letterSpacing: 0.2 }}>
              Your library is empty
            </Text>
            <Text className="mt-1.5 max-w-[260px] text-center text-sm" style={{ color: theme.textSoft, lineHeight: 18 }}>
              Save books to your library so you can pick them up anywhere — even offline.
            </Text>
            <TouchableOpacity
              onPress={() => router.push("/(tabs)/books")}
              activeOpacity={0.85}
              className="mt-5 flex-row items-center rounded-full"
              style={{
                paddingHorizontal: 16,
                paddingVertical: 10,
                backgroundColor: theme.primary,
                shadowColor: theme.primary,
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: 0.3,
                shadowRadius: 10,
                elevation: 4,
              }}
            >
              <Ionicons name="search" size={14} color={theme.primaryContrast} style={{ marginRight: 6 }} />
              <Text className="text-sm font-bold" style={{ color: theme.primaryContrast, letterSpacing: 0.2 }}>
                Find books to read
              </Text>
            </TouchableOpacity>
          </View>
        }
        refreshControl={
          <RefreshControl
            tintColor={theme.primary}
            titleColor={theme.primary}
            progressBackgroundColor={theme.surface}
            refreshing={refreshing}
            onRefresh={handleRefresh}
          />
        }
      />
    </View>
  );
};

export default BooksLibrary;
