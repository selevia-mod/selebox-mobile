import { MaterialIcons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { FlashList } from "@shopify/flash-list";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Dimensions,
  InteractionManager,
  Linking,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Query } from "react-native-appwrite";
import FastImage from "react-native-fast-image";
import LoaderKit from "react-native-loader-kit";
import Modal from "react-native-modal";
import Share from "react-native-share";
import { useDispatch, useSelector } from "react-redux";
import {
  CustomAlertModal,
  CampaignAdModal,
  ImageViewer,
  MainScreensHeader,
  PostBook,
  PostCard,
  PostCardSkeleton,
  PostClip,
  PostCommentModal,
  PostLikesModal,
  PostNativeAd,
  PostShareYourThoughts,
  PostVideo,
  StoryBar,
  StyledSafeAreaView,
} from "../../components";
import { useGlobalContext } from "../../context/global-provider";
import { useVideosStats } from "../../context/video-stats-provider";
import useAppTheme from "../../hooks/useAppTheme";
import useIsOffline from "../../hooks/useIsOffline";
import useResetOnBlur from "../../hooks/useResetOnBlur";
import { FollowService } from "../../lib/follows";
import { consumePostCommentModalResume } from "../../lib/post-comment-modal-resume";
import { deletePost, fetchGeneratedPosts, getPost, recordPostView, searchPosts } from "../../lib/posts";
import { hasRoleKey, SELECTABLE_ROLE_KEYS } from "../../lib/user-roles";
import { blockUser, hideContent, listBlockedUsers, listHiddenContent, listUserReports, recordEulaAcceptance, reportContent } from "../../lib/safety";
import tabNavigationEvents from "../../lib/tab-navigation-events";
import { useModalMessage } from "../../lib/useModalMessage";
import { fetchUsersByQuery } from "../../lib/users";
import secrets from "../../private/secrets";
import { appendPost, clearPost, removePendingPost, setPost } from "../../store/reducers/post";

const REPORT_REASONS = [
  "Objectionable content",
  "Harassment or bullying",
  "Hate speech",
  "Sexual content or nudity",
  "Spam or scams",
  "Self-harm or violence",
  "Other",
];
const { height: screenHeight } = Dimensions.get("window");
const EULA_VERSION = "2024-12";
const POST_FEED_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const getEulaStorageKey = (userId) => `selebox:eula:${EULA_VERSION}:${userId}`;
const EULA_POINTS = [
  {
    icon: "verified-user",
    title: "Respect first",
    subtitle: "No hate, harassment, explicit content, or threats.",
  },
  {
    icon: "gavel",
    title: "Play by the rules",
    subtitle: "No violence, self-harm encouragement, or illegal activity.",
  },
  {
    icon: "flag",
    title: "See something? Report it.",
    subtitle: "Flag abusive users so we can respond quickly.",
  },
];

const extractVideoIds = (feedItems) => {
  const ids = [];
  for (const item of feedItems) {
    if (item.type === "video") {
      if (item.data?.$id) ids.push(item.data.$id);
    } else if (item.type === "post" && item.data?.postResourceId) {
      const videoId = item.data.video?.$id || item.data.postResourceId;
      if (videoId) ids.push(videoId);
    }
  }
  return ids;
};

const toFiniteNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clamp01 = (value) => Math.max(0, Math.min(1, toFiniteNumber(value, 0)));
const normalizeRouteParam = (value) => {
  if (!value) return null;
  if (Array.isArray(value)) return value[0] || null;
  return String(value);
};

const getSeenPostEngagementRate = (post = {}) => {
  const likes = toFiniteNumber(post.postLikes ?? post.postLikeCount, 0);
  const comments = toFiniteNumber(post.postComments ?? post.postCommentCount, 0);
  const shares = toFiniteNumber(post.shares ?? post.shareCount ?? post.totalShares, 0);
  const saves = toFiniteNumber(post.saves ?? post.saveCount ?? post.totalSaves ?? post.bookmarks, 0);
  const reads = toFiniteNumber(post.reads ?? post.readCount ?? post.totalReads, 0);

  const impressions = Math.max(
    0,
    toFiniteNumber(
      post.postViews ??
        post.postViewCount ??
        post.impressions ??
        post.impressionCount ??
        post.totalImpressions ??
        post.views ??
        post.viewCount ??
        post.totalViews,
      0,
    ),
  );

  const interactions = likes + comments * 1.5 + shares * 2 + saves * 1.2 + reads;
  const derivedRate = impressions > 0 ? interactions / impressions : interactions > 0 ? Math.min(1, interactions / 25) : 0;

  return clamp01(derivedRate);
};

const getFeedIdentity = (entry) => {
  const data = entry?.data || entry || {};
  const type = entry?.type || data?.type;

  if (type === "post") {
    const resourceId = data?.postResourceId || data?.video?.$id || data?.clip?.$id;
    const resourceType = data?.postResourceType || (data?.clip ? "clip" : data?.video ? "video" : null);
    if (resourceId && resourceType) return `${resourceType}-${resourceId}`;
    const postId = data?.$id || data?.id;
    return postId ? `post-${postId}` : null;
  }

  const id = data?.$id || data?.id || data?.uri;
  return id ? `${type || "item"}-${id}` : null;
};

const isPlayableFeedItem = (entry) => {
  if (!entry) return false;
  const { type, data } = entry;
  if (!data) return false;

  if (type === "video") return Boolean(data?.videoUrl);
  if (type === "clip") return Boolean(data?.clipUrl);

  if (type === "post" && data?.postResourceId) {
    const isClipPost = data.postResourceType === "clip" || Boolean(data.clip);
    if (isClipPost) return Boolean((data.clip || data)?.clipUrl);
    return Boolean((data.video || data)?.videoUrl);
  }

  return false;
};

