// Creator profile screen — opened anywhere a user is tapped (post owners,
// video uploaders, comment authors, suggested creators, search results, …).
//
// Why the pre-hydrate + module cache:
//   The original implementation gated the entire screen on a fresh
//   getUserByID + fetchVideos round trip. From the user's perspective, tapping
//   a creator showed the loading spinner until BOTH calls resolved (~800-1500ms
//   on a real network). That felt like the screen was lagging.
//
//   Now we paint with whatever we already know about the user *before* the
//   network call finishes:
//     1. CREATOR_PROFILE_CACHE — a module-level Map<userId, user> with a 5min
//        TTL. Tapping the same creator twice in a session is instant.
//     2. allVideos — the global feed cache already has uploader objects with
//        username + avatar + accountId. If the tapped creator authored any
//        cached video, we have enough to paint the name/avatar immediately.
//     3. allVideos.uploader.uploader — if the creator IS a viewer (commented
//        elsewhere), we may have richer data. Same lookup.
//
//   The fresh fetch still runs in the background and replaces the placeholder
//   user once it resolves, so any data we don't have (banner, bio, exact
//   stats) lands within the same beat without ever showing a blocked screen.

import { Feather, MaterialIcons } from "@expo/vector-icons";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { MMKV } from "react-native-mmkv";
import { Profile, StyledSafeAreaView, StyledTitle } from "../../components";
import { useGlobalContext } from "../../context/global-provider";
import useAppTheme from "../../hooks/useAppTheme";
import { filterVideosByOwner } from "../../lib/appwrite";
import { listBlockedUsers, unblockUser } from "../../lib/safety";
import { getUserByID } from "../../lib/users";
import { VideosService } from "../../lib/video";

// Two-tier cache for creator profiles:
//   • In-memory Map (fastest, used for back-to-back navigation in same session)
//   • MMKV-backed disk persistence (survives cold start)
// Previously this was Map-only at module scope, so every cold start of the
// app threw away the entire cache and the user saw "loading vibes" on
// every single creator profile they opened. With MMKV persistence the
// next-day app launch still hands a cached user to the first paint while
// a silent refresh runs in the background.
//
// Freshness:
//   - In-memory entries have an inline cachedAt; TTL gates them out.
//   - Disk entries carry the same cachedAt; TTL also gates them on read.
//   - 5min is long enough that flicking between creators feels instant,
//     short enough that bio/banner edits land within one return-to-screen.
const CREATOR_PROFILE_TTL_MS = 5 * 60 * 1000;
// Stronger freshness gate for the focus refetch — if disk cache is
// younger than this, skip the network call entirely. Web-style
// "load once per minute" semantic.
const CREATOR_PROFILE_REFRESH_TTL_MS = 60 * 1000;
const CREATOR_PROFILE_CACHE = new Map();
const profileStorage = new MMKV({ id: "selebox-profile-cache" });

const readCachedUser = (userId) => {
  if (!userId) return null;
  // In-memory first.
  const cached = CREATOR_PROFILE_CACHE.get(userId);
  if (cached) {
    if (Date.now() - cached.cachedAt > CREATOR_PROFILE_TTL_MS) {
      CREATOR_PROFILE_CACHE.delete(userId);
    } else {
      return cached.user;
    }
  }
  // Fall through to MMKV. On cold start this is the only layer that has
  // anything; promote it back into memory so subsequent reads in the
  // session bypass the JSON parse cost.
  try {
    const blob = profileStorage.getString(`user:${userId}`);
    if (!blob) return null;
    const parsed = JSON.parse(blob);
    if (!parsed || typeof parsed !== "object") return null;
    if (Date.now() - parsed.cachedAt > CREATOR_PROFILE_TTL_MS) {
      profileStorage.delete(`user:${userId}`);
      return null;
    }
    CREATOR_PROFILE_CACHE.set(userId, parsed);
    return parsed.user;
  } catch {
    return null;
  }
};

const readCachedUserAge = (userId) => {
  if (!userId) return Infinity;
  const cached = CREATOR_PROFILE_CACHE.get(userId);
  if (cached?.cachedAt) return Date.now() - cached.cachedAt;
  try {
    const blob = profileStorage.getString(`user:${userId}`);
    if (!blob) return Infinity;
    const parsed = JSON.parse(blob);
    if (!parsed?.cachedAt) return Infinity;
    return Date.now() - parsed.cachedAt;
  } catch {
    return Infinity;
  }
};

