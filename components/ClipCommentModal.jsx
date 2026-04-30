import { router } from "expo-router";
import { memo, useEffect, useState } from "react";
import {
  Dimensions,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import FastImage from "react-native-fast-image";
import UserAvatar from "./UserAvatar";
import LoaderKit from "react-native-loader-kit";
import Modal from "react-native-modal";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useClipsStats } from "../context/clip-stats-provider";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import { createClipComment, fetchClipComments, updateClip } from "../lib/clips";
import TimeAgo from "../lib/utils/time-ago";
import UserRoleBadgeIcons from "./UserRoleBadgeIcons";

const SCREEN_HEIGHT = Dimensions.get("window").height;

const ClipCommentModal = ({ isVisible, onClose, item, onCommentPosted }) => {
  const insets = useSafeAreaInsets();
  const { user } = useGlobalContext();
  const { theme } = useAppTheme();
  const { incrementCommentCount, updateClipCommentCount } = useClipsStats();

  const [loading, setLoading] = useState(true);
  const [comments, setComments] = useState([]);
  const [commentText, setCommentText] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [lastId, setLastId] = useState();
  const [hasMore, setHasMore] = useState(false);
  const clipID = item?.$id;

  useEffect(() => {
    if (clipID && isVisible) {
      fetchComments();
    }
  }, [clipID, isVisible]);

  const fetchComments = async () => {
    try {
      setLoading(true);
      const comments = await fetchClipComments({ clipId: clipID });
      setComments(comments.documents);
      setHasMore(comments.documents.length < comments.total);
      setLastId(comments.documents.at(-1)?.$id);
      updateClipCommentCount(clipID, comments.documents.length);
    } catch (error) {
      console.log("fetchComments: error", error);
    } finally {
      setLoading(false);
    }
  };

  const fetchMoreComments = async () => {
    if (!lastId || !hasMore) return;
    try {
      const commentsData = await fetchClipComments({
        clipId: clipID,
        lastId,
        limit: 10,
      });

      const uniqueComments = commentsData.documents.filter((comment) => !comments.some((existing) => existing.$id === comment.$id));

      if (uniqueComments.length === 0) {
        setHasMore(false);
        return;
      }

      const updatedFetchedComments = [...comments, ...uniqueComments];
      setComments(updatedFetchedComments);
      setLastId(commentsData.documents.at(-1)?.$id);
      if (updatedFetchedComments.length >= commentsData.total) setHasMore(false);
    } catch (error) {
      console.log("fetchMoreComments: error", error);
    }
  };

  const handlePostComment = async () => {
    if (isSubmitting || !commentText?.trim()) return;

    try {
      setIsSubmitting(true);
      const response = await createClipComment({
        clipId: clipID,
        comment: commentText,
        commentOwner: user?.$id,
      });

      setComments((prev) => [...prev, response]);
      setCommentText("");
      incrementCommentCount(clipID);
      onCommentPosted(Math.max(0, comments.length));
      // backend sync
      await updateClip({
        ID: clipID,
        clipComments: Math.max(0, comments.length + 1),
      });
    } catch (error) {
      console.log("handlePostComment: error", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const renderCommentItem = ({ item }) => {
    const commentBubbleStyle = {
      backgroundColor: theme.surfaceMuted,
    };

    const handleUserPress = () => {
      onClose();
      if (user?.$id === item?.commentOwner?.$id) router.push("/profile");
      else
        router.push({
          pathname: "/creator-profile",
          params: { userId: item?.commentOwner?.$id },
        });
    };

    return (
      <TouchableWithoutFeedback>
        <View className="mb-5 flex flex-row space-x-2">
          <TouchableOpacity onPress={handleUserPress}>
            <UserAvatar name={item?.commentOwner?.username} avatarUri={item?.commentOwner?.avatar} size={40} borderRadius={20} />
          </TouchableOpacity>

          <View className="flex flex-1 flex-col justify-center rounded-[8px] px-3 py-2" style={commentBubbleStyle}>
            <View className="flex flex-row items-center space-x-1">
              <TouchableOpacity onPress={handleUserPress}>
                <View className="flex-row items-center">
                  <Text className="font-sans text-sm font-semibold" style={{ color: theme.text }}>
                    {item?.commentOwner?.username || "Deleted User"}
                  </Text>
                  <UserRoleBadgeIcons user={item?.commentOwner} size={16} />
                </View>
              </TouchableOpacity>
              <Text className="font-sans text-xs" style={{ color: theme.textSoft }}>
                {TimeAgo(item?.$createdAt)}
              </Text>
            </View>
            <Text className="font-sans text-sm" style={{ color: theme.textMuted }}>
              {item?.comment}
            </Text>
          </View>
        </View>
      </TouchableWithoutFeedback>
    );
  };

  return (
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
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{
          minHeight: SCREEN_HEIGHT * 0.5,
          maxHeight: SCREEN_HEIGHT * 0.7,
          borderTopLeftRadius: 28,
          borderTopRightRadius: 28,
          borderTopWidth: 1,
          borderTopColor: theme.border,
          paddingBottom: insets.bottom + 16,
          backgroundColor: theme.surfaceElevated,
        }}
      >
        {/* Drag Handle */}
        <View className="items-center py-2">
          <View className="h-1.5 w-20 rounded-full" style={{ backgroundColor: theme.handle }} />
        </View>

        {/* Comments */}
        {loading ? (
          <View className="flex-1 items-center justify-center">
            <LoaderKit style={{ width: 40, height: 40, opacity: 0.5 }} name={"LineScale"} color={theme.primary} />
          </View>
        ) : (
          <FlatList
            data={comments}
            keyExtractor={(item) => item?.$id || item?.id || `${item?.comment}-${item?.$createdAt}`}
            contentContainerStyle={{
              paddingHorizontal: 16,
              paddingBottom: 12,
              flexGrow: 1,
            }}
            showsVerticalScrollIndicator={false}
            renderItem={renderCommentItem}
            // Virtualization tuning — see PostCommentModal for rationale.
            initialNumToRender={8}
            maxToRenderPerBatch={6}
            windowSize={10}
            updateCellsBatchingPeriod={50}
            ListEmptyComponent={
              <View className="flex flex-1 items-center justify-center">
                <Text className="font-sans text-sm font-medium" style={{ color: theme.textSoft }}>
                  No Comments Available
                </Text>
              </View>
            }
            onEndReached={fetchMoreComments}
          />
        )}

        {/* Input */}
        <View
          className="flex-row items-center border-t px-4 py-3"
          style={{ paddingBottom: insets.bottom, borderTopColor: theme.border, backgroundColor: theme.surfaceElevated }}
        >
          <TextInput
            onChangeText={setCommentText}
            value={commentText}
            placeholder="Add a comment..."
            placeholderTextColor={theme.placeholder}
            className="flex-1"
            maxLength={300}
            autoCapitalize="sentences"
            multiline
            style={{ maxHeight: 100, color: theme.inputText }}
          />
          <TouchableOpacity onPress={handlePostComment} disabled={isSubmitting} className="ml-4">
            <Text className="font-semibold" style={{ color: isSubmitting ? theme.textSoft : theme.primary }}>
              Post
            </Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
};

export default memo(ClipCommentModal);
