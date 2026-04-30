// Books > Reading List sub-tab.
// Shows the user's own reading lists with a preview row of book covers, tap to
// open the full list of books in a sheet, and (on own profile) the ability to
// delete a list or remove a book from it.
//
// Activated by the parent PagerView via `isActive`. Data is fetched on focus
// when active, and refreshed on pull-to-refresh.

import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, InteractionManager, RefreshControl, ScrollView, Text, TouchableOpacity, View } from "react-native";
import Modal from "react-native-modal";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import useResetOnBlur from "../hooks/useResetOnBlur";
import { UserReadingListService } from "../lib/user-reading-list";
import BookLibraryCard from "./BookLibraryCard";

const BooksReadingList = ({ isActive = false }) => {
  const { theme } = useAppTheme();
  const { user } = useGlobalContext();

  const [readingLists, setReadingLists] = useState([]);
  const [loadingLists, setLoadingLists] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedList, setSelectedList] = useState(null);
  const [selectedListBooks, setSelectedListBooks] = useState([]);
  const [loadingListBooks, setLoadingListBooks] = useState(false);
  const [removingBookId, setRemovingBookId] = useState(null);
  const [deletingList, setDeletingList] = useState(false);
  const [listSheetVisible, setListSheetVisible] = useState(false);

  useResetOnBlur(setRefreshing);

  const userReadingListService = useMemo(() => new UserReadingListService(), []);
  const isActiveRef = useRef(isActive);
  const hasFetchedOnceRef = useRef(false);

  // Always treat the user as the owner here — Reading List is a self-only tab.
  const isOwner = true;

  const getListBookEntries = (list) => {
    if (!Array.isArray(list?.readingListBooks)) return [];
    return list.readingListBooks.filter((entry) => entry?.book && typeof entry.book === "object");
  };
  const getListBooksTotal = (list) => getListBookEntries(list).length;

  const fetchReadingLists = useCallback(
    async ({ silent = false } = {}) => {
      if (!user?.$id) {
        setReadingLists([]);
        setLoadingLists(false);
        return;
      }
      if (!silent && !hasFetchedOnceRef.current) setLoadingLists(true);

      try {
        const res = await userReadingListService.fetchUserReadingLists({ ownerId: user.$id, limit: 50 });
        setReadingLists(res?.documents || []);
      } catch (error) {
        console.log("BooksReadingList fetchReadingLists error:", error);
      } finally {
        setLoadingLists(false);
        hasFetchedOnceRef.current = true;
      }
    },
    [user?.$id, userReadingListService],
  );

  // Refetch on focus, but only when the sub-tab is actually active.
  useFocusEffect(
    useCallback(() => {
      isActiveRef.current = isActive;
      if (isActive) void fetchReadingLists();
    }, [fetchReadingLists, isActive]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetchReadingLists({ silent: true });
    } finally {
      setRefreshing(false);
    }
  }, [fetchReadingLists]);

  const handleOpenList = (list) => {
    if (!list?.$id) return;
    setSelectedList(list);
    setListSheetVisible(true);
    setLoadingListBooks(true);
    try {
      setSelectedListBooks(getListBookEntries(list));
    } finally {
      setLoadingListBooks(false);
    }
  };

  const closeSheet = () => {
    setListSheetVisible(false);
    setSelectedList(null);
    setSelectedListBooks([]);
    setLoadingListBooks(false);
    setRemovingBookId(null);
    setDeletingList(false);
  };

  const removeBookFromList = async (bookEntry) => {
    if (!selectedList?.$id || !bookEntry?.$id) return;
    try {
      setRemovingBookId(bookEntry.$id);
      await userReadingListService.removeBookFromReadingList({ readingListBookId: bookEntry.$id });
      setSelectedListBooks((prev) => prev.filter((entry) => entry.$id !== bookEntry.$id));
      setSelectedList((prev) =>
        prev
          ? {
              ...prev,
              readingListBooks: getListBookEntries(prev).filter((entry) => entry.$id !== bookEntry.$id),
            }
          : prev,
      );
      setReadingLists((prev) =>
        prev.map((list) =>
          list.$id === selectedList.$id
            ? {
                ...list,
                readingListBooks: getListBookEntries(list).filter((entry) => entry.$id !== bookEntry.$id),
              }
            : list,
        ),
      );
    } catch (error) {
      console.log("BooksReadingList removeBook error:", error);
    } finally {
      setRemovingBookId(null);
    }
  };

  const handleRemoveBook = (bookEntry) => {
    Alert.alert("Remove book", "Remove this book from the reading list?", [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => removeBookFromList(bookEntry) },
    ]);
  };

  const deleteList = async (list) => {
    if (!list?.$id) return;
    try {
      setDeletingList(true);
      const entries = getListBookEntries(list);
      for (const entry of entries) {
        try {
          await userReadingListService.removeBookFromReadingList({ readingListBookId: entry.$id });
        } catch (error) {
          console.log("BooksReadingList deleteList removeEntry error:", error);
        }
      }
      await userReadingListService.deleteUserReadingList({ readingListId: list.$id });
      setReadingLists((prev) => prev.filter((entry) => entry.$id !== list.$id));
      if (selectedList?.$id === list.$id) closeSheet();
    } catch (error) {
      console.log("BooksReadingList deleteList error:", error);
    } finally {
      setDeletingList(false);
    }
  };

  const handleDeleteList = (list) => {
    if (!list?.$id) return;
    Alert.alert("Delete reading list", "Delete this reading list and remove all books from it?", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => deleteList(list) },
    ]);
  };

  // Wait one frame so the close-modal transition completes before the next
  // sheet opens (otherwise the new sheet stutters).
  const waitForTransition = useCallback(() => new Promise((resolve) => InteractionManager.runAfterInteractions(() => resolve())), []);

  const renderReadingListItem = ({ item: list, index }) => {
    const previewEntries = getListBookEntries(list).slice(0, 3);
    const isLast = index === readingLists.length - 1;

    return (
      <View
        className={`rounded-2xl px-3 py-3 ${isLast ? "" : "mb-3"}`}
        style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}
      >
        <View className="flex-row items-center justify-between">
          <View className="mr-3 flex-1">
            <Text className="text-base font-bold" style={{ color: theme.text }} numberOfLines={1}>
              {list?.title || "Untitled"}
            </Text>
            <Text className="mt-0.5 text-xs" style={{ color: theme.textSoft }}>
              {getListBooksTotal(list)} {getListBooksTotal(list) === 1 ? "book" : "books"}
            </Text>
          </View>
          <View className="flex-row items-center">
            <TouchableOpacity
              onPress={() => handleOpenList(list)}
              activeOpacity={0.85}
              className="rounded-full px-3 py-1.5"
              style={{ backgroundColor: theme.primary }}
            >
              <Text className="text-xs font-semibold" style={{ color: theme.primaryContrast }}>
                Open
              </Text>
            </TouchableOpacity>
            {isOwner ? (
              <TouchableOpacity
                onPress={() => handleDeleteList(list)}
                activeOpacity={0.85}
                className="ml-2 h-8 w-8 items-center justify-center rounded-full"
                style={{ backgroundColor: theme.dangerSoft }}
              >
                <MaterialCommunityIcons name="trash-can-outline" size={16} color={theme.danger} />
              </TouchableOpacity>
            ) : null}
          </View>
        </View>

        {previewEntries.length > 0 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mt-3" contentContainerStyle={{ paddingRight: 8 }}>
            {previewEntries.map((entry) => (
              <BookLibraryCard
                key={`${list.$id}-${entry?.$id}`}
                item={entry?.book}
                hideSettings
                hideStats
                customStyle={{
                  width: 220,
                  backgroundColor: theme.card,
                  paddingHorizontal: 5,
                  paddingVertical: 3,
                  marginRight: 10,
                  marginBottom: 0,
                }}
              />
            ))}
          </ScrollView>
        ) : null}
      </View>
    );
  };

  const renderListBookItem = ({ item: bookEntry }) => (
    <View>
      {isOwner ? (
        <TouchableOpacity
          disabled={removingBookId === bookEntry?.$id}
          onPress={() => handleRemoveBook(bookEntry)}
          className="mb-3 mr-1 self-end rounded-full px-3 py-1.5"
          style={{ backgroundColor: theme.dangerSoft }}
        >
          {removingBookId === bookEntry?.$id ? (
            <ActivityIndicator size="small" color={theme.danger} />
          ) : (
            <Text className="text-xs font-semibold" style={{ color: theme.danger }}>
              Remove from list
            </Text>
          )}
        </TouchableOpacity>
      ) : null}
      <BookLibraryCard item={bookEntry?.book} hideSettings customStyle={{ backgroundColor: theme.card, paddingHorizontal: 5, paddingVertical: 3 }} />
    </View>
  );

  const renderEmptyState = () => (
    <View className="items-center justify-center px-4 py-12">
      <MaterialCommunityIcons name="bookmark-multiple-outline" size={56} color={theme.textSubtle} />
      <Text className="mt-4 text-base font-semibold" style={{ color: theme.text }}>
        No reading lists yet
      </Text>
      <Text className="mt-2 text-center text-sm" style={{ color: theme.textSoft }}>
        Bookmark a book and add it to a reading list to see it here.
      </Text>
    </View>
  );

  return (
    <View className="flex-1">
      {loadingLists && readingLists.length === 0 ? (
        <View className="items-center justify-center py-10">
          <ActivityIndicator size="small" color={theme.primary} />
        </View>
      ) : (
        <FlatList
          data={readingLists}
          keyExtractor={(item) => item?.$id || `list-${item?.title ?? Math.random()}`}
          renderItem={renderReadingListItem}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 50, paddingTop: 6 }}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={renderEmptyState}
          refreshControl={
            <RefreshControl
              tintColor={theme.primary}
              titleColor={theme.primary}
              progressBackgroundColor={theme.surface}
              refreshing={refreshing}
              onRefresh={onRefresh}
            />
          }
        />
      )}

      <Modal
        isVisible={listSheetVisible}
        onBackdropPress={closeSheet}
        onBackButtonPress={closeSheet}
        swipeDirection="down"
        onSwipeComplete={closeSheet}
        style={{ justifyContent: "flex-end", margin: 0 }}
        backdropOpacity={0.3}
        propagateSwipe
      >
        <View
          className="max-h-[85%] rounded-t-3xl px-4 pb-5 pt-3"
          style={{ borderTopWidth: 1, borderTopColor: theme.border, backgroundColor: theme.background }}
        >
          <View className="items-center pb-2">
            <View className="h-1.5 w-16 rounded-full" style={{ backgroundColor: theme.handle }} />
          </View>

          <View className="mb-3 flex-row items-center justify-between">
            <View className="mr-3 flex-1">
              <Text className="text-lg font-bold" style={{ color: theme.text }} numberOfLines={1}>
                {selectedList?.title || "Reading List"}
              </Text>
              <Text className="text-xs" style={{ color: theme.textSoft }}>
                {getListBooksTotal(selectedList)} {getListBooksTotal(selectedList) === 1 ? "book" : "books"}
              </Text>
            </View>
            <View className="flex-row items-center">
              {isOwner ? (
                <TouchableOpacity
                  disabled={deletingList}
                  onPress={async () => {
                    const list = selectedList;
                    closeSheet();
                    await waitForTransition();
                    handleDeleteList(list);
                  }}
                  className="mr-2 h-9 w-9 items-center justify-center rounded-full"
                  style={{ backgroundColor: theme.dangerSoft }}
                >
                  {deletingList ? (
                    <ActivityIndicator size="small" color={theme.danger} />
                  ) : (
                    <MaterialCommunityIcons name="delete-outline" size={18} color={theme.danger} />
                  )}
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity
                onPress={closeSheet}
                className="h-9 w-9 items-center justify-center rounded-full"
                style={{ backgroundColor: theme.surfaceMuted }}
              >
                <MaterialCommunityIcons name="close" size={18} color={theme.icon} />
              </TouchableOpacity>
            </View>
          </View>

          <View className="rounded-2xl p-2" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
            {loadingListBooks ? (
              <View className="items-center py-8">
                <ActivityIndicator size="small" color={theme.primary} />
              </View>
            ) : selectedListBooks.length > 0 ? (
              <FlatList
                data={selectedListBooks}
                keyExtractor={(item) => item?.$id || `entry-${Math.random()}`}
                renderItem={renderListBookItem}
                showsVerticalScrollIndicator={false}
                contentContainerStyle={{ paddingBottom: 8 }}
              />
            ) : (
              <View className="px-4 py-6 items-center">
                <Text className="text-center text-sm" style={{ color: theme.textSoft }}>
                  No books in this reading list yet.
                </Text>
              </View>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
};

export default BooksReadingList;
