import { Feather, MaterialIcons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TouchableOpacity, View } from "react-native";
import { MMKV } from "react-native-mmkv";
import { Profile as ProfileComponent, StyledSafeAreaView, StyledTitle } from "../../components";
import { useGlobalContext } from "../../context/global-provider";
import useAppTheme from "../../hooks/useAppTheme";
import { VideosService } from "../../lib/video";

// Persist the user's own video list to MMKV so the My Profile screen
// paints videos immediately on every visit instead of always showing
// the loading state. Same pattern as creator-profile.jsx — keeps the
// "loading vibes" the user complained about reserved for genuinely
// first-time-this-account opens.
const OWN_PROFILE_TTL_MS = 5 * 60 * 1000;
const OWN_PROFILE_REFRESH_TTL_MS = 60 * 1000;
const profileStorage = new MMKV({ id: "selebox-profile-cache" });

const readCachedOwnVideos = (userId) => {
  if (!userId) return null;
  try {
    const blob = profileStorage.getString(`own-videos:${userId}`);
    if (!blob) return null;
    const parsed = JSON.parse(blob);
    if (!parsed || !Array.isArray(parsed.videos)) return null;
    if (Date.now() - parsed.cachedAt > OWN_PROFILE_TTL_MS) {
      profileStorage.delete(`own-videos:${userId}`);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const writeCachedOwnVideos = (userId, videos) => {
  if (!userId || !Array.isArray(videos)) return;
  try {
    profileStorage.set(`own-videos:${userId}`, JSON.stringify({ videos, cachedAt: Date.now() }));
  } catch {
    /* best-effort; storage full / OS revoking access shouldn't crash the screen */
  }
};

const Profile = () => {
  const { user, allVideos } = useGlobalContext();
  const { theme } = useAppTheme();
  // Pre-hydrate from feed cache OR persisted MMKV — whichever has data.
  // The feed cache (allVideos) is usually fresher; MMKV is the cold-start
  // safety net. Only the videos for THIS user are pulled in either case.
  const initialVideos = useMemo(() => {
    if (!user?.$id) return [];
    if (allVideos?.length) {
      const fromFeed = allVideos.filter((v) => v?.uploader === user.$id || v?.uploader?.uid === user.$id);
      if (fromFeed.length) return fromFeed;
    }
    const persisted = readCachedOwnVideos(user.$id);
    return persisted?.videos || [];
  }, [allVideos, user?.$id]);
  const [videos, setVideos] = useState(initialVideos);
  // Only show the loading state when there's truly nothing to paint.
  // With MMKV persistence this should be rare — limited to first-account-open
  // or first-after-app-data-clear cases. Eliminates the "loading vibes"
  // on every return-to-tab.
  const [loading, setLoading] = useState(!initialVideos.length);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const videosService = useRef(new VideosService()).current;
  const hasLoadedOnce = useRef(false);

  const hydrateCachedVideos = useCallback(() => {
    if (!user?.$id || !allVideos?.length) return [];
    const cachedVideos = allVideos.filter((video) => video?.uploader === user.$id || video?.uploader?.uid === user.$id);
    if (cachedVideos.length) {
      setVideos(cachedVideos);
    }
    return cachedVideos;
  }, [allVideos, user?.$id]);

  const fetchUserVideos = useCallback(async () => {
    if (!user?.$id) {
      setLoading(false);
      return;
    }
    const cachedVideos = hydrateCachedVideos();
    if (!hasLoadedOnce.current) setLoading(!cachedVideos.length && !initialVideos.length);
    setIsRefreshing(true);

    try {
      // limit:24 (was 100) — on slow / spotty networks a 100-row video
      // payload could take long enough to hit the default 60s fetch
      // timeout, leaving the profile spinning. 24 fits two screens of
      // grid cells on typical phones and is plenty for first paint.
      // Older videos are paged in via ProfileVideosTab's onEndReached.
      const videosData = await videosService.fetchVideos({ userId: user?.$id, limit: 24, status: "published" });
      setVideos(videosData.documents);
      // Persist for cold-start hydration on the next app launch.
      writeCachedOwnVideos(user.$id, videosData.documents);
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
  }, [hydrateCachedVideos, initialVideos.length, user?.$id, videos.length, videosService]);

  useEffect(() => {
    hydrateCachedVideos();
  }, [hydrateCachedVideos]);

  useFocusEffect(
    useCallback(() => {
      // Freshness gate — if the persisted videos list is younger than
      // OWN_PROFILE_REFRESH_TTL_MS (60s), skip the fetch. Back-and-forth
      // tapping into My Profile within a minute now reuses the cache
      // without ANY network call, eliminating the loading flash.
      const persisted = readCachedOwnVideos(user?.$id);
      const cacheAge = persisted?.cachedAt ? Date.now() - persisted.cachedAt : Infinity;
      if (cacheAge < OWN_PROFILE_REFRESH_TTL_MS && hasLoadedOnce.current) return;
      if (cacheAge < OWN_PROFILE_REFRESH_TTL_MS && persisted?.videos?.length) {
        setVideos(persisted.videos);
        setLoading(false);
        hasLoadedOnce.current = true;
        return;
      }
      fetchUserVideos();
    }, [fetchUserVideos, user?.$id]),
  );

  return (
    <StyledSafeAreaView>
      <View className="h-full w-full">
        <View className="flex-row items-center justify-between px-4 pb-2 pt-2">
          <TouchableOpacity
            activeOpacity={0.7}
            className="h-10 w-10 items-center justify-center rounded-full"
            style={{ backgroundColor: theme.surfaceMuted }}
            onPress={() => {
              router.back();
            }}
          >
            <MaterialIcons name="arrow-back" size={22} color={theme.icon} />
          </TouchableOpacity>
          <View className="flex-row items-center space-x-2">
            <StyledTitle className="py-0" icon={<MaterialIcons name="person" size={22} color={theme.icon} />} title={"My Profile"} />
          </View>
          <TouchableOpacity
            activeOpacity={0.7}
            className="h-10 w-10 items-center justify-center rounded-full"
            style={{ backgroundColor: theme.surfaceMuted }}
            onPress={() => router.push("/edit-profile")}
          >
            <Feather name="settings" size={20} color={theme.icon} />
          </TouchableOpacity>
        </View>
        <View className="flex-1 px-4 pb-5">
          <ProfileComponent user={user} videos={videos} isLoadingProfile={loading || !user} />
        </View>
      </View>
    </StyledSafeAreaView>
  );
};

export default Profile;
