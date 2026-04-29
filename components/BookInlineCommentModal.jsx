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
import LoaderKit from "react-native-loader-kit";
import Modal from "react-native-modal";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import { BookInlineCommentsService, buildInlineCommentNotificationResourceId, INLINE_COMMENT_NOTIFICATION_TYPE } from "../lib/book-inline-comments";
import { NotificationService } from "../lib/notifications";
import TimeAgo from "../lib/time-ago";
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
import AnimatedSkeleton from "./AnimatedSkeleton";
import UserMention from "./UserMention";

const SCREEN_HEIGHT = Dimensions.get("window").height;
const LIMIT = 20;
const INITIAL_VISIBLE_REPLIES = 3;
const INLINE_COMMENT_SKELETON_ITEMS = ["inline-comment-skeleton-1", "inline-comment-skeleton-2", "inline-comment-skeleton-3"];
const getInlineCommentLikes = (comment) =>
  Array.isArray(comment?.booksChapterInlineCommentLikes)
    ? comment.booksChapterInlineCommentLikes
    : comment?.booksChapterInlineCommentLikes?.documents || [];
const getInlineCommentReplies = (comment) =>
  Array.isArray(comment?.booksChapterInlineCommentReplies)
    ? comment.booksChapterInlineCommentReplies
    : comment?.booksChapterInlineCommentReplies?.documents || [];
const getInlineCommentOwnerId = (owner) => {
  if (!owner) return "";
  if (typeof owner === "string") return owner;
  return owner?.$id || "";
};

