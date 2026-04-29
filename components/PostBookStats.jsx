import { AntDesign, FontAwesome } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { useBookStats } from "../context/book-stats-provider";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import FormatNumber from "../lib/format-number";
import { consumePostCommentModalResume } from "../lib/post-comment-modal-resume";
import BookCommentModal from "./BookCommentModal";
import StyledDivider from "./StyledDivider";

const PostBookStats = ({ book, onSharePress }) => {
  const { user } = useGlobalContext();
  const { theme } = useAppTheme();
  const { getBookStats, toggleLike } = useBookStats();
  const [isCommentModalVisible, setCommentModalVisible] = useState(false);
  const [commentModalResumeToken, setCommentModalResumeToken] = useState(null);

  const bookId = book?.$id;
  const commentResumeScope = useMemo(() => `post-book-comment:${String(bookId || "unknown")}`, [bookId]);
  const stats = getBookStats(bookId) || {};

  // Fallback to book data if stats not loaded yet
  const likeCount = stats.likeCount ?? book?.bookLikes ?? 0;
  const commentCount = stats.commentCount ?? book?.bookComments ?? 0;
  const liked = stats.liked ?? false;
  const likeColor = theme.like;
  const commentColor = theme.comment;

  const handleLike = async () => {
    if (!user || !bookId) return;
    await toggleLike(bookId, user.$id);
  };

  useFocusEffect(
    useCallback(() => {
      if (!bookId) return;
      const pendingResume = consumePostCommentModalResume(commentResumeScope);
      if (!pendingResume?.postId) return;
      if (String(pendingResume.postId) !== String(bookId)) return;
      setCommentModalResumeToken(pendingResume.token || null);
      setCommentModalVisible(true);
    }, [bookId, commentResumeScope]),
  );

  return (
    <View className="flex flex-col space-y-2 px-4 pb-2">
      {/* Likes + Comments Counters */}
      <View className="flex-row items-center space-x-3 self-end pt-3 pb-1.5">
        <TouchableOpacity className="flex-row items-center space-x-1 rounded-full px-3 py-1" style={{ backgroundColor: "rgba(255, 77, 109, 0.18)" }}>
          <FontAwesome name="heart" size={14} color={likeColor} />
          <Text className="text-sm font-semibold" style={{ color: likeColor }}>
            {FormatNumber(likeCount)}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => {
            setCommentModalResumeToken(null);
            setCommentModalVisible(true);
          }}
          className="flex-row items-center space-x-1 rounded-full px-3 py-1"
          style={{ backgroundColor: theme.commentSoft }}
        >
          <FontAwesome name="comment" size={14} color={commentColor} />
          <Text className="text-sm font-semibold" style={{ color: commentColor }}>
            {FormatNumber(commentCount)}
          </Text>
        </TouchableOpacity>
      </View>

      <StyledDivider color={theme.divider} className="mb-0" />

      {/* Action Buttons */}
      <View className="flex-row items-center justify-between space-x-2">
        <TouchableOpacity onPress={handleLike} className="flex-1 flex-row items-center justify-center space-x-1 px-3 py-2 opacity-80">
          <AntDesign name="like1" size={15} color={liked ? theme.primary : theme.icon} />
          <Text className="text-sm font-medium" style={{ color: liked ? theme.primary : theme.text }}>
            {liked ? "Liked" : "Like"}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => {
            setCommentModalResumeToken(null);
            setCommentModalVisible(true);
          }}
          className="flex-1 flex-row items-center justify-center space-x-1 px-3 py-2 opacity-80"
        >
          <FontAwesome name="comments" size={15} color={theme.icon} />
          <Text className="text-sm font-medium" style={{ color: theme.text }}>
            Comment
          </Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={onSharePress} className="flex-1 flex-row items-center justify-center space-x-1 px-3 py-2 opacity-80">
          <FontAwesome name="share" size={15} color={theme.icon} />
          <Text className="text-sm font-medium" style={{ color: theme.text }}>
            Share
          </Text>
        </TouchableOpacity>
      </View>

      {/* Comment Modal */}
      <BookCommentModal
        isVisible={isCommentModalVisible}
        book={book}
        onClose={() => {
          setCommentModalVisible(false);
          setCommentModalResumeToken(null);
        }}
        resumeScope={commentResumeScope}
        resumeToken={commentModalResumeToken}
      />
    </View>
  );
};

export default PostBookStats;
