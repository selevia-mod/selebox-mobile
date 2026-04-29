import { Entypo } from "@expo/vector-icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from "react-native";
import Modal from "react-native-modal";
import Animated, { Easing, LinearTransition, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import useAppTheme from "../hooks/useAppTheme";
import { BOOK_CHAPTER_LIST_SELECT, BookService, getBookChapterSectionLabel, isIntroductionChapter, sortBookChaptersByOrder } from "../lib/books";
import TimeAgo from "../lib/time-ago";

const ROW_HEIGHT = 78;
const ROW_LAYOUT_TRANSITION = LinearTransition.springify().damping(28).stiffness(105).mass(0.45);

const moveItem = (list, fromIndex, toIndex) => {
  if (fromIndex === toIndex) return list;
  const updated = [...list];
  const [item] = updated.splice(fromIndex, 1);
  updated.splice(toIndex, 0, item);
  return updated;
};

const BookChapterReorderModal = ({ isVisible, onClose, book, chapters = [], chaptersTotal = 0, onSave, saving = false }) => {
  const { theme } = useAppTheme();
  const bookService = useRef(new BookService()).current;
  const sortedChapters = useMemo(() => sortBookChaptersByOrder(chapters), [chapters]);
  const introductionChapter = useMemo(() => sortedChapters.find((chapter, index) => isIntroductionChapter(chapter, index)) || null, [sortedChapters]);
  const baseReorderableChapters = useMemo(
    () => (introductionChapter ? sortedChapters.filter((chapter) => chapter?.$id !== introductionChapter.$id) : sortedChapters),
    [introductionChapter, sortedChapters],
  );
  const [orderedChapters, setOrderedChapters] = useState(baseReorderableChapters);
  const [dragging, setDragging] = useState(null);
  const [lastId, setLastId] = useState();
  const [hasMore, setHasMore] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const isFetchingMoreRef = useRef(false);
  const dragTranslateY = useSharedValue(0);
  const dragScale = useSharedValue(1);

  useEffect(() => {
    if (!isVisible) return;
    setOrderedChapters(baseReorderableChapters);
    setLastId(sortedChapters[sortedChapters.length - 1]?.$id);
    const effectiveTotal = introductionChapter ? Math.max(Number(chaptersTotal) - 1, 0) : Number(chaptersTotal);
    setHasMore(effectiveTotal > baseReorderableChapters.length);
    setIsFetchingMore(false);
    isFetchingMoreRef.current = false;
    setDragging(null);
    dragTranslateY.value = 0;
    dragScale.value = 1;
  }, [baseReorderableChapters, chaptersTotal, dragScale, dragTranslateY, introductionChapter, isVisible, sortedChapters]);

  const hasChanges = useMemo(() => {
    if (orderedChapters.length !== baseReorderableChapters.length) return true;
    return orderedChapters.some((chapter, index) => chapter.$id !== baseReorderableChapters[index]?.$id);
  }, [baseReorderableChapters, orderedChapters]);

  const handleLongPress = (chapter, index, event) => {
    if (saving) return;
    dragTranslateY.value = withTiming(0, { duration: 120 });
    dragScale.value = withTiming(1.015, { duration: 180, easing: Easing.out(Easing.cubic) });
    setDragging({
      chapterId: chapter.$id,
      startIndex: index,
      currentIndex: index,
      startPageY: event.nativeEvent.pageY,
    });
  };

  const handleTouchMove = (event) => {
    if (!dragging || saving) return;

    const pageY = event.nativeEvent.pageY;
    const deltaY = pageY - dragging.startPageY;
    const movedSlots = Math.round(deltaY / ROW_HEIGHT);
    const targetIndex = Math.max(0, Math.min(orderedChapters.length - 1, dragging.startIndex + movedSlots));
    const visualTranslateY = deltaY - (targetIndex - dragging.startIndex) * ROW_HEIGHT;
    dragTranslateY.value = withTiming(visualTranslateY, {
      duration: 44,
      easing: Easing.out(Easing.cubic),
    });

    if (targetIndex === dragging.currentIndex) return;
    setOrderedChapters((prev) => moveItem(prev, dragging.currentIndex, targetIndex));
    setDragging((prev) => (prev ? { ...prev, currentIndex: targetIndex } : prev));
  };

  const endDrag = () => {
    if (!dragging) return;
    dragTranslateY.value = withTiming(
      0,
      {
        duration: 220,
        easing: Easing.out(Easing.cubic),
      },
      (finished) => {
        if (finished) runOnJS(setDragging)(null);
      },
    );
    dragScale.value = withTiming(1, { duration: 200, easing: Easing.out(Easing.cubic) });
  };

  const dragRowStyle = useAnimatedStyle(() => {
    return {
      transform: [{ translateY: dragTranslateY.value }, { scale: dragScale.value }],
    };
  });

  const fetchMoreBookChapters = useCallback(async () => {
    try {
      if (!book?.$id || !hasMore || isFetchingMoreRef.current) return;
      isFetchingMoreRef.current = true;
      setIsFetchingMore(true);

      const chaptersData = await bookService.fetchBookChapters({
        bookId: book.$id,
        limit: 15,
        select: BOOK_CHAPTER_LIST_SELECT,
        ...(lastId ? { lastId } : {}),
      });
      const fetchedChapters = sortBookChaptersByOrder(chaptersData?.documents || []);
      const nextLastId = fetchedChapters[fetchedChapters.length - 1]?.$id;

      setOrderedChapters((prev) => {
        const uniqueChapters = fetchedChapters.filter(
          (chapter, index) => !isIntroductionChapter(chapter, index) && !prev.some((existing) => existing.$id === chapter.$id),
        );
        const next = uniqueChapters.length ? [...prev, ...uniqueChapters] : prev;
        const effectiveTotal = introductionChapter ? Math.max(Number(chaptersTotal) - 1, 0) : Number(chaptersTotal);
        if (effectiveTotal > 0) {
          setHasMore(next.length < effectiveTotal);
        } else if (!uniqueChapters.length) {
          setHasMore(false);
        }
        return next;
      });

      setLastId(nextLastId);
      if (!nextLastId) setHasMore(false);
    } catch (error) {
      console.log("fetchMoreBookChapters: error", error);
    } finally {
      isFetchingMoreRef.current = false;
      setIsFetchingMore(false);
    }
  }, [book?.$id, bookService, chaptersTotal, hasMore, introductionChapter, lastId]);

  useEffect(() => {
    if (!isVisible || !hasMore || isFetchingMoreRef.current) return;
    if (orderedChapters.length > 0 && orderedChapters.length < 8) {
      fetchMoreBookChapters();
    }
  }, [fetchMoreBookChapters, hasMore, isVisible, orderedChapters.length]);

  const handleListScroll = useCallback(
    (event) => {
      if (dragging || !hasMore || isFetchingMoreRef.current) return;
      const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
      const nearBottom = layoutMeasurement.height + contentOffset.y >= contentSize.height - 120;
      if (nearBottom) fetchMoreBookChapters();
    },
    [dragging, fetchMoreBookChapters, hasMore],
  );

  return (
    <Modal isVisible={isVisible} onBackButtonPress={onClose} onBackdropPress={onClose} style={{ margin: 0, justifyContent: "flex-end" }}>
      <View className="max-h-[85%] min-h-[85%] rounded-t-2xl" style={{ backgroundColor: theme.background }}>
        <View className="flex-row items-center justify-between px-4 py-3" style={{ borderBottomWidth: 1, borderBottomColor: theme.border }}>
          <View>
            <Text className="text-lg font-semibold" style={{ color: theme.text }}>
              Reorder Parts
            </Text>
            <Text className="mt-0.5 text-xs" style={{ color: theme.textSoft }}>
              The introduction stays fixed at the top.
            </Text>
          </View>
          <TouchableOpacity onPress={onClose}>
            <Entypo name="cross" size={22} color={theme.icon} />
          </TouchableOpacity>
        </View>

        <View className="flex-1" onTouchMove={handleTouchMove} onTouchEnd={endDrag} onTouchCancel={endDrag}>
          <ScrollView
            className="flex-1 px-4 pt-3"
            showsVerticalScrollIndicator={false}
            scrollEnabled={!dragging}
            onScroll={handleListScroll}
            scrollEventThrottle={16}
          >
            {introductionChapter ? (
              <View className="mb-3 rounded-xl px-3 py-3" style={{ borderWidth: 1, borderColor: theme.primary, backgroundColor: theme.primarySoft }}>
                <View className="flex-row items-center">
                  <View
                    className="mr-3 h-7 w-7 items-center justify-center rounded-full"
                    style={{ borderWidth: 1, borderColor: theme.primary, backgroundColor: theme.surfaceMuted }}
                  >
                    <Text className="text-[10px] font-semibold" style={{ color: theme.textMuted }}>
                      Intro
                    </Text>
                  </View>
                  <View className="flex-1 pr-3">
                    <Text className="text-sm font-semibold" style={{ color: theme.text }} numberOfLines={1}>
                      {introductionChapter.title || "Introduction"}
                    </Text>
                    <View className="mt-1 flex-row items-center space-x-2">
                      <Text
                        className="rounded-full px-2 py-0.5 text-[10px]"
                        style={{ borderWidth: 1, borderColor: theme.primary, backgroundColor: theme.primarySoft, color: theme.primary }}
                      >
                        Introduction
                      </Text>
                      <Text
                        className="rounded-full px-2 py-0.5 text-[10px]"
                        style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surfaceMuted, color: theme.textMuted }}
                      >
                        Fixed first item
                      </Text>
                    </View>
                  </View>
                  <Entypo name="lock" size={18} color={theme.primary} />
                </View>
              </View>
            ) : null}

            {orderedChapters.length ? (
              orderedChapters.map((chapter, index) => {
                const isDragging = dragging?.chapterId === chapter.$id;
                const displayOrder = index + 1;
                const displayChapter = { ...chapter, order: displayOrder };
                return (
                  <Animated.View key={chapter.$id} layout={ROW_LAYOUT_TRANSITION} style={isDragging ? [{ zIndex: 10 }, dragRowStyle] : undefined}>
                    <TouchableOpacity
                      onLongPress={(event) => handleLongPress(chapter, index, event)}
                      delayLongPress={220}
                      activeOpacity={0.9}
                      disabled={saving}
                      style={[
                        { height: ROW_HEIGHT, justifyContent: "center" },
                        isDragging
                          ? [
                              {
                                zIndex: 10,
                              },
                            ]
                          : null,
                      ]}
                      className="mb-2 rounded-xl border px-3 py-3"
                      style={{ borderColor: isDragging ? theme.primary : theme.border, backgroundColor: isDragging ? theme.primarySoft : theme.card }}
                    >
                      <View className="flex-row items-center">
                        <View
                          className="mr-3 h-7 w-7 items-center justify-center rounded-full"
                          style={{ borderWidth: 1, borderColor: theme.borderStrong, backgroundColor: theme.surfaceMuted }}
                        >
                          <Text className="text-xs font-semibold" style={{ color: theme.textMuted }}>
                            {displayOrder}
                          </Text>
                        </View>
                        <View className="flex-1 pr-3">
                          <Text className="text-sm font-semibold" style={{ color: theme.text }} numberOfLines={1}>
                            {chapter.title || getBookChapterSectionLabel(displayChapter, displayOrder - 1)}
                          </Text>
                          <View className="mt-1 flex-row items-center space-x-2">
                            <Text
                              className="rounded-full px-2 py-0.5 text-[10px]"
                              style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surfaceMuted, color: theme.textMuted }}
                            >
                              {getBookChapterSectionLabel(displayChapter, displayOrder - 1)}
                            </Text>
                            <Text
                              className="rounded-full px-2 py-0.5 text-[10px]"
                              style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surfaceMuted, color: theme.textMuted }}
                            >
                              {chapter.status}
                            </Text>
                            <Text className="text-[11px]" style={{ color: theme.textSoft }}>
                              {TimeAgo(chapter.$createdAt)}
                            </Text>
                          </View>
                        </View>
                        <Entypo name="menu" size={18} color={isDragging ? theme.primary : theme.iconMuted} />
                      </View>
                    </TouchableOpacity>
                  </Animated.View>
                );
              })
            ) : (
              <View className="items-center justify-center py-10">
                <Text className="text-sm" style={{ color: theme.textSoft }}>
                  {introductionChapter ? "Add more parts to reorder them here." : "No parts to reorder yet."}
                </Text>
              </View>
            )}
            {isFetchingMore ? (
              <View className="items-center py-3">
                <ActivityIndicator size="small" color={theme.primary} />
              </View>
            ) : null}
          </ScrollView>
        </View>

        <View className="p-4" style={{ borderTopWidth: 1, borderTopColor: theme.border }}>
          <TouchableOpacity
            onPress={() => onSave(introductionChapter ? [introductionChapter, ...orderedChapters] : orderedChapters)}
            disabled={saving || !orderedChapters.length || !hasChanges}
            className="items-center justify-center rounded-full py-3 disabled:opacity-50"
            style={{ backgroundColor: theme.primary }}
          >
            {saving ? (
              <View className="flex-row items-center space-x-2">
                <ActivityIndicator size="small" color={theme.primaryContrast} />
                <Text className="font-semibold" style={{ color: theme.primaryContrast }}>
                  Saving order...
                </Text>
              </View>
            ) : (
              <Text className="font-semibold" style={{ color: theme.primaryContrast }}>
                Save part order
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
};

export default BookChapterReorderModal;
