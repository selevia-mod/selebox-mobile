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
import FastImage from "react-native-fast-image";
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
  // PostClip removed — clips feature retired May 2026.
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
import {
  attachIsLikedByCurrentUser,
  deletePost,
  fetchDiscoverPosts,
  fetchFollowingPosts,
  fetchGeneratedPosts,
  getPost,
  recordPostView,
} from "../../lib/posts";
import { USE_SUPABASE_POSTS } from "../../lib/feature-flags";
import {
  adaptSupabasePostToAppwriteShape,
  fetchDiscoverFeedPage,
  fetchFeedDelta,
  fetchFeedPage,
  fetchFollowingFeedPage,
  fetchForYouFeedPage,
  fetchPostStats,
  loadUserContentFilters,
  resolveSupabaseUserId,
  trackPostViews,
} from "../../lib/posts-supabase";
// Phase E.3 — gate feed video autoplay by device tier. Low-tier devices
// pause everything (autoplay is the single biggest battery + jank source);
// mid/high devices keep the existing topmost-only behavior.
// Phase E.5 — getFlashListConfig hands back tier-tuned drawDistance +
// removeClippedSubviews + onEndReachedThreshold so the feed shrinks its
// pre-rendered window on low-end phones.
import { getFlashListConfig, isLowTier } from "../../lib/device-tier";
import { hasRoleKey, SELECTABLE_ROLE_KEYS } from "../../lib/user-roles";
import { blockUser, hideContent, listBlockedUsers, listHiddenContent, listUserReports, recordEulaAcceptance, reportContent, snoozeUser } from "../../lib/safety";
import tabNavigationEvents from "../../lib/tab-navigation-events";
import { useModalMessage } from "../../hooks/useModalMessage";
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

// Phase C — runs a Supabase posts fetcher (Discover / Following /
// For-You / profile), fetches batched like + comment stats, adapts each
// row into the Appwrite-shaped object PostCard / PostInformation /
// PostCommentModal expect, and wraps each adapted post in the
// `{ type, data, key }` feed entry shape `renderItem` destructures.
//
// Centralizing this means the three tab branches in loadFeed +
// fetchMorePosts share one path — easier to reason about, harder to
// drift out of sync. Returns { entries, cursor, more }:
//   - entries: feed entries ready to feed normalizeFeed/renderItem
//   - cursor: oldest post's created_at (ISO) for `before`-style pagination
//   - more:   whether the page filled (heuristic: page.length === PAGE_SIZE)
const loadSupabaseFeedPage = async (fetcher, pageSize) => {
  const supabasePosts = (await fetcher()) || [];
  if (supabasePosts.length === 0) {
    return { entries: [], cursor: null, more: false };
  }
  const postIds = supabasePosts.map((p) => p?.id).filter(Boolean);
  const stats = await fetchPostStats(postIds);
  const entries = supabasePosts
    .map((p) => {
      const adapted = adaptSupabasePostToAppwriteShape(p, stats);
      if (!adapted?.$id) return null;
      return { type: "post", data: adapted, key: `post-${adapted.$id}` };
    })
    .filter(Boolean);
  const cursor = supabasePosts[supabasePosts.length - 1]?.created_at || null;
  // A page that filled exactly is taken as a strong "probably more"
  // signal. False negative on the last page is harmless — onEndReached
  // will simply no-op.
  const more = pageSize ? supabasePosts.length >= pageSize : false;
  return { entries, cursor, more };
};

