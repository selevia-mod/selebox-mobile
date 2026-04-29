import { MaterialCommunityIcons, MaterialIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { InteractionManager, Text, TouchableOpacity, View } from "react-native";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import { BookChapterCommentsService } from "../lib/book-chapter-comments";
import TimeAgo from "../lib/time-ago";
import UserAvatar from "./UserAvatar";

const INITIAL_VISIBLE_REPLIES = 3;

const BookChapterCommentItem = ({
  item,
  onReplyPress,
  onClose,
  onProfilePress,
  renderMentionText,
  highlightedCommentId,
  highlightedReplyId,
  onCommentActionsPress,
  onReplyActionsPress,
}) => {
  const { user } = useGlobalContext();
  const { theme } = useAppTheme();
  const likes = useMemo(
    () => (Array.isArray(item?.booksChaptersCommentLikes) ? item.booksChaptersCommentLikes : item?.booksChaptersCommentLikes?.documents || []),
    [item?.booksChaptersCommentLikes],
  );
  const likesSignature = useMemo(
    () =>
      likes
        .map((like) => String(like?.$id || like?.likeOwner?.$id || ""))
        .sort()
        .join("|"),
    [likes],
  );
  const [liked, setLiked] = useState(() => likes.some((like) => like?.likeOwner?.$id === user?.$id));
  const [likeCount, setLikeCount] = useState(likes.length);
  const [showReplies, setShowReplies] = useState(false);
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_REPLIES);
  const committedLikedRef = useRef(likes.some((like) => like?.likeOwner?.$id === user?.$id));
  const committedCountRef = useRef(likes.length);
  const desiredLikedRef = useRef(committedLikedRef.current);
  const syncInFlightRef = useRef(false);
  const isMountedRef = useRef(true);
  const appliedLikesSignatureRef = useRef(likesSignature);

  const replies = Array.isArray(item?.booksChaptersCommentReplies)
    ? item.booksChaptersCommentReplies
    : item?.booksChaptersCommentReplies?.documents || [];
  const visibleReplies = showReplies ? replies.slice(0, visibleCount) : [];
  const isHighlightedComment = String(item?.$id || "") === String(highlightedCommentId || "");
  const isOwnComment = Boolean(user?.$id && item?.commentOwner?.$id && String(item.commentOwner.$id) === String(user.$id));
  const commentBubbleStyle = {
    backgroundColor: isHighlightedComment ? theme.primarySoft : theme.surfaceMuted,
  };

  const applyOptimisticLikeState = useCallback((nextLiked, baseLiked = committedLikedRef.current, baseCount = committedCountRef.current) => {
    const delta = nextLiked === baseLiked ? 0 : nextLiked ? 1 : -1;
    const nextCount = Math.max(0, baseCount + delta);

    setLiked(nextLiked);
    setLikeCount(nextCount);
  }, []);

  useEffect(() => {
    if (likesSignature === appliedLikesSignatureRef.current) return;

    appliedLikesSignatureRef.current = likesSignature;
    const nextLiked = likes.some((like) => like?.likeOwner?.$id === user?.$id);
    const nextCount = likes.length;
    const hasPendingLocalPreference = desiredLikedRef.current !== committedLikedRef.current;

    committedLikedRef.current = nextLiked;
    committedCountRef.current = nextCount;

    if (hasPendingLocalPreference) {
      applyOptimisticLikeState(desiredLikedRef.current, nextLiked, nextCount);
      return;
    }

    desiredLikedRef.current = nextLiked;
    setLiked(nextLiked);
    setLikeCount(nextCount);
  }, [applyOptimisticLikeState, likes, likesSignature, user?.$id]);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const shouldForceShowReplies = Boolean(item?.__forceShowRepliesToken);
    if (!shouldForceShowReplies) return;

    setShowReplies(true);
    const minimumVisible = Number(item?.__forceVisibleReplies || replies.length || INITIAL_VISIBLE_REPLIES);
    setVisibleCount(Math.max(INITIAL_VISIBLE_REPLIES, minimumVisible));
  }, [item?.__forceShowRepliesToken, item?.__forceVisibleReplies, replies.length]);

  const handleUserPress = (commentTarget = null) => {
    const ownerId = commentTarget?.commentOwner?.$id || item?.commentOwner?.$id;
    if (!ownerId) return;

    if (typeof onProfilePress === "function") {
      onProfilePress(ownerId);
      return;
    }

    onClose?.();
    if (user?.$id === ownerId) router.push("/profile");
    else router.push({ pathname: "/creator-profile", params: { userId: ownerId } });
  };

  const syncLikeMutation = useCallback(() => {
    if (syncInFlightRef.current || !user?.$id || !item?.$id) return;

    syncInFlightRef.current = true;

    InteractionManager.runAfterInteractions(() => {
      const runSync = async () => {
        try {
          while (desiredLikedRef.current !== committedLikedRef.current) {
            const nextTargetLiked = desiredLikedRef.current;
            const previousCommittedLiked = committedLikedRef.current;

            if (nextTargetLiked) {
              const existingLike = likes.find((like) => like?.likeOwner?.$id === user?.$id);
              if (!existingLike) {
                await BookChapterCommentsService.likeComment({
                  userId: user.$id,
                  commentId: item.$id,
                });
              }
            } else {
              await BookChapterCommentsService.removeLikeComment({
                userId: user.$id,
                commentId: item.$id,
              });
            }

            committedLikedRef.current = nextTargetLiked;
            if (nextTargetLiked !== previousCommittedLiked) {
              committedCountRef.current = Math.max(0, committedCountRef.current + (nextTargetLiked ? 1 : -1));
            }
          }
        } catch (error) {
          console.log("handleLikeComment error:", error);
          desiredLikedRef.current = committedLikedRef.current;
          if (isMountedRef.current) {
            applyOptimisticLikeState(committedLikedRef.current, committedLikedRef.current, committedCountRef.current);
          }
        } finally {
          syncInFlightRef.current = false;
          if (desiredLikedRef.current !== committedLikedRef.current) {
            syncLikeMutation();
          }
        }
      };

      void runSync();
    });
  }, [applyOptimisticLikeState, item?.$id, likes, user?.$id]);

  const handleLikeComment = useCallback(() => {
    if (!user?.$id || !item?.$id) return;

    const nextDesiredLiked = !desiredLikedRef.current;
    desiredLikedRef.current = nextDesiredLiked;
    applyOptimisticLikeState(nextDesiredLiked);
    syncLikeMutation();
  }, [applyOptimisticLikeState, item?.$id, syncLikeMutation, user?.$id]);

  const handleToggleReplies = () => {
    if (!showReplies) {
      setShowReplies(true);
      setVisibleCount(INITIAL_VISIBLE_REPLIES);
      return;
    }
    setShowReplies(false);
    setVisibleCount(INITIAL_VISIBLE_REPLIES);
  };

  const handleViewMoreReplies = () => {
    setVisibleCount((prev) => Math.min(prev + INITIAL_VISIBLE_REPLIES, replies.length));
  };

  return (
    <View className="mb-4">
      <View className="flex-row items-start space-x-2">
        <TouchableOpacity onPress={() => handleUserPress(null)}>
          <UserAvatar
            name={item?.commentOwner?.username}
            avatarUri={item?.commentOwner?.avatar}
            size={40}
            borderRadius={20}
          />
        </TouchableOpacity>

        <View className="flex-1 flex-row items-start">
          <View className="flex-1">
            <View className="relative rounded-[8px] px-3 py-2 pr-9" style={commentBubbleStyle}>
              <TouchableOpacity onPress={() => handleUserPress(null)}>
                <Text className="font-sans text-sm font-semibold" style={{ color: theme.text }}>
                  {item?.commentOwner?.username || "Deleted User"}
                </Text>
              </TouchableOpacity>
              {isOwnComment ? (
                <TouchableOpacity
                  onPress={() => onCommentActionsPress?.(item)}
                  hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
                  className="absolute bottom-0 right-1 top-0 justify-center rounded-full p-1"
                >
                  <MaterialIcons name="more-vert" size={16} color={theme.iconMuted} />
                </TouchableOpacity>
              ) : null}
              {renderMentionText?.(item?.comment, "mt-1 font-sans text-sm leading-5", "font-sans font-semibold", {
                color: theme.textMuted,
                mentionColor: theme.accentBlue,
              })}
            </View>

            <View className="mt-1 flex-row items-center space-x-3 px-1">
              <Text className="font-sans text-xs" style={{ color: theme.textMuted }}>
                {TimeAgo(item?.$createdAt)}
              </Text>
              <TouchableOpacity onPress={() => onReplyPress?.(item)}>
                <Text className="font-sans text-xs font-semibold" style={{ color: theme.primary }}>
                  Reply
                </Text>
              </TouchableOpacity>
            </View>

            {replies.length > 0 && (
              <View className="mt-3 pl-3" style={{ borderLeftWidth: 1, borderLeftColor: theme.divider }}>
                {!showReplies ? (
                  <TouchableOpacity onPress={handleToggleReplies}>
                    <Text className="font-sans text-xs" style={{ color: theme.textSoft }}>
                      View {replies.length === 1 ? "1 reply" : `${replies.length} replies`}
                    </Text>
                  </TouchableOpacity>
                ) : (
                  <>
                    {visibleReplies.map((reply) => {
                      const isHighlightedReply = String(reply?.$id || "") === String(highlightedReplyId || "");
                      const isOwnReply = Boolean(user?.$id && reply?.commentOwner?.$id && String(reply.commentOwner.$id) === String(user.$id));
                      return (
                        <View key={reply?.$id} className="mb-3 flex-row items-center space-x-2">
                          <TouchableOpacity onPress={() => handleUserPress(reply)}>
                            <UserAvatar
                              name={reply?.commentOwner?.username}
                              avatarUri={reply?.commentOwner?.avatar}
                              size={28}
                              borderRadius={14}
                            />
                          </TouchableOpacity>

                          <View className="flex-1">
                            <View
                              className="relative rounded-[8px] px-2.5 py-2 pr-8"
                              style={{
                                backgroundColor: isHighlightedReply ? theme.primarySoft : theme.cardStrong,
                              }}
                            >
                              <TouchableOpacity onPress={() => handleUserPress(reply)}>
                                <Text className="font-sans text-xs font-semibold" style={{ color: theme.text }}>
                                  {reply?.commentOwner?.username || "Deleted User"}
                                </Text>
                              </TouchableOpacity>
                              {isOwnReply ? (
                                <TouchableOpacity
                                  onPress={() => onReplyActionsPress?.(item?.$id, reply)}
                                  hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
                                  className="absolute bottom-0 right-1 top-0 justify-center rounded-full p-1"
                                >
                                  <MaterialIcons name="more-vert" size={15} color={theme.iconMuted} />
                                </TouchableOpacity>
                              ) : null}
                              {renderMentionText?.(reply?.comment, "mt-0.5 font-sans text-xs leading-5", "font-sans font-semibold", {
                                color: theme.textMuted,
                                mentionColor: theme.accentBlue,
                              })}
                            </View>
                            <View className="mt-1 px-1">
                              <Text className="font-sans text-[11px]" style={{ color: theme.textMuted }}>
                                {TimeAgo(reply?.$createdAt)}
                              </Text>
                            </View>
                          </View>
                        </View>
                      );
                    })}

                    {visibleCount < replies.length ? (
                      <TouchableOpacity onPress={handleViewMoreReplies}>
                        <Text className="font-sans text-xs" style={{ color: theme.textSoft }}>
                          View {Math.min(INITIAL_VISIBLE_REPLIES, replies.length - visibleCount)} more{" "}
                          {replies.length - visibleCount === 1 ? "reply" : "replies"}
                        </Text>
                      </TouchableOpacity>
                    ) : null}

                    <TouchableOpacity onPress={handleToggleReplies} className="mt-1">
                      <Text className="font-sans text-xs" style={{ color: theme.textSubtle }}>
                        Hide replies
                      </Text>
                    </TouchableOpacity>
                  </>
                )}
              </View>
            )}
          </View>

          <TouchableOpacity onPress={handleLikeComment} disabled={!user?.$id} className="ml-3 items-center pt-2">
            <MaterialCommunityIcons name={liked ? "heart" : "heart-outline"} size={16} color={liked ? theme.like : theme.iconMuted} />
            <Text
              className="mt-1 text-center font-sans text-[11px] font-semibold"
              style={{ color: theme.textSoft, minWidth: 16, opacity: likeCount > 0 ? 1 : 0 }}
            >
              {likeCount > 0 ? likeCount : 0}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
};

export default memo(BookChapterCommentItem);
