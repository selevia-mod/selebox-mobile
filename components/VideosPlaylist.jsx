// Videos > Playlist sub-tab — YouTube-style.
//
// Layout:
//   1. Hero card — large 16:9 thumbnail of the most-recent video, dark overlay
//      with playlist name, video count, total runtime, and a violet "Play all"
//      pill that jumps into the first video.
//   2. Numbered list of compact rows — each row mirrors YouTube mobile's
//      playlist row (index, 16:9 thumb with duration badge, title, uploader,
//      views, 3-dot menu).
//
// UX features wired here:
//   - Toggle-label fix: each row's StyledPlaylistButton is told `inPlaylist`
//     up-front so the menu opens with the correct label, no async race.
//   - Optimistic remove + undo snackbar: tapping Remove hides the row instantly
//     and shows a 5-second undo snackbar. The actual addToPlaylist (toggle)
//     network call only fires when the timer expires; Undo cancels everything
//     before the DB ever sees it.
//   - Auto-advance: tapping a row navigates to video-player with playlist
//     context (URIs + index) so the player can queue the next video on end.

import { Entypo, MaterialCommunityIcons, MaterialIcons } from "@expo/vector-icons";
import { FlashList } from "@shopify/flash-list";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Animated, RefreshControl, Text, TouchableOpacity, View, useWindowDimensions } from "react-native";
import FastImage from "react-native-fast-image";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import { addToPlaylist, filterVideosByVideoIds, getPlaylist } from "../lib/appwrite";
import FormatNumber from "../lib/utils/format-number";
import { formatDurationCompact, formatRuntimeTotal, getVideoDurationSeconds } from "../lib/utils/video-duration";
import StyledPlaylistButton from "./StyledPlaylistButton";

const PLAYLIST_TITLE = "My playlist";
const UNDO_WINDOW_MS = 5000;

