import { Entypo, FontAwesome, MaterialIcons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Animated, Easing, Pressable, ScrollView, Switch, Text, TextInput, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import { SafeAreaView } from "react-native-safe-area-context";
import { useSelector } from "react-redux";
import { BookChaptersModal, CustomAlertModal, StyledTitle } from "../../components";
import BookChapterReorderModal from "../../components/BookChapterReorderModal";
import { useGlobalContext } from "../../context/global-provider";
import useAppTheme from "../../hooks/useAppTheme";
import {
  BOOK_CHAPTER_LIST_SELECT,
  BookService,
  getBookChapterOrder,
  getBookChapterSectionLabel,
  getNextNumberedBookChapterOrder,
  initialBookForm,
  isIntroductionChapter,
  sortBookChaptersByOrder,
} from "../../lib/books";
import { persistImagePickerAsset } from "../../lib/image-utils";
import TimeAgo from "../../lib/time-ago";
import { useModalMessage } from "../../lib/useModalMessage";

const BookEditor = () => {
  const { user } = useGlobalContext();
  const { theme } = useAppTheme();
  const { globalSettings } = useSelector((state) => state.app);
  const { book: bookParam, draftKey: draftKeyParamRaw } = useLocalSearchParams();
  const draftKeyParam = Array.isArray(draftKeyParamRaw) ? draftKeyParamRaw[0] : draftKeyParamRaw;
  const localDrafts = useSelector((state) => state?.books?.localDrafts || {});
  const book = useMemo(() => (bookParam ? JSON.parse(bookParam) : null), [bookParam]);
  const { message, messageOpen, showMessage, closeMessage } = useModalMessage();
  const [bookForm, setBookForm] = useState(book ? book : initialBookForm);
  const [bookChapters, setBookChapters] = useState([]);
  const [bookChapterTotal, setBookChapterTotal] = useState(0);
  const [chaptersVisible, setChaptersVisible] = useState(false);
  const [chapterReorderVisible, setChapterReorderVisible] = useState(false);
  const [savingChapterOrder, setSavingChapterOrder] = useState(false);
  const [bookSaving, setBookSaving] = useState(false);
  const [loadingBookChapters, setLoadingBookChapters] = useState(Boolean(book?.$id));
  const [bookLocked, setBookLocked] = useState(book?.isLocked);
  const [contentRating, setContentRating] = useState(book?.contentRating === "Rated 18");
  const [bookStatus, setBookStatus] = useState(book?.status === "Completed");

  const isEdit = book?.$id;
  const existingBookDraftKey = useMemo(() => {
    if (!user?.$id || !book?.$id) return null;
    return `bookDraft:${user.$id}:book:${book.$id}`;
  }, [user?.$id, book?.$id]);
  const activeDraftKey = useMemo(() => {
    if (draftKeyParam) return draftKeyParam;
    if (existingBookDraftKey && localDrafts?.[existingBookDraftKey]) return existingBookDraftKey;
    return null;
  }, [draftKeyParam, existingBookDraftKey, localDrafts]);
  const localDraft = activeDraftKey ? localDrafts?.[activeDraftKey] : null;
  const isLocalDraft = Boolean(activeDraftKey);
  const canManageChapters = Boolean(isEdit || isLocalDraft);
  const localDraftChapters = useMemo(() => {
    const chapters =
      Array.isArray(localDraft?.chapters) && localDraft.chapters.length
        ? localDraft.chapters
        : localDraft?.chapterForm
          ? [localDraft.chapterForm]
          : [];
    return [...chapters]
      .map((chapter, index) => ({
        ...chapter,
        order: getBookChapterOrder(chapter, index),
        status: chapter?.status || "Draft",
        $createdAt: chapter?.$createdAt || (chapter?.updatedAt ? new Date(chapter.updatedAt).toISOString() : new Date().toISOString()),
      }))
      .sort((a, b) => Number(a?.order || 0) - Number(b?.order || 0));
  }, [localDraft]);
  const displayedChapters = useMemo(() => {
    const merged = [...bookChapters];
    localDraftChapters.forEach((localChapter) => {
      if (localChapter?.$id) {
        const serverIndex = merged.findIndex((chapter) => chapter?.$id === localChapter.$id);
        if (serverIndex >= 0) {
          merged[serverIndex] = { ...merged[serverIndex], ...localChapter };
          return;
        }
      }
      const localIndex = merged.findIndex((chapter) => chapter?.localId && chapter.localId === localChapter.localId);
      if (localIndex >= 0) {
        merged[localIndex] = { ...merged[localIndex], ...localChapter };
      } else {
        merged.push(localChapter);
      }
    });

    return sortBookChaptersByOrder(merged);
  }, [bookChapters, isEdit, localDraftChapters]);
  const latestDisplayedChapters = useMemo(
    () =>
      displayedChapters
        .filter((chapter, index) => !isIntroductionChapter(chapter, index))
        .sort((a, b) => getBookChapterOrder(b) - getBookChapterOrder(a))
        .slice(0, 5),
    [displayedChapters],
  );
  const introductionChapter = useMemo(
    () => displayedChapters.find((chapter, index) => isIntroductionChapter(chapter, index)) || null,
    [displayedChapters],
  );
  const hasIntroduction = useMemo(() => displayedChapters.some((chapter, index) => isIntroductionChapter(chapter, index)), [displayedChapters]);
  const reorderableChapterCount = useMemo(
    () => sortBookChaptersByOrder(bookChapters).filter((chapter, index) => !isIntroductionChapter(chapter, index)).length,
    [bookChapters],
  );
  const bookService = new BookService();
  const tags = JSON.parse(globalSettings["BOOKS_CATEGORIES"]);
  const sizeLimitThumbnailUpload = globalSettings["BOOKS_COVER_MAX_SIZE_MB"] * 1024 * 1024;
  const sizeLimitTitleChars = globalSettings["BOOKS_TITLE_MAX_CHAR_SIZE"];
  const sizeLimitSynopsisWords = globalSettings["BOOKS_SYNOPSIS_MIN_WORD_COUNT"];
  const sizeMaxSynopsisWords = globalSettings["BOOKS_SYNOPSIS_MAX_WORD_COUNT"];
  const sizeLimitTags = globalSettings["BOOKS_TAGS_MAX_SIZE"];
  const bookChapterLockStart = globalSettings["BOOKS_CHAPTER_LOCK_START"];
  const [showMenu, setShowMenu] = useState(false);
  const animation = useRef(new Animated.Value(0)).current; // 0 = hidden, 1 = visible
  const opacity = animation;

  useFocusEffect(
    useCallback(() => {
      if (!book?.$id) {
        setLoadingBookChapters(false);
        return;
      }
      let isActive = true;
      const fetchBookChapters = async () => {
        try {
          setLoadingBookChapters(true);
          const bookChapters = await bookService.fetchAllBookChapters({ bookId: book.$id, select: BOOK_CHAPTER_LIST_SELECT });
          if (!isActive) return;
          const sortedChapters = sortBookChaptersByOrder(bookChapters.documents || []);
          setBookChapters(sortedChapters);
          setBookChapterTotal(bookChapters.total);
        } catch (error) {
          console.log("fetchBookChapters: error", error);
        } finally {
          if (isActive) {
            setLoadingBookChapters(false);
          }
        }
      };
      fetchBookChapters();
      return () => {
        isActive = false;
      };
    }, [book?.$id]),
  );

  useEffect(() => {
    if (!isLocalDraft || isEdit) return;
    setBookChapters(localDraftChapters);
    const computedTotal = localDraftChapters.length
      ? Math.max(localDraftChapters.length, ...localDraftChapters.map((chapter, index) => getBookChapterOrder(chapter, index)))
      : 0;
    setBookChapterTotal(computedTotal);
  }, [isEdit, isLocalDraft, localDraftChapters]);

  const chapterOrderLoading = isEdit && loadingBookChapters;

  const handleChange = (key, value) => {
    if (key === "title" || key === "synopsis") {
      setBookForm((prev) => ({ ...prev, [key]: value }));
    } else if (key === "tags") {
      setBookForm((prev) => {
        const updatedTags = prev.tags.includes(value) ? prev.tags.filter((t) => t !== value) : [...prev.tags, value];
        return { ...prev, tags: updatedTags };
      });
    }
  };

  useEffect(() => {
    Animated.timing(animation, {
      toValue: showMenu ? 1 : 0,
      duration: 200,
      easing: Easing.out(Easing.ease),
      useNativeDriver: true,
    }).start();
  }, [showMenu]);

  const translateY = animation.interpolate({
    inputRange: [0, 1],
    outputRange: [-10, 0],
  });

  const getWordCount = (text) => {
    if (!text) return 0;
    return text.trim().split(/\s+/).length;
  };

  const openPicker = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission Denied", "Please allow access to the photo library.");
      return;
    }

    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: "images",
      });

      if (!result.canceled) {
        const rawAsset = result.assets[0];
        const asset = await persistImagePickerAsset(rawAsset, "book-cover");
        if (asset && asset.fileSize > sizeLimitThumbnailUpload) {
          showMessage(`Please ensure your thumbnail upload size is under ${sizeLimitThumbnailUpload / 1024 / 1024}MB.`, 500);
          return;
        }
        setBookForm((prev) => ({ ...prev, thumbnail: asset }));
      }
    } catch (error) {
      console.log("openPicker: error", error);
    }
  };

  const handleValidateData = () => {
    if (!bookForm?.thumbnail) {
      showMessage("Please add a book cover.");
      return true;
    }

    if (!bookForm?.title?.length) {
      showMessage("Please enter a title.");
      return true;
    }

    if (!bookForm?.synopsis?.length) {
      showMessage("Please enter a synopsis.");
      return true;
    }

    if (bookForm?.title?.length > sizeLimitTitleChars) {
      showMessage(`Please ensure your title char size is under ${sizeLimitTitleChars}.`);
      return true;
    }
    const contentWordCount = getWordCount(bookForm.synopsis);

    if (contentWordCount < sizeLimitSynopsisWords) {
      showMessage(`Please ensure your synopsis word count is over ${sizeLimitSynopsisWords}.`);
      return true;
    }

    if (contentWordCount > sizeMaxSynopsisWords) {
      showMessage(`Please ensure your synopsis word count is under ${sizeMaxSynopsisWords}.`);
      return true;
    }

    if (!bookForm?.tags?.length) {
      showMessage("Please select at least 1 tag.");
      return true;
    }

    if (bookForm?.tags?.length > sizeLimitTags) {
      showMessage(`Please ensure your total tags is under ${sizeLimitTags}.`);
      return true;
    }
    return false;
  };

  const handleNext = async () => {
    try {
      if (handleValidateData()) return;
      if (chapterOrderLoading) {
        showMessage("Please wait while your chapters finish loading.");
        return;
      }
      router.push({
        pathname: "book-introduction-editor",
        params: {
          book: JSON.stringify(bookForm),
          nextChapterOrder: getNextNumberedBookChapterOrder(displayedChapters),
          ...(isLocalDraft ? { draftKey: activeDraftKey } : {}),
        },
      });
    } catch (error) {
      console.log("handleNext: error", error);
    }
  };

  const handleCreateNewChapter = () => {
    if (chapterOrderLoading) {
      showMessage("Please wait while your chapters finish loading.");
      return;
    }
    const nextChapterOrder = getNextNumberedBookChapterOrder(displayedChapters);
    router.push({
      pathname: "chapter-editor",
      params: {
        book: JSON.stringify(bookForm),
        bookChapterTotal: nextChapterOrder,
        ...(isLocalDraft ? { draftKey: activeDraftKey } : {}),
      },
    });
  };

  const handleManageIntroduction = () => {
    if (chapterOrderLoading) {
      showMessage("Please wait while your chapters finish loading.");
      return;
    }

    router.push({
      pathname: "book-introduction-editor",
      params: {
        book: JSON.stringify(bookForm),
        nextChapterOrder: getNextNumberedBookChapterOrder(displayedChapters),
        ...(introductionChapter ? { chapter: JSON.stringify(introductionChapter) } : {}),
        ...(isLocalDraft ? { draftKey: activeDraftKey } : {}),
      },
    });
  };

  const handleEditChapter = (chapter, index) => {
    const chapterOrder = getBookChapterOrder(chapter, index);
    const openingIntroduction = isIntroductionChapter(chapter, index);
    router.push({
      pathname: openingIntroduction ? "book-introduction-editor" : "chapter-editor",
      params: {
        book: JSON.stringify(bookForm),
        ...(openingIntroduction ? { nextChapterOrder: getNextNumberedBookChapterOrder(displayedChapters) } : { bookChapterTotal: chapterOrder }),
        chapter: JSON.stringify(chapter),
        ...(isLocalDraft ? { draftKey: activeDraftKey } : {}),
      },
    });
  };

  const handleViewAsReader = () => {
    setShowMenu(false);
    router.push({ pathname: "book-info", params: { bookId: bookForm.$id } });
  };

  const onChapterSelect = async (item, index) => {
    setChaptersVisible(false);
    const chapterOrder = getBookChapterOrder(item, index);
    const openingIntroduction = isIntroductionChapter(item, index);
    let selectedChapter = item;
    if (item?.$id && !Object.prototype.hasOwnProperty.call(item, "content")) {
      try {
        selectedChapter = await bookService.fetchBookChapter({ chapterId: item.$id });
      } catch (error) {
        console.log("onChapterSelect: error", error);
        showMessage("Unable to load chapter. Please try again.");
        return;
      }
    }
    router.push({
      pathname: openingIntroduction ? "book-introduction-editor" : "chapter-editor",
      params: {
        book: JSON.stringify(bookForm),
        ...(openingIntroduction ? { nextChapterOrder: getNextNumberedBookChapterOrder(displayedChapters) } : { bookChapterTotal: chapterOrder }),
        chapter: JSON.stringify(selectedChapter),
        ...(isLocalDraft ? { draftKey: activeDraftKey } : {}),
      },
    });
  };

  const toggleChaptersVisible = () => {
    setChaptersVisible((prev) => !prev);
  };

  const toggleChapterReorderVisible = () => {
    setChapterReorderVisible((prev) => !prev);
  };

  const handleCloseMessage = () => {
    closeMessage();
  };

  const handleSaveChapterOrder = async (orderedChapters) => {
    try {
      if (!orderedChapters?.length) {
        showMessage("No chapters available to reorder.");
        return;
      }

      const sortedOrderedChapters = sortBookChaptersByOrder(orderedChapters);
      const introductionChapter = sortedOrderedChapters.find((chapter, index) => isIntroductionChapter(chapter, index));
      const reorderableChapters = introductionChapter
        ? sortedOrderedChapters.filter((chapter) => chapter?.$id !== introductionChapter.$id)
        : sortedOrderedChapters;
      const normalizedChapters = introductionChapter
        ? [{ ...introductionChapter, order: 0 }, ...reorderableChapters.map((chapter, index) => ({ ...chapter, order: index + 1 }))]
        : reorderableChapters.map((chapter, index) => ({ ...chapter, order: index + 1 }));

      const updates = normalizedChapters
        .map((chapter) => ({ chapter, order: chapter.order }))
        .filter(({ chapter, order }) => Number(chapter.order) !== order);

      if (!updates.length) {
        setChapterReorderVisible(false);
        showMessage("Chapter order is already up to date.");
        return;
      }

      setSavingChapterOrder(true);
      await Promise.all(
        updates.map(({ chapter, order }) =>
          bookService.updateBookChapter({
            ID: chapter.$id,
            order,
          }),
        ),
      );

      setBookChapters(normalizedChapters);
      setBookChapterTotal(normalizedChapters.length);
      setChapterReorderVisible(false);
      showMessage("Chapter order updated.");
    } catch (error) {
      console.log("handleSaveChapterOrder: error", error);
      showMessage("Unable to update chapter order. Please try again.");
    } finally {
      setSavingChapterOrder(false);
    }
  };

  const handleSaveBookInfo = async () => {
    try {
      if (handleValidateData()) return;
      let responseThumbnail = null;
      setBookSaving(true);

      // only upload new if picking a file (uri exists)
      if (bookForm?.thumbnail?.uri) {
        responseThumbnail = await bookService.uploadCover(bookForm.thumbnail);
      }

      // build safe update payload
      const bookUpdatePayload = {
        title: bookForm.title,
        synopsis: bookForm.synopsis,
        tags: bookForm.tags,
        ...(responseThumbnail ? { thumbnail: responseThumbnail } : {}),
      };

      await bookService.updateBook({
        ID: bookForm.$id,
        ...bookUpdatePayload,
      });

      showMessage("Successfully save book info!", 300, () => router.dismiss(1));
    } catch (error) {
      console.log("handleNext: error", error);
    } finally {
      setBookSaving(false);
    }
  };

  const handleDeleteBook = () => {
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
              await bookService.deleteBook({ ID: bookForm.$id });
              router.back();
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

  const handleLockBook = async (value) => {
    try {
      setBookLocked(value);
      Alert.alert(
        "Confirm Lock Book",
        "Are you sure you want to lock this book? There is no going back!",
        [
          {
            text: "No",
            style: "cancel",
            onPress: () => setBookLocked(false),
          },
          {
            text: "Yes",
            onPress: async () => {
              await bookService.updateBook({ ID: book.$id, isLocked: value });
              showMessage("Successfully locked your book! Expect earnings from stars and coins!");
            },
            style: "destructive",
          },
        ],
        { cancelable: true },
      );
    } catch (error) {
      console.log("handleLockBook", error);
    }
  };

  const handleMatureContentSwitch = async (value) => {
    setContentRating(value);
    let rating = "Rated PG";
    if (value === true) {
      rating = "Rated 18";
    }
    bookService.updateBook({ ID: book.$id, contentRating: rating });
  };

  const handleCompleteStatusSwitch = async (value) => {
    setBookStatus(value);
    let status = "Ongoing";
    if (value === true) {
      status = "Completed";
    }
    bookService.updateBook({ ID: book.$id, status });
  };

  const cardStyle = {
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.border,
  };

  const inputStyle = {
    backgroundColor: theme.inputBackground,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    color: theme.inputText,
  };

  const switchTrackColor = {
    false: theme.surfaceStrong,
    true: theme.primary,
  };

  return (
    <SafeAreaView className="flex-1" style={{ backgroundColor: theme.background }}>
      <View className="flex-1">
        <View
          className="align-start flex-row items-center justify-between px-4 pb-2 pt-2"
          style={{ borderBottomWidth: 1, borderBottomColor: theme.border }}
        >
          <StyledTitle
            className="py-0"
            icon={
              <TouchableOpacity onPress={() => router.back()}>
                <MaterialIcons name="arrow-back" size={24} color={theme.icon} />
              </TouchableOpacity>
            }
            title={isEdit ? "Edit book" : isLocalDraft ? "Edit offline draft" : "Create new book"}
          />
          {/* Right actions */}
          {canManageChapters ? (
            <View className="relative flex-row space-x-2">
              <TouchableOpacity onPress={handleCreateNewChapter} disabled={chapterOrderLoading}>
                {chapterOrderLoading ? <ActivityIndicator size="small" color={theme.primary} /> : <Entypo name="plus" size={25} color={theme.icon} />}
              </TouchableOpacity>

              {/* Dots menu */}
              {isEdit ? (
                <View className="relative">
                  <TouchableOpacity onPress={() => setShowMenu((prev) => !prev)}>
                    <Entypo name="dots-three-horizontal" size={25} color={theme.icon} />
                  </TouchableOpacity>

                  {showMenu && (
                    <>
                      {/* Overlay to close when tapping outside */}
                      <Pressable
                        onPress={() => setShowMenu(false)}
                        style={{
                          position: "absolute",
                          top: 0,
                          bottom: 0,
                          left: -2000,
                          right: -2000,
                          zIndex: 9999,
                        }}
                      />

                      <Animated.View
                        style={{
                          position: "absolute",
                          right: 0,
                          top: 30,
                          width: 160,
                          borderRadius: 12,
                          borderWidth: 1,
                          borderColor: theme.border,
                          backgroundColor: theme.surfaceElevated,
                          paddingVertical: 6,
                          opacity,
                          transform: [{ translateY }],
                          zIndex: 999,
                        }}
                      >
                        <TouchableOpacity
                          onPress={() => {
                            setShowMenu(false);
                            handleSaveBookInfo();
                          }}
                          style={{ paddingVertical: 10, paddingHorizontal: 14 }}
                        >
                          <Text style={{ color: theme.text, fontSize: 13 }}>Save</Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                          onPress={() => {
                            setShowMenu(false);
                            handleViewAsReader();
                          }}
                          style={{ paddingVertical: 10, paddingHorizontal: 14 }}
                        >
                          <Text style={{ color: theme.text, fontSize: 13 }}>View as reader</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => {
                            setShowMenu(false);
                            handleDeleteBook();
                          }}
                          style={{ paddingVertical: 10, paddingHorizontal: 14 }}
                        >
                          <Text style={{ color: theme.danger, fontSize: 13 }}>Delete</Text>
                        </TouchableOpacity>
                      </Animated.View>
                    </>
                  )}
                </View>
              ) : null}
            </View>
          ) : (
            <TouchableOpacity onPress={handleNext} className="rounded-full px-4 py-2" style={{ backgroundColor: theme.primary }}>
              <Text className="text-sm font-semibold" style={{ color: theme.primaryContrast }}>
                Next
              </Text>
            </TouchableOpacity>
          )}
        </View>
        <ScrollView
          contentContainerStyle={{ paddingBottom: 50 }}
          className="space-y-4 px-4 py-5"
          showsVerticalScrollIndicator={false}
          style={{ zIndex: -999, backgroundColor: theme.background }}
        >
          <TouchableOpacity onPress={openPicker} className="rounded-2xl p-4" style={cardStyle}>
            <View className="flex-row items-center justify-between">
              <Text className="text-sm font-semibold uppercase tracking-[2px]" style={{ color: theme.textMuted }}>
                Book Cover
              </Text>
              <Text className="text-[10px] font-medium" style={{ color: theme.textSoft }}>{`Max ${sizeLimitThumbnailUpload / 1024 / 1024}MB`}</Text>
            </View>
            <View className="mt-3 flex-row items-center space-x-3">
              {bookForm?.thumbnail ? (
                <View className="items-center justify-center overflow-hidden rounded-xl" style={cardStyle}>
                  <FastImage
                    className="h-40 w-[110px]"
                    source={{
                      uri: bookForm?.thumbnail?.uri || bookForm?.thumbnail,
                      priority: FastImage.priority.high,
                    }}
                    resizeMode={FastImage.resizeMode.cover}
                  />
                </View>
              ) : (
                <View
                  className="h-40 w-[110px] items-center justify-center space-y-1 rounded-xl p-3"
                  style={{ borderWidth: 1, borderStyle: "dashed", borderColor: theme.borderStrong, backgroundColor: theme.surfaceMuted }}
                >
                  <FontAwesome name="plus" size={28} color={theme.iconMuted} />
                  <Text className="text-xs" style={{ color: theme.textSoft }}>
                    Upload
                  </Text>
                </View>
              )}
              <View className="flex-1">
                <Text className="text-base font-semibold" style={{ color: theme.text }}>
                  {bookForm.thumbnail ? "Edit cover" : "Add a cover"}
                </Text>
                <Text className="mt-1 text-xs" style={{ color: theme.textSoft }}>
                  A good cover helps your book stand out in search.
                </Text>
              </View>
            </View>
          </TouchableOpacity>

          <View className="rounded-2xl p-4" style={cardStyle}>
            <View className="flex-row items-center justify-between">
              <Text className="text-sm font-semibold uppercase tracking-[2px]" style={{ color: theme.textMuted }}>
                Book Title
              </Text>
              <Text
                className="text-[10px] font-medium"
                style={{ color: theme.textSoft }}
              >{`${bookForm.title?.length || 0}/${sizeLimitTitleChars}`}</Text>
            </View>
            <TextInput
              value={bookForm.title}
              onChangeText={(text) => handleChange("title", text)}
              className="mt-3 rounded-xl px-3 py-3 text-[14px]"
              style={inputStyle}
              maxLength={Number(sizeLimitTitleChars)}
              multiline
              submitBehavior="blurAndSubmit"
              returnKeyType="done"
              placeholderTextColor={theme.placeholder}
            />
          </View>

          <View className="rounded-2xl p-4" style={cardStyle}>
            <View className="flex-row items-center justify-between">
              <Text className="text-sm font-semibold uppercase tracking-[2px]" style={{ color: theme.textMuted }}>
                Description
              </Text>
              <Text className="text-[10px] font-medium" style={{ color: theme.textSoft }}>{`Words ${getWordCount(bookForm.synopsis)}`}</Text>
            </View>
            <TextInput
              value={bookForm.synopsis}
              onChangeText={(text) => handleChange("synopsis", text)}
              className="mt-3 rounded-xl px-3 py-3 text-[14px]"
              multiline
              style={[inputStyle, { minHeight: 200, maxHeight: 300 }]}
              textAlignVertical="top"
              placeholderTextColor={theme.placeholder}
            />
          </View>

          <View className="rounded-2xl p-4" style={cardStyle}>
            <View className="flex-row items-center justify-between">
              <Text className="text-sm font-semibold uppercase tracking-[2px]" style={{ color: theme.textMuted }}>
                Tags
              </Text>
              <Text className="text-[10px] font-medium" style={{ color: theme.textSoft }}>{`Max ${sizeLimitTags}`}</Text>
            </View>
            <Text className="mt-2 text-xs" style={{ color: theme.textSoft }}>
              Select at least 1 tag.
            </Text>
            <View className="flex flex-row flex-wrap gap-2 pt-3">
              {tags.map((tag, index) => {
                const isSelected = bookForm?.tags?.includes(tag);
                const isDisabled = !isSelected && bookForm?.tags?.length >= sizeLimitTags;
                return (
                  <TouchableOpacity
                    onPress={() => handleChange("tags", tag)}
                    className="h-fit w-fit rounded-full px-4 py-2"
                    key={index.toString()}
                    disabled={isDisabled}
                    style={[
                      {
                        borderWidth: 1,
                        borderColor: isSelected ? theme.primary : theme.border,
                        backgroundColor: isSelected ? theme.primary : theme.surfaceMuted,
                      },
                      isDisabled ? { opacity: 0.35 } : undefined,
                    ]}
                  >
                    <Text className="text-nowrap text-sm font-medium" style={{ color: isSelected ? theme.primaryContrast : theme.text }}>
                      {tag}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {isEdit && (
            <View className="rounded-2xl px-4 py-3" style={cardStyle}>
              <View className="flex-row items-center justify-between">
                <View className="flex-1 pr-3">
                  <Text className="text-base font-bold" style={{ color: theme.text }}>
                    Lock Book
                  </Text>
                  <Text className="mt-1 text-xs" style={{ color: theme.textSoft }}>
                    When enabled, this book’s chapters will be locked starting at chapter {bookChapterLockStart}.
                  </Text>
                </View>
                <View style={{ transform: [{ scale: 0.8 }] }}>
                  <Switch
                    value={bookLocked}
                    onValueChange={handleLockBook}
                    trackColor={switchTrackColor}
                    thumbColor={bookLocked ? theme.primaryContrast : theme.surfaceElevated}
                    ios_backgroundColor={theme.surfaceStrong}
                    disabled={bookLocked}
                  />
                </View>
              </View>
            </View>
          )}

          {isEdit && (
            <View className="rounded-2xl px-4 py-3" style={cardStyle}>
              <View className="flex-row items-center justify-between">
                <View className="flex-1 pr-3">
                  <Text className="text-base font-bold" style={{ color: theme.text }}>
                    Mature Content
                  </Text>
                  <Text className="mt-1 text-xs" style={{ color: theme.textSoft }}>
                    ⚠️ Does your story contain adult or mature themes such as violence, sexual content, or strong language?.
                  </Text>
                </View>
                <View style={{ transform: [{ scale: 0.8 }] }}>
                  <Switch
                    value={contentRating}
                    onValueChange={handleMatureContentSwitch}
                    trackColor={switchTrackColor}
                    thumbColor={contentRating ? theme.primaryContrast : theme.surfaceElevated}
                    ios_backgroundColor={theme.surfaceStrong}
                  />
                </View>
              </View>
            </View>
          )}

          {isEdit && (
            <View className="rounded-2xl px-4 py-3" style={cardStyle}>
              <View className="flex-row items-center justify-between">
                <View className="flex-1 pr-3">
                  <Text className="text-base font-bold" style={{ color: theme.text }}>
                    Complete
                  </Text>
                  <Text className="mt-1 text-xs" style={{ color: theme.textSoft }}>
                    🟢 When toggled ON → story marked as "Completed".
                  </Text>
                </View>
                <View style={{ transform: [{ scale: 0.8 }] }}>
                  <Switch
                    value={bookStatus}
                    onValueChange={handleCompleteStatusSwitch}
                    trackColor={switchTrackColor}
                    thumbColor={bookStatus ? theme.primaryContrast : theme.surfaceElevated}
                    ios_backgroundColor={theme.surfaceStrong}
                  />
                </View>
              </View>
            </View>
          )}

          {isEdit && (
            <TouchableOpacity
              onPress={handleSaveBookInfo}
              className="mt-2 flex-row items-center justify-center rounded-full px-4 py-3"
              style={{ backgroundColor: theme.primary }}
            >
              {bookSaving ? (
                <View className="flex-row items-center space-x-2">
                  <ActivityIndicator size="small" color={theme.primaryContrast} />
                  <Text className="font-medium" style={{ color: theme.primaryContrast }}>
                    Saving Book...
                  </Text>
                </View>
              ) : (
                <Text className="font-medium" style={{ color: theme.primaryContrast }}>
                  Save Book
                </Text>
              )}
            </TouchableOpacity>
          )}

          {canManageChapters && (
            <View className="rounded-2xl p-4" style={cardStyle}>
              <View className="flex-row items-center justify-between">
                <Text className="text-base font-semibold" style={{ color: theme.text }}>
                  Table of contents
                </Text>
                <View className="flex-row items-center space-x-4">
                  {isEdit && reorderableChapterCount > 1 && (
                    <TouchableOpacity onPress={toggleChapterReorderVisible} disabled={chapterOrderLoading}>
                      <Text className="text-xs font-semibold" style={{ color: theme.primary }}>
                        Reorder
                      </Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity onPress={toggleChaptersVisible} disabled={chapterOrderLoading}>
                    <Text className="text-xs font-semibold" style={{ color: theme.primary }}>
                      See all
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>

              {chapterOrderLoading && (
                <View className="mt-3 flex-row items-center">
                  <ActivityIndicator size="small" color={theme.primary} />
                  <Text className="ml-2 text-xs" style={{ color: theme.textSoft }}>
                    Loading chapters before adding a new one...
                  </Text>
                </View>
              )}

              <View className="mt-3">
                {latestDisplayedChapters.map((chapter, index) => {
                  return (
                    <TouchableOpacity
                      onPress={() => handleEditChapter(chapter, index)}
                      key={(chapter?.$id || chapter?.localId || index).toString()}
                      className="flex-row items-center justify-between py-3"
                      style={{ borderBottomWidth: 1, borderBottomColor: theme.divider }}
                    >
                      <View className="flex-1 pr-3">
                        <Text className="text-base font-semibold" style={{ color: theme.text }}>
                          {chapter.title}
                        </Text>
                        <View className="mt-1 flex-row items-center space-x-2">
                          <Text
                            className="rounded-full px-2 py-0.5 text-[10px]"
                            style={{ borderWidth: 1, borderColor: theme.primary, backgroundColor: theme.primarySoft, color: theme.primary }}
                          >
                            {getBookChapterSectionLabel(chapter, index)}
                          </Text>
                          <Text
                            className="rounded-full px-2 py-0.5 text-[10px]"
                            style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surfaceMuted, color: theme.textMuted }}
                          >
                            {chapter.status}
                          </Text>
                          <Text className="text-xs" style={{ color: theme.textSoft }}>
                            {TimeAgo(chapter.$createdAt)}
                          </Text>
                        </View>
                      </View>

                      <FontAwesome name="chevron-right" size={16} color={theme.iconMuted} />
                    </TouchableOpacity>
                  );
                })}
              </View>

              <View className="mt-4 flex-row space-x-3">
                <TouchableOpacity
                  onPress={handleManageIntroduction}
                  disabled={chapterOrderLoading}
                  className="flex-1 flex-row items-center justify-center rounded-full px-4 py-3"
                  style={[
                    { borderWidth: 1, borderColor: theme.primary, backgroundColor: theme.primarySoft },
                    chapterOrderLoading ? { opacity: 0.65 } : undefined,
                  ]}
                >
                  {chapterOrderLoading ? (
                    <ActivityIndicator size="small" color={theme.primary} />
                  ) : (
                    <Entypo name="book" size={18} color={theme.primary} />
                  )}
                  <Text className="ml-1.5 font-medium" style={{ color: theme.primary }}>
                    {chapterOrderLoading ? "Loading..." : hasIntroduction ? "Edit Introduction" : "Add Introduction"}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={handleCreateNewChapter}
                  disabled={chapterOrderLoading}
                  className="flex-1 flex-row items-center justify-center rounded-full px-4 py-3"
                  style={[{ backgroundColor: theme.primary }, chapterOrderLoading ? { opacity: 0.65 } : undefined]}
                >
                  {chapterOrderLoading ? (
                    <ActivityIndicator size="small" color={theme.primaryContrast} />
                  ) : (
                    <Entypo name="plus" size={18} color={theme.primaryContrast} />
                  )}
                  <Text className="ml-1.5 font-medium" style={{ color: theme.primaryContrast }}>
                    {chapterOrderLoading ? "Loading..." : "Add Part"}
                  </Text>
                </TouchableOpacity>
              </View>

              {!hasIntroduction && (
                <Text className="mt-3 text-xs leading-5" style={{ color: theme.textSoft }}>
                  Introduction is optional and managed separately from your part list.
                </Text>
              )}
            </View>
          )}
        </ScrollView>
      </View>
      <CustomAlertModal message={message} iconName="message" messageOpen={messageOpen} closeMessage={handleCloseMessage} />
      <BookChaptersModal
        isVisible={chaptersVisible}
        onClose={toggleChaptersVisible}
        onSelect={onChapterSelect}
        book={bookForm}
        chapters={displayedChapters}
        useInitialChaptersOnly
      />
      <BookChapterReorderModal
        isVisible={chapterReorderVisible}
        onClose={toggleChapterReorderVisible}
        book={bookForm}
        chapters={bookChapters}
        chaptersTotal={bookChapterTotal}
        onSave={handleSaveChapterOrder}
        saving={savingChapterOrder}
      />
    </SafeAreaView>
  );
};

export default BookEditor;
