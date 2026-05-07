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
import BookLockPromptBanner from "./BookLockPromptBanner";

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
  // Supabase stores status values lowercase ('ongoing', 'completed'). The old
  // Appwrite values were title-cased ('Ongoing', 'Completed'); after the
  // migration this filter started returning zero rows for non-self viewers.
  const bookStatus = isLoggedInUser ? undefined : ["ongoing", "completed"];

  // "Does the viewing writer have at least one paid book?" — gates the
  // BookLockPromptBanner on each Free row. Only resolved when the
  // viewer is looking at their OWN profile (i.e. the cards are
  // BookCatalogCard, the writer-facing variant). Falls through to false
  // for everyone else, so the banner stays hidden on other users'
  // profiles even if our cache holds a stale `true`. RPC is cheap
  // (single EXISTS) and runs once per tab focus.
  const [hasPaidBooks, setHasPaidBooks] = useState(false);
  // Per-book optimistic dismissal — keyed by book.$id. Lets the row
  // unmount its banner immediately when the author taps Lock or
  // Dismiss, without waiting for the next refetch to drop the prompt.
  const [dismissedBookIds, setDismissedBookIds] = useState(() => new Set());

  useFocusEffect(
    useCallback(() => {
      fetchUserBooks();
    }, [userId]),
  );

  // Resolve the qualifier flag — only for the self-viewing case. Any
  // other viewer sees regular cards without a lock banner anyway.
  useFocusEffect(
    useCallback(() => {
      if (!isLoggedInUser || !user?.$id) {
        setHasPaidBooks(false);
        return;
      }
      let cancelled = false;
      (async () => {
        try {
          const has = await bookService.hasPaidBooks({ userId: user.$id });
          if (!cancelled) setHasPaidBooks(Boolean(has));
        } catch (err) {
          // Non-fatal — banner just stays hidden.
          console.error("ProfileBooksTab: hasPaidBooks failed:", err?.message);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [isLoggedInUser, user?.$id]),
  );

  const fetchUserBooks = async () => {
    if (!hasLoadedRef.current) onLoadingChange?.(true);
    try {
      // Pass actorUserId so fetchBooks can detect self-author and route
      // through fetch_author_books RPC to include drafts. The check is
      // server-verified via actor=author equality inside the RPC, so
      // passing this even on other users' profiles is safe — those
      // requests already supply `bookStatus` which short-circuits the
      // self-author path anyway.
      const booksData = await bookService.fetchBooks({
        userId: userId,
        actorUserId: user?.$id,
        status: bookStatus,
      });
      setUserBooks(booksData.documents);
      setLastId(booksData.documents[booksData.documents.length - 1]?.$id);
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
      const booksData = await bookService.fetchBooks({ userId: userId, actorUserId: user?.$id, lastId: lastId, status: bookStatus });
      const uniqueBook = booksData.documents.filter((book) => !userBooks.some((existing) => existing.$id === book.$id));
      if (uniqueBook.length === 0) {
        setHasMore(false);
        setIsFetchingMore(false);
        return;
      }
      const updatedFetchedUserBooks = [...userBooks, ...uniqueBook];
      setUserBooks(updatedFetchedUserBooks);
      setLastId(booksData.documents[booksData.documents.length - 1]?.$id);
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
              // Pass userId so deleteBook can resolve the Supabase actor
              // for the SECURITY DEFINER RPC that verifies ownership.
              // Without this it falls back to messages-user, which works
              // today but is less explicit.
              await bookService.deleteBook({ ID: bookId, userId: user?.$id });
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
    if (!isLoggedInUser) {
      return <BookLibraryCard item={item} hideRemove />;
    }
    // Self-viewing path — render the lock-prompt banner above books
    // that qualify. The banner itself triple-checks visibility (book
    // is Free, not dismissed, qualifier flag true), but the
    // dismissedBookIds gate handles same-session optimistic hides
    // without waiting for the next refetch to drop the prompt.
    const showBanner = !dismissedBookIds.has(item?.$id);
    return (
      <View>
        {showBanner ? (
          <BookLockPromptBanner
            book={item}
            shouldShow={hasPaidBooks}
            userId={user?.$id}
            onLocked={() => {
              setDismissedBookIds((prev) => {
                const next = new Set(prev);
                next.add(item?.$id);
                return next;
              });
              // Bounce the list refresh in the background so the card
              // re-renders with its new "Paid" tag the next pass.
              fetchUserBooks();
            }}
            onDismissed={() => {
              setDismissedBookIds((prev) => {
                const next = new Set(prev);
                next.add(item?.$id);
                return next;
              });
            }}
          />
        ) : null}
        <BookCatalogCard item={item} handleDeleteBook={handleDeleteBook} />
      </View>
    );
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
