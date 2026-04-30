import { MaterialCommunityIcons, MaterialIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Dimensions,
  FlatList,
  InteractionManager,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Query } from "react-native-appwrite";
import FastImage from "react-native-fast-image";
import UserAvatar from "./UserAvatar";
import LoaderKit from "react-native-loader-kit";
import Modal from "react-native-modal";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useGlobalContext } from "../context/global-provider";
import { useVideosStats } from "../context/video-stats-provider";
import useAppTheme from "../hooks/useAppTheme";
import { databases } from "../lib/appwrite";
import { buildVideoNotificationResourceId, NotificationService } from "../lib/notifications";
import TimeAgo from "../lib/utils/time-ago";
import {
  buildMentionSearchTerms,
  extractMentionTargetsFromMarkup,
  extractMentionUsernames,
  findComposerMentionAtPosition,
  hasMentionLabelInText,
  MENTION_SEARCH_DEBOUNCE_MS,
  normalizeExternalUrl,
  normalizeMentionSearchQuery,
  normalizeMentionToken,
  rankMentionCandidatesByUsername,
  sanitizeMentionLabel,
  serializeMentionsForStorage,
} from "../lib/user-mentions";
import { fetchUsersByQuery, getUserByID } from "../lib/users";
import {
  createVideoComment,
  createVideoCommentLike,
  createVideoReplyComment,
  fetchVideoCommentLikesByCommentIds,
  fetchVideoCommentRepliesByParentIds,
  fetchVideoComments,
  removeVideoCommentLike,
  threadVideoComments,
} from "../lib/video";
import useCommentReactionState from "../hooks/useCommentReactionState";
import secrets from "../private/secrets";
import ReactionPicker from "./ReactionPicker";
import UserRoleBadgeIcons from "./UserRoleBadgeIcons";
import UserMention from "./UserMention";

const SCREEN_HEIGHT = Dimensions.get("window").height;
const PAGE_SIZE = 10;
const INITIAL_VISIBLE_REPLIES = 3;
const SUBMITTED_REPLY_HIGHLIGHT_MS = 3200;
const resolveOwnerId = (owner) => {
  if (!owner) return null;
  if (typeof owner === "string") return owner;
  return owner?.$id || owner?.id || null;
};
const getCommentReplies = (comment) => {
  if (Array.isArray(comment?.videoComments)) return comment.videoComments;
  if (Array.isArray(comment?.videoCommentReplies)) return comment.videoCommentReplies;
  return [];
};

const getCommentLikes = (comment) => {
  if (Array.isArray(comment?.videoCommentLikes)) return comment.videoCommentLikes;
  if (Array.isArray(comment?.videosCommentLikes)) return comment.videosCommentLikes;
  if (Array.isArray(comment?.videoCommentsLikes)) return comment.videoCommentsLikes;
  return [];
};

