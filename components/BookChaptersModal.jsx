import { Entypo } from "@expo/vector-icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, RefreshControl, Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import Modal from "react-native-modal";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSelector } from "react-redux";
import useAppTheme from "../hooks/useAppTheme";
import { BookUnlocksService } from "../lib/book-unlocks";
import { BOOK_CHAPTER_LIST_SELECT, BookService, getBookChapterSectionLabel, isIntroductionChapter, sortBookChaptersByOrder } from "../lib/books";
import UserRoleBadgeIcons from "./UserRoleBadgeIcons";

const CHAPTERS_PAGE_SIZE = 50;
const PAGINATION_BOTTOM_DISTANCE = 140;
const CONTENT_FIT_TOLERANCE = 12;

// Tab bucketing for the author-only Published / Drafts split. The
// `localId` check catches offline drafts (Redux/MMKV-only chapters that
// were never sent to the server); the `status === "Draft"` check catches
// server-side drafts (the `Save Draft Online` flow). Anything else is
// treated as published — covers "Publish", "Published", and the
// historical case where status was missing on legacy rows.
const getChapterTabBucket = (chapter) => {
  if (chapter?.localId) return "draft";
  if (chapter?.status === "Draft") return "draft";
  return "published";
};

const BookChaptersModal = ({
  isVisible,
  onClose,
  book,
  unlocks,
  onSelect,
  chapters: initialChapters = [],
  useInitialChaptersOnly = false,
  // When true, render the Published / Drafts tab bar above the list.
  // Only the author of the book has this set; readers see the existing
  // single-list view (drafts aren't fetched in the reader path anyway,
  // so toggling tabs there would be empty UX). book-editor.jsx is the
  // current driver since that's where displayedChapters merges server
  // rows with offline-only local drafts.
  showAuthorTabs = false,
}) => {
  const { theme } = useAppTheme();
  const { user } = useSelector((state) => state.auth);
  const { globalSettings } = useSelector((state) => state.app);
  // Prefer the per-book threshold (mapped from `lock_from_chapter`).
  // globalSettings is a fallback for legacy books — relying on it alone
  // caused a flicker where the gate trivially failed because
  // globalSettings hadn't rehydrated and undefined comparisons
  // short-circuited isChapterLocked to false. The static helper has
  // its own defensive fallback now too.
  const bookChapterLockStart = book?.bookChapterLockStart ?? globalSettings?.["BOOKS_CHAPTER_LOCK_START"];
  const [chapters, setChapters] = useState(initialChapters || []);
  const [refreshing, setRefreshing] = useState(false);
  const [lastId, setLastId] = useState();
  const [hasMore, setHasMore] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [activeTab, setActiveTab] = useState("published");

  // Reset to Published whenever the modal opens — keeps the entry view
  // predictable (the user expects to land on what readers see, then
  // explicitly switch into Drafts when they're hunting for one).
  useEffect(() => {
    if (isVisible) setActiveTab("published");
  }, [isVisible]);

  // Bucket counts drive the badges next to each tab label. Computed
  // from the full `chapters` state, not the filtered list, so the count
  // doesn't change as the user toggles tabs.
  const tabCounts = useMemo(() => {
    let published = 0;
    let draft = 0;
    for (const ch of chapters || []) {
      if (getChapterTabBucket(ch) === "draft") draft += 1;
      else published += 1;
    }
    return { published, draft };
  }, [chapters]);

  // Filtered list rendered by FlatList. When tabs are off (reader view)
  // we pass `chapters` through unchanged so existing behavior is preserved
  // bit-for-bit.
  const displayedChapters = useMemo(() => {
    if (!showAuthorTabs) return chapters;
    return (chapters || []).filter((ch) => getChapterTabBucket(ch) === activeTab);
  }, [chapters, showAuthorTabs, activeTab]);
  const insets = useSafeAreaInsets();
  const activeRequestRef = useRef(0);
  const chaptersRef = useRef(initialChapters || []);
  const isFetchingMoreRef = useRef(false);
  const listLayoutHeightRef = useRef(0);
  const listContentHeightRef = useRef(0);
  const bookService = useRef(new BookService()).current;
  const bookThumbnailUri = typeof book?.thumbnail === "string" ? book.thumbnail : book?.thumbnail?.uri || "";

  const applyChapters = useCallback((nextChapters = []) => {
    const sortedChapters = sortBookChaptersByOrder(nextChapters);
    chaptersRef.current = sortedChapters;
    setChapters(sortedChapters);
    return sortedChapters;
  }, []);

  const syncInitialChapters = useCallback(() => {
    applyChapters(initialChapters || []);
  }, [applyChapters, initialChapters]);

  useEffect(() => {
    if (isVisible && book?.$id && !useInitialChaptersOnly) return;
    syncInitialChapters();
  }, [book?.$id, isVisible, syncInitialChapters, useInitialChaptersOnly]);

  const applyPaginatedResult = useCallback(
    (documents = []) => {
      const sortedDocuments = applyChapters(documents);
      setLastId(documents[documents.length - 1]?.$id);
      setHasMore(sortedDocuments.length > 0 && documents.length === CHAPTERS_PAGE_SIZE);
    },
    [applyChapters],
  );

  const loadFirstPage = useCallback(
    async ({ showRefresh = false } = {}) => {
      const requestId = activeRequestRef.current + 1;
      activeRequestRef.current = requestId;
      isFetchingMoreRef.current = false;
      setIsFetchingMore(false);
      setHasMore(false);
      setLastId(undefined);

      if (showRefresh) setRefreshing(true);

      try {
        if (!book?.$id || useInitialChaptersOnly) {
          const sortedInitialChapters = applyChapters(initialChapters || []);
          setLastId(sortedInitialChapters[sortedInitialChapters.length - 1]?.$id);
          setHasMore(false);
          return;
        }

        const response = await bookService.fetchBookChapters({
          bookId: book.$id,
          status: "Publish",
          limit: CHAPTERS_PAGE_SIZE,
          select: BOOK_CHAPTER_LIST_SELECT,
        });
        if (activeRequestRef.current !== requestId) return;
        applyPaginatedResult(response?.documents || []);
      } catch (error) {
        console.error("loadFirstPage: error", error);
        if (activeRequestRef.current === requestId) {
          const sortedInitialChapters = applyChapters(initialChapters || []);
          setLastId(sortedInitialChapters[sortedInitialChapters.length - 1]?.$id);
          setHasMore(false);
        }
      } finally {
        if (showRefresh && activeRequestRef.current === requestId) setRefreshing(false);
      }
    },
    [applyChapters, applyPaginatedResult, book?.$id, bookService, initialChapters, useInitialChaptersOnly],
  );

  useEffect(() => {
    if (!isVisible) return;
    loadFirstPage();
  }, [isVisible, loadFirstPage]);

  const onRefresh = async () => {
    await loadFirstPage({ showRefresh: true });
  };

  const fetchMoreBookChapters = useCallback(async () => {
    if (!book?.$id || useInitialChaptersOnly || !lastId || !hasMore || isFetchingMoreRef.current) return;

    const requestId = activeRequestRef.current;
    isFetchingMoreRef.current = true;
    setIsFetchingMore(true);

    try {
      const response = await bookService.fetchBookChapters({
        bookId: book.$id,
        status: "Publish",
        limit: CHAPTERS_PAGE_SIZE,
        lastId,
        select: BOOK_CHAPTER_LIST_SELECT,
      });
      if (activeRequestRef.current !== requestId) return;

      const documents = response?.documents || [];
      const nextLastId = documents[documents.length - 1]?.$id;
      const existingChapterIds = new Set(chaptersRef.current.map((chapter) => chapter?.$id).filter(Boolean));
      const uniqueDocuments = documents.filter((chapter) => chapter?.$id && !existingChapterIds.has(chapter.$id));
      const nextChapters = uniqueDocuments.length ? applyChapters([...chaptersRef.current, ...uniqueDocuments]) : chaptersRef.current;

      setLastId(nextLastId || lastId);
      setHasMore(Boolean(nextLastId) && uniqueDocuments.length > 0 && documents.length === CHAPTERS_PAGE_SIZE);
    } catch (error) {
      console.error("fetchMoreBookChapters: error", error);
    } finally {
      if (activeRequestRef.current === requestId) {
        isFetchingMoreRef.current = false;
      }
      setIsFetchingMore(false);
    }
  }, [applyChapters, book?.$id, bookService, hasMore, lastId, useInitialChaptersOnly]);

  const maybeFetchMoreFromListMetrics = useCallback(() => {
    if (!isVisible || !hasMore || isFetchingMoreRef.current || refreshing) return;

    const layoutHeight = listLayoutHeightRef.current;
    const contentHeight = listContentHeightRef.current;
    if (layoutHeight <= 0 || contentHeight <= 0) return;

    const contentFitsList = contentHeight <= layoutHeight + CONTENT_FIT_TOLERANCE;
    if (contentFitsList) fetchMoreBookChapters();
  }, [fetchMoreBookChapters, hasMore, isVisible, refreshing]);

  const handleListLayout = useCallback(
    (event) => {
      listLayoutHeightRef.current = event.nativeEvent.layout.height;
      maybeFetchMoreFromListMetrics();
    },
    [maybeFetchMoreFromListMetrics],
  );

  const handleContentSizeChange = useCallback(
    (_width, height) => {
      listContentHeightRef.current = height;
      maybeFetchMoreFromListMetrics();
    },
    [maybeFetchMoreFromListMetrics],
  );

  const handleListScroll = useCallback(
    (event) => {
      if (!hasMore || isFetchingMoreRef.current || refreshing) return;

      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const distanceFromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height);
      if (distanceFromBottom <= PAGINATION_BOTTOM_DISTANCE) fetchMoreBookChapters();
    },
    [fetchMoreBookChapters, hasMore, refreshing],
  );

  useEffect(() => {
    maybeFetchMoreFromListMetrics();
  }, [chapters.length, maybeFetchMoreFromListMetrics]);

  const renderFooter = () => {
    if (!isFetchingMore) return null;

    return (
      <View className="items-center py-4">
        <ActivityIndicator size="small" color={theme.primary} />
      </View>
    );
  };

  const getChapterStatusLabel = (chapter) => {
    if (chapter?.localId) return "Offline Draft";
    if (chapter?.status === "Draft") return "Draft";
    if (chapter?.status === "Publish") return "Publish";
    return chapter?.status || "Publish";
  };

  const renderChapter = ({ item, index }) => {
    // Display-only lock check (no owner-bypass): the author of the book
    // should see lock icons on their own paywalled chapters too — same as
    // web does — even though tapping those chapters still routes them
    // straight to the reader (book-info.jsx onChapterSelect uses the full
    // isChapterLocked which DOES bypass for owners, preserving free read).
    const isChapterLocked = BookUnlocksService.isChapterLockedForDisplay({
      book,
      bookChapterLockStart,
      chapter: item,
      index,
      unlocks,
    });
    const chapterStatusLabel = getChapterStatusLabel(item);
    const sectionLabel = getBookChapterSectionLabel(item, index);
    const isIntroduction = isIntroductionChapter(item, index);

    const handleChapterSelect = () => {
      onSelect(item, index);
    };
    return (
      <TouchableOpacity onPress={handleChapterSelect} className="flex-row items-center px-4 py-3">
        <View className="flex-1">
          <Text className="text-base font-medium" style={{ color: theme.text }} numberOfLines={1}>
            {item.title || sectionLabel}
          </Text>
          <View className="mt-1 flex-row items-center space-x-2">
            <Text
              className="rounded-full border px-2 py-0.5 text-[10px]"
              style={{
                borderColor: isIntroduction ? theme.accentPurple : theme.border,
                backgroundColor: isIntroduction ? theme.accentPurpleSoft : theme.surfaceMuted,
                color: isIntroduction ? theme.accentPurple : theme.textMuted,
              }}
            >
              {sectionLabel}
            </Text>
            <Text
              className="rounded-full border px-2 py-0.5 text-[10px]"
              style={{ borderColor: theme.border, backgroundColor: theme.surfaceMuted, color: theme.textMuted }}
            >
              {chapterStatusLabel}
            </Text>
          </View>
        </View>
        {isChapterLocked && <Entypo name="lock" size={16} color={theme.textSubtle} />}
        <Entypo name="chevron-right" size={16} color={theme.textSubtle} />
      </TouchableOpacity>
    );
  };

  return (
    <Modal
      isVisible={isVisible}
      onBackButtonPress={onClose}
      onBackdropPress={onClose}
      style={{ margin: 0, justifyContent: "flex-end" }}
      propagateSwipe
    >
      <View className="max-h-[85%] min-h-[85%] rounded-t-2xl" style={{ backgroundColor: theme.surfaceElevated }}>
        {/* Header */}
        <View className="flex-row items-center justify-between border-b px-4 py-3" style={{ borderColor: theme.border }}>
          <Text className="text-lg font-semibold" style={{ color: theme.text }}>
            Table of Contents
          </Text>
          <TouchableOpacity onPress={onClose}>
            <Entypo name="cross" size={22} color={theme.icon} />
          </TouchableOpacity>
        </View>

        {/* Author-only Published / Drafts tab bar. Sits between the
            sticky header and the FlatList so it stays visible at the
            top of the modal regardless of scroll position. */}
        {showAuthorTabs && (
          <View
            className="flex-row"
            style={{ borderBottomWidth: 1, borderBottomColor: theme.border, backgroundColor: theme.surfaceElevated }}
          >
            {[
              { key: "published", label: "Published", count: tabCounts.published },
              { key: "drafts", label: "Drafts", count: tabCounts.draft, bucket: "draft" },
            ].map((tab) => {
              const isActive = activeTab === (tab.bucket || tab.key);
              return (
                <TouchableOpacity
                  key={tab.key}
                  onPress={() => setActiveTab(tab.bucket || tab.key)}
                  activeOpacity={0.85}
                  style={{
                    flex: 1,
                    paddingVertical: 12,
                    alignItems: "center",
                    justifyContent: "center",
                    flexDirection: "row",
                    borderBottomWidth: 2,
                    borderBottomColor: isActive ? "#7975D4" : "transparent",
                  }}
                >
                  <Text
                    style={{
                      fontSize: 13,
                      fontWeight: isActive ? "700" : "500",
                      color: isActive ? "#7975D4" : theme.textSoft,
                      letterSpacing: 0.3,
                    }}
                  >
                    {tab.label}
                  </Text>
                  <View
                    style={{
                      marginLeft: 8,
                      minWidth: 22,
                      paddingHorizontal: 6,
                      paddingVertical: 1,
                      borderRadius: 999,
                      backgroundColor: isActive ? "#7975D4" : theme.surfaceMuted,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 11,
                        fontWeight: "700",
                        color: isActive ? "#FFFFFF" : theme.textMuted,
                      }}
                    >
                      {tab.count > 99 ? "99+" : tab.count}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        {/* Chapters list */}
        <FlatList
          className="flex-1"
          data={displayedChapters}
          renderItem={renderChapter}
          refreshing={refreshing}
          onRefresh={onRefresh}
          onEndReached={fetchMoreBookChapters}
          onEndReachedThreshold={0.4}
          onLayout={handleListLayout}
          onContentSizeChange={handleContentSizeChange}
          onScroll={handleListScroll}
          scrollEventThrottle={16}
          removeClippedSubviews={false}
          keyExtractor={(item, idx) => item.$id ?? item.localId ?? item.id ?? `chapter-${idx}`}
          ListHeaderComponent={
            <View className="mx-4 my-2 flex-row space-x-3">
              <FastImage
                source={{ uri: bookThumbnailUri, priority: FastImage.priority.high }}
                className="h-[120] w-[80] rounded-lg"
                style={{ backgroundColor: theme.surfaceMuted }}
              />
              <View className="flex-1 space-y-2">
                <Text className="text-lg font-bold" style={{ color: theme.text }} numberOfLines={2} ellipsizeMode="tail">
                  {book?.title}
                </Text>
                <View className="flex-row items-center">
                  <Text className="text-base font-medium" style={{ color: theme.textSoft }}>
                    By {book?.uploader?.username}
                  </Text>
                  <UserRoleBadgeIcons user={book?.uploader} size={14} />
                </View>
              </View>
            </View>
          }
          ListEmptyComponent={
            <View className="items-center justify-center p-6">
              <Text style={{ color: theme.textSoft }}>
                {showAuthorTabs && activeTab === "draft"
                  ? "No drafts yet — every saved-as-draft part lands here."
                  : showAuthorTabs && activeTab === "published"
                    ? "No published parts yet."
                    : "No chapters available"}
              </Text>
            </View>
          }
          ListFooterComponent={renderFooter}
          refreshControl={
            <RefreshControl
              tintColor={theme.primary}
              titleColor={theme.primary}
              progressBackgroundColor={theme.surface}
              refreshing={refreshing}
              onRefresh={onRefresh}
            />
          }
          contentContainerStyle={{ flexGrow: 1, paddingBottom: insets.bottom + 50 }}
        />
      </View>
    </Modal>
  );
};

export default BookChaptersModal;
