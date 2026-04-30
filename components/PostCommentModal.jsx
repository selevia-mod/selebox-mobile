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
import useAppTheme from "../hooks/useAppTheme";
import { databases } from "../lib/appwrite";
import { buildPostNotificationResourceId, NotificationService } from "../lib/notifications";
import { consumePostCommentModalDraft, queuePostCommentModalResume } from "../lib/post-comment-modal-resume";
import {
  createPostComment,
  createPostCommentLike,
  createPostReplyComment,
  fetchPostCommentLikesByCommentIds,
  fetchPostCommentRepliesByParentIds,
  fetchPostComments,
  getPost,
  removePostCommentLike,
  threadPostComments,
  updatePost,
} from "../lib/posts";
// Phase C.7 — Supabase comments service. Used when the modal is opened on
// a post adapted by `adaptSupabasePostToAppwriteShape` (detected via the
// `_supabase` mirror field). Same dual-shape branching pattern used in
// PostInformation: existing Appwrite paths run unchanged for Appwrite posts,
// Supabase paths run for Supabase posts.
import {
  addComment as addSupabaseComment,
  deleteComment as deleteSupabaseComment,
  fetchCommentsForPost,
  fetchCommentReactionCounts,
  adaptCommentTreeToAppwriteShape,
  adaptSupabaseCommentToAppwriteShape,
} from "../lib/comments-supabase";
import {
  getMyReactionsForTargets as getMySupabaseReactionsForTargets,
  setReaction as setSupabaseReaction,
  removeMyReaction as removeMySupabaseReaction,
} from "../lib/reactions-supabase";
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
import { DEFAULT_REACTION_KEY, getReactionByKey } from "../lib/reactions";
import secrets from "../private/secrets";
import ReactionPicker from "./ReactionPicker";
import UserMention from "./UserMention";
import UserRoleBadgeIcons from "./UserRoleBadgeIcons";

const SCREEN_HEIGHT = Dimensions.get("window").height;
const PAGE_SIZE = 10;
const INITIAL_VISIBLE_REPLIES = 3;
const SUBMITTED_REPLY_HIGHLIGHT_MS = 3200;
const POST_REPLY_RELATION_KEYS = ["postComment", "postComments", "parentComment", "parentCommentId", "replyToComment"];

const normalizeNotificationTargetId = (value) => {
  if (!value) return null;
  if (Array.isArray(value)) return value[0] || null;
  return String(value);
};

const resolveOwnerId = (owner) => {
  if (!owner) return null;
  if (typeof owner === "string") return owner;
  return owner?.$id || owner?.id || null;
};

const getCommentReplies = (comment) => {
  if (Array.isArray(comment?.postCommentReplies)) return comment.postCommentReplies;
  if (Array.isArray(comment?.postCommentsReplies)) return comment.postCommentsReplies;
  return [];
};

const getCommentLikes = (comment) => {
  if (Array.isArray(comment?.postCommentLikes)) return comment.postCommentLikes;
  if (Array.isArray(comment?.postsCommentLikes)) return comment.postsCommentLikes;
  return [];
};