const Home = () => {
  const routeParams = useLocalSearchParams();
  const { user } = useGlobalContext();
  const { theme } = useAppTheme();
  const { batchLoadVideoStats } = useVideosStats();
  const isOffline = useIsOffline();

  const [postsLoading, setPostsLoading] = useState(true);
  const [posts, setPosts] = useState([]);
  const [lastId, setLastId] = useState();
  const [hasMore, setHasMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  useResetOnBlur(setRefreshing);
  const [refreshCounter, setRefreshCounter] = useState(0);
  const [localCursor, setLocalCursor] = useState(0);
  const globalKeyCounter = useRef(0); // Track total items normalized (pre-filter)
  const localCursorRef = useRef(0);

  const [showImageViewer, setShowImageViewer] = useState(false);
  const [images, setImages] = useState([]);
  const [imageViewerInitialIndex, setImageViewerInitialIndex] = useState(0);
  const flatListRef = useRef(null);
  const lastScrollY = useRef(0);
  const navHiddenRef = useRef(false);
  const isSearchFocusedRef = useRef(false);

  const [isCommentModalVisible, setCommentModalVisible] = useState(false);
  const [isLikesModalVisible, setLikesModalVisible] = useState(false);
  const [currentPost, setCurrentPost] = useState();
  const [commentModalFocus, setCommentModalFocus] = useState({ focusCommentId: null, focusReplyId: null });
  const [commentModalResumeToken, setCommentModalResumeToken] = useState(null);
  const [isFetchingMore, setIsFetchingMore] = useState(false);

  const { message, messageOpen, closeMessage, showMessage } = useModalMessage();

  const [searchQuery, setSearchQuery] = useState("");
  const [filteredPosts, setFilteredPosts] = useState([]);
  const [searchUsers, setSearchUsers] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [searchLastId, setSearchLastId] = useState(null);

  const [expandedIndex, setExpandedIndex] = useState(null);
  const [expandedMenuIndex, setExpandedMenuIndex] = useState(null);
  const [blockedUserIds, setBlockedUserIds] = useState(new Set());
  const [hiddenContentIds, setHiddenContentIds] = useState(new Set());
  const [safetySheetVisible, setSafetySheetVisible] = useState(false);
  const [reportModalVisible, setReportModalVisible] = useState(false);
  const [pendingReportOpen, setPendingReportOpen] = useState(false);

  const openReportModal = () => {
    setPendingReportOpen(true);
    setSafetySheetVisible(false);
    // Small delay prevents modal stacking glitches on iOS
    setTimeout(() => {
      setReportModalVisible(true);
      setPendingReportOpen(false);
    }, 500);
  };

  const closeReportModal = () => {
    setPendingReportOpen(true);
    setReportModalVisible(false);
    // Wait for report modal close animation to complete
    setTimeout(() => {
      setSafetySheetVisible(true);
      setPendingReportOpen(false);
    }, 500);
  };
  const [pendingSafetyTarget, setPendingSafetyTarget] = useState(null);
  const [selectedReportReason, setSelectedReportReason] = useState("");
  const [reportNotes, setReportNotes] = useState("");
  const [submittingReport, setSubmittingReport] = useState(false);
  const [blockingUser, setBlockingUser] = useState(false);
  const [showEulaModal, setShowEulaModal] = useState(false);
  const [hasResolvedEula, setHasResolvedEula] = useState(false);
  const [isVideoMuted, setIsVideoMuted] = useState(true);

  const videoRefs = useRef({});
  const currentlyPlayingKey = useRef(null);
  const pendingPlaybackKey = useRef(null);
  const lastViewableKeysRef = useRef([]);
  const isHomeFocused = useRef(false);
  const isFetchingMoreRef = useRef(false);
  const isFetchingSearchMoreRef = useRef(false);
  const paginationPrefetchLockRef = useRef(false);
  const paginationPrefetchTsRef = useRef(0);
  const wasBackgrounded = useRef(false);
  const isVideoMutedRef = useRef(true);
  const pendingAlertMessage = useRef(null);
  const postsState = useSelector((state) => state.post);
  const dispatch = useDispatch();
  const PAGE_SIZE = 15;
  const USER_SEARCH_LIMIT = 8;
  const MAX_TRACKED_SEEN_POSTS = 220;
  const seenPostIdsRef = useRef(new Set());
  const seenPostEngagementRef = useRef(new Map());
  const sentPostViewsRef = useRef(new Set());
  const viewerUserIdRef = useRef(null);
  const notificationCommentOpenKeyRef = useRef(null);
  const notificationOpenTimerRef = useRef(null);
  const focusPostIdParam = useMemo(
    () => normalizeRouteParam(routeParams.focusPostId || routeParams.postId),
    [routeParams.focusPostId, routeParams.postId],
  );
  const focusCommentIdParam = useMemo(
    () => normalizeRouteParam(routeParams.focusCommentId || routeParams.commentId || routeParams.comment),
    [routeParams.comment, routeParams.commentId, routeParams.focusCommentId],
  );
  const focusReplyIdParam = useMemo(
    () => normalizeRouteParam(routeParams.focusReplyId || routeParams.replyId),
    [routeParams.focusReplyId, routeParams.replyId],
  );
  const cachedFeedUserId = postsState.feedUserId || null;
  const cachedFeedBelongsToUser = Boolean(user?.$id && cachedFeedUserId === user.$id);
  const rawCachedPosts = Array.isArray(postsState.posts) ? postsState.posts : [];
  const cachedAt = Number(postsState.cachedAt);
  const isCachedFeedExpired = rawCachedPosts.length > 0 && (!Number.isFinite(cachedAt) || Date.now() - cachedAt > POST_FEED_CACHE_TTL_MS);
  const cachedPosts = useMemo(() => {
    if (!cachedFeedBelongsToUser || isCachedFeedExpired) return [];
    return rawCachedPosts;
  }, [cachedFeedBelongsToUser, isCachedFeedExpired, rawCachedPosts]);
  const cachedLastId = cachedFeedBelongsToUser && !isCachedFeedExpired ? (postsState.lastId ?? null) : null;
  const cachedHasMore = cachedFeedBelongsToUser && !isCachedFeedExpired ? Boolean(postsState.hasMore) : false;
  const openCommentsParam = useMemo(() => {
    const raw = normalizeRouteParam(routeParams.openComments);
    return raw === "1" || raw === "true";
  }, [routeParams.openComments]);

  const syncPostView = useCallback((postId) => {
    const viewerUserId = viewerUserIdRef.current;
    if (!postId || !viewerUserId) return;

    const trackingKey = `${viewerUserId}:${postId}`;
    if (sentPostViewsRef.current.has(trackingKey)) return;

    sentPostViewsRef.current.add(trackingKey);
    recordPostView({ postId, viewOwner: viewerUserId }).catch((err) => {
      console.log("recordPostView: error", err);
      // Allow retry on transient failures.
      sentPostViewsRef.current.delete(trackingKey);
    });
  }, []);

  const markSeenPost = useCallback(
    (entry) => {
      if (!entry || entry.type !== "post") return;

      const postId = entry.data?.$id;
      if (!postId) return;

      const postIds = seenPostIdsRef.current;
      const engagementMap = seenPostEngagementRef.current;
      const engagementRate = getSeenPostEngagementRate(entry.data);

      // Keep insertion order fresh for a bounded payload.
      if (postIds.has(postId)) postIds.delete(postId);
      postIds.add(postId);
      if (engagementRate > 0) engagementMap.set(postId, engagementRate);
      syncPostView(postId);

      while (postIds.size > MAX_TRACKED_SEEN_POSTS) {
        const oldestPostId = postIds.values().next().value;
        if (!oldestPostId) break;
        postIds.delete(oldestPostId);
        engagementMap.delete(oldestPostId);
      }
    },
    [MAX_TRACKED_SEEN_POSTS, syncPostView],
  );

  const buildSeenPayload = useCallback(
    (seedEntries = []) => {
      const mergedPostIds = new Set(seenPostIdsRef.current);

      seedEntries.forEach((entry) => {
        if (entry?.type !== "post") return;
        const postId = entry?.data?.$id;
        if (!postId) return;
        mergedPostIds.add(postId);

        const currentEngagement = seenPostEngagementRef.current.get(postId);
        if (!Number.isFinite(currentEngagement) || currentEngagement <= 0) {
          const fallbackRate = getSeenPostEngagementRate(entry.data);
          if (fallbackRate > 0) {
            seenPostEngagementRef.current.set(postId, fallbackRate);
          }
        }
      });

      let seenPostIds = Array.from(mergedPostIds);
      if (seenPostIds.length > MAX_TRACKED_SEEN_POSTS) {
        seenPostIds = seenPostIds.slice(seenPostIds.length - MAX_TRACKED_SEEN_POSTS);
      }

      if (seenPostIds.length === 0) {
        return {
          seenPostIds: [],
          seenPostEngagementByPostId: {},
        };
      }

      const seenPostEngagementByPostId = {};
      seenPostIds.forEach((postId) => {
        const engagementRate = seenPostEngagementRef.current.get(postId);
        if (Number.isFinite(engagementRate) && engagementRate > 0) {
          seenPostEngagementByPostId[postId] = Number(engagementRate.toFixed(4));
        }
      });

      return { seenPostIds, seenPostEngagementByPostId };
    },
    [MAX_TRACKED_SEEN_POSTS],
  );

  const extraData = useMemo(() => ({ expandedIndex, expandedMenuIndex }), [expandedIndex, expandedMenuIndex]);
  const pendingPosts = postsState.pendingPosts || [];
  const pendingEntries = useMemo(
    () =>
      pendingPosts.map((entry, index) => ({
        type: "post",
        data: entry.data,
        key: `pending-${entry.clientId || entry.data?.clientId || index}`,
      })),
    [pendingPosts],
  );
  const filteredSearchUsers = useMemo(() => {
    if (!searchUsers.length) return [];
    return searchUsers.filter((item) => item?.$id && !blockedUserIds.has(item.$id));
  }, [searchUsers, blockedUserIds]);
  const searchResults = useMemo(() => {
    if (!isSearching) return [];
    const userItems = filteredSearchUsers.map((item) => ({
      type: "user",
      data: item,
      key: `user-${item.$id}`,
    }));
    return [...userItems, ...filteredPosts];
  }, [filteredSearchUsers, filteredPosts, isSearching]);
  const feedData = useMemo(() => {
    if (isSearching) return searchResults;
    if (pendingEntries.length === 0) return posts;

    const seen = new Set();
    posts.forEach((entry) => {
      const identity = getFeedIdentity(entry);
      if (identity) seen.add(identity);
    });

    const dedupedPending = pendingEntries.filter((entry) => {
      const identity = getFeedIdentity(entry);
      return !identity || !seen.has(identity);
    });

    return [...dedupedPending, ...posts];
  }, [isSearching, searchResults, pendingEntries, posts]);
  const feedDataRef = useRef(feedData);

  useEffect(() => {
    feedDataRef.current = feedData;
  }, [feedData]);

  const clearNotificationRouteParams = useCallback(() => {
    router.setParams({
      focusPostId: undefined,
      focusCommentId: undefined,
      focusReplyId: undefined,
      postId: undefined,
      commentId: undefined,
      replyId: undefined,
      openComments: undefined,
    });
  }, []);

  useEffect(() => {
    if (!focusPostIdParam) return;
    const shouldOpenComments = openCommentsParam || Boolean(focusCommentIdParam || focusReplyIdParam);
    if (!shouldOpenComments) return;

    const openKey = `${focusPostIdParam}:${focusCommentIdParam || ""}:${focusReplyIdParam || ""}`;
    if (notificationCommentOpenKeyRef.current === openKey) return;
    notificationCommentOpenKeyRef.current = openKey;
    let isCancelled = false;
    let hasOpenedModal = false;

    const openCommentModalForNotification = async () => {
      const currentFeed = feedDataRef.current || [];
      let targetIndex = currentFeed.findIndex((entry) => entry?.type === "post" && String(entry?.data?.$id || "") === String(focusPostIdParam));
      let resolvedPost = targetIndex >= 0 ? currentFeed[targetIndex]?.data : null;

      if (!resolvedPost) {
        try {
          const fetchedPost = await getPost({ ID: focusPostIdParam });
          if (fetchedPost?.$id && !isCancelled) {
            const fetchedEntry = { type: "post", data: fetchedPost, key: `post-${fetchedPost.$id}` };
            resolvedPost = fetchedPost;
            targetIndex = 0;
            setPosts((prev) =>
              prev.some((entry) => entry?.type === "post" && entry?.data?.$id === fetchedPost.$id) ? prev : [fetchedEntry, ...prev],
            );
            setFilteredPosts((prev) =>
              prev.some((entry) => entry?.type === "post" && entry?.data?.$id === fetchedPost.$id) ? prev : [fetchedEntry, ...prev],
            );
          }
        } catch (error) {
          console.log("focus notification: getPost error", error);
        }
      }

      if (isCancelled) return;

      const fallbackPost = resolvedPost || {
        $id: focusPostIdParam,
        postOwner: null,
        postComments: 0,
      };

      setCurrentPost(fallbackPost);
      setCommentModalFocus({
        focusCommentId: focusCommentIdParam || null,
        focusReplyId: focusReplyIdParam || null,
      });

      const list = flatListRef.current;
      if (list) {
        try {
          if (targetIndex >= 0) {
            list.recordInteraction?.();
            list.scrollToIndex?.({ index: targetIndex, animated: true, viewPosition: 0.14 });
          } else {
            list.scrollToOffset?.({ offset: 0, animated: true });
          }
        } catch (error) {
          list.scrollToOffset?.({ offset: 0, animated: true });
        }
      }

      notificationOpenTimerRef.current = setTimeout(() => {
        if (isCancelled) return;
        hasOpenedModal = true;
        setCommentModalResumeToken(null);
        setCommentModalVisible(true);
        clearNotificationRouteParams();
        notificationOpenTimerRef.current = null;
      }, 380);
    };

    openCommentModalForNotification();

    return () => {
      isCancelled = true;
      if (notificationOpenTimerRef.current) {
        clearTimeout(notificationOpenTimerRef.current);
        notificationOpenTimerRef.current = null;
      }
      if (!hasOpenedModal && notificationCommentOpenKeyRef.current === openKey) {
        notificationCommentOpenKeyRef.current = null;
      }
    };
  }, [clearNotificationRouteParams, focusCommentIdParam, focusPostIdParam, focusReplyIdParam, openCommentsParam]);

  useFocusEffect(
    useCallback(() => {
      const pendingResume = consumePostCommentModalResume("home");
      if (!pendingResume?.postId) return;

      const targetPostId = String(pendingResume.postId);
      const currentFeed = feedDataRef.current || [];
      const matchedPost = currentFeed.find((entry) => entry?.type === "post" && String(entry?.data?.$id || "") === targetPostId)?.data;
      const fallbackPost = matchedPost || pendingResume.postSnapshot || { $id: targetPostId, postOwner: null, postComments: 0 };

      setCurrentPost(fallbackPost);
      notificationCommentOpenKeyRef.current = null;
      setCommentModalFocus({ focusCommentId: null, focusReplyId: null });
      setCommentModalResumeToken(pendingResume.token || null);
      setCommentModalVisible(true);
    }, []),
  );
  const AUTO_PLAY_VISIBLE_PERCENT = 35;
  const FEED_ESTIMATED_ITEM_SIZE = 430;
  const FEED_DRAW_DISTANCE = Math.round(screenHeight * 2.4);
  const FEED_ON_END_REACHED_THRESHOLD = 1.1;
  const FEED_PREFETCH_VIEWPORT_MULTIPLIER = 2;
  const FEED_PREFETCH_COOLDOWN_MS = 280;
  const viewabilityConfig = {
    itemVisiblePercentThreshold: AUTO_PLAY_VISIBLE_PERCENT,
    minimumViewTime: 0,
    waitForInteraction: false,
  };
  const getFeedItemType = useCallback((item) => {
    if (!item?.type) return "post";
    if (item.type !== "post") return item.type;

    if (item?.data?.clientStatus === "pending") return "pending-post";
    if (!item?.data?.postResourceId) {
      if (Array.isArray(item?.data?.postUrls) && item.data.postUrls.length > 0) return "post-media";
      if (typeof item?.data?.post === "string" && item.data.post.includes("http")) return "post-link";
      return "post";
    }

    if (item?.data?.postResourceType === "clip" || item?.data?.clip) return "post-clip";

    return "post-video";
  }, []);

  const resolveItemData = (entry) => entry?.data || entry || {};
  const resolveOwnerId = (entry) => {
    const data = resolveItemData(entry);
    return (
      data?.postOwner?.$id ||
      data?.postOwner ||
      data?.uploader?.$id ||
      data?.uploader?.id ||
      data?.video?.uploader?.$id ||
      data?.video?.uploader?.id ||
      data?.clip?.uploader?.$id ||
      data?.clip?.uploader?.id ||
      data?.ownerId ||
      data?.userId ||
      null
    );
  };
  const resolveOwnerName = (entry) => {
    const data = resolveItemData(entry);
    return (
      data?.postOwner?.username ||
      data?.postOwner?.name ||
      data?.uploader?.username ||
      data?.uploader?.name ||
      data?.video?.uploader?.username ||
      data?.video?.uploader?.name ||
      data?.clip?.uploader?.username ||
      data?.clip?.uploader?.name ||
      "this user"
    );
  };
  const resolveContentId = (entry) => {
    const data = resolveItemData(entry);
    return data?.$id || data?.id || data?.postResourceId || data?.video?.$id || data?.video?.id || data?.clip?.$id || data?.clip?.id || null;
  };
  const applySafetyFilters = (feedItems = []) =>
    feedItems.filter((entry) => {
      const ownerId = resolveOwnerId(entry);
      const contentId = resolveContentId(entry);

      if (ownerId && blockedUserIds.has(ownerId)) return false;
      if (contentId && hiddenContentIds.has(contentId)) return false;
      return true;
    });
  const buildSafetyTarget = (entry) => ({
    ...entry,
    ownerId: resolveOwnerId(entry),
    ownerName: resolveOwnerName(entry),
    contentId: resolveContentId(entry),
  });
  const filterUniqueFeedItems = useCallback((existingItems = [], incomingItems = []) => {
    if (!Array.isArray(incomingItems) || incomingItems.length === 0) return [];

    const seenIdentities = new Set();
    const seenKeys = new Set();
    existingItems.forEach((entry) => {
      const identity = getFeedIdentity(entry);
      if (identity) seenIdentities.add(identity);
      if (entry?.key) seenKeys.add(entry.key);
    });

    const uniqueItems = [];
    incomingItems.forEach((entry) => {
      const identity = getFeedIdentity(entry);
      const key = entry?.key;

      if (identity) {
        if (seenIdentities.has(identity)) return;
        seenIdentities.add(identity);
        uniqueItems.push(entry);
        if (key) seenKeys.add(key);
        return;
      }

      if (key) {
        if (seenKeys.has(key)) return;
        seenKeys.add(key);
      }

      uniqueItems.push(entry);
    });

    return uniqueItems;
  }, []);

  // Normalize feed items → add stable "key" with global counter to prevent duplicates
  const normalizeFeed = useCallback((feed) => {
    const seen = new Set();
    const result = [];

    feed.forEach((item, index) => {
      const identity = getFeedIdentity(item);
      const fallbackType = item?.type || "item";
      if (identity) {
        if (seen.has(identity)) return;
        seen.add(identity);
      }

      result.push({
        ...item,
        key: identity || `${fallbackType}-${globalKeyCounter.current + index}`,
      });
    });
    globalKeyCounter.current += feed.length; // Increment by pre-filter count
    return result;
  }, []);

  useEffect(() => {
    const checkEulaStatus = async () => {
      if (!user?.$id) {
        setShowEulaModal(false);
        setHasResolvedEula(false);
        return;
      }

      try {
        const stored = await AsyncStorage.getItem(getEulaStorageKey(user.$id));
        setShowEulaModal(!stored);
      } catch (error) {
        console.log("EULA check error", error);
        setShowEulaModal(true);
      } finally {
        setHasResolvedEula(true);
      }
    };

    checkEulaStatus();
  }, [user?.$id]);

  useEffect(() => {
    const fetchSafetySignals = async () => {
      if (!user?.$id) return;
      try {
        const [blocked, reported, hidden] = await Promise.all([
          listBlockedUsers({ blockerId: user.$id }).catch(() => []),
          listUserReports({ reporterId: user.$id }).catch(() => []),
          listHiddenContent({ userId: user.$id }).catch(() => []),
        ]);

        setBlockedUserIds(new Set(blocked));
        setHiddenContentIds(new Set([...reported, ...hidden]));
      } catch (error) {
        console.log("safety signals error", error);
      }
    };

    fetchSafetySignals();
  }, [user?.$id]);

  // Initial load: prefer the persisted feed and only hit the network when cache is empty.
  useEffect(() => {
    const bootstrap = async () => {
      if (isCachedFeedExpired) {
        dispatch(clearPost());
      }

      if (cachedPosts.length > 0) {
        const slice = cachedPosts.slice(0, PAGE_SIZE);
        const filtered = applySafetyFilters(slice);
        const nextLocalCursor = Math.min(cachedPosts.length, PAGE_SIZE);

        setPosts(filtered);
        localCursorRef.current = nextLocalCursor;
        setLocalCursor(nextLocalCursor);
        setLastId(cachedLastId);
        setHasMore(cachedHasMore);
        setPostsLoading(false);
        return;
      }

      setPosts([]);
      localCursorRef.current = 0;
      setLocalCursor(0);
      setLastId(null);
      setHasMore(false);
      await loadFeed({ refreshMode: true });
    };

    bootstrap();
  }, [user?.$id]);

  useEffect(() => {
    setPosts((prev) => applySafetyFilters(prev));
    setFilteredPosts((prev) => applySafetyFilters(prev));
  }, [blockedUserIds, hiddenContentIds]);

  useEffect(() => {
    seenPostIdsRef.current = new Set();
    seenPostEngagementRef.current = new Map();
    sentPostViewsRef.current = new Set();
    viewerUserIdRef.current = user?.$id || null;
  }, [user?.$id]);

  useEffect(() => {
    localCursorRef.current = localCursor;
  }, [localCursor]);

  const loadFeed = async ({ refreshMode = false } = {}) => {
    setPostsLoading(true);
    try {
      const currentViewerUserId = user?.$id || null;
      if (viewerUserIdRef.current !== currentViewerUserId) {
        seenPostIdsRef.current = new Set();
        seenPostEngagementRef.current = new Map();
        sentPostViewsRef.current = new Set();
        viewerUserIdRef.current = currentViewerUserId;
      }

      const seenPayload = buildSeenPayload(cachedPosts.length ? cachedPosts : posts);

      const {
        feed = [],
        nextCursor,
        hasMore,
      } = await fetchGeneratedPosts({
        limit: PAGE_SIZE,
        userId: user?.$id,
        ...seenPayload,
        refresh: refreshMode,
      });
      globalKeyCounter.current = 0; // Reset counter on fresh load
      const normalized = normalizeFeed(feed);
      const filtered = applySafetyFilters(normalized);

      // Pre-fetch video stats in batch before rendering
      const videoIds = extractVideoIds(filtered);
      if (videoIds.length > 0) await batchLoadVideoStats(videoIds, user?.$id);

      setPosts(filtered);
      localCursorRef.current = filtered.length;
      setLocalCursor(filtered.length); // Reset cursor on fresh load
      setLastId(nextCursor);
      setHasMore(hasMore);
      dispatch(
        setPost({
          posts: filtered,
          lastId: nextCursor,
          hasMore,
          feedUserId: user?.$id || null,
          cachedAt: Date.now(),
        }),
      );
    } finally {
      setPostsLoading(false);
    }
  };

  const fetchMorePosts = useCallback(async () => {
    if (isFetchingMoreRef.current) return;
    isFetchingMoreRef.current = true;

    let networkFetchStarted = false;
    try {
      const cursor = localCursorRef.current;

      if (cursor < cachedPosts.length) {
        const nextSlice = applySafetyFilters(cachedPosts.slice(cursor, cursor + PAGE_SIZE));
        setPosts((prev) => {
          const uniqueSlice = filterUniqueFeedItems(prev, nextSlice);
          return uniqueSlice.length > 0 ? [...prev, ...uniqueSlice] : prev;
        });

        const nextCursor = Math.min(cachedPosts.length, cursor + PAGE_SIZE);
        localCursorRef.current = nextCursor;
        setLocalCursor(nextCursor);
        return;
      }

      if (!hasMore || postsLoading) return;

      networkFetchStarted = true;
      setIsFetchingMore(true);
      const {
        feed = [],
        nextCursor: apiNextCursor,
        hasMore: more,
      } = await fetchGeneratedPosts({
        limit: PAGE_SIZE,
        lastId,
        userId: user?.$id,
        ...buildSeenPayload(cachedPosts.length ? cachedPosts : posts),
      });

      const normalized = normalizeFeed(feed);
      const filtered = applySafetyFilters(normalized);
      const uniqueForStore = filterUniqueFeedItems(cachedPosts, filtered);

      setPosts((prev) => {
        const uniqueForView = filterUniqueFeedItems(prev, uniqueForStore);
        return uniqueForView.length > 0 ? [...prev, ...uniqueForView] : prev;
      });

      const nextCursor = localCursorRef.current + uniqueForStore.length;
      localCursorRef.current = nextCursor;
      setLocalCursor(nextCursor); // Update cursor after API fetch
      setLastId(apiNextCursor);
      setHasMore(more);
      dispatch(
        appendPost({
          posts: uniqueForStore,
          lastId: apiNextCursor,
          hasMore: more,
          feedUserId: user?.$id || null,
          cachedAt: Date.now(),
        }),
      );

      // Keep pagination snappy: append first, hydrate stats in background.
      const videoIds = extractVideoIds(uniqueForStore);
      if (videoIds.length > 0) {
        batchLoadVideoStats(videoIds, user?.$id).catch((error) => {
          console.log("batchLoadVideoStats: pagination error", error);
        });
      }
    } finally {
      if (networkFetchStarted) setIsFetchingMore(false);
      isFetchingMoreRef.current = false;
    }
  }, [
    PAGE_SIZE,
    applySafetyFilters,
    batchLoadVideoStats,
    dispatch,
    filterUniqueFeedItems,
    buildSeenPayload,
    hasMore,
    lastId,
    normalizeFeed,
    posts,
    postsLoading,
    cachedPosts,
    user?.$id,
  ]);

  useEffect(() => {
    isVideoMutedRef.current = isVideoMuted;
  }, [isVideoMuted]);

  const handleVideoMuteChange = useCallback((muted) => {
    isVideoMutedRef.current = muted;
    setIsVideoMuted(muted);
  }, []);

  const resumeVideoRef = useCallback((ref) => {
    ref?.resumeVideo?.();
    if (isVideoMutedRef.current) ref?.muteVideo?.();
    else ref?.unmuteVideo?.();
  }, []);

  const syncPlaybackToKey = useCallback(
    (mainKey) => {
      if (!mainKey) {
        Object.values(videoRefs.current).forEach((ref) => ref?.pauseVideo?.());
        currentlyPlayingKey.current = null;
        pendingPlaybackKey.current = null;
        return;
      }

      let resumed = false;
      pendingPlaybackKey.current = mainKey;
      Object.entries(videoRefs.current).forEach(([key, ref]) => {
        if (key === mainKey) {
          resumed = true;
          resumeVideoRef(ref);
        } else {
          ref?.pauseVideo?.();
        }
      });

      currentlyPlayingKey.current = mainKey;
      if (resumed) pendingPlaybackKey.current = null;
    },
    [resumeVideoRef],
  );

  const resumeVisibleMedia = useCallback(() => {
    const visibleKeys = lastViewableKeysRef.current || [];
    if (visibleKeys.length === 0) return;
    syncPlaybackToKey(visibleKeys[0]);
  }, [syncPlaybackToKey]);

  // Pause/resume videos on app background; feed refresh stays manual via pull-to-refresh.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "background") {
        wasBackgrounded.current = true;
        Object.values(videoRefs.current).forEach((ref) => ref?.pauseVideo?.());
      } else if (nextState === "inactive") {
        Object.values(videoRefs.current).forEach((ref) => ref?.pauseVideo?.());
      } else if (nextState === "active") {
        // Resume videos if home is focused
        if (isHomeFocused.current) {
          resumeVisibleMedia();
        }
        wasBackgrounded.current = false;
      }
    });

    return () => subscription.remove();
  }, [resumeVisibleMedia]);

  // Pause/resume videos on screen focus
  useFocusEffect(
    useCallback(() => {
      isHomeFocused.current = true;
      resumeVisibleMedia();

      return () => {
        isHomeFocused.current = false;
        currentlyPlayingKey.current = null;
        Object.values(videoRefs.current).forEach((ref) => ref?.pauseVideo?.());
      };
    }, [resumeVisibleMedia]),
  );

  useEffect(
    () => () => {
      isHomeFocused.current = false;
      currentlyPlayingKey.current = null;
      Object.values(videoRefs.current).forEach((ref) => ref?.pauseVideo?.());
      videoRefs.current = {};
    },
    [],
  );

  useFocusEffect(
    useCallback(() => {
      navHiddenRef.current = false;
      tabNavigationEvents.emit("tabBarVisibility", { visible: true });
      return () => {
        navHiddenRef.current = false;
        tabNavigationEvents.emit("tabBarVisibility", { visible: true });
      };
    }, []),
  );

  const scrollFeedToTop = useCallback(() => {
    const list = flatListRef.current;
    if (!list) return;

    const currentOffset = Math.max(0, lastScrollY.current || 0);
    const FAR_SCROLL_THRESHOLD = screenHeight * 3;
    const WARM_UP_OFFSET = Math.round(screenHeight * 1.25);

    list.recordInteraction?.();

    // For long jumps, warm the recycler near the top first to avoid a blank frame.
    if (currentOffset > FAR_SCROLL_THRESHOLD) {
      list.scrollToOffset?.({ offset: WARM_UP_OFFSET, animated: false });
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          list.scrollToIndex?.({ index: 0, animated: false, viewPosition: 0 });
        });
      });
    } else {
      list.scrollToIndex?.({ index: 0, animated: true, viewPosition: 0 });
    }

    lastScrollY.current = 0;
    if (navHiddenRef.current) {
      navHiddenRef.current = false;
      tabNavigationEvents.emit("tabBarVisibility", { visible: true });
    }
  }, []);

  useEffect(() => {
    const handleScrollToTop = ({ tab }) => {
      if (tab !== "home") return;
      scrollFeedToTop();
    };

    tabNavigationEvents.on("scrollToTop", handleScrollToTop);
    return () => {
      tabNavigationEvents.off("scrollToTop", handleScrollToTop);
    };
  }, [scrollFeedToTop]);

  // Search effect → normalize to feed format
  useEffect(() => {
    const delay = setTimeout(async () => {
      const trimmedQuery = searchQuery.trim();
      if (!trimmedQuery) {
        setFilteredPosts([]);
        setSearchUsers([]);
        setIsSearching(false);
        setSearchHasMore(false);
        setSearchLastId(null);
        setSearchLoading(false);
        return;
      }

      setSearchLoading(true);
      setIsSearching(true);
      setSearchUsers([]);
      setFilteredPosts([]);

      try {
        const [postsResponse, usersResponse] = await Promise.all([
          searchPosts({ searchQuery: trimmedQuery }),
          fetchUsersByQuery([Query.contains("username", trimmedQuery), Query.limit(USER_SEARCH_LIMIT)]),
        ]);

        const { documents = [], hasMore, lastId } = postsResponse || {};
        const mapped = documents.map((doc) => ({
          type: "post",
          data: doc,
          key: `post-${doc.$id}`,
        }));

        setFilteredPosts(applySafetyFilters(mapped));
        setSearchLastId(lastId);
        setSearchHasMore(hasMore);
        setSearchUsers(usersResponse?.documents || []);
      } catch (error) {
        console.log("search error", error);
        setFilteredPosts([]);
        setSearchUsers([]);
        setSearchLastId(null);
        setSearchHasMore(false);
      } finally {
        setSearchLoading(false);
      }
    }, 300);

    return () => clearTimeout(delay);
  }, [searchQuery]);

  const fetchMoreSearchResults = useCallback(async () => {
    if (!searchHasMore || searchLoading || !searchLastId || isFetchingSearchMoreRef.current) return;

    isFetchingSearchMoreRef.current = true;
    setSearchLoading(true);
    try {
      const { documents, hasMore, lastId } = await searchPosts({
        searchQuery: searchQuery.trim(),
        cursorId: searchLastId,
      });

      const mapped = documents.map((doc) => ({
        type: "post",
        data: doc,
        key: `post-${doc.$id}`,
      }));

      const filtered = applySafetyFilters(mapped);
      setFilteredPosts((prev) => {
        const unique = filterUniqueFeedItems(prev, filtered);
        return unique.length > 0 ? [...prev, ...unique] : prev;
      });
      setSearchLastId(lastId);
      setSearchHasMore(hasMore);
    } catch (error) {
      console.log("fetchMoreSearchResults: error", error);
    } finally {
      isFetchingSearchMoreRef.current = false;
      setSearchLoading(false);
    }
  }, [searchHasMore, searchLoading, searchLastId, searchQuery, applySafetyFilters, filterUniqueFeedItems]);

  const triggerPaginationPrefetch = useCallback(async () => {
    const now = Date.now();
    if (paginationPrefetchLockRef.current) return;
    if (now - paginationPrefetchTsRef.current < FEED_PREFETCH_COOLDOWN_MS) return;

    paginationPrefetchLockRef.current = true;
    paginationPrefetchTsRef.current = now;

    try {
      if (isSearching) await fetchMoreSearchResults();
      else await fetchMorePosts();
    } finally {
      paginationPrefetchLockRef.current = false;
    }
  }, [isSearching, fetchMoreSearchResults, fetchMorePosts]);

  const handleAcceptEula = async () => {
    if (!user?.$id) return;
    const acceptedAt = new Date().toISOString();

    try {
      await AsyncStorage.setItem(getEulaStorageKey(user.$id), acceptedAt);
      await recordEulaAcceptance({ userId: user.$id, version: EULA_VERSION, acceptedAt });
      setShowEulaModal(false);
    } catch (error) {
      console.log("EULA accept error", error);
      setShowEulaModal(false);
    }
  };

  const openSafetySheet = (target) => {
    if (!target) return;
    const safeTarget = buildSafetyTarget(target);
    setPendingSafetyTarget(safeTarget);
    setSelectedReportReason("");
    setReportNotes("");
    setPendingReportOpen(false);
    setSafetySheetVisible(true);
    setReportModalVisible(false);
  };

  const closeSafetySheet = () => {
    pendingAlertMessage.current = null;
    setSafetySheetVisible(false);
    setPendingSafetyTarget(null);
    setPendingReportOpen(false);
  };

  const submitReport = async () => {
    if (!pendingSafetyTarget?.contentId || !user?.$id || !selectedReportReason) return;
    setSubmittingReport(true);
    try {
      const res = await reportContent({
        contentId: pendingSafetyTarget.contentId,
        contentType: pendingSafetyTarget.type || "post",
        reporterId: user.$id,
        ownerId: pendingSafetyTarget.ownerId,
        reason: selectedReportReason,
        notes: reportNotes.trim() || null,
      });

      setHiddenContentIds((prev) => new Set([...prev, pendingSafetyTarget.contentId]));
      pendingAlertMessage.current = res
        ? "Thanks for flagging this. We'll review it quickly."
        : "Report recorded locally. Backend configuration needed to process it.";
    } catch (error) {
      console.log("submitReport error", error);
      pendingAlertMessage.current = "Unable to submit the report. Please try again.";
    } finally {
      setSubmittingReport(false);
      setReportModalVisible(false);
      setPendingReportOpen(false);
      setSafetySheetVisible(false);
      setPendingSafetyTarget(null);
    }
  };

  const handleHideContent = () => {
    if (!pendingSafetyTarget?.contentId) {
      closeSafetySheet();
      return;
    }
    setHiddenContentIds((prev) => new Set([...prev, pendingSafetyTarget.contentId]));
    pendingAlertMessage.current = "Post hidden. You won't see it again.";

    if (user?.$id) {
      hideContent({
        userId: user.$id,
        contentId: pendingSafetyTarget.contentId,
        contentType: pendingSafetyTarget.type || "post",
      }).catch((err) => console.log("hideContent sync error:", err));
    }

    setSafetySheetVisible(false);
    setPendingSafetyTarget(null);
  };

  const executeBlockUser = async () => {
    if (!pendingSafetyTarget?.ownerId || !user?.$id) return;
    setBlockingUser(true);
    try {
      const res = await blockUser({
        blockerId: user.$id,
        blockedUserId: pendingSafetyTarget.ownerId,
        contentId: pendingSafetyTarget.contentId,
        contentType: pendingSafetyTarget.type || "post",
        reason: "User blocked from feed",
      });

      // Auto-unfollow blocked user to fully sever feed/story ties
      try {
        await FollowService.unfollowUser({ followerId: user.$id, followingId: pendingSafetyTarget.ownerId });
      } catch (err) {
        console.log("auto-unfollow failed", err);
      }

      setBlockedUserIds((prev) => new Set([...prev, pendingSafetyTarget.ownerId]));
      if (pendingSafetyTarget.contentId) {
        setHiddenContentIds((prev) => new Set([...prev, pendingSafetyTarget.contentId]));
      }
      pendingAlertMessage.current = res
        ? "User blocked and content hidden."
        : "Blocked locally. Connect the backend collection to persist this block.";
    } catch (error) {
      console.log("blockUser error", error);
      pendingAlertMessage.current = "Unable to block this user right now. Please try again.";
    } finally {
      setBlockingUser(false);
      setSafetySheetVisible(false);
      setReportModalVisible(false);
      setPendingSafetyTarget(null);
      setPendingReportOpen(false);
    }
  };

  const confirmBlockUser = () => {
    if (!pendingSafetyTarget?.ownerId) return;
    Alert.alert(
      "Block user",
      `Block ${pendingSafetyTarget.ownerName}? Their posts will disappear from your feed immediately and we'll review this account.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Block", style: "destructive", onPress: executeBlockUser },
      ],
    );
  };

  const openTermsLink = () => {
    Linking.openURL(`${secrets.WEBSITE}/terms-of-service`);
  };

  const onRefresh = async () => {
    videoRefs.current = {};
    await loadFeed({ refreshMode: true });
    setRefreshCounter((prev) => prev + 1);
  };

  const updatePostCommentCount = (postId, newCount) => {
    setPosts((prev) =>
      prev.map((item) => (item.type === "post" && item.data?.$id === postId ? { ...item, data: { ...item.data, postComments: newCount } } : item)),
    );

    setFilteredPosts((prev) =>
      prev.map((item) => (item.type === "post" && item.data?.$id === postId ? { ...item, data: { ...item.data, postComments: newCount } } : item)),
    );

    setCurrentPost((prev) => (prev?.$id === postId ? { ...prev, postComments: newCount } : prev));
  };

  const updatePostLikeCount = (postId, newCount, isLikedByCurrentUser) => {
    setPosts((prev) =>
      prev.map((item) =>
        item.type === "post" && item.data?.$id === postId
          ? {
              ...item,
              data: {
                ...item.data,
                postLikes: newCount,
                ...(typeof isLikedByCurrentUser === "boolean" ? { isLikedByCurrentUser } : {}),
              },
            }
          : item,
      ),
    );

    setFilteredPosts((prev) =>
      prev.map((item) =>
        item.type === "post" && item.data?.$id === postId
          ? {
              ...item,
              data: {
                ...item.data,
                postLikes: newCount,
                ...(typeof isLikedByCurrentUser === "boolean" ? { isLikedByCurrentUser } : {}),
              },
            }
          : item,
      ),
    );

    setCurrentPost((prev) =>
      prev?.$id === postId ? { ...prev, postLikes: newCount, ...(typeof isLikedByCurrentUser === "boolean" ? { isLikedByCurrentUser } : {}) } : prev,
    );
  };

  const handlePostDeleted = useCallback(
    (postId) => {
      if (!postId) return;
      setExpandedIndex(null);
      setExpandedMenuIndex(null);
      setPosts((prev) => prev.filter((p) => p.data?.$id !== postId));
      setFilteredPosts((prev) => prev.filter((p) => p.data?.$id !== postId));
      dispatch(removePendingPost({ postId }));
    },
    [dispatch],
  );

  const restoreDeletedPost = useCallback(
    (post) => {
      if (!post?.$id) return;
      const entry = { type: "post", data: post, key: `post-${post.$id}` };
      setPosts((prev) => (prev.some((p) => p.data?.$id === post.$id) ? prev : [entry, ...prev]));
      if (isSearching) {
        setFilteredPosts((prev) => (prev.some((p) => p.data?.$id === post.$id) ? prev : [entry, ...prev]));
      }
    },
    [isSearching],
  );

  const requestDeletePost = useCallback(
    (post) => {
      if (!post?.$id) return;
      handlePostDeleted(post.$id);
      InteractionManager.runAfterInteractions(() => {
        deletePost({ ID: post.$id })
          .then(() => {
            showMessage("Post deleted.", 500);
          })
          .catch((error) => {
            console.log("deletePost: error", error);
            restoreDeletedPost(post);
            showMessage("Unable to delete post. Restored.", 600);
          });
      });
    },
    [handlePostDeleted, restoreDeletedPost, showMessage],
  );
  const handleUserPress = useCallback(
    (profileUser) => {
      if (!profileUser?.$id) return;
      if (user?.$id === profileUser.$id) {
        router.push("/profile");
        return;
      }
      router.push({ pathname: "/creator-profile", params: { userId: profileUser.$id } });
    },
    [user?.$id],
  );

  const handleScroll = (event) => {
    const y = event?.nativeEvent?.contentOffset?.y ?? 0;
    const delta = y - lastScrollY.current;
    const holdTabBarHidden = isSearchFocusedRef.current;
    const viewportHeight = event?.nativeEvent?.layoutMeasurement?.height ?? 0;
    const contentHeight = event?.nativeEvent?.contentSize?.height ?? 0;

    if (viewportHeight > 0 && contentHeight > 0) {
      const distanceFromBottom = contentHeight - (y + viewportHeight);
      const prefetchDistance = viewportHeight * FEED_PREFETCH_VIEWPORT_MULTIPLIER;
      if (distanceFromBottom <= prefetchDistance) {
        triggerPaginationPrefetch();
      }
    }

    const showTabBar = () => {
      if (!navHiddenRef.current) return;
      navHiddenRef.current = false;
      if (!holdTabBarHidden) {
        tabNavigationEvents.emit("tabBarVisibility", { visible: true });
      }
    };

    const hideTabBar = () => {
      if (navHiddenRef.current) return;
      navHiddenRef.current = true;
      if (!holdTabBarHidden) {
        tabNavigationEvents.emit("tabBarVisibility", { visible: false });
      }
    };

    if (y <= 0) {
      showTabBar();
      lastScrollY.current = y;
      return;
    }

    if (Math.abs(delta) < 6) {
      lastScrollY.current = y;
      return;
    }

    if (delta > 12 && y > 60) {
      hideTabBar();
    } else if (delta < -12) {
      showTabBar();
    }

    lastScrollY.current = y;
  };

  const handleSearchFocus = useCallback(() => {
    if (isSearchFocusedRef.current) return;
    isSearchFocusedRef.current = true;
    tabNavigationEvents.emit("tabBarVisibility", { visible: false });
  }, []);

  const handleSearchBlur = useCallback(() => {
    if (!isSearchFocusedRef.current) return;
    isSearchFocusedRef.current = false;
    if (!navHiddenRef.current) {
      tabNavigationEvents.emit("tabBarVisibility", { visible: true });
    }
  }, []);

  const onViewableItemsChanged = useRef(({ viewableItems }) => {
    viewableItems.forEach((entry) => markSeenPost(entry?.item));

    const visibleKeys = viewableItems.map((v) => v.item?.key).filter(Boolean);
    lastViewableKeysRef.current = visibleKeys;

    if (!isHomeFocused.current) {
      Object.values(videoRefs.current).forEach((ref) => ref?.pauseVideo?.());
      currentlyPlayingKey.current = null;
      return;
    }

    if (visibleKeys.length === 0) {
      Object.values(videoRefs.current).forEach((ref) => ref?.pauseVideo?.());
      currentlyPlayingKey.current = null;
      return;
    }

    const playableItems = viewableItems.filter((entry) => isPlayableFeedItem(entry?.item));
    const sortedPlayable = playableItems.slice().sort((a, b) => {
      const aIndex = typeof a?.index === "number" ? a.index : Number.MAX_SAFE_INTEGER;
      const bIndex = typeof b?.index === "number" ? b.index : Number.MAX_SAFE_INTEGER;
      return aIndex - bIndex;
    });
    const mainKey = sortedPlayable.length > 0 ? sortedPlayable[0]?.item?.key : null;

    if (!mainKey) {
      Object.values(videoRefs.current).forEach((ref) => ref?.pauseVideo?.());
      currentlyPlayingKey.current = null;
      pendingPlaybackKey.current = null;
      return;
    }

    if (currentlyPlayingKey.current !== mainKey) {
      syncPlaybackToKey(mainKey);
      return;
    }

    const activeRef = videoRefs.current[mainKey];
    if (activeRef) {
      resumeVideoRef(activeRef);
      if (pendingPlaybackKey.current === mainKey) pendingPlaybackKey.current = null;
    }
  }).current;

  const renderItem = useCallback(
    ({ item, index }) => {
      const { type, data, key } = item;

      if (type === "user") {
        const isSelf = user?.$id === data?.$id;
        return (
          <TouchableOpacity
            className="mx-2 mb-3 flex-row items-center justify-between rounded-2xl px-3 py-3"
            style={{ backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border }}
            activeOpacity={0.7}
            onPress={() => handleUserPress(data)}
          >
            <View className="flex-1 flex-row items-center">
              <FastImage
                source={{ uri: data?.avatar, priority: FastImage.priority.high }}
                className="h-12 w-12 rounded-xl"
                style={{ backgroundColor: theme.surfaceMuted }}
              />
              <View className="ml-3 flex-1">
                <Text className="text-[15px] font-semibold" style={{ color: theme.text }} numberOfLines={1} ellipsizeMode="tail">
                  {data?.username || "User"}
                </Text>
                {hasRoleKey(data, SELECTABLE_ROLE_KEYS.creator) ? (
                  <Text className="mt-0.5 text-xs text-amber-300/80">Creator</Text>
                ) : (
                  <Text className="mt-0.5 text-xs" style={{ color: theme.textSoft }}>
                    User
                  </Text>
                )}
              </View>
            </View>
            <View className="rounded-full px-3 py-1" style={{ backgroundColor: theme.surfaceMuted }}>
              <Text className="text-xs font-semibold" style={{ color: theme.textMuted }}>
                {isSelf ? "You" : "View"}
              </Text>
            </View>
          </TouchableOpacity>
        );
      }

      if (type === "book") {
        return <PostBook item={data} index={index} forceUpdate={refreshCounter} onOpenSafetySheet={() => openSafetySheet({ type, data })} />;
      }

      if (type === "video") {
        const videoNavId = data?.uri || data?.$id;
        const videoDocId = data?.$id;
        return (
          <PostVideo
            item={data}
            videoNavId={videoNavId}
            videoDocId={videoDocId}
            onOpenSafetySheet={() => openSafetySheet({ type, data })}
            mutedPreference={isVideoMuted}
            onMutedChange={handleVideoMuteChange}
            ref={(el) => {
              if (el) {
                videoRefs.current[key] = el;
                const isVisible = lastViewableKeysRef.current?.includes?.(key);
                if (isVisible && (pendingPlaybackKey.current === key || currentlyPlayingKey.current === key)) {
                  resumeVideoRef(el);
                  pendingPlaybackKey.current = null;
                  currentlyPlayingKey.current = key;
                }
              } else {
                delete videoRefs.current[key];
              }
            }}
          />
        );
      }

      if (type === "clip") {
        return (
          <PostClip
            item={data}
            onOpenSafetySheet={() => openSafetySheet({ type, data })}
            ref={(el) => {
              if (el) {
                videoRefs.current[key] = el;
                const isVisible = lastViewableKeysRef.current?.includes?.(key);
                if (isVisible && (pendingPlaybackKey.current === key || currentlyPlayingKey.current === key)) {
                  resumeVideoRef(el);
                  pendingPlaybackKey.current = null;
                  currentlyPlayingKey.current = key;
                }
              } else {
                delete videoRefs.current[key];
              }
            }}
          />
        );
      }

      if (type === "ad") {
        return <PostNativeAd />;
      }

      // "post" or default
      if (data.postResourceId) {
        const isClipPost = data.postResourceType === "clip" || Boolean(data.clip);

        if (isClipPost) {
          return (
            <PostClip
              item={data.clip || data}
              onOpenSafetySheet={() => openSafetySheet({ type: "post", data })}
              ref={(el) => {
                if (el) videoRefs.current[key] = el;
                else delete videoRefs.current[key];
              }}
            />
          );
        }

        // if you want posts-with-video to render like videos
        const videoNavId = data.video?.uri || data.postResourceId || data.video?.$id;
        const videoDocId = data.video?.$id || data.postResourceId;
        return (
          <PostVideo
            isPostFromVideo={true}
            item={data.video || data} // ideally backend attaches full video doc to data.video
            videoNavId={videoNavId}
            videoDocId={videoDocId}
            onOpenSafetySheet={() => openSafetySheet({ type: "post", data })}
            mutedPreference={isVideoMuted}
            onMutedChange={handleVideoMuteChange}
            ref={(el) => {
              if (el) {
                videoRefs.current[key] = el;
                const isVisible = lastViewableKeysRef.current?.includes?.(key);
                if (isVisible && (pendingPlaybackKey.current === key || currentlyPlayingKey.current === key)) {
                  resumeVideoRef(el);
                  pendingPlaybackKey.current = null;
                  currentlyPlayingKey.current = key;
                }
              } else {
                delete videoRefs.current[key];
              }
            }}
          />
        );
      }

      return (
        <PostCard
          item={data}
          index={index}
          flatListRef={flatListRef}
          handleLikesPress={(item) => {
            setCurrentPost(item);
            setLikesModalVisible(true);
          }}
          handleCommentPress={(item) => {
            setCurrentPost(item);
            notificationCommentOpenKeyRef.current = null;
            setCommentModalFocus({ focusCommentId: null, focusReplyId: null });
            setCommentModalResumeToken(null);
            setCommentModalVisible(true);
          }}
          handleSharePress={async (item) => {
            await Share.open({
              message: "Check out this post!",
              url: `${secrets.WEBSITE}/home/${item?.$id}`,
              title: item.posts,
              type: "url",
            });
          }}
          onLikeChange={updatePostLikeCount}
          onOpenImageViewer={({ images: nextImages, initialIndex, item: selectedPost }) => {
            setImages(nextImages);
            setImageViewerInitialIndex(initialIndex);
            setCurrentPost(selectedPost);
            setShowImageViewer(true);
          }}
          onPostDeleteRequest={requestDeletePost}
          isExpanded={expandedIndex === index}
          onToggleExpand={() => setExpandedIndex((prev) => (prev === index ? null : index))}
          isExpandedMenu={expandedMenuIndex === index}
          onToggleExpandMenu={() => setExpandedMenuIndex((prev) => (prev === index ? null : index))}
          onOpenSafetySheet={() => openSafetySheet({ type: "post", data })}
          isPending={data?.clientStatus === "pending"}
        />
      );
    },
    [
      expandedIndex,
      expandedMenuIndex,
      refreshing,
      isVideoMuted,
      handleVideoMuteChange,
      resumeVideoRef,
      handleUserPress,
      requestDeletePost,
      theme,
      user?.$id,
    ],
  );

  return (
    <StyledSafeAreaView edges={["top"]} style={{ backgroundColor: theme.background }}>
      <View className="flex-1 w-full ">
        <View className="px-4 pt-1.5 pb-2">
          <MainScreensHeader
            title="Selebox"
            searchPlaceholder="Search Posts."
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            onSearchFocus={handleSearchFocus}
            onSearchBlur={handleSearchBlur}
          />
        </View>

        <FlashList
          ref={flatListRef}
          data={feedData}
          refreshing={refreshing}
          onRefresh={onRefresh}
          renderItem={renderItem}
          keyExtractor={(item, index) => item?.key || getFeedIdentity(item) || `feed-item-${index}`}
          getItemType={getFeedItemType}
          extraData={extraData}
          onEndReached={triggerPaginationPrefetch}
          onEndReachedThreshold={FEED_ON_END_REACHED_THRESHOLD}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          removeClippedSubviews={false} // 🔥 prevents flicker
          estimatedItemSize={FEED_ESTIMATED_ITEM_SIZE}
          drawDistance={FEED_DRAW_DISTANCE}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 100, paddingTop: 2 }}
          ListHeaderComponent={
            <View className="px-2 pb-1">
              <PostShareYourThoughts onPress={() => router.push("/create-post")} />

              <View className="mt-1.5">
                <View className="mt-0.5">
                  <StoryBar user={user} forceUpdate={refreshing} />
                </View>
              </View>

              <View className="mt-1 h-px" style={{ backgroundColor: theme.divider }} />
            </View>
          }
          ListFooterComponent={
            isFetchingMore ? (
              <View className="items-center py-6">
                <ActivityIndicator size="small" color={theme.primary} />
              </View>
            ) : null
          }
          ListEmptyComponent={
            postsLoading ? (
              <View className="px-2 pb-2 pt-1">
                <PostCardSkeleton count={3} />
              </View>
            ) : searchLoading ? (
              <View className="items-center justify-center px-6 py-14">
                <LoaderKit style={{ width: 50, height: 50 }} name="LineScalePulseOutRapid" color={theme.primary} />
                <Text className="mt-4 text-base font-semibold" style={{ color: theme.text }}>
                  Searching
                </Text>
                <Text className="mt-1 text-sm" style={{ color: theme.textSoft }}>
                  Finding matches for you.
                </Text>
              </View>
            ) : (
              <View className="items-center justify-center px-6 py-14">
                <MaterialIcons name="search-off" size={64} color={theme.textSubtle} />
                <Text className="mt-4 text-base font-semibold" style={{ color: theme.text }}>
                  No results found
                </Text>
                <Text className="mt-2 text-center text-sm" style={{ color: theme.textSoft }}>
                  We couldn’t find anything matching your search.{"\n"}
                  Try different keywords.
                </Text>
              </View>
            )
          }
          refreshControl={
            <RefreshControl
              tintColor={theme.primary}
              titleColor={theme.primary}
              progressBackgroundColor={theme.surface}
              refreshing={refreshing}
              onRefresh={async () => {
                setRefreshing(true);
                try {
                  await onRefresh();
                } finally {
                  setRefreshing(false);
                }
              }}
            />
          }
        />
      </View>

      <ImageViewer
        images={images}
        visible={showImageViewer}
        onClose={() => setShowImageViewer(false)}
        initialIndex={imageViewerInitialIndex}
        postItem={currentPost}
        handleSharePress={async (item) => {
          await Share.open({
            message: "Check out this post!",
            url: `${secrets.WEBSITE}/home/${item?.$id}`,
            title: item.posts,
            type: "url",
          });
        }}
        onLikeChange={updatePostLikeCount}
        onCommentChange={updatePostCommentCount}
      />

      <PostCommentModal
        isVisible={isCommentModalVisible}
        onClose={() => {
          setCommentModalVisible(false);
          notificationCommentOpenKeyRef.current = null;
          setCommentModalFocus({ focusCommentId: null, focusReplyId: null });
          setCommentModalResumeToken(null);
        }}
        item={currentPost}
        onCommentPosted={(newCount) => {
          if (!currentPost?.$id) return;
          updatePostCommentCount(currentPost.$id, newCount);
        }}
        focusCommentId={commentModalFocus.focusCommentId}
        focusReplyId={commentModalFocus.focusReplyId}
        resumeScope="home"
        resumeToken={commentModalResumeToken}
      />

      <PostLikesModal isVisible={isLikesModalVisible} onClose={() => setLikesModalVisible(false)} item={currentPost} />

      <Modal
        isVisible={safetySheetVisible}
        onBackdropPress={closeSafetySheet}
        onBackButtonPress={closeSafetySheet}
        backdropOpacity={0.6}
        useNativeDriver
        onModalHide={() => {
          if (pendingAlertMessage.current) {
            showMessage(pendingAlertMessage.current, 100);
            pendingAlertMessage.current = null;
          }
        }}
      >
        <View className="rounded-2xl px-5 py-5" style={{ backgroundColor: theme.surfaceElevated }}>
          <Text className="text-lg font-semibold" style={{ color: theme.text }}>
            Post actions
          </Text>

          <TouchableOpacity className="mt-4 rounded-xl px-4 py-3" style={{ backgroundColor: theme.surfaceMuted }} onPress={handleHideContent}>
            <View className="flex flex-row items-center">
              <MaterialIcons name="visibility-off" size={22} color={theme.icon} style={{ marginRight: 12 }} />
              <View>
                <Text className="text-base font-semibold" style={{ color: theme.text }}>
                  Hide post
                </Text>
                <Text className="mt-1 text-xs" style={{ color: theme.textSoft }}>
                  See fewer like this
                </Text>
              </View>
            </View>
          </TouchableOpacity>

          <TouchableOpacity className="mt-2 rounded-xl px-4 py-3" style={{ backgroundColor: theme.surfaceMuted }} onPress={openReportModal}>
            <View className="flex flex-row items-center">
              <MaterialIcons name="flag" size={22} color={theme.icon} style={{ marginRight: 12 }} />
              <View>
                <Text className="text-base font-semibold" style={{ color: theme.text }}>
                  Report post
                </Text>
                <Text className="mt-1 text-xs" style={{ color: theme.textSoft }}>
                  Tell us what’s wrong
                </Text>
              </View>
            </View>
          </TouchableOpacity>

          <TouchableOpacity
            className="mt-2 rounded-xl px-4 py-3"
            style={{ backgroundColor: theme.surfaceMuted }}
            onPress={confirmBlockUser}
            disabled={blockingUser || !pendingSafetyTarget?.ownerId}
          >
            <View className="flex flex-row items-center justify-between">
              <View className="flex flex-row items-center">
                <MaterialIcons name="block" size={22} color={theme.icon} style={{ marginRight: 12 }} />
                <View>
                  <Text className="text-base font-semibold" style={{ color: theme.text }}>
                    Block user
                  </Text>
                  <Text className="mt-1 text-xs" style={{ color: theme.textSoft }}>
                    Stop seeing anything from them
                  </Text>
                </View>
              </View>
              {blockingUser ? <ActivityIndicator size="small" color={theme.primary} /> : null}
            </View>
          </TouchableOpacity>

          <TouchableOpacity className="mt-3 items-center" onPress={closeSafetySheet}>
            <Text className="text-sm" style={{ color: theme.textMuted }}>
              Cancel
            </Text>
          </TouchableOpacity>
        </View>
      </Modal>

      <Modal
        isVisible={reportModalVisible}
        onBackdropPress={() => setReportModalVisible(false)}
        onBackButtonPress={closeReportModal}
        backdropOpacity={0.7}
        useNativeDriver
        avoidKeyboard
        onModalHide={() => {
          if (pendingAlertMessage.current) {
            showMessage(pendingAlertMessage.current, 100);
            pendingAlertMessage.current = null;
          }
        }}
      >
        <View className="rounded-2xl px-5 py-6" style={{ backgroundColor: theme.surfaceElevated }}>
          <Text className="text-lg font-semibold" style={{ color: theme.text }}>
            Report content
          </Text>
          <Text className="mt-1 text-sm" style={{ color: theme.textMuted }}>
            Tell us what is wrong. We review every report.
          </Text>

          <View className="mt-3 flex-row flex-wrap">
            {REPORT_REASONS.map((reason) => {
              const selected = selectedReportReason === reason;
              return (
                <TouchableOpacity
                  key={reason}
                  onPress={() => setSelectedReportReason(reason)}
                  className="mb-2 mr-2 rounded-full border px-3 py-2"
                  style={{
                    borderColor: selected ? theme.primary : theme.border,
                    backgroundColor: selected ? theme.primarySoft : theme.surface,
                  }}
                >
                  <Text className="text-xs font-semibold" style={{ color: selected ? theme.primary : theme.text }}>
                    {reason}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <TextInput
            value={reportNotes}
            onChangeText={setReportNotes}
            placeholder="Add details to help our review (optional)"
            placeholderTextColor={theme.placeholder}
            multiline
            className="mt-3 rounded-xl px-3 py-2"
            style={{
              minHeight: 70,
              textAlignVertical: "top",
              color: theme.inputText,
              borderWidth: 1,
              borderColor: theme.inputBorder,
              backgroundColor: theme.inputBackground,
            }}
          />

          <TouchableOpacity
            className="mt-4 rounded-xl px-4 py-3"
            style={{ backgroundColor: !selectedReportReason || submittingReport ? theme.surfaceStrong : theme.primary }}
            onPress={submitReport}
            disabled={!selectedReportReason || submittingReport}
          >
            <View className="flex flex-row items-center justify-center space-x-2">
              {submittingReport ? <ActivityIndicator size="small" color={theme.primaryContrast} /> : null}
              <Text className="text-center text-base font-semibold" style={{ color: theme.primaryContrast }}>
                {submittingReport ? "Sending report..." : "Submit report"}
              </Text>
            </View>
            <Text className="mt-1 text-center text-xs" style={{ color: theme.primaryContrast }}>
              We will remove it from your feed immediately.
            </Text>
          </TouchableOpacity>

          <TouchableOpacity className="mt-3 items-center" onPress={closeReportModal} disabled={pendingReportOpen}>
            <Text className="text-sm" style={{ color: theme.textMuted }}>
              Back
            </Text>
          </TouchableOpacity>
        </View>
      </Modal>

      {showEulaModal && (
        <Modal isVisible={true} backdropOpacity={0.75} useNativeDriver onBackdropPress={() => {}} onBackButtonPress={() => {}}>
          <View
            className="mx-1 overflow-hidden rounded-3xl"
            style={{ maxHeight: screenHeight * 0.85, borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surfaceElevated }}
          >
            <View className="flex-row items-center px-5 py-4" style={{ backgroundColor: theme.surfaceMuted }}>
              <View className="mr-2 rounded-2xl p-3" style={{ backgroundColor: theme.primarySoft }}>
                <MaterialIcons name="verified-user" size={22} color={theme.primary} />
              </View>
              <View className="flex-1">
                <Text className="text-base font-semibold" style={{ color: theme.text }}>
                  Community agreement
                </Text>
                <Text className="mt-0.5 text-xs" style={{ color: theme.textMuted }}>
                  Selebox stays safe when we all uphold the rules.
                </Text>
              </View>
              <View className="rounded-full px-3 py-1" style={{ backgroundColor: theme.surface }}>
                <Text className="text-xs font-semibold" style={{ color: theme.textMuted }}>
                  Required
                </Text>
              </View>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: screenHeight * 0.7 }}>
              <View className="px-5 py-5">
                <Text className="text-sm" style={{ color: theme.textMuted }}>
                  Selebox is a zero-tolerance community: no hate, harassment, explicit content, violence, or illegal activity. Continue only if you
                  agree to our End User License Agreement and will report abusive users.
                </Text>

                <View className="mt-4">
                  {EULA_POINTS.map((point) => (
                    <View key={point.title} className="mb-3 flex-row items-start rounded-2xl px-3.5 py-3" style={{ backgroundColor: theme.surface }}>
                      <View className="mt-1">
                        <MaterialIcons name={point.icon} size={20} color={theme.primary} />
                      </View>
                      <View className="ml-3 flex-1">
                        <Text className="text-sm font-semibold" style={{ color: theme.text }}>
                          {point.title}
                        </Text>
                        <Text className="mt-1 text-xs" style={{ color: theme.textMuted }}>
                          {point.subtitle}
                        </Text>
                      </View>
                    </View>
                  ))}
                </View>

                <View className="mt-5 flex-row space-x-3">
                  <TouchableOpacity
                    className="flex-1 rounded-xl px-4 py-3"
                    style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surface }}
                    onPress={openTermsLink}
                  >
                    <View className="flex flex-row items-center justify-center space-x-2">
                      <MaterialIcons name="open-in-new" size={18} color={theme.primary} />
                      <Text className="text-sm font-semibold" style={{ color: theme.text }} numberOfLines={1} ellipsizeMode="tail">
                        View terms
                      </Text>
                    </View>
                  </TouchableOpacity>

                  <TouchableOpacity className="flex-1 rounded-xl px-4 py-3" style={{ backgroundColor: theme.primary }} onPress={handleAcceptEula}>
                    <Text
                      className="text-center text-sm font-semibold"
                      style={{ color: theme.primaryContrast }}
                      numberOfLines={1}
                      ellipsizeMode="tail"
                    >
                      Agree & continue
                    </Text>
                  </TouchableOpacity>
                </View>

                <Text className="mt-3 text-center text-xs" style={{ color: theme.textSoft }}>
                  Required to continue using Selebox.
                </Text>
              </View>
            </ScrollView>
          </View>
        </Modal>
      )}

      <CampaignAdModal
        enabled={Boolean(user?.$id) && hasResolvedEula && !showEulaModal && !isOffline}
        userId={user?.$id}
        onMessage={showMessage}
        onModalOpen={() => syncPlaybackToKey(null)}
        onModalClose={resumeVisibleMedia}
      />

      <CustomAlertModal message={message} messageOpen={messageOpen} closeMessage={closeMessage} />
    </StyledSafeAreaView>
  );
};

export default Home;
