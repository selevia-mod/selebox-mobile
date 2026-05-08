import { Audio } from "expo-av";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useVideoPlayer, VideoView } from "expo-video";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Animated, Dimensions, PanResponder, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import FastImage from "react-native-fast-image";
import { useDispatch, useSelector } from "react-redux";

import {
  CustomAlertModal,
  StoryActionBar,
  StoryCubeFaces,
  StoryHeader,
  StoryReplyComposer,
  StoryRepostSheet,
  StoryViewersSheet,
  StyledSafeAreaView,
} from "../../components";
import { useGlobalContext } from "../../context/global-provider";
import storyEvents from "../../lib/story-events";
import { StoryService } from "../../lib/story-service";
import { MOMENTS_VIEWER_SWR } from "../../lib/feature-flags";
import { useModalMessage } from "../../hooks/useModalMessage";
import { isViewerStoryCacheFresh, selectViewerStoryCacheEntry, setViewerStories } from "../../store/reducers/story";

// --------------------------------------------------
// Constants
// --------------------------------------------------
const { width: screenWidth, height: screenHeight } = Dimensions.get("window");
const MAX_VIDEO_DURATION = 30000;
const LONG_PRESS_THRESHOLD = 300;
const READY_VIDEO_STATUSES = new Set(["ready", "published"]);

// --------------------------------------------------
// Pure helpers (module scope)
//
// Hoisted out of the component so they can run from a useState
// initializer (which fires before any of the in-component callbacks
// are defined). The viewer's SWR pass calls these synchronously to
// build userGroups directly off the Redux cache, painting the cube
// instantly with no spinner / no flash.
// --------------------------------------------------

const isActiveStory = (story) => {
  if (!story) return false;
  const now = Date.now();
  if (story.expiresAt) return new Date(story.expiresAt).getTime() > now;
  return now - new Date(story.createdAt).getTime() <= 24 * 60 * 60 * 1000;
};

const sanitizeGroupedStories = (grouped) => {
  if (!grouped) return {};
  const result = {};
  Object.entries(grouped).forEach(([userId, storiesForUser]) => {
    const cleaned = (storiesForUser || []).filter((s) => {
      if (!s || !s.user?.id) return false;
      if (!isActiveStory(s)) return false;
      if (s.status === "deleted") return false;
      // Non-ready videos are intentionally KEPT in the stack — see the
      // filter-fix history above. The viewer renders a "processing"
      // overlay for owned non-ready videos and uses an image-duration
      // fallback so auto-advance still works.
      return true;
    });
    if (cleaned.length) {
      result[userId] = cleaned;
    }
  });
  return result;
};

// Build the ordered userGroups stack ([Own, …Following, …Discover])
// from a sanitized groupedObj. `viewerScopeKeys` is the set of userIds
// that came from fetchViewerStories (own + followings); anyone not in
// that set is considered Discover. Pure — no closures, no refs.
const buildUserGroupsFromGroupedObj = (groupedObj, viewerScopeKeys, viewerUserId) => {
  const groups = Object.entries(groupedObj || {})
    .map(([groupKey, storiesForUser]) => {
      const stories = Array.isArray(storiesForUser) ? [...storiesForUser] : [];
      if (!stories.length) return null;
      stories.sort((a, b) => {
        const aTs = new Date(a.createdAt).getTime();
        const bTs = new Date(b.createdAt).getTime();
        if (aTs !== bTs) return aTs - bTs; // older first
        const aId = String(a.id || "");
        const bId = String(b.id || "");
        return aId < bId ? -1 : aId > bId ? 1 : 0;
      });
      const first = stories[0];
      const userId = first?.user?.id || groupKey;
      return {
        userId,
        name: first?.user?.name || "Unknown User",
        avatar: first?.user?.avatar ?? null,
        stories,
      };
    })
    .filter(Boolean);

  const sortByNewest = (a, b) => {
    const lastA = a.stories[a.stories.length - 1];
    const lastB = b.stories[b.stories.length - 1];
    return new Date(lastB.createdAt) - new Date(lastA.createdAt);
  };

  const ownGroup = groups.find((u) => u.userId === viewerUserId) || null;
  const followingGroups = groups
    .filter((u) => u.userId !== viewerUserId && viewerScopeKeys.has(u.userId))
    .sort(sortByNewest);
  const discoverGroups = groups
    .filter((u) => u.userId !== viewerUserId && !viewerScopeKeys.has(u.userId))
    .sort(sortByNewest);

  return {
    userGroups: [
      ...(ownGroup ? [ownGroup] : []),
      ...followingGroups,
      ...discoverGroups,
    ],
    bucketByUserId: {
      ...(ownGroup ? { [ownGroup.userId]: "own" } : {}),
      ...Object.fromEntries(followingGroups.map((g) => [g.userId, "following"])),
      ...Object.fromEntries(discoverGroups.map((g) => [g.userId, "discover"])),
    },
  };
};

// Synchronous: pull a fresh userGroups + start index out of the Redux
// cache for instant first-paint. Returns null when the cache is empty
// or stale, in which case the caller falls back to the network-first
// path (and shows the spinner placeholder).
const seedFromCache = ({
  cacheEntry,
  viewerUserId,
  uploaderId,
  clickedOwnStory,
}) => {
  if (!cacheEntry || !isViewerStoryCacheFresh(cacheEntry) || !cacheEntry.grouped) {
    return null;
  }
  const cleaned = sanitizeGroupedStories(cacheEntry.grouped) || {};
  const viewerScopeKeys = new Set(Object.keys(cleaned));
  const { userGroups, bucketByUserId } = buildUserGroupsFromGroupedObj(
    cleaned,
    viewerScopeKeys,
    viewerUserId,
  );
  if (!userGroups.length) return null;

  let startUserIdx = 0;
  if (clickedOwnStory) {
    const ownIdx = userGroups.findIndex((u) => u.userId === viewerUserId);
    if (ownIdx >= 0) startUserIdx = ownIdx;
  } else if (uploaderId) {
    const idx = userGroups.findIndex((u) => u.userId === uploaderId);
    if (idx >= 0) startUserIdx = idx;
  }

  return { userGroups, bucketByUserId, startUserIdx };
};

// --------------------------------------------------
// Swipe-up hint pill — shown above the StoryBottomBar when the active
// Moment has a link attached. Tap-target is a fallback for users who
// don't realize they can swipe up; the gesture in the panResponder is
// the primary interaction. The chevron pulse animation is a visual cue
// that something's interactive without being noisy.
// --------------------------------------------------
const SwipeUpHint = ({ link, onTap }) => {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 900, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  const translateY = pulse.interpolate({ inputRange: [0, 1], outputRange: [0, -4] });
  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] });

  // Label leads with "Slide up to ..." so the gesture is explicit —
  // earlier copy ("Read this book") didn't communicate that swiping
  // was the trigger, only what the destination was. Per-resource
  // verbs keep the destination obvious. Mirrors the Instagram-style
  // swipe-up CTA convention.
  const label =
    link.resourceType === "book"
      ? "Slide up to read this book"
      : link.resourceType === "video"
      ? "Slide up to watch this video"
      : "Slide up to open link";

  return (
    <TouchableOpacity activeOpacity={0.85} onPress={onTap} style={hintStyles.wrap}>
      <Animated.View style={[hintStyles.chevron, { transform: [{ translateY }], opacity }]}>
        <Feather name="chevron-up" size={22} color="#fff" />
      </Animated.View>
      <Text style={hintStyles.label}>{label}</Text>
    </TouchableOpacity>
  );
};

const hintStyles = StyleSheet.create({
  wrap: {
    alignSelf: "center",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginBottom: 8,
  },
  chevron: { marginBottom: 4 },
  label: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0.3,
    // Heavier shadow so the text reads cleanly on bright media
    // without needing a backing pill that would clutter the
    // composer-and-emojis bar below.
    textShadowColor: "rgba(0, 0, 0, 0.85)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 6,
  },
});

