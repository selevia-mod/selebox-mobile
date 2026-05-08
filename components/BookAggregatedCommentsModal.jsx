// BookAggregatedCommentsModal — book-info "Comments" surface (May 2026
// rewrite). Replaces BookCommentModal, which displayed comments left
// directly on the book row. That book-level surface was barely used —
// readers engage at the chapter level instead.
//
// New behavior:
//   • Lists every top-level comment from every chapter of this book,
//     newest first, in one round-trip via
//     BookChapterCommentsService.fetchBookAggregatedChapterComments.
//   • Each row shows the commenter (avatar + username), comment preview
//     (3 lines max), time-ago, and a small "From: Chapter 5 — <title>"
//     breadcrumb so readers know which chapter the comment is on.
//   • Tapping a row routes to book-reading at that chapter with the
//     comment focused — that's where likes/replies/composer live.
//
// View-only by design:
//   • There's no top-level composer here. A book-level new comment has
//     no chapter to attach to under the new schema, so we don't offer
//     it. Users post from inside a chapter.
//   • Like/reply for any comment happens after they tap into the chapter.

import { Ionicons } from "@expo/vector-icons";
import { memo, useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Dimensions, FlatList, Text, TouchableOpacity, View } from "react-native";
import Modal from "react-native-modal";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import useAppTheme from "../hooks/useAppTheme";
import { BookChapterCommentsService } from "../lib/book-chapter-comments";
import TimeAgo from "../lib/utils/time-ago";
import UserAvatar from "./UserAvatar";

const PAGE_LIMIT = 50;
// Pixel-based heights — matches BookChapterCommentModal (which works
// fine in the chapter-reading flow). Percentage strings ("85%") on a
// child of react-native-modal's content View don't reliably resolve
// — same issue Charles hit with the report modal: modal opens, but
// the close button can land off-screen and users perceive the screen
// as frozen because tapping the visible area doesn't dismiss it.
const SCREEN_HEIGHT = Dimensions.get("window").height;
const MODAL_MAX_HEIGHT = SCREEN_HEIGHT * 0.78;
const MODAL_MIN_HEIGHT = SCREEN_HEIGHT * 0.55;

