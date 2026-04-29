// components/PostVideo.js
import { Entypo, MaterialIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useVideoPlayer, VideoView } from "expo-video";
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { AppState, Pressable, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import LoaderKit from "react-native-loader-kit";
import { useGlobalContext } from "../context/global-provider";
import { useVideosStats } from "../context/video-stats-provider";
import useAppTheme from "../hooks/useAppTheme";
import useIsOffline from "../hooks/useIsOffline";
import TimeAgo from "../lib/time-ago";
import { VideosService } from "../lib/video";
import AnimatedSkeleton from "./AnimatedSkeleton";
import StyledLikeCommentShare from "./StyledLikeCommentShare";
import UserRoleBadgeIcons from "./UserRoleBadgeIcons";
import VideoCommentModal from "./VideoCommentModal";

const feedVideoPlaybackCoordinator = {
  ownerId: null,
  forcePause: null,
};

const PostVideo = forwardRef(({ item, isPostFromVideo, onOpenSafetySheet, mutedPreference = true, onMutedChange, videoNavId, videoDocId }, ref) => {
  const { user, globalSettings } = useGlobalContext();
  const { theme } = useAppTheme();
  const isOffline = useIsOffline();
  const { updateVideoStats } = useVideosStats();
  const AUTO_PAUSE_SECONDS = Number(globalSettings["FEED_AUTO_PAUSE_VIDEO_TIMER"] || 60);

  const [video, setVideo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [videoLoading, setVideoLoading] = useState(true);
  const [error, setError] = useState(false);
  const [isPausedByTimer, setIsPausedByTimer] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [isEnded, setIsEnded] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(mutedPreference);
  const [isCommentModalVisible, setCommentModalVisible] = useState(false);
  const [showIndicator, setShowIndicator] = useState(false);
  const [indicatorIcon, setIndicatorIcon] = useState("play-arrow");
  const [isManuallyPaused, setIsManuallyPaused] = useState(false);

  const videoService = new VideosService();
  const playerRef = useRef(null);
  const videoViewRef = useRef(null);
  const timerRef = useRef(null);
  const shouldPlayRef = useRef(false);
  const indicatorTimeoutRef = useRef(null);
  const manualPausedRef = useRef(false);
  const pausedAtRef = useRef(0);
  const mutedPreferenceRef = useRef(mutedPreference);
  const isFocusedRef = useRef(false);
  const playbackOwnerIdRef = useRef(Symbol("post-video-owner"));
  const isPlayingRef = useRef(false);
  const isPausedByTimerRef = useRef(false);
  const appStateRef = useRef(AppState.currentState);
  const resumeOnActiveRef = useRef(false);
  const wasFocusedRef = useRef(false);
  const mutedBeforeBackgroundRef = useRef(null);

  const isLoggedInUser = user?.$id === video?.uploader?.$id;

  const forcePauseSelf = useCallback(() => {
    shouldPlayRef.current = false;
    isFocusedRef.current = false;
    try {
      playerRef.current?.pause?.();
    } catch (_) {}
  }, []);

  const claimPlaybackOwnership = useCallback(() => {
    const thisOwnerId = playbackOwnerIdRef.current;
    const previousOwnerId = feedVideoPlaybackCoordinator.ownerId;

    if (previousOwnerId && previousOwnerId !== thisOwnerId) {
      try {
        feedVideoPlaybackCoordinator.forcePause?.();
      } catch (_) {}
    }

    feedVideoPlaybackCoordinator.ownerId = thisOwnerId;
    feedVideoPlaybackCoordinator.forcePause = forcePauseSelf;
  }, [forcePauseSelf]);

  const releasePlaybackOwnership = useCallback(() => {
    if (feedVideoPlaybackCoordinator.ownerId !== playbackOwnerIdRef.current) return;
    feedVideoPlaybackCoordinator.ownerId = null;
    feedVideoPlaybackCoordinator.forcePause = null;
  }, []);

  /** SAFE PLAY FUNCTION (fixes .catch bugs) */
  const safePlay = useCallback(() => {
    try {
      if (manualPausedRef.current) return;
      claimPlaybackOwnership();
      const r = playerRef.current?.play?.();
      if (r?.catch) r.catch(() => {});
    } catch (_) {}
  }, [claimPlaybackOwnership]);

  /** SAFE PAUSE */
  const safePause = useCallback(() => {
    try {
      forcePauseSelf();
      isPlayingRef.current = false;
      setIsPlaying(false);
      releasePlaybackOwnership();
    } catch (_) {}
  }, [forcePauseSelf, releasePlaybackOwnership]);

  const applyMuted = useCallback((muted) => {
    setIsMuted(muted);
    if (playerRef.current) playerRef.current.muted = muted;
  }, []);

  const toggleMuted = useCallback(
    (event) => {
      event?.stopPropagation?.();
      const next = !isMuted;
      setIsMuted(next);
      if (playerRef.current) playerRef.current.muted = next;
      onMutedChange?.(next);
    },
    [isMuted, onMutedChange],
  );

  /** LOAD VIDEO */
  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(false);

      try {
        setVideoLoading(true);
        setIsPausedByTimer(false);
        setIsEnded(false);
        setIsPlaying(false);
        isPlayingRef.current = false;
        setElapsed(0);
        setIsManuallyPaused(false);
        setShowIndicator(false);
        manualPausedRef.current = false;
        pausedAtRef.current = 0;
        shouldPlayRef.current = false;
        isFocusedRef.current = false;
        setVideo(item);
        applyMuted(mutedPreferenceRef.current);
      } catch (e) {
        setError(true);
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [item, applyMuted]);

  useEffect(() => {
    mutedPreferenceRef.current = mutedPreference;
    applyMuted(mutedPreference);
  }, [mutedPreference, applyMuted]);

  useEffect(() => {
    manualPausedRef.current = isManuallyPaused;
  }, [isManuallyPaused]);

  useEffect(() => {
    isPausedByTimerRef.current = isPausedByTimer;
  }, [isPausedByTimer]);

  /** PAUSE WHEN APP GOES BACKGROUND */
  useEffect(() => {
    const sub = AppState.addEventListener("change", (nextState) => {
      appStateRef.current = nextState;

      if (nextState === "active") {
        if (mutedBeforeBackgroundRef.current !== null) {
          try {
            if (playerRef.current) playerRef.current.muted = mutedBeforeBackgroundRef.current;
          } catch (_) {}
          mutedBeforeBackgroundRef.current = null;
        } else if (playerRef.current) {
          playerRef.current.muted = isMuted;
        }
        if (!resumeOnActiveRef.current) return;
        resumeOnActiveRef.current = false;
        if (!wasFocusedRef.current) return;
        if (isPausedByTimer || isEnded || manualPausedRef.current) return;
        isFocusedRef.current = true;
        shouldPlayRef.current = true;
        safePlay();
        return;
      }

      if (mutedBeforeBackgroundRef.current === null) {
        mutedBeforeBackgroundRef.current = isMuted;
      }
      try {
        if (playerRef.current) playerRef.current.muted = true;
      } catch (_) {}
      resumeOnActiveRef.current = Boolean(playerRef.current?.playing || shouldPlayRef.current);
      wasFocusedRef.current = isFocusedRef.current;
      safePause();
    });

    return () => sub.remove();
  }, [isMuted, isPausedByTimer, isEnded, safePause, safePlay]);

  /** SETUP PLAYER */
  const setupPlayer = useCallback((player) => {
    player.loop = false;
    player.timeUpdateEventInterval = 0.1;
    player.showNowPlayingNotification = false;
    player.staysActiveInBackground = false;
    player.startsPictureInPictureAutomatically = false;
    player.allowsExternalPlayback = false;
    player.automaticallyWaitsToMinimizeStalling = false;
    player.preventsDisplaySleepDuringVideoPlayback = false;
    player.allowsScrubbing = false;
    player.allowsControl = false;
    player.usesExternalPlayback = false;
    player.muted = mutedPreferenceRef.current;

    player.addListener("playToEnd", () => {
      setIsEnded(true);
      setIsPlaying(false);
      isPlayingRef.current = false;
      clearInterval(timerRef.current);
    });

    playerRef.current = player;
  }, []);

  const player = useVideoPlayer(
    video
      ? {
          uri: video.videoUrl,
          metadata: {
            title: video.title,
            artist: video?.uploader?.username || video?.uploader?.name,
            artwork: video?.thumbnail || video?.uploader?.avatar,
          },
        }
      : null,
    setupPlayer,
  );

  // Listen for player readiness
  useEffect(() => {
    if (!player) return;

    const resolveStatus = (nextStatus) => {
      if (!nextStatus) return player.status;
      if (typeof nextStatus === "string") return nextStatus;
      if (typeof nextStatus?.status === "string") return nextStatus.status;
      return player.status;
    };

    const handleStatus = (nextStatus) => {
      const status = resolveStatus(nextStatus);

      if (status === "readyToPlay") {
        setVideoLoading(false);

        if (shouldPlayRef.current && !isPausedByTimer) {
          safePlay();
        }
      }

      if (status === "error") {
        setError(true);
        setVideoLoading(false);
      }

      if (status === "loading" || status === "idle") {
        const currentlyPlaying = isPlayingRef.current || playerRef.current?.playing;
        if (!currentlyPlaying) setVideoLoading(true);
      }
    };

    handleStatus(player.status);

    const statusSub = player.addListener("statusChange", handleStatus);
    const playingSub = player.addListener("playingChange", ({ isPlaying: nextIsPlaying }) => {
      if (isPausedByTimerRef.current && nextIsPlaying) {
        isPlayingRef.current = false;
        setIsPlaying(false);
        try {
          playerRef.current?.pause?.();
        } catch (_) {}
        return;
      }
      isPlayingRef.current = nextIsPlaying;
      setIsPlaying(nextIsPlaying);
      if (nextIsPlaying) setVideoLoading(false);
    });
    const timeSub = player.addListener("timeUpdate", () => {
      if (isPlayingRef.current) return;
      const currentTime = Number(player.currentTime || 0);
      if (currentTime > 0) {
        isPlayingRef.current = true;
        setIsPlaying(true);
        setVideoLoading(false);
      }
    });

    return () => {
      statusSub.remove();
      playingSub.remove();
      timeSub.remove();
    };
  }, [player, safePlay, isPausedByTimer]);

  useEffect(() => {
    if (playerRef.current) playerRef.current.muted = isMuted;
  }, [player, isMuted]);

  // Ensure auto-pause actually stops playback.
  useEffect(() => {
    if (!isPausedByTimer) return;
    shouldPlayRef.current = false;
    isFocusedRef.current = false;
    try {
      playerRef.current?.pause?.();
    } catch (_) {}
    isPlayingRef.current = false;
    setIsPlaying(false);
    releasePlaybackOwnership();
  }, [isPausedByTimer, player, releasePlaybackOwnership]);

  // Fallback: clear loader if playback has started but events were missed.
  useEffect(() => {
    if (!videoLoading) return;
    let cancelled = false;
    const interval = setInterval(() => {
      if (cancelled) return;
      const currentPlayer = playerRef.current;
      if (!currentPlayer) return;
      const currentTime = Number(currentPlayer.currentTime || 0);
      if (currentPlayer.playing || currentTime > 0) {
        isPlayingRef.current = true;
        setIsPlaying(true);
        setVideoLoading(false);
        clearInterval(interval);
      }
    }, 200);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [videoLoading]);

  /** TIMER FOR AUTO PAUSE */
  useEffect(() => {
    if (!shouldPlayRef.current || isPausedByTimer) return;

    timerRef.current = setInterval(() => {
      setElapsed((t) => {
        if (t + 1 >= AUTO_PAUSE_SECONDS) {
          safePause();
          setIsPausedByTimer(true);
          clearInterval(timerRef.current);
        }
        return t + 1;
      });
    }, 1000);

    return () => clearInterval(timerRef.current);
  }, [shouldPlayRef.current]);

  /** FULL SCREEN VIDEO */
  const handleOpenVideo = (event) => {
    event?.stopPropagation?.();
    const currentTime = Number(playerRef.current?.currentTime || 0);
    const resumeFrom = Math.max(0, currentTime - 1);
    const targetId = video?.uri || videoNavId || video?.videoUrl;
    const targetDocId = videoDocId || (video?.uri || video?.videoUrl ? video?.$id : null);
    if (!targetId && !targetDocId) return;
    router.push({
      pathname: "video-player",
      params: { id: targetId || targetDocId, docId: targetDocId, view: "RECOMMENDED", startAt: String(resumeFrom) },
    });
  };

  const showPlaybackIndicator = useCallback((iconName) => {
    setIndicatorIcon(iconName);
    setShowIndicator(true);
    if (indicatorTimeoutRef.current) clearTimeout(indicatorTimeoutRef.current);
    indicatorTimeoutRef.current = setTimeout(() => {
      setShowIndicator(false);
    }, 0);
  }, []);

  const handleTogglePlayback = useCallback(() => {
    const canToggle = isFocusedRef.current || shouldPlayRef.current || playerRef.current?.playing || isManuallyPaused || isPausedByTimer || isEnded;

    if (!canToggle) return;

    const isPaused = isManuallyPaused || isPausedByTimer || isEnded;

    if (!isPaused) {
      pausedAtRef.current = Number(playerRef.current?.currentTime || 0);
      manualPausedRef.current = true;
      setIsManuallyPaused(true);
      shouldPlayRef.current = false;
      isPlayingRef.current = false;
      setIsPlaying(false);
      safePause();
      showPlaybackIndicator("pause");
      return;
    }

    manualPausedRef.current = false;
    setIsManuallyPaused(false);
    if (isPausedByTimer) setIsPausedByTimer(false);
    if (isEnded) {
      setIsEnded(false);
      try {
        playerRef.current?.replay?.();
      } catch {}
    }

    try {
      if (playerRef.current && pausedAtRef.current > 0) {
        playerRef.current.currentTime = pausedAtRef.current;
      }
    } catch {}
    shouldPlayRef.current = true;
    safePlay();
    showPlaybackIndicator("play-arrow");
  }, [isManuallyPaused, isPausedByTimer, isEnded, safePause, safePlay, showPlaybackIndicator]);

  /** PROFILE TAP */
  const handleProfile = () => {
    if (isOffline) return;
    if (isLoggedInUser) router.push("/profile");
    else
      router.push({
        pathname: "/creator-profile",
        params: { userId: video?.uploader?.$id },
      });
  };

  /** EXPOSE TO PARENT */
  useImperativeHandle(ref, () => ({
    pauseVideo: () => {
      isFocusedRef.current = false;
      shouldPlayRef.current = false;
      safePause();
    },
    resumeVideo: () => {
      isFocusedRef.current = true;
      if (isPausedByTimer || isEnded || manualPausedRef.current) return;

      shouldPlayRef.current = true;
      safePlay();
    },
    muteVideo: () => {
      applyMuted(true);
    },
    unmuteVideo: () => {
      applyMuted(false);
    },
  }));

  useEffect(
    () => () => {
      shouldPlayRef.current = false;
      clearInterval(timerRef.current);
      if (indicatorTimeoutRef.current) {
        clearTimeout(indicatorTimeoutRef.current);
        indicatorTimeoutRef.current = null;
      }
      safePause();
      releasePlaybackOwnership();
    },
    [releasePlaybackOwnership, safePause],
  );

  /** LOADING / ERROR UI */
  if (loading || !video) {
    return (
      <View className="mt-3 rounded-lg p-3" style={{ backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}>
        <AnimatedSkeleton className="h-[300px] w-full rounded-lg" />
        <AnimatedSkeleton className="mt-2 h-5 w-[60%] rounded" />
      </View>
    );
  }

  /** MAIN UI */
  return (
    <View className="mt-1.5 overflow-hidden rounded-lg" style={{ backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}>
      {/* HEADER */}
      <View className="flex flex-row items-center justify-between px-4 py-2">
        <View className="flex flex-row items-center">
          <TouchableOpacity onPress={handleProfile}>
            <FastImage
              source={{ uri: video.uploader?.avatar }}
              style={{ height: 35, width: 35, borderRadius: 5, marginRight: 10, backgroundColor: theme.surfaceStrong }}
            />
          </TouchableOpacity>

          <View>
            <TouchableOpacity onPress={handleProfile}>
              <View className="flex-row items-center">
                <Text className="text-base font-bold" style={{ color: theme.text }}>
                  {video.uploader?.username}
                </Text>
                <UserRoleBadgeIcons user={video.uploader} size={18} />
              </View>
            </TouchableOpacity>
            <Text className="text-xs" style={{ color: theme.textSoft }}>
              {isPostFromVideo ? TimeAgo(item.publishDate ?? item.$createdAt) : "Featured"}
            </Text>
          </View>
        </View>

        {!isLoggedInUser && (
          <TouchableOpacity onPress={onOpenSafetySheet} hitSlop={{ left: 15, bottom: 15, top: 10, right: 10 }}>
            <Entypo name="dots-three-horizontal" size={18} color={theme.iconMuted} />
          </TouchableOpacity>
        )}
      </View>

      {/* VIDEO AREA */}
      <View className="relative aspect-video w-full" style={{ backgroundColor: theme.mediaBackground }}>
        <VideoView
          ref={videoViewRef}
          player={player}
          allowsFullscreen={false}
          allowsPictureInPicture={false}
          nativeControls={false}
          requiresLinearPlayback={true}
          className="h-full w-full"
          pointerEvents="none"
        />

        <Pressable onPress={isPausedByTimer ? handleOpenVideo : handleTogglePlayback} style={StyleSheet.absoluteFill} android_disableSound />

        {videoLoading && !isPlaying && (
          <View
            className="absolute inset-0 h-full w-full items-center justify-center"
            style={{ backgroundColor: theme.mediaOverlayStrong }}
            pointerEvents="none"
          >
            <LoaderKit style={{ width: 40, height: 40 }} name="LineScalePulseOutRapid" color={theme.primaryContrast} />
          </View>
        )}

        {isPausedByTimer && (
          <View
            className="absolute inset-0 h-full w-full items-center justify-center"
            style={{ backgroundColor: theme.mediaOverlayStrong }}
            pointerEvents="none"
          >
            <Text className="text-lg" style={{ color: theme.primaryContrast }}>
              Continue Watching
            </Text>
          </View>
        )}

        {(showIndicator || isManuallyPaused || isPausedByTimer || isEnded) && (
          <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]} pointerEvents="none">
            <View className="h-14 w-14 items-center justify-center rounded-full" style={{ backgroundColor: theme.mediaOverlayStrong }}>
              <MaterialIcons
                name={showIndicator ? indicatorIcon : isManuallyPaused ? "pause" : "play-arrow"}
                size={36}
                color={theme.primaryContrast}
              />
            </View>
          </View>
        )}

        <TouchableOpacity
          onPress={handleOpenVideo}
          activeOpacity={0.8}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel="Open video fullscreen"
          className="absolute bottom-3 right-14 h-9 w-9 items-center justify-center rounded-full"
          style={{ backgroundColor: theme.mediaOverlayStrong }}
        >
          <MaterialIcons name="fullscreen" size={20} color={theme.primaryContrast} />
        </TouchableOpacity>

        <TouchableOpacity
          onPress={toggleMuted}
          activeOpacity={0.8}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel={isMuted ? "Unmute video" : "Mute video"}
          className="absolute bottom-3 right-3 h-9 w-9 items-center justify-center rounded-full"
          style={{ backgroundColor: theme.mediaOverlayStrong }}
        >
          <MaterialIcons name={isMuted ? "volume-off" : "volume-up"} size={20} color={theme.primaryContrast} />
        </TouchableOpacity>
      </View>

      {/* TITLE */}
      <TouchableOpacity onPress={handleOpenVideo}>
        <View className="p-4">
          <Text className="text-[15px] font-bold" style={{ color: theme.text }}>
            {video.title}
          </Text>
        </View>
      </TouchableOpacity>

      {/* LIKE/COMMENT/SHARE */}
      <StyledLikeCommentShare item={video} variant="feed" showCommentButton={true} onCommentPress={() => setCommentModalVisible(true)} />

      {/* COMMENTS MODAL */}
      <VideoCommentModal
        isVisible={isCommentModalVisible}
        onClose={() => setCommentModalVisible(false)}
        item={video}
        onCommentPosted={(newCount) => updateVideoStats(video.$id, { commentsCount: newCount })}
      />
    </View>
  );
});

export default React.memo(PostVideo);