// Walks a list of FeedEntry items, collects all post documents, asks
// lib/posts to attach the viewer's like state in ONE batched query, then
// merges the enriched docs back into the entries. Replaces the prior
// behaviour where every PostCard fetched its own like state on mount.
//
// Phase C.6+ — Supabase-shaped posts (with `_supabase` set by the adapter)
// are skipped here. PostInformation handles their like state through the
// reactions table on mount; running this Appwrite query against UUIDs
// would produce nothing and waste a roundtrip.
const enrichEntriesWithLikeState = async (entries, viewerUserId) => {
  if (!Array.isArray(entries) || entries.length === 0) return entries;
  if (!viewerUserId) return entries;

  const postEntries = entries.filter(
    // Skip Supabase-shaped posts — PostInformation reads their like
    // state from the reactions table on mount, and querying Appwrite's
    // postsLike with a UUID would return nothing while still costing a
    // roundtrip + (worse) writing isLikedByCurrentUser=false back onto
    // the post, which PostInformation honors before its Supabase branch.
    (e) => e?.type === "post" && e?.data?.$id && !e?.data?._supabase,
  );
  if (postEntries.length === 0) return entries;

  const enrichedPosts = await attachIsLikedByCurrentUser(
    postEntries.map((e) => e.data),
    viewerUserId,
  );
  const byId = new Map(enrichedPosts.map((p) => [p?.$id, p]));

  return entries.map((entry) => {
    if (entry?.type !== "post" || !entry?.data?.$id || entry?.data?._supabase) return entry;
    const enriched = byId.get(entry.data.$id);
    return enriched ? { ...entry, data: enriched } : entry;
  });
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
  const { user, chatUserId } = useGlobalContext();
  // The Supabase feed functions (fetchFollowingFeedPage /
  // fetchForYouFeedPage / fetchDiscoverFeedPage) all expect a Supabase
  // UUID, not the Appwrite hex `user.$id` used elsewhere. They have an
  // internal Appwrite→UUID resolver (`resolveSupabaseUserId` via
  // `profiles.legacy_appwrite_id`), but it uses a separate module-level
  // cache from the one chat uses (`getMessagesUserId`), so on cold start
  // the first feed call could lazy-resolve and miss → empty feed for
  // Appwrite-auth users (the entire mobile user base today since
  // USE_SUPABASE_AUTH=false).
  //
  // Reuse the global-provider's already-resolved id (`chatUserId`,
  // populated on auth bootstrap by `setMessagesAppwriteUser` →
  // `profiles.legacy_appwrite_id`). Falls back to `user?.$id` for the
  // Appwrite-only legacy feed paths (when USE_SUPABASE_POSTS=false).
  const supabaseFeedUserId = chatUserId || user?.$id || null;
  const { theme } = useAppTheme();
  const { batchLoadVideoStats } = useVideosStats();
  const isOffline = useIsOffline();

  const [postsLoading, setPostsLoading] = useState(true);
  const [posts, setPosts] = useState([]);
  const [lastId, setLastId] = useState();
  const [hasMore, setHasMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Facebook-pattern feed delta. `lastSeenAt` tracks the newest post's
  // created_at across the rendered list. Pull-to-refresh fetches only
  // posts created since this timestamp instead of re-running the
  // expensive feed_for_you ranker. Updated whenever a fresh page lands
  // (initial load + infinite scroll) and after delta apply.
  const [lastSeenAt, setLastSeenAt] = useState(null);

  // Background-poll buffer + pill. The poll runs every 60s while the
  // app is foregrounded and fills `newPostsBuffer` with hydrated post
  // entries (already adapted to the FlatList's shape). The pill at the
  // top of the feed shows the count and on tap prepends them to the
  // list. NO DB call on tap — the data is already hydrated.
  // (Pill scroll-to-top reuses the existing `flatListRef` declared
  // elsewhere in this component.)
  const [newPostsBuffer, setNewPostsBuffer] = useState([]);
  // Stable id-set for fast dedup against repeat polls and the live feed.
  const newPostsBufferIdsRef = useRef(new Set());
  const feedAppStateRef = useRef(AppState.currentState);
  // Active feed tab — "for-you" (personalized via feed generator), "following"
  // (followed users only), or "discover" (newest posts excluding followed).
  const [feedTab, setFeedTab] = useState("for-you");
  const feedTabRef = useRef("for-you");
  const [followingCount, setFollowingCount] = useState(null); // null=unknown, 0=empty-state CTA
  // Per-tab session cache so switching tabs after first load is instant.
  // Lost on app remount — pull-to-refresh on a tab still does a network refresh.
  // For You also has a redux persist layer below (cachedPosts), this just adds
  // a parallel in-memory snapshot for quick switching during the session.
  const tabCacheRef = useRef({}); // { [tab]: { posts, lastId, hasMore, cursor, followingCount? } }
  // lastReRankAtRef — timestamp of the last time pull-to-refresh
  // triggered a feed_for_you re-rank. Throttled to 30s between
  // re-ranks so a user mashing pull-to-refresh doesn't hammer the
  // ranker. Used by the rotation strategy: when fetchFeedDelta returns
  // 0 new posts, fall through to feed_for_you (which excludes posts
  // seen in the last 24h, per the 3-tier cascade), giving the user
  // fresh content even when nothing new has been posted.
  const lastReRankAtRef = useRef(0);
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

  const [isCommentModalVisible, setCommentModalVisible] = useState(false);
  const [isLikesModalVisible, setLikesModalVisible] = useState(false);
  const [currentPost, setCurrentPost] = useState();
  const [commentModalFocus, setCommentModalFocus] = useState({ focusCommentId: null, focusReplyId: null });
  const [commentModalResumeToken, setCommentModalResumeToken] = useState(null);
  const [isFetchingMore, setIsFetchingMore] = useState(false);

  const { message, messageOpen, closeMessage, showMessage } = useModalMessage();

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
  const [snoozingUser, setSnoozingUser] = useState(false);
  const [showEulaModal, setShowEulaModal] = useState(false);
  const [hasResolvedEula, setHasResolvedEula] = useState(false);
  const [isVideoMuted, setIsVideoMuted] = useState(true);

  const videoRefs = useRef({});
  const currentlyPlayingKey = useRef(null);
  const pendingPlaybackKey = useRef(null);
  const lastViewableKeysRef = useRef([]);
  // Buffer + debounce state for trackPostViews — see onViewableItemsChanged.
  // Set holds post IDs that just entered the viewport since the last flush;
  // timer fires 1.5s after the last viewport change to batch the RPC call.
  const pendingViewIdsRef = useRef(new Set());
  const flushViewsTimerRef = useRef(null);
  const isHomeFocused = useRef(false);
  const isFetchingMoreRef = useRef(false);
  const paginationPrefetchLockRef = useRef(false);
  const paginationPrefetchTsRef = useRef(0);
  const wasBackgrounded = useRef(false);
  const isVideoMutedRef = useRef(true);
  const pendingAlertMessage = useRef(null);
  const postsState = useSelector((state) => state.post);
  const dispatch = useDispatch();
  const PAGE_SIZE = 15;
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
  const feedData = useMemo(() => {
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
  }, [pendingEntries, posts]);
  const feedDataRef = useRef(feedData);
  // Index post entries by $id so notification deep-link lookups (findIndex /
  // find by post id) are O(1) instead of a full feed scan. Hits on:
  //   - openCommentModalForNotification (line ~446)
  //   - useFocusEffect resume handler (line ~524)
  // Both fire on user interaction, so latency matters even though they're rare.
  const feedIndexRef = useRef(new Map());

  useEffect(() => {
    feedDataRef.current = feedData;
    const nextIndex = new Map();
    for (const entry of feedData) {
      const id = entry?.data?.$id;
      if (entry?.type === "post" && id) nextIndex.set(String(id), entry);
    }
    feedIndexRef.current = nextIndex;
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
      // O(1) Map lookup — see feedIndexRef definition above. Falls back to
      // findIndex only if the index is somehow stale.
      const indexedEntry = feedIndexRef.current.get(String(focusPostIdParam));
      let targetIndex = indexedEntry
        ? currentFeed.indexOf(indexedEntry)
        : currentFeed.findIndex((entry) => entry?.type === "post" && String(entry?.data?.$id || "") === String(focusPostIdParam));
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
      // O(1) Map lookup; falls back to .find for safety against stale index.
      const matchedPost =
        feedIndexRef.current.get(targetPostId)?.data ||
        currentFeed.find((entry) => entry?.type === "post" && String(entry?.data?.$id || "") === targetPostId)?.data;
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
  // Phase E.5 — drawDistance + removeClippedSubviews + threshold
  // come from the tier-aware helper. Memoize once per render via
  // useMemo so the FlashList prop identity doesn't change every
  // render and force re-layout. screenHeight is module-level constant.
  const flashListConfig = useMemo(() => getFlashListConfig({ screenHeight }), []);
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
  // Memoized so its identity stays stable across renders. Several useEffects
  // (including the discover/following pre-warm at line ~1054) list this in
  // their dependency array — without useCallback it gets a new identity on
  // every render and the effects re-run constantly, scheduling/cancelling
  // the 1s prewarm timer on every paint and adding event-loop pressure.
  const applySafetyFilters = useCallback(
    (feedItems = []) =>
      feedItems.filter((entry) => {
        const ownerId = resolveOwnerId(entry);
        const contentId = resolveContentId(entry);

        if (ownerId && blockedUserIds.has(ownerId)) return false;
        if (contentId && hiddenContentIds.has(contentId)) return false;

        // Drop ghost entries left behind when an Appwrite auth account was
        // deleted but the user's content (posts/videos/clips) wasn't cleaned up.
        // Symptom: empty avatar + blank username on the card, blank profile
        // screen on tap. Applies to all tabs (For You, Following, Discover).
        const data = entry?.data || entry || {};
        const type = entry?.type || data?.type;

        if (type === "post") {
          if (!data?.postOwner?.username) return false;
          // Post references a deleted video/clip resource.
          if (data?.postResourceType === "video" && !data?.video?.$id) return false;
          if (data?.postResourceType === "clip" && !data?.clip?.$id) return false;
        } else if (type === "video") {
          if (!data?.uploader?.username && !data?.uploader?.name) return false;
        } else if (type === "clip") {
          if (!data?.uploader?.username && !data?.uploader?.name) return false;
        }

        return true;
      }),
    [blockedUserIds, hiddenContentIds],
  );
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
        // Dual-source the safety lists during the migration window:
        //   - Appwrite (legacy) — covers historical mobile-only blocks
        //     and contentReports + hides that haven't been backfilled yet.
        //     IDs come back as Appwrite hex.
        //   - Supabase (new) — covers blocks/hides done on web AND
        //     anything mobile dual-wrote since the safety.js update.
        //     IDs come back as Supabase UUIDs.
        // We populate BOTH sets so the in-memory home-feed filter checks
        // either form. The Supabase filter loaded by posts-supabase.js's
        // loadUserContentFilters is the authoritative source for the
        // post-fetch shouldHidePost pass; this state is only the
        // last-resort UI-side filter for legacy code paths.
        const [blocked, reported, hidden, supabaseFilters] = await Promise.all([
          listBlockedUsers({ blockerId: user.$id }).catch(() => []),
          listUserReports({ reporterId: user.$id }).catch(() => []),
          listHiddenContent({ userId: user.$id }).catch(() => []),
          // resolveSupabaseUserId is what posts-supabase uses internally;
          // we pass user.$id (Appwrite hex) and it resolves through
          // profiles.legacy_appwrite_id.
          (async () => {
            try {
              const resolved = await resolveSupabaseUserId(user.$id);
              if (!resolved) return null;
              return await loadUserContentFilters(resolved);
            } catch (_) {
              return null;
            }
          })(),
        ]);

        // Combine Appwrite hex IDs and Supabase UUIDs in the same set so
        // the in-memory filter at line ~739 catches whichever form the
        // post happens to carry. Posts coming back from Supabase have
        // user_id = UUID; posts from the Appwrite fallback path have
        // user_id = hex. The set holding both means the .has() check
        // matches in either case.
        const blockedSet = new Set(blocked);
        const hiddenSet = new Set([...reported, ...hidden]);
        if (supabaseFilters) {
          supabaseFilters.blockedUserIds.forEach((id) => blockedSet.add(id));
          supabaseFilters.hiddenPostIds.forEach((id) => hiddenSet.add(id));
          // Snoozes are user-targeted (not post-targeted), so they map
          // into the blocked set conceptually for the UI-filter pass —
          // it doesn't distinguish between block and snooze for the
          // hide effect. (Snooze rows expire; loadUserContentFilters
          // already filters them by expires_at > now.)
          supabaseFilters.snoozedUserIds.forEach((id) => blockedSet.add(id));
        }
        setBlockedUserIds(blockedSet);
        setHiddenContentIds(hiddenSet);
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
  }, [blockedUserIds, hiddenContentIds]);

  // Pre-warm Following + Discover tabs in the background ~1s after the
  // initial For-You load lands. Without this, tapping Following or
  // Discover for the first time triggered a synchronous network fetch
  // that took 600–1500ms to paint anything — the "switching tab looks
  // like bug and has a delay" behavior the user flagged. With pre-warm,
  // tabCacheRef is populated by the time the user taps, so
  // handleSwitchTab takes the cached-restore branch and the switch is
  // instant.
  //
  // Guards:
  //   - Only fires once per mount (prewarmedRef).
  //   - Skips if the current viewer's id isn't ready yet.
  //   - Skips if For-You is still loading (we don't want to fight for
  //     bandwidth with the initial paint).
  //   - Each tab's pre-warm is best-effort — failure on Following
  //     doesn't abort Discover and vice versa.
  const prewarmedRef = useRef(false);
  useEffect(() => {
    if (prewarmedRef.current) return;
    if (!user?.$id) return;
    if (postsLoading) return;
    if (!supabaseFeedUserId) return; // Need the resolved Supabase id for the RPCs.
    prewarmedRef.current = true;

    const handle = setTimeout(async () => {
      const tasks = [];
      // Following — chronological from followed creators.
      if (!tabCacheRef.current.following) {
        tasks.push(
          (async () => {
            try {
              const result = await loadSupabaseFeedPage(
                () => fetchFollowingFeedPage({ userId: supabaseFeedUserId, limit: PAGE_SIZE }),
                PAGE_SIZE,
              );
              const filtered = applySafetyFilters(result.entries);
              const enriched = await enrichEntriesWithLikeState(filtered, user?.$id);
              tabCacheRef.current.following = {
                posts: enriched,
                lastId: result.cursor,
                hasMore: result.more,
                cursor: enriched.length,
                followingCount: null,
              };
            } catch (err) {
              // Best-effort — failure here just means the user gets
              // the original cold-load on first tap, same as before.
              console.log("[home] following pre-warm failed:", err?.message);
            }
          })(),
        );
      }
      // Discover — trending velocity, last 7 days, excludes followed.
      if (!tabCacheRef.current.discover) {
        tasks.push(
          (async () => {
            try {
              const result = await loadSupabaseFeedPage(
                () => fetchDiscoverFeedPage({ userId: supabaseFeedUserId, limit: PAGE_SIZE, offset: 0 }),
                PAGE_SIZE,
              );
              const filtered = applySafetyFilters(result.entries);
              const enriched = await enrichEntriesWithLikeState(filtered, user?.$id);
              tabCacheRef.current.discover = {
                posts: enriched,
                lastId: result.cursor,
                hasMore: result.more,
                cursor: enriched.length,
              };
            } catch (err) {
              console.log("[home] discover pre-warm failed:", err?.message);
            }
          })(),
        );
      }
      await Promise.all(tasks);
    }, 1000);

    return () => clearTimeout(handle);
  }, [user?.$id, postsLoading, supabaseFeedUserId, applySafetyFilters, enrichEntriesWithLikeState]);

  useEffect(() => {
    seenPostIdsRef.current = new Set();
    seenPostEngagementRef.current = new Map();
    sentPostViewsRef.current = new Set();
    viewerUserIdRef.current = user?.$id || null;
  }, [user?.$id]);

  useEffect(() => {
    localCursorRef.current = localCursor;
  }, [localCursor]);

  // Keep feedTabRef in sync so loadFeed/fetchMorePosts can read the active tab
  // without being re-created on every tab switch.
  useEffect(() => {
    feedTabRef.current = feedTab;
  }, [feedTab]);

  const handleSwitchTab = (nextTab) => {
    if (nextTab === feedTab) return;

    // Snapshot the outgoing tab's state so we can restore instantly on return.
    tabCacheRef.current[feedTab] = {
      posts,
      lastId,
      hasMore,
      cursor: localCursorRef.current,
      followingCount: feedTab === "following" ? followingCount : undefined,
    };

    feedTabRef.current = nextTab;
    setFeedTab(nextTab);

    const cached = tabCacheRef.current[nextTab];
    if (cached && Array.isArray(cached.posts) && cached.posts.length > 0) {
      // Restore from cache — no network call.
      setPosts(cached.posts);
      setLastId(cached.lastId);
      setHasMore(cached.hasMore);
      localCursorRef.current = cached.cursor || 0;
      setLocalCursor(cached.cursor || 0);
      if (nextTab === "following" && typeof cached.followingCount === "number") {
        setFollowingCount(cached.followingCount);
      }
      setPostsLoading(false);
      return;
    }

    // No cache — load fresh.
    setPosts([]);
    setLastId(undefined);
    setHasMore(false);
    localCursorRef.current = 0;
    setLocalCursor(0);
    loadFeed({ refreshMode: false, tab: nextTab });
  };

  const loadFeed = async ({ refreshMode = false, tab } = {}) => {
    const activeTab = tab || feedTabRef.current || feedTab;
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
      const safetyParams = {
        blockedUserIds: Array.from(blockedUserIds),
        hiddenContentIds: Array.from(hiddenContentIds),
      };

      let feed = [];
      let nextCursor = null;
      let hasMoreRes = false;

      if (activeTab === "following") {
        // Phase C.8 — Supabase Following read path. Same flag as Discover
        // (USE_SUPABASE_POSTS): when on, we query posts WHERE user_id IN
        // (people I follow) ordered by created_at desc. The Appwrite
        // path additionally returns a followingCount for the empty-state
        // CTA; on Supabase we leave that as null (the home screen handles
        // null gracefully — it just hides the count chip).
        if (USE_SUPABASE_POSTS) {
          const result = await loadSupabaseFeedPage(() => fetchFollowingFeedPage({ userId: supabaseFeedUserId, limit: PAGE_SIZE }), PAGE_SIZE);
          feed = result.entries;
          nextCursor = result.cursor;
          hasMoreRes = result.more;
          setFollowingCount(null);
        } else {
          const res = await fetchFollowingPosts({ userId: user?.$id, limit: PAGE_SIZE, ...safetyParams });
          feed = res.feed || [];
          nextCursor = res.nextCursor;
          hasMoreRes = res.hasMore;
          setFollowingCount(typeof res.followingCount === "number" ? res.followingCount : null);
        }
      } else if (activeTab === "discover") {
        // Discover — Postgres-RPC feed: last 7 days of posts from creators
        // the viewer doesn't follow yet, with < 100 followers (the
        // "discover new accounts" filter). Ordered chronologically newest
        // first. Refresh always starts at offset 0.
        if (USE_SUPABASE_POSTS) {
          const result = await loadSupabaseFeedPage(
            () => fetchDiscoverFeedPage({ userId: supabaseFeedUserId, limit: PAGE_SIZE, offset: 0 }),
            PAGE_SIZE,
          );
          feed = result.entries;
          nextCursor = result.cursor;
          hasMoreRes = result.more;
        } else {
          const res = await fetchDiscoverPosts({ userId: user?.$id, limit: PAGE_SIZE, ...safetyParams });
          feed = res.feed || [];
          nextCursor = res.nextCursor;
          hasMoreRes = res.hasMore;
        }
      } else {
        // For You — Postgres-RPC algorithmic feed: tag/author affinity
        // (built nightly from the user's like/comment/repost/follow
        // history with 30-day decay) + log-engagement + recency + same-
        // author diversity penalty + small random freshness. Falls back
        // to the legacy Appwrite recommender when USE_SUPABASE_POSTS is
        // off so we can flip the flag without a code change.
        if (USE_SUPABASE_POSTS) {
          const result = await loadSupabaseFeedPage(
            () => fetchForYouFeedPage({ userId: supabaseFeedUserId, limit: PAGE_SIZE, offset: 0 }),
            PAGE_SIZE,
          );
          feed = result.entries;
          nextCursor = result.cursor;
          hasMoreRes = result.more;
        } else {
          const res = await fetchGeneratedPosts({
            limit: PAGE_SIZE,
            userId: user?.$id,
            ...seenPayload,
            refresh: refreshMode,
          });
          feed = res.feed || [];
          nextCursor = res.nextCursor;
          hasMoreRes = res.hasMore;
        }
      }

      globalKeyCounter.current = 0; // Reset counter on fresh load
      const normalized = normalizeFeed(feed);
      const filtered = applySafetyFilters(normalized);

      // Run the two independent batches in parallel — video stats hits the
      // metrics collection, like state hits postsLike. Sequential awaits here
      // were doubling perceived feed-load latency for nothing.
      const videoIds = extractVideoIds(filtered);
      const [, enriched] = await Promise.all([
        videoIds.length > 0 ? batchLoadVideoStats(videoIds, user?.$id) : Promise.resolve(),
        enrichEntriesWithLikeState(filtered, user?.$id),
      ]);

      setPosts(enriched);
      localCursorRef.current = enriched.length;
      setLocalCursor(enriched.length); // Reset cursor on fresh load
      setLastId(nextCursor);
      setHasMore(hasMoreRes);

      // Facebook-pattern feed: track newest created_at across the feed
      // so onRefresh can do an additive delta fetch on the next pull.
      // We look at the loaded entries' adapted data shape (Appwrite-flavor
      // $createdAt, set by adaptSupabasePostToAppwriteShape).
      if (enriched.length > 0) {
        let newest = null;
        for (const e of enriched) {
          const t = e?.data?.$createdAt;
          if (t && (!newest || t > newest)) newest = t;
        }
        if (newest) setLastSeenAt(newest);
      }

      // Only persist For You to redux cache; Following/Discover are ephemeral.
      if (activeTab === "for-you") {
        dispatch(
          setPost({
            posts: enriched,
            lastId: nextCursor,
            hasMore: hasMoreRes,
            feedUserId: user?.$id || null,
            cachedAt: Date.now(),
          }),
        );
      }
    } finally {
      setPostsLoading(false);
    }
  };

  const fetchMorePosts = useCallback(async () => {
    if (isFetchingMoreRef.current) return;
    isFetchingMoreRef.current = true;

    let networkFetchStarted = false;
    try {
      const activeTab = feedTabRef.current || "for-you";
      const cursor = localCursorRef.current;

      // Cached pagination only applies to For You (the only tab persisted to redux).
      if (activeTab === "for-you" && cursor < cachedPosts.length) {
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

      const safetyParams = {
        blockedUserIds: Array.from(blockedUserIds),
        hiddenContentIds: Array.from(hiddenContentIds),
      };

      let feed = [];
      let apiNextCursor = null;
      let more = false;

      if (activeTab === "following") {
        // Phase C.8 — Supabase Following pagination. `lastId` is the
        // oldest post's created_at from the previous page (stashed by
        // loadFeed/fetchFollowingFeedPage as a string cursor).
        if (USE_SUPABASE_POSTS) {
          const result = await loadSupabaseFeedPage(() => fetchFollowingFeedPage({ userId: supabaseFeedUserId, limit: PAGE_SIZE, before: lastId }), PAGE_SIZE);
          feed = result.entries;
          apiNextCursor = result.cursor;
          more = result.more;
        } else {
          const res = await fetchFollowingPosts({ userId: user?.$id, limit: PAGE_SIZE, lastId, ...safetyParams });
          feed = res.feed || [];
          apiNextCursor = res.nextCursor;
          more = res.hasMore;
        }
      } else if (activeTab === "discover") {
        // Discover pagination — RPC uses integer offset (score isn't
        // monotonic with time, so a created_at cursor would skip rows).
        // posts.length captures everything we've rendered so far for the
        // active tab; refresh resets it to 0 by clearing posts.
        if (USE_SUPABASE_POSTS) {
          const offset = posts.length;
          const result = await loadSupabaseFeedPage(
            () => fetchDiscoverFeedPage({ userId: supabaseFeedUserId, limit: PAGE_SIZE, offset }),
            PAGE_SIZE,
          );
          feed = result.entries;
          apiNextCursor = result.cursor;
          more = result.more;
        } else {
          const res = await fetchDiscoverPosts({ userId: user?.$id, limit: PAGE_SIZE, lastId, ...safetyParams });
          feed = res.feed || [];
          apiNextCursor = res.nextCursor;
          more = res.hasMore;
        }
      } else {
        // For-You pagination — same offset-based RPC contract as Discover.
        // Falls back to the Appwrite recommender when USE_SUPABASE_POSTS
        // is off.
        if (USE_SUPABASE_POSTS) {
          const offset = posts.length;
          const result = await loadSupabaseFeedPage(
            () => fetchForYouFeedPage({ userId: supabaseFeedUserId, limit: PAGE_SIZE, offset }),
            PAGE_SIZE,
          );
          feed = result.entries;
          apiNextCursor = result.cursor;
          more = result.more;
        } else {
          const res = await fetchGeneratedPosts({
            limit: PAGE_SIZE,
            lastId,
            userId: user?.$id,
            ...buildSeenPayload(cachedPosts.length ? cachedPosts : posts),
          });
          feed = res.feed || [];
          apiNextCursor = res.nextCursor;
          more = res.hasMore;
        }
      }

      const normalized = normalizeFeed(feed);
      const filtered = applySafetyFilters(normalized);
      const enriched = await enrichEntriesWithLikeState(filtered, user?.$id);
      const uniqueForStore = filterUniqueFeedItems(cachedPosts, enriched);

      setPosts((prev) => {
        const uniqueForView = filterUniqueFeedItems(prev, uniqueForStore);
        return uniqueForView.length > 0 ? [...prev, ...uniqueForView] : prev;
      });

      const nextCursor = localCursorRef.current + uniqueForStore.length;
      localCursorRef.current = nextCursor;
      setLocalCursor(nextCursor); // Update cursor after API fetch
      setLastId(apiNextCursor);
      setHasMore(more);

      // Only For You hydrates the redux cache (persists across remounts).
      if (activeTab === "for-you") {
        dispatch(
          appendPost({
            posts: uniqueForStore,
            lastId: apiNextCursor,
            hasMore: more,
            feedUserId: user?.$id || null,
            cachedAt: Date.now(),
          }),
        );
      }

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
      // Phase E.3 — On low-tier devices, syncPlaybackToKey is a pure
      // pause-everything operation regardless of mainKey. This catches
      // the modal-close + tab-focus paths that call this directly, not
      // just onViewableItemsChanged.
      if (!mainKey || isLowTier()) {
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

  const triggerPaginationPrefetch = useCallback(async () => {
    const now = Date.now();
    if (paginationPrefetchLockRef.current) return;
    if (now - paginationPrefetchTsRef.current < FEED_PREFETCH_COOLDOWN_MS) return;

    paginationPrefetchLockRef.current = true;
    paginationPrefetchTsRef.current = now;

    try {
      await fetchMorePosts();
    } finally {
      paginationPrefetchLockRef.current = false;
    }
  }, [fetchMorePosts]);

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

  const openSafetySheet = useCallback((target) => {
    if (!target) return;
    const safeTarget = buildSafetyTarget(target);
    setPendingSafetyTarget(safeTarget);
    setSelectedReportReason("");
    setReportNotes("");
    setPendingReportOpen(false);
    setSafetySheetVisible(true);
    setReportModalVisible(false);
  }, []);

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

  // Snooze the post's author for 30 days. Web-parity action — same TTL,
  // same Supabase user_snoozes table. Optimistically adds the owner to
  // blockedUserIds so the in-memory feed filter hides their content
  // immediately; the canonical state lives in Supabase and gets re-read
  // by loadUserContentFilters on next refresh.
  const handleSnoozeUser = async () => {
    if (!pendingSafetyTarget?.ownerId || !user?.$id) {
      closeSafetySheet();
      return;
    }
    setSnoozingUser(true);
    try {
      await snoozeUser({
        userId: user.$id,
        targetUserId: pendingSafetyTarget.ownerId,
        durationDays: 30,
      });
      setBlockedUserIds((prev) => new Set([...prev, pendingSafetyTarget.ownerId]));
      if (pendingSafetyTarget.contentId) {
        setHiddenContentIds((prev) => new Set([...prev, pendingSafetyTarget.contentId]));
      }
      pendingAlertMessage.current = "Snoozed for 30 days. We'll bring them back automatically.";
    } catch (error) {
      console.log("snoozeUser error", error);
      pendingAlertMessage.current = "Couldn't snooze right now. Please try again.";
    } finally {
      setSnoozingUser(false);
      setSafetySheetVisible(false);
      setPendingSafetyTarget(null);
    }
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

  // Pull-to-refresh is now ADDITIVE (Facebook pattern). Instead of
  // re-running the expensive feed_for_you ranker every gesture, we fetch
  // only posts created AFTER the newest one we've seen (lastSeenAt) and
  // prepend them. ~80% reduction in DB load, scroll position preserved,
  // feed feels alive.
  //
  // The For You tab is the primary beneficiary — its ranker is the
  // expensive call. Following / Discover tabs still fall back to a full
  // reload for now since their queries are already cheap.
  //
  // First-time refresh (no lastSeenAt yet) and any non-For-You tab fall
  // through to the legacy full-reload path.
  const onRefresh = async () => {
    videoRefs.current = {};
    if (feedTab !== "for-you" || !lastSeenAt || !user?.$id) {
      await loadFeed({ refreshMode: true });
      setRefreshCounter((prev) => prev + 1);
      return;
    }
    // Fast path — the background poller already buffered new posts.
    // Apply them without another DB roundtrip.
    if (newPostsBuffer.length > 0) {
      applyNewPostsBuffer();
      setRefreshCounter((prev) => prev + 1);
      return;
    }
    try {
      const newPosts = await fetchFeedDelta({
        userId: user.$id,
        sinceTimestamp: lastSeenAt,
        limit: 30,
      });
      if (newPosts.length === 0) {
        // Empty delta = no chronologically-newer posts. Rather than
        // showing the user the same feed again (the "seeing the same
        // post over and over" complaint), re-rank via feed_for_you.
        // The server's 3-tier cascade naturally rotates content:
        //   • Tier 1: last 7 days, NOT seen in last 24h
        //   • Tier 2: last 30 days, NOT seen in last 7 days
        //   • Tier 3: all-time top engagement (last resort)
        // This gives the user fresh content on refresh with zero new
        // posts — exactly matching their "show posts I didn't see
        // today" twist.
        //
        // Throttle: don't re-rank more than once every 30s. Prevents
        // a user mashing pull-to-refresh from melting the ranker.
        const now = Date.now();
        const sinceLastReRank = now - (lastReRankAtRef.current || 0);
        if (sinceLastReRank > 30_000) {
          lastReRankAtRef.current = now;
          await loadFeed({ refreshMode: true });
        }
        setRefreshCounter((prev) => prev + 1);
        return;
      }
      // Hydrate stats + adapt to the FlatList's entry shape.
      const newIds = newPosts.map((p) => p?.id).filter(Boolean);
      const stats = await fetchPostStats(newIds);
      const newEntries = newPosts
        .map((p) => {
          const adapted = adaptSupabasePostToAppwriteShape(p, stats);
          if (!adapted?.$id) return null;
          return { type: "post", data: adapted, key: `post-${adapted.$id}` };
        })
        .filter(Boolean);
      // Prepend, dedup against any race where the same post is already
      // in the list (e.g. realtime + delta fetch overlap). Capture the
      // merged list so we can mirror it into Redux cachedPosts in the
      // same beat — without that mirror, any cache-driven code path
      // (bootstrap remount, fetchMorePosts seen payload) would see the
      // stale pre-prepend list.
      let mergedListForCache = null;
      setPosts((prev) => {
        const existingIds = new Set(prev.map((e) => e?.data?.$id).filter(Boolean));
        const fresh = newEntries.filter((e) => !existingIds.has(e?.data?.$id));
        const next = fresh.length ? [...fresh, ...prev] : prev;
        mergedListForCache = next;
        return next;
      });
      if (mergedListForCache) {
        dispatch(
          setPost({
            posts: mergedListForCache,
            lastId: cachedLastId ?? null,
            hasMore: cachedHasMore,
            feedUserId: user?.$id || null,
            cachedAt: Date.now(),
          }),
        );
      }
      setLastSeenAt(newPosts[0].created_at);
      setRefreshCounter((prev) => prev + 1);
    } catch (err) {
      // CRITICAL: do NOT fall back to full loadFeed here. The previous
      // behavior was to call loadFeed({ refreshMode: true }) on any
      // additive-refresh failure, but loadFeed re-runs the algorithmic
      // For-You ranker and *replaces* the entire `posts` state with a
      // fresh server-ordered list. After the user had just tapped the
      // "↑ N new posts" pill and seen the new top-of-feed, a transient
      // network blip during pull-to-refresh would yank that fresh view
      // away and resurface the algorithmic ordering — read by the user
      // as "refresh goes back to old stale pattern". Best UX: log the
      // error, leave existing posts intact, let the next refresh /
      // poller tick try again.
      console.log("[home] additive refresh failed (preserving current feed):", err?.message);
      setRefreshCounter((prev) => prev + 1);
    }
  };

  // Apply buffered posts (from the background poller) to the top of the
  // feed. Called by the "↑ N new posts" pill tap, and as the fast path
  // inside onRefresh when the buffer already has data. NO DB call —
  // these rows were hydrated by the poller; we just dedup and prepend.
  //
  // Cache writeback: previously this function only updated local `posts`
  // state. The Redux `cachedPosts` (the persisted For-You cache that
  // hydrates on bootstrap + drives `cachedPosts.slice(...)` pagination)
  // was left untouched, so the new entries were invisible to any path
  // that read from cache. The user's reported bug — "tap pill, see new
  // feed, refresh, goes back to old stale pattern" — was the cache-driven
  // path resurfacing the stale list. Now the cache mirror also gets the
  // prepended entries, keeping local + persisted views in lockstep.
  const applyNewPostsBuffer = useCallback(() => {
    if (!newPostsBuffer.length) return 0;
    let inserted = 0;
    let mergedListForCache = null;
    setPosts((prev) => {
      const existingIds = new Set(prev.map((e) => e?.data?.$id).filter(Boolean));
      const toInsert = newPostsBuffer.filter((e) => !existingIds.has(e?.data?.$id));
      inserted = toInsert.length;
      const next = toInsert.length ? [...toInsert, ...prev] : prev;
      mergedListForCache = next;
      return next;
    });
    // Move lastSeenAt forward to the newest applied entry.
    let newest = lastSeenAt;
    for (const e of newPostsBuffer) {
      const t = e?.data?.$createdAt;
      if (t && (!newest || t > newest)) newest = t;
    }
    if (newest && newest !== lastSeenAt) setLastSeenAt(newest);
    setNewPostsBuffer([]);
    newPostsBufferIdsRef.current = new Set();
    // Mirror the new top-of-feed into Redux cachedPosts so any cache-
    // driven code path (bootstrap on next mount, fetchMorePosts seen
    // payload) sees the same ordering as the live UI.
    if (inserted > 0 && mergedListForCache) {
      dispatch(
        setPost({
          posts: mergedListForCache,
          lastId: cachedLastId ?? null,
          hasMore: cachedHasMore,
          feedUserId: user?.$id || null,
          cachedAt: Date.now(),
        }),
      );
    }
    if (inserted > 0) {
      // Bring the user's eye to the new posts.
      try {
        flatListRef.current?.scrollToOffset?.({ offset: 0, animated: true });
      } catch {
        /* ref not yet ready or unmounted — no-op */
      }
    }
    return inserted;
  }, [newPostsBuffer, lastSeenAt, dispatch, user?.$id, cachedLastId, cachedHasMore]);

  // Background poller — every 60s while foregrounded, fetch new posts
  // since lastSeenAt and stash them in newPostsBuffer (hydrated +
  // adapted, ready to apply). The pill renders count from the buffer
  // length. Realtime upgrade path: replace the setInterval with a
  // postgres_changes subscription on `posts` once we've validated it
  // works for anon clients in production.
  useEffect(() => {
    if (!user?.$id || !lastSeenAt || feedTab !== "for-you") return;
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      if (feedAppStateRef.current !== "active") return;
      try {
        const newPosts = await fetchFeedDelta({
          userId: user.$id,
          sinceTimestamp: lastSeenAt,
          limit: 30,
        });
        if (cancelled || !newPosts.length) return;
        // Skip ids already buffered or already in the live feed.
        const liveIds = new Set();
        // We don't have access to live `posts` array safely from here
        // (closures capture state at effect-mount time), so use the
        // buffer-id ref + treat the newPosts list itself as authoritative.
        const filtered = newPosts.filter(
          (p) => p?.id && !newPostsBufferIdsRef.current.has(p.id) && !liveIds.has(p.id),
        );
        if (!filtered.length) return;
        const ids = filtered.map((p) => p.id);
        const stats = await fetchPostStats(ids);
        const entries = filtered
          .map((p) => {
            const adapted = adaptSupabasePostToAppwriteShape(p, stats);
            if (!adapted?.$id) return null;
            return { type: "post", data: adapted, key: `post-${adapted.$id}` };
          })
          .filter(Boolean);
        if (cancelled || !entries.length) return;
        for (const e of entries) {
          if (e?.data?.$id) newPostsBufferIdsRef.current.add(e.data.$id);
        }
        setNewPostsBuffer((prev) => [...entries, ...prev]);
      } catch (err) {
        // Polling errors are non-fatal — next tick retries.
        console.log("[home] poll error:", err?.message);
      }
    };
    const intervalId = setInterval(poll, 60_000);
    const sub = AppState.addEventListener("change", (next) => {
      const prev = feedAppStateRef.current;
      feedAppStateRef.current = next;
      // On return from background, immediately check for new posts so
      // the pill shows up right away rather than waiting for the next
      // 60s tick.
      if (prev !== "active" && next === "active") poll();
    });
    return () => {
      cancelled = true;
      clearInterval(intervalId);
      sub.remove();
    };
  }, [user?.$id, lastSeenAt, feedTab]);

  // Reset the buffer when the tab changes — it's For-You-only.
  useEffect(() => {
    if (feedTab !== "for-you") {
      setNewPostsBuffer([]);
      newPostsBufferIdsRef.current = new Set();
    }
  }, [feedTab]);

  const updatePostCommentCount = useCallback((postId, newCount) => {
    setPosts((prev) =>
      prev.map((item) => (item.type === "post" && item.data?.$id === postId ? { ...item, data: { ...item.data, postComments: newCount } } : item)),
    );

    setCurrentPost((prev) => (prev?.$id === postId ? { ...prev, postComments: newCount } : prev));
  }, []);

  const updatePostLikeCount = useCallback((postId, newCount, isLikedByCurrentUser) => {
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

    setCurrentPost((prev) =>
      prev?.$id === postId ? { ...prev, postLikes: newCount, ...(typeof isLikedByCurrentUser === "boolean" ? { isLikedByCurrentUser } : {}) } : prev,
    );
  }, []);

  const handlePostDeleted = useCallback(
    (postId) => {
      if (!postId) return;
      setExpandedIndex(null);
      setExpandedMenuIndex(null);
      setPosts((prev) => prev.filter((p) => p.data?.$id !== postId));
      dispatch(removePendingPost({ postId }));
    },
    [dispatch],
  );

  const restoreDeletedPost = useCallback((post) => {
    if (!post?.$id) return;
    const entry = { type: "post", data: post, key: `post-${post.$id}` };
    setPosts((prev) => (prev.some((p) => p.data?.$id === post.$id) ? prev : [entry, ...prev]));
  }, []);

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
    const viewportHeight = event?.nativeEvent?.layoutMeasurement?.height ?? 0;
    const contentHeight = event?.nativeEvent?.contentSize?.height ?? 0;

    if (viewportHeight > 0 && contentHeight > 0) {
      const distanceFromBottom = contentHeight - (y + viewportHeight);
      const prefetchDistance = viewportHeight * FEED_PREFETCH_VIEWPORT_MULTIPLIER;
      if (distanceFromBottom <= prefetchDistance) {
        triggerPaginationPrefetch();
      }
    }

    // Don't toggle the tab bar from scroll while any modal/sheet is open —
    // the user isn't actually scrolling the feed, the keyboard or sheet is
    // shifting layout. (This variable used to be declared somewhere up the
    // file but was dropped during an earlier refactor; references stayed,
    // which crashed Hermes with `Property 'holdTabBarHidden' doesn't exist`.)
    const holdTabBarHidden = isCommentModalVisible || isLikesModalVisible || showImageViewer || safetySheetVisible;

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

  const onViewableItemsChanged = useRef(({ viewableItems }) => {
    viewableItems.forEach((entry) => markSeenPost(entry?.item));

    // Buffer post IDs that just entered the viewport, then flush in
    // batches via trackPostViews. This populates server-side post_views
    // so feed_for_you can dedupe on the next refresh ("always fresh"
    // For You UX). Best-effort — failures are swallowed in the helper,
    // and only Supabase-shape UUIDs are tracked (Appwrite hex IDs are
    // skipped at the helper level).
    //
    // We bias toward IDs since Supabase posts already carry .id (UUID);
    // for old/legacy items that only have $id (Appwrite hex), the helper
    // will filter those out. Net effect: tracking only fires for the
    // posts that feed_for_you actually returns.
    const newIds = viewableItems
      .map((v) => v?.item?.id || v?.item?.$id)
      .filter(Boolean);
    if (newIds.length > 0) {
      newIds.forEach((id) => pendingViewIdsRef.current.add(id));
      // Debounce — flush 1.5s after the last viewport change. Avoids
      // spamming the RPC during a fast scroll.
      if (flushViewsTimerRef.current) clearTimeout(flushViewsTimerRef.current);
      flushViewsTimerRef.current = setTimeout(() => {
        const idsToFlush = Array.from(pendingViewIdsRef.current);
        pendingViewIdsRef.current.clear();
        if (idsToFlush.length > 0 && (chatUserId || user?.$id)) {
          void trackPostViews({
            userId: chatUserId || user?.$id,
            postIds: idsToFlush,
          });
        }
      }, 1500);
    }

    const visibleKeys = viewableItems.map((v) => v.item?.key).filter(Boolean);
    lastViewableKeysRef.current = visibleKeys;

    // Phase E.3 — Low-tier devices skip feed autoplay entirely. The
    // user can still tap a video to play it on the dedicated player
    // screen; we just don't burn battery + GPU autoplaying carousels
    // of muted previews on phones that strain to keep up. Mid + high
    // tiers fall through to the existing "topmost visible video plays"
    // logic below.
    if (isLowTier()) {
      Object.values(videoRefs.current).forEach((ref) => ref?.pauseVideo?.());
      currentlyPlayingKey.current = null;
      pendingPlaybackKey.current = null;
      return;
    }

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

  // Stable handlers for PostCard so memo() bail-out actually works during scroll.
  // Inline arrows in renderItem create new function refs every Home re-render,
  // forcing every visible PostCard to re-render even when its data is unchanged.
  const handlePostLikesPress = useCallback((item) => {
    setCurrentPost(item);
    setLikesModalVisible(true);
  }, []);

  const handlePostCommentPress = useCallback((item) => {
    setCurrentPost(item);
    notificationCommentOpenKeyRef.current = null;
    setCommentModalFocus({ focusCommentId: null, focusReplyId: null });
    setCommentModalResumeToken(null);
    setCommentModalVisible(true);
  }, []);

  const handlePostSharePress = useCallback(async (item) => {
    try {
      await Share.open({
        message: "Check out this post!",
        url: `${secrets.WEBSITE}/home/${item?.$id}`,
        title: item?.posts,
        type: "url",
      });
    } catch {
      // user dismissed share sheet
    }
  }, []);

  const handlePostOpenImageViewer = useCallback(({ images: nextImages, initialIndex, item: selectedPost }) => {
    setImages(nextImages);
    setImageViewerInitialIndex(initialIndex);
    setCurrentPost(selectedPost);
    setShowImageViewer(true);
  }, []);

  const handleToggleExpanded = useCallback((idx) => {
    setExpandedIndex((prev) => (prev === idx ? null : idx));
  }, []);

  const handleToggleExpandedMenu = useCallback((idx) => {
    setExpandedMenuIndex((prev) => (prev === idx ? null : idx));
  }, []);

  const handlePostSafetySheet = useCallback(
    (item) => {
      openSafetySheet({ type: "post", data: item });
    },
    [openSafetySheet],
  );

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
                source={{ uri: data?.avatar, priority: FastImage.priority.normal }}
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

      // type === "clip" branch removed — clips feature retired May 2026.
      // Clip-typed feed items are filtered out upstream in lib/posts.js
      // so this branch is unreachable; kept comment for archaeology.

      if (type === "ad") {
        return <PostNativeAd />;
      }

      // "post" or default
      if (data.postResourceId) {
        // Clip-resource posts (data.postResourceType === "clip") retired
        // May 2026. They're filtered upstream in lib/posts.js so we
        // shouldn't see them here, but keep the type-switch fall-through
        // simple by treating them as plain text posts if they slip past.
        const isClipPost = data.postResourceType === "clip" || Boolean(data.clip);
        if (isClipPost) {
          return <PostCard item={data} onOpenSafetySheet={() => openSafetySheet({ type: "post", data })} />;
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
          handleLikesPress={handlePostLikesPress}
          handleCommentPress={handlePostCommentPress}
          handleSharePress={handlePostSharePress}
          onLikeChange={updatePostLikeCount}
          onOpenImageViewer={handlePostOpenImageViewer}
          onPostDeleteRequest={requestDeletePost}
          isExpanded={expandedIndex === index}
          onToggleExpand={handleToggleExpanded}
          isExpandedMenu={expandedMenuIndex === index}
          onToggleExpandMenu={handleToggleExpandedMenu}
          onOpenSafetySheet={handlePostSafetySheet}
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
          <MainScreensHeader title="Selebox" />
        </View>

        {/* Facebook-pattern "↑ N new posts" pill. Absolute-positioned over
            the FlashList so it doesn't reflow on scroll. Only renders for
            the For You tab; visibility tied to the buffer length. Tap →
            applies buffered posts to the top, no DB call. */}
        {feedTab === "for-you" && newPostsBuffer.length > 0 ? (
          <View
            pointerEvents="box-none"
            style={{
              position: "absolute",
              top: 64,
              left: 0,
              right: 0,
              alignItems: "center",
              zIndex: 50,
            }}
          >
            <TouchableOpacity
              onPress={applyNewPostsBuffer}
              activeOpacity={0.85}
              style={{
                paddingHorizontal: 18,
                paddingVertical: 9,
                borderRadius: 999,
                backgroundColor: theme.primary,
                shadowColor: "#000",
                shadowOpacity: 0.18,
                shadowRadius: 8,
                shadowOffset: { width: 0, height: 4 },
                elevation: 4,
              }}
            >
              <Text style={{ color: theme.primaryContrast || "#fff", fontWeight: "600", fontSize: 13 }}>
                {newPostsBuffer.length === 1
                  ? "↑ 1 new post"
                  : `↑ ${newPostsBuffer.length} new posts`}
              </Text>
            </TouchableOpacity>
          </View>
        ) : null}

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
          onEndReachedThreshold={flashListConfig.onEndReachedThreshold}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          // Phase E.5 — `removeClippedSubviews` and `drawDistance` come
          // from `getFlashListConfig`, which returns tier-tuned values:
          // mid/high keep flicker-free behavior; low-tier opts into the
          // small-window mode to reduce mounted-row count + memory.
          removeClippedSubviews={flashListConfig.removeClippedSubviews}
          estimatedItemSize={FEED_ESTIMATED_ITEM_SIZE}
          drawDistance={flashListConfig.drawDistance}
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

              {/* Feed tabs: For You / Following / Discover — minimal, premium spacing */}
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  paddingHorizontal: 4,
                  paddingTop: 10,
                  paddingBottom: 2,
                }}
              >
                {[
                  { key: "for-you", label: "For You" },
                  { key: "following", label: "Following" },
                  { key: "discover", label: "Discover" },
                ].map((tab) => {
                  const isActive = feedTab === tab.key;
                  return (
                    <TouchableOpacity
                      key={tab.key}
                      onPress={() => handleSwitchTab(tab.key)}
                      activeOpacity={0.85}
                      style={{
                        paddingVertical: 6,
                        paddingHorizontal: 14,
                        borderRadius: 999,
                        marginRight: 4,
                        backgroundColor: isActive ? theme.primary : "transparent",
                      }}
                    >
                      <Text
                        style={{
                          fontSize: 13,
                          fontWeight: isActive ? "700" : "500",
                          letterSpacing: 0.1,
                          color: isActive ? (theme.primaryContrast ?? "#ffffff") : (theme.textMuted ?? theme.text),
                        }}
                      >
                        {tab.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
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
            ) : feedTab === "following" ? (
              <View className="items-center justify-center px-6 py-14">
                <MaterialIcons name="people-outline" size={64} color={theme.textSubtle} />
                <Text className="mt-4 text-base font-semibold" style={{ color: theme.text }}>
                  {followingCount === 0 ? "Follow people to see their posts here" : "No new posts from people you follow"}
                </Text>
                <Text className="mt-2 text-center text-sm" style={{ color: theme.textSoft }}>
                  {followingCount === 0 ? "Discover creators you'd love to follow." : "Check back later — or browse Discover for fresh content."}
                </Text>
                <TouchableOpacity
                  onPress={() => handleSwitchTab("discover")}
                  activeOpacity={0.85}
                  style={{
                    marginTop: 16,
                    paddingVertical: 10,
                    paddingHorizontal: 18,
                    borderRadius: 999,
                    backgroundColor: theme.primary,
                  }}
                >
                  <Text style={{ fontSize: 13, fontWeight: "700", color: theme.primaryContrast ?? "#ffffff" }}>Browse Discover</Text>
                </TouchableOpacity>
              </View>
            ) : feedTab === "discover" ? (
              <View className="items-center justify-center px-6 py-14">
                <MaterialIcons name="explore-off" size={64} color={theme.textSubtle} />
                <Text className="mt-4 text-base font-semibold" style={{ color: theme.text }}>
                  No new posts to discover
                </Text>
                <Text className="mt-2 text-center text-sm" style={{ color: theme.textSoft }}>
                  Pull down to refresh.
                </Text>
              </View>
            ) : (
              <View className="items-center justify-center px-6 py-14">
                <MaterialIcons name="search-off" size={64} color={theme.textSubtle} />
                <Text className="mt-4 text-base font-semibold" style={{ color: theme.text }}>
                  No posts yet
                </Text>
                <Text className="mt-2 text-center text-sm" style={{ color: theme.textSoft }}>
                  Pull down to refresh.
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

          {/* Snooze for 30 days — softer than block. Web has had this for
              a while; we're adding it on mobile for cross-platform parity.
              Only writes to Supabase user_snoozes (no Appwrite equivalent
              table); the in-memory blockedUserIds set picks it up on next
              feed refresh via loadUserContentFilters. */}
          <TouchableOpacity
            className="mt-2 rounded-xl px-4 py-3"
            style={{ backgroundColor: theme.surfaceMuted }}
            onPress={handleSnoozeUser}
            disabled={snoozingUser || !pendingSafetyTarget?.ownerId}
          >
            <View className="flex flex-row items-center justify-between">
              <View className="flex flex-row items-center">
                <MaterialIcons name="schedule" size={22} color={theme.icon} style={{ marginRight: 12 }} />
                <View>
                  <Text className="text-base font-semibold" style={{ color: theme.text }}>
                    Snooze for 30 days
                  </Text>
                  <Text className="mt-1 text-xs" style={{ color: theme.textSoft }}>
                    Take a break from this person — auto-undoes after 30 days
                  </Text>
                </View>
              </View>
              {snoozingUser ? <ActivityIndicator size="small" color={theme.primary} /> : null}
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