const PostCommentItem = memo(
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
    onRepliesContainerLayout,
    onReplyLayout,
    renderMentionText,
  }) => {
    const { theme } = useAppTheme();
    const replies = getCommentReplies(item);
    const likes = useMemo(() => getCommentLikes(item), [item?.postCommentLikes, item?.postsCommentLikes]);
    // Phase C.7 — Supabase comments come pre-decorated with `_supabase`
    // (raw row) and `myReaction` (the user's emoji on this comment, or
    // null) by the adapter. We use those to skip the Appwrite-only "scan
    // likeOwner ids" probe and drive the like UI on Supabase posts.
    const isSupabaseComment = Boolean(item?._supabase);
    const supabaseMyReaction = isSupabaseComment ? item?.myReaction || null : null;

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
    const initialLiked = isSupabaseComment
      ? Boolean(supabaseMyReaction)
      : likes.some((like) => String(resolveOwnerId(like?.likeOwner) || "") === normalizedCurrentUserId);
    const [liked, setLiked] = useState(() => initialLiked);
    const [likeCount, setLikeCount] = useState(likes.length);
    const committedLikedRef = useRef(initialLiked);
    const committedCountRef = useRef(likes.length);
    const desiredLikedRef = useRef(committedLikedRef.current);
    const syncInFlightRef = useRef(false);
    const isMountedRef = useRef(true);
    const appliedLikesSignatureRef = useRef(likesSignature);

    // Reaction overlay state. On Supabase comments the picked emoji IS
    // the reaction key in the reactions table (heart/laugh/sad/cry/angry).
    // On Appwrite comments it's local-only UI state — the legacy backend
    // only stores binary like/unlike.
    const [userReactionKey, setUserReactionKey] = useState(() =>
      isSupabaseComment
        ? supabaseMyReaction
        : likes.some((like) => String(resolveOwnerId(like?.likeOwner) || "") === normalizedCurrentUserId)
          ? DEFAULT_REACTION_KEY
          : null,
    );
    // Keep the latest reaction key reachable in async sync without
    // capturing stale closures. Only used by the Supabase write path.
    const userReactionKeyRef = useRef(userReactionKey);
    userReactionKeyRef.current = userReactionKey;
    // Per-reply reactions are local-only — replies don't have backend like wiring yet.
    const [replyReactions, setReplyReactions] = useState({}); // { [replyId]: reactionKey }
    const [pickerVisible, setPickerVisible] = useState(false);
    const [pickerAnchor, setPickerAnchor] = useState(null);
    const [pickerTargetId, setPickerTargetId] = useState(null); // null = top-level, else replyId
    const likeButtonRef = useRef(null);
    const replyButtonRefsMap = useRef(new Map());

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

    const isHighlightedComment = String(item?.$id || "") === highlightedCommentId;
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
      const nextCount = likes.length;
      // Phase C.7 — On Supabase comments the `likes` array is a list of
      // length-only placeholders (the adapter feeds in counts via
      // reactionCounts); placeholders carry no `likeOwner` so the
      // "is mine?" probe below would always evaluate false and
      // silently un-like the comment whenever ANYONE else's reaction
      // shifts the count. Trust the source-of-truth `myReaction` field
      // we hydrated at mount and only sync the count here.
      if (isSupabaseComment) {
        committedCountRef.current = nextCount;
        if (desiredLikedRef.current === committedLikedRef.current) {
          setLikeCount(nextCount);
        }
        return;
      }
      const nextLiked = likes.some((like) => String(resolveOwnerId(like?.likeOwner) || "") === normalizedCurrentUserId);
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
    }, [applyOptimisticLikeState, isSupabaseComment, likes, likesSignature, normalizedCurrentUserId]);

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

              // Phase C.7 — Supabase write path. The reactions table
              // is the source of truth; we just mirror the desired
              // emoji or remove the row entirely.
              if (isSupabaseComment) {
                if (nextTargetLiked) {
                  const emoji = userReactionKeyRef.current || DEFAULT_REACTION_KEY;
                  await setSupabaseReaction({ targetType: "comment", targetId: item.$id, emoji });
                } else {
                  await removeMySupabaseReaction({ targetType: "comment", targetId: item.$id });
                }
              } else if (nextTargetLiked) {
                const existingLike = likes.find((like) => String(resolveOwnerId(like?.likeOwner) || "") === normalizedCurrentUserId);
                if (!existingLike) {
                  const newLike = await createPostCommentLike({
                    commentId: item.$id,
                    likeOwner: normalizedCurrentUserId,
                  });
                  if (!newLike) throw new Error("Post comment like not created");
                }
              } else {
                await removePostCommentLike({
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
    }, [applyOptimisticLikeState, isSupabaseComment, item?.$id, likes, normalizedCurrentUserId]);

    const handleLikeComment = useCallback(() => {
      if (!item?.$id || !normalizedCurrentUserId) return;

      const nextDesiredLiked = !desiredLikedRef.current;
      desiredLikedRef.current = nextDesiredLiked;
      applyOptimisticLikeState(nextDesiredLiked);
      syncLikeMutation();
    }, [applyOptimisticLikeState, item?.$id, normalizedCurrentUserId, syncLikeMutation]);

    // ── Reaction handlers (top-level comment) ──
    const handleReactionTap = useCallback(() => {
      if (!item?.$id || !normalizedCurrentUserId) return;
      if (userReactionKey) {
        setUserReactionKey(null);
        // Clear server-side like too
        if (desiredLikedRef.current) {
          desiredLikedRef.current = false;
          applyOptimisticLikeState(false);
          syncLikeMutation();
        }
      } else {
        setUserReactionKey(DEFAULT_REACTION_KEY);
        if (!desiredLikedRef.current) {
          desiredLikedRef.current = true;
          applyOptimisticLikeState(true);
          syncLikeMutation();
        }
      }
    }, [applyOptimisticLikeState, item?.$id, normalizedCurrentUserId, syncLikeMutation, userReactionKey]);

    const handleReactionLongPress = useCallback(() => {
      if (!item?.$id || !normalizedCurrentUserId) return;
      likeButtonRef.current?.measureInWindow?.((x, y, width, height) => {
        setPickerAnchor({ x, y, width, height });
        setPickerTargetId(null);
        setPickerVisible(true);
      });
    }, [item?.$id, normalizedCurrentUserId]);

    // ── Reaction handlers (reply) ──
    const handleReplyReactionTap = useCallback((replyId) => {
      if (!replyId) return;
      setReplyReactions((prev) => {
        const next = { ...prev };
        if (next[replyId]) delete next[replyId];
        else next[replyId] = DEFAULT_REACTION_KEY;
        return next;
      });
    }, []);

    const handleReplyReactionLongPress = useCallback((replyId) => {
      if (!replyId) return;
      const buttonRef = replyButtonRefsMap.current.get(replyId);
      buttonRef?.measureInWindow?.((x, y, width, height) => {
        setPickerAnchor({ x, y, width, height });
        setPickerTargetId(replyId);
        setPickerVisible(true);
      });
    }, []);

    // ── Picker selection — routes by pickerTargetId ──
    const handlePickReaction = useCallback(
      (key) => {
        if (pickerTargetId === null) {
          // Top-level comment
          const previousKey = userReactionKeyRef.current;
          setUserReactionKey(key);
          userReactionKeyRef.current = key;
          if (!desiredLikedRef.current) {
            desiredLikedRef.current = true;
            applyOptimisticLikeState(true);
            syncLikeMutation();
          } else if (isSupabaseComment && previousKey !== key && item?.$id) {
            // Already liked but switching emoji — write directly via
            // setReaction. We bypass syncLikeMutation here because that
            // loop would treat this as a like-toggle and inflate the
            // count. setReaction is idempotent so a no-op'd same-emoji
            // pick is safe.
            void setSupabaseReaction({ targetType: "comment", targetId: item.$id, emoji: key }).catch((error) => {
              console.log("handlePickReaction: setReaction (supabase) error", error);
            });
          }
        } else {
          // Reply
          setReplyReactions((prev) => ({ ...prev, [pickerTargetId]: key }));
        }
      },
      [applyOptimisticLikeState, isSupabaseComment, item?.$id, pickerTargetId, syncLikeMutation],
    );

    const closePicker = useCallback(() => setPickerVisible(false), []);

    const activeReaction = userReactionKey ? getReactionByKey(userReactionKey) : null;
    const pickerActiveKey = pickerTargetId === null ? userReactionKey : (replyReactions[pickerTargetId] ?? null);

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
                  ref={likeButtonRef}
                  onPress={handleReactionTap}
                  onLongPress={handleReactionLongPress}
                  delayLongPress={220}
                  disabled={!normalizedCurrentUserId}
                  hitSlop={{ top: 6, right: 6, bottom: 6, left: 6 }}
                  style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
                >
                  {activeReaction ? (
                    <Text style={{ fontSize: 13, lineHeight: 16 }}>{activeReaction.emoji}</Text>
                  ) : (
                    <Text className="font-sans text-xs font-semibold" style={{ color: theme.textSoft }}>
                      React
                    </Text>
                  )}
                  {likeCount > 0 ? (
                    <Text className="font-sans text-xs font-semibold" style={{ color: activeReaction ? theme.like : theme.textSoft }}>
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
                <View
                  className="mt-3 border-l pl-3"
                  style={{ borderLeftColor: theme.border }}
                  onLayout={(event) => onRepliesContainerLayout?.(item?.$id, event)}
                >
                  {!showReplies ? (
                    <TouchableOpacity onPress={onToggleReplies}>
                      <Text className="font-sans text-xs" style={{ color: theme.textSoft }}>
                        View {replies.length === 1 ? "1 reply" : `${replies.length} replies`}
                      </Text>
                    </TouchableOpacity>
                  ) : (
                    <>
                      {visibleReplies.map((reply) => (
                        <View
                          key={reply?.$id}
                          className="mb-3 flex-row items-start space-x-2"
                          onLayout={(event) => onReplyLayout?.(item?.$id, reply?.$id, event)}
                        >
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
                                ref={(el) => {
                                  if (el) replyButtonRefsMap.current.set(reply.$id, el);
                                  else replyButtonRefsMap.current.delete(reply.$id);
                                }}
                                onPress={() => handleReplyReactionTap(reply.$id)}
                                onLongPress={() => handleReplyReactionLongPress(reply.$id)}
                                delayLongPress={220}
                                disabled={!normalizedCurrentUserId}
                                hitSlop={{ top: 6, right: 6, bottom: 6, left: 6 }}
                                style={{ flexDirection: "row", alignItems: "center" }}
                              >
                                {replyReactions[reply.$id] ? (
                                  <Text style={{ fontSize: 13, lineHeight: 16 }}>{getReactionByKey(replyReactions[reply.$id])?.emoji}</Text>
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
          visible={pickerVisible}
          anchor={pickerAnchor}
          activeKey={pickerActiveKey}
          onSelect={handlePickReaction}
          onClose={closePicker}
        />
      </View>
    );
  },
);

const PostCommentModal = ({
  item,
  isVisible,
  onClose,
  onCommentPosted,
  focusCommentId,
  focusReplyId,
  resumeScope,
  resumeToken,
  coverScreen = true,
}) => {
  const postID = item?.$id;
  // Phase C.7 — detect Supabase-shape posts. The home feed adapter sets
  // `_supabase` to the raw Supabase row; that's our signal to read/write
  // through Supabase's `comments` + `reactions` tables instead of Appwrite.
  const isSupabasePost = Boolean(item?._supabase);
  const insets = useSafeAreaInsets();
  const { user } = useGlobalContext();
  const { theme } = useAppTheme();
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
  const [allowExternalFocus, setAllowExternalFocus] = useState(true);
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  const [commentListScrollOffset, setCommentListScrollOffset] = useState(0);
  const [commentListContentHeight, setCommentListContentHeight] = useState(0);
  const [commentListLayoutHeight, setCommentListLayoutHeight] = useState(0);
  const [actionsSheetVisible, setActionsSheetVisible] = useState(false);
  const [actionTarget, setActionTarget] = useState(null);
  const [isDeletingTarget, setIsDeletingTarget] = useState(false);
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
  const commentItemOffsetsRef = useRef(new Map());
  const replyContainerOffsetsRef = useRef(new Map());
  const replyOffsetsRef = useRef(new Map());
  const replyAbsoluteOffsetsRef = useRef(new Map());
  const pendingFocusedScrollRef = useRef(false);
  const autoFocusScrollEnabledRef = useRef(false);
  const rawCommentsRef = useRef([]);
  const lastIdRef = useRef(null);
  const hasMoreRef = useRef(false);

  const normalizedFocusCommentId = normalizeNotificationTargetId(focusCommentId);
  const normalizedFocusReplyId = normalizeNotificationTargetId(focusReplyId);
  const effectiveFocusCommentId = allowExternalFocus ? normalizedFocusCommentId : null;
  const effectiveFocusReplyId = allowExternalFocus ? normalizedFocusReplyId : null;
  const focusedTargetCommentId = useMemo(() => {
    if (effectiveFocusCommentId) return effectiveFocusCommentId;
    if (!effectiveFocusReplyId) return null;

    const targetComment = comments.find((comment) => getCommentReplies(comment).some((reply) => String(reply?.$id || "") === effectiveFocusReplyId));
    return targetComment?.$id ? String(targetComment.$id) : null;
  }, [comments, effectiveFocusCommentId, effectiveFocusReplyId]);

  const clearMeasuredOffsets = useCallback(() => {
    commentItemOffsetsRef.current.clear();
    replyContainerOffsetsRef.current.clear();
    replyOffsetsRef.current.clear();
    replyAbsoluteOffsetsRef.current.clear();
  }, []);

  const disableAutoFocusScroll = useCallback(() => {
    autoFocusScrollEnabledRef.current = false;
    pendingFocusedScrollRef.current = false;
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

  useEffect(() => {
    clearMeasuredOffsets();
  }, [clearMeasuredOffsets, postID]);

  useEffect(() => {
    autoFocusScrollEnabledRef.current = enableAutoFocusScroll && Boolean(normalizedFocusCommentId || normalizedFocusReplyId);
    if (!autoFocusScrollEnabledRef.current) {
      pendingFocusedScrollRef.current = false;
    }
  }, [enableAutoFocusScroll, normalizedFocusCommentId, normalizedFocusReplyId]);

  const hydrateThreadedComments = useCallback(async (nextRawComments = []) => {
    if (!Array.isArray(nextRawComments) || nextRawComments.length === 0) {
      return [];
    }

    const parentCommentIds = nextRawComments.map((comment) => comment?.$id).filter(Boolean);
    const [repliesResult, likesResult] = await Promise.all([
      fetchPostCommentRepliesByParentIds({ parentCommentIds, limit: 500 }),
      fetchPostCommentLikesByCommentIds({ commentIds: parentCommentIds, limit: 1000 }),
    ]);
    const threadedComments = threadPostComments(nextRawComments, repliesResult?.byParentId || {});

    return threadedComments.map((comment) => ({
      ...comment,
      postCommentLikes: likesResult?.byCommentId?.[comment?.$id] || getCommentLikes(comment),
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
      const selectedMentionedUsersSnapshot = Array.from(selectedMentionMapRef.current.values()).filter((mentionedUser) => mentionedUser?.$id);
      queuePostCommentModalResume({
        scope: resumeScope,
        postId: postID,
        postSnapshot: item,
        draft: {
          text: commentText,
          selectedMentionUsers: selectedMentionedUsersSnapshot,
          replyTarget,
        },
      });
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
    [closeModalForNavigation, commentText, item, postID, replyTarget, resumeScope, user?.$id],
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

  const fetchComments = useCallback(
    async (loadMore = false) => {
      if (!postID) return;
      const currentLastId = lastIdRef.current;
      const currentHasMore = hasMoreRef.current;
      const currentRawComments = rawCommentsRef.current;
      if (loadMore && (!currentLastId || !currentHasMore)) return;

      try {
        if (!loadMore) setLoading(true);

        // Phase C.7 — Supabase posts read all comments + replies in one
        // round trip (web's loadComments pattern). No pagination yet:
        // posts on the home feed have small comment counts, and the
        // single-query path keeps the modal snappy. Pagination can land
        // in a follow-up if a post genuinely has hundreds of comments.
        if (isSupabasePost) {
          const tree = await fetchCommentsForPost(postID);
          const parentIds = (tree.parents || []).map((p) => p.id);
          const replyIds = Object.values(tree.repliesByParent || {})
            .flat()
            .map((r) => r.id);
          const allCommentIds = [...parentIds, ...replyIds];
          const [reactionCounts, myReactions] = await Promise.all([
            allCommentIds.length ? fetchCommentReactionCounts(allCommentIds) : Promise.resolve({}),
            allCommentIds.length ? getMySupabaseReactionsForTargets({ targetType: "comment", targetIds: allCommentIds }) : Promise.resolve({}),
          ]);
          const adapted = adaptCommentTreeToAppwriteShape(tree, { reactionCounts, myReactions });
          // The "raw" cache mirrors the parents (Supabase rows), so that
          // optimistic appends on submit can rebuild the adapted view.
          setRawCommentsState(tree.parents || []);
          setComments(adapted);
          setLastIdState(null);
          setHasMoreState(false);
          return;
        }

        const commentsData = await fetchPostComments({
          postId: postID,
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
      } catch (error) {
        console.log("fetchComments: error", error);
      } finally {
        if (!loadMore) setLoading(false);
      }
    },
    [hydrateThreadedComments, isSupabasePost, postID, setHasMoreState, setLastIdState, setRawCommentsState],
  );

  useEffect(() => {
    if (!isVisible || !postID) return;
    fetchComments(false);
  }, [fetchComments, isVisible, postID]);

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
    setAllowExternalFocus(Boolean(normalizedFocusCommentId || normalizedFocusReplyId));
    setIsComposerFocused(false);
    setCommentListScrollOffset(0);
    setCommentListContentHeight(0);
    setCommentListLayoutHeight(0);
    setHighlightedCommentId(null);
    setHighlightedReplyId(null);
    setActionsSheetVisible(false);
    setActionTarget(null);
    setIsDeletingTarget(false);
    disableAutoFocusScroll();
    clearMeasuredOffsets();
    selectedMentionMapRef.current.clear();
    mentionUserCacheRef.current.clear();
    committedMentionRangeRef.current = null;
    selectionRef.current = null;
  }, [
    clearMeasuredOffsets,
    disableAutoFocusScroll,
    isVisible,
    normalizedFocusCommentId,
    normalizedFocusReplyId,
    setHasMoreState,
    setLastIdState,
    setRawCommentsState,
  ]);

  useEffect(() => {
    if (!isVisible || !postID || !resumeToken) return;

    const restoredDraft = consumePostCommentModalDraft({ token: resumeToken, postId: postID });
    if (!restoredDraft) return;

    const restoredText = String(restoredDraft?.text || "");
    const restoredMentionMap = new Map();

    (restoredDraft?.selectedMentionUsers || []).forEach((mentionedUser) => {
      if (!mentionedUser?.$id) return;
      const mentionToken = normalizeMentionToken(mentionedUser?.username || mentionedUser?.name || "");
      if (!mentionToken) return;
      restoredMentionMap.set(mentionToken, mentionedUser);
      mentionUserCacheRef.current.set(mentionToken, mentionedUser);
    });

    selectedMentionMapRef.current = restoredMentionMap;
    setSelectedMentionUsers(Array.from(restoredMentionMap.values()));
    setReplyTarget(restoredDraft?.replyTarget || null);
    setCommentText(restoredText);
    selectionRef.current = {
      start: restoredText.length,
      end: restoredText.length,
    };
    committedMentionRangeRef.current = null;
    clearMentionSuggestions();

    setTimeout(() => {
      inputRef.current?.focus();
    }, 0);
  }, [clearMentionSuggestions, isVisible, postID, resumeToken]);

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

  const deleteDocumentFromCollections = useCallback(async (documentId, collectionIds = []) => {
    let lastError = null;

    for (const collectionId of collectionIds.filter(Boolean)) {
      try {
        await databases.deleteDocument(secrets.appwriteConfig.databaseId, collectionId, documentId);
        return true;
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError) throw lastError;
    return false;
  }, []);

  const handleDeleteReply = useCallback(
    async (commentId, reply) => {
      const normalizedCommentId = String(commentId || "");
      const replyId = String(reply?.$id || "");
      if (!normalizedCommentId || !replyId || !isOwnedByCurrentUser(reply?.commentOwner)) return;

      try {
        // Phase C.7 — Supabase replies live in the same `comments` table
        // as parents (just with parent_id set), so a single DELETE by id
        // covers them. The Appwrite path needs to try both collections
        // (replies live separately there).
        if (isSupabasePost) {
          await deleteSupabaseComment(replyId);
        } else {
          await deleteDocumentFromCollections(replyId, [
            secrets.appwriteConfig.postsCommentRepliesCollectionId,
            secrets.appwriteConfig.postsCommentCollectionId,
          ]);
        }

        setComments((prev) =>
          prev.map((commentItem) =>
            String(commentItem?.$id || "") === normalizedCommentId
              ? {
                  ...commentItem,
                  postCommentReplies: getCommentReplies(commentItem).filter((existingReply) => String(existingReply?.$id || "") !== replyId),
                }
              : commentItem,
          ),
        );
      } catch (error) {
        console.log("handleDeleteReply: error", error);
      }
    },
    [deleteDocumentFromCollections, isOwnedByCurrentUser, isSupabasePost],
  );

  const handleDeleteComment = useCallback(
    async (comment) => {
      const commentId = String(comment?.$id || "");
      if (!commentId || !isOwnedByCurrentUser(comment?.commentOwner)) return;

      try {
        // Phase C.7 — Supabase delete path. Replies share a table with
        // their parent (parent_id FK), so deleting all replies first then
        // the parent is a couple of cheap DELETEs. The Appwrite path has
        // to walk multiple collections + handle relation-key drift.
        if (isSupabasePost) {
          const localReplies = getCommentReplies(comment).filter((reply) => reply?.$id);
          await Promise.all(
            localReplies.map((reply) =>
              deleteSupabaseComment(String(reply.$id)).catch((error) => {
                console.log("handleDeleteComment (supabase): reply delete error", error);
              }),
            ),
          );
          await deleteSupabaseComment(commentId);
        } else {
          const localReplies = getCommentReplies(comment).filter((reply) => reply?.$id);
          await Promise.all(
            localReplies.map((reply) =>
              deleteDocumentFromCollections(String(reply.$id), [
                secrets.appwriteConfig.postsCommentRepliesCollectionId,
                secrets.appwriteConfig.postsCommentCollectionId,
              ]).catch((error) => {
                console.log("handleDeleteComment: local reply delete error", error);
              }),
            ),
          );

          const repliesCollectionId = secrets.appwriteConfig.postsCommentRepliesCollectionId;
          if (repliesCollectionId) {
            for (const relationKey of POST_REPLY_RELATION_KEYS) {
              try {
                const relationReplies = await databases.listDocuments(secrets.appwriteConfig.databaseId, repliesCollectionId, [
                  Query.equal(relationKey, commentId),
                  Query.limit(200),
                ]);

                await Promise.all(
                  (relationReplies?.documents || [])
                    .filter((reply) => reply?.$id)
                    .map((reply) =>
                      deleteDocumentFromCollections(String(reply.$id), [repliesCollectionId, secrets.appwriteConfig.postsCommentCollectionId]).catch(
                        (error) => {
                          console.log("handleDeleteComment: relation reply delete error", error);
                        },
                      ),
                    ),
                );
                break;
              } catch (error) {
                // Keep trying possible relation keys until one succeeds.
              }
            }
          }

          await databases.deleteDocument(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.postsCommentCollectionId, commentId);
        }

        setRawCommentsState((prev) => {
          const next = prev.filter((existingComment) => String(existingComment?.$id || "") !== commentId);
          const nextCount = Math.max(0, next.length);
          onCommentPosted?.(nextCount);
          // Counts on Supabase posts are derived from the comments table —
          // skip the legacy `updatePost` denormalization step. Appwrite
          // posts continue to need it.
          if (postID && !isSupabasePost) void updatePost({ ID: postID, postComments: nextCount });
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
    [deleteDocumentFromCollections, isOwnedByCurrentUser, isSupabasePost, onCommentPosted, postID, replyTarget?.id, setRawCommentsState],
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
      if (!user?.$id || !postID || !commentId) return;

      const resourceId = buildPostNotificationResourceId({
        postId: postID,
        commentId,
        ...(isReply && replyId ? { replyId } : {}),
      });

      const notifiedIds = new Set();
      const notificationType = isReply ? "post-reply" : "post-comment";

      try {
        if (isReply) {
          const resolvedRecipient = await resolveRecipientForNotification(replyRecipient);
          if (resolvedRecipient?.$id && String(resolvedRecipient.$id) !== String(user.$id)) {
            notifiedIds.add(String(resolvedRecipient.$id));
            await notificationService.notifyUser({
              sender: user,
              recipient: resolvedRecipient,
              type: "post-reply",
              resourceId,
              message: "replied to your comment",
            });
          }
        } else {
          let postOwner = await resolveRecipientForNotification(item?.postOwner);
          if (!postOwner && postID) {
            try {
              const postDocument = await getPost({ ID: postID });
              postOwner = await resolveRecipientForNotification(postDocument?.postOwner);
            } catch (error) {
              console.log("notifyCommentRecipients: fetch post owner error", error);
            }
          }
          if (postOwner?.$id && String(postOwner.$id) !== String(user.$id)) {
            notifiedIds.add(String(postOwner.$id));
            await notificationService.notifyUser({
              sender: user,
              recipient: postOwner,
              type: "post-comment",
              resourceId,
              message: "commented on your post",
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
      item?.postOwner,
      normalizeMentionUsernames,
      notificationService,
      postID,
      resolveMentionedUsers,
      resolveRecipientForNotification,
      user,
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

      // Reply-on-reply: prefill the composer with @username so the reply
      // visually addresses the original reply author, while threading to the
      // top-level parent (matches web's flat-thread model in app.js renderComment).
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
    if (!postID || !user?.$id || isSubmitting || !commentText.trim()) return;

    const trimmedComment = commentText.trim();
    const isReply = Boolean(replyTarget);
    const replyContext = replyTarget;
    setAllowExternalFocus(false);
    disableAutoFocusScroll();
    const selectedMentionedUsersSnapshot = Array.from(selectedMentionMapRef.current.values()).filter((mentionedUser) => mentionedUser?.$id);
    const persistedCommentText = serializeMentionsForStorage(trimmedComment, selectedMentionedUsersSnapshot);
    setIsSubmitting(true);

    setCommentText("");
    selectedMentionMapRef.current.clear();
    setSelectedMentionUsers([]);
    committedMentionRangeRef.current = null;
    clearMentionSuggestions();
    if (isReply) {
      setReplyTarget(null);
    }

    try {
      if (replyContext?.id) {
        // Phase C.7 — Supabase reply path. addComment with parent_id makes
        // it a reply on the same post. The returned row carries the joined
        // profile so we can adapt it directly into the modal's local list
        // without a follow-up read.
        let newReply;
        if (isSupabasePost) {
          const supabaseReply = await addSupabaseComment({
            postId: postID,
            parentId: replyContext.id,
            body: persistedCommentText,
          });
          newReply = adaptSupabaseCommentToAppwriteShape(supabaseReply);
        } else {
          newReply = await createPostReplyComment({
            postId: postID,
            comment: persistedCommentText,
            commentOwner: user.$id,
            parentCommentId: replyContext.id,
          });
        }

        setComments((prevComments) =>
          prevComments.map((existingComment) =>
            String(existingComment?.$id || "") === String(replyContext.id)
              ? {
                  ...existingComment,
                  postCommentReplies: [...getCommentReplies(existingComment), newReply],
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
        // Notifications stay on the Appwrite path for now — Supabase posts
        // hand off to web's notification stack (next phase).
        if (!isSupabasePost) {
          void notifyCommentRecipients({
            text: persistedCommentText,
            isReply: true,
            commentId: replyContext.id,
            replyId: newReply?.$id,
            replyRecipient: replyContext.recipient,
            selectedMentionedUsers: selectedMentionedUsersSnapshot,
          });
        }
      } else {
        // Phase C.7 — Supabase top-level comment path. Insert returns the
        // adapted row; we append to both the raw cache (Supabase row) and
        // the rendered list (Appwrite-shaped). Counts are derived from the
        // reactions/comments tables so we skip the legacy `updatePost`
        // denormalization step.
        if (isSupabasePost) {
          const supabaseRow = await addSupabaseComment({
            postId: postID,
            body: persistedCommentText,
          });
          const adaptedRow = adaptSupabaseCommentToAppwriteShape(supabaseRow);
          const nextRawComments = [...rawCommentsRef.current, supabaseRow];
          const nextThreadedComments = [...comments, adaptedRow];
          setRawCommentsState(nextRawComments);
          setComments(nextThreadedComments);
          const nextCount = Math.max(0, nextThreadedComments.length);
          onCommentPosted?.(nextCount);
          // Notification path is Appwrite-only today; skip for Supabase
          // posts. The web project ships its own notification stack on
          // Supabase, and mobile will pick that up in a later phase.
        } else {
          const newComment = await createPostComment({
            postId: postID,
            comment: persistedCommentText,
            commentOwner: user.$id,
          });

          const nextRawComments = [...rawCommentsRef.current, newComment];
          const nextThreadedComments = await hydrateThreadedComments(nextRawComments);
          setRawCommentsState(nextRawComments);
          setComments(nextThreadedComments);
          const nextCount = Math.max(0, nextThreadedComments.length);
          onCommentPosted?.(nextCount);
          await updatePost({ ID: postID, postComments: nextCount });
          void notifyCommentRecipients({
            text: persistedCommentText,
            isReply: false,
            commentId: newComment?.$id,
            selectedMentionedUsers: selectedMentionedUsersSnapshot,
          });
        }
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
    disableAutoFocusScroll,
    highlightSubmittedReply,
    hydrateThreadedComments,
    isSubmitting,
    notifyCommentRecipients,
    onCommentPosted,
    postID,
    replyTarget,
    setRawCommentsState,
    user?.$id,
  ]);

  useEffect(() => {
    if (highlightTimeoutRef.current) {
      clearTimeout(highlightTimeoutRef.current);
      highlightTimeoutRef.current = null;
    }

    if (!isVisible || (!effectiveFocusCommentId && !effectiveFocusReplyId)) {
      if (submittedReplyHighlightTimeoutRef.current) return;
      setHighlightedCommentId(null);
      setHighlightedReplyId(null);
      return;
    }

    setHighlightedCommentId(effectiveFocusCommentId || focusedTargetCommentId || null);
    setHighlightedReplyId(effectiveFocusReplyId || null);

    highlightTimeoutRef.current = setTimeout(() => {
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
  }, [effectiveFocusCommentId, effectiveFocusReplyId, focusedTargetCommentId, isVisible]);

  useEffect(() => {
    if (!normalizedFocusCommentId && !normalizedFocusReplyId) return;
    setAllowExternalFocus(true);
  }, [normalizedFocusCommentId, normalizedFocusReplyId]);

  useEffect(() => {
    if (!isVisible || loading || !focusedTargetCommentId) return;
    if (comments.some((comment) => String(comment?.$id || "") === String(focusedTargetCommentId))) return;

    let isCancelled = false;

    const ensureFocusedCommentLoaded = async () => {
      try {
        const focusedComment = await databases.getDocument(
          secrets.appwriteConfig.databaseId,
          secrets.appwriteConfig.postsCommentCollectionId,
          focusedTargetCommentId,
        );
        if (!focusedComment || isCancelled) return;

        const [hydratedFocusedComment] = await hydrateThreadedComments([focusedComment]);
        if (!hydratedFocusedComment || isCancelled) return;

        setRawCommentsState((prev) =>
          prev.some((comment) => String(comment?.$id || "") === String(focusedTargetCommentId)) ? prev : [...prev, focusedComment],
        );
        setComments((prev) =>
          prev.some((comment) => String(comment?.$id || "") === String(focusedTargetCommentId)) ? prev : [...prev, hydratedFocusedComment],
        );
      } catch (error) {
        console.log("ensureFocusedCommentLoaded: error", error);
      }
    };

    void ensureFocusedCommentLoaded();

    return () => {
      isCancelled = true;
    };
  }, [comments, focusedTargetCommentId, hydrateThreadedComments, isVisible, loading, setRawCommentsState]);

  useEffect(() => {
    if (!isVisible || !focusedTargetCommentId) return;

    const targetComment = comments.find((comment) => String(comment?.$id || "") === String(focusedTargetCommentId));
    if (!targetComment) return;

    const replies = getCommentReplies(targetComment);
    const isFocusedComment = effectiveFocusCommentId && String(effectiveFocusCommentId) === String(focusedTargetCommentId);
    const focusedReplyIndex = effectiveFocusReplyId ? replies.findIndex((reply) => String(reply?.$id || "") === String(effectiveFocusReplyId)) : -1;
    const minimumVisibleCount = isFocusedComment
      ? Math.max(INITIAL_VISIBLE_REPLIES, replies.length)
      : focusedReplyIndex >= 0
        ? Math.max(INITIAL_VISIBLE_REPLIES, focusedReplyIndex + 1)
        : INITIAL_VISIBLE_REPLIES;

    setReplyPanelsByCommentId((prev) => {
      const currentPanel = prev[String(focusedTargetCommentId)] || {};
      const nextVisibleCount = Math.max(minimumVisibleCount, Number(currentPanel?.visibleCount || INITIAL_VISIBLE_REPLIES));

      if (currentPanel?.showReplies && Number(currentPanel?.visibleCount || 0) === nextVisibleCount) {
        return prev;
      }

      return {
        ...prev,
        [String(focusedTargetCommentId)]: {
          showReplies: true,
          visibleCount: nextVisibleCount,
        },
      };
    });
  }, [comments, effectiveFocusCommentId, effectiveFocusReplyId, focusedTargetCommentId, isVisible]);

  const syncReplyAbsoluteOffsetsForComment = useCallback((commentId) => {
    const normalizedCommentId = String(commentId || "");
    if (!normalizedCommentId) return;

    const commentOffset = commentItemOffsetsRef.current.get(normalizedCommentId);
    const replyContainerOffset = replyContainerOffsetsRef.current.get(normalizedCommentId);
    if (typeof commentOffset !== "number" || typeof replyContainerOffset !== "number") return;

    replyOffsetsRef.current.forEach((entry, replyId) => {
      if (String(entry?.commentId || "") !== normalizedCommentId || typeof entry?.offset !== "number") return;

      replyAbsoluteOffsetsRef.current.set(String(replyId), {
        commentId: normalizedCommentId,
        offset: commentOffset + replyContainerOffset + entry.offset,
      });
    });
  }, []);

  const scrollToMeasuredFocusedTarget = useCallback(
    (animated = true) => {
      if (!autoFocusScrollEnabledRef.current || !focusedTargetCommentId || !listRef.current) return false;

      const normalizedCommentId = String(focusedTargetCommentId || "");
      const normalizedReplyId = String(effectiveFocusReplyId || "");
      const targetIndex = comments.findIndex((comment) => String(comment?.$id || "") === normalizedCommentId);
      if (targetIndex === -1) return false;
      const measuredCommentOffset = commentItemOffsetsRef.current.get(normalizedCommentId);
      const hasReliableCommentOffset = typeof measuredCommentOffset === "number" && (targetIndex === 0 || measuredCommentOffset > 0);

      if (normalizedReplyId && hasReliableCommentOffset) {
        const measuredReply = replyAbsoluteOffsetsRef.current.get(normalizedReplyId);
        if (measuredReply?.commentId === normalizedCommentId && typeof measuredReply?.offset === "number") {
          pendingFocusedScrollRef.current = false;
          autoFocusScrollEnabledRef.current = false;
          listRef.current.scrollToOffset({
            offset: Math.max(0, measuredReply.offset - 36),
            animated,
          });
          return true;
        }
      }

      if (hasReliableCommentOffset) {
        pendingFocusedScrollRef.current = Boolean(normalizedReplyId);
        if (!normalizedReplyId) {
          autoFocusScrollEnabledRef.current = false;
        }
        listRef.current.scrollToOffset({
          offset: Math.max(0, measuredCommentOffset - 28),
          animated,
        });
        return true;
      }

      return false;
    },
    [comments, effectiveFocusReplyId, focusedTargetCommentId],
  );

  const requestPendingFocusedScroll = useCallback(() => {
    if (!autoFocusScrollEnabledRef.current || !pendingFocusedScrollRef.current) return;
    requestAnimationFrame(() => {
      scrollToMeasuredFocusedTarget(true);
    });
  }, [scrollToMeasuredFocusedTarget]);

  const handleCommentItemLayout = useCallback(
    (commentId, event) => {
      const normalizedCommentId = String(commentId || "");
      const nextOffset = event?.nativeEvent?.layout?.y;
      if (!normalizedCommentId || typeof nextOffset !== "number") return;

      commentItemOffsetsRef.current.set(normalizedCommentId, nextOffset);
      syncReplyAbsoluteOffsetsForComment(normalizedCommentId);

      if (pendingFocusedScrollRef.current && normalizedCommentId === String(focusedTargetCommentId || "")) {
        requestPendingFocusedScroll();
      }
    },
    [focusedTargetCommentId, requestPendingFocusedScroll, syncReplyAbsoluteOffsetsForComment],
  );

  const handleRepliesContainerLayout = useCallback(
    (commentId, event) => {
      const normalizedCommentId = String(commentId || "");
      const nextOffset = event?.nativeEvent?.layout?.y;
      if (!normalizedCommentId || typeof nextOffset !== "number") return;

      replyContainerOffsetsRef.current.set(normalizedCommentId, nextOffset);
      syncReplyAbsoluteOffsetsForComment(normalizedCommentId);

      if (pendingFocusedScrollRef.current && normalizedCommentId === String(focusedTargetCommentId || "")) {
        requestPendingFocusedScroll();
      }
    },
    [focusedTargetCommentId, requestPendingFocusedScroll, syncReplyAbsoluteOffsetsForComment],
  );

  const handleReplyLayout = useCallback(
    (commentId, replyId, event) => {
      const normalizedCommentId = String(commentId || "");
      const normalizedReplyId = String(replyId || "");
      const nextOffset = event?.nativeEvent?.layout?.y;
      if (!normalizedCommentId || !normalizedReplyId || typeof nextOffset !== "number") return;

      replyOffsetsRef.current.set(normalizedReplyId, {
        commentId: normalizedCommentId,
        offset: nextOffset,
      });
      syncReplyAbsoluteOffsetsForComment(normalizedCommentId);

      if (pendingFocusedScrollRef.current && normalizedReplyId === String(effectiveFocusReplyId || "")) {
        requestPendingFocusedScroll();
      }
    },
    [effectiveFocusReplyId, requestPendingFocusedScroll, syncReplyAbsoluteOffsetsForComment],
  );

  const handleScrollToFocusedComment = useCallback(() => {
    if (!autoFocusScrollEnabledRef.current || !focusedTargetCommentId || !listRef.current || comments.length === 0) return false;

    if (scrollToMeasuredFocusedTarget(true)) {
      return true;
    }

    const targetIndex = comments.findIndex((comment) => String(comment?.$id || "") === focusedTargetCommentId);
    if (targetIndex === -1) return false;

    pendingFocusedScrollRef.current = true;
    listRef.current.scrollToIndex({
      index: targetIndex,
      animated: true,
      viewPosition: effectiveFocusReplyId ? 0.02 : 0.15,
    });
    return true;
  }, [comments, effectiveFocusReplyId, focusedTargetCommentId, scrollToMeasuredFocusedTarget]);

  useEffect(() => {
    if (!isVisible || loading || !focusedTargetCommentId || !autoFocusScrollEnabledRef.current) return;

    pendingFocusedScrollRef.current = true;
    let timer = null;
    const interactionTask = InteractionManager.runAfterInteractions(() => {
      timer = setTimeout(() => {
        handleScrollToFocusedComment();
      }, 220);
    });

    return () => {
      pendingFocusedScrollRef.current = false;
      if (interactionTask?.cancel) interactionTask.cancel();
      if (timer) clearTimeout(timer);
    };
  }, [focusedTargetCommentId, handleScrollToFocusedComment, isVisible, loading]);

  const handleScrollToIndexFailed = useCallback(
    (info) => {
      const fallbackOffset = Math.max(0, Math.max(Number(info?.averageItemLength || 0), 120) * Number(info?.index || 0));
      setTimeout(() => {
        listRef.current?.scrollToOffset({ offset: fallbackOffset, animated: true });
        if (pendingFocusedScrollRef.current) {
          setTimeout(() => {
            handleScrollToFocusedComment();
          }, 120);
        }
      }, 120);
    },
    [handleScrollToFocusedComment],
  );

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
        <View onLayout={(event) => handleCommentItemLayout(commentId, event)}>
          <PostCommentItem
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
            onRepliesContainerLayout={handleRepliesContainerLayout}
            onReplyLayout={handleReplyLayout}
            renderMentionText={renderMentionText}
          />
        </View>
      );
    },
    [
      handleCommentItemLayout,
      handleReplyPress,
      handleRepliesContainerLayout,
      handleReplyLayout,
      highlightedCommentId,
      highlightedReplyId,
      openMentionProfile,
      renderMentionText,
      replyPanelsByCommentId,
      toggleRepliesForComment,
      user?.$id,
      viewMoreRepliesForComment,
      openCommentActions,
      openReplyActions,
    ],
  );

  const commentListScrollOffsetMax = Math.max(0, commentListContentHeight - commentListLayoutHeight);
  const commentListContentContainerStyle =
    comments.length > 0 ? { paddingHorizontal: 16, paddingBottom: 12 } : { paddingHorizontal: 16, paddingBottom: 12, flexGrow: 1 };
  const enableSwipeToClose = Platform.OS === "ios";
  const enableAutoFocusScroll = true;

  return (
    <>
      <Modal
        isVisible={isVisible}
        coverScreen={coverScreen}
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
              // Virtualization tuning — comment rows are heavy (avatar +
              // reactions + replies + mention parsing). RN defaults render
              // too many off-screen and trip the "slow to update" warning.
              initialNumToRender={8}
              maxToRenderPerBatch={6}
              windowSize={10}
              updateCellsBatchingPeriod={50}
              removeClippedSubviews={Platform.OS !== "android"}
              nestedScrollEnabled
              keyboardShouldPersistTaps="handled"
              onEndReached={() => fetchComments(true)}
              onScrollToIndexFailed={handleScrollToIndexFailed}
              onLayout={enableSwipeToClose ? handleCommentListLayout : undefined}
              onContentSizeChange={enableSwipeToClose ? handleCommentListContentSizeChange : undefined}
              onScroll={enableSwipeToClose ? handleCommentListScroll : undefined}
              scrollEventThrottle={enableSwipeToClose ? 16 : undefined}
              onScrollBeginDrag={() => {
                disableAutoFocusScroll();
                setAllowExternalFocus(false);
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
        coverScreen={coverScreen}
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

export default memo(PostCommentModal);