const BookInlineCommentItem = memo(
  ({ item, userId, onProfilePress, onReplyPress, onMentionPress, onUrlPress, onCommentActionsPress, onReplyActionsPress, palette }) => {
    const [showReplies, setShowReplies] = useState(false);
    const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_REPLIES);
    const isPending = Boolean(item?.isPending);
    const likes = getInlineCommentLikes(item);
    const replies = getInlineCommentReplies(item);
    const features = item?.__features || BookInlineCommentsService.getFeatureFlags();
    const initialLiked = likes.some((like) => {
      const likeOwner = like?.likeOwner;
      if (!likeOwner || !userId) return false;
      if (typeof likeOwner === "string") return String(likeOwner) === String(userId);
      return String(likeOwner?.$id || "") === String(userId);
    });
    const initialLikeCount = Number.isFinite(item?.likeCount) ? item.likeCount : likes.length;
    const likesSignature = `${likes
      .map((like) => String(like?.$id || like?.likeOwner?.$id || like?.likeOwner || ""))
      .sort()
      .join("|")}:${initialLikeCount}`;
    const [liked, setLiked] = useState(initialLiked);
    const [likeCount, setLikeCount] = useState(initialLikeCount);
    const replyCount = Number.isFinite(item?.replyCount) ? item.replyCount : replies.length;
    const visibleReplies = showReplies ? replies.slice(0, visibleCount) : [];
    const committedLikedRef = useRef(initialLiked);
    const committedCountRef = useRef(initialLikeCount);
    const desiredLikedRef = useRef(initialLiked);
    const syncInFlightRef = useRef(false);
    const isMountedRef = useRef(true);
    const appliedLikesSignatureRef = useRef(likesSignature);
    const canLike = Boolean(features.likesEnabled && !isPending && userId && item?.$id);
    const canReply = Boolean(features.repliesEnabled && !isPending && userId && item?.$id);
    const isOwnComment = Boolean(!isPending && userId && item?.$id && String(getInlineCommentOwnerId(item?.commentOwner)) === String(userId));

    const applyOptimisticLikeState = useCallback((nextLiked, baseLiked = committedLikedRef.current, baseCount = committedCountRef.current) => {
      const delta = nextLiked === baseLiked ? 0 : nextLiked ? 1 : -1;
      const nextCount = Math.max(0, baseCount + delta);

      setLiked(nextLiked);
      setLikeCount(nextCount);
    }, []);

    useEffect(() => {
      if (likesSignature === appliedLikesSignatureRef.current) return;

      appliedLikesSignatureRef.current = likesSignature;
      const nextLiked = likes.some((like) => {
        const likeOwner = like?.likeOwner;
        if (!likeOwner || !userId) return false;
        if (typeof likeOwner === "string") return String(likeOwner) === String(userId);
        return String(likeOwner?.$id || "") === String(userId);
      });
      const nextCount = Number.isFinite(item?.likeCount) ? item.likeCount : likes.length;
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
    }, [applyOptimisticLikeState, item?.likeCount, likes, likesSignature, userId]);

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

    const syncLikeMutation = useCallback(() => {
      if (syncInFlightRef.current || !canLike) return;

      syncInFlightRef.current = true;

      InteractionManager.runAfterInteractions(() => {
        const runSync = async () => {
          try {
            while (desiredLikedRef.current !== committedLikedRef.current) {
              const nextTargetLiked = desiredLikedRef.current;
              const previousCommittedLiked = committedLikedRef.current;

              if (nextTargetLiked) {
                await BookInlineCommentsService.likeComment({
                  userId,
                  commentId: item.$id,
                });
              } else {
                await BookInlineCommentsService.removeLikeComment({
                  userId,
                  commentId: item.$id,
                });
              }

              committedLikedRef.current = nextTargetLiked;
              if (nextTargetLiked !== previousCommittedLiked) {
                committedCountRef.current = Math.max(0, committedCountRef.current + (nextTargetLiked ? 1 : -1));
              }
            }
          } catch (error) {
            console.warn("handleInlineLikeComment error:", error?.message || error);
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
    }, [applyOptimisticLikeState, canLike, item?.$id, userId]);

    const handleLikeComment = useCallback(() => {
      if (!canLike) return;

      const nextDesiredLiked = !desiredLikedRef.current;
      desiredLikedRef.current = nextDesiredLiked;
      applyOptimisticLikeState(nextDesiredLiked);
      syncLikeMutation();
    }, [applyOptimisticLikeState, canLike, syncLikeMutation]);

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
      setVisibleCount((previousVisibleCount) => Math.min(previousVisibleCount + INITIAL_VISIBLE_REPLIES, replies.length));
    };
    const commentTextClassName = "mt-1 font-sans text-sm leading-5";
    const replyTextClassName = "mt-0.5 font-sans text-xs leading-5";
    const mentionClassName = "font-sans font-semibold";

    return (
      <View className="mb-4">
        <View className="flex-row items-start space-x-2">
          <TouchableOpacity onPress={() => onProfilePress?.(item)}>
            <FastImage
              source={{ uri: item?.commentOwner?.avatar || "" }}
              className="h-10 w-10 rounded-full"
              style={{ backgroundColor: palette.avatar }}
            />
          </TouchableOpacity>

          <View className="flex-1 flex-row items-start">
            <View className="flex-1">
              <View
                className="relative rounded-[8px] px-3 py-2 pr-9"
                style={{
                  backgroundColor: isPending ? palette.pendingBubble : palette.bubble,
                }}
              >
                <TouchableOpacity onPress={() => onProfilePress?.(item)}>
                  <Text className="font-sans text-sm font-semibold" style={{ color: palette.ownerText }}>
                    {item?.commentOwner?.username || "Deleted User"}
                  </Text>
                </TouchableOpacity>
                {isOwnComment ? (
                  <TouchableOpacity
                    onPress={() => onCommentActionsPress?.(item)}
                    hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
                    className="absolute bottom-0 right-1 top-0 justify-center rounded-full p-1"
                  >
                    <MaterialIcons name="more-vert" size={16} color={palette.actionIcon} />
                  </TouchableOpacity>
                ) : null}
                <UserMention
                  variant="text"
                  value={item?.comment}
                  className={commentTextClassName}
                  mentionClassName={mentionClassName}
                  textStyle={{ color: palette.countText }}
                  mentionStyle={{ color: palette.replyAction }}
                  onMentionPress={onMentionPress}
                  onUrlPress={onUrlPress}
                />
              </View>

              <View className="mt-1 flex-row items-center space-x-3 px-1">
                <Text className="font-sans text-xs" style={{ color: palette.timestamp }}>
                  {isPending ? "Sending..." : TimeAgo(item?.$createdAt)}
                </Text>
                <TouchableOpacity disabled={!canReply} onPress={() => onReplyPress?.(item)}>
                  <Text
                    className="font-sans text-xs font-semibold"
                    style={{ color: canReply ? palette.replyAction : palette.timestamp, opacity: canReply ? 1 : 0.65 }}
                  >
                    Reply
                  </Text>
                </TouchableOpacity>
              </View>

              {replyCount > 0 ? (
                <View className="mt-3 border-l pl-3" style={{ borderLeftColor: palette.replyRail }}>
                  {!showReplies ? (
                    <TouchableOpacity onPress={handleToggleReplies}>
                      <Text className="font-sans text-xs" style={{ color: palette.replyMeta }}>
                        View {replyCount === 1 ? "1 reply" : `${replyCount} replies`}
                      </Text>
                    </TouchableOpacity>
                  ) : (
                    <>
                      {visibleReplies.map((reply) => (
                        <View key={reply?.$id || `${reply?.comment}-${reply?.$createdAt}`} className="mb-3 flex-row items-center space-x-2">
                          <TouchableOpacity onPress={() => onProfilePress?.(reply)}>
                            <FastImage
                              source={{ uri: reply?.commentOwner?.avatar || "" }}
                              className="h-7 w-7 rounded-full"
                              style={{ backgroundColor: palette.avatar }}
                            />
                          </TouchableOpacity>

                          <View className="flex-1">
                            <View
                              className="relative rounded-[8px] px-2.5 py-2 pr-8"
                              style={{
                                backgroundColor: reply?.isPending ? palette.pendingReplyBubble : palette.replyBubble,
                              }}
                            >
                              <TouchableOpacity onPress={() => onProfilePress?.(reply)}>
                                <Text className="font-sans text-xs font-semibold" style={{ color: palette.ownerText }}>
                                  {reply?.commentOwner?.username || "Deleted User"}
                                </Text>
                              </TouchableOpacity>
                              {!reply?.isPending &&
                              userId &&
                              reply?.$id &&
                              String(getInlineCommentOwnerId(reply?.commentOwner)) === String(userId) ? (
                                <TouchableOpacity
                                  onPress={() => onReplyActionsPress?.(item?.$id, reply)}
                                  hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
                                  className="absolute bottom-0 right-1 top-0 justify-center rounded-full p-1"
                                >
                                  <MaterialIcons name="more-vert" size={15} color={palette.replyActionIcon} />
                                </TouchableOpacity>
                              ) : null}
                              <UserMention
                                variant="text"
                                value={reply?.comment}
                                className={replyTextClassName}
                                mentionClassName={mentionClassName}
                                textStyle={{ color: palette.countText }}
                                mentionStyle={{ color: palette.replyAction }}
                                onMentionPress={onMentionPress}
                                onUrlPress={onUrlPress}
                              />
                            </View>
                            <View className="mt-1 flex-row items-center px-1">
                              <Text className="font-sans text-[11px]" style={{ color: palette.timestamp }}>
                                {reply?.isPending ? "Sending..." : TimeAgo(reply?.$createdAt)}
                              </Text>
                            </View>
                          </View>
                        </View>
                      ))}

                      {visibleCount < replies.length ? (
                        <TouchableOpacity onPress={handleViewMoreReplies}>
                          <Text className="font-sans text-xs" style={{ color: palette.replyMeta }}>
                            View {Math.min(INITIAL_VISIBLE_REPLIES, replies.length - visibleCount)} more{" "}
                            {replies.length - visibleCount === 1 ? "reply" : "replies"}
                          </Text>
                        </TouchableOpacity>
                      ) : null}

                      <TouchableOpacity onPress={handleToggleReplies} className="mt-1">
                        <Text className="font-sans text-xs" style={{ color: palette.replyMetaMuted }}>
                          Hide replies
                        </Text>
                      </TouchableOpacity>
                    </>
                  )}
                </View>
              ) : null}
            </View>

            <TouchableOpacity onPress={handleLikeComment} disabled={!canLike} className="ml-3 items-center pt-2">
              <MaterialCommunityIcons
                name={liked ? "heart" : "heart-outline"}
                size={16}
                color={liked ? palette.likeActive : canLike ? palette.likeInactive : palette.countText}
              />
              <Text
                className="mt-1 text-center font-sans text-[11px] font-semibold"
                style={{ minWidth: 16, opacity: likeCount > 0 ? 1 : 0, color: palette.countText }}
              >
                {likeCount > 0 ? likeCount : 0}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  },
);

const BookInlineCommentModal = ({ anchor, chapter, isVisible, onClose, onThreadUpdated, bookReadingTheme, pageColor }) => {
  const { theme } = useAppTheme();
  const chapterId = chapter?.$id;
  const insets = useSafeAreaInsets();
  const inputRef = useRef(null);
  const commentsListRef = useRef(null);
  const { user } = useGlobalContext();
  const [loading, setLoading] = useState(true);
  const [thread, setThread] = useState(null);
  const [comments, setComments] = useState([]);
  const [commentText, setCommentText] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [replyTarget, setReplyTarget] = useState(null);
  const [selectedMentionUsers, setSelectedMentionUsers] = useState([]);
  const [mentionSuggestions, setMentionSuggestions] = useState([]);
  const [showMentionSuggestions, setShowMentionSuggestions] = useState(false);
  const [mentionReady, setMentionReady] = useState(false);
  const [mentionTriggerIndex, setMentionTriggerIndex] = useState(null);
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  const [lastId, setLastId] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [commentScrollOffset, setCommentScrollOffset] = useState(0);
  const [commentContentHeight, setCommentContentHeight] = useState(0);
  const [commentListViewportHeight, setCommentListViewportHeight] = useState(0);
  const [actionsSheetVisible, setActionsSheetVisible] = useState(false);
  const [actionTarget, setActionTarget] = useState(null);
  const [isDeletingTarget, setIsDeletingTarget] = useState(false);
  const notificationService = useRef(new NotificationService()).current;
  const mentionTimerRef = useRef(null);
  const mentionSearchRequestIdRef = useRef(0);
  const mentionUserCacheRef = useRef(new Map());
  const selectedMentionMapRef = useRef(new Map());
  const committedMentionRangeRef = useRef(null);
  const selectionRef = useRef(null);
  const mentionSelectionInProgressRef = useRef(false);
  const pendingMentionSelectionRef = useRef(null);
  const composerBlurTimeoutRef = useRef(null);
  const composerPressInRef = useRef(false);

  const backendConfigured = BookInlineCommentsService.isConfigured();
  const enableSwipeToClose = Platform.OS === "ios";
  const modalBackgroundColor = theme.surfaceElevated;
  const surfaceBorderColor = theme.border;
  const chromeMutedTextColor = theme.textSoft;
  const closeButtonBackgroundColor = theme.surfaceMuted;
  const passageBackgroundColor = theme.cardStrong;
  const passageBorderColor = theme.border;
  const passageMetaColor = theme.accentBlue;
  const passageTextColor = theme.text;
  const commentBubbleBackgroundColor = theme.surfaceMuted;
  const pendingBubbleBackgroundColor = theme.primarySoft;
  const composerBackgroundColor = theme.inputBackground;
  const composerBorderColor = theme.inputBorder;
  const replyActionColor = theme.accentBlue;
  const avatarBackgroundColor = theme.surfaceStrong;
  const replyRailColor = theme.divider;
  const replyBubbleBackgroundColor = theme.cardStrong;
  const pendingReplyBubbleBackgroundColor = theme.primarySoft;
  const likeActiveColor = theme.like;
  const likeInactiveColor = theme.textSoft;
  const activePostButtonColor = theme.primary;
  const inlineFeatureFlags = BookInlineCommentsService.getFeatureFlags();
  const passageText = anchor?.preview || thread?.anchorText || "Selected passage";
  const loadedCommentCount = comments.reduce((totalCount, commentItem) => totalCount + 1 + getInlineCommentReplies(commentItem).length, 0);
  const displayedCommentCount = Math.max(thread?.totalCommentCount ?? thread?.commentsCount ?? 0, loadedCommentCount);
  const commentCountLabel = `${displayedCommentCount} ${displayedCommentCount === 1 ? "comment" : "comments"}`;
  const canSubmitComment = backendConfigured && !isSubmitting && Boolean(commentText.trim()) && (!replyTarget || inlineFeatureFlags.repliesEnabled);
  const initialLoading = loading && comments.length === 0;
  const inlineCommentItemPalette = {
    avatar: avatarBackgroundColor,
    bubble: commentBubbleBackgroundColor,
    likeActive: likeActiveColor,
    likeInactive: likeInactiveColor,
    countText: theme.textSoft,
    ownerText: theme.text,
    pendingBubble: pendingBubbleBackgroundColor,
    pendingReplyBubble: pendingReplyBubbleBackgroundColor,
    actionIcon: theme.iconMuted,
    replyAction: replyActionColor,
    replyActionIcon: theme.iconMuted,
    replyBubble: replyBubbleBackgroundColor,
    replyMeta: theme.textSubtle,
    replyMetaMuted: theme.textSubtle,
    replyRail: replyRailColor,
    timestamp: theme.textSoft,
  };
  const composerTextClassName = "font-sans text-sm leading-5";
  const composerMentionClassName = "font-sans font-semibold";
  const mentionSuggestionContainerClassName = "max-h-44 border-t";
  const mentionSuggestionItemClassName = "flex-row items-center space-x-2 border-b px-4 py-2";
  const mentionSuggestionSelectedItemClassName = "";
  const mentionSuggestionAvatarClassName = "h-8 w-8 rounded-full";
  const commentListScrollOffsetMax = Math.max(0, commentContentHeight - commentListViewportHeight);
  const commentListContentContainerStyle =
    initialLoading || comments.length > 0 ? { paddingTop: 4, paddingBottom: 12 } : { paddingTop: 4, paddingBottom: 12, flexGrow: 1 };

  const resolveCommentOwnerId = (item) => {
    const owner = item?.commentOwner;
    if (!owner) return "";
    if (typeof owner === "string") return owner;
    return owner?.$id || "";
  };

  const isOwnedByCurrentUser = useCallback(
    (owner) => {
      const ownerId = getInlineCommentOwnerId(owner);
      return Boolean(user?.$id && ownerId && String(ownerId) === String(user.$id));
    },
    [user?.$id],
  );

  const syncSelectedMentionUsers = useCallback(() => {
    const uniqueUsers = Array.from(
      new Map(Array.from(selectedMentionMapRef.current.values()).map((mentionedUser) => [String(mentionedUser?.$id || ""), mentionedUser])).values(),
    ).filter((mentionedUser) => mentionedUser?.$id);
    setSelectedMentionUsers(uniqueUsers);
  }, []);

  const clearMentionSuggestions = useCallback(() => {
    mentionSearchRequestIdRef.current += 1;
    setShowMentionSuggestions(false);
    setMentionSuggestions([]);
    setMentionTriggerIndex(null);
    setMentionReady(false);
  }, []);

  const clearComposerBlurTimeout = useCallback(() => {
    if (composerBlurTimeoutRef.current) {
      clearTimeout(composerBlurTimeoutRef.current);
      composerBlurTimeoutRef.current = null;
    }
  }, []);

  const closeModalForNavigation = useCallback(() => {
    Keyboard.dismiss();
    clearComposerBlurTimeout();
    clearMentionSuggestions();
    setIsComposerFocused(false);
    onClose?.();
  }, [clearComposerBlurTimeout, clearMentionSuggestions, onClose]);

  const handleRequestClose = useCallback(() => {
    closeModalForNavigation();
  }, [closeModalForNavigation]);

  const cacheMentionUsers = useCallback((users = []) => {
    users.forEach((candidate) => {
      const mentionToken = normalizeMentionToken(candidate?.username || candidate?.name || "");
      if (mentionToken && candidate?.$id) {
        mentionUserCacheRef.current.set(mentionToken, candidate);
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
          const cachedUser = mentionUserCacheRef.current.get(username);
          if (cachedUser?.$id) {
            resolvedUsersMap.set(cachedUser.$id, cachedUser);
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
            console.warn("resolveMentionedUsers error:", error?.message || error);
          }
        }),
      );

      const resolvedUsers = Array.from(resolvedUsersMap.values());
      cacheMentionUsers(resolvedUsers);
      return resolvedUsers;
    },
    [cacheMentionUsers],
  );

  const openUserProfile = useCallback(
    (ownerId) => {
      const normalizedOwnerId = String(ownerId || "").trim();
      if (!normalizedOwnerId) return;

      closeModalForNavigation();
      if (String(user?.$id || "") === normalizedOwnerId) {
        router.push("/profile");
        return;
      }

      router.push({
        pathname: "/creator-profile",
        params: { userId: normalizedOwnerId },
      });
    },
    [closeModalForNavigation, user?.$id],
  );

  const openMentionProfile = useCallback(
    (targetUserId) => {
      if (!targetUserId) return;
      openUserProfile(targetUserId);
    },
    [openUserProfile],
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
        console.warn("handleInlineMentionPress error:", error?.message || error);
      }
    },
    [openMentionProfile, resolveMentionedUsers],
  );

  const handleUrlPress = useCallback(async (url) => {
    const targetUrl = normalizeExternalUrl(url);
    if (!targetUrl) return;

    try {
      await Linking.openURL(targetUrl);
    } catch (error) {
      console.warn("handleInlineCommentUrlPress error:", error?.message || error);
    }
  }, []);

  const renderComposerMentionText = useMemo(() => {
    if (!commentText) return null;

    return (
      <UserMention
        variant="text"
        value={commentText}
        className={composerTextClassName}
        mentionClassName={composerMentionClassName}
        textStyle={{ color: theme.inputText }}
        mentionStyle={{ color: theme.accentBlue }}
        selectedMentionUsers={selectedMentionUsers}
        onMentionPress={(_username, userId) => {
          if (userId) openMentionProfile(userId);
        }}
      />
    );
  }, [commentText, composerMentionClassName, composerTextClassName, openMentionProfile, selectedMentionUsers, theme.accentBlue, theme.inputText]);

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
        setShowMentionSuggestions(true);
        setMentionReady(true);
      } catch (error) {
        if (requestId !== mentionSearchRequestIdRef.current) return;
        console.warn("findInlineMentionSuggestions error:", error?.message || error);
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
      selectedMentionMapRef.current.forEach((mentionedUser, token) => {
        const mentionLabel = sanitizeMentionLabel(mentionedUser?.username || mentionedUser?.name || "");
        if (!mentionLabel || !hasMentionLabelInText(text, mentionLabel)) {
          selectedMentionMapRef.current.delete(token);
          hasRemovedMention = true;
        }
      });
      if (hasRemovedMention) syncSelectedMentionUsers();

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
      pendingMentionSelectionRef.current = null;
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

  const resolveRecipientForNotification = useCallback(
    async (recipient) => {
      if (!recipient) return null;
      if (typeof recipient === "object" && recipient?.$id && recipient?.expoPushToken) return recipient;
      if (typeof recipient === "object" && recipient?.$id && recipient?.username) return recipient;

      const recipientId = typeof recipient === "string" ? recipient : recipient?.$id || "";
      if (!recipientId) return null;
      if (String(recipientId) === String(user?.$id || "")) return user;

      try {
        return await getUserByID({ ID: recipientId });
      } catch (error) {
        console.warn("resolveInlineNotificationRecipient error:", error?.message || error);
        return typeof recipient === "object" ? recipient : null;
      }
    },
    [user],
  );

  const resolveChapterOwner = useCallback(
    async () => resolveRecipientForNotification(chapter?.book?.uploader),
    [chapter?.book?.uploader, resolveRecipientForNotification],
  );

  const notifyInlineCommentRecipients = useCallback(
    async ({ text, isReply, replyRecipient, selectedMentionedUsers = [], commentId = "", replyId = "" }) => {
      if (!user?.$id || !chapterId || !anchor?.anchorKey) return;

      const resourceId = buildInlineCommentNotificationResourceId({
        chapterId,
        anchorKey: anchor.anchorKey,
        commentId,
        replyId,
      });
      if (!resourceId) return;

      const notifiedIds = new Set();

      try {
        if (isReply) {
          const resolvedRecipient = await resolveRecipientForNotification(replyRecipient);
          if (resolvedRecipient?.$id && String(resolvedRecipient.$id) !== String(user.$id)) {
            notifiedIds.add(String(resolvedRecipient.$id));
            await notificationService.notifyUser({
              sender: user,
              recipient: resolvedRecipient,
              type: INLINE_COMMENT_NOTIFICATION_TYPE,
              resourceId,
              message: "replied to your comment on a passage",
            });
          }
        } else {
          const chapterOwner = await resolveChapterOwner();
          if (chapterOwner?.$id && String(chapterOwner.$id) !== String(user.$id)) {
            notifiedIds.add(String(chapterOwner.$id));
            await notificationService.notifyUser({
              sender: user,
              recipient: chapterOwner,
              type: INLINE_COMMENT_NOTIFICATION_TYPE,
              resourceId,
              message: `commented on a passage in "${chapter?.title || "your chapter"}"`,
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
              type: INLINE_COMMENT_NOTIFICATION_TYPE,
              resourceId,
              message: `${user?.username || "Someone"} mentioned you in a ${isReply ? "reply" : "comment"} on a passage`,
            });
          }),
        );
      } catch (error) {
        console.warn("notifyInlineCommentRecipients error:", error?.message || error);
      }
    },
    [
      anchor?.anchorKey,
      chapter?.title,
      chapterId,
      cacheMentionUsers,
      normalizeMentionUsernames,
      notificationService,
      resolveChapterOwner,
      resolveMentionedUsers,
      resolveRecipientForNotification,
      user,
    ],
  );

  useEffect(() => {
    if (isVisible) return;

    if (mentionTimerRef.current) {
      clearTimeout(mentionTimerRef.current);
      mentionTimerRef.current = null;
    }
    clearComposerBlurTimeout();
    setLoading(true);
    setThread(null);
    setComments([]);
    setCommentText("");
    setIsSubmitting(false);
    setReplyTarget(null);
    setSelectedMentionUsers([]);
    setMentionSuggestions([]);
    setShowMentionSuggestions(false);
    setMentionReady(false);
    setMentionTriggerIndex(null);
    setIsComposerFocused(false);
    setLastId(null);
    setHasMore(false);
    setSubmitError("");
    setCommentScrollOffset(0);
    setCommentContentHeight(0);
    setCommentListViewportHeight(0);
    setActionsSheetVisible(false);
    setActionTarget(null);
    setIsDeletingTarget(false);
    selectedMentionMapRef.current.clear();
    mentionUserCacheRef.current.clear();
    committedMentionRangeRef.current = null;
    selectionRef.current = null;
    mentionSelectionInProgressRef.current = false;
    pendingMentionSelectionRef.current = null;
    composerPressInRef.current = false;
  }, [anchor?.anchorKey, chapterId, clearComposerBlurTimeout, isVisible]);

  useEffect(() => {
    return () => {
      if (mentionTimerRef.current) {
        clearTimeout(mentionTimerRef.current);
      }
      clearComposerBlurTimeout();
      pendingMentionSelectionRef.current = null;
    };
  }, [clearComposerBlurTimeout]);

  useEffect(() => {
    if (!isVisible) return undefined;

    let isMounted = true;

    const loadThread = async () => {
      if (!chapterId || !anchor?.anchorKey) {
        if (isMounted) {
          setLoading(false);
          setThread(null);
          setComments([]);
          setLastId(null);
          setHasMore(false);
        }
        return;
      }

      if (!backendConfigured) {
        if (isMounted) {
          setLoading(false);
          setThread(null);
          setComments([]);
          setLastId(null);
          setHasMore(false);
        }
        return;
      }

      try {
        setLoading(true);
        const existingThread = await BookInlineCommentsService.getThreadByAnchor({
          bookChapterId: chapterId,
          anchorKey: anchor.anchorKey,
        });

        if (!existingThread) {
          if (isMounted) {
            setThread(null);
            setComments([]);
            setLastId(null);
            setHasMore(false);
          }
          return;
        }

        const syncedThread = (await BookInlineCommentsService.syncThreadStats({ threadId: existingThread.$id })) || existingThread;
        const commentsData = await BookInlineCommentsService.fetchThreadComments({
          threadId: syncedThread.$id,
          limit: LIMIT,
        });
        const docs = commentsData.documents || [];

        if (!isMounted) return;

        setThread(syncedThread);
        setComments(docs);
        setLastId(docs.at(-1)?.$id || null);
        setHasMore(docs.length === LIMIT);
        onThreadUpdated?.(anchor.anchorKey, syncedThread);
      } catch (error) {
        console.warn("loadThread error:", error?.message || error);
        if (!isMounted) return;
        setThread(null);
        setComments([]);
        setLastId(null);
        setHasMore(false);
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    loadThread();

    return () => {
      isMounted = false;
    };
  }, [anchor?.anchorKey, backendConfigured, chapterId, isVisible]);

  const handleUserPress = useCallback(
    (item) => {
      const ownerId = resolveCommentOwnerId(item);
      if (!ownerId) return;
      openUserProfile(ownerId);
    },
    [openUserProfile],
  );

  const buildThreadSnapshot = useCallback(
    (baseThreadDocument, nextComments) => {
      const resolvedComments = Array.isArray(nextComments) ? nextComments : [];
      const nextRepliesCount = resolvedComments.reduce((totalReplies, commentItem) => totalReplies + getInlineCommentReplies(commentItem).length, 0);
      const fallbackTopLevelCount = resolvedComments.length;
      const nextTopLevelCount = Math.max(baseThreadDocument?.commentsCount ?? thread?.commentsCount ?? fallbackTopLevelCount, 0);

      return {
        ...(thread || {}),
        ...(baseThreadDocument || {}),
        commentsCount: nextTopLevelCount,
        repliesCount: nextRepliesCount,
        totalCommentCount: nextTopLevelCount + nextRepliesCount,
      };
    },
    [thread],
  );

  const updateCommentReplies = useCallback((parentCommentId, updater) => {
    setComments((previousComments) =>
      previousComments.map((commentItem) => {
        if (String(commentItem?.$id || "") !== String(parentCommentId || "")) return commentItem;

        const currentReplies = getInlineCommentReplies(commentItem);
        const nextReplies = updater(currentReplies, commentItem);
        return {
          ...commentItem,
          booksChapterInlineCommentReplies: nextReplies,
          replyCount: nextReplies.length,
          __forceShowRepliesToken: Date.now(),
          __forceVisibleReplies: nextReplies.length,
        };
      }),
    );
  }, []);

  const handleReplyPress = useCallback(
    (comment) => {
      if (!comment?.$id || !inlineFeatureFlags.repliesEnabled || !user?.$id) return;

      setReplyTarget({
        id: comment.$id,
        username: comment?.commentOwner?.username || "",
        recipient: comment?.commentOwner || null,
      });
      committedMentionRangeRef.current = null;
      clearMentionSuggestions();
      setSubmitError("");
      setTimeout(() => inputRef.current?.focus(), 100);
    },
    [clearMentionSuggestions, inlineFeatureFlags.repliesEnabled, user?.$id],
  );

  const handleCancelReply = useCallback(() => {
    setReplyTarget(null);
    setCommentText("");
    selectedMentionMapRef.current.clear();
    setSelectedMentionUsers([]);
    committedMentionRangeRef.current = null;
    clearMentionSuggestions();
    setSubmitError("");
  }, [clearMentionSuggestions]);

  const closeActionsSheet = useCallback(() => {
    if (isDeletingTarget) return;
    setActionsSheetVisible(false);
    setActionTarget(null);
  }, [isDeletingTarget]);

  const openCommentActions = useCallback(
    (comment) => {
      if (!isOwnedByCurrentUser(comment?.commentOwner) || !comment?.$id) return;
      setActionTarget({ type: "comment", comment, commentId: String(comment.$id) });
      setActionsSheetVisible(true);
    },
    [isOwnedByCurrentUser],
  );

  const openReplyActions = useCallback(
    (commentId, reply) => {
      if (!isOwnedByCurrentUser(reply?.commentOwner) || !commentId || !reply?.$id) return;
      setActionTarget({ type: "reply", reply, commentId: String(commentId) });
      setActionsSheetVisible(true);
    },
    [isOwnedByCurrentUser],
  );

  const handleDeleteReply = useCallback(
    async (commentId, reply) => {
      const normalizedCommentId = String(commentId || "");
      const replyId = String(reply?.$id || "");
      if (!normalizedCommentId || !replyId || !isOwnedByCurrentUser(reply?.commentOwner)) return;

      try {
        await BookInlineCommentsService.deleteReplyComment({ replyId });

        const nextComments = comments.map((commentItem) =>
          String(commentItem?.$id || "") === normalizedCommentId
            ? {
                ...commentItem,
                booksChapterInlineCommentReplies: getInlineCommentReplies(commentItem).filter(
                  (existingReply) => String(existingReply?.$id || "") !== replyId,
                ),
                replyCount: Math.max(0, (commentItem?.replyCount ?? getInlineCommentReplies(commentItem).length) - 1),
              }
            : commentItem,
        );

        const nextThreadDocument = buildThreadSnapshot(thread, nextComments);
        setComments(nextComments);
        setThread(nextThreadDocument);
        if (anchor?.anchorKey && nextThreadDocument) {
          onThreadUpdated?.(anchor.anchorKey, nextThreadDocument);
        }
      } catch (error) {
        console.warn("handleDeleteInlineReply error:", error?.message || error);
      }
    },
    [anchor?.anchorKey, buildThreadSnapshot, comments, isOwnedByCurrentUser, onThreadUpdated, thread],
  );

  const handleDeleteComment = useCallback(
    async (comment) => {
      const commentId = String(comment?.$id || "");
      if (!commentId || !isOwnedByCurrentUser(comment?.commentOwner)) return;

      try {
        const fallbackThreadDocument = {
          ...(thread || {}),
          commentsCount: Math.max((thread?.commentsCount ?? comments.length) - 1, 0),
        };

        const { thread: syncedThread } = await BookInlineCommentsService.deleteInlineComment({
          commentId,
          threadId: thread?.$id,
        });

        const nextComments = comments.filter((existingComment) => String(existingComment?.$id || "") !== commentId);
        const nextThreadDocument = buildThreadSnapshot(syncedThread || fallbackThreadDocument, nextComments);

        setComments(nextComments);
        setThread(nextThreadDocument);
        if (replyTarget?.id && String(replyTarget.id) === commentId) {
          handleCancelReply();
        }
        if (anchor?.anchorKey && nextThreadDocument) {
          onThreadUpdated?.(anchor.anchorKey, {
            ...nextThreadDocument,
            totalCommentCount: Math.max(nextThreadDocument.totalCommentCount ?? 0, 0),
            repliesCount: Math.max(nextThreadDocument.repliesCount ?? 0, 0),
            commentsCount: Math.max(nextThreadDocument.commentsCount ?? 0, 0),
          });
        }
      } catch (error) {
        console.warn("handleDeleteInlineComment error:", error?.message || error);
      }
    },
    [anchor?.anchorKey, buildThreadSnapshot, comments, handleCancelReply, isOwnedByCurrentUser, onThreadUpdated, replyTarget?.id, thread],
  );

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

  const fetchMoreComments = useCallback(async () => {
    if (!thread?.$id || !lastId || !hasMore || loading) return;

    try {
      const commentsData = await BookInlineCommentsService.fetchThreadComments({
        threadId: thread.$id,
        lastId,
        limit: LIMIT,
      });
      const fetchedComments = commentsData.documents || [];

      setComments((previousComments) => {
        const uniqueComments = fetchedComments.filter(
          (item) => !previousComments.some((existingComment) => String(existingComment?.$id || "") === String(item?.$id || "")),
        );

        if (uniqueComments.length === 0) {
          setHasMore(false);
          return previousComments;
        }

        return [...previousComments, ...uniqueComments];
      });
      setLastId(fetchedComments.at(-1)?.$id || null);
      setHasMore(fetchedComments.length === LIMIT);
    } catch (error) {
      console.warn("fetchMoreComments error:", error?.message || error);
    }
  }, [hasMore, lastId, loading, thread?.$id]);

  const buildOptimisticThread = (comment) => {
    const currentCount = Math.max(thread?.commentsCount ?? 0, comments.length);

    return {
      ...(thread || {
        $id: `temp-thread-${anchor?.anchorKey || "inline"}`,
        anchorKey: anchor?.anchorKey,
        anchorVersion: anchor?.anchorVersion || "v1",
        anchorTag: anchor?.tagName || "p",
        anchorOrdinal: Number(anchor?.ordinal) || 0,
        anchorPath: anchor?.path || "",
        anchorText: passageText,
        normalizedTextHash: anchor?.textHash || "",
      }),
      commentsCount: currentCount + 1,
      latestCommentPreview: comment,
      lastCommentAt: new Date().toISOString(),
    };
  };

  const handlePostComment = useCallback(async () => {
    if (!backendConfigured || isSubmitting || !commentText.trim() || !chapterId || !anchor?.anchorKey) return;
    if (!user?.$id) {
      setSubmitError("You need to be signed in to comment.");
      return;
    }

    const trimmedComment = commentText.trim();
    const replyContext = replyTarget;
    const selectedMentionedUsersSnapshot = Array.from(selectedMentionMapRef.current.values()).filter((mentionedUser) => mentionedUser?.$id);
    const persistedCommentText = serializeMentionsForStorage(trimmedComment, selectedMentionedUsersSnapshot);
    const previousThread = thread;
    let optimisticReplyId = null;
    let optimisticCommentId = null;

    try {
      Keyboard.dismiss();
      clearComposerBlurTimeout();
      setIsComposerFocused(false);
      setIsSubmitting(true);
      setSubmitError("");
      setCommentText("");
      selectedMentionMapRef.current.clear();
      setSelectedMentionUsers([]);
      committedMentionRangeRef.current = null;
      clearMentionSuggestions();

      if (replyContext) {
        setReplyTarget(null);
        optimisticReplyId = `temp-inline-reply-${Date.now()}`;
        const optimisticReply = {
          $id: optimisticReplyId,
          $createdAt: new Date().toISOString(),
          comment: persistedCommentText,
          commentOwner: user,
          isPending: true,
        };

        updateCommentReplies(replyContext.id, (currentReplies) => [...currentReplies, optimisticReply]);

        const createdReply = await BookInlineCommentsService.createReplyComment({
          comment: persistedCommentText,
          commentOwner: user.$id,
          bookChapterInlineComment: replyContext.id,
          commentOwnerDocument: user,
        });

        if (!createdReply?.$id) throw new Error("Reply not created.");

        updateCommentReplies(replyContext.id, (currentReplies) => {
          const hasOptimisticReply = currentReplies.some((reply) => String(reply?.$id || "") === String(optimisticReplyId || ""));
          if (!hasOptimisticReply) return [...currentReplies, createdReply];

          return currentReplies.map((reply) => (String(reply?.$id || "") === String(optimisticReplyId || "") ? createdReply : reply));
        });
        void notifyInlineCommentRecipients({
          text: persistedCommentText,
          isReply: true,
          replyRecipient: replyContext.recipient,
          selectedMentionedUsers: selectedMentionedUsersSnapshot,
          commentId: replyContext.id,
          replyId: createdReply.$id,
        });
        return;
      }

      optimisticCommentId = `temp-inline-comment-${Date.now()}`;
      const optimisticCreatedAt = new Date().toISOString();
      const optimisticThread = buildOptimisticThread(trimmedComment);
      const optimisticComment = {
        $id: optimisticCommentId,
        $createdAt: optimisticCreatedAt,
        comment: persistedCommentText,
        commentOwner: user,
        booksChapterInlineCommentLikes: [],
        booksChapterInlineCommentReplies: [],
        likeCount: 0,
        replyCount: 0,
        isPending: true,
        __features: inlineFeatureFlags,
      };

      setThread(optimisticThread);
      setComments((prev) => [optimisticComment, ...prev]);

      const response = await BookInlineCommentsService.createInlineComment({
        bookChapterId: chapterId,
        anchor,
        comment: persistedCommentText,
        commentOwner: user?.$id,
        commentOwnerDocument: user,
      });

      if (!response?.comment) throw new Error("Comment not created.");

      const syncedThread = response.thread || optimisticThread;
      setThread(syncedThread);
      setComments((prev) => [response.comment, ...prev.filter((item) => item?.$id !== optimisticCommentId && item?.$id !== response.comment.$id)]);
      setLastId((currentLastId) => currentLastId || response.comment.$id);
      onThreadUpdated?.(anchor.anchorKey, syncedThread);
      void notifyInlineCommentRecipients({
        text: persistedCommentText,
        isReply: false,
        selectedMentionedUsers: selectedMentionedUsersSnapshot,
        commentId: response.comment.$id,
      });
    } catch (error) {
      console.warn("handlePostComment error:", error?.message || error);
      if (replyContext?.id) {
        updateCommentReplies(replyContext.id, (currentReplies) =>
          currentReplies.filter((reply) => String(reply?.$id || "") !== String(optimisticReplyId || "")),
        );
        setReplyTarget(replyContext);
      } else {
        setThread(previousThread || null);
        setComments((prev) => prev.filter((item) => String(item?.$id || "") !== String(optimisticCommentId || "")));
      }
      selectedMentionMapRef.current = new Map(
        selectedMentionedUsersSnapshot
          .map((mentionedUser) => [normalizeMentionToken(mentionedUser?.username || mentionedUser?.name || ""), mentionedUser])
          .filter(([mentionToken]) => mentionToken),
      );
      setSelectedMentionUsers(selectedMentionedUsersSnapshot);
      cacheMentionUsers(selectedMentionedUsersSnapshot);
      committedMentionRangeRef.current = null;
      setCommentText((currentText) => currentText || trimmedComment);
      setSubmitError(error?.message || "Unable to post this comment right now.");
    } finally {
      setIsSubmitting(false);
    }
  }, [
    anchor,
    backendConfigured,
    cacheMentionUsers,
    chapterId,
    clearComposerBlurTimeout,
    clearMentionSuggestions,
    commentText,
    inlineFeatureFlags,
    isSubmitting,
    notifyInlineCommentRecipients,
    onThreadUpdated,
    passageText,
    replyTarget,
    thread,
    updateCommentReplies,
    user,
  ]);

  const renderCommentItem = useCallback(
    ({ item }) => (
      <BookInlineCommentItem
        item={item}
        userId={user?.$id}
        onMentionPress={handleMentionPress}
        onCommentActionsPress={openCommentActions}
        onReplyActionsPress={openReplyActions}
        onProfilePress={handleUserPress}
        onReplyPress={handleReplyPress}
        onUrlPress={handleUrlPress}
        palette={inlineCommentItemPalette}
      />
    ),
    [
      handleMentionPress,
      handleReplyPress,
      handleUrlPress,
      handleUserPress,
      inlineCommentItemPalette,
      openCommentActions,
      openReplyActions,
      user?.$id,
    ],
  );

  const renderCommentSkeletonItem = useCallback(({ index }) => {
    const primaryWidth = index === 0 ? "74%" : index === 1 ? "66%" : "71%";
    const secondaryWidth = index === 0 ? "52%" : index === 1 ? "43%" : "58%";

    return (
      <View className="mb-4 flex-row items-start space-x-2">
        <AnimatedSkeleton style={{ width: 40, height: 40, borderRadius: 999, backgroundColor: theme.skeletonBase }} />

        <View className="flex-1 flex-row items-start">
          <View className="flex-1">
            <View className="rounded-[8px] px-3 py-2" style={{ backgroundColor: theme.surfaceMuted }}>
              <AnimatedSkeleton style={{ width: 96, height: 14, backgroundColor: theme.skeletonHighlight }} />
              <AnimatedSkeleton style={{ width: primaryWidth, height: 12, marginTop: 10, backgroundColor: theme.skeletonBase }} />
              <AnimatedSkeleton style={{ width: secondaryWidth, height: 12, marginTop: 8, backgroundColor: theme.skeletonBase }} />
            </View>

            <View className="mt-1 flex-row items-center space-x-3 px-1">
              <AnimatedSkeleton style={{ width: 56, height: 10, backgroundColor: theme.skeletonBase }} />
              <AnimatedSkeleton style={{ width: 40, height: 10, backgroundColor: theme.skeletonBase }} />
            </View>
          </View>

          <View className="ml-3 items-center pt-2">
            <AnimatedSkeleton style={{ width: 16, height: 16, borderRadius: 999, backgroundColor: theme.skeletonBase }} />
            <AnimatedSkeleton style={{ width: 12, height: 10, marginTop: 6, backgroundColor: theme.skeletonBase }} />
          </View>
        </View>
      </View>
    );
  }, []);

  const listHeader = useMemo(
    () => (
      <View
        className="mb-3 rounded-2xl border px-3.5 py-3"
        style={{
          backgroundColor: passageBackgroundColor,
          borderColor: passageBorderColor,
        }}
      >
        <View className="flex-row items-center justify-between">
          <View className="mr-3 flex-row items-center">
            <MaterialCommunityIcons name="format-quote-open" size={15} color={passageMetaColor} />
            <Text className="ml-2 font-sans text-[11px] font-semibold" style={{ color: passageMetaColor }}>
              Highlighted Passage
            </Text>
          </View>
        </View>
        <Text className="mt-2 font-sans text-sm leading-5" style={{ color: passageTextColor }}>
          {passageText}
        </Text>
      </View>
    ),
    [commentCountLabel, passageBackgroundColor, passageBorderColor, passageMetaColor, passageText, passageTextColor],
  );

  return (
    <>
      <Modal
        isVisible={isVisible}
        onBackdropPress={handleRequestClose}
        onBackButtonPress={handleRequestClose}
        swipeDirection={enableSwipeToClose ? "down" : null}
        onSwipeComplete={enableSwipeToClose ? handleRequestClose : undefined}
        scrollTo={
          enableSwipeToClose
            ? (params) => {
                commentsListRef.current?.scrollToOffset?.({
                  offset: Math.max(params?.y || 0, 0),
                  animated: false,
                });
              }
            : undefined
        }
        scrollOffset={enableSwipeToClose ? commentScrollOffset : undefined}
        scrollOffsetMax={enableSwipeToClose ? commentListScrollOffsetMax : undefined}
        style={{ justifyContent: "flex-end", margin: 0 }}
        backdropOpacity={0.3}
        propagateSwipe={enableSwipeToClose}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={{
            minHeight: SCREEN_HEIGHT * 0.6,
            maxHeight: SCREEN_HEIGHT * 0.75,
            height: SCREEN_HEIGHT * 0.75,
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            borderTopWidth: 1,
            borderTopColor: surfaceBorderColor,
            paddingBottom: insets.bottom + 8,
            backgroundColor: modalBackgroundColor,
          }}
        >
          <View className="items-center py-1.5">
            <View className="h-1.5 w-20 rounded-full" style={{ backgroundColor: theme.handle }} />
          </View>
          <View className="flex-1 px-4">
            <View className="pb-2">
              <View className="flex-row items-center justify-end">
                <TouchableOpacity
                  onPress={handleRequestClose}
                  accessibilityRole="button"
                  accessibilityLabel="Close inline comments"
                  className="h-8 w-8 items-center justify-center rounded-full"
                  style={{ backgroundColor: closeButtonBackgroundColor }}
                >
                  <MaterialCommunityIcons name="close" size={18} color={theme.icon} />
                </TouchableOpacity>
              </View>
            </View>

            <FlatList
              ref={commentsListRef}
              data={initialLoading ? INLINE_COMMENT_SKELETON_ITEMS : comments}
              keyExtractor={(item) => (initialLoading ? String(item) : item?.$id || `${item?.comment}-${item?.$createdAt}`)}
              renderItem={initialLoading ? renderCommentSkeletonItem : renderCommentItem}
              ListHeaderComponent={listHeader}
              contentContainerStyle={commentListContentContainerStyle}
              showsVerticalScrollIndicator={false}
              nestedScrollEnabled
              keyboardShouldPersistTaps="handled"
              scrollEventThrottle={enableSwipeToClose ? 16 : undefined}
              onLayout={
                enableSwipeToClose
                  ? (event) => {
                      setCommentListViewportHeight(event.nativeEvent.layout.height);
                    }
                  : undefined
              }
              onScroll={
                enableSwipeToClose
                  ? (event) => {
                      setCommentScrollOffset(Math.max(event.nativeEvent.contentOffset.y, 0));
                    }
                  : undefined
              }
              onContentSizeChange={
                enableSwipeToClose
                  ? (_width, height) => {
                      setCommentContentHeight(height);
                    }
                  : undefined
              }
              onEndReachedThreshold={0.3}
              onEndReached={initialLoading ? undefined : fetchMoreComments}
              onScrollBeginDrag={() => {
                setIsComposerFocused(false);
                clearMentionSuggestions();
              }}
              removeClippedSubviews={Platform.OS !== "android"}
              ListEmptyComponent={
                initialLoading ? null : (
                  <View className="flex-1 items-center justify-center px-4 py-8">
                    <Text className="text-center font-sans text-sm" style={{ color: chromeMutedTextColor }}>
                      {backendConfigured
                        ? "No comments yet. Start the thread for this highlighted passage."
                        : "Inline comments are disabled until the Appwrite collections are configured."}
                    </Text>
                  </View>
                )
              }
              ListFooterComponent={
                initialLoading ? (
                  <View className="h-2" />
                ) : hasMore ? (
                  <View className="items-center py-4">
                    <LoaderKit style={{ width: 28, height: 28, opacity: 0.35 }} name="LineScale" color={theme.primary} />
                  </View>
                ) : (
                  <View className="h-2" />
                )
              }
            />
          </View>

          {showMentionSuggestions && isComposerFocused ? (
            <UserMention
              variant="suggestions"
              suggestions={mentionSuggestions}
              selectedUserIds={selectedMentionUsers.map((selectedUser) => String(selectedUser?.$id || "")).filter(Boolean)}
              ready={mentionReady}
              onSelect={handleMentionSelect}
              onSelectStart={(mentionUser) => {
                mentionSelectionInProgressRef.current = true;
                pendingMentionSelectionRef.current = mentionUser;
              }}
              activeOpacity={1}
              nestedScrollEnabled
              containerClassName={mentionSuggestionContainerClassName}
              containerStyle={{ zIndex: 30, elevation: 30, borderTopColor: theme.border, backgroundColor: theme.surfaceElevated }}
              itemClassName={mentionSuggestionItemClassName}
              selectedItemClassName={mentionSuggestionSelectedItemClassName}
              avatarClassName={mentionSuggestionAvatarClassName}
            />
          ) : null}

          <View
            className="border-t px-4 py-3"
            style={{ borderTopColor: surfaceBorderColor, paddingBottom: insets.bottom, backgroundColor: theme.surfaceElevated }}
          >
            {replyTarget ? (
              <View
                className="mb-2 flex-row items-center justify-between rounded-lg border px-4 py-2"
                style={{ borderColor: theme.accentBlue, backgroundColor: theme.accentBlueSoft }}
              >
                <Text className="mr-3 flex-1 font-sans text-xs" style={{ color: chromeMutedTextColor }}>
                  Replying to {replyTarget.username || "comment"}
                </Text>
                <TouchableOpacity onPress={handleCancelReply}>
                  <Text className="font-sans text-xs font-semibold" style={{ color: theme.accentBlue }}>
                    Cancel
                  </Text>
                </TouchableOpacity>
              </View>
            ) : null}

            <View className="flex-row items-center">
              <View
                className="relative flex-1 rounded-2xl border px-4 py-2.5"
                style={{ borderColor: composerBorderColor, backgroundColor: composerBackgroundColor }}
              >
                <TextInput
                  ref={inputRef}
                  onPressIn={handleComposerPressIn}
                  onChangeText={(value) => {
                    handleCommentTextChange(value);
                    if (submitError) setSubmitError("");
                  }}
                  onSelectionChange={handleSelectionChange}
                  onFocus={() => {
                    clearComposerBlurTimeout();
                    setIsComposerFocused(true);
                  }}
                  onBlur={() => {
                    clearComposerBlurTimeout();
                    composerBlurTimeoutRef.current = setTimeout(() => {
                      if (inputRef.current?.isFocused?.()) return;
                      if (mentionSelectionInProgressRef.current) {
                        composerBlurTimeoutRef.current = setTimeout(() => {
                          if (inputRef.current?.isFocused?.()) {
                            clearComposerBlurTimeout();
                            return;
                          }
                          if (!mentionSelectionInProgressRef.current) {
                            clearComposerBlurTimeout();
                            return;
                          }
                          const pendingMentionSelection = pendingMentionSelectionRef.current;
                          if (pendingMentionSelection?.username) {
                            handleMentionSelect(pendingMentionSelection);
                            clearComposerBlurTimeout();
                            return;
                          }
                          mentionSelectionInProgressRef.current = false;
                          setIsComposerFocused(false);
                          clearMentionSuggestions();
                          clearComposerBlurTimeout();
                        }, 180);
                        return;
                      }
                      setIsComposerFocused(false);
                      clearMentionSuggestions();
                      clearComposerBlurTimeout();
                    }, 40);
                  }}
                  placeholder={replyTarget ? "Write a reply..." : backendConfigured ? "Add a comment..." : "Backend setup required"}
                  placeholderTextColor={theme.placeholder}
                  maxLength={300}
                  autoCapitalize="sentences"
                  multiline
                  editable={backendConfigured && (!replyTarget || inlineFeatureFlags.repliesEnabled)}
                  textAlignVertical="top"
                  selectionColor={theme.primary}
                  style={{ maxHeight: 100, color: theme.inputText }}
                  className="font-sans text-sm leading-5"
                >
                  {renderComposerMentionText}
                </TextInput>
              </View>

              <TouchableOpacity onPress={handlePostComment} disabled={!canSubmitComment} className="ml-4">
                <Text className="font-sans text-sm font-semibold" style={{ color: canSubmitComment ? activePostButtonColor : chromeMutedTextColor }}>
                  Post
                </Text>
              </TouchableOpacity>
            </View>

            {submitError ? (
              <Text className="mt-2 font-sans text-xs" style={{ color: theme.danger }}>
                {submitError}
              </Text>
            ) : null}
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
            <View className="flex-row items-center justify-between">
              <View className="flex-row items-center">
                <MaterialIcons name="delete-outline" size={22} color={theme.danger} style={{ marginRight: 12 }} />
                <View>
                  <Text className="text-base font-semibold" style={{ color: theme.text }}>
                    Delete
                  </Text>
                  <Text className="mt-1 text-xs" style={{ color: theme.textSoft }}>
                    {actionTarget?.type === "reply" ? "Remove this reply" : "Remove this comment"}
                  </Text>
                </View>
              </View>
              {isDeletingTarget ? (
                <LoaderKit style={{ width: 16, height: 16, opacity: 0.9 }} name="BallSpinFadeLoader" color={theme.primary} />
              ) : null}
            </View>
          </TouchableOpacity>

          <TouchableOpacity className="mt-3 items-center" onPress={closeActionsSheet} disabled={isDeletingTarget}>
            <Text className="text-sm" style={{ color: theme.textSoft }}>
              Cancel
            </Text>
          </TouchableOpacity>
        </View>
      </Modal>
    </>
  );
};

export default memo(BookInlineCommentModal);