// --------------------------------------------------
// Component
// --------------------------------------------------
const StoryViewer = () => {
  const { globalSettings } = useGlobalContext();
  let imageDurationMs = (globalSettings["STORY_IMAGE_DURATION"] || 10) * 1000 || 10000;

  const dispatch = useDispatch();

  // Params
  const { uploaderId, startAtOwnStories, viewerId } = useLocalSearchParams();
  const viewerUserId = viewerId ?? null;

  const clickedOwnStory = startAtOwnStories === "1" && uploaderId && viewerUserId && uploaderId === viewerUserId;

  const cacheKey = viewerUserId || "anonymous";
  const cacheEntry = useSelector((state) => selectViewerStoryCacheEntry(state, cacheKey));

  const { message, messageOpen, showMessage, closeMessage } = useModalMessage();

  // --------------------------------------------------
  // State
  // --------------------------------------------------
  // SWR seed — when MOMENTS_VIEWER_SWR is on and the Redux storyCache
  // has a fresh entry for this viewer, we hydrate users + the start
  // index synchronously here. The cube renders the cached stack on the
  // very first paint, no spinner, and loadAllStories below just runs
  // a background refresh. When the cache is missing/stale we fall
  // through to the legacy network-first path (loading: true → spinner
  // → setUsers when fetch returns).
  const swrSeed = MOMENTS_VIEWER_SWR
    ? seedFromCache({
        cacheEntry,
        viewerUserId: viewerUserId,
        uploaderId,
        clickedOwnStory,
      })
    : null;

  const [users, setUsers] = useState(() => swrSeed?.userGroups || []);
  const [currentUserIndex, setCurrentUserIndex] = useState(() => swrSeed?.startUserIdx || 0);
  const [currentStoryIndex, setCurrentStoryIndex] = useState(0);
  const [loading, setLoading] = useState(() => !swrSeed);
  const [storyMusic, setStoryMusic] = useState(null);
  const musicRef = useRef(null);
  const musicLoadIdRef = useRef(0);

  // NEW: Prevent music creation when viewer is closing
  const closingRef = useRef(false);

  const [storyStats, setStoryStats] = useState({
    totalLikes: 0,
    totalViews: 0,
  });
  const [hasLiked, setHasLiked] = useState(false);
  const [hasViewed, setHasViewed] = useState(false);

  // ────────────────────────────────────────────────────────────────
  // Premium-viewer state (May 2026 revamp)
  //
  // currentReaction:    'heart' | 'haha' | 'sad' | 'cry' | 'angry' | null
  // reactionCount:      total reactions across all emojis on this Moment
  // reactionPickerOpen: 5-emoji popup floating above the action bar
  // viewersSheetOpen:   owner-only sheet listing who viewed
  // repostSheetOpen:    Share-to-DM / Repost menu
  // commentsOpen:       PostCommentModal reused for Moment comments
  // muted:              local audio mute toggle. Persists per-session
  //                     globally so toggling once silences subsequent
  //                     Moments until the user un-mutes.
  // ────────────────────────────────────────────────────────────────
  const [currentReaction, setCurrentReaction] = useState(null);
  const [reactionCount, setReactionCount] = useState(0);
  const [viewersSheetOpen, setViewersSheetOpen] = useState(false);
  const [repostSheetOpen, setRepostSheetOpen] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const [muted, setMuted] = useState(false);

  // --------------------------------------------------
  // Refs
  // --------------------------------------------------
  const usersRef = useRef(swrSeed?.userGroups || []);
  const currentUserIndexRef = useRef(swrSeed?.startUserIdx || 0);
  // Mirrors currentStoryIndex so loadAllStories' SWR shape-mismatch
  // branch can preserve the user's playback position across network
  // refreshes (without depending on stale closure state).
  const currentStoryIndexRef = useRef(0);
  // Maps userId → "own" | "following" | "discover", populated by
  // loadAllStories once the buckets are computed. Lets handleNextStory
  // emit a log line when the cube transitions from one bucket to the
  // next (e.g. "advancing from following to discover"). Seeded from
  // the SWR cache pass so the very first cross-bucket transition has
  // the right labels even before the network refresh lands.
  const userBucketsRef = useRef(swrSeed?.bucketByUserId || {});
  const pausedRef = useRef(false);
  const lastStoryIndexRef = useRef({});
  const videoLoadedRef = useRef(false);
  const cacheEntryRef = useRef(cacheEntry);
  // Mirrors handleFollowLink so the panResponder (created in a useRef
  // and frozen at first render) can call the latest version on swipe-up.
  // Same pattern used by usersRef / currentUserIndexRef above. Kept as a
  // ref (not deps array) because PanResponder.create captures its
  // closure once and won't see fresh callbacks otherwise.
  const followLinkRef = useRef(() => {});
  // Mirrors currentStory.link so the swipe-up handler can decide
  // whether the gesture should fire follow-link OR fall through to the
  // existing close-on-vertical-swipe behavior.
  const currentLinkRef = useRef(null);

  const [paused, setPaused] = useState(false);
  const progress = useRef(new Animated.Value(0)).current;
  const progressValueRef = useRef(0);
  const currentDurationRef = useRef(imageDurationMs);
  const progressAnimRef = useRef(null);

  const cubeAnim = useRef(new Animated.Value(0)).current;
  const [availabilityChecked, setAvailabilityChecked] = useState(false);

  const longPressTimeout = useRef(null);
  const gestureRef = useRef({
    startX: 0,
    startY: 0,
    isLongPress: false,
    isSwipe: false,
  });

  // Helper is hoisted (function) so it can be used before declaration
  function isVideoReady(story) {
    if (!story || story.type !== "video") return true;
    return READY_VIDEO_STATUSES.has(story.status);
  }

  // --------------------------------------------------
  // Memos
  // --------------------------------------------------
  const currentUser = useMemo(() => (users.length ? users[currentUserIndex] : null), [users, currentUserIndex]);

  const currentStory = useMemo(() => {
    if (!currentUser) return null;
    return currentUser.stories[currentStoryIndex] ?? null;
  }, [currentUser, currentStoryIndex]);

  const prevUser = useMemo(() => (currentUserIndex > 0 ? users[currentUserIndex - 1] : null), [users, currentUserIndex]);
  const nextUser = useMemo(() => (currentUserIndex < users.length - 1 ? users[currentUserIndex + 1] : null), [users, currentUserIndex]);

  // --------------------------------------------------
  // Track last opened story index per user
  // --------------------------------------------------
  useEffect(() => {
    if (currentUser?.userId) {
      lastStoryIndexRef.current[currentUser.userId] = currentStoryIndex;
    }
  }, [currentUser?.userId, currentStoryIndex]);

  useEffect(() => {
    usersRef.current = users;
  }, [users]);

  useEffect(() => {
    currentUserIndexRef.current = currentUserIndex;
  }, [currentUserIndex]);

  useEffect(() => {
    currentStoryIndexRef.current = currentStoryIndex;
  }, [currentStoryIndex]);

  // Keep currentLinkRef in sync with the active story's link so the
  // panResponder's swipe-up handler can read the latest value without
  // re-creating the responder (PanResponder.create is captured once on
  // mount).
  useEffect(() => {
    currentLinkRef.current = currentStory?.link || null;
  }, [currentStory?.id, currentStory?.link]);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    cacheEntryRef.current = cacheEntry;
  }, [cacheEntry]);

  // --------------------------------------------------
  // Audio helpers
  // --------------------------------------------------
  const stopAndUnloadSound = useCallback(async (sound) => {
    if (!sound) return;

    try {
      await sound.stopAsync?.();
    } catch {}

    try {
      await sound.unloadAsync?.();
    } catch {}
  }, []);

  const stopAndUnloadCurrentMusic = useCallback(async () => {
    const activeSound = musicRef.current;
    musicRef.current = null;

    await stopAndUnloadSound(activeSound);
  }, [stopAndUnloadSound]);

  // --------------------------------------------------
  // SAFE CLOSE — Blocks music creation & unloads audio
  // --------------------------------------------------
  const safeClose = useCallback(() => {
    closingRef.current = true;
    musicLoadIdRef.current += 1;

    void stopAndUnloadCurrentMusic();

    router.back();
  }, [stopAndUnloadCurrentMusic]);

  // --------------------------------------------------
  // Cleanup on unmount
  // --------------------------------------------------
  useEffect(() => {
    return () => {
      musicLoadIdRef.current += 1;
      void stopAndUnloadCurrentMusic();
    };
  }, [stopAndUnloadCurrentMusic]);

  // Cleanup on blur (Expo Router keeps components mounted)
  useFocusEffect(
    useCallback(() => {
      return () => {
        musicLoadIdRef.current += 1;
        void stopAndUnloadCurrentMusic();
      };
    }, [stopAndUnloadCurrentMusic]),
  );

  // --------------------------------------------------
  // Video setup
  // --------------------------------------------------
  const videoPlayer = useVideoPlayer(currentStory?.type === "video" && isVideoReady(currentStory) ? currentStory.mediaUrl : null, (player) => {
    videoLoadedRef.current = false;

    if (currentStory?.type === "video" && isVideoReady(currentStory)) {
      player.loop = false;
      player.controls = false;

      player.addListener("statusChange", (status) => {
        if (status.status === "readyToPlay" && !videoLoadedRef.current) {
          if (!pausedRef.current && !gestureRef.current.isLongPress) {
            videoLoadedRef.current = true;
            currentDurationRef.current = player.duration;
            player.play();
            startProgressAnimation();
          }
        }
      });
    }
  });

  useEffect(() => {
    if (!videoPlayer) return;

    if (paused) {
      videoPlayer.pause?.();
    } else {
      videoPlayer.play?.();
    }

    if (videoLoadedRef.current && !pausedRef.current && !gestureRef.current.isLongPress) {
      try {
        videoPlayer.replay();
        videoPlayer.play();
      } catch (e) {}
    }
  }, [paused, videoPlayer, currentStory?.id]);

  // --------------------------------------------------
  // Helpers
  // --------------------------------------------------
  // isActiveStory + sanitizeGroupedStories live at module scope (top
  // of file) so they're callable from useState initializers for the
  // SWR seed pass. The component-local helpers used to live here.
  const getSavedIndex = (user) => (user ? (lastStoryIndexRef.current[user.userId] ?? 0) : 0);

  // --------------------------------------------------
  // Like toggle (legacy — kept while older surfaces still consume it)
  // --------------------------------------------------
  const toggleLike = async () => {
    if (!currentStory || !viewerUserId) return;

    if (hasLiked) {
      const likedDoc = await StoryService.checkIfUserLiked(currentStory.id, viewerUserId);
      if (likedDoc) {
        setHasLiked(false);
        await StoryService.unlikeStory(likedDoc.$id);
        setStoryStats((prev) => ({ ...prev, totalLikes: prev.totalLikes - 1 }));
      }
    } else {
      setHasLiked(true);
      await StoryService.likeStory(currentStory.id, viewerUserId);
      setStoryStats((prev) => ({ ...prev, totalLikes: prev.totalLikes + 1 }));
    }
  };

  // --------------------------------------------------
  // Reaction handlers — optimistic + DB-backed
  // --------------------------------------------------
  // pickReaction handles three transitions:
  //   1. No reaction → set new one        (count + 1)
  //   2. Same reaction tapped → remove it (count - 1)
  //   3. Different reaction → swap        (count unchanged)
  // The DB upsert pattern + composite PK guarantees a user only ever
  // has one reaction per story, so we don't have to manage that
  // invariant on the client. With the new FB-style action bar all
  // 5 emojis are tap-targets directly — no separate picker UI.
  const pickReaction = async (key) => {
    if (!currentStory || !viewerUserId) return;

    const prev = currentReaction;
    if (prev === key) {
      // Toggle off — remove
      setCurrentReaction(null);
      setReactionCount((c) => Math.max(0, c - 1));
      try {
        await StoryService.removeStoryReaction(currentStory.id, viewerUserId);
      } catch (e) {
        console.log("[reactions] remove failed, reverting:", e?.message);
        setCurrentReaction(prev);
        setReactionCount((c) => c + 1);
      }
      return;
    }

    setCurrentReaction(key);
    if (!prev) setReactionCount((c) => c + 1);
    try {
      await StoryService.setStoryReaction(currentStory.id, viewerUserId, key);
    } catch (e) {
      console.log("[reactions] set failed, reverting:", e?.message);
      setCurrentReaction(prev);
      if (!prev) setReactionCount((c) => Math.max(0, c - 1));
    }
  };

  // --------------------------------------------------
  // Mute toggle — applies to the active Moment's music sound. We
  // also store the choice in pausedRef so subsequent Moments
  // initialise muted as well (sticky preference per session).
  // --------------------------------------------------
  const handleMuteToggle = async () => {
    const next = !muted;
    setMuted(next);
    try {
      const sound = musicRef.current;
      if (sound) {
        await sound.setIsMutedAsync?.(next);
      }
    } catch (e) {
      console.log("[mute] toggle failed:", e?.message);
    }
  };

  // --------------------------------------------------
  // Repost handlers
  // --------------------------------------------------
  const handleRepost = async () => {
    if (!currentStory || !viewerUserId) return;
    try {
      await StoryService.repostStory(currentStory.id, viewerUserId);
      setRepostSheetOpen(false);
      // Notify other parts of the app (story tray, profile) that the
      // user just published a repost so feeds can refresh.
      storyEvents.emit?.("story-shared", { type: "repost", originalId: currentStory.id });
    } catch (e) {
      console.log("[repost] failed:", e?.message);
    }
  };

  const handleShareToDM = () => {
    // Route to the new-chat flow with a payload describing the Moment
    // to share. The chat composer reads it and seeds the message
    // with a Moment preview card. (Wired in a follow-up commit; for
    // now the flow lands the user on the chat picker.)
    if (!currentStory) return;
    router.push({
      pathname: "/(message)/new-chat",
      params: {
        shareKind: "story",
        shareStoryId: currentStory.id,
      },
    });
  };

  // --------------------------------------------------
  // Load all stories
  // --------------------------------------------------
  const loadAllStories = useCallback(
    async ({ forceNetwork = false } = {}) => {
      if (!viewerUserId) {
        setUsers([]);
        setLoading(false);
        return;
      }

      try {
        setLoading(true);

        // Always try network first to avoid stale/deleted stories
        let groupedObj = null;
        try {
          const grouped = await StoryService.fetchViewerStories({
            viewerId: viewerUserId,
            limit: 200,
            offset: 0,
          });
          groupedObj = sanitizeGroupedStories(grouped) || {};
          // Dispatch the viewer-scope (own + following only) to Redux
          // BEFORE we touch groupedObj further, and pass a SHALLOW
          // CLONE so the local mutations below (discover merge, per-
          // creator fallback) don't bleed into Redux state. Without
          // this clone, the discover merge below mutated the same
          // object reference Redux now held → next focus,
          // `seedFromCache` would read the merged shape from cache,
          // build viewerScopeKeys = `Object.keys(merged)` (which
          // contains discover users), and misclassify those discover
          // users as "following" — landing the cube on the wrong
          // bucket and the wrong moment when users tapped a tile.
          dispatch(
            setViewerStories({
              viewerId: cacheKey,
              grouped: { ...groupedObj },
            }),
          );
        } catch (networkErr) {
          console.log("Network fetch failed, falling back to cache", networkErr);
          if (!forceNetwork && cacheEntryRef.current && isViewerStoryCacheFresh(cacheEntryRef.current)) {
            // Clone here too — local merges below shouldn't mutate
            // the cache entry through `cleaned`'s nested references.
            groupedObj = { ...(sanitizeGroupedStories(cacheEntryRef.current.grouped) || {}) };
          }
        }

        if (!groupedObj) groupedObj = {};

        // Snapshot the viewer-scope keys (own + followings) BEFORE we
        // merge discover users, so we can later partition userGroups
        // into [Own, …Following, …Discover] sections — that's the
        // FB-style strip order users expect when navigating between
        // creators in the viewer.
        const viewerScopeKeys = new Set(Object.keys(groupedObj));

        // Mirror the home StoryBar: viewer + followings + discover.
        //
        // fetchViewerStories returns viewer + followings only. Without
        // the merge below, two flows broke:
        //   1. Tap a discover creator's tile → groupedObj wouldn't
        //      contain them, the reorder would be a no-op, and the
        //      viewer would land on whichever following happened to be
        //      first (typically a 1-moment creator → "plays one then
        //      closes").
        //   2. Tap your OWN story when you don't follow anyone with an
        //      active moment → groupedObj contains only you, usersLen
        //      = 1, and after your stack auto-advance hits the close
        //      branch immediately. The handleNextStory log line
        //      `usersLen: 1, storiesLen: 1` is exactly that case.
        //
        // The fix: also fetch the public/discover feed (same call the
        // StoryBar makes) and merge every creator we don't already
        // have. The reorder-tapped-creator-to-index-0 logic below
        // still runs, so the tapped tile lands you on that creator
        // first and then auto-advances through everyone else, just
        // like FB.
        try {
          // Bumped from 50 → 200 to match the viewer-scope fetch's
          // limit. With 50 we were occasionally truncating the list
          // before the tapped creator's stories appeared, which then
          // forced the per-creator fallback below to fire — fine for
          // correctness, but wasteful. 200 covers all realistic
          // strip sizes (FB shows ~15-20).
          const discoverList = await StoryService.fetchStories({ limit: 200, offset: 0 });
          let newDiscoverUsers = 0;
          if (Array.isArray(discoverList) && discoverList.length) {
            // Group the flat list by uploader, sanitize per-user the
            // same way the viewer-scope branch does so consumers see
            // a uniform shape.
            const discoverGrouped = {};
            for (const s of discoverList) {
              const uid = s?.user?.id;
              if (!uid) continue;
              if (!discoverGrouped[uid]) discoverGrouped[uid] = [];
              discoverGrouped[uid].push(s);
            }
            const cleanedDiscover = sanitizeGroupedStories(discoverGrouped) || {};
            // Merge — only add creators we don't already have so we
            // don't clobber the (likely fresher) viewer-scope payload.
            for (const [uid, stories] of Object.entries(cleanedDiscover)) {
              if (!groupedObj[uid] && stories?.length) {
                groupedObj[uid] = stories;
                newDiscoverUsers += 1;
              }
            }
          }
          // Diagnostic — when "tap own → close after own" is reported,
          // this line tells us whether discover came back empty
          // (server / status filter dropping rows), or returned data
          // but every creator was already in the viewer-scope payload.
          console.log("[story-viewer] discover fetched", {
            rawCount: discoverList?.length || 0,
            newDiscoverUsers,
            viewerScopeUsers: viewerScopeKeys.size,
          });
        } catch (discoverErr) {
          console.log("[story-viewer] discover merge failed:", discoverErr?.message);
        }

        // Last-chance per-creator fallback. If the tapped uploader
        // isn't in viewer-scope OR the discover merge (e.g. their
        // stories are paginated past the 50-item discover slice we
        // just fetched), pull just their stories directly so we
        // never end up with a stack that doesn't include the
        // creator the user actually tapped.
        if (uploaderId && !groupedObj[uploaderId]) {
          try {
            const creatorStories = await StoryService.fetchUserStories(uploaderId);
            if (creatorStories?.length) {
              const cleaned = sanitizeGroupedStories({ [uploaderId]: creatorStories });
              if (cleaned[uploaderId]?.length) {
                groupedObj = { ...groupedObj, [uploaderId]: cleaned[uploaderId] };
              }
            }
          } catch (creatorErr) {
            console.log("[story-viewer] tapped-creator fetch failed:", creatorErr?.message);
          }
        }

        let userGroups = Object.entries(groupedObj)
          .map(([groupKey, storiesForUser]) => {
            // Trust sanitize. groupedObj already passed through
            // sanitizeGroupedStories on both the viewer-scope branch
            // and the discover merge branch — re-running isActiveStory
            // here was double-filtering, and a near-expiry story that
            // squeaked past sanitize at T0 could fail the redundant
            // check at T0+ε and silently drop the entire group. Symptom
            // we hit: `newDiscoverUsers: 1` from the merge, but
            // `discover: 0` once the buckets were built.
            const stories = Array.isArray(storiesForUser) ? [...storiesForUser] : [];
            if (!stories.length) {
              console.log("[story-viewer] empty group dropped", { groupKey });
              return null;
            }

            // Chronological order (oldest → newest) per user, matching
            // Instagram / Facebook / TikTok convention. Tap a creator's
            // tile and you start at their oldest active moment, then
            // auto-advance forward in time to the latest. Tie-break by
            // id so two moments with the exact same createdAt always
            // land in a deterministic order — without this the sort
            // would be stable but the input order (which varies
            // between cold loads, cache loads, and network responses)
            // would leak into the viewer.
            stories.sort((a, b) => {
              const aTs = new Date(a.createdAt).getTime();
              const bTs = new Date(b.createdAt).getTime();
              if (aTs !== bTs) return aTs - bTs; // older first
              const aId = String(a.id || "");
              const bId = String(b.id || "");
              return aId < bId ? -1 : aId > bId ? 1 : 0;
            });

            const first = stories[0];
            // Fall back to the groupKey if for any reason the story
            // row doesn't carry a user.id — that way the group still
            // gets bucketed correctly (groupKey is the userId we
            // grouped under in the first place).
            const userId = first?.user?.id || groupKey;
            return {
              userId,
              name: first?.user?.name || "Unknown User",
              avatar: first?.user?.avatar ?? null,
              stories,
            };
          })
          .filter(Boolean);

        // FB-strip ordering. Three buckets:
        //   • Own       — viewer's own group (always first if present).
        //   • Following — creators the viewer follows, sorted by their
        //                 newest moment first (recency-DESC).
        //   • Discover  — creators the viewer doesn't follow (came in
        //                 via the discover merge), same recency-DESC.
        //
        // The buckets are concatenated in that fixed order so navigating
        // forward (tap right / swipe left) walks Own → Following → Discover
        // → end, and navigating backward (tap left / swipe right) walks
        // the reverse. Tapping any tile lands you at THAT creator's
        // position in the ordered list (not at 0), so the rest of the
        // strip naturally extends to either side of the moment you
        // started on — same as Facebook / Instagram / TikTok.
        const sortByNewest = (a, b) => {
          const lastA = a.stories[a.stories.length - 1];
          const lastB = b.stories[b.stories.length - 1];
          return new Date(lastB.createdAt) - new Date(lastA.createdAt);
        };

        const ownGroup = userGroups.find((u) => u.userId === viewerUserId) || null;
        const followingGroups = userGroups
          .filter((u) => u.userId !== viewerUserId && viewerScopeKeys.has(u.userId))
          .sort(sortByNewest);
        const discoverGroups = userGroups
          .filter((u) => u.userId !== viewerUserId && !viewerScopeKeys.has(u.userId))
          .sort(sortByNewest);

        userGroups = [
          ...(ownGroup ? [ownGroup] : []),
          ...followingGroups,
          ...discoverGroups,
        ];

        // Track each user's bucket so handleNextStory's diagnostic log
        // can call out cross-bucket transitions (Own → Following,
        // Following → Discover, etc.). Stored on the bucketsRef so it
        // survives re-renders without needing a state update.
        const bucketByUserId = {};
        if (ownGroup) bucketByUserId[ownGroup.userId] = "own";
        for (const g of followingGroups) bucketByUserId[g.userId] = "following";
        for (const g of discoverGroups) bucketByUserId[g.userId] = "discover";
        userBucketsRef.current = bucketByUserId;

        // Pick the starting position. clickedOwnStory short-circuits to
        // the own group (always at index 0 above when present); otherwise
        // we look up the tapped uploader in the reordered list. If the
        // uploader didn't survive the merge for any reason (e.g. their
        // moments all expired between the StoryBar render and now) we
        // fall back to index 0 so the viewer at least opens with
        // something instead of blanking out.
        let startUserIdx = 0;
        if (clickedOwnStory && ownGroup) {
          startUserIdx = 0;
        } else if (uploaderId) {
          const idx = userGroups.findIndex((u) => u.userId === uploaderId);
          if (idx >= 0) startUserIdx = idx;
        }

        // Bucket-structure log — fires once per loadAllStories so we can
        // verify the strip composition matches what the home StoryBar
        // showed. If "Own → Following → Discover" feels off when
        // navigating, this log tells you whether the issue is:
        //   - the buckets coming back empty (server / filter issue), or
        //   - the navigation logic skipping ahead (handleNextStory bug).
        console.log("[story-viewer] userGroups built", {
          own: ownGroup ? 1 : 0,
          following: followingGroups.length,
          discover: discoverGroups.length,
          total: userGroups.length,
          startUserIdx,
          startBucket: userGroups[startUserIdx] ? bucketByUserId[userGroups[startUserIdx].userId] : null,
        });

        // Race protection for SWR. If we already painted the cube
        // synchronously from cache (useState initializer), the cube is
        // already on-screen — possibly mid-playback — by the time the
        // network refresh resolves. Compare shape (userIds + per-user
        // story counts in order):
        //   • Same shape → cache and network agree. Do NOTHING.
        //     Cube stays exactly where the user left it.
        //   • Different shape → fresh data; replace the user list,
        //     but PRESERVE the user's current position whenever
        //     possible. Snapping back to startUserIdx on every
        //     network refresh was the May 2026 "viewer jumps back to
        //     the originally-tapped moment mid-playback" bug — it
        //     fired any time discover added/removed a creator while
        //     the user was watching, which is constantly.
        const prevUsers = usersRef.current;
        const sameShape =
          Array.isArray(prevUsers) &&
          prevUsers.length === userGroups.length &&
          prevUsers.every((u, i) =>
            u?.userId === userGroups[i]?.userId &&
            (u?.stories?.length ?? 0) === (userGroups[i]?.stories?.length ?? 0),
          );

        if (!sameShape) {
          // Try to preserve the currently-displayed user across the
          // shape change. Look up their userId in the new userGroups;
          // if they're still on the board, set the index to their NEW
          // position (which may have shifted as discover users were
          // added/removed). Only fall back to startUserIdx when the
          // current user has truly vanished (story expired, was
          // deleted, etc.).
          const prevUserId = prevUsers?.[currentUserIndexRef.current]?.userId || null;
          let nextUserIdx = startUserIdx;
          if (prevUserId) {
            const preservedIdx = userGroups.findIndex((u) => u.userId === prevUserId);
            if (preservedIdx >= 0) {
              nextUserIdx = preservedIdx;
            }
          }
          // Story index — preserve only if we kept the same user AND
          // their stories list is at least as long as where we were.
          // Otherwise reset to story 0 of whichever user we landed on.
          const sameUser = prevUserId && nextUserIdx >= 0 && userGroups[nextUserIdx]?.userId === prevUserId;
          const prevStoryIdx = currentStoryIndexRef.current ?? 0;
          const preservedStoryIdx =
            sameUser && (userGroups[nextUserIdx]?.stories?.length ?? 0) > prevStoryIdx
              ? prevStoryIdx
              : 0;

          setUsers(userGroups);
          setCurrentUserIndex(nextUserIdx);
          setCurrentStoryIndex(preservedStoryIdx);
        }
      } catch (err) {
        console.log("loadAllStories error:", err);
      } finally {
        setLoading(false);
      }
    },
    [cacheKey, clickedOwnStory, dispatch, uploaderId, viewerUserId],
  );

  // Load stories when dependencies change (but not when cacheEntry changes, since it's now a ref)
  useEffect(() => {
    loadAllStories();
  }, [loadAllStories]);

  // Re-check availability once if story becomes missing
  useEffect(() => {
    if (loading) return;
    const missing = !currentUser || !currentStory;
    if (missing && !availabilityChecked) {
      setAvailabilityChecked(true);
      loadAllStories({ forceNetwork: true });
    } else if (!missing && availabilityChecked) {
      setAvailabilityChecked(false);
    }
  }, [loading, currentUser, currentStory, availabilityChecked, loadAllStories]);

  // --------------------------------------------------
  // Stats + Music
  // --------------------------------------------------
  useEffect(() => {
    if (!currentStory || !viewerUserId || closingRef.current) return;
    const loadId = ++musicLoadIdRef.current;
    let disposed = false;

    const fetchStats = async () => {
      try {
        const _hasViewed = await StoryService.checkIfUserViewed(currentStory.id, viewerUserId);
        if (disposed || closingRef.current || loadId !== musicLoadIdRef.current) return;
        setHasViewed(_hasViewed);

        const likedDoc = await StoryService.checkIfUserLiked(currentStory.id, viewerUserId);
        if (disposed || closingRef.current || loadId !== musicLoadIdRef.current) return;
        setHasLiked(!!likedDoc);

        // Load the real aggregate view count from story_stats. Without
        // this, totalViews started at 0 and only ever incremented when
        // a NEW view was created on the current device — which never
        // fires for the owner viewing their own moment, so the activity
        // pill always read "0 views" no matter how many people had
        // actually watched. Now we seed it with the persisted count
        // and any new-view increment below stacks on top.
        try {
          const stats = await StoryService.getStoryStats(currentStory.id);
          if (disposed || closingRef.current || loadId !== musicLoadIdRef.current) return;
          setStoryStats((prev) => ({
            ...prev,
            totalViews: stats?.viewCount ?? 0,
            totalLikes: stats?.likeCount ?? prev.totalLikes,
          }));
        } catch (statsErr) {
          console.log("[story-viewer] getStoryStats error:", statsErr?.message);
        }

        // Reactions — fetched on every story change so the action
        // bar reflects the viewer's existing reaction (if any) and
        // the running total. Bundled with the existing stats fetch
        // so we don't add a separate effect that fights for the
        // closingRef guard.
        try {
          const summary = await StoryService.getStoryReactions(currentStory.id, viewerUserId);
          if (disposed || closingRef.current || loadId !== musicLoadIdRef.current) return;
          setCurrentReaction(summary?.ownReaction || null);
          setReactionCount(summary?.total || 0);
        } catch (rxnErr) {
          console.log("[reactions] load error:", rxnErr?.message);
          setCurrentReaction(null);
          setReactionCount(0);
        }

        if (!_hasViewed && currentStory.user.id !== viewerUserId) {
          await StoryService.createView(currentStory.id, viewerUserId);
          if (disposed || closingRef.current || loadId !== musicLoadIdRef.current) return;
          setHasViewed(true);

          setStoryStats((prev) => ({
            ...prev,
            totalViews: prev.totalViews + 1,
          }));
        }
      } catch (error) {
        console.log("fetchStats error:", error);
      }
    };

    const loadMusic = async () => {
      let createdSound = null;

      try {
        if (closingRef.current) return;

        await stopAndUnloadCurrentMusic();
        if (disposed || closingRef.current || loadId !== musicLoadIdRef.current) return;

        if (!currentStory?.musicId) {
          setStoryMusic(null);
          return;
        }

        const musicDoc = await StoryService.fetchMusic(currentStory.musicId);
        if (disposed || closingRef.current || loadId !== musicLoadIdRef.current) return;

        setStoryMusic(musicDoc);

        await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
        if (disposed || closingRef.current || loadId !== musicLoadIdRef.current) return;

        const { sound } = await Audio.Sound.createAsync(
          { uri: musicDoc.fileUrl },
          {
            shouldPlay: !pausedRef.current && !closingRef.current,
            isLooping: true,
            // Apply the sticky session-level mute preference at
            // creation time so the next Moment doesn't briefly
            // play audio before the muted state is applied.
            isMuted: muted,
          },
        );
        createdSound = sound;

        if (disposed || closingRef.current || loadId !== musicLoadIdRef.current) return;

        musicRef.current = sound;
      } catch (error) {
        console.log("loadMusic error:", error);
      } finally {
        if (createdSound && (disposed || closingRef.current || loadId !== musicLoadIdRef.current)) {
          await stopAndUnloadSound(createdSound);
        }
      }
    };

    fetchStats();
    void loadMusic();

    return () => {
      disposed = true;

      if (loadId === musicLoadIdRef.current) {
        musicLoadIdRef.current += 1;
      }

      void stopAndUnloadCurrentMusic();
    };
  }, [currentStory?.id, currentStory?.musicId, currentStory?.user?.id, viewerUserId, stopAndUnloadCurrentMusic, stopAndUnloadSound]);

  // --------------------------------------------------
  // Pause / Resume
  // --------------------------------------------------
  const pauseStory = useCallback(() => {
    if (pausedRef.current) return;
    setPaused(true);

    musicRef.current?.pauseAsync();

    if (currentStory?.type === "video" && isVideoReady(currentStory)) {
      videoPlayer?.pause();
    }

    progress.stopAnimation((v) => (progressValueRef.current = v ?? 0));
  }, [currentStory?.type, currentStory?.status, videoPlayer, progress]);

  const resumeStory = useCallback(() => {
    if (!pausedRef.current) return;
    setPaused(false);

    musicRef.current?.playAsync();

    if (videoLoadedRef.current && currentStory?.type === "video" && isVideoReady(currentStory)) {
      try {
        videoPlayer.play();
      } catch (e) {}
    }

    const remaining = 1 - progressValueRef.current;
    const remainingMs = remaining * currentDurationRef.current;

    if (remaining <= 0) return handleNextStory();

    const anim = Animated.timing(progress, {
      toValue: 1,
      duration: remainingMs,
      useNativeDriver: false,
    });

    progressAnimRef.current = anim;

    anim.start(({ finished }) => {
      if (finished && !pausedRef.current) handleNextStory();
    });
  }, [currentStory?.type, currentStory?.status]);

  // --------------------------------------------------
  // Story Navigation
  // --------------------------------------------------
  // Story navigation. Two constraints we have to satisfy together:
  //   1. Read the freshest currentStoryIndex even if multiple advance
  //      calls fire close together (e.g. animation finish + a delete-
  //      driven advance). The setState updater pattern reads the
  //      committed/queued state directly, which is more reliable than
  //      a ref that's only updated by a mirroring useEffect.
  //   2. Don't call router.back() (via safeClose) from inside the
  //      updater — that fires a parent navigator state change during
  //      our render commit and trips React's "Cannot update a
  //      component while rendering a different component" warning.
  //
  // We satisfy both by setting a `shouldClose` flag from inside the
  // updater (the updater stays close to pure — it returns the same
  // `prev` value when it would have closed) and invoking safeClose()
  // AFTER the updater returns, outside the render phase.
  const handleNextStory = useCallback(() => {
    if (closingRef.current) return;

    const userIdx = currentUserIndexRef.current;
    const usersLocal = usersRef.current;
    const user = usersLocal[userIdx];
    if (!user) return;

    let shouldClose = false;
    setCurrentStoryIndex((prev) => {
      const nextIndex = prev + 1;
      const len = user.stories.length;
      const buckets = userBucketsRef.current || {};
      const fromBucket = buckets[user.userId] || null;

      if (nextIndex < len) {
        // Same-user advance — staying within the active stack.
        console.log("[story-viewer] handleNextStory", {
          decision: "next-story",
          userIdx,
          prev,
          nextIndex,
          storiesLen: len,
          usersLen: usersLocal.length,
          bucket: fromBucket,
        });
        return nextIndex;
      }

      const nextUserIndex = userIdx + 1;
      if (nextUserIndex < usersLocal.length) {
        const nextUser = usersLocal[nextUserIndex];
        const toBucket = buckets[nextUser?.userId] || null;
        // Cross-user transition — call out bucket changes so we can
        // confirm the Own → Following → Discover progression matches
        // what the user expects.
        console.log("[story-viewer] handleNextStory", {
          decision: "next-user",
          userIdx,
          nextUserIndex,
          fromBucket,
          toBucket,
          crossedBucket: fromBucket !== toBucket,
          usersLen: usersLocal.length,
        });
        setCurrentUserIndex(nextUserIndex);
        return 0; // start at oldest moment of next user (chronological)
      }

      // End of the stack — close. Logged so we can distinguish a
      // legitimate end (Own → Following → Discover → end) from a
      // premature close caused by an incomplete merge.
      console.log("[story-viewer] handleNextStory", {
        decision: "close",
        userIdx,
        usersLen: usersLocal.length,
        fromBucket,
      });
      shouldClose = true;
      return prev; // hold the index — close fires below
    });
    if (shouldClose) safeClose();
  }, [safeClose]);

  const handlePrevStory = useCallback(() => {
    if (closingRef.current) return;

    const userIdx = currentUserIndexRef.current;
    const usersLocal = usersRef.current;
    const user = usersLocal[userIdx];
    if (!user) return;

    let shouldClose = false;
    setCurrentStoryIndex((prev) => {
      const prevIndex = prev - 1;
      if (prevIndex >= 0) return prevIndex;

      const prevUserIndex = userIdx - 1;
      if (prevUserIndex >= 0) {
        const prevUser = usersLocal[prevUserIndex];
        setCurrentUserIndex(prevUserIndex);
        return prevUser.stories.length - 1; // newest moment of prev user
      }

      shouldClose = true;
      return prev;
    });
    if (shouldClose) safeClose();
  }, [safeClose]);

  const handleTap = (x) => {
    if (closingRef.current) return;
    if (pausedRef.current || gestureRef.current.isLongPress) return;

    if (x < screenWidth / 2) handlePrevStory();
    else handleNextStory();
  };

  // --------------------------------------------------
  // Progress animation
  // --------------------------------------------------
  const startProgressAnimation = useCallback(() => {
    if (!currentStory || closingRef.current) return;

    let durationMs = imageDurationMs;

    if (currentStory.type === "video" && isVideoReady(currentStory)) {
      const backendMs = currentDurationRef.current * 1000 || MAX_VIDEO_DURATION;
      durationMs = Math.min(backendMs, MAX_VIDEO_DURATION);
    }

    currentDurationRef.current = durationMs;

    progressValueRef.current = 0;
    progress.setValue(0);

    const anim = Animated.timing(progress, {
      toValue: 1,
      duration: durationMs,
      useNativeDriver: false,
    });

    progressAnimRef.current = anim;

    anim.start(({ finished }) => {
      if (finished && !pausedRef.current && !closingRef.current) handleNextStory();
    });
  }, [currentStory, imageDurationMs, handleNextStory]);

  useEffect(() => {
    if (!users.length || !currentStory || closingRef.current) return;

    // For non-ready videos we used to bail entirely — that left the
    // progress bar frozen and the stack never advanced (the user just
    // sat on a "Video is still processing…" overlay forever). Now we
    // start an image-length animation so the placeholder eventually
    // auto-advances to the next moment. When the video finishes
    // encoding mid-view, the readyToPlay listener inside useVideoPlayer
    // will call startProgressAnimation again with the real duration.
    startProgressAnimation();
  }, [currentStory?.id, users.length]);

  // Follow the swipe-up link target on the current Moment. Routes
  // in-app for Selebox book/video links (using router.push to the same
  // routes the rest of the app uses) and falls back to the system
  // browser for external URLs. Closes the viewer first so the user
  // doesn't return to a paused-mid-swipe Moment when they come back.
  const handleFollowLink = useCallback(async () => {
    const link = currentLinkRef.current;
    if (!link?.url) return;
    closingRef.current = true;
    try {
      // Close the viewer first — gives the user a clean transition into
      // the destination instead of a paused-mid-swipe story behind a modal.
      router.back();
      // Tiny defer so the back animation gets a chance to commit before
      // we push the next route. Without this Expo Router occasionally
      // collapses the two transitions and lands on the wrong stack frame.
      setTimeout(() => {
        // Resolve the destination from explicit resourceType/resourceId
        // first (set by LinkPickerModal at attach time), then fall back
        // to parsing link.url. The URL fallback covers:
        //   - older Moments stored before LinkPickerModal extracted
        //     resourceType
        //   - links pasted with query strings / fragments that didn't
        //     match the modal's strict regex
        //   - any future case where resourceType is missing for any
        //     reason — better to deep-link from the URL than open
        //     selebox.com in a browser when we have all the data needed.
        let resolvedType = null;
        let resolvedId = null;

        if (link.resourceType === "book" && link.resourceId) {
          resolvedType = "book";
          resolvedId = link.resourceId;
        } else if (link.resourceType === "video" && link.resourceId) {
          resolvedType = "video";
          resolvedId = link.resourceId;
        } else if (link.url) {
          // Permissive Selebox-URL match — accepts UUID + legacy hex IDs
          // and tolerates ?query / #fragment suffixes. Mirrors the regex
          // in utils/appLinks.js so both surfaces stay in sync.
          const match = link.url.match(/^https?:\/\/(?:www\.)?selebox\.com\/(books|videos)\/([\w-]+)/i);
          if (match) {
            resolvedType = match[1] === "books" ? "book" : "video";
            resolvedId = match[2];
          }
        }

        if (resolvedType === "book" && resolvedId) {
          router.push({ pathname: "/(book)/book-info", params: { bookId: resolvedId } });
        } else if (resolvedType === "video" && resolvedId) {
          router.push({ pathname: "/(video)/video-player", params: { docId: resolvedId } });
        } else {
          // Genuinely external (non-Selebox) URL — open in the system
          // browser. WebBrowser keeps the in-app context (no tab spam)
          // while still respecting the user's default browser preference
          // on Android.
          WebBrowser.openBrowserAsync(link.url).catch((err) => {
            console.log("[story-viewer] failed to open link", err?.message);
          });
        }
      }, 80);
    } catch (err) {
      console.log("[story-viewer] handleFollowLink error", err?.message);
    }
  }, []);

  // Sync the latest follow-link callback into a ref so the panResponder
  // (frozen at first render) can call the freshest version on swipe-up
  // without being re-created.
  useEffect(() => {
    followLinkRef.current = handleFollowLink;
  }, [handleFollowLink]);

  // --------------------------------------------------
  // Gestures
  // --------------------------------------------------
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !closingRef.current,

      onPanResponderGrant: (evt) => {
        const { locationX, locationY } = evt.nativeEvent;

        gestureRef.current = {
          startX: locationX,
          startY: locationY,
          isLongPress: false,
          isSwipe: false,
        };

        if (closingRef.current) return;

        longPressTimeout.current = setTimeout(() => {
          gestureRef.current.isLongPress = true;
          pauseStory();
        }, LONG_PRESS_THRESHOLD);
      },

      onPanResponderMove: (_, { dx, dy }) => {
        if (closingRef.current) return;

        if ((Math.abs(dx) > 10 || Math.abs(dy) > 10) && longPressTimeout.current) {
          clearTimeout(longPressTimeout.current);
          longPressTimeout.current = null;
        }

        if (!gestureRef.current.isSwipe && Math.abs(dx) > 35 && Math.abs(dy) < 40) {
          gestureRef.current.isSwipe = true;
        }

        if (gestureRef.current.isSwipe) {
          const t = Math.max(-1, Math.min(1, dx / screenWidth));
          cubeAnim.setValue(t);
        }
      },

      onPanResponderRelease: (_, { dx, dy, vx }) => {
        if (closingRef.current) return;

        if (longPressTimeout.current) {
          clearTimeout(longPressTimeout.current);
          longPressTimeout.current = null;
        }

        const { startX, isLongPress, isSwipe } = gestureRef.current;

        if (isLongPress) {
          resumeStory();
          return;
        }

        // Vertical swipe — up = follow link (when one is attached),
        // down = close viewer (existing behavior). The directional split
        // makes the swipe-up gesture feel natural for the "tap to learn
        // more / read this book" CTA on Moments with a link, while
        // preserving Instagram-style swipe-down-to-dismiss for everything
        // else.
        if (!isSwipe) {
          const verticalThreshold = screenHeight * 0.18;
          const horizontalLimit = screenWidth * 0.2;

          if (Math.abs(dy) > verticalThreshold && Math.abs(dx) < horizontalLimit) {
            // Swipe UP (dy < 0) with a link attached → follow.
            if (dy < 0 && currentLinkRef.current?.url) {
              followLinkRef.current?.();
              return;
            }
            // Swipe DOWN (or up without a link) → close.
            closingRef.current = true;
            safeClose();
            return;
          }
        }

        if (isSwipe) {
          const threshold = screenWidth * 0.25;
          const movedLeft = dx < -threshold || vx < -0.3;
          const movedRight = dx > threshold || vx > 0.3;

          const animateTo = (value, cb) => {
            Animated.timing(cubeAnim, {
              toValue: value,
              duration: 220,
              useNativeDriver: true,
            }).start(() => {
              cubeAnim.setValue(0);

              if (closingRef.current) return;

              if (cb) cb();
              else resumeStory();
            });
          };

          const userIdx = currentUserIndexRef.current;
          const usersLocal = usersRef.current;

          // Next user
          if (movedLeft) {
            if (userIdx < usersLocal.length - 1) {
              animateTo(-1, () => {
                if (closingRef.current) return;

                const nextUserIndex = userIdx + 1;
                const nextUser = usersLocal[nextUserIndex];
                const lastIndex = getSavedIndex(nextUser);

                setCurrentUserIndex(nextUserIndex);
                setCurrentStoryIndex(lastIndex);
              });
            } else {
              Animated.spring(cubeAnim, {
                toValue: 0,
                friction: 6,
                useNativeDriver: true,
              }).start(() => resumeStory());
            }
            return;
          }

          // Previous user
          if (movedRight) {
            if (userIdx > 0) {
              animateTo(1, () => {
                if (closingRef.current) return;

                const prevUserIndex = userIdx - 1;
                const prevUser = usersLocal[prevUserIndex];
                const lastIndex = getSavedIndex(prevUser) ?? prevUser.stories.length - 1;

                setCurrentUserIndex(prevUserIndex);
                setCurrentStoryIndex(lastIndex);
              });
            } else {
              Animated.spring(cubeAnim, {
                toValue: 0,
                friction: 6,
                useNativeDriver: true,
              }).start(() => resumeStory());
            }
            return;
          }

          Animated.spring(cubeAnim, {
            toValue: 0,
            friction: 7,
            useNativeDriver: true,
          }).start(() => resumeStory());

          return;
        }

        // TAP
        handleTap(startX);
      },
    }),
  ).current;

  // --------------------------------------------------
  // Render media
  // --------------------------------------------------
  const renderStoryMedia = (story, isCurrent) => {
    if (!story) return null;

    const mediaStyle = { width: "100%", height: "100%" };

    // May 2026 — cover instead of contain so the picture/video uses
    // the full screen. The previous "contain" sizing left visible
    // letterbox bars on any non-portrait media (square Selebox-logo
    // images showed white bars top + bottom). With cover the media
    // crops to fill — same approach IG/FB Stories use. Authors
    // already see the editor's safe-frame guide while composing, so
    // important content stays inside the visible region.
    if (story.type === "image") {
      return <FastImage source={{ uri: story.mediaUrl }} style={mediaStyle} resizeMode="cover" />;
    }

    if (story.type === "video" && !isVideoReady(story)) {
      return <FastImage source={{ uri: story.thumbnail || story.mediaUrl }} style={mediaStyle} resizeMode="cover" />;
    }

    if (isCurrent) {
      return (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <VideoView
            style={styles.media}
            player={videoPlayer}
            nativeControls={false}
            allowsFullscreen={false}
            allowsPictureInPicture={false}
            contentFit="cover"
          />
        </View>
      );
    }

    return <FastImage source={{ uri: story.thumbnail || story.mediaUrl }} style={mediaStyle} resizeMode="cover" />;
  };

  // --------------------------------------------------
  // Delete story
  // --------------------------------------------------
  const doDeleteStory = async () => {
    if (!currentStory?.id) return;

    const storyToDelete = currentStory;
    const uploaderIdLocal = storyToDelete.user?.id;

    // Optimistic UI removal to avoid UI freeze while backend processes
    setUsers((prev) => {
      const next = prev
        .map((u) => ({
          ...u,
          stories: (u.stories || []).filter((s) => s.id !== storyToDelete.id),
        }))
        .filter((u) => u.stories.length > 0);
      return next;
    });

    storyEvents.emit("storyDeleted", {
      storyId: storyToDelete.id,
      uploaderId: uploaderIdLocal,
    });

    // Decide next story/user after optimistic removal
    const usersLocal = usersRef.current;
    const userIdx = currentUserIndexRef.current;
    const user = usersLocal[userIdx];
    if (!user || user.stories.length <= 1) {
      if (usersLocal.length <= 1) {
        safeClose();
      } else {
        const nextIdx = Math.min(userIdx, usersLocal.length - 2);
        setCurrentUserIndex(nextIdx);
        setCurrentStoryIndex(0);
      }
    } else {
      handleNextStory();
    }

    // Run backend cleanup in background
    (async () => {
      try {
        await Promise.allSettled([StoryService.deleteStoryMedia(storyToDelete), StoryService.deleteStory(storyToDelete.id)]);
      } catch (err) {
        console.log("Failed to delete story:", err);
      } finally {
        await loadAllStories({ forceNetwork: true });
      }
    })();
  };

  // Two-button confirm with explicit Cancel — the previous CustomAlertModal
  // path treated backdrop tap (and "Okay") identically and ALWAYS fired
  // doDeleteStory, so there was no way to back out once the trash icon
  // was tapped. Alert.alert is the native API and gives us a real
  // destructive Delete + non-destructive Cancel. iOS auto-styles the
  // destructive button red.
  const askDelete = () => {
    Alert.alert(
      "Delete this moment?",
      "It will be removed from your story and your viewers won't see it anymore.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: doDeleteStory },
      ],
      { cancelable: true },
    );
  };

  // --------------------------------------------------
  // Render
  // --------------------------------------------------
  const handleUnavailableClose = () => {
    storyEvents.emit("storyDeleted", { storyId: null, uploaderId: null });
    loadAllStories({ forceNetwork: true });
    safeClose();
  };

  const missingStory = !currentUser || !currentStory;

  // Brief loading placeholder — silent, no copy. The previous version
  // showed "Loading stories…" centered on a black screen, which felt
  // like an error/loading screen every time the user tapped a tile.
  // FB / IG / TikTok all use a near-instant fade-in instead. We match
  // that by rendering just a small low-contrast spinner over a black
  // backdrop while the network fetch resolves; the user reads it as
  // a transition shimmer, not a blocking screen.
  if (loading && missingStory) {
    return (
      <StyledSafeAreaView className="flex-1 items-center justify-center bg-black" edges={["top"]}>
        <ActivityIndicator size="small" color="rgba(255,255,255,0.55)" />
      </StyledSafeAreaView>
    );
  }

  if (missingStory) {
    return (
      <StyledSafeAreaView className="flex-1 items-center justify-center bg-black">
        <Text className="text-white">Story not available.</Text>
        <TouchableOpacity className="mt-4 rounded-full bg-purple-600 px-4 py-2" onPress={handleUnavailableClose}>
          <Text className="font-semibold text-white">Go back</Text>
        </TouchableOpacity>
      </StyledSafeAreaView>
    );
  }

  const progressWidth = progress.interpolate({
    inputRange: [0, 1],
    outputRange: ["0%", "100%"],
  });

  const prevStory = prevUser ? prevUser.stories[getSavedIndex(prevUser)] : null;
  const nextStory = nextUser ? nextUser.stories[getSavedIndex(nextUser)] : null;

  // CURRENT
  const currentFace = (
    <View style={styles.faceInner}>
      {/* Media fills the full screen first — header + bottom bar
          overlay it via absolute positioning. */}
      <View style={styles.mediaArea} {...panResponder.panHandlers}>
        <View style={styles.mediaFrame}>{renderStoryMedia(currentStory, true)}</View>
      </View>

      <View style={styles.headerArea} pointerEvents="box-none">
        <StoryHeader
          user={currentUser}
          story={currentStory}
          storyMusic={storyMusic}
          stories={currentUser.stories}
          currentStoryIndex={currentStoryIndex}
          progressWidth={progressWidth}
          onClose={safeClose}
          onDelete={askDelete}
          viewerUserId={viewerUserId}
          isMuted={muted}
          onMuteToggle={handleMuteToggle}
          isPaused={paused}
          onPauseToggle={() => (paused ? resumeStory() : pauseStory())}
        />
      </View>

      <View style={styles.bottomArea} pointerEvents="box-none">
        {currentStory?.link?.url ? <SwipeUpHint link={currentStory.link} onTap={handleFollowLink} /> : null}

        <StoryActionBar
          isOwnStory={currentStory.user.id === viewerUserId}
          currentReaction={currentReaction}
          reactionCount={reactionCount}
          totalViews={storyStats.totalViews}
          onReactionPress={pickReaction}
          onComposerPress={() => setReplyOpen(true)}
          onRepostPress={() => setRepostSheetOpen(true)}
          onViewersPress={() => setViewersSheetOpen(true)}
        />
      </View>

      {currentStory.type === "video" && !isVideoReady(currentStory) && currentStory.user.id === viewerUserId && (
        <View style={styles.processingOverlay}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={styles.processingText}>Video is still processing…</Text>
        </View>
      )}
    </View>
  );

  // PREVIOUS / NEXT preview faces — shown briefly during the cube
  // swipe between users. These are static previews, not interactive,
  // so they only need the media + a minimal header (avatar/name).
  // Previously they rendered `<StoryBottomBar>` and `<StoryHeader>`
  // with `currentUser`/`currentStory` (the active user's data, not
  // the prev/next user's — leftover from an earlier refactor). The
  // bottom bar reference also crashed the screen because StoryBottomBar
  // was retired in the May 2026 action-bar revamp and never imported
  // here. The crash only surfaced once we started loading discover
  // creators alongside followings (cube has > 1 face), so this branch
  // had been silently broken for a while.
  //
  // Fix: drop the bottom bar entirely on preview faces (the user only
  // sees them during a 220ms swipe animation — they don't need it),
  // and pass the correct prev/next user + story to the header so the
  // preview shows the right avatar/name during the swipe.
  const prevFace =
    prevUser && prevStory ? (
      <View style={styles.faceInner}>
        <View style={styles.headerArea} pointerEvents="none">
          <StoryHeader
            user={prevUser}
            story={prevStory}
            stories={prevUser.stories || [prevStory]}
            currentStoryIndex={getSavedIndex(prevUser)}
            progressWidth={progressWidth}
            onClose={safeClose}
            viewerUserId={viewerUserId}
          />
        </View>

        <View style={styles.mediaArea}>
          <View style={styles.mediaFrame}>{renderStoryMedia(prevStory, false)}</View>
        </View>
      </View>
    ) : null;

  const nextFace =
    nextUser && nextStory ? (
      <View style={styles.faceInner}>
        <View style={styles.headerArea} pointerEvents="none">
          <StoryHeader
            user={nextUser}
            story={nextStory}
            stories={nextUser.stories || [nextStory]}
            currentStoryIndex={getSavedIndex(nextUser)}
            progressWidth={progressWidth}
            onClose={safeClose}
            viewerUserId={viewerUserId}
          />
        </View>

        <View style={styles.mediaArea}>
          <View style={styles.mediaFrame}>{renderStoryMedia(nextStory, false)}</View>
        </View>
      </View>
    ) : null;

  return (
    // edges={["top"]} so the safe-area padding only protects the
    // notch/status bar at the top. Without this constraint the wrapper
    // also reserves insets.bottom of black at the screen bottom — and
    // because StoryActionBar already adds insets.bottom + 54 of its
    // own padding to lift its controls above the home indicator, we
    // were double-counting the bottom inset. The visible symptom was
    // a chunky black strip below the views/send-message pill that
    // looked like it was overlaying the controls. Restricting the
    // safe area to "top" lets the cube + action bar extend all the
    // way to the screen bottom, and the action bar handles its own
    // home-indicator clearance.
    <StyledSafeAreaView className="flex-1 bg-black" edges={["top"]}>
      <View style={styles.root}>
        <StoryCubeFaces cubeAnim={cubeAnim} currentFace={currentFace} prevFace={prevFace} nextFace={nextFace} />
      </View>
      <CustomAlertModal message={message} iconName="trash" iconColor="#f87171" messageOpen={messageOpen} closeMessage={closeMessage} />

      {/* Premium-viewer sheets — mounted at root so they sit above
          the cube faces and bottom bar. They each manage their own
          backdrop + dismiss gestures. */}
      <StoryViewersSheet
        visible={viewersSheetOpen}
        onClose={() => setViewersSheetOpen(false)}
        storyId={currentStory?.id}
        totalViews={storyStats.totalViews}
        totalReactions={reactionCount}
      />

      <StoryRepostSheet
        visible={repostSheetOpen}
        onClose={() => setRepostSheetOpen(false)}
        onShareToDM={handleShareToDM}
        onRepost={handleRepost}
        ownerName={currentStory?.user?.name ? `@${currentStory.user.name}` : null}
      />

      {/* Reply composer — opens when the viewer taps "Send message…"
          on the action bar. Fires getOrCreate1to1Conversation +
          sendMessage against the moment owner. */}
      <StoryReplyComposer
        visible={replyOpen}
        onClose={() => setReplyOpen(false)}
        recipientId={currentStory?.user?.id}
        recipientName={currentStory?.user?.name}
        onSent={() => showMessage("Message sent")}
      />

      {/* Story comments — coming in a follow-up. PostCommentModal is
          currently coupled to post-shaped items (reads item.$id) so we
          can't reuse it directly; a dedicated StoryCommentModal +
          story_comments table will land next. For now the button shows
          an alert so users know the feature is on the way. */}
    </StyledSafeAreaView>
  );
};

// --------------------------------------------------
// Styles
// --------------------------------------------------
const styles = StyleSheet.create({
  root: {
    flex: 1,
    width: screenWidth,
    backgroundColor: "#020617",
  },

  faceInner: {
    flex: 1,
    backgroundColor: "#020617",
  },

  // May 2026 — full-bleed layout. Header + bottom bar overlay the
  // media as floating absolutes instead of consuming flex space, so
  // the picture/video uses the entire screen. Each face stacks the
  // three regions on top of each other:
  //   • mediaArea fills 100% (z=0)
  //   • headerArea floats at top, pointerEvents: box-none so taps
  //     fall through to the media (only the close/delete buttons
  //     intercept)
  //   • bottomArea floats at bottom, same box-none pattern
  headerArea: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
  },

  mediaArea: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },

  bottomArea: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 10,
  },

  mediaFrame: {
    width: "100%",
    height: "100%",
    justifyContent: "center",
    alignItems: "center",
  },

  media: {
    width: "100%",
    height: "100%",
    backgroundColor: "#020617",
  },

  processingOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 999,
  },

  processingText: {
    color: "#fff",
    marginTop: 8,
    fontSize: 14,
  },
});

export default StoryViewer;
