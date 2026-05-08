import { MaterialIcons } from "@expo/vector-icons";
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
import LoaderKit from "react-native-loader-kit";
import Modal from "react-native-modal";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import { databases } from "../lib/appwrite";
import { BookChapterCommentsService } from "../lib/book-chapter-comments";
import { BookService } from "../lib/books";
import { buildBookChapterNotificationResourceId, NotificationService } from "../lib/notifications";
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
import secrets from "../private/secrets";
import BookChapterCommentItem from "./BookChapterCommentItem";
import UserMention from "./UserMention";
import UserRoleBadgeIcons from "./UserRoleBadgeIcons";

const SCREEN_HEIGHT = Dimensions.get("window").height;
const LIMIT = 10;
const INITIAL_VISIBLE_REPLIES = 3;
const SUBMITTED_REPLY_HIGHLIGHT_MS = 3200;

const resolveOwnerId = (owner) => {
  if (!owner) return null;
  if (typeof owner === "string") return owner;
  return owner?.$id || owner?.id || null;
};

const normalizeNotificationTargetId = (value) => {
  if (!value) return null;
  if (Array.isArray(value)) return value[0] || null;
  return String(value);
};

const getCommentReplies = (comment) =>
  Array.isArray(comment?.booksChaptersCommentReplies) ? comment.booksChaptersCommentReplies : comment?.booksChaptersCommentReplies?.documents || [];