const VideoCommentItem = memo(
  ({
    item,
    highlightedCommentId,
    highlightedReplyId,
    onReplyPress,
    onProfilePress,
    currentUserId,
    showReplies,
    visibleCount,
    onToggleReplies,
    onViewMoreReplies,
    onCommentActionsPress,
    onReplyActionsPress,
    renderMentionText,
  }) => {
    const { theme } = useAppTheme();
    const replies = getCommentReplies(item);
    const likes = useMemo(() => getCommentLikes(item), [item?.videoCommentLikes, item?.videosCommentLikes, item?.videoCommentsLikes]);
    const likesSignature = useMemo(
      () =>
        likes
          .map((like) => String(like?.$id || resolveOwnerId(like?.likeOwner) || ""))
          .sort()
          .join("|"),
      [likes],
    );
    const visibleReplies = showReplies ? replies.slice(0, visibleCount) : [];
    const normalizedCurrentUserId = String(currentUserId || "");
    const isOwnComment = Boolean(currentUserId && item?.commentOwner?.$id && String(item.commentOwner.$id) === String(currentUserId));
    const isHighlightedComment = String(item?.$id || "") === highlightedCommentId;
    const commentBubbleStyle = {
      backgroundColor: isHighlightedComment ? theme.primarySoft : theme.surfaceMuted,
    };
    const [liked, setLiked] = useState(() => likes.some((like) => String(resolveOwnerId(like?.likeOwner) || "") === normalizedCurrentUserId));
    const [likeCount, setLikeCount] = useState(likes.length);
    const committedLikedRef = useRef(likes.some((like) => String(resolveOwnerId(like?.likeOwner) || "") === normalizedCurrentUserId));
    const committedCountRef = useRef(likes.length);
    const desiredLikedRef = useRef(committedLikedRef.current);
    const syncInFlightRef = useRef(false);
    const isMountedRef = useRef(true);
    const appliedLikesSignatureRef = useRef(likesSignature);

    const handleUserPress = (commentTarget) => {
      const ownerId = commentTarget?.commentOwner?.$id;
      if (!ownerId) return;
      if (typeof onProfilePress === "function") {
        onProfilePress(ownerId);
        return;
      }
      if (currentUserId === ownerId) router.push("/profile");
      else router.push({ pathname: "/creator-profile", params: { userId: ownerId } });
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
      const nextLiked = likes.some((like) => String(resolveOwnerId(like?.likeOwner) || "") === normalizedCurrentUserId);
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
    }, [applyOptimisticLikeState, likes, likesSignature, normalizedCurrentUserId]);

    useEffect(() => {
      return () => {
        isMountedRef.current = false;
      };
    }, []);

    const syncLikeMutation = useCallback(() => {
      if (syncInFlightRef.current || !item?.$id || !normalizedCurrentUserId) return;

      syncInFlightRef.current = true;

      InteractionManager.runAfterInteractions(() => {
        const runSync = async () => {
          try {
            while (desiredLikedRef.current !== committedLikedRef.current) {
              const nextTargetLiked = desiredLikedRef.current;
              const previousCommittedLiked = committedLikedRef.current;

              if (nextTargetLiked) {
                const existingLike = likes.find((like) => String(resolveOwnerId(like?.likeOwner) || "") === normalizedCurrentUserId);
                if (!existingLike) {
                  const newLike = await createVideoCommentLike({
                    commentId: item.$id,
                    likeOwner: normalizedCurrentUserId,
                  });
                  if (!newLike) throw new Error("Video comment like not created");
                }
              } else {
                await removeVideoCommentLike({
                  commentId: item.$id,
                  likeOwner: normalizedCurrentUserId,
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
    }, [applyOptimisticLikeState, item?.$id, likes, normalizedCurrentUserId]);

    const handleLikeComment = useCallback(() => {
      if (!item?.$id || !normalizedCurrentUserId) return;

      const nextDesiredLiked = !desiredLikedRef.current;
      desiredLikedRef.current = nextDesiredLiked;
      applyOptimisticLikeState(nextDesiredLiked);
      syncLikeMutation();
    }, [applyOptimisticLikeState, item?.$id, normalizedCurrentUserId, syncLikeMutation]);

    // Reaction overlay — wires the picker over the existing binary like.
    const reactions = useCommentReactionState({ initialLiked: liked });

    const handleReactionTap = useCallback(() => {
      if (!item?.$id || !normalizedCurrentUserId) return;
      const wasReacted = !!reactions.userReactionKey;
      reactions.toggleTopLevelDefault();
      // Sync server-side like to match reaction presence
      const targetLiked = !wasReacted;
      if (targetLiked !== desiredLikedRef.current) {
        desiredLikedRef.current = targetLiked;
        applyOptimisticLikeState(targetLiked);
        syncLikeMutation();
      }
    }, [applyOptimisticLikeState, item?.$id, normalizedCurrentUserId, reactions, syncLikeMutation]);

    const handlePickReactionWithSync = useCallback(
      (key) => {
        const wasTopLevel = reactions.isPickerForTopLevel;
        reactions.handlePickReaction(key);
        // Only top-level reactions sync to backend like state (replies are visual-only).
        if (wasTopLevel && !desiredLikedRef.current) {
          desiredLikedRef.current = true;
          applyOptimisticLikeState(true);
          syncLikeMutation();
        }
      },
      [applyOptimisticLikeState, reactions, syncLikeMutation],
    );

    return (
      <View className="mb-4">
        <View className="flex-row items-start space-x-2">
          <TouchableOpacity onPress={() => handleUserPress(item)}>
            <UserAvatar name={item?.commentOwner?.username} avatarUri={item?.commentOwner?.avatar} size={40} borderRadius={20} />
          </TouchableOpacity>

          <View className="flex-1 flex-row items-start">
            <View className="flex-1">
              <View className="relative rounded-[8px] px-3 py-2 pr-9" style={commentBubbleStyle}>
                <TouchableOpacity onPress={() => handleUserPress(item)}>
                  <View className="flex-row items-center pr-3">
                    <Text className="font-sans text-sm font-semibold" style={{ color: theme.text }}>
                      {item?.commentOwner?.username || "Deleted User"}
                    </Text>
                    <UserRoleBadgeIcons user={item?.commentOwner} size={16} />
                  </View>
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

              <View className="mt-1 flex-row items-center px-1" style={{ gap: 12 }}>
                <Text className="font-sans text-xs" style={{ color: theme.textMuted }}>
                  {TimeAgo(item?.$createdAt)}
                </Text>
                <TouchableOpacity
                  ref={reactions.likeButtonRef}
                  onPress={handleReactionTap}
                  onLongPress={reactions.openTopLevelPicker}
                  delayLongPress={220}
                  disabled={!normalizedCurrentUserId}
                  hitSlop={{ top: 6, right: 6, bottom: 6, left: 6 }}
                  style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
                >
                  {reactions.activeReaction ? (
                    <Text style={{ fontSize: 13, lineHeight: 16 }}>{reactions.activeReaction.emoji}</Text>
                  ) : (
                    <Text className="font-sans text-xs font-semibold" style={{ color: theme.textSoft }}>
                      React
                    </Text>
                  )}
                  {likeCount > 0 ? (
                    <Text className="font-sans text-xs font-semibold" style={{ color: reactions.activeReaction ? theme.like : theme.textSoft }}>
                      {likeCount}
                    </Text>
                  ) : null}
                </TouchableOpacity>
                <TouchableOpacity onPress={() => onReplyPress(item)}>
                  <Text className="font-sans text-xs font-semibold" style={{ color: theme.primary }}>
                    Reply
                  </Text>
                </TouchableOpacity>
              </View>

              {replies.length > 0 && (
                <View className="mt-3 border-l pl-3" style={{ borderLeftColor: theme.border }}>
                  {!showReplies ? (
                    <TouchableOpacity onPress={onToggleReplies}>
                      <Text className="font-sans text-xs" style={{ color: theme.textSoft }}>
                        View {replies.length === 1 ? "1 reply" : `${replies.length} replies`}
                      </Text>
                    </TouchableOpacity>
                  ) : (
                    <>
                      {visibleReplies.map((reply) => (
                        <View key={reply?.$id} className="mb-3 flex-row items-center space-x-2">
                          <TouchableOpacity onPress={() => handleUserPress(reply)}>
                            <UserAvatar name={reply?.commentOwner?.username} avatarUri={reply?.commentOwner?.avatar} size={28} borderRadius={14} />
                          </TouchableOpacity>

                          <View className="flex-1">
                            <View
                              className="relative rounded-[8px] px-2.5 py-2 pr-8"
                              style={{
                                backgroundColor: String(reply?.$id || "") === highlightedReplyId ? theme.primarySoft : theme.cardStrong,
                              }}
                            >
                              <TouchableOpacity onPress={() => handleUserPress(reply)}>
                                <View className="flex-row items-center pr-2">
                                  <Text className="font-sans text-xs font-semibold" style={{ color: theme.text }}>
                                    {reply?.commentOwner?.username || "Deleted User"}
                                  </Text>
                                  <UserRoleBadgeIcons user={reply?.commentOwner} size={16} />
                                </View>
                              </TouchableOpacity>
                              {currentUserId && reply?.commentOwner?.$id && String(reply.commentOwner.$id) === String(currentUserId) ? (
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
                            <View className="mt-1 flex-row items-center px-1" style={{ gap: 12 }}>
                              <Text className="font-sans text-[11px]" style={{ color: theme.textMuted }}>
                                {TimeAgo(reply?.$createdAt)}
                              </Text>
                              <TouchableOpacity
                                ref={(el) => reactions.registerReplyButton(reply.$id, el)}
                                onPress={() => reactions.toggleReplyDefault(reply.$id)}
                                onLongPress={() => reactions.openReplyPicker(reply.$id)}
                                delayLongPress={220}
                                disabled={!normalizedCurrentUserId}
                                hitSlop={{ top: 6, right: 6, bottom: 6, left: 6 }}
                                style={{ flexDirection: "row", alignItems: "center" }}
                              >
                                {reactions.getReplyReaction(reply.$id) ? (
                                  <Text style={{ fontSize: 13, lineHeight: 16 }}>{reactions.getReplyReaction(reply.$id).emoji}</Text>
                                ) : (
                                  <Text className="font-sans text-[11px] font-semibold" style={{ color: theme.textSoft }}>
                                    React
                                  </Text>
                                )}
                              </TouchableOpacity>
                              {normalizedCurrentUserId ? (
                                <TouchableOpacity
                                  onPress={() => onReplyPress(item, reply?.commentOwner)}
                                  hitSlop={{ top: 6, right: 6, bottom: 6, left: 6 }}
                                >
                                  <Text className="font-sans text-[11px] font-semibold" style={{ color: theme.primary }}>
                                    Reply
                                  </Text>
                                </TouchableOpacity>
                              ) : null}
                            </View>
                          </View>
                        </View>
                      ))}

                      {visibleCount < replies.length ? (
                        <TouchableOpacity onPress={onViewMoreReplies}>
                          <Text className="font-sans text-xs" style={{ color: theme.textSoft }}>
                            View {Math.min(INITIAL_VISIBLE_REPLIES, replies.length - visibleCount)} more{" "}
                            {replies.length - visibleCount === 1 ? "reply" : "replies"}
                          </Text>
                        </TouchableOpacity>
                      ) : null}

                      <TouchableOpacity onPress={onToggleReplies} className="mt-1">
                        <Text className="font-sans text-xs" style={{ color: theme.textSubtle }}>
                          Hide replies
                        </Text>
                      </TouchableOpacity>
                    </>
                  )}
                </View>
              )}
            </View>
          </View>
        </View>

        <ReactionPicker
          visible={reactions.pickerVisible}
          anchor={reactions.pickerAnchor}
          activeKey={reactions.pickerActiveKey}
          onSelect={handlePickReactionWithSync}
          onClose={reactions.closePicker}
        />
      </View>
    );
  },
);

const VideoCommentModal = ({ isVisible, onClose, item, onCommentPosted }) => {
  const insets = useSafeAreaInsets();
  const { user } = useGlobalContext();
  const { theme } = useAppTheme();
  const { updateVideoStats } = useVideosStats();
  const notificationService = useRef(new NotificationService()).current;
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const highlightTimeoutRef = useRef(null);
  const submittedReplyHighlightTimeoutRef = useRef(null);
  const mentionTimerRef = useRef(null);
  const mentionSearchRequestIdRef = useRef(0);
  const mentionUserCacheRef = useRef(new Map());
  const selectedMentionMapRef = useRef(new Map());
  const committedMentionRangeRef = useRef(null);
  const selectionRef = useRef(null);
  const mentionSelectionInProgressRef = useRef(false);
  const composerPressInRef = useRef(false);
  const rawCommentsRef = useRef([]);
  const lastIdRef = useRef(null);
  const hasMoreRef = useRef(false);

  const [loading, setLoading] = useState(true);
  const [comments, setComments] = useState([]);
  const [commentText, setCommentText] = useState("");
  const [selectedMentionUsers, setSelectedMentionUsers] = useState([]);
  const [mentionSuggestions, setMentionSuggestions] = useState([]);
  const [showMentionSuggestions, setShowMentionSuggestions] = useState(false);
  const [mentionReady, setMentionReady] = useState(false);
  const [mentionTriggerIndex, setMentionTriggerIndex] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [replyTarget, setReplyTarget] = useState(null);
  const [replyPanelsByCommentId, setReplyPanelsByCommentId] = useState({});
  const [highlightedCommentId, setHighlightedCommentId] = useState(null);
  const [highlightedReplyId, setHighlightedReplyId] = useState(null);
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  const [commentListScrollOffset, setCommentListScrollOffset] = useState(0);
  const [commentListContentHeight, setCommentListContentHeight] = useState(0);
  const [commentListLayoutHeight, setCommentListLayoutHeight] = useState(0);
  const [actionsSheetVisible, setActionsSheetVisible] = useState(false);
  const [actionTarget, setActionTarget] = useState(null);
  const [isDeletingTarget, setIsDeletingTarget] = useState(false);
  const enableSwipeToClose = Platform.OS === "ios";

  const videoCommentId = item?.uri?.replace("/videos/", "") || item?.videoId || item?.videoID || item?.$id;
  const videoDocId = item?.$id;
  const videoOwner = item?.uploader || item?.videoOwner || null;

  const hydrateThreadedComments = useCallback(async (nextRawComments = []) => {
    if (!Array.isArray(nextRawComments) || nextRawComments.length === 0) {
      return [];
    }

    const parentCommentIds = nextRawComments.map((comment) => comment?.$id).filter(Boolean);
    const [repliesResult, likesResult] = await Promise.all([
      fetchVideoCommentRepliesByParentIds({ parentCommentIds, limit: 500 }),
      fetchVideoCommentLikesByCommentIds({ commentIds: parentCommentIds, limit: 1000 }),
    ]);
    const threadedComments = threadVideoComments(nextRawComments, repliesResult?.byParentId || {});

    return threadedComments.map((comment) => ({
      ...comment,
      videoCommentLikes: likesResult?.byCommentId?.[comment?.$id] || getCommentLikes(comment),
    }));
  }, []);

  const syncSelectedMentionUsers = useCallback(() => {
    const uniqueUsers = Array.from(
      new Map(Array.from(selectedMentionMapRef.current.values()).map((mentionUser) => [String(mentionUser.$id), mentionUser])).values(),
    );
    setSelectedMentionUsers(uniqueUsers);
  }, []);

  const clearMentionSuggestions = useCallback(() => {
    mentionSearchRequestIdRef.current += 1;
    setShowMentionSuggestions(false);
    setMentionSuggestions([]);
    setMentionTriggerIndex(null);
    setMentionReady(false);
  }, []);

  const setRawCommentsState = useCallback((value) => {
    const nextValue = typeof value === "function" ? value(rawCommentsRef.current) : value;
    rawCommentsRef.current = Array.isArray(nextValue) ? nextValue : [];
  }, []);

  const setLastIdState = useCallback((value) => {
    const nextValue = typeof value === "function" ? value(lastIdRef.current) : value;
    lastIdRef.current = nextValue || null;
  }, []);

  const setHasMoreState = useCallback((value) => {
    const nextValue = typeof value === "function" ? value(hasMoreRef.current) : value;
    hasMoreRef.current = Boolean(nextValue);
  }, []);

  const cacheMentionUsers = useCallback((users = []) => {
    users.forEach((candidate) => {
      const usernameToken = normalizeMentionToken(candidate?.username);
      if (usernameToken && candidate?.$id) {
        mentionUserCacheRef.current.set(usernameToken, candidate);
      }
    });
  }, []);

  const normalizeMentionUsernames = useCallback((text) => extractMentionUsernames(text), []);

  const resolveMentionedUsers = useCallback(
    async (usernames) => {
      const resolvedUsersMap = new Map();
      const normalizedUsernames = Array.from(new Set((usernames || []).map((username) => normalizeMentionToken(username)).filter(Boolean)));

      await Promise.all(
        normalizedUsernames.map(async (username) => {
          const cached = mentionUserCacheRef.current.get(username);
          if (cached?.$id) {
            resolvedUsersMap.set(cached.$id, cached);
            return;
          }

          try {
            const userDocs = await fetchUsersByQuery([Query.contains("username", username), Query.limit(20)]);
            const candidates = userDocs?.documents || [];
            const exactUsername = candidates.find((candidate) => normalizeMentionToken(candidate?.username) === username);

            if (exactUsername?.$id) {
              resolvedUsersMap.set(exactUsername.$id, exactUsername);
            }
          } catch (error) {
            console.log("resolveMentionedUsers: error", error);
          }
        }),
      );

      const resolvedUsers = Array.from(resolvedUsersMap.values());
      cacheMentionUsers(resolvedUsers);
      return resolvedUsers;
    },
    [cacheMentionUsers],
  );

  const closeModalForNavigation = useCallback(() => {
    Keyboard.dismiss();
    clearMentionSuggestions();
    setIsComposerFocused(false);
    setActionsSheetVisible(false);
    setActionTarget(null);
    onClose?.();
  }, [clearMentionSuggestions, onClose]);

  const openMentionProfile = useCallback(
    (targetUserId) => {
      if (!targetUserId) return;
      closeModalForNavigation();

      if (String(targetUserId) === String(user?.$id)) {
        router.push("/profile");
        return;
      }

      router.push({
        pathname: "/creator-profile",
        params: {
          userId: targetUserId,
        },
      });
    },
    [closeModalForNavigation, user?.$id],
  );

  const handleMentionPress = useCallback(
    async (username, targetUserId = null) => {
      try {
        if (targetUserId) {
          openMentionProfile(targetUserId);
          return;
        }

        const normalizedUsername = normalizeMentionToken(username);
        if (!normalizedUsername) return;
        let mentionedUser = mentionUserCacheRef.current.get(normalizedUsername);
        if (!mentionedUser?.$id) {
          const resolvedUsers = await resolveMentionedUsers([normalizedUsername]);
          mentionedUser = resolvedUsers.find((candidate) => normalizeMentionToken(candidate?.username) === normalizedUsername) || resolvedUsers[0];
        }
        if (!mentionedUser?.$id) return;

        openMentionProfile(mentionedUser.$id);
      } catch (error) {
        console.log("handleMentionPress: error", error);
      }
    },
    [openMentionProfile, resolveMentionedUsers],
  );

  const handleOpenExternalUrl = useCallback(async (url) => {
    const targetUrl = normalizeExternalUrl(url);
    if (!targetUrl) return;

    try {
      await Linking.openURL(targetUrl);
    } catch (error) {
      console.log("handleOpenExternalUrl: error", error);
    }
  }, []);

  const renderMentionText = useCallback(
    (value, className, mentionClassName, colors = {}) => {
      return (
        <UserMention
          variant="text"
          value={value}
          className={className}
          mentionClassName={mentionClassName}
          textStyle={colors?.color ? { color: colors.color } : undefined}
          mentionStyle={colors?.mentionColor ? { color: colors.mentionColor } : undefined}
          onMentionPress={handleMentionPress}
          onUrlPress={handleOpenExternalUrl}
        />
      );
    },
    [handleMentionPress, handleOpenExternalUrl],
  );

  const renderComposerMentionText = useMemo(() => {
    if (!commentText) return null;

    return (
      <UserMention
        variant="text"
        value={commentText}
        className="font-sans text-sm leading-5"
        mentionClassName="font-sans font-semibold"
        selectedMentionUsers={selectedMentionUsers}
        textStyle={{ color: theme.inputText }}
        mentionStyle={{ color: theme.accentBlue }}
        onMentionPress={(_username, userId) => {
          if (userId) openMentionProfile(userId);
        }}
      />
    );
  }, [commentText, openMentionProfile, selectedMentionUsers, theme.accentBlue, theme.inputText]);

  const getActiveMention = useCallback((text, cursorPos) => {
    const cursor = Math.max(0, Math.min(text.length, cursorPos));
    const beforeCursor = text.slice(0, cursor);
    const lastAt = beforeCursor.lastIndexOf("@");

    if (lastAt === -1) return null;
    if (lastAt > 0 && !/\s/.test(beforeCursor[lastAt - 1])) return null;

    const rawQuery = beforeCursor.slice(lastAt + 1);
    if (rawQuery.includes("\n")) return null;
    if (/[^a-zA-Z0-9._\-\s]/.test(rawQuery)) return null;
    const query = rawQuery.replace(/\s+/g, " ").trimStart();
    if (query.split(" ").filter(Boolean).length > 2) return null;

    return { start: lastAt, query };
  }, []);

  const findMentionSuggestions = useCallback(
    async (query, requestId) => {
      try {
        const normalizedQuery = String(query || "")
          .replace(/\s+/g, " ")
          .trim();
        const normalizedUsernameQuery = normalizeMentionSearchQuery(normalizedQuery);
        const mentionSearchTerms = buildMentionSearchTerms(normalizedQuery);
        const fetchByUsername = async (usernameQuery) =>
          fetchUsersByQuery([Query.contains("username", usernameQuery), Query.limit(20), Query.orderDesc("$createdAt")]);
        const fetchByName = async (nameQuery) =>
          fetchUsersByQuery([Query.contains("name", nameQuery), Query.limit(20), Query.orderDesc("$createdAt")]);

        let users = [];

        if (!normalizedUsernameQuery) {
          const result = await fetchUsersByQuery([Query.limit(20), Query.orderDesc("$createdAt")]);
          users = rankMentionCandidatesByUsername(result?.documents || [], "", user?.$id);
        } else {
          const candidates = [];
          const searchResults = await Promise.all(
            mentionSearchTerms.flatMap((searchTerm) => [fetchByUsername(searchTerm).catch(() => null), fetchByName(searchTerm).catch(() => null)]),
          );

          searchResults.forEach((result) => {
            candidates.push(...(result?.documents || []));
          });

          Array.from(mentionUserCacheRef.current.values()).forEach((candidate) => {
            candidates.push(candidate);
          });

          users = rankMentionCandidatesByUsername(candidates, normalizedUsernameQuery, user?.$id);
        }

        if (requestId !== mentionSearchRequestIdRef.current) return;
        cacheMentionUsers(users);
        setMentionSuggestions(users.slice(0, 20));
        setShowMentionSuggestions(Boolean(users.length) || !normalizedUsernameQuery);
        setMentionReady(true);
      } catch (error) {
        if (requestId !== mentionSearchRequestIdRef.current) return;
        console.log("findMentionSuggestions: error", error);
        setMentionSuggestions([]);
        setShowMentionSuggestions(false);
        setMentionReady(false);
      }
    },
    [cacheMentionUsers, user?.$id],
  );

  const handleSelectionChange = useCallback(
    ({ nativeEvent: { selection } }) => {
      if (!selection) return;
      selectionRef.current = selection;

      if (!composerPressInRef.current) return;
      composerPressInRef.current = false;
      if (selection.start !== selection.end) return;

      const selectedMention = findComposerMentionAtPosition(commentText, selectedMentionUsers, selection.start);
      if (!selectedMention?.userId) return;

      inputRef.current?.blur?.();
      openMentionProfile(selectedMention.userId);
    },
    [commentText, openMentionProfile, selectedMentionUsers],
  );

  const handleComposerPressIn = useCallback(() => {
    composerPressInRef.current = true;
    requestAnimationFrame(() => {
      if (!composerPressInRef.current) return;
      composerPressInRef.current = false;

      const selection = selectionRef.current;
      if (!selection || selection.start !== selection.end) return;

      const selectedMention = findComposerMentionAtPosition(commentText, selectedMentionUsers, selection.start);
      if (!selectedMention?.userId) return;

      inputRef.current?.blur?.();
      openMentionProfile(selectedMention.userId);
    });
  }, [commentText, openMentionProfile, selectedMentionUsers]);

  const handleCommentTextChange = useCallback(
    (text) => {
      setCommentText(text);
      let hasRemovedMention = false;
      selectedMentionMapRef.current.forEach((mentionedUser, username) => {
        const mentionLabel = sanitizeMentionLabel(mentionedUser?.username || mentionedUser?.name || "");
        if (!mentionLabel) {
          selectedMentionMapRef.current.delete(username);
          hasRemovedMention = true;
          return;
        }
        if (!hasMentionLabelInText(text, mentionLabel)) {
          selectedMentionMapRef.current.delete(username);
          hasRemovedMention = true;
        }
      });
      if (hasRemovedMention) {
        syncSelectedMentionUsers();
      }

      const cursor = typeof selectionRef.current?.start === "number" ? Math.max(0, Math.min(text.length, selectionRef.current.start)) : text.length;
      const activeMention = getActiveMention(text, cursor);

      if (mentionTimerRef.current) {
        clearTimeout(mentionTimerRef.current);
        mentionTimerRef.current = null;
      }

      const committedMentionRange = committedMentionRangeRef.current;
      if (committedMentionRange) {
        const committedSlice = text.slice(committedMentionRange.start, committedMentionRange.end);
        if (committedSlice !== committedMentionRange.token) {
          committedMentionRangeRef.current = null;
        } else if (activeMention && activeMention.start === committedMentionRange.start && cursor > committedMentionRange.end) {
          const trailingText = text.slice(committedMentionRange.end, cursor);
          if (!trailingText.includes("@")) {
            clearMentionSuggestions();
            return;
          }
        }
      }

      if (!activeMention) {
        clearMentionSuggestions();
        return;
      }

      setMentionTriggerIndex(activeMention.start);
      setShowMentionSuggestions(true);
      setMentionReady(false);
      const requestId = mentionSearchRequestIdRef.current + 1;
      mentionSearchRequestIdRef.current = requestId;

      mentionTimerRef.current = setTimeout(() => {
        findMentionSuggestions(activeMention.query, requestId);
      }, MENTION_SEARCH_DEBOUNCE_MS);
    },
    [clearMentionSuggestions, findMentionSuggestions, getActiveMention, syncSelectedMentionUsers],
  );

  const handleMentionSelect = useCallback(
    (selectedUser) => {
      mentionSelectionInProgressRef.current = false;
      if (!selectedUser?.username) return;

      const cursor = selectionRef.current?.start ?? commentText.length;
      const mentionStart = mentionTriggerIndex ?? getActiveMention(commentText, cursor)?.start ?? commentText.lastIndexOf("@");
      if (typeof mentionStart !== "number" || mentionStart < 0) return;
      const safeCursor = Math.max(mentionStart, Math.min(commentText.length, cursor));
      const prefix = commentText.slice(0, mentionStart);
      const suffix = commentText.slice(safeCursor);
      const mentionToken = normalizeMentionToken(selectedUser.username);
      const mentionLabel = sanitizeMentionLabel(selectedUser?.username || selectedUser?.name || "");
      const alreadySelected = mentionToken ? selectedMentionMapRef.current.has(mentionToken) : false;
      const alreadyMentionedInText = mentionLabel ? hasMentionLabelInText(commentText, mentionLabel) : false;
      const insertedText = alreadySelected && alreadyMentionedInText ? "" : `${selectedUser.username} `;
      const nextTextRaw = `${prefix}${insertedText}${suffix}`;
      const nextText = insertedText ? nextTextRaw : nextTextRaw.replace(/\s{2,}/g, " ");
      if (mentionToken) {
        selectedMentionMapRef.current.set(mentionToken, selectedUser);
        mentionUserCacheRef.current.set(mentionToken, selectedUser);
      }
      syncSelectedMentionUsers();
      committedMentionRangeRef.current = insertedText
        ? {
            start: prefix.length,
            end: prefix.length + insertedText.length,
            token: insertedText,
          }
        : null;
      const nextCursor = prefix.length + insertedText.length;
      selectionRef.current = {
        start: nextCursor,
        end: nextCursor,
      };
      setCommentText(nextText);
      clearMentionSuggestions();
      setTimeout(() => {
        inputRef.current?.focus();
      }, 0);
    },
    [clearMentionSuggestions, commentText, getActiveMention, mentionTriggerIndex, syncSelectedMentionUsers],
  );

  const fetchCommentsData = useCallback(
    async (loadMore = false) => {
      if (!videoCommentId) return;
      const currentLastId = lastIdRef.current;
      const currentHasMore = hasMoreRef.current;
      const currentRawComments = rawCommentsRef.current;
      if (loadMore && (!currentLastId || !currentHasMore)) return;

      try {
        if (!loadMore) setLoading(true);

        const commentsData = await fetchVideoComments({
          videoId: videoCommentId,
          lastId: loadMore ? currentLastId : undefined,
          limit: PAGE_SIZE,
        });

        const incomingDocs = commentsData?.documents || [];
        const mergedRawComments = loadMore
          ? [...currentRawComments, ...incomingDocs.filter((incoming) => !currentRawComments.some((existing) => existing?.$id === incoming?.$id))]
          : incomingDocs;
        const total = Number(commentsData?.total || 0);
        const threadedComments = await hydrateThreadedComments(mergedRawComments);

        setRawCommentsState(mergedRawComments);
        setComments(threadedComments);
        setLastIdState(incomingDocs.at(-1)?.$id || (loadMore ? currentLastId : null));
        setHasMoreState(total > mergedRawComments.length);

        if (videoDocId) {
          updateVideoStats(videoDocId, { commentsCount: total || mergedRawComments.length });
        }
      } catch (error) {
        console.log("fetchCommentsData: error", error);
      } finally {
        if (!loadMore) setLoading(false);
      }
    },
    [hydrateThreadedComments, setHasMoreState, setLastIdState, setRawCommentsState, updateVideoStats, videoCommentId, videoDocId],
  );

  useEffect(() => {
    if (!isVisible || !videoCommentId) return;
    fetchCommentsData(false);
  }, [fetchCommentsData, isVisible, videoCommentId]);

  useEffect(() => {
    if (isVisible) return;
    if (mentionTimerRef.current) {
      clearTimeout(mentionTimerRef.current);
      mentionTimerRef.current = null;
    }
    if (highlightTimeoutRef.current) {
      clearTimeout(highlightTimeoutRef.current);
      highlightTimeoutRef.current = null;
    }
    if (submittedReplyHighlightTimeoutRef.current) {
      clearTimeout(submittedReplyHighlightTimeoutRef.current);
      submittedReplyHighlightTimeoutRef.current = null;
    }

    setComments([]);
    setRawCommentsState([]);
    setCommentText("");
    setSelectedMentionUsers([]);
    setMentionSuggestions([]);
    setShowMentionSuggestions(false);
    setMentionReady(false);
    setMentionTriggerIndex(null);
    setReplyTarget(null);
    setReplyPanelsByCommentId({});
    setLoading(true);
    setLastIdState(null);
    setHasMoreState(false);
    setIsComposerFocused(false);
    setCommentListScrollOffset(0);
    setCommentListContentHeight(0);
    setCommentListLayoutHeight(0);
    setHighlightedCommentId(null);
    setHighlightedReplyId(null);
    setActionsSheetVisible(false);
    setActionTarget(null);
    setIsDeletingTarget(false);
    selectedMentionMapRef.current.clear();
    mentionUserCacheRef.current.clear();
    committedMentionRangeRef.current = null;
    selectionRef.current = null;
  }, [isVisible, setHasMoreState, setLastIdState, setRawCommentsState]);

  useEffect(() => {
    return () => {
      if (mentionTimerRef.current) {
        clearTimeout(mentionTimerRef.current);
      }
      if (highlightTimeoutRef.current) {
        clearTimeout(highlightTimeoutRef.current);
      }
      if (submittedReplyHighlightTimeoutRef.current) {
        clearTimeout(submittedReplyHighlightTimeoutRef.current);
      }
    };
  }, []);

  const toggleRepliesForComment = useCallback((commentId) => {
    const normalizedCommentId = String(commentId || "");
    if (!normalizedCommentId) return;

    setReplyPanelsByCommentId((prev) => {
      const currentPanel = prev[normalizedCommentId];
      const nextShowReplies = !Boolean(currentPanel?.showReplies);

      return {
        ...prev,
        [normalizedCommentId]: {
          showReplies: nextShowReplies,
          visibleCount: INITIAL_VISIBLE_REPLIES,
        },
      };
    });
  }, []);

  const viewMoreRepliesForComment = useCallback((commentId, totalReplies) => {
    const normalizedCommentId = String(commentId || "");
    if (!normalizedCommentId) return;

    setReplyPanelsByCommentId((prev) => {
      const currentPanel = prev[normalizedCommentId];
      const currentVisibleCount = Math.max(INITIAL_VISIBLE_REPLIES, Number(currentPanel?.visibleCount || INITIAL_VISIBLE_REPLIES));
      const nextVisibleCount = Math.min(currentVisibleCount + INITIAL_VISIBLE_REPLIES, Math.max(0, totalReplies || 0));

      return {
        ...prev,
        [normalizedCommentId]: {
          showReplies: true,
          visibleCount: Math.max(INITIAL_VISIBLE_REPLIES, nextVisibleCount),
        },
      };
    });
  }, []);

  const isOwnedByCurrentUser = useCallback(
    (owner) => {
      const ownerId = resolveOwnerId(owner);
      return Boolean(user?.$id && ownerId && String(ownerId) === String(user.$id));
    },
    [user?.$id],
  );

  const handleDeleteReply = useCallback(
    async (commentId, reply) => {
      const normalizedCommentId = String(commentId || "");
      const replyId = String(reply?.$id || "");
      if (!normalizedCommentId || !replyId || !isOwnedByCurrentUser(reply?.commentOwner)) return;

      try {
        await databases.deleteDocument(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.videosCommentRepliesCollectionId, replyId);

        setComments((prev) =>
          prev.map((commentItem) =>
            String(commentItem?.$id || "") === normalizedCommentId
              ? {
                  ...commentItem,
                  videoComments: getCommentReplies(commentItem).filter((existingReply) => String(existingReply?.$id || "") !== replyId),
                }
              : commentItem,
          ),
        );
      } catch (error) {
        console.log("handleDeleteReply: error", error);
      }
    },
    [isOwnedByCurrentUser],
  );

  const handleDeleteComment = useCallback(
    async (comment) => {
      const commentId = String(comment?.$id || "");
      if (!commentId || !isOwnedByCurrentUser(comment?.commentOwner)) return;

      try {
        const localReplies = getCommentReplies(comment).filter((reply) => reply?.$id);
        await Promise.all(
          localReplies.map((reply) =>
            databases
              .deleteDocument(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.videosCommentRepliesCollectionId, String(reply.$id))
              .catch((error) => {
                console.log("handleDeleteComment: local reply delete error", error);
              }),
          ),
        );

        try {
          const relationReplies = await databases.listDocuments(
            secrets.appwriteConfig.databaseId,
            secrets.appwriteConfig.videosCommentRepliesCollectionId,
            [Query.equal("videoComments", commentId), Query.limit(200)],
          );

          await Promise.all(
            (relationReplies?.documents || [])
              .filter((reply) => reply?.$id)
              .map((reply) =>
                databases
                  .deleteDocument(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.videosCommentRepliesCollectionId, String(reply.$id))
                  .catch((error) => {
                    console.log("handleDeleteComment: relation reply delete error", error);
                  }),
              ),
          );
        } catch (error) {
          console.log("handleDeleteComment: relation reply fetch error", error);
        }

        await databases.deleteDocument(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.videosCommentsCollectionId, commentId);

        setRawCommentsState((prev) => {
          const next = prev.filter((existingComment) => String(existingComment?.$id || "") !== commentId);
          const nextCount = Math.max(0, next.length);
          onCommentPosted?.(nextCount);
          if (videoDocId) {
            updateVideoStats(videoDocId, { commentsCount: nextCount });
          }
          return next;
        });

        setComments((prev) => prev.filter((existingComment) => String(existingComment?.$id || "") !== commentId));

        if (replyTarget?.id && String(replyTarget.id) === commentId) {
          setReplyTarget(null);
          setCommentText("");
        }
      } catch (error) {
        console.log("handleDeleteComment: error", error);
      }
    },
    [isOwnedByCurrentUser, onCommentPosted, replyTarget?.id, setRawCommentsState, updateVideoStats, videoDocId],
  );

  const openCommentActions = useCallback(
    (comment) => {
      if (!isOwnedByCurrentUser(comment?.commentOwner)) return;
      setActionTarget({ type: "comment", comment, commentId: String(comment?.$id || "") });
      setActionsSheetVisible(true);
    },
    [isOwnedByCurrentUser],
  );

  const openReplyActions = useCallback(
    (commentId, reply) => {
      if (!isOwnedByCurrentUser(reply?.commentOwner)) return;
      setActionTarget({ type: "reply", reply, commentId: String(commentId || "") });
      setActionsSheetVisible(true);
    },
    [isOwnedByCurrentUser],
  );

  const closeActionsSheet = useCallback(() => {
    if (isDeletingTarget) return;
    setActionsSheetVisible(false);
    setActionTarget(null);
  }, [isDeletingTarget]);

  const handleConfirmDeleteAction = useCallback(async () => {
    if (!actionTarget || isDeletingTarget) return;

    setIsDeletingTarget(true);
    try {
      if (actionTarget.type === "comment") {
        await handleDeleteComment(actionTarget.comment);
      } else if (actionTarget.type === "reply") {
        await handleDeleteReply(actionTarget.commentId, actionTarget.reply);
      }
      setActionsSheetVisible(false);
      setActionTarget(null);
    } finally {
      setIsDeletingTarget(false);
    }
  }, [actionTarget, handleDeleteComment, handleDeleteReply, isDeletingTarget]);

  const resolveRecipientForNotification = useCallback(
    async (recipient) => {
      if (!recipient) return null;
      if (typeof recipient === "object" && recipient?.$id) return recipient;

      const recipientId = resolveOwnerId(recipient);
      if (!recipientId) return null;
      if (user?.$id && String(recipientId) === String(user.$id)) return user;

      try {
        return await getUserByID({ ID: recipientId });
      } catch (error) {
        console.log("resolveRecipientForNotification: error", error);
        return null;
      }
    },
    [user],
  );

  const notifyCommentRecipients = useCallback(
    async ({ text, isReply, commentId, replyId, replyRecipient, selectedMentionedUsers = [] }) => {
      if (!user?.$id || !videoCommentId || !commentId) return;

      const resourceId = buildVideoNotificationResourceId({
        videoId: videoDocId || videoCommentId,
        commentId,
        ...(isReply && replyId ? { replyId } : {}),
      });

      const notifiedIds = new Set();
      const notificationType = isReply ? "video-reply" : "video-comment";

      try {
        if (isReply) {
          const resolvedRecipient = await resolveRecipientForNotification(replyRecipient);
          if (resolvedRecipient?.$id && String(resolvedRecipient.$id) !== String(user.$id)) {
            notifiedIds.add(String(resolvedRecipient.$id));
            await notificationService.notifyUser({
              sender: user,
              recipient: resolvedRecipient,
              type: "video-reply",
              resourceId,
              message: "replied to your comment",
            });
          }
        } else {
          const resolvedVideoOwner = await resolveRecipientForNotification(videoOwner);
          if (resolvedVideoOwner?.$id && String(resolvedVideoOwner.$id) !== String(user.$id)) {
            notifiedIds.add(String(resolvedVideoOwner.$id));
            await notificationService.notifyUser({
              sender: user,
              recipient: resolvedVideoOwner,
              type: "video-comment",
              resourceId,
              message: "commented on your video",
            });
          }
        }

        const mentionTargetsFromMarkup = extractMentionTargetsFromMarkup(text);
        const mentionUsersFromMarkup = await Promise.all(
          mentionTargetsFromMarkup.map(async ({ userId, label }) => {
            const resolvedMentionUser = await resolveRecipientForNotification(userId);
            if (!resolvedMentionUser?.$id) return null;
            return {
              ...resolvedMentionUser,
              ...(resolvedMentionUser?.username ? {} : { username: label }),
            };
          }),
        );
        const mentionedUsernames = normalizeMentionUsernames(text);
        const resolvedMentionedUsers = mentionedUsernames.length > 0 ? await resolveMentionedUsers(mentionedUsernames) : [];
        const mentionedUsersMap = new Map();
        [...(selectedMentionedUsers || []), ...mentionUsersFromMarkup, ...resolvedMentionedUsers].forEach((mentionedUser) => {
          if (!mentionedUser?.$id) return;
          mentionedUsersMap.set(String(mentionedUser.$id), mentionedUser);
        });
        const mentionedUsers = Array.from(mentionedUsersMap.values());
        cacheMentionUsers(mentionedUsers);

        await Promise.all(
          mentionedUsers.map((mentionedUser) => {
            const mentionedUserId = String(mentionedUser?.$id || "");
            if (!mentionedUserId || mentionedUserId === String(user.$id) || notifiedIds.has(mentionedUserId)) return null;

            notifiedIds.add(mentionedUserId);
            return notificationService.notifyUser({
              sender: user,
              recipient: mentionedUser,
              type: notificationType,
              resourceId,
              message: `${user?.username || "Someone"} mentioned you in a ${isReply ? "reply" : "comment"}`,
            });
          }),
        );
      } catch (error) {
        console.log("notifyCommentRecipients: error", error);
      }
    },
    [
      cacheMentionUsers,
      normalizeMentionUsernames,
      notificationService,
      resolveMentionedUsers,
      resolveRecipientForNotification,
      user,
      videoCommentId,
      videoDocId,
      videoOwner,
    ],
  );

  const highlightSubmittedReply = useCallback((commentId, replyId) => {
    const normalizedCommentId = String(commentId || "");
    const normalizedReplyId = String(replyId || "");
    if (!normalizedCommentId || !normalizedReplyId) return;

    setHighlightedCommentId(normalizedCommentId);
    setHighlightedReplyId(normalizedReplyId);

    if (submittedReplyHighlightTimeoutRef.current) {
      clearTimeout(submittedReplyHighlightTimeoutRef.current);
    }

    submittedReplyHighlightTimeoutRef.current = setTimeout(() => {
      setHighlightedCommentId(null);
      setHighlightedReplyId(null);
      submittedReplyHighlightTimeoutRef.current = null;
    }, SUBMITTED_REPLY_HIGHLIGHT_MS);
  }, []);

  const handleReplyPress = useCallback(
    (comment, mentionUser) => {
      if (!comment?.$id) return;
      setReplyTarget({
        id: comment.$id,
        username: comment?.commentOwner?.username,
        recipient: comment?.commentOwner,
      });
      committedMentionRangeRef.current = null;
      clearMentionSuggestions();

      // Reply-on-reply: prefill the composer with @username so the reply visually
      // addresses the original reply author, while threading to the top-level parent
      // (matches web's flat-thread model).
      if (mentionUser?.username) {
        setCommentText(`@${mentionUser.username} `);
      }

      setTimeout(() => {
        inputRef.current?.focus();
      }, 100);
    },
    [clearMentionSuggestions],
  );

  const handleCancelReply = useCallback(() => {
    setReplyTarget(null);
    setCommentText("");
    selectedMentionMapRef.current.clear();
    setSelectedMentionUsers([]);
    committedMentionRangeRef.current = null;
    clearMentionSuggestions();
  }, [clearMentionSuggestions]);

  const handleRequestClose = useCallback(() => {
    closeModalForNavigation();
  }, [closeModalForNavigation]);

  const handlePostComment = useCallback(async () => {
    if (!videoCommentId || !user?.$id || isSubmitting || !commentText.trim()) return;

    const trimmedComment = commentText.trim();
    const replyContext = replyTarget;
    const selectedMentionedUsersSnapshot = Array.from(selectedMentionMapRef.current.values()).filter((mentionedUser) => mentionedUser?.$id);
    const persistedCommentText = serializeMentionsForStorage(trimmedComment, selectedMentionedUsersSnapshot);
    setIsSubmitting(true);

    setCommentText("");
    selectedMentionMapRef.current.clear();
    setSelectedMentionUsers([]);
    committedMentionRangeRef.current = null;
    clearMentionSuggestions();
    if (replyContext) {
      setReplyTarget(null);
    }

    try {
      if (replyContext?.id) {
        const newReply = await createVideoReplyComment({
          videoId: videoCommentId,
          comment: persistedCommentText,
          commentOwner: user.$id,
          parentCommentId: replyContext.id,
        });

        setComments((prevComments) =>
          prevComments.map((existingComment) =>
            String(existingComment?.$id || "") === String(replyContext.id)
              ? {
                  ...existingComment,
                  videoComments: [...getCommentReplies(existingComment), newReply],
                }
              : existingComment,
          ),
        );
        setReplyPanelsByCommentId((prev) => {
          const normalizedCommentId = String(replyContext.id || "");
          const currentPanel = prev[normalizedCommentId];
          const currentVisibleCount = Math.max(INITIAL_VISIBLE_REPLIES, Number(currentPanel?.visibleCount || INITIAL_VISIBLE_REPLIES));
          return {
            ...prev,
            [normalizedCommentId]: {
              showReplies: true,
              visibleCount: currentVisibleCount + 1,
            },
          };
        });
        highlightSubmittedReply(replyContext.id, newReply?.$id);
        void notifyCommentRecipients({
          text: persistedCommentText,
          isReply: true,
          commentId: replyContext.id,
          replyId: newReply?.$id,
          replyRecipient: replyContext.recipient,
          selectedMentionedUsers: selectedMentionedUsersSnapshot,
        });
      } else {
        const newComment = await createVideoComment({
          videoId: videoCommentId,
          comment: persistedCommentText,
          commentOwner: user.$id,
        });
        const hydratedComment = {
          ...newComment,
          videoComments: Array.isArray(newComment?.videoComments) ? newComment.videoComments : [],
          videoCommentLikes: getCommentLikes(newComment),
        };

        const nextRawComments = [hydratedComment, ...rawCommentsRef.current];
        setRawCommentsState(nextRawComments);
        setComments((prevComments) => [hydratedComment, ...prevComments]);

        const nextCount = Math.max(0, nextRawComments.length);
        onCommentPosted?.(nextCount);
        if (videoDocId) {
          updateVideoStats(videoDocId, { commentsCount: nextCount });
        }

        void notifyCommentRecipients({
          text: persistedCommentText,
          isReply: false,
          commentId: newComment?.$id,
          selectedMentionedUsers: selectedMentionedUsersSnapshot,
        });

        requestAnimationFrame(() => {
          listRef.current?.scrollToOffset?.({ offset: 0, animated: true });
        });
      }
    } catch (error) {
      if (replyContext) setReplyTarget(replyContext);
      setCommentText(trimmedComment);
      console.log("handlePostComment: error", error);
    } finally {
      setIsSubmitting(false);
    }
  }, [
    clearMentionSuggestions,
    commentText,
    highlightSubmittedReply,
    isSubmitting,
    notifyCommentRecipients,
    onCommentPosted,
    replyTarget,
    setRawCommentsState,
    updateVideoStats,
    user?.$id,
    videoCommentId,
    videoDocId,
  ]);

  useEffect(() => {
    if (highlightTimeoutRef.current) {
      clearTimeout(highlightTimeoutRef.current);
      highlightTimeoutRef.current = null;
    }

    if (!highlightedCommentId && !highlightedReplyId) return;

    highlightTimeoutRef.current = setTimeout(() => {
      if (submittedReplyHighlightTimeoutRef.current) return;
      setHighlightedCommentId(null);
      setHighlightedReplyId(null);
      highlightTimeoutRef.current = null;
    }, 3000);

    return () => {
      if (highlightTimeoutRef.current) {
        clearTimeout(highlightTimeoutRef.current);
        highlightTimeoutRef.current = null;
      }
    };
  }, [highlightedCommentId, highlightedReplyId]);

  const handleCommentListScroll = useCallback(
    (event) => {
      if (!enableSwipeToClose) return;
      setCommentListScrollOffset(Math.max(0, Number(event?.nativeEvent?.contentOffset?.y || 0)));
    },
    [enableSwipeToClose],
  );

  const handleCommentListLayout = useCallback(
    (event) => {
      if (!enableSwipeToClose) return;
      setCommentListLayoutHeight(Math.max(0, Number(event?.nativeEvent?.layout?.height || 0)));
    },
    [enableSwipeToClose],
  );

  const handleCommentListContentSizeChange = useCallback(
    (_width, height) => {
      if (!enableSwipeToClose) return;
      setCommentListContentHeight(Math.max(0, Number(height || 0)));
    },
    [enableSwipeToClose],
  );

  const renderCommentItem = useCallback(
    ({ item: commentItem }) => {
      const commentId = String(commentItem?.$id || "");
      const panelState = replyPanelsByCommentId[commentId] || {};
      const showReplies = Boolean(panelState?.showReplies);
      const visibleCount = Math.max(INITIAL_VISIBLE_REPLIES, Number(panelState?.visibleCount || INITIAL_VISIBLE_REPLIES));
      const totalReplies = getCommentReplies(commentItem).length;

      return (
        <VideoCommentItem
          item={commentItem}
          onReplyPress={handleReplyPress}
          onProfilePress={openMentionProfile}
          currentUserId={user?.$id}
          highlightedCommentId={highlightedCommentId}
          highlightedReplyId={highlightedReplyId}
          showReplies={showReplies}
          visibleCount={visibleCount}
          onToggleReplies={() => toggleRepliesForComment(commentId)}
          onViewMoreReplies={() => viewMoreRepliesForComment(commentId, totalReplies)}
          onCommentActionsPress={openCommentActions}
          onReplyActionsPress={openReplyActions}
          renderMentionText={renderMentionText}
        />
      );
    },
    [
      handleReplyPress,
      highlightedCommentId,
      highlightedReplyId,
      openCommentActions,
      openMentionProfile,
      openReplyActions,
      renderMentionText,
      replyPanelsByCommentId,
      toggleRepliesForComment,
      user?.$id,
      viewMoreRepliesForComment,
    ],
  );

  const commentListScrollOffsetMax = Math.max(0, commentListContentHeight - commentListLayoutHeight);
  const commentListContentContainerStyle =
    comments.length > 0 ? { paddingHorizontal: 16, paddingBottom: 12 } : { paddingHorizontal: 16, paddingBottom: 12, flexGrow: 1 };

  return (
    <>
      <Modal
        isVisible={isVisible}
        onBackdropPress={handleRequestClose}
        onBackButtonPress={handleRequestClose}
        swipeDirection={enableSwipeToClose ? "down" : null}
        onSwipeComplete={enableSwipeToClose ? handleRequestClose : undefined}
        swipeThreshold={32}
        style={{ justifyContent: "flex-end", margin: 0 }}
        backdropOpacity={0.3}
        propagateSwipe={enableSwipeToClose}
        scrollTo={
          enableSwipeToClose
            ? (params) => {
                listRef.current?.scrollToOffset?.({
                  offset: Math.max(0, Number(params?.y || 0)),
                  animated: false,
                });
              }
            : undefined
        }
        scrollOffset={enableSwipeToClose ? commentListScrollOffset : undefined}
        scrollOffsetMax={enableSwipeToClose ? commentListScrollOffsetMax : undefined}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={{
            minHeight: SCREEN_HEIGHT * 0.6,
            maxHeight: SCREEN_HEIGHT * 0.78,
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            borderTopWidth: 1,
            borderTopColor: theme.border,
            paddingBottom: insets.bottom + 16,
            backgroundColor: theme.surfaceElevated,
          }}
        >
          <View className="px-4 pb-2 pt-2">
            <View className="items-center">
              <View className="h-1.5 w-20 rounded-full" style={{ backgroundColor: theme.handle }} />
            </View>
            <View className="mt-2 flex-row items-center justify-between">
              <Text className="font-sans text-sm font-semibold" style={{ color: theme.text }}>
                Comments
              </Text>
              <TouchableOpacity
                onPress={handleRequestClose}
                hitSlop={{
                  top: 10,
                  bottom: 10,
                  left: 10,
                  right: 10,
                }}
              >
                <Text className="font-sans text-sm font-semibold" style={{ color: theme.textMuted }}>
                  Close
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          {loading ? (
            <View className="flex-1 items-center justify-center">
              <LoaderKit style={{ width: 40, height: 40, opacity: 0.5 }} name={"LineScale"} color={theme.primary} />
            </View>
          ) : (
            <FlatList
              ref={listRef}
              data={comments}
              keyExtractor={(commentItem) => commentItem?.$id || commentItem?.id || `${commentItem?.comment}-${commentItem?.$createdAt}`}
              style={{ flex: 1 }}
              contentContainerStyle={commentListContentContainerStyle}
              showsVerticalScrollIndicator={false}
              renderItem={renderCommentItem}
              // Virtualization tuning — see PostCommentModal for rationale.
              initialNumToRender={8}
              maxToRenderPerBatch={6}
              windowSize={10}
              updateCellsBatchingPeriod={50}
              removeClippedSubviews={Platform.OS !== "android"}
              nestedScrollEnabled
              keyboardShouldPersistTaps="handled"
              onLayout={enableSwipeToClose ? handleCommentListLayout : undefined}
              onContentSizeChange={enableSwipeToClose ? handleCommentListContentSizeChange : undefined}
              onScroll={enableSwipeToClose ? handleCommentListScroll : undefined}
              scrollEventThrottle={enableSwipeToClose ? 16 : undefined}
              onEndReached={() => fetchCommentsData(true)}
              onScrollBeginDrag={() => {
                setIsComposerFocused(false);
                clearMentionSuggestions();
              }}
              ListEmptyComponent={
                <View className="flex flex-1 items-center justify-center">
                  <Text className="font-sans text-sm font-medium" style={{ color: theme.textSoft }}>
                    No Comments Available
                  </Text>
                </View>
              }
            />
          )}

          {showMentionSuggestions && isComposerFocused ? (
            <UserMention
              variant="suggestions"
              suggestions={mentionSuggestions}
              selectedUserIds={selectedMentionUsers.map((selectedUser) => String(selectedUser?.$id || "")).filter(Boolean)}
              ready={mentionReady}
              onSelect={handleMentionSelect}
              onSelectStart={() => {
                mentionSelectionInProgressRef.current = true;
              }}
              containerClassName="max-h-44 border-t"
              containerStyle={{ borderTopColor: theme.border, backgroundColor: theme.surfaceElevated }}
            />
          ) : null}

          {replyTarget ? (
            <View
              className="mx-4 mb-2 flex-row items-center justify-between rounded-lg border px-4 py-2"
              style={{ borderColor: theme.primary, backgroundColor: theme.primarySoft }}
            >
              <Text className="text-xs" style={{ color: theme.textMuted }}>
                Replying to {replyTarget.username || "user"}
              </Text>
              <TouchableOpacity onPress={handleCancelReply}>
                <Text className="text-xs font-semibold" style={{ color: theme.primary }}>
                  Cancel
                </Text>
              </TouchableOpacity>
            </View>
          ) : null}

          <View
            className="flex-row items-center border-t px-4 py-3"
            style={{ paddingBottom: insets.bottom, borderTopColor: theme.border, backgroundColor: theme.surfaceElevated }}
          >
            <View className="relative flex-1">
              <TextInput
                ref={inputRef}
                onPressIn={handleComposerPressIn}
                onChangeText={handleCommentTextChange}
                onSelectionChange={handleSelectionChange}
                onFocus={() => {
                  setIsComposerFocused(true);
                }}
                onBlur={() => {
                  setTimeout(() => {
                    if (inputRef.current?.isFocused?.()) return;
                    if (mentionSelectionInProgressRef.current) {
                      mentionSelectionInProgressRef.current = false;
                      return;
                    }
                    setIsComposerFocused(false);
                    clearMentionSuggestions();
                  }, 40);
                }}
                textAlignVertical="top"
                placeholder={replyTarget ? "Write a reply..." : "Add a comment..."}
                placeholderTextColor={theme.placeholder}
                selectionColor={theme.primary}
                className="font-sans text-sm leading-5"
                maxLength={300}
                autoCapitalize="sentences"
                multiline
                style={{ maxHeight: 100, color: theme.inputText }}
              >
                {renderComposerMentionText}
              </TextInput>
            </View>
            <TouchableOpacity onPress={handlePostComment} disabled={isSubmitting} className="ml-4">
              <Text className="font-semibold" style={{ color: isSubmitting ? theme.textSoft : theme.primary }}>
                Post
              </Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        isVisible={isVisible && actionsSheetVisible}
        onBackdropPress={closeActionsSheet}
        onBackButtonPress={closeActionsSheet}
        backdropOpacity={0.6}
        useNativeDriver
      >
        <View className="rounded-2xl px-5 py-5" style={{ backgroundColor: theme.surfaceElevated, borderWidth: 1, borderColor: theme.border }}>
          <Text className="text-lg font-semibold" style={{ color: theme.text }}>
            {actionTarget?.type === "reply" ? "Reply actions" : "Comment actions"}
          </Text>

          <TouchableOpacity
            className={`mt-4 rounded-xl px-4 py-3 ${isDeletingTarget ? "opacity-60" : ""}`}
            style={{ backgroundColor: theme.cardStrong }}
            onPress={handleConfirmDeleteAction}
            disabled={isDeletingTarget}
          >
            <View className="flex flex-row items-center justify-between">
              <View className="flex flex-row items-center">
                <MaterialIcons name="delete-outline" size={22} color={theme.danger} style={{ marginRight: 12 }} />
                <View>
                  <Text className="text-base font-semibold" style={{ color: theme.text }}>
                    Delete
                  </Text>
                  <Text className="mt-1 text-xs" style={{ color: theme.textMuted }}>
                    {actionTarget?.type === "reply" ? "Remove this reply" : "Remove this comment"}
                  </Text>
                </View>
              </View>
              {isDeletingTarget ? (
                <LoaderKit style={{ width: 16, height: 16, opacity: 0.9 }} name={"BallSpinFadeLoader"} color={theme.primary} />
              ) : null}
            </View>
          </TouchableOpacity>

          <TouchableOpacity className="mt-3 items-center" onPress={closeActionsSheet} disabled={isDeletingTarget}>
            <Text className="text-sm" style={{ color: theme.textMuted }}>
              Cancel
            </Text>
          </TouchableOpacity>
        </View>
      </Modal>
    </>
  );
};

export default memo(VideoCommentModal);
