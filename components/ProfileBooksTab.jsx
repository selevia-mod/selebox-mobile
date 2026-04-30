import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Text, View } from "react-native";
import { RefreshControl } from "react-native-gesture-handler";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import { BookService } from "../lib/books";
import BookCatalogCard from "./BookCatalogCard";
import BookLibraryCard from "./BookLibraryCard";

const ProfileBooksTab = ({
  userId,
  nestedScrollEnabled = false,
  sectionTitle = "Books",
  listRef,
  contentPaddingTop = 0,
  onScroll,
  onLoadingChange,
  suppressEmptyState = false,
  headerComponent = null,
}) => {
  const { user } = useGlobalContext();
  const { theme } = useAppTheme();
  const [userBooks, setUserBooks] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [lastId, setLastId] = useState();
  const [hasMore, setHasMore] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const internalListRef = useRef(null);
  const effectiveListRef = listRef || internalListRef;
  const hasLoadedRef = useRef(false);

  const bookService = new BookService();
  const isLoggedInUser = user?.$id === userId;
  const bookStatus = isLoggedInUser ? undefined : ["Ongoing", "Completed"];

  useFocusEffect(
    useCallback(() => {
      fetchUserBooks();
    }, [userId]),
  );

  const fetchUserBooks = async () => {
    if (!hasLoadedRef.current) onLoadingChange?.(true);
    try {
      const booksData = await bookService.fetchBooks({ userId: userId, status: bookStatus });
      setUserBooks(booksData.documents);
      setLastId(booksData.documents[booksData.documents.length - 1].$id);
      setHasMore(booksData.documents.length < booksData.total);
    } catch (error) {
      console.log("fetchUserBooks: error", error);
    } finally {
      if (!hasLoadedRef.current) {
        hasLoadedRef.current = true;
        onLoadingChange?.(false);
      }
    }
  };

  const fetchMoreUserBooks = async () => {
    try {
      if (!lastId || !hasMore) return;
      setIsFetchingMore(true);
      const booksData = await bookService.fetchBooks({ userId: userId, lastId: lastId, status: bookStatus });
      const uniqueBook = booksData.documents.filter((book) => !userBooks.some((existing) => existing.$id === book.$id));
      if (uniqueBook.length === 0) {
        setHasMore(false);
        setIsFetchingMore(false);
        return;
      }
      const updatedFetchedUserBooks = [...userBooks, ...uniqueBook];
      setUserBooks(updatedFetchedUserBooks);
      setLastId(booksData.documents[booksData.documents.length - 1].$id);
      if (updatedFetchedUserBooks.length >= booksData.total) setHasMore(false);
    } catch (error) {
      console.log("fetchMoreUserBooks: error", error);
    } finally {
      setIsFetchingMore(false);
    }
  };

  const onRefresh = async () => {
    await fetchUserBooks();
  };

  const handleDeleteBook = async (bookId) => {
    try {
      Alert.alert(
        "Confirm Deletion",
        "Are you sure you want to delete this book? There is no going back!",
        [
          {
            text: "No",
            style: "cancel",
          },
          {
            text: "Yes",
            onPress: async () => {
              await bookService.deleteBook({ ID: bookId });
              fetchUserBooks();
            },
            style: "destructive",
          },
        ],
        { cancelable: true },
      );
    } catch (error) {
      console.log("handleDeleteBook: error", error);
    }
  };

  const renderItem = ({ item }) => {
    return isLoggedInUser ? <BookCatalogCard item={item} handleDeleteBook={handleDeleteBook} /> : <BookLibraryCard item={item} hideRemove />;
  };

  const handleScrollToIndexFailed = useCallback(({ averageItemLength, index }) => {
    const offset = Math.max(0, averageItemLength * index);
    effectiveListRef.current?.scrollToOffset?.({ offset, animated: true });
  }, []);

  const renderListHeader = () => (
    <View style={{ paddingTop: contentPaddingTop }}>
      {headerComponent}
      {sectionTitle ? (
        <Text className="mb-2 text-xl font-bold" style={{ color: theme.text }}>
          {sectionTitle}
        </Text>
      ) : null}
    </View>
  );

  return (
    <View className="flex-1">
      <FlatList
        ref={effectiveListRef}
        data={userBooks}
        refreshing={refreshing}
        nestedScrollEnabled={nestedScrollEnabled}
        ListHeaderComponent={renderListHeader}
        keyExtractor={(item, index) => item?.$id || `${item.type}-${index}`}
        renderItem={renderItem}
        onScrollToIndexFailed={handleScrollToIndexFailed}
        showsVerticalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onRefresh={onRefresh}
        onEndReached={fetchMoreUserBooks}
        contentContainerStyle={{ paddingBottom: 40 }}
        ListFooterComponent={
          isFetchingMore ? (
            <View className="items-center py-4">
              <ActivityIndicator size="small" color={theme.primary} />
            </View>
          ) : null
        }
        ListEmptyComponent={
          suppressEmptyState ? null : (
            <View className="flex-1 items-center justify-center px-4 py-12">
              <MaterialCommunityIcons name="book-open-page-variant" size={48} color={theme.textSoft} />
              <Text className="mt-4 font-sans text-lg font-semibold" style={{ fontFamily: "Poppins-SemiBold", color: theme.text }}>
                No Books Yet
              </Text>
              <Text className="mt-2 text-center font-sans text-sm" style={{ fontFamily: "Poppins-Regular", color: theme.textSoft }}>
                {isLoggedInUser
                  ? "You haven't published any books yet.\nStart writing and share your first story!"
                  : "This user hasn't published any books yet."}
              </Text>
            </View>
          )
        }
        refreshControl={
          <RefreshControl
            tintColor={theme.primary}
            titleColor={theme.text}
            refreshing={refreshing}
            onRefresh={useCallback(async () => {
              setRefreshing(true);
              await onRefresh();
              setRefreshing(false);
            })}
          />
        }
      />
    </View>
  );
};

export default ProfileBooksTab;
