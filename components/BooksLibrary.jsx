import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, RefreshControl, Text, View } from "react-native";
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
  const { library } = useSelector((state) => state.books);
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
      if (library.length > 0) {
        setUserLibrary(library.slice(0, PAGE_SIZE));
      } else {
        fetchUserLibrary();
      }
    }, []),
  );

  const fetchUserLibrary = async () => {
    try {
      const bookLibraryData = await bookService.fetchBookLibraryByUser({ userId: user.$id });
      setUserLibrary(bookLibraryData.documents);
      setLastId(bookLibraryData.documents[bookLibraryData.documents.length - 1].$id);
      setHasMore(bookLibraryData.documents.length < bookLibraryData.total);
      dispatch(setLibraryLastId(bookLibraryData.documents[bookLibraryData.documents.length - 1].$id));
      dispatch(setLibraryHasMore(bookLibraryData.documents.length < bookLibraryData.total));
      dispatch(setLibrary(bookLibraryData.documents));
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
                await bookService.deleteBookLibrary({ bookLibraryId: item.$id });
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

  return (
    <View className="flex-1">
      <FlatList
        removeClippedSubviews={false}
        data={userLibrary}
        refreshing={refreshing}
        keyExtractor={(item, index) => item?.$id || `${item.type}-${index}`}
        renderItem={renderItem}
        contentContainerStyle={{ paddingBottom: 50 }}
        showsVerticalScrollIndicator={false}
        ref={listRef}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        onRefresh={handleRefresh}
        onEndReached={fetchMoreUserLibrary}
        ListFooterComponent={
          isFetchingMore ? (
            <View className="items-center py-4">
              <ActivityIndicator size="small" color={theme.primary} />
            </View>
          ) : null
        }
        ListEmptyComponent={
          <View className="flex-1 items-center justify-center px-4 py-12">
            <MaterialCommunityIcons name="book-open-page-variant" size={48} color={theme.textSubtle} />
            <Text className="mt-4 text-lg font-semibold" style={{ color: theme.text }}>
              No Books Yet
            </Text>
            <Text className="mt-2 text-center text-sm" style={{ color: theme.textSoft }}>
              You haven’t published any books yet.{"\n"}
              Start writing and share your first story!
            </Text>
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