const VideosPlaylist = () => {
  const { theme } = useAppTheme();
  const { user, allVideos, globalSettings } = useGlobalContext();
  const { width } = useWindowDimensions();

  const [playlistVideos, setPlaylistVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // videoId -> seconds. Populated lazily as durations resolve from cache or
  // from the HLS manifest. Each row reads its number from here; the hero
  // sums what's available so totalRuntime grows live as values arrive.
  const [durationsByVideoId, setDurationsByVideoId] = useState({});

  // Optimistic-remove state. Once a videoId is here, the row is hidden but the
  // network mutation hasn't fired yet — Undo just clears the entry and the row
  // reappears, no DB touched.
  const [pendingRemovalId, setPendingRemovalId] = useState(null);
  const pendingRemovalTimerRef = useRef(null);
  const snackbarOpacity = useRef(new Animated.Value(0)).current;
  const snackbarTranslateY = useRef(new Animated.Value(40)).current;

  const hasLoadedOnce = useMemo(() => playlistVideos.length > 0, [playlistVideos.length]);

  const loadPlaylist = useCallback(
    async ({ silent = false } = {}) => {
      if (!user?.$id) {
        setPlaylistVideos([]);
        setLoading(false);
        return;
      }
      if (!silent) setLoading(true);
      try {
        const videoIds = await getPlaylist(user.$id);
        if (!Array.isArray(videoIds) || videoIds.length === 0) {
          setPlaylistVideos([]);
          return;
        }
        const matched = filterVideosByVideoIds(allVideos || [], videoIds);
        setPlaylistVideos(matched);
      } catch (error) {
        console.log("VideosPlaylist load error:", error?.message || error);
      } finally {
        setLoading(false);
      }
    },
    [allVideos, user?.$id],
  );

  useFocusEffect(
    useCallback(() => {
      void loadPlaylist({ silent: hasLoadedOnce });
    }, [hasLoadedOnce, loadPlaylist]),
  );

  // Lazy duration loader. Walks the current playlist and resolves any video
  // whose duration hasn't landed in `durationsByVideoId` yet. The util's TTL
  // cache and in-flight dedupe keep this safe to call repeatedly — we won't
  // re-fetch a manifest we've already parsed this session.
  useEffect(() => {
    let isCancelled = false;
    const missing = playlistVideos.filter((v) => v?.$id && !(v.$id in durationsByVideoId));
    if (missing.length === 0) return undefined;

    // Fan out in parallel — the util caps duplicate fetches via INFLIGHT_FETCHES,
    // so even bursts of mounts hit the network at most once per video.
    const tasks = missing.map(async (video) => {
      try {
        const seconds = await getVideoDurationSeconds(video);
        if (isCancelled) return null;
        return [video.$id, seconds];
      } catch (error) {
        return [video.$id, null];
      }
    });

    Promise.all(tasks).then((entries) => {
      if (isCancelled) return;
      const updates = entries.filter(Boolean);
      if (updates.length === 0) return;
      setDurationsByVideoId((prev) => {
        const next = { ...prev };
        for (const [id, seconds] of updates) next[id] = seconds;
        return next;
      });
    });

    return () => {
      isCancelled = true;
    };
  }, [durationsByVideoId, playlistVideos]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadPlaylist({ silent: true });
    } finally {
      setRefreshing(false);
    }
  }, [loadPlaylist]);

  // Hide the row instantly while keeping the data in memory so Undo can
  // restore without re-fetching. Undo cancels the pending network call;
  // expiry runs it.
  const hideSnackbar = useCallback(() => {
    Animated.parallel([
      Animated.timing(snackbarOpacity, { toValue: 0, duration: 180, useNativeDriver: true }),
      Animated.timing(snackbarTranslateY, { toValue: 40, duration: 180, useNativeDriver: true }),
    ]).start();
  }, [snackbarOpacity, snackbarTranslateY]);

  const showSnackbar = useCallback(() => {
    Animated.parallel([
      Animated.timing(snackbarOpacity, { toValue: 1, duration: 200, useNativeDriver: true }),
      Animated.timing(snackbarTranslateY, { toValue: 0, duration: 240, useNativeDriver: true }),
    ]).start();
  }, [snackbarOpacity, snackbarTranslateY]);

  const handleRequestRemove = useCallback(
    (videoIdToRemove) => {
      if (!videoIdToRemove || !user?.$id) return;

      // Cancel any in-flight pending removal before starting a new one (rare
      // but cleaner — last-tap-wins).
      if (pendingRemovalTimerRef.current) clearTimeout(pendingRemovalTimerRef.current);

      setPendingRemovalId(videoIdToRemove);
      showSnackbar();

      pendingRemovalTimerRef.current = setTimeout(async () => {
        try {
          // addToPlaylist is a toggle — calling it on a video already in the
          // playlist removes it. This is the actual DB write.
          await addToPlaylist(videoIdToRemove, user.$id);
          // Drop the video from the local list so it doesn't pop back when the
          // pending state clears.
          setPlaylistVideos((prev) => prev.filter((v) => v?.$id !== videoIdToRemove));
        } catch (error) {
          console.log("VideosPlaylist remove error:", error?.message || error);
        } finally {
          pendingRemovalTimerRef.current = null;
          setPendingRemovalId(null);
          hideSnackbar();
        }
      }, UNDO_WINDOW_MS);
    },
    [hideSnackbar, showSnackbar, user?.$id],
  );

  const handleUndoRemove = useCallback(() => {
    if (pendingRemovalTimerRef.current) clearTimeout(pendingRemovalTimerRef.current);
    pendingRemovalTimerRef.current = null;
    setPendingRemovalId(null);
    hideSnackbar();
  }, [hideSnackbar]);

  // Filter out the row that's pending removal so it disappears instantly. If
  // Undo lands, the row comes back without any re-fetch.
  const visibleVideos = useMemo(
    () => (pendingRemovalId ? playlistVideos.filter((v) => v?.$id !== pendingRemovalId) : playlistVideos),
    [pendingRemovalId, playlistVideos],
  );

  // Total runtime — sums every resolved duration. Updates live as the lazy
  // loader fills `durationsByVideoId`. Hidden until at least one duration has
  // landed, so the hero doesn't briefly show "0m".
  const totalRuntimeLabel = useMemo(() => {
    const totalSeconds = playlistVideos.reduce((acc, v) => {
      const sec = v?.$id ? durationsByVideoId[v.$id] : null;
      return acc + (Number.isFinite(sec) && sec > 0 ? sec : 0);
    }, 0);
    return formatRuntimeTotal(totalSeconds);
  }, [durationsByVideoId, playlistVideos]);

  // Pass the playlist's URI list to the player so it can queue the next item
  // on end. Comma-joined to keep router params terse.
  const handleOpenVideo = useCallback(
    (video) => {
      if (!video?.uri) return;
      const playlistUris = visibleVideos.map((v) => v?.uri).filter(Boolean).join(",");
      const playlistIndex = visibleVideos.findIndex((v) => v?.uri === video.uri);
      router.push({
        pathname: "video-player",
        params: {
          id: video.uri,
          docId: video.$id,
          view: "PLAYLIST",
          playlistUris,
          playlistIndex: String(playlistIndex >= 0 ? playlistIndex : 0),
        },
      });
    },
    [visibleVideos],
  );

  const handlePlayAll = useCallback(() => {
    const first = visibleVideos[0];
    if (first) handleOpenVideo(first);
  }, [handleOpenVideo, visibleVideos]);

  const ROW_THUMB_WIDTH = 116;
  const ROW_THUMB_HEIGHT = Math.round(ROW_THUMB_WIDTH * 9 / 16);

  const renderItem = useCallback(
    ({ item, index }) => {
      const viewsValue = (item?.videoStats?.totalViews || 0) * (Number(globalSettings?.["VIEWS_MULTIPLIER"]) || 1);
      const durationLabel = formatDurationCompact(item?.$id ? durationsByVideoId[item.$id] : null);

      return (
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={() => handleOpenVideo(item)}
          className="flex-row items-center px-3 py-2"
          style={{ borderBottomWidth: 1, borderBottomColor: theme.divider }}
        >
          <View style={{ width: 24, alignItems: "center" }}>
            <Text className="text-xs" style={{ color: theme.textSubtle, fontWeight: "600" }}>
              {index + 1}
            </Text>
          </View>

          {/* Thumbnail with duration badge bottom-right */}
          <View
            style={{
              width: ROW_THUMB_WIDTH,
              height: ROW_THUMB_HEIGHT,
              borderRadius: 8,
              overflow: "hidden",
              backgroundColor: theme.surfaceMuted,
              marginLeft: 8,
            }}
          >
            {item?.thumbnail ? (
              <FastImage
                source={{ uri: item.thumbnail, priority: FastImage.priority.normal }}
                style={{ width: "100%", height: "100%" }}
                resizeMode={FastImage.resizeMode.cover}
              />
            ) : (
              <View className="flex-1 items-center justify-center">
                <MaterialIcons name="movie" size={24} color={theme.iconMuted} />
              </View>
            )}
            {durationLabel ? (
              <View
                style={{
                  position: "absolute",
                  bottom: 4,
                  right: 4,
                  paddingHorizontal: 5,
                  paddingVertical: 1,
                  borderRadius: 4,
                  backgroundColor: "rgba(0,0,0,0.78)",
                }}
              >
                <Text style={{ color: "#ffffff", fontSize: 10, fontWeight: "600", letterSpacing: 0.2 }}>
                  {durationLabel}
                </Text>
              </View>
            ) : null}
          </View>

          <View className="ml-3 flex-1">
            <Text className="text-[13px] font-bold" style={{ color: theme.text, lineHeight: 18 }} numberOfLines={2}>
              {item?.title || "Untitled"}
            </Text>
            <Text className="mt-1 text-[11px]" style={{ color: theme.textSoft }} numberOfLines={1}>
              {item?.uploader?.username || "Unknown"}
            </Text>
            <Text className="mt-0.5 text-[10px]" style={{ color: theme.textSubtle }} numberOfLines={1}>
              {FormatNumber(viewsValue)} views
            </Text>
          </View>

          {/* 3-dot menu — `inPlaylist` short-circuits the async check so the
              menu opens correctly labeled. `onRequestRemove` routes the Remove
              tap through the optimistic flow above instead of firing an
              immediate addToPlaylist mutation. */}
          <View style={{ marginLeft: 4 }}>
            <StyledPlaylistButton
              videoId={item?.$id}
              inPlaylist
              onRequestRemove={handleRequestRemove}
              refetchFunction={() => loadPlaylist({ silent: true })}
            />
          </View>
        </TouchableOpacity>
      );
    },
    [
      durationsByVideoId,
      globalSettings,
      handleOpenVideo,
      handleRequestRemove,
      loadPlaylist,
      theme.divider,
      theme.iconMuted,
      theme.surfaceMuted,
      theme.text,
      theme.textSoft,
      theme.textSubtle,
    ],
  );

  const keyExtractor = useCallback((item, index) => item?.$id || item?.uri || `playlist-${index}`, []);

  const heroVideo = visibleVideos[0];
  const heroHeight = Math.round((width - 32) * 9 / 16);

  const renderHeader = useCallback(() => {
    if (!heroVideo) return null;
    return (
      <View className="px-4 pt-3 pb-3">
        <View
          className="overflow-hidden rounded-2xl"
          style={{
            height: heroHeight,
            backgroundColor: theme.surfaceStrong,
            shadowColor: theme.primary,
            shadowOffset: { width: 0, height: 6 },
            shadowOpacity: 0.18,
            shadowRadius: 14,
            elevation: 4,
          }}
        >
          {heroVideo.thumbnail ? (
            <FastImage
              source={{ uri: heroVideo.thumbnail, priority: FastImage.priority.high }}
              style={{ width: "100%", height: "100%" }}
              resizeMode={FastImage.resizeMode.cover}
            />
          ) : null}
          <View className="absolute inset-0" style={{ backgroundColor: "rgba(15,15,15,0.55)" }} />
          <View className="absolute left-4 top-4 flex-row items-center rounded-full px-2.5 py-1" style={{ backgroundColor: "rgba(0,0,0,0.45)" }}>
            <MaterialCommunityIcons name="playlist-play" size={14} color="#ffffff" />
            <Text className="ml-1.5 text-[11px] font-semibold" style={{ color: "#ffffff", letterSpacing: 0.3 }}>
              PLAYLIST
            </Text>
          </View>
          <View className="absolute inset-x-0 bottom-0 px-4 pb-4">
            <Text className="text-xl font-bold" style={{ color: "#ffffff", letterSpacing: 0.2 }} numberOfLines={1}>
              {PLAYLIST_TITLE}
            </Text>
            <Text className="mt-0.5 text-[12px]" style={{ color: "rgba(255,255,255,0.85)" }}>
              {visibleVideos.length} {visibleVideos.length === 1 ? "video" : "videos"}
              {totalRuntimeLabel ? ` • ${totalRuntimeLabel}` : ""}
            </Text>
            <View className="mt-3 flex-row items-center">
              <TouchableOpacity
                onPress={handlePlayAll}
                activeOpacity={0.85}
                className="flex-row items-center rounded-full px-4 py-2"
                style={{
                  backgroundColor: theme.primary,
                  shadowColor: theme.primary,
                  shadowOffset: { width: 0, height: 4 },
                  shadowOpacity: 0.35,
                  shadowRadius: 8,
                  elevation: 4,
                }}
              >
                <MaterialIcons name="play-arrow" size={18} color={theme.primaryContrast} style={{ marginRight: 4 }} />
                <Text className="text-sm font-bold" style={{ color: theme.primaryContrast, letterSpacing: 0.2 }}>
                  Play all
                </Text>
              </TouchableOpacity>
              <View
                className="ml-2 h-9 w-9 items-center justify-center rounded-full"
                style={{ backgroundColor: "rgba(255,255,255,0.15)", borderWidth: 1, borderColor: "rgba(255,255,255,0.18)" }}
              >
                <Entypo name="dots-three-horizontal" size={16} color="#ffffff" />
              </View>
            </View>
          </View>
        </View>
      </View>
    );
  }, [handlePlayAll, heroHeight, heroVideo, theme.primary, theme.primaryContrast, theme.surfaceStrong, totalRuntimeLabel, visibleVideos.length]);

  if (loading && playlistVideos.length === 0) {
    return (
      <View className="flex-1 items-center justify-center py-12">
        <ActivityIndicator size="small" color={theme.primary} />
      </View>
    );
  }

  return (
    <View className="flex-1">
      <FlashList
        data={visibleVideos}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        estimatedItemSize={ROW_THUMB_HEIGHT + 24}
        ListHeaderComponent={renderHeader}
        contentContainerStyle={{ paddingBottom: 80 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            tintColor={theme.primary}
            titleColor={theme.primary}
            progressBackgroundColor={theme.surface}
            refreshing={refreshing}
            onRefresh={onRefresh}
          />
        }
        ListEmptyComponent={
          <View className="items-center justify-center px-8 py-16">
            <View className="h-16 w-16 items-center justify-center rounded-full" style={{ backgroundColor: theme.primarySoft }}>
              <MaterialCommunityIcons name="playlist-plus" size={28} color={theme.primary} />
            </View>
            <Text className="mt-4 text-lg font-bold" style={{ color: theme.text, letterSpacing: 0.2 }}>
              Your playlist is empty
            </Text>
            <Text className="mt-2 text-center text-sm" style={{ color: theme.textSoft, maxWidth: 280 }}>
              Tap the three dots on any video and choose <Text style={{ color: theme.text, fontWeight: "600" }}>Add to playlist</Text> to save it here.
            </Text>
          </View>
        }
      />

      {/* Undo snackbar — sits above the bottom nav, fades + slides in/out. Only
          visible while a removal is pending. Tapping Undo cancels the timer
          before the network call ever fires. */}
      <Animated.View
        pointerEvents={pendingRemovalId ? "auto" : "none"}
        style={{
          position: "absolute",
          left: 16,
          right: 16,
          bottom: 24,
          opacity: snackbarOpacity,
          transform: [{ translateY: snackbarTranslateY }],
        }}
      >
        <View
          className="flex-row items-center justify-between rounded-2xl px-4 py-3"
          style={{
            backgroundColor: theme.surfaceElevated,
            borderWidth: 1,
            borderColor: theme.border,
            shadowColor: theme.overlayStrong,
            shadowOffset: { width: 0, height: 6 },
            shadowOpacity: 0.25,
            shadowRadius: 14,
            elevation: 8,
          }}
        >
          <View className="flex-row items-center" style={{ flex: 1 }}>
            <MaterialIcons name="check-circle" size={18} color={theme.primary} style={{ marginRight: 8 }} />
            <Text className="text-sm font-semibold" style={{ color: theme.text }}>
              Removed from playlist
            </Text>
          </View>
          <TouchableOpacity onPress={handleUndoRemove} activeOpacity={0.85} className="ml-3 rounded-full px-3 py-1.5" style={{ backgroundColor: theme.primarySoft }}>
            <Text className="text-sm font-bold" style={{ color: theme.primary, letterSpacing: 0.2 }}>
              Undo
            </Text>
          </TouchableOpacity>
        </View>
      </Animated.View>
    </View>
  );
};

export default VideosPlaylist;