const BookAggregatedCommentsModal = ({ isVisible, book, onClose, onCommentPress, onModalHide }) => {
  const { theme } = useAppTheme();
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);

  const bookId = book?.$id || book?.id || null;

  const load = useCallback(async () => {
    if (!bookId) {
      setItems([]);
      return;
    }
    setLoading(true);
    try {
      const result = await BookChapterCommentsService.fetchBookAggregatedChapterComments?.({
        bookId,
        limit: PAGE_LIMIT,
      });
      setItems(result?.documents || []);
    } catch (error) {
      console.warn("[BookAggregatedCommentsModal] load failed:", error?.message);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [bookId]);

  // Refetch every time the modal opens — the count seen on the book-info
  // button could be stale by minutes if the user just posted a comment
  // inside a chapter and came back. Cheap query (single JOIN) so no
  // need for SWR caching here.
  useEffect(() => {
    if (isVisible) load();
  }, [isVisible, load]);

  // View-only — rows are not pressable. Earlier iterations let users
  // tap a row to open a per-chapter thread modal in-place; that
  // surfaced an iOS modal-stack freeze that we couldn't make robust
  // without significant rework. Simpler product call: this is a
  // read-only "what people are saying about this book" view. Engaging
  // (likes, replies, posting) happens inside the chapter via the
  // regular reading flow.
  const renderItem = useCallback(
    ({ item }) => {
      const owner = item?.commentOwner || {};
      const chapterLabel =
        item?.chapter?.order != null
          ? `Chapter ${item.chapter.order}${item.chapter.title ? ` — ${item.chapter.title}` : ""}`
          : item?.chapter?.title || "Chapter";

      return (
        <View
          className="flex-row px-4 py-3"
          style={{ borderBottomWidth: 1, borderBottomColor: theme.border }}
        >
          {/* UserAvatar's API is (name, avatarUri, userId) — NOT a
              source-style prop. */}
          <UserAvatar
            name={owner?.username}
            avatarUri={owner?.avatar || owner?.avatar_url}
            userId={owner?.$id}
            size={36}
            borderRadius={18}
          />
          <View className="ml-3 flex-1">
            <View className="flex-row items-center" style={{ flexWrap: "wrap" }}>
              <Text className="text-sm font-semibold" style={{ color: theme.text }} numberOfLines={1}>
                {owner?.username || "User"}
              </Text>
              {item?.created_at ? (
                <Text className="ml-2 text-[11px]" style={{ color: theme.textSoft }}>
                  · {TimeAgo(item.created_at)}
                </Text>
              ) : null}
            </View>
            <Text className="mt-1 text-sm" style={{ color: theme.text }} numberOfLines={3}>
              {item?.content || ""}
            </Text>
            <View className="mt-2 flex-row items-center" style={{ gap: 6 }}>
              <Ionicons name="bookmark-outline" size={11} color={theme.primary} />
              <Text
                className="text-[10px] font-bold uppercase"
                style={{ color: theme.primary, letterSpacing: 0.6, flexShrink: 1 }}
                numberOfLines={1}
              >
                {chapterLabel}
              </Text>
            </View>
          </View>
        </View>
      );
    },
    [theme.border, theme.primary, theme.text, theme.textSoft],
  );

  const keyExtractor = useCallback((item, index) => item?.$id || item?.id || `c-${index}`, []);

  return (
    <Modal
      isVisible={isVisible}
      onBackdropPress={onClose}
      onBackButtonPress={onClose}
      onModalHide={onModalHide}
      backdropOpacity={0.6}
      useNativeDriver
      style={{ justifyContent: "flex-end", margin: 0 }}
    >
      <View
        className="rounded-t-3xl"
        style={{
          backgroundColor: theme.surfaceElevated,
          // Explicit pixel heights — see the SCREEN_HEIGHT constants
          // at top of file for why we don't use percentage strings.
          maxHeight: MODAL_MAX_HEIGHT,
          minHeight: MODAL_MIN_HEIGHT,
          // Safe-area bottom padding so the FlatList's last row +
          // any future composer aren't behind the home indicator on
          // iPhones with the bottom gesture bar.
          paddingBottom: insets.bottom,
          borderTopWidth: 1,
          borderTopColor: theme.border,
        }}
      >
        {/* Header */}
        <View
          className="flex-row items-center justify-between px-4 py-4"
          style={{ borderBottomWidth: 1, borderBottomColor: theme.border }}
        >
          <View>
            <Text className="text-base font-bold" style={{ color: theme.text }}>
              Comments
            </Text>
            <Text className="mt-0.5 text-xs" style={{ color: theme.textSoft }}>
              From every chapter of this book
            </Text>
          </View>
          <TouchableOpacity onPress={onClose} hitSlop={10}>
            <Ionicons name="close" size={24} color={theme.icon} />
          </TouchableOpacity>
        </View>

        {/* List */}
        {loading && items.length === 0 ? (
          <View className="flex-1 items-center justify-center py-16">
            <ActivityIndicator size="small" color={theme.primary} />
          </View>
        ) : items.length === 0 ? (
          <View className="flex-1 items-center justify-center px-6 py-16">
            <Ionicons name="chatbubble-outline" size={40} color={theme.iconMuted} />
            <Text className="mt-4 text-base font-semibold" style={{ color: theme.text }}>
              No comments yet
            </Text>
            <Text className="mt-2 text-center text-sm" style={{ color: theme.textSoft }}>
              Be the first to discuss a chapter. Open a chapter and tap{"\n"}the comment icon to leave one.
            </Text>
          </View>
        ) : (
          <FlatList
            data={items}
            renderItem={renderItem}
            keyExtractor={keyExtractor}
            initialNumToRender={10}
            maxToRenderPerBatch={10}
            windowSize={5}
            removeClippedSubviews
          />
        )}
      </View>
    </Modal>
  );
};

export default memo(BookAggregatedCommentsModal);