const BookChapterCommentModal = ({ chapter, isVisible, onClose, onCommentPosted, focusCommentId, focusReplyId }) => {
  const chapterID = chapter?.$id;
  const insets = useSafeAreaInsets();
  const { user } = useGlobalContext();
  const { theme } = useAppTheme();

  const [loading, setLoading] = useState(true);
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
  const [commentListScrollOffset, setCommentListScrollOffset] = useState(0);
  const [commentListContentHeight, setCommentListContentHeight] = useState(0);
  const [commentListLayoutHeight, setCommentListLayoutHeight] = useState(0);
  const [highlightedCommentId, setHighlightedCommentId] = useState(null);
  const [highlightedReplyId, setHighlightedReplyId] = useState(null);
  const [allowExternalFocus, setAllowExternalFocus] = useState(true);
  const [actionsSheetVisible, setActionsSheetVisible] = useState(false);
  const [actionTarget, setActionTarget] = useState(null);
  const [isDeletingTarget, setIsDeletingTarget] = useState(false);

  const inputRef = useRef(null);
  const listRef = useRef(null);
  const bookService = useRef(new BookService()).current;
  const notificationService = useRef(new NotificationService()).current;
  const highlightTimeoutRef = useRef(null);
  const mentionTimerRef = useRef(null);
  const mentionSearchRequestIdRef = useRef(0);
  const mentionUserCacheRef = useRef(new Map());
  const selectedMentionMapRef = useRef(new Map());
  const committedMentionRangeRef = useRef(null);
  const selectionRef = useRef(null);
  const submittedHighlightTimeoutRef = useRef(null);
  const mentionSelectionInProgressRef = useRef(false);
  const pendingMentionSelectionRef = useRef(null);
  const composerBlurTimeoutRef = useRef(null);
  const composerPressInRef = useRef(false);
  const commentItemOffsetsRef = useRef(new Map());
  const pendingFocusedScrollRef = useRef(false);
  const autoFocusScrollEnabledRef = useRef(false);
  const revealedFocusKeyRef = useRef(null);
  const lastIdRef = useRef(null);
  const hasMoreRef = useRef(false);

  const normalizedFocusCommentId = normalizeNotificationTargetId(focusCommentId);
  const normalizedFocusReplyId = normalizeNotificationTargetId(focusReplyId);
  const effectiveFocusCommentId = allowExternalFocus ? normalizedFocusCommentId : null;
  const effectiveFocusReplyId = allowExternalFocus ? normalizedFocusReplyId : null;
  const enableSwipeToClose = Platform.OS === "ios";
  const focusedTargetCommentId = useMemo(() => {
    if (effectiveFocusCommentId) return effectiveFocusCommentId;
    if (!effectiveFocusReplyId) return null;

    const targetComment = comments.find((comment) => getCommentReplies(comment).some((reply) => String(reply?.$id || "") === effectiveFocusReplyId));
    return targetComment?.$id ? String(targetComment.$id) : null;
  }, [comments, effectiveFocusCommentId, effectiveFocusReplyId]);

  const clearMeasuredOffsets = useCallback(() => {
    commentItemOffsetsRef.current.clear();
  }, []);

  const disableAutoFocusScroll = useCallback(() => {
    autoFocusScrollEnabledRef.current = false;
    pendingFocusedScrollRef.current = false;
  }, []);

  const setLastIdState = useCallback((value) => {
    const nextValue = typeof value === "function" ? value(lastIdRef.current) : value;
    lastIdRef.current = nextValue || null;
  }, []);

  const setHasMoreState = useCallback((value) => {
    const nextValue = typeof value === "function" ? value(hasMoreRef.current) : value;
    hasMoreRef.current = Boolean(nextValue);
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

  const clearComposerBlurTimeout = useCallback(() => {
    if (composerBlurTimeoutRef.current) {
      clearTimeout(composerBlurTimeoutRef.current);
      composerBlurTimeoutRef.current = null;
    }
  }, []);

  const clearHighlightTimers = useCallback(() => {
    if (highlightTimeoutRef.current) {
      clearTimeout(highlightTimeoutRef.current);
      highlightTimeoutRef.current = null;
    }
    if (submittedHighlightTimeoutRef.current) {
      clearTimeout(submittedHighlightTimeoutRef.current);
      submittedHighlightTimeoutRef.current = null;
    }
  }, []);

  const cacheMentionUsers = useCallback((users = []) => {
    users.forEach((candidate) => {
      const usernameToken = normalizeMentionToken(candidate?.username);
      if (usernameToken && candidate?.$id) mentionUserCacheRef.current.set(usernameToken, candidate);
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
            if (exactUsername?.$id) resolvedUsersMap.set(exactUsername.$id, exactUsername);
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

  const fetchComments = useCallback(
    async (loadMore = false) => {
      const currentLastId = lastIdRef.current;
      const currentHasMore = hasMoreRef.current;
      if (!chapterID || (loadMore && (!currentLastId || !currentHasMore))) return;

      try {
        if (!loadMore) setLoading(true);

        const response = await bookService.fetchBookChapterComments({
          bookChapterId: chapterID,
          limit: LIMIT,
          lastId: loadMore ? currentLastId : undefined,
        });

        const newDocs = response?.documents || [];
        const total = Number(response?.total || 0);

        setComments((prev) => {
          const merged = loadMore ? [...prev, ...newDocs.filter((nextItem) => !prev.some((prevItem) => prevItem?.$id === nextItem?.$id))] : newDocs;
          setHasMoreState(total > 0 ? total > merged.length : newDocs.length === LIMIT);
          return merged;
        });

        setLastIdState(newDocs.at(-1)?.$id || (loadMore ? currentLastId : null));
      } catch (error) {
        console.log("fetchComments error:", error);
      } finally {
        if (!loadMore) setLoading(false);
      }
    },
    [bookService, chapterID, setHasMoreState, setLastIdState],
  );

  useEffect(() => {
    clearMeasuredOffsets();
  }, [chapterID, clearMeasuredOffsets]);

  useEffect(() => {
    clearMeasuredOffsets();
  }, [comments, clearMeasuredOffsets]);

  useEffect(() => {
    autoFocusScrollEnabledRef.current = isVisible && Boolean(normalizedFocusCommentId || normalizedFocusReplyId);
    if (!autoFocusScrollEnabledRef.current) {
      pendingFocusedScrollRef.current = false;
    }
  }, [isVisible, normalizedFocusCommentId, normalizedFocusReplyId]);

  useEffect(() => {
    if (!isVisible || !chapterID) return;
    fetchComments(false);
  }, [chapterID, fetchComments, isVisible]);

  useEffect(() => {
    if (isVisible) return;
    if (mentionTimerRef.current) {
      clearTimeout(mentionTimerRef.current);
      mentionTimerRef.current = null;
    }
    clearComposerBlurTimeout();
    clearHighlightTimers();
    setLoading(true);
    setComments([]);
    setReplyTarget(null);
    setCommentText("");
    setSelectedMentionUsers([]);
    setMentionSuggestions([]);
    setShowMentionSuggestions(false);
    setMentionReady(false);
    setMentionTriggerIndex(null);
    setLastIdState(null);
    setHasMoreState(false);
    setAllowExternalFocus(true);
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
    pendingMentionSelectionRef.current = null;
    revealedFocusKeyRef.current = null;
    clearMeasuredOffsets();
    disableAutoFocusScroll();
  }, [clearComposerBlurTimeout, clearHighlightTimers, clearMeasuredOffsets, disableAutoFocusScroll, isVisible, setHasMoreState, setLastIdState]);

  useEffect(() => {
    if (!normalizedFocusCommentId && !normalizedFocusReplyId) return;
    setAllowExternalFocus(true);
  }, [normalizedFocusCommentId, normalizedFocusReplyId]);

  useEffect(() => {
    if (!isVisible || (!effectiveFocusCommentId && !effectiveFocusReplyId)) {
      if (submittedHighlightTimeoutRef.current) return;
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
    if (!isVisible || loading || !focusedTargetCommentId) return;
    if (comments.some((comment) => String(comment?.$id || "") === String(focusedTargetCommentId))) return;

    let isCancelled = false;

    const ensureFocusedCommentLoaded = async () => {
      try {
        const focusedComment = await databases.getDocument(
          secrets.appwriteConfig.databaseId,
          secrets.appwriteConfig.booksChaptersCommentsCollectionId,
          focusedTargetCommentId,
        );
        if (!focusedComment || isCancelled) return;

        let hydratedReplies = [];
        try {
          const repliesResult = await databases.listDocuments(
            secrets.appwriteConfig.databaseId,
            secrets.appwriteConfig.booksChaptersCommentRepliesCollectionId,
            [Query.equal("bookChapterComment", [focusedTargetCommentId]), Query.orderAsc("$createdAt"), Query.limit(200)],
          );
          hydratedReplies = repliesResult?.documents || [];
        } catch (replyError) {
          console.log("ensureFocusedCommentLoaded: replies fetch error", replyError);
        }

        setComments((prev) => {
          if (prev.some((comment) => String(comment?.$id || "") === String(focusedTargetCommentId))) return prev;
          return [...prev, { ...focusedComment, booksChaptersCommentReplies: hydratedReplies }];
        });
      } catch (error) {
        console.log("ensureFocusedCommentLoaded: error", error);
      }
    };

    void ensureFocusedCommentLoaded();

    return () => {
      isCancelled = true;
    };
  }, [comments, focusedTargetCommentId, isVisible, loading]);

  useEffect(() => {
    if (!isVisible || !focusedTargetCommentId) return;

    const revealKey = `${focusedTargetCommentId}:${effectiveFocusReplyId || ""}`;
    if (revealedFocusKeyRef.current === revealKey) return;

    const targetComment = comments.find((comment) => String(comment?.$id || "") === String(focusedTargetCommentId));
    if (!targetComment) return;

    const replies = getCommentReplies(targetComment);
    const focusedReplyIndex = effectiveFocusReplyId ? replies.findIndex((reply) => String(reply?.$id || "") === String(effectiveFocusReplyId)) : -1;
    const minimumVisibleReplies = focusedReplyIndex >= 0 ? Math.max(INITIAL_VISIBLE_REPLIES, focusedReplyIndex + 1) : INITIAL_VISIBLE_REPLIES;

    setComments((prev) =>
      prev.map((commentItem) =>
        String(commentItem?.$id || "") === String(focusedTargetCommentId)
          ? {
              ...commentItem,
              ...(replies.length > 0
                ? {
                    __forceShowRepliesToken: Date.now(),
                    __forceVisibleReplies: minimumVisibleReplies,
                  }
                : {}),
            }
          : commentItem,
      ),
    );

    revealedFocusKeyRef.current = revealKey;
  }, [comments, effectiveFocusReplyId, focusedTargetCommentId, isVisible]);

  useEffect(() => {
    return () => {
      if (mentionTimerRef.current) clearTimeout(mentionTimerRef.current);
      clearComposerBlurTimeout();
      clearHighlightTimers();
      pendingMentionSelectionRef.current = null;
    };
  }, [clearComposerBlurTimeout, clearHighlightTimers]);

  const closeModalForNavigation = useCallback(() => {
    Keyboard.dismiss();
    clearMentionSuggestions();
    setIsComposerFocused(false);
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
        params: { userId: targetUserId },
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

  const handleUrlPress = useCallback(async (url) => {
    const targetUrl = normalizeExternalUrl(url);
    if (!targetUrl) return;

    try {
      await Linking.openURL(targetUrl);
    } catch (error) {
      console.log("handleUrlPress: error", error);
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
          onUrlPress={handleUrlPress}
        />
      );
    },
    [handleMentionPress, handleUrlPress],
  );

  const renderComposerMentionText = useMemo(() => {
    if (!commentText) return null;

    return (
      <UserMention
        variant="text"
        value={commentText}
        className="font-sans text-sm leading-5"
        mentionClassName="font-sans font-semibold"
        textStyle={{ color: theme.text }}
        mentionStyle={{ color: theme.accentBlue }}
        selectedMentionUsers={selectedMentionUsers}
        onMentionPress={(_username, userId) => {
          if (userId) openMentionProfile(userId);
        }}
      />
    );
  }, [commentText, openMentionProfile, selectedMentionUsers, theme.accentBlue, theme.text]);

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
      if (!user?.$id || !chapterID || !commentId) return;

      const resourceId = buildBookChapterNotificationResourceId({
        chapterId: chapterID,
        commentId,
        ...(isReply && replyId ? { replyId } : {}),
      });

      const notifiedIds = new Set();
      const notificationType = isReply ? "book-chapter-reply" : "book-chapter-comment";

      try {
        if (isReply) {
          const resolvedRecipient = await resolveRecipientForNotification(replyRecipient);
          if (resolvedRecipient?.$id && String(resolvedRecipient.$id) !== String(user.$id)) {
            notifiedIds.add(String(resolvedRecipient.$id));
            await notificationService.notifyUser({
              sender: user,
              recipient: resolvedRecipient,
              type: "book-chapter-reply",
              resourceId,
              message: "replied to your chapter comment",
            });
          }
        } else {
          const chapterOwner = await resolveRecipientForNotification(chapter?.book?.uploader);
          if (chapterOwner?.$id && String(chapterOwner.$id) !== String(user.$id)) {
            notifiedIds.add(String(chapterOwner.$id));
            await notificationService.notifyUser({
              sender: user,
              recipient: chapterOwner,
              type: "book-chapter-comment",
              resourceId,
              message: "commented on your chapter",
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
      chapter?.book?.uploader,
      chapterID,
      normalizeMentionUsernames,
      notificationService,
      resolveMentionedUsers,
      resolveRecipientForNotification,
      user,
    ],
  );

  const highlightSubmittedReply = useCallback(
    (commentId, replyId) => {
      const normalizedCommentId = String(commentId || "");
      const normalizedReplyId = String(replyId || "");
      if (!normalizedCommentId || !normalizedReplyId) return;

      setHighlightedCommentId(normalizedCommentId);
      setHighlightedReplyId(normalizedReplyId);
      clearHighlightTimers();

      submittedHighlightTimeoutRef.current = setTimeout(() => {
        setHighlightedCommentId(null);
        setHighlightedReplyId(null);
        submittedHighlightTimeoutRef.current = null;
      }, SUBMITTED_REPLY_HIGHLIGHT_MS);
    },
    [clearHighlightTimers],
  );

  const highlightSubmittedComment = useCallback(
    (commentId) => {
      const normalizedCommentId = String(commentId || "");
      if (!normalizedCommentId) return;

      setHighlightedCommentId(normalizedCommentId);
      setHighlightedReplyId(null);
      clearHighlightTimers();

      submittedHighlightTimeoutRef.current = setTimeout(() => {
        setHighlightedCommentId(null);
        submittedHighlightTimeoutRef.current = null;
      }, SUBMITTED_REPLY_HIGHLIGHT_MS);
    },
    [clearHighlightTimers],
  );

  const handleReplyPress = useCallback(
    (comment, mentionUser) => {
      if (!comment?.$id) return;
      setReplyTarget({
        id: comment.$id,
        username: comment?.commentOwner?.username || "",
        recipient: comment?.commentOwner,
      });
      committedMentionRangeRef.current = null;
      clearMentionSuggestions();
      // Reply-on-reply: prefill the composer with @username so the reply
      // visually addresses the original reply author, while threading to the
      // top-level parent (matches web's flat-thread model).
      if (mentionUser?.username) {
        setCommentText(`@${mentionUser.username} `);
      }
      setTimeout(() => inputRef.current?.focus(), 100);
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
        await databases.deleteDocument(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.booksChaptersCommentRepliesCollectionId, replyId);

        if (String(highlightedReplyId || "") === replyId) {
          setHighlightedReplyId(null);
        }

        setComments((prev) =>
          prev.map((commentItem) =>
            String(commentItem?.$id || "") === normalizedCommentId
              ? {
                  ...commentItem,
                  booksChaptersCommentReplies: getCommentReplies(commentItem).filter((existingReply) => String(existingReply?.$id || "") !== replyId),
                }
              : commentItem,
          ),
        );
      } catch (error) {
        console.log("handleDeleteReply: error", error);
      }
    },
    [highlightedReplyId, isOwnedByCurrentUser],
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
              .deleteDocument(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.booksChaptersCommentRepliesCollectionId, String(reply.$id))
              .catch((error) => {
                console.log("handleDeleteComment: local reply delete error", error);
              }),
          ),
        );

        try {
          const relationReplies = await databases.listDocuments(
            secrets.appwriteConfig.databaseId,
            secrets.appwriteConfig.booksChaptersCommentRepliesCollectionId,
            [Query.equal("bookChapterComment", commentId), Query.limit(200)],
          );

          await Promise.all(
            (relationReplies?.documents || [])
              .filter((reply) => reply?.$id)
              .map((reply) =>
                databases
                  .deleteDocument(
                    secrets.appwriteConfig.databaseId,
                    secrets.appwriteConfig.booksChaptersCommentRepliesCollectionId,
                    String(reply.$id),
                  )
                  .catch((error) => {
                    console.log("handleDeleteComment: relation reply delete error", error);
                  }),
              ),
          );
        } catch (error) {
          console.log("handleDeleteComment: relation reply fetch error", error);
        }

        await databases.deleteDocument(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.booksChaptersCommentsCollectionId, commentId);

        if (String(highlightedCommentId || "") === commentId) {
          setHighlightedCommentId(null);
        }
        if (replyTarget?.id && String(replyTarget.id) === commentId) {
          handleCancelReply();
        }

        setComments((prev) => {
          const next = prev.filter((existingComment) => String(existingComment?.$id || "") !== commentId);
          onCommentPosted?.(Math.max(0, next.length));
          return next;
        });
      } catch (error) {
        console.log("handleDeleteComment: error", error);
      }
    },
    [handleCancelReply, highlightedCommentId, isOwnedByCurrentUser, onCommentPosted, replyTarget?.id],
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

  const handlePostComment = useCallback(async () => {
    if (!chapterID || !user?.$id || isSubmitting || !commentText.trim()) return;

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
    if (replyContext) setReplyTarget(null);

    try {
      if (replyContext?.id) {
        const newReply = await BookChapterCommentsService.createReplyChapterComment({
          comment: persistedCommentText,
          commentOwner: user.$id,
          bookChapterComment: replyContext.id,
        });

        if (!newReply?.$id) throw new Error("Reply not created");

        setComments((prev) =>
          prev.map((commentItem) => {
            if (String(commentItem?.$id || "") !== String(replyContext.id)) return commentItem;
            const nextReplies = [...getCommentReplies(commentItem), newReply];
            return {
              ...commentItem,
              booksChaptersCommentReplies: nextReplies,
              __forceShowRepliesToken: Date.now(),
              __forceVisibleReplies: nextReplies.length,
            };
          }),
        );

        highlightSubmittedReply(replyContext.id, newReply.$id);
        void notifyCommentRecipients({
          text: persistedCommentText,
          isReply: true,
          commentId: replyContext.id,
          replyId: newReply.$id,
          replyRecipient: replyContext.recipient,
          selectedMentionedUsers: selectedMentionedUsersSnapshot,
        });
      } else {
        const newComment = await bookService.createBookChapterComment({
          bookChapterId: chapterID,
          comment: persistedCommentText,
          commentOwner: user.$id,
        });

        if (!newComment?.$id) throw new Error("Comment not created");

        setComments((prev) => {
          const next = [...prev, newComment];
          onCommentPosted?.(next.length);
          return next;
        });

        setTimeout(() => {
          listRef.current?.scrollToEnd({ animated: true });
        }, 100);

        highlightSubmittedComment(newComment.$id);
        void notifyCommentRecipients({
          text: persistedCommentText,
          isReply: false,
          commentId: newComment.$id,
          selectedMentionedUsers: selectedMentionedUsersSnapshot,
        });
      }
    } catch (error) {
      if (replyContext) setReplyTarget(replyContext);
      setCommentText(trimmedComment);
      console.log("handlePostComment error:", error);
    } finally {
      setIsSubmitting(false);
    }
  }, [
    bookService,
    chapterID,
    clearMentionSuggestions,
    commentText,
    highlightSubmittedComment,
    highlightSubmittedReply,
    isSubmitting,
    notifyCommentRecipients,
    onCommentPosted,
    replyTarget,
    user?.$id,
  ]);

  const scrollToMeasuredFocusedComment = useCallback(
    (animated = true) => {
      if (!autoFocusScrollEnabledRef.current || !focusedTargetCommentId || !listRef.current) return false;

      const normalizedCommentId = String(focusedTargetCommentId || "");
      const targetIndex = comments.findIndex((comment) => String(comment?.$id || "") === normalizedCommentId);
      if (targetIndex === -1) return false;

      const measuredCommentOffset = commentItemOffsetsRef.current.get(normalizedCommentId);
      const hasReliableCommentOffset = typeof measuredCommentOffset === "number" && (targetIndex === 0 || measuredCommentOffset > 0);
      if (!hasReliableCommentOffset) return false;

      pendingFocusedScrollRef.current = false;
      autoFocusScrollEnabledRef.current = false;
      listRef.current.scrollToOffset({
        offset: Math.max(0, measuredCommentOffset - 28),
        animated,
      });
      return true;
    },
    [comments, focusedTargetCommentId],
  );

  const handleCommentItemLayout = useCallback(
    (commentId, event) => {
      const normalizedCommentId = String(commentId || "");
      const nextOffset = event?.nativeEvent?.layout?.y;
      if (!normalizedCommentId || typeof nextOffset !== "number") return;

      commentItemOffsetsRef.current.set(normalizedCommentId, nextOffset);
      if (pendingFocusedScrollRef.current && normalizedCommentId === String(focusedTargetCommentId || "")) {
        scrollToMeasuredFocusedComment(true);
      }
    },
    [focusedTargetCommentId, scrollToMeasuredFocusedComment],
  );

  const handleScrollToFocusedComment = useCallback(() => {
    if (!autoFocusScrollEnabledRef.current || !focusedTargetCommentId || !listRef.current || comments.length === 0) return false;

    if (scrollToMeasuredFocusedComment(true)) {
      return true;
    }

    const targetIndex = comments.findIndex((comment) => String(comment?.$id || "") === String(focusedTargetCommentId));
    if (targetIndex === -1) return false;

    pendingFocusedScrollRef.current = true;
    listRef.current.scrollToIndex({
      index: targetIndex,
      animated: true,
      viewPosition: 0.15,
    });
    return true;
  }, [comments, focusedTargetCommentId, scrollToMeasuredFocusedComment]);

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
    ({ item }) => (
      <View onLayout={(event) => handleCommentItemLayout(item?.$id, event)}>
        <BookChapterCommentItem
          item={item}
          onReplyPress={handleReplyPress}
          onClose={onClose}
          onProfilePress={openMentionProfile}
          onCommentActionsPress={openCommentActions}
          onReplyActionsPress={openReplyActions}
          renderMentionText={renderMentionText}
          highlightedCommentId={highlightedCommentId}
          highlightedReplyId={highlightedReplyId}
        />
      </View>
    ),
    [
      handleCommentItemLayout,
      handleReplyPress,
      highlightedCommentId,
      highlightedReplyId,
      onClose,
      openCommentActions,
      openMentionProfile,
      openReplyActions,
      renderMentionText,
    ],
  );

  const commentListScrollOffsetMax = Math.max(0, commentListContentHeight - commentListLayoutHeight);
  const commentListContentContainerStyle =
    comments.length > 0 ? { paddingHorizontal: 16, paddingBottom: 12 } : { paddingHorizontal: 16, paddingBottom: 12, flexGrow: 1 };
  const ModalContentContainer = Platform.OS === "ios" ? KeyboardAvoidingView : View;

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
        <ModalContentContainer
          {...(Platform.OS === "ios" ? { behavior: "padding" } : {})}
          style={{
            minHeight: SCREEN_HEIGHT * 0.6,
            maxHeight: SCREEN_HEIGHT * 0.78,
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            borderTopWidth: 1,
            borderTopColor: theme.border,
            paddingBottom: Platform.OS === "ios" ? insets.bottom + 16 : 0,
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
              keyExtractor={(item) => item?.$id || `${item?.comment}-${item?.$createdAt}`}
              style={{ flex: 1 }}
              contentContainerStyle={commentListContentContainerStyle}
              showsVerticalScrollIndicator={false}
              renderItem={renderCommentItem}
              // Virtualization tuning — see PostCommentModal for rationale.
              initialNumToRender={8}
              maxToRenderPerBatch={6}
              windowSize={10}
              updateCellsBatchingPeriod={50}
              onEndReached={() => fetchComments(true)}
              onScrollToIndexFailed={handleScrollToIndexFailed}
              nestedScrollEnabled
              keyboardShouldPersistTaps="handled"
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
              removeClippedSubviews={Platform.OS !== "android"}
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
              onSelectStart={(mentionUser) => {
                mentionSelectionInProgressRef.current = true;
                pendingMentionSelectionRef.current = mentionUser;
              }}
              activeOpacity={1}
              nestedScrollEnabled
              containerClassName="max-h-44 border-t"
              containerStyle={{ zIndex: 30, elevation: 30, borderTopColor: theme.border, backgroundColor: theme.surfaceElevated }}
              selectedItemClassName="border-sky-300/25 bg-sky-400/20"
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
            style={
              Platform.OS === "ios"
                ? { paddingBottom: insets.bottom, borderTopColor: theme.border, backgroundColor: theme.surfaceElevated }
                : { borderTopColor: theme.border, backgroundColor: theme.surfaceElevated }
            }
          >
            <View className="relative flex-1">
              <TextInput
                ref={inputRef}
                onPressIn={handleComposerPressIn}
                onChangeText={handleCommentTextChange}
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
                textAlignVertical="top"
                placeholder={replyTarget ? "Write a reply..." : "Add a comment..."}
                placeholderTextColor={theme.placeholder}
                className="font-sans text-sm leading-5"
                style={{ color: theme.inputText, maxHeight: 100 }}
                maxLength={300}
                autoCapitalize="sentences"
                multiline
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
        </ModalContentContainer>
      </Modal>

      <Modal
        isVisible={isVisible && actionsSheetVisible}
        onBackdropPress={closeActionsSheet}
        onBackButtonPress={closeActionsSheet}
        backdropOpacity={0.6}
        useNativeDriver
      >
        <View className="rounded-2xl px-5 py-5" style={{ backgroundColor: theme.surfaceElevated }}>
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
                  <Text className="mt-1 text-xs" style={{ color: theme.textSoft }}>
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

export default memo(BookChapterCommentModal);