const writeCachedUser = (userId, user) => {
  if (!userId || !user) return;
  const entry = { user, cachedAt: Date.now() };
  CREATOR_PROFILE_CACHE.set(userId, entry);
  try {
    profileStorage.set(`user:${userId}`, JSON.stringify(entry));
  } catch {
    // Disk write failure (e.g. storage full) shouldn't poison the
    // in-memory layer — silent best-effort persistence.
  }
};

// Persisted videos list per creator, mirroring the user-level cache.
// Keyed `videos:<userId>` so it lives alongside the user blob in the
// same MMKV instance. Same TTL semantics.
const readCachedCreatorVideos = (userId) => {
  if (!userId) return null;
  try {
    const blob = profileStorage.getString(`videos:${userId}`);
    if (!blob) return null;
    const parsed = JSON.parse(blob);
    if (!parsed || !Array.isArray(parsed.videos)) return null;
    if (Date.now() - parsed.cachedAt > CREATOR_PROFILE_TTL_MS) {
      profileStorage.delete(`videos:${userId}`);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const writeCachedCreatorVideos = (userId, videos) => {
  if (!userId || !Array.isArray(videos)) return;
  try {
    profileStorage.set(`videos:${userId}`, JSON.stringify({ videos, cachedAt: Date.now() }));
  } catch {
    // Best-effort; same rationale as writeCachedUser.
  }
};

// Pulls the richest user payload we already have in memory for this userId,
// without making any network calls. Sources, in order of richness:
//   - the module-level CREATOR_PROFILE_CACHE (most recently fetched)
//   - any uploader object hanging off allVideos (username + avatar + role)
const findCachedCreator = (userId, allVideos) => {
  if (!userId) return null;

  const cachedUser = readCachedUser(userId);
  if (cachedUser) return cachedUser;

  if (Array.isArray(allVideos)) {
    const fromVideo = allVideos.find((video) => {
      const uploaderId = video?.uploader?.$id || video?.uploader?.uid;
      return uploaderId === userId;
    });
    if (fromVideo?.uploader && typeof fromVideo.uploader === "object") return fromVideo.uploader;
  }

  return null;
};

const CreatorProfile = () => {
  const { userId } = useLocalSearchParams();
  const { allVideos, user: viewer } = useGlobalContext();
  const { theme } = useAppTheme();
  // Pre-hydrate the user state synchronously on first mount so the screen
  // paints with the cached creator immediately. The fresh fetch below will
  // replace this placeholder once it resolves.
  const initialUser = useMemo(() => findCachedCreator(userId, allVideos), [userId, allVideos]);
  // Pre-hydrate videos in this priority order:
  //   1. allVideos (the global feed cache) — usually has the latest
  //   2. MMKV-persisted creator videos cache — survives cold start
  //   3. Empty until the network fetch resolves
  const initialVideos = useMemo(() => {
    if (!userId) return [];
    if (allVideos?.length) {
      const fromFeed = filterVideosByOwner(allVideos, userId);
      if (fromFeed.length) return fromFeed;
    }
    const persisted = readCachedCreatorVideos(userId);
    return persisted?.videos || [];
  }, [allVideos, userId]);
  const [user, setUser] = useState(initialUser);
  const [videos, setVideos] = useState(initialVideos);
  // Only show the loading state if we don't already have *something* to show
  // for the user — i.e. it's a fresh creator we've never opened before AND
  // none of their videos have hit our feed cache OR the persisted MMKV
  // cache yet. With MMKV persistence the loading state is now reserved
  // for genuinely-first-time-open creators; everything else paints
  // instantly from cache.
  const [loading, setLoading] = useState(!initialUser && !initialVideos.length);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isBlocked, setIsBlocked] = useState(false);
  const videosService = useRef(new VideosService()).current;
  const hasLoadedOnce = useRef(false);

  const hydrateCachedVideos = useCallback(() => {
    if (!allVideos?.length || !userId) return [];
    const cachedVideos = filterVideosByOwner(allVideos, userId);
    if (cachedVideos.length) {
      setVideos(cachedVideos);
    }
    return cachedVideos;
  }, [allVideos, userId]);

  const fetchUserAndVideos = useCallback(async () => {
    if (!userId) return;
    const cachedVideos = hydrateCachedVideos();
    // Only flip the loading flag if we have nothing pre-hydrated AND we
    // haven't already loaded this user once in this mount. Otherwise the
    // screen is already painted and the fresh fetch is a silent refresh.
    if (!hasLoadedOnce.current && !user) setLoading(!cachedVideos.length);
    setIsRefreshing(true);

    try {
      const [userData, videosData] = await Promise.all([
        getUserByID({ ID: userId }),
        videosService.fetchVideos({ userId, limit: 50, status: "published" }),
      ]);

      if (userData) {
        setUser(userData);
        writeCachedUser(userId, userData);
      }
      const finalVideos = videosData?.documents?.length ? videosData.documents : cachedVideos;
      setVideos(finalVideos);
      // Persist the freshly-fetched list so the next cold-start open of
      // this creator paints videos immediately instead of after the
      // network round-trip.
      if (finalVideos?.length) writeCachedCreatorVideos(userId, finalVideos);
    } catch (error) {
      console.log("fetchUserAndVideos: error", error);
      if (!videos.length) {
        setVideos(cachedVideos);
      }
    } finally {
      setLoading(false);
      setIsRefreshing(false);
      hasLoadedOnce.current = true;
    }
  }, [hydrateCachedVideos, user, userId, videos.length, videosService]);

  useFocusEffect(
    useCallback(() => {
      // Freshness gate — if we have a cached user younger than the
      // refresh TTL (60s), skip the network refetch entirely. This
      // is the main fix for "everytime I go to profile it gives a
      // loading vibes": back-to-back opens within a minute now reuse
      // the in-memory + MMKV cache without ANY network call.
      // First-time-this-session opens still fetch fresh.
      const cacheAge = readCachedUserAge(userId);
      if (cacheAge < CREATOR_PROFILE_REFRESH_TTL_MS && hasLoadedOnce.current) {
        // Cache is fresh AND we've already painted once in this mount
        // — nothing to do. The on-mount paint already used the cache.
      } else if (cacheAge < CREATOR_PROFILE_REFRESH_TTL_MS) {
        // Cache is fresh but this is the first focus of the mount.
        // Just hydrate from the cache and skip the network.
        hasLoadedOnce.current = true;
        setLoading(false);
      } else {
        fetchUserAndVideos();
      }

      // Run the blocked-user check non-blocking. Previously this was awaited
      // inline alongside the user fetch, which delayed first paint by a full
      // round trip even though the result only affects an edge-case overlay.
      // Now the profile renders immediately and the block check resolves in
      // the background.
      if (viewer?.$id && userId) {
        listBlockedUsers({ blockerId: viewer.$id })
          .then((blocked) => setIsBlocked(blocked.includes(userId)))
          .catch(() => setIsBlocked(false));
      }
    }, [fetchUserAndVideos, userId, viewer?.$id]),
  );

  return (
    <StyledSafeAreaView>
      <View className="h-full w-full px-4 pb-5">
        <View className="align-start h-[50px] flex-row items-center justify-between">
          <TouchableOpacity
            activeOpacity={0.7}
            className="h-10 w-10 items-center justify-center rounded-full"
            style={{ backgroundColor: theme.surfaceMuted }}
            onPress={() => {
              router.back();
            }}
          >
            <MaterialIcons name="arrow-back" size={24} color={theme.icon} />
          </TouchableOpacity>
          <View className="flex-row items-center space-x-2">
            <StyledTitle className="py-0" icon={<MaterialIcons name="person" size={24} color={theme.icon} />} title={"Creator Profile"} />
          </View>
          <TouchableOpacity disabled style={{ opacity: 0 }} activeOpacity={0.7} onPress={() => router.push("/edit-profile")}>
            <Feather name="settings" size={22} color={theme.icon} />
          </TouchableOpacity>
        </View>
        {isBlocked ? (
          <View className="mt-10 items-center">
            <MaterialIcons name="block" size={56} color="#ef4444" />
            <View className="mt-3 items-center">
              <StyledTitle className="py-0" title="You blocked this user" />
              <TouchableOpacity
                className="mt-3 rounded-full px-4 py-2"
                style={{ backgroundColor: theme.surfaceMuted }}
                onPress={async () => {
                  try {
                    await unblockUser({ blockerId: viewer.$id, blockedUserId: userId });
                    setIsBlocked(false);
                    fetchUserAndVideos();
                  } catch (err) {
                    console.log("unblock error", err);
                  }
                }}
              >
                <Text className="text-base font-semibold" style={{ color: theme.text }}>
                  Unblock
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <Profile user={user} videos={videos} isLoadingProfile={loading || !user} />
        )}
      </View>
    </StyledSafeAreaView>
  );
};

export default CreatorProfile;
