import { FontAwesome, MaterialCommunityIcons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, InteractionManager, RefreshControl, ScrollView, Text, TouchableOpacity, View } from "react-native";
import Modal from "react-native-modal";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import { sortByViews } from "../lib/appwrite";
import { BookService } from "../lib/books";
import { fetchClips } from "../lib/clips";
import { UserReadingListService } from "../lib/user-reading-list";
import BookLibraryCard from "./BookLibraryCard";
import StyledFlatList from "./StyledFlatList";
import VideoCardSmall from "./VideoCardSmall";

const ProfileHomeTab = ({ userVideos, userId, nestedScrollEnabled = false, headerComponent, tabBarComponent }) => {
  const { user } = useGlobalContext();
  const { theme } = useAppTheme();
  const [videos, setVideos] = useState([]);
  const [clips, setClips] = useState([]);
  const [books, setBooks] = useState([]);
  const [readingLists, setReadingLists] = useState([]);
  const [loadingReadingLists, setLoadingReadingLists] = useState(false);
  const [selectedReadingList, setSelectedReadingList] = useState(null);
  const [readingListBooks, setReadingListBooks] = useState([]);
  const [loadingReadingListBooks, setLoadingReadingListBooks] = useState(false);
  const [removingReadingListBookId, setRemovingReadingListBookId] = useState(null);
  const [deletingReadingList, setDeletingReadingList] = useState(false);
  const [readingListModalVisible, setReadingListModalVisible] = useState(false);
  const [allReadingListsModalVisible, setAllReadingListsModalVisible] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const pendingReadingListOpenRef = useRef(null);

  const bookService = useMemo(() => new BookService(), []);
  const userReadingListService = useMemo(() => new UserReadingListService(), []);
  const isLoggedInUser = user?.$id === userId;
  const bookStatus = isLoggedInUser ? undefined : ["Ongoing", "Completed"];
  const displayedReadingLists = useMemo(() => readingLists.slice(0, 3), [readingLists]);

  useFocusEffect(
    useCallback(() => {
      fetchUserMostViewedVideos();
      fetchUserRecentClips();
      fetchUserRecentBooks();
      fetchUserReadingLists();
    }, [userId, userVideos]),
  );

  const getReadingListBookEntries = (readingList) => {
    if (!Array.isArray(readingList?.readingListBooks)) return [];
    return readingList.readingListBooks.filter((entry) => entry?.book && typeof entry.book === "object");
  };

  const getReadingListBooksTotal = (readingList) => getReadingListBookEntries(readingList).length;

  const fetchUserMostViewedVideos = async () => {
    const videoData = await sortByViews(userVideos, 3);
    setVideos(videoData);
  };

  const fetchUserRecentClips = async () => {
    try {
      if (userId) {
        const clipsData = await fetchClips({ limit: 3, userId: userId });
        setClips(clipsData.documents);
      }
    } catch (error) {
      console.log("fetchUserRecentClipsError", error);
    }
  };

  const fetchUserRecentBooks = async () => {
    try {
      if (userId) {
        const booksData = await bookService.fetchBooks({ userId: userId, limit: 3, status: bookStatus });
        setBooks(booksData.documents);
      }
    } catch (error) {
      console.error("fetchUserRecentBooks", error);
    }
  };

  const fetchUserReadingLists = async () => {
    try {
      if (!userId) {
        setReadingLists([]);
        return;
      }

      setLoadingReadingLists(true);
      const readingListsData = await userReadingListService.fetchUserReadingLists({ ownerId: userId, limit: 50 });
      setReadingLists(readingListsData?.documents || []);
    } catch (error) {
      console.log("fetchUserReadingLists: error", error);
      setReadingLists([]);
    } finally {
      setLoadingReadingLists(false);
    }
  };

  const handleOpenReadingList = async (readingList) => {
    if (!readingList?.$id) return;

    setSelectedReadingList(readingList);
    setReadingListModalVisible(true);
    setLoadingReadingListBooks(true);

    try {
      setReadingListBooks(getReadingListBookEntries(readingList));
    } catch (error) {
      console.log("handleOpenReadingList: error", error);
      setReadingListBooks([]);
    } finally {
      setLoadingReadingListBooks(false);
    }
  };

  const closeReadingListModal = () => {
    setReadingListModalVisible(false);
    setSelectedReadingList(null);
    setReadingListBooks([]);
    setLoadingReadingListBooks(false);
    setRemovingReadingListBookId(null);
    setDeletingReadingList(false);
  };

  const waitForReadingListModalTransition = useCallback(
    () =>
      new Promise((resolve) => {
        InteractionManager.runAfterInteractions(() => {
          requestAnimationFrame(() => resolve());
        });
      }),
    [],
  );

  const removeBookFromReadingList = async (bookEntry) => {
    if (!selectedReadingList?.$id || !bookEntry?.$id) return;

    try {
      setRemovingReadingListBookId(bookEntry.$id);
      await userReadingListService.removeBookFromReadingList({ readingListBookId: bookEntry.$id });

      setReadingListBooks((prev) => prev.filter((entry) => entry.$id !== bookEntry.$id));

      setSelectedReadingList((prev) =>
        prev
          ? {
              ...prev,
              readingListBooks: getReadingListBookEntries(prev).filter((entry) => entry.$id !== bookEntry.$id),
            }
          : prev,
      );

      setReadingLists((prev) =>
        prev.map((list) =>
          list.$id === selectedReadingList.$id
            ? {
                ...list,
                readingListBooks: getReadingListBookEntries(list).filter((entry) => entry.$id !== bookEntry.$id),
              }
            : list,
        ),
      );
    } catch (error) {
      console.log("removeBookFromReadingList: error", error);
      Alert.alert("Error", "Unable to remove this book from the reading list.");
    } finally {
      setRemovingReadingListBookId(null);
    }
  };

  const handleRemoveBookFromReadingList = (bookEntry) => {
    Alert.alert("Remove Book", "Remove this book from the reading list?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => removeBookFromReadingList(bookEntry),
      },
    ]);
  };

  const deleteReadingList = async (readingList) => {
    if (!readingList?.$id) return;

    try {
      setDeletingReadingList(true);

      const entries = getReadingListBookEntries(readingList);
      for (const entry of entries) {
        try {
          await userReadingListService.removeBookFromReadingList({ readingListBookId: entry.$id });
        } catch (error) {
          console.log("deleteReadingList: removeEntryError", error);
        }
      }

      await userReadingListService.deleteUserReadingList({ readingListId: readingList.$id });

      setReadingLists((prev) => prev.filter((list) => list.$id !== readingList.$id));

      if (selectedReadingList?.$id === readingList.$id) {
        closeReadingListModal();
      }
    } catch (error) {
      console.log("deleteReadingList: error", error);
      Alert.alert("Error", "Unable to delete this reading list.");
    } finally {
      setDeletingReadingList(false);
    }
  };

  const handleDeleteReadingList = (readingList = selectedReadingList) => {
    if (!readingList?.$id) return;

    Alert.alert("Delete Reading List", "Delete this reading list and all books inside it?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => deleteReadingList(readingList),
      },
    ]);
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([fetchUserMostViewedVideos(), fetchUserRecentClips(), fetchUserRecentBooks(), fetchUserReadingLists()]);
    } catch (error) {
      console.error("Error refreshing profile home tab:", error);
    } finally {
      setRefreshing(false);
    }
  };

  const renderSectionHeader = ({ icon, iconType = "mci", title, subtitle, actionLabel, onActionPress, actionDisabled = false }) => {
    const IconComponent = iconType === "fa" ? FontAwesome : MaterialCommunityIcons;
    return (
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center">
          <View className="mr-2 h-9 w-9 items-center justify-center rounded-xl" style={{ backgroundColor: theme.surfaceMuted }}>
            <IconComponent name={icon} size={18} color={theme.icon} />
          </View>
          <View>
            <Text className="text-base font-semibold" style={{ color: theme.text }}>
              {title}
            </Text>
            <Text className="text-[11px] font-semibold" style={{ color: theme.textSoft }}>
              {subtitle}
            </Text>
          </View>
        </View>

        {actionLabel ? (
          <TouchableOpacity disabled={actionDisabled} onPress={onActionPress} className={actionDisabled ? "opacity-40" : ""}>
            <Text className="text-xs font-semibold" style={{ color: theme.primary }}>
              {actionLabel}
            </Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  };

  const renderHorizontalPlaceholders = ({ count = 3, width = 160, height = 120, icon, iconType = "mci" }) => {
    const IconComponent = iconType === "fa" ? FontAwesome : MaterialCommunityIcons;
    return (
      <View className="flex-row px-2 py-3">
        {Array.from({ length: count }).map((_, index) => (
          <View
            key={`placeholder-${width}-${index}`}
            className="mr-3 items-center justify-center rounded-2xl"
            style={{ width, height, borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}
          >
            <IconComponent name={icon} size={28} color={theme.textSubtle} />
          </View>
        ))}
      </View>
    );
  };

  const renderEmptyText = (text) => (
    <View className="px-4 pb-4">
      <Text className="text-center text-xs" style={{ color: theme.textSoft }}>
        {text}
      </Text>
    </View>
  );

  const renderAllReadingListItem = ({ item: readingList, index }) => (
    <View
      className={`flex-row items-center justify-between rounded-xl px-3 py-3 ${index !== readingLists.length - 1 ? "mb-2" : ""}`}
      style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}
    >
      <View className="mr-3 flex-1">
        <Text className="text-sm font-semibold" style={{ color: theme.text }} numberOfLines={1}>
          {readingList?.title || "Untitled"}
        </Text>
        <Text className="mt-1 text-xs" style={{ color: theme.textSoft }}>
          {getReadingListBooksTotal(readingList)} books
        </Text>
      </View>
      <View className="flex-row items-center">
        <TouchableOpacity
          onPress={() => {
            pendingReadingListOpenRef.current = readingList;
            setAllReadingListsModalVisible(false);
          }}
          className="mr-2 rounded-full px-3 py-1.5"
          style={{ backgroundColor: theme.surfaceMuted }}
        >
          <Text className="text-xs font-semibold" style={{ color: theme.text }}>
            Open
          </Text>
        </TouchableOpacity>

        {isLoggedInUser ? (
          <TouchableOpacity
            onPress={() => handleDeleteReadingList(readingList)}
            className="rounded-full px-3 py-1.5"
            style={{ backgroundColor: theme.dangerSoft }}
          >
            <Text className="text-xs font-semibold" style={{ color: theme.danger }}>
              Delete
            </Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );

  const renderReadingListBookItem = ({ item: bookEntry }) => (
    <View>
      {isLoggedInUser ? (
        <TouchableOpacity
          disabled={removingReadingListBookId === bookEntry?.$id}
          onPress={() => handleRemoveBookFromReadingList(bookEntry)}
          className="mb-3 mr-1 self-end rounded-full px-3 py-1.5"
          style={{ backgroundColor: theme.dangerSoft }}
        >
          {removingReadingListBookId === bookEntry?.$id ? (
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

  return (
    <>
      <ScrollView
        nestedScrollEnabled={nestedScrollEnabled}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={theme.primary} colors={[theme.primary]} />}
      >
        {headerComponent}
        {tabBarComponent}
        <View className="flex-1 py-2">
          <View>
            {renderSectionHeader({
              icon: "book-open-page-variant",
              title: "Recent Books",
              subtitle: "Latest 3",
            })}
            <View className="mt-3 rounded-2xl p-2" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
              {books.length > 0 ? (
                <StyledFlatList
                  horizontal={true}
                  scrollEnabled={true}
                  key={"bookHomeTab"}
                  data={books}
                  refreshControl={null}
                  renderItem={({ item }) => (
                    <BookLibraryCard
                      item={item}
                      hideSettings
                      hideStats
                      customStyle={{ width: 260, backgroundColor: theme.card, paddingHorizontal: 5, paddingVertical: 3, marginRight: 10 }}
                    />
                  )}
                  ListFooterComponent={null}
                  showsVerticalScrollIndicator={false}
                  showsHorizontalScrollIndicator={false}
                  scrollToTopStyle={{ bottom: 5 }}
                  emptyStateImageStyle={{ height: 90 }}
                  emptyStateTitleStyle={{ fontSize: 15 }}
                  contentContainerStyle={{ paddingHorizontal: 4, paddingVertical: 4 }}
                />
              ) : (
                <View className="py-1">
                  {renderHorizontalPlaceholders({
                    count: 2,
                    width: 240,
                    height: 160,
                    icon: "book-open-page-variant",
                  })}
                  {renderEmptyText(isLoggedInUser ? "No books yet." : "No books yet.")}
                </View>
              )}
            </View>
          </View>

          <View className="mt-5">
            {renderSectionHeader({
              icon: "film",
              iconType: "fa",
              title: "Most Viewed Videos",
              subtitle: "Top 3",
            })}
            <View className="mt-3 rounded-2xl p-2" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
              {videos.length > 0 ? (
                <StyledFlatList
                  horizontal={true}
                  scrollEnabled={true}
                  key={"videoHomeTab"}
                  data={videos}
                  refreshControl={null}
                  renderItem={({ item }) => <VideoCardSmall isFlexColumn={true} item={item} key={item?.uri} />}
                  ListFooterComponent={null}
                  showsVerticalScrollIndicator={false}
                  showsHorizontalScrollIndicator={false}
                  scrollToTopStyle={{ bottom: 5 }}
                  emptyStateImageStyle={{ height: 90 }}
                  emptyStateTitleStyle={{ fontSize: 15 }}
                  contentContainerStyle={{ paddingHorizontal: 4, paddingVertical: 4 }}
                />
              ) : (
                <View className="py-1">
                  {renderHorizontalPlaceholders({
                    count: 3,
                    width: 160,
                    height: 120,
                    icon: "film",
                    iconType: "fa",
                  })}
                  {renderEmptyText(isLoggedInUser ? "No videos yet." : "No videos yet.")}
                </View>
              )}
            </View>
          </View>

          <View className="mt-5">
            {renderSectionHeader({
              icon: "bookmark-multiple-outline",
              title: "Reading Lists",
              subtitle: "Collections",
              actionLabel: "See all",
              actionDisabled: readingLists.length === 0,
              onActionPress: () => setAllReadingListsModalVisible(true),
            })}
            <View className="mt-3 rounded-2xl p-2" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
              {loadingReadingLists ? (
                <View className="items-center py-6">
                  <ActivityIndicator size="small" color={theme.primary} />
                </View>
              ) : displayedReadingLists.length > 0 ? (
                <View className="px-1 py-1">
                  {displayedReadingLists.map((readingList, index) => {
                    const previewEntries = getReadingListBookEntries(readingList).slice(0, 3);

                    return (
                      <View
                        key={readingList.$id}
                        className={`rounded-xl px-3 py-3 ${index !== displayedReadingLists.length - 1 ? "mb-2" : ""}`}
                        style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}
                      >
                        <View className="mt-2">
                          <View className="flex-row justify-between">
                            <View className="flex-1">
                              <Text className="text-sm font-semibold" style={{ color: theme.text }} numberOfLines={1}>
                                {readingList?.title || "Untitled"}
                              </Text>
                              <Text className="mt-1 text-xs" style={{ color: theme.textSoft }}>
                                {getReadingListBooksTotal(readingList)} books
                              </Text>
                            </View>
                            <TouchableOpacity
                              onPress={() => handleOpenReadingList(readingList)}
                              className="self-start rounded-full px-3 py-1.5"
                              style={{ backgroundColor: theme.surfaceMuted }}
                            >
                              <Text className="text-xs font-semibold" style={{ color: theme.text }}>
                                See all
                              </Text>
                            </TouchableOpacity>
                          </View>

                          {previewEntries.length > 0 ? (
                            <ScrollView
                              horizontal
                              showsHorizontalScrollIndicator={false}
                              className="mt-2"
                              contentContainerStyle={{ paddingRight: 8 }}
                            >
                              {previewEntries.map((entry) => (
                                <BookLibraryCard
                                  key={`${readingList.$id}-${entry?.$id}`}
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
                      </View>
                    );
                  })}
                </View>
              ) : (
                <View className="py-1">
                  {renderHorizontalPlaceholders({
                    count: 2,
                    width: 240,
                    height: 160,
                    icon: "book-open-page-variant",
                  })}
                  {renderEmptyText(isLoggedInUser ? "No reading lists yet." : "No reading lists yet.")}
                </View>
              )}
            </View>
          </View>
        </View>
      </ScrollView>

      <Modal
        isVisible={allReadingListsModalVisible}
        onBackdropPress={() => setAllReadingListsModalVisible(false)}
        onBackButtonPress={() => setAllReadingListsModalVisible(false)}
        onModalHide={async () => {
          if (!pendingReadingListOpenRef.current) return;
          const readingListToOpen = pendingReadingListOpenRef.current;
          pendingReadingListOpenRef.current = null;
          await waitForReadingListModalTransition();
          handleOpenReadingList(readingListToOpen);
        }}
        swipeDirection="down"
        onSwipeComplete={() => setAllReadingListsModalVisible(false)}
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
            <Text className="text-lg font-bold" style={{ color: theme.text }}>
              All Reading Lists
            </Text>
            <TouchableOpacity
              onPress={() => setAllReadingListsModalVisible(false)}
              className="h-9 w-9 items-center justify-center rounded-full"
              style={{ backgroundColor: theme.surfaceMuted }}
            >
              <MaterialCommunityIcons name="close" size={18} color={theme.icon} />
            </TouchableOpacity>
          </View>

          <View className="rounded-2xl p-2" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
            {readingLists.length > 0 ? (
              <FlatList
                data={readingLists}
                keyExtractor={(item) => item?.$id}
                renderItem={renderAllReadingListItem}
                showsVerticalScrollIndicator={false}
                contentContainerStyle={{ paddingBottom: 8 }}
              />
            ) : (
              renderEmptyText("No reading lists yet.")
            )}
          </View>
        </View>
      </Modal>

      <Modal
        isVisible={readingListModalVisible}
        onBackdropPress={closeReadingListModal}
        onBackButtonPress={closeReadingListModal}
        swipeDirection="down"
        onSwipeComplete={closeReadingListModal}
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
                {selectedReadingList?.title || "Reading List"}
              </Text>
              <Text className="text-xs" style={{ color: theme.textSoft }}>
                {getReadingListBooksTotal(selectedReadingList)} books
              </Text>
            </View>

            <View className="flex-row items-center">
              {isLoggedInUser ? (
                <TouchableOpacity
                  disabled={deletingReadingList}
                  onPress={() => handleDeleteReadingList(selectedReadingList)}
                  className="mr-2 h-9 w-9 items-center justify-center rounded-full"
                  style={{ backgroundColor: theme.dangerSoft }}
                >
                  {deletingReadingList ? (
                    <ActivityIndicator size="small" color={theme.danger} />
                  ) : (
                    <MaterialCommunityIcons name="delete-outline" size={18} color={theme.danger} />
                  )}
                </TouchableOpacity>
              ) : null}

              <TouchableOpacity
                onPress={closeReadingListModal}
                className="h-9 w-9 items-center justify-center rounded-full"
                style={{ backgroundColor: theme.surfaceMuted }}
              >
                <MaterialCommunityIcons name="close" size={18} color={theme.icon} />
              </TouchableOpacity>
            </View>
          </View>

          <View className="rounded-2xl p-2" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
            {loadingReadingListBooks ? (
              <View className="items-center py-8">
                <ActivityIndicator size="small" color={theme.primary} />
              </View>
            ) : readingListBooks.length > 0 ? (
              <FlatList
                data={readingListBooks}
                keyExtractor={(item) => item?.$id}
                renderItem={renderReadingListBookItem}
                showsVerticalScrollIndicator={false}
                contentContainerStyle={{ paddingBottom: 8 }}
              />
            ) : (
              renderEmptyText("No books in this reading list yet.")
            )}
          </View>
        </View>
      </Modal>
    </>
  );
};

export default ProfileHomeTab;
