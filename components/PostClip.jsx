// components/PostClip.js
import { Entypo } from "@expo/vector-icons";
import { router } from "expo-router";
import { useVideoPlayer, VideoView } from "expo-video";
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { AppState, Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import LoaderKit from "react-native-loader-kit";
import Share from "react-native-share";
import { useClipsStats } from "../context/clip-stats-provider";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import playbackEvents from "../lib/playback-events";
import secrets from "../private/secrets";
import AnimatedSkeleton from "./AnimatedSkeleton";
import ClipCommentModal from "./ClipCommentModal";
import ClipInformation from "./ClipInformation";
import UserRoleBadgeIcons from "./UserRoleBadgeIcons";

const PostClip = forwardRef(({ item, onOpenSafetySheet }, ref) => {
  const { user } = useGlobalContext();
  const { theme } = useAppTheme();
  const { updateClipCommentCount } = useClipsStats();

  const [clip, setClip] = useState(null);
  const [loading, setLoading] = useState(true);
  const [videoLoading, setVideoLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [isEnded, setIsEnded] = useState(false);
  const [isCommentModalVisible, setCommentModalVisible] = useState(false);

  const playerRef = useRef(null);
  const shouldPlayRef = useRef(false);

  const isLoggedInUser = user?.$id === clip?.uploader?.$id;

  /** SAFE PLAY */
  const safePlay = useCallback(() => {
    try {
      const r = playerRef.current?.play?.();
      if (r?.catch) r.catch(() => {});
    } catch (_) {}
  }, []);

  /** SAFE PAUSE */
  const safePause = useCallback(() => {
    try {
      playerRef.current?.pause?.();
    } catch (_) {}
  }, []);

  /** PAUSE WHEN A FOREGROUND-FOCUS MODAL OPENS
   *
   *  Mirrors PostVideo: subscribes to the global playbackEvents bus and
   *  pauses when a "pause-all" signal is broadcast. Without this, the
   *  Share Profile sheet and similar foreground-focus modals can be
   *  force-closed by the system because the autoplaying clip is competing
   *  for playback ownership. */
  useEffect(() => {
    const handlePauseAll = () => {
      try {
        safePause();
      } catch (_) {}
    };
    playbackEvents.on("pause-all", handlePauseAll);
    return () => {
      playbackEvents.off("pause-all", handlePauseAll);
    };
  }, [safePause]);

  /** LOAD CLIP */
  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(false);

      try {
        setClip(item);
        setIsEnded(false); // reset ended state for new clip
      } catch (_) {
        setError(true);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [item, retryKey]);

  /** PLAYER SETUP */
  const setupPlayer = useCallback((player) => {
    player.loop = false;
    player.showNowPlayingNotification = false;
    player.staysActiveInBackground = false;
    player.allowsExternalPlayback = false;

    player.addListener("playToEnd", () => {
      setIsEnded(true);
    });

    playerRef.current = player;
  }, []);

  const player = useVideoPlayer(
    clip?.clipUrl
      ? {
          uri: clip.clipUrl,
          metadata: {
            title: clip.title,
            artist: clip.uploader?.name,
            artwork: clip?.thumbnail,
          },
          key: retryKey, // 🔥 ensures replay works
        }
      : null,
    setupPlayer,
  );

  /** PLAYER STATUS HANDLER */
  useEffect(() => {
    if (!player) return;

    const sub = player.addListener("statusChange", () => {
      const state = player.status;

      if (state === "readyToPlay") {
        setVideoLoading(false);

        if (shouldPlayRef.current) {
          safePlay();
        }
      }

      if (state === "error") {
        setError(true);
        setVideoLoading(false);
      }

      if (state === "loading") {
        setVideoLoading(true);
      }
    });

    return () => sub.remove();
  }, [player]);

  /** PAUSE WHEN APP GOES BACKGROUND */
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        safePause();
      }
    });
    return () => sub.remove();
  }, []);

  /** NAVIGATION ACTIONS */
  const handleClipPress = () => {
    router.push({
      pathname: "clips",
      params: {
        showClip: JSON.stringify(clip),
        showClipTrigger: Date.now(),
      },
    });
  };

  const handleProfilePress = () => {
    if (isLoggedInUser) router.push("/profile");
    else
      router.push({
        pathname: "/creator-profile",
        params: { userId: clip?.uploader?.$id },
      });
  };

  const handleSharePress = async () => {
    await Share.open({
      message: `Check out this clip!`,
      url: `${secrets.WEBSITE}/clips/${clip?.$id}`,
      title: clip?.title,
      type: "url",
    });
  };

  /** EXPOSE CONTROLS TO PARENT */
  useImperativeHandle(ref, () => ({
    pauseVideo: () => {
      shouldPlayRef.current = false;
      safePause();
    },
    resumeVideo: () => {
      shouldPlayRef.current = true;
      safePlay();
    },
    muteVideo: () => {
      if (playerRef.current) playerRef.current.muted = true;
    },
    unmuteVideo: () => {
      if (playerRef.current) playerRef.current.muted = false;
    },
  }));

  useEffect(
    () => () => {
      shouldPlayRef.current = false;
      safePause();
    },
    [safePause],
  );

  /** SKELETON */
  if (loading) {
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
      {/* Header */}
      <View className="flex flex-row items-center justify-between px-4 py-2">
        <View className="flex flex-row items-center">
          <TouchableOpacity onPress={handleProfilePress} activeOpacity={0.7}>
            <FastImage
              source={{ uri: clip.uploader?.avatar, priority: FastImage.priority.normal }}
              style={{ height: 35, width: 35, borderRadius: 5, marginRight: 10, backgroundColor: theme.surfaceStrong }}
            />
          </TouchableOpacity>

          <View>
            <TouchableOpacity onPress={handleProfilePress} activeOpacity={0.7}>
              <View className="flex-row items-center">
                <Text className="text-base font-bold" style={{ color: theme.text }}>
                  {clip.uploader?.username}
                </Text>
                <UserRoleBadgeIcons user={clip.uploader} size={18} />
              </View>
            </TouchableOpacity>
            <Text className="text-xs" style={{ color: theme.textSoft }}>
              Featured
            </Text>
          </View>
        </View>

        {!isLoggedInUser && (
          <TouchableOpacity onPress={onOpenSafetySheet} hitSlop={{ left: 15, bottom: 15, top: 10, right: 10 }}>
            <Entypo name="dots-three-horizontal" size={18} color={theme.iconMuted} />
          </TouchableOpacity>
        )}
      </View>

      {/* Video */}
      <TouchableOpacity activeOpacity={0.9} onPress={handleClipPress}>
        <View className="relative h-[300px] w-full overflow-hidden" style={{ backgroundColor: theme.mediaBackground }}>
          <VideoView player={player} allowsFullscreen={false} allowsPictureInPicture={false} className="h-full w-full" pointerEvents="none" />

          {videoLoading && !isEnded && (
            <View className="absolute inset-0 h-full w-full items-center justify-center" style={{ backgroundColor: theme.mediaOverlay }}>
              <LoaderKit style={{ width: 40, height: 40 }} name="LineScalePulseOutRapid" color={theme.primaryContrast} />
            </View>
          )}

          {/* REPLAY BUTTON */}
          {isEnded && (
            <View className="absolute inset-0 h-full w-full items-center justify-center">
              <TouchableOpacity
                className="rounded-full px-6 py-3"
                style={{ backgroundColor: theme.surface }}
                onPress={() => {
                  setIsEnded(false);
                  shouldPlayRef.current = true; // allow autoplay again
                  setRetryKey((k) => k + 1); // 🔥 force FULL reload — required for replay
                  safePlay(); // optional immediate play
                }}
              >
                <Text className="text-base font-bold" style={{ color: theme.text }}>
                  ▶ Replay
                </Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </TouchableOpacity>

      {/* INFO */}
      <View className="px-4 py-3">
        <Text className="text-lg font-bold" style={{ color: theme.text }}>
          {clip.title}
        </Text>
        {clip.description ? (
          <Text className="mt-1 text-sm" style={{ color: theme.textMuted }} numberOfLines={2}>
            {clip.description}
          </Text>
        ) : null}
      </View>

      {/* LIKE / COMMENT / SHARE */}
      <ClipInformation item={clip} variant="feed" onSharePress={handleSharePress} onCommentPress={() => setCommentModalVisible(true)} />

      {/* COMMENT MODAL */}
      <ClipCommentModal
        isVisible={isCommentModalVisible}
        onClose={() => setCommentModalVisible(false)}
        item={clip}
        onCommentPosted={(newCount) => updateClipCommentCount(clip.$id, newCount)}
      />
    </View>
  );
});

export default React.memo(PostClip);
