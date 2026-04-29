import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import Modal from "react-native-modal";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import useAppTheme from "../hooks/useAppTheme";
import { UserReadingListService } from "../lib/user-reading-list";

const BookReadingListModal = ({ isVisible, onClose, userId, bookId, isBookInLibrary = false, onAddToLibrary }) => {
  const { theme } = useAppTheme();
  const insets = useSafeAreaInsets();
  const readingListService = useMemo(() => new UserReadingListService(), []);

  const [readingLists, setReadingLists] = useState([]);
  const [loadingLists, setLoadingLists] = useState(false);
  const [addingLibrary, setAddingLibrary] = useState(false);
  const [activeReadingListId, setActiveReadingListId] = useState(null);
  const [isCreateModalVisible, setIsCreateModalVisible] = useState(false);
  const [newReadingListTitle, setNewReadingListTitle] = useState("");
  const [creatingReadingList, setCreatingReadingList] = useState(false);

  useEffect(() => {
    if (!isVisible || !userId) return;
    fetchReadingLists();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible, userId, bookId]);

  useEffect(() => {
    if (isVisible) return;
    setIsCreateModalVisible(false);
    setNewReadingListTitle("");
  }, [isVisible]);

  const fetchReadingLists = async () => {
    try {
      setLoadingLists(true);
      const response = await readingListService.fetchUserReadingLists({ ownerId: userId, limit: 50 });
      const docs = response?.documents || [];

      const enrichedReadingLists = await Promise.all(
        docs.map(async (readingList) => {
          const [readingListBooks, existingBookRelation] = await Promise.all([
            readingListService.fetchReadingListBooks({ readingListId: readingList.$id, limit: 1 }),
            bookId ? readingListService.getReadingListBookByBook({ readingListId: readingList.$id, bookId }) : Promise.resolve({ documents: [] }),
          ]);

          return {
            ...readingList,
            booksTotal: readingListBooks?.total || 0,
            hasBook: (existingBookRelation?.documents || []).length > 0,
          };
        }),
      );

      setReadingLists(enrichedReadingLists);
    } catch (error) {
      console.log("fetchReadingLists: error", error);
    } finally {
      setLoadingLists(false);
    }
  };

  const handleAddToLibrary = async () => {
    if (!onAddToLibrary || addingLibrary || isBookInLibrary) return;

    try {
      setAddingLibrary(true);
      await onAddToLibrary();
    } catch (error) {
      console.log("handleAddToLibrary: error", error);
      Alert.alert("Error", "Unable to add this book to your library right now.");
    } finally {
      setAddingLibrary(false);
    }
  };

  const handleAddBookToReadingList = async (readingList) => {
    if (!bookId || !readingList?.$id || activeReadingListId || readingList?.hasBook) return;

    try {
      setActiveReadingListId(readingList.$id);

      const existing = await readingListService.getReadingListBookByBook({ readingListId: readingList.$id, bookId });
      if ((existing?.documents || []).length > 0) {
        setReadingLists((prev) => prev.map((listItem) => (listItem.$id === readingList.$id ? { ...listItem, hasBook: true } : listItem)));
        return;
      }

      await readingListService.addBookToReadingList({ readingListId: readingList.$id, bookId });

      setReadingLists((prev) =>
        prev.map((listItem) =>
          listItem.$id === readingList.$id
            ? {
                ...listItem,
                hasBook: true,
                booksTotal: (listItem.booksTotal || 0) + 1,
              }
            : listItem,
        ),
      );
    } catch (error) {
      console.log("handleAddBookToReadingList: error", error);
      Alert.alert("Error", "Unable to add this book to the reading list.");
    } finally {
      setActiveReadingListId(null);
    }
  };

  const handleCreateReadingList = async () => {
    const title = newReadingListTitle.trim();
    if (!title) {
      Alert.alert("Missing Title", "Please enter a reading list title.");
      return;
    }
    if (!userId) return;

    try {
      setCreatingReadingList(true);
      const createdReadingList = await readingListService.createUserReadingList({ title, ownerId: userId });
      let booksTotal = 0;
      let hasBook = false;

      if (bookId) {
        const existingBook = await readingListService.getReadingListBookByBook({ readingListId: createdReadingList.$id, bookId });
        if ((existingBook?.documents || []).length === 0) {
          await readingListService.addBookToReadingList({ readingListId: createdReadingList.$id, bookId });
        }
        booksTotal = 1;
        hasBook = true;
      }

      setReadingLists((prev) => [{ ...createdReadingList, booksTotal, hasBook }, ...prev]);
      setNewReadingListTitle("");
      setIsCreateModalVisible(false);
    } catch (error) {
      console.log("handleCreateReadingList: error", error);
      Alert.alert("Error", "Unable to create reading list right now.");
    } finally {
      setCreatingReadingList(false);
    }
  };

  return (
    <>
      <Modal
        isVisible={isVisible}
        onBackdropPress={onClose}
        onBackButtonPress={onClose}
        swipeDirection="down"
        onSwipeComplete={onClose}
        style={{ justifyContent: "flex-end", margin: 0 }}
        backdropOpacity={0.3}
        propagateSwipe
      >
        <View
          className="max-h-[85%] rounded-t-3xl px-4 pt-3"
          style={{
            paddingBottom: insets.bottom + 16,
            backgroundColor: theme.surfaceElevated,
            borderTopWidth: 1,
            borderTopColor: theme.border,
          }}
        >
          <View className="items-center pb-2">
            <View className="h-1.5 w-16 rounded-full" style={{ backgroundColor: theme.handle }} />
          </View>

          <View className="mb-3 flex-row items-center justify-between">
            <Text className="text-lg font-bold" style={{ color: theme.text }}>
              Save Book
            </Text>
            <TouchableOpacity
              onPress={onClose}
              className="h-8 w-8 items-center justify-center rounded-full"
              style={{ backgroundColor: theme.surfaceMuted }}
            >
              <Ionicons name="close" size={18} color={theme.icon} />
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            disabled={addingLibrary || isBookInLibrary}
            onPress={handleAddToLibrary}
            className="mb-4 flex-row items-center justify-between rounded-2xl border px-3 py-3"
            style={{ borderColor: theme.border, backgroundColor: isBookInLibrary ? theme.accentGreenSoft : theme.card }}
          >
            <View className="flex-row items-center">
              <MaterialCommunityIcons
                name={isBookInLibrary ? "bookmark-check" : "bookmark-plus-outline"}
                size={22}
                color={isBookInLibrary ? theme.accentGreen : theme.icon}
              />
              <View className="ml-3">
                <Text className="text-sm font-semibold" style={{ color: theme.text }}>
                  Add to library
                </Text>
                <Text className="text-xs" style={{ color: theme.textSoft }}>
                  {isBookInLibrary ? "Already in your library" : "Save this book to your library"}
                </Text>
              </View>
            </View>
            {addingLibrary ? (
              <ActivityIndicator size="small" color={theme.primary} />
            ) : (
              <Ionicons
                name={isBookInLibrary ? "checkmark-circle" : "chevron-forward"}
                size={20}
                color={isBookInLibrary ? theme.accentGreen : theme.icon}
              />
            )}
          </TouchableOpacity>

          <View className="mb-2 flex-row items-center justify-between">
            <Text className="text-sm font-semibold" style={{ color: theme.textSoft }}>
              Your Reading Lists
            </Text>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 8 }}>
            {loadingLists ? (
              <View className="items-center py-6">
                <ActivityIndicator size="small" color={theme.primary} />
              </View>
            ) : readingLists.length > 0 ? (
              readingLists.map((readingList) => {
                const isPending = activeReadingListId === readingList.$id;
                return (
                  <TouchableOpacity
                    key={readingList.$id}
                    disabled={isPending || readingList.hasBook}
                    onPress={() => handleAddBookToReadingList(readingList)}
                    className="mb-2 flex-row items-center justify-between rounded-2xl border px-3 py-3"
                    style={{ borderColor: theme.border, backgroundColor: readingList.hasBook ? theme.accentGreenSoft : theme.card }}
                  >
                    <View className="flex-1 pr-3">
                      <Text className="text-base font-semibold" style={{ color: theme.text }} numberOfLines={1}>
                        {readingList?.title || "Untitled"}
                      </Text>
                      <Text className="mt-0.5 text-xs" style={{ color: theme.textSoft }}>
                        {readingList.booksTotal || 0} books
                      </Text>
                    </View>
                    {isPending ? (
                      <ActivityIndicator size="small" color={theme.primary} />
                    ) : (
                      <Ionicons
                        name={readingList.hasBook ? "checkmark-circle" : "add-circle-outline"}
                        size={22}
                        color={readingList.hasBook ? theme.accentGreen : theme.icon}
                      />
                    )}
                  </TouchableOpacity>
                );
              })
            ) : (
              <View
                className="items-center rounded-2xl border border-dashed px-4 py-6"
                style={{ borderColor: theme.borderStrong, backgroundColor: theme.card }}
              >
                <MaterialCommunityIcons name="book-plus-outline" size={28} color={theme.iconMuted} />
                <Text className="mt-2 text-sm" style={{ color: theme.textMuted }}>
                  No reading lists yet
                </Text>
              </View>
            )}
          </ScrollView>

          <TouchableOpacity
            onPress={() => setIsCreateModalVisible(true)}
            className="mt-2 flex-row items-center justify-center rounded-2xl py-3"
            style={{ backgroundColor: theme.primary }}
          >
            <Ionicons name="add" size={18} color={theme.primaryContrast} />
            <Text className="ml-1 text-sm font-semibold" style={{ color: theme.primaryContrast }}>
              Create new reading list
            </Text>
          </TouchableOpacity>
        </View>
      </Modal>

      <Modal
        isVisible={isCreateModalVisible}
        onBackdropPress={() => setIsCreateModalVisible(false)}
        onBackButtonPress={() => setIsCreateModalVisible(false)}
        useNativeDriver
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          className="rounded-2xl p-4"
          style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surfaceElevated }}
        >
          <View className="flex-row items-center justify-between">
            <Text className="text-lg font-bold" style={{ color: theme.text }}>
              Create Reading List
            </Text>
            <TouchableOpacity
              onPress={() => setIsCreateModalVisible(false)}
              className="h-8 w-8 items-center justify-center rounded-full"
              style={{ backgroundColor: theme.surfaceMuted }}
            >
              <Ionicons name="close" size={16} color={theme.icon} />
            </TouchableOpacity>
          </View>
          <Text className="mt-2 text-xs" style={{ color: theme.textSoft }}>
            Enter a title for your new reading list.
          </Text>
          <TextInput
            autoFocus
            editable={!creatingReadingList}
            value={newReadingListTitle}
            onChangeText={setNewReadingListTitle}
            placeholder="Reading list title"
            placeholderTextColor={theme.placeholder}
            selectionColor={theme.primary}
            className="mt-4 rounded-xl border px-3 py-3"
            style={{ borderColor: theme.inputBorder, backgroundColor: theme.inputBackground, color: theme.inputText }}
            maxLength={60}
          />
          <TouchableOpacity
            disabled={creatingReadingList}
            onPress={handleCreateReadingList}
            className="mt-4 items-center rounded-xl py-3"
            style={{ backgroundColor: creatingReadingList ? theme.accentPurple : theme.primary }}
          >
            {creatingReadingList ? (
              <ActivityIndicator size="small" color={theme.primaryContrast} />
            ) : (
              <Text className="text-sm font-semibold" style={{ color: theme.primaryContrast }}>
                Save Reading List
              </Text>
            )}
          </TouchableOpacity>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
};

export default BookReadingListModal;
