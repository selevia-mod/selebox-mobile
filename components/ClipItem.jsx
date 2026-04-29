import { FontAwesome, Ionicons } from "@expo/vector-icons";
import Slider from "@react-native-community/slider";
import { useVideoPlayer, VideoView } from "expo-video";
import React, { memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Dimensions, Platform, StyleSheet, Text, TouchableOpacity, TouchableWithoutFeedback, View } from "react-native";
import LoaderKit from "react-native-loader-kit";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import useAppTheme from "../hooks/useAppTheme";
import ClipInformation from "./ClipInformation";

const { height: SCREEN_HEIGHT, width: SCREEN_WIDTH } = Dimensions.get("window");
const BOTTOM_TAB_BAR_HEIGHT = Platform.OS === "ios" ? 83 : 50;

const formatTime = (totalSeconds) => {
  const roundedSeconds = Math.floor(totalSeconds); // removes decimals
  const minutes = Math.floor(roundedSeconds / 60);
  const seconds = roundedSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

const ClipItem = React.forwardRef(({ item, onCommentPress, onSharePress }, ref) => {
  const insets = useSafeAreaInsets();
  const { theme } = useAppTheme();
  const isPlayingRef = useRef(true);
  const [showControls, setShowControls] = useState(false);
  const durationRef = useRef(1);
  const positionRef = useRef(0);
  const [seeking, setSeeking] = useState(false);
  const [, forceRender] = useState(0);
  const [loading, setLoading] = useState(false);
  const loaderTimeoutRef = useRef(null);
  const [hasError, setHasError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  const videoViewRef = useRef(null);
  const controlsTimeoutRef = useRef(null);

  const setupPlayer = useCallback((player) => {
    player.loop = true;
    player.timeUpdateEventInterval = 0.1;
    player.showNowPlayingNotification = false;
    player.staysActiveInBackground = false;
    player.allowsExternalPlayback = false;
  }, []);

  const player = useVideoPlayer(
    item?.clipUrl
      ? {
          uri: item.clipUrl,
          metadata: {
            title: item?.title,
            artist: item?.uploader?.name,
            artwork: item?.uploader?.avatar,
          },
          key: retryKey, // force re-init on retry
        }
      : null,
    setupPlayer,
  );

  useImperativeHandle(
    ref,
    () => ({
      play: () => {
        try {
          if (player?.status !== "error" && typeof player.play === "function") {
            player.play();
          }
        } catch (e) {
          console.log("play() failed", e);
        }
      },
      pause: () => {
        try {
          if (player?.status !== "error" && typeof player.pause === "function") {
            player.pause();
          }
        } catch (e) {
          console.log("pause() failed", e);
        }
      },
      isDestroyed: () => player?.status === "error",
    }),
    [player],
  );

  useEffect(() => {
    if (!player) return;

    const statusListener = player.addListener("statusChange", () => {
      const status = player.status;
      if (status === "readyToPlay") {
        isPlayingRef.current = true;
        clearTimeout(loaderTimeoutRef.current);
        setLoading(false);
        setHasError(false);
      } else if (status === "loading" || status === "idle") {
        loaderTimeoutRef.current = setTimeout(() => {
          setLoading(true);
        }, 120);
      } else if (status === "error") {
        clearTimeout(loaderTimeoutRef.current);
        setLoading(false);
        setHasError(true);
      }
    });

    const timeUpdateListener = player.addListener("timeUpdate", () => {
      if (!seeking) {
        positionRef.current = player.currentTime;
        durationRef.current = player.duration || 1;
        forceRender(Date.now());
      }
    });

    return () => {
      statusListener?.remove();
      timeUpdateListener?.remove();
    };
  }, [player, seeking]);

  const togglePlayback = async () => {
    try {
      if (isPlayingRef.current) {
        await player?.pause();
      } else {
        await player?.play();
      }
      isPlayingRef.current = !isPlayingRef.current;
      forceRender(Date.now()); // to show correct icon
    } catch (error) {
      console.log("togglePlayBack: error", error);
    }
  };

  const handleSeekStart = () => {
    setSeeking(true);
  };

  const handleSeekComplete = async (val) => {
    const delta = val - positionRef.current;
    try {
      await player.seekBy(delta);
      positionRef.current = val;
      forceRender(Date.now());
    } catch (error) {
      console.warn("handleSeekComplete: error", error);
    } finally {
      setSeeking(false);
      if (!isPlayingRef.current) {
        await player.play();
        isPlayingRef.current = true;
        forceRender(Date.now());
      }
    }
  };

  const showOverlay = () => {
    setShowControls(true);
    clearTimeout(controlsTimeoutRef.current);
    controlsTimeoutRef.current = setTimeout(() => setShowControls(false), 3000);
  };

  const hideOverlay = () => {
    setShowControls(false);
    clearTimeout(controlsTimeoutRef.current);
  };

  const handleVideoPress = () => {
    if (showControls) {
      hideOverlay(); // Hide immediately if visible
    } else {
      showOverlay(); // Show and auto-hide
    }
  };

  const handleRetry = () => {
    setRetryKey((prev) => prev + 1);
    setHasError(false);
    setLoading(true);
    player.replay();
  };

  return (
    <View style={styles.container}>
      <View style={[styles.videoContainer, { paddingBottom: BOTTOM_TAB_BAR_HEIGHT + insets.bottom + 25 }]}>
        <VideoView
          className="h-full w-full"
          ref={videoViewRef}
          player={player}
          nativeControls={false}
          allowsFullscreen={false}
          allowsPictureInPicture={false}
          allowsVideoFrameAnalysis={false}
          pointerEvents="none"
        />
      </View>

      {loading && (
        <View style={[styles.loadingOverlay, { paddingBottom: insets.bottom + BOTTOM_TAB_BAR_HEIGHT + 25 }]}>
          <LoaderKit style={{ width: 50, height: 50 }} name="LineScalePulseOutRapid" color={theme.primaryContrast} />
        </View>
      )}

      {hasError && (
        <View style={[styles.retryOverlay, { paddingBottom: insets.bottom + BOTTOM_TAB_BAR_HEIGHT + 25 }]}>
          <TouchableOpacity onPress={handleRetry}>
            <FontAwesome name="repeat" size={50} color={theme.primaryContrast} />
          </TouchableOpacity>
        </View>
      )}

      <TouchableWithoutFeedback onPress={handleVideoPress}>
        <View style={StyleSheet.absoluteFillObject} />
      </TouchableWithoutFeedback>

      {(showControls || seeking) && (
        <TouchableWithoutFeedback onPress={handleVideoPress}>
          <View style={styles.overlay}>
            {/* Playback button */}
            <TouchableOpacity
              style={{ paddingBottom: insets.bottom + BOTTOM_TAB_BAR_HEIGHT + 25, alignSelf: "center" }}
              onPress={togglePlayback}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Ionicons name={isPlayingRef.current ? "pause-circle" : "play-circle"} size={64} color={theme.primaryContrast} />
            </TouchableOpacity>

            {/* Slider */}
            <View style={[styles.sliderContainer, { bottom: insets.bottom + BOTTOM_TAB_BAR_HEIGHT + 35 }]}>
              <Slider
                style={{ width: SCREEN_WIDTH - 10 }}
                minimumValue={0}
                maximumValue={durationRef.current}
                value={positionRef.current}
                onSlidingStart={handleSeekStart}
                onSlidingComplete={handleSeekComplete}
                minimumTrackTintColor="#7975D4"
                maximumTrackTintColor="#555"
                thumbTintColor="#7975D4"
              />
              <View style={styles.timeRow}>
                <Text style={styles.timeText}>{formatTime(positionRef.current)}</Text>
                <Text style={styles.timeText}>{formatTime(durationRef.current)}</Text>
              </View>
            </View>
          </View>
        </TouchableWithoutFeedback>
      )}

      {/* Clip Information */}
      <ClipInformation item={item} onCommentPress={onCommentPress} onSharePress={onSharePress} showControls={showControls} />
    </View>
  );
});

export default memo(ClipItem, (prevProps, nextProps) => {
  return prevProps.item?.$id === nextProps.item?.$id && prevProps.isVisible === nextProps.isVisible;
});

const styles = StyleSheet.create({
  container: {
    height: SCREEN_HEIGHT,
    width: SCREEN_WIDTH,
  },
  videoContainer: {
    flex: 1,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.3)",
    zIndex: 1000,
  },
  sliderContainer: {
    position: "absolute",
    width: "100%",
    alignItems: "center",
  },
  timeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    width: SCREEN_WIDTH - 20,
  },
  timeText: {
    color: "white",
    fontSize: 12,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.3)",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 999,
    opacity: 0.5,
  },
  retryOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.3)",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 999,
  },
});
