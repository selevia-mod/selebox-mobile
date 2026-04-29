import { AntDesign, MaterialCommunityIcons, MaterialIcons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Text, TouchableOpacity, View } from "react-native";
import { RefreshControl } from "react-native-gesture-handler";
import { useDispatch, useSelector } from "react-redux";
import { BookCatalogCard, StyledSafeAreaView, StyledTitle } from "../../components";
import { useGlobalContext } from "../../context/global-provider";
import useAppTheme from "../../hooks/useAppTheme";
import useResetOnBlur from "../../hooks/useResetOnBlur";
import { BookService } from "../../lib/books";
import { removeLocalDraft, setUserBooks } from "../../store/reducers/books";

const Catalog = () => {
  const { theme } = useAppTheme();
  const { user } = useGlobalContext();
  const dispatch = useDispatch();
  const { userBooks } = useSelector((state) => state.books);
  const localDrafts = useSelector((state) => state?.books?.localDrafts || {});
  const [refreshing, setRefreshing] = useState(false);
  const [lastId, setLastId] = useState();
  const [hasMore, setHasMore] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  useResetOnBlur(setRefreshing, setIsFetchingMore);

  const bookService = new BookService();
  const localDraftPrefix = `bookDraft:${user?.$id}:`;
  const localDraftEntries = useMemo(() => {
    return Object.entries(localDrafts)
      .filter(
        ([draftKey, draftValue]) =>
          draftKey.startsWith(localDraftPrefix) &&
          !draftValue?.meta?.bookId &&
          (draftValue?.chapterForm || (Array.isArray(draftValue?.chapters) && draftValue.chapters.length)),
      )
      .map(([draftKey, draftValue]) => ({ draftKey, draftValue }))
      .sort((a, b) => Number(b.draftValue?.updatedAt || 0) - Number(a.draftValue?.updatedAt || 0));
  }, [localDraftPrefix, localDrafts]);

  useFocusEffect(
    useCallback(() => {
      fetchUserBooks();
    }, []),
  );

  const fetchUserBooks = async () => {
    try {
      const booksData = await bookService.fetchBooks({ userId: user.$id });
      const newestBooks = booksData.documents || [];
      setLastId(newestBooks[newestBooks.length - 1]?.$id);
      setHasMore(newestBooks.length < booksData.total);
      dispatch(setUserBooks(newestBooks));
    } catch (error) {
      console.log("fetchUserBooks: error", error);
    }
  };

  const fetchMoreUserBooks = async () => {
    try {
      if (!lastId || !hasMore) return;
      setIsFetchingMore(true);
      const booksData = await bookService.fetchBooks({ userId: user.$id, lastId: lastId });
      const uniqueBook = booksData.documents.filter((book) => !userBooks.some((existing) => existing.$id === book.$id));
      if (uniqueBook.length === 0) {
        setHasMore(false);
        setIsFetchingMore(false);
        return;
      }
      const updatedFetchedUserBooks = [...userBooks, ...uniqueBook];
      setLastId(booksData.documents[booksData.documents.length - 1]?.$id);
      dispatch(setUserBooks(updatedFetchedUserBooks));
      if (updatedFetchedUserBooks.length >= booksData.total) setHasMore(false);
    } catch (error) {
      console.log("fetchMoreUserBooks: error", error);
    } finally {
      setIsFetchingMore(false);
    }
  };

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetchUserBooks();
    } finally {
      setRefreshing(false);
    }
  }, []);

  const handleCreateNew = () => router.push("book-editor");

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
    return <BookCatalogCard item={item} handleDeleteBook={handleDeleteBook} />;
  };

  const getLocalDraftBookTitle = (draftEntry) => {
    const { draftKey, draftValue } = draftEntry || {};
    const snapshotTitle = draftValue?.bookSnapshot?.title?.trim();
    if (snapshotTitle) return snapshotTitle;
    const metaTitle = draftValue?.meta?.bookTitle?.trim();
    if (metaTitle) return metaTitle;
    const matched = draftKey?.match(/newBook:([^:]+)/);
    if (matched?.[1]) return matched[1];
    return "Untitled Book";
  };

  const handleDeleteLocalDraft = (draftKey) => {
    Alert.alert("Delete offline draft", "Remove this offline draft from your device?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => dispatch(removeLocalDraft(draftKey)),
      },
    ]);
  };

  const handleResumeLocalDraft = async (draftEntry) => {
    try {
      const { draftValue } = draftEntry || {};
      const draftBookId = draftValue?.meta?.bookId;

      let resolvedBook = draftValue?.bookSnapshot || null;
      if (!resolvedBook && draftBookId) {
        resolvedBook = userBooks.find((book) => book?.$id === draftBookId) || null;
      }
      if (!resolvedBook && draftBookId) {
        resolvedBook = await bookService.fetchBook({ bookId: draftBookId });
      }

      if (!resolvedBook) {
        Alert.alert("Cannot resume draft", "This draft is missing book information. Please delete it and create a new draft.");
        return;
      }

      router.push({
        pathname: "book-editor",
        params: {
          book: JSON.stringify(resolvedBook),
          draftKey: draftEntry?.draftKey,
        },
      });
    } catch (error) {
      console.log("handleResumeLocalDraft: error", error);
      Alert.alert("Cannot resume draft", "Unable to open offline draft right now.");
    }
  };

  const renderLocalDraftsHeader = () => {
    if (!localDraftEntries.length) return null;

    return (
      <View className="mb-2">
        <View className="mb-3 flex-row items-center justify-between">
          <View className="flex-row items-center space-x-2">
            <View className="h-3.5 w-1 rounded-full" style={{ backgroundColor: theme.accentAmber }} />
            <Text className="text-[11px] font-semibold uppercase tracking-[3px]" style={{ color: theme.textSoft }}>
              Offline Drafts
            </Text>
          </View>
          <Text className="text-[11px]" style={{ color: theme.textSubtle }}>
            {localDraftEntries.length}
          </Text>
        </View>
        {localDraftEntries.map((draftEntry) => {
          const { draftValue } = draftEntry;
          const draftChapters =
            Array.isArray(draftValue?.chapters) && draftValue.chapters.length
              ? draftValue.chapters
              : draftValue?.chapterForm
                ? [draftValue.chapterForm]
                : [];
          const chapterCount = draftChapters.length;
          const bookTitle = getLocalDraftBookTitle(draftEntry);
          const latestChapter = [...draftChapters].sort((a, b) => Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0))[0];
          const localDraftItem = {
            title: bookTitle,
            status: "Draft",
            thumbnail:
              draftValue?.bookSnapshot?.thumbnail ||
              latestChapter?.thumbnail?.uri ||
              latestChapter?.thumbnail ||
              draftValue?.chapterForm?.thumbnail?.uri ||
              "",
            updatedAt: draftValue?.updatedAt,
          };

          return (
            <BookCatalogCard
              key={draftEntry.draftKey}
              item={localDraftItem}
              hideStats
              showViewAsReader={false}
              updatedAtLabel="Last saved"
              subtitle={`${chapterCount} ${chapterCount === 1 ? "chapter" : "chapters"} saved`}
              onPress={() => handleResumeLocalDraft(draftEntry)}
              onEdit={() => handleResumeLocalDraft(draftEntry)}
              onDelete={() => handleDeleteLocalDraft(draftEntry.draftKey)}
            />
          );
        })}
      </View>
    );
  };

  const renderBooksHeader = () => {
    return (
      <View className={localDraftEntries.length ? "mb-2 mt-4" : "mb-2"}>
        <View className="mb-3 flex-row items-center justify-between">
          <View className="flex-row items-center space-x-2">
            <View className="h-3.5 w-1 rounded-full" style={{ backgroundColor: theme.accentBlue }} />
            <Text className="text-[11px] font-semibold uppercase tracking-[3px]" style={{ color: theme.textSoft }}>
              My Books
            </Text>
          </View>
          <Text className="text-[11px]" style={{ color: theme.textSubtle }}>
            {userBooks.length}
          </Text>
        </View>
      </View>
    );
  };

  const renderCatalogListHeader = () => {
    return (
      <>
        {renderLocalDraftsHeader()}
        {renderBooksHeader()}
      </>
    );
  };

  return (
    <StyledSafeAreaView>
      <View className="h-full w-full">
        <View className="flex-row items-center justify-between px-4 pb-2 pt-2">
          <TouchableOpacity
            activeOpacity={0.7}
            className="h-10 w-10 items-center justify-center rounded-full"
            style={{ backgroundColor: theme.surfaceMuted }}
            onPress={() => router.back()}
          >
            <MaterialIcons name="arrow-back" size={22} color={theme.icon} />
          </TouchableOpacity>
          <View className="flex-row items-center space-x-2">
            <StyledTitle className="py-0" icon={<MaterialIcons name="create" size={22} color={theme.icon} />} title={"Author Section"} />
          </View>
          <TouchableOpacity
            activeOpacity={0.7}
            className="h-10 w-10 items-center justify-center rounded-full"
            style={{ backgroundColor: theme.surfaceMuted }}
            onPress={handleCreateNew}
          >
            <AntDesign name="plus" size={18} color={theme.icon} />
          </TouchableOpacity>
        </View>

        <View className="flex-1 px-3">
          <Text className="mb-3 text-xs font-semibold" style={{ color: theme.textSoft }}>
            Write, edit, and manage your book catalog.
          </Text>

          <View className="flex-1 rounded-2xl px-3 py-3" style={{ backgroundColor: theme.card }}>
            <FlatList
              data={userBooks}
              refreshing={refreshing}
              keyExtractor={(item, index) => item?.$id || `${item.type}-${index}`}
              renderItem={renderItem}
              showsVerticalScrollIndicator={false}
              onRefresh={onRefresh}
              onEndReached={fetchMoreUserBooks}
              onEndReachedThreshold={0.2}
              ListHeaderComponent={renderCatalogListHeader}
              contentContainerStyle={{ paddingBottom: 20 }}
              ListFooterComponent={
                isFetchingMore ? (
                  <View className="items-center py-4">
                    <ActivityIndicator size="small" color={theme.primary} />
                  </View>
                ) : null
              }
              ListEmptyComponent={
                localDraftEntries.length ? null : (
                  <View
                    className="items-center justify-center rounded-2xl px-4 py-12"
                    style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surfaceMuted }}
                  >
                    <MaterialCommunityIcons name="book-open-page-variant" size={48} color={theme.iconMuted} />
                    <Text className="mt-4 text-lg font-semibold" style={{ color: theme.text }}>
                      No Books Yet
                    </Text>
                    <Text className="mt-2 text-center text-sm" style={{ color: theme.textSoft }}>
                      You haven’t published any books yet.{"\n"}
                      Start writing and share your first story!
                    </Text>
                    <TouchableOpacity
                      activeOpacity={0.8}
                      onPress={handleCreateNew}
                      className="mt-4 rounded-xl px-4 py-2"
                      style={{ backgroundColor: theme.primary }}
                    >
                      <Text className="text-sm font-semibold" style={{ color: theme.primaryContrast }}>
                        Create your first book
                      </Text>
                    </TouchableOpacity>
                  </View>
                )
              }
              refreshControl={<RefreshControl tintColor={theme.primary} titleColor={theme.text} refreshing={refreshing} onRefresh={onRefresh} />}
            />
          </View>
        </View>
      </View>
    </StyledSafeAreaView>
  );
};

export default Catalog;
