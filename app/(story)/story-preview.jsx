import { Ionicons } from "@expo/vector-icons";
import { Audio } from "expo-av";
import { router, useLocalSearchParams } from "expo-router";
import { VideoView, useVideoPlayer } from "expo-video";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Animated, Dimensions, Image, PanResponder, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import ViewShot from "react-native-view-shot";
import { CustomAlertModal, MusicPickerModal, SelectedMusicBadge } from "../../components";
import StyledSafeAreaView from "../../components/StyledSafeAreaView";
import storyEvents from "../../lib/story-events";

const { width, height } = Dimensions.get("window");

export default function StoryPreview() {
  const { uri, type } = useLocalSearchParams();
  const isVideo = type === "video";

  const viewShotRef = useRef(null);
  const scale = useRef(new Animated.Value(1)).current;
  const pan = useRef(new Animated.ValueXY()).current;

  // text overlays
  const [texts, setTexts] = useState([]);
  const [activeTextId, setActiveTextId] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [mediaInfo, setMediaInfo] = useState({ w: 0, h: 0 });
  const [isPortrait, setIsPortrait] = useState(true);

  // music icon state
  const [musicModalOpen, setMusicModalOpen] = useState(false);
  const [selectedMusic, setSelectedMusic] = useState(null);
  const musicSound = useRef(null);

  const [showLengthError, setShowLengthError] = useState(false);

  const playerRef = useRef(null);
  const player = useVideoPlayer(isVideo ? { uri } : null, (p) => {
    if (!p) return;

    p.loop = true;

    const unsub = p.addListener("statusChange", (status) => {
      if (status.status === "readyToPlay") {
        const durationMs = p.duration;

        // If valid, play video normally
        p.play();
        unsub?.remove?.();
      }
    });
  });

  useEffect(() => {
    if (isVideo && player) {
      const playVideo = async () => {
        try {
          await player.play();
        } catch (err) {
          console.warn("Video autoplay failed:", err);
        }
      };
      playVideo();
    }
  }, [isVideo, player]);

  useEffect(() => {
    return () => {
      try {
        player?.pause();
        player?.unload?.();
      } catch {}
    };
  }, [player]);

  useEffect(() => {
    let active = true;
    if (!isVideo && uri) {
      Image.getSize(
        uri,
        (w, h) => {
          if (!active) return;
          setMediaInfo({ w, h });
          setIsPortrait(h >= w);
        },
        () => {},
      );
    } else if (isVideo) setIsPortrait(false);
    return () => (active = false);
  }, [uri, isVideo]);

  // Media gesture
  const mediaGestureStateRef = useRef({ initialPinchDist: null });
  const lastScale = useRef(1);
  const lastPan = useRef({ x: 0, y: 0 });

  const mediaResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderMove: (evt, gestureState) => {
        const touches = evt.nativeEvent.touches || [];
        if (touches.length === 2) {
          const [a, b] = touches;
          const distance = Math.hypot(b.pageX - a.pageX, b.pageY - a.pageY);
          if (!mediaGestureStateRef.current.initialPinchDist) mediaGestureStateRef.current.initialPinchDist = distance / lastScale.current;
          const newScale = Math.min(Math.max(distance / mediaGestureStateRef.current.initialPinchDist, 0.8), 3);
          scale.setValue(newScale);
        } else if (touches.length === 1) {
          const { dx, dy } = gestureState;
          const canvasW = width;
          const canvasH = height * 0.6;
          const scaledW = (isPortrait ? width * 0.9 : width) * scale.__getValue();
          const scaledH = height * 0.6 * scale.__getValue();
          const maxX = Math.max(0, (scaledW - canvasW) / 2);
          const maxY = Math.max(0, (scaledH - canvasH) / 2);
          let newX = lastPan.current.x + dx;
          let newY = lastPan.current.y + dy;
          newX = Math.min(maxX, Math.max(-maxX, newX));
          newY = Math.min(maxY, Math.max(-maxY, newY));
          pan.setValue({ x: newX, y: newY });
        }
      },
      onPanResponderRelease: () => {
        lastPan.current = { x: pan.x.__getValue(), y: pan.y.__getValue() };
        mediaGestureStateRef.current.initialPinchDist = null;
        lastScale.current = scale.__getValue();
      },
    }),
  ).current;

  // add new text
  const handleAddText = () => {
    const id = Date.now().toString();
    const pan = new Animated.ValueXY({ x: 0, y: 0 });
    const scale = new Animated.Value(1);

    const responder = PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderMove: (evt, gestureState) => {
        const touches = evt.nativeEvent.touches || [];
        if (touches.length === 2) {
          const [a, b] = touches;
          const dist = Math.hypot(b.pageX - a.pageX, b.pageY - a.pageY);
          if (!responder.initialDist) responder.initialDist = dist / scale.__getValue();
          const newScale = Math.min(Math.max(dist / responder.initialDist, 0.5), 3);
          scale.setValue(newScale);
        } else if (touches.length === 1) {
          const { dx, dy } = gestureState;
          pan.setValue({ x: dx, y: dy });
        }
      },
      onPanResponderRelease: () => {
        responder.initialDist = null;
        pan.flattenOffset();
      },
    });

    setTexts((prev) => [
      ...prev,
      {
        id,
        text: "",
        color: "#ffffff",
        pan,
        scale,
        responder,
        isEditing: true,
      },
    ]);
    setActiveTextId(id);
  };

  const handleShare = async () => {
    try {
      setUploading(true);

      // capture overlay if needed
      const overlayCapture = await viewShotRef.current.capture();
      const isVideo = type === "video";
      // Emit event to StoryBar
      storyEvents.emit("storyShared", {
        uri: isVideo ? uri : overlayCapture,
        type,
        thumbnail: isVideo ? null : overlayCapture,
        texts,
        musicId: selectedMusic?.$id ?? null,
      });

      // Navigate back — StoryBar will handle optimistic UI + upload
      router.back();
    } catch (error) {
      console.log("Error sharing story:", error);
    } finally {
      setUploading(false);
    }
  };

  const playSelectedMusic = async (url) => {
    try {
      // enable audio even when phone is on silent mode
      await Audio.setAudioModeAsync({
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
      });

      // unload previous audio instance safely
      if (musicSound.current) {
        await musicSound.current.unloadAsync();
        musicSound.current = null;
      }

      // now create a new audio instance
      const { sound } = await Audio.Sound.createAsync({ uri: url }, { shouldPlay: true, isLooping: true });

      musicSound.current = sound;
    } catch (err) {
      console.log("Error playing music preview:", err);
    }
  };

  useEffect(() => {
    return () => {
      if (musicSound.current) {
        musicSound.current.unloadAsync();
        musicSound.current = null;
      }
    };
  }, []);

  const COLORS = ["#ffffff", "#000000", "#ff3b30", "#ff9500", "#ffcc00", "#4cd964", "#34aadc", "#5856d6", "#ff2d55"];

  const activeText = texts.find((t) => t.id === activeTextId);

  const updateText = (id, newValue) => {
    setTexts((prev) => prev.map((t) => (t.id === id ? { ...t, text: newValue } : t)));
  };

  const finishEditing = (textObj) => {
    if (!textObj.text.trim()) {
      setTexts((prev) => prev.filter((t) => t.id !== textObj.id));
    } else {
      setTexts((prev) => prev.map((t) => (t.id === textObj.id ? { ...t, isEditing: false } : t)));
    }
    setActiveTextId(null);
  };

  const beginEditing = (id) => {
    setTexts((prev) => prev.map((t) => (t.id === id ? { ...t, isEditing: true } : t)));
    setActiveTextId(id);
  };

  const changeColor = (color) => {
    if (!activeTextId) return;
    setTexts((prev) => prev.map((t) => (t.id === activeTextId ? { ...t, color } : t)));
  };

  return (
    <StyledSafeAreaView className="flex-1 bg-black">
      {/* 🔹 Top Actions */}
      <View style={styles.topActions}>
        {!activeText ? (
          <>
            <TouchableOpacity onPress={() => router.back()}>
              <Ionicons name="close" size={30} color="#fff" />
            </TouchableOpacity>

            {/* TEXT BUTTON */}
            {type !== "video" && (
              <TouchableOpacity onPress={handleAddText}>
                <Ionicons name="text" size={28} color="#fff" />
              </TouchableOpacity>
            )}

            {/* MUSIC BUTTON */}
            {type !== "video" && (
              <TouchableOpacity onPress={() => setMusicModalOpen(true)}>
                <Ionicons name="musical-notes" size={28} color="#fff" />
              </TouchableOpacity>
            )}
          </>
        ) : (
          <>
            <View />
            <TouchableOpacity
              style={styles.doneButton}
              onPress={() => {
                if (activeText.text.trim() === "") {
                  setTexts((prev) => prev.filter((t) => t.id !== activeText.id));
                } else {
                  setTexts((prev) => prev.map((t) => (t.id === activeText.id ? { ...t, isEditing: false } : t)));
                }
                setActiveTextId(null);
              }}
            >
              <Text className="font-psemibold text-black">Done</Text>
            </TouchableOpacity>
          </>
        )}
      </View>

      {/* 🔹 Canvas */}
      <View style={styles.canvasArea}>
        <SelectedMusicBadge
          selectedMusic={selectedMusic}
          onRemove={() => {
            setSelectedMusic(null);
            musicSound.current?.unloadAsync();
          }}
        />

        {/* 📸 ONLY MEDIA + TEXTS WILL BE CAPTURED */}
        <ViewShot ref={viewShotRef} options={{ format: "jpg", quality: 0.9 }} style={styles.captureArea}>
          <Animated.View {...mediaResponder.panHandlers} style={[styles.mediaWrapper, { transform: [{ scale }, ...pan.getTranslateTransform()] }]}>
            {isVideo ? (
              <VideoView
                ref={playerRef}
                player={player}
                style={isPortrait ? styles.mediaPortrait : styles.media}
                allowsFullscreen={false}
                allowsPictureInPicture={false}
                nativeControls={false}
                contentFit="contain"
                onReady={() => player.play()}
              />
            ) : (
              <FastImage source={{ uri }} style={isPortrait ? styles.mediaPortrait : styles.media} resizeMode={isPortrait ? "contain" : "cover"} />
            )}
          </Animated.View>

          {texts.map((t) => (
            <Animated.View
              key={t.id}
              {...t.responder.panHandlers}
              style={[styles.textOverlay, { transform: [...t.pan.getTranslateTransform(), { scale: t.scale }] }]}
            >
              {t.isEditing ? (
                <TextInput
                  value={t.text}
                  onChangeText={(val) => updateText(t.id, val)}
                  onSubmitEditing={() => finishEditing(t)}
                  autoFocus
                  placeholder="Type something..."
                  placeholderTextColor="#ccc"
                  style={[styles.textInput, { color: t.color }]}
                />
              ) : (
                <TouchableOpacity onPress={() => beginEditing(t.id)}>
                  <Text style={[styles.text, { color: t.color }]}>{t.text}</Text>
                </TouchableOpacity>
              )}
            </Animated.View>
          ))}
        </ViewShot>

        {/* 🎨 COLOR PICKER UI */}
        {activeText && activeText.isEditing && (
          <View style={styles.colorPicker}>
            {COLORS.map((c) => (
              <TouchableOpacity
                key={c}
                onPress={() => changeColor(c)}
                style={[styles.colorDot, { backgroundColor: c, borderWidth: c === "#ffffff" ? 1 : 0 }]}
              />
            ))}
          </View>
        )}
      </View>

      {/* 🔹 Bottom */}
      <View style={styles.bottomActions}>
        {!activeText && (
          <TouchableOpacity
            className="rounded-[10px] bg-purple-700 px-4 py-2"
            disabled={uploading}
            onPress={handleShare}
            style={uploading && { opacity: 0.6 }}
          >
            {uploading ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.shareText}>Share</Text>}
          </TouchableOpacity>
        )}
      </View>
      <CustomAlertModal
        message="Video stories cannot exceed 30 seconds."
        iconName="circle-exclamation"
        iconColor="#ff4444"
        messageOpen={showLengthError}
        closeMessage={() => {
          router.back();
          setShowLengthError(false);
        }}
      />
      <MusicPickerModal
        isOpen={musicModalOpen}
        onClose={() => setMusicModalOpen(false)}
        onSelect={(music) => {
          setSelectedMusic(music);
          playSelectedMusic(music.fileUrl);
        }}
      />
    </StyledSafeAreaView>
  );
}

const styles = StyleSheet.create({
  topActions: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    width: "100%",
    paddingHorizontal: 10,
    paddingVertical: 10,
    height: 60,
  },
  canvasArea: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    width: "100%",
    borderRadius: 8,
  },
  bottomActions: {
    width: "100%",
    alignItems: "flex-end",
    right: 10,
    top: 10,
    height: 60,
  },
  captureArea: {
    width: "100%",
    height: "100%",
    backgroundColor: "gray",
    overflow: "hidden",
  },
  mediaWrapper: { flex: 1, alignItems: "center", justifyContent: "center" },
  media: { width, height: height * 0.6 },
  mediaPortrait: { width: width * 0.9, height: height * 0.6 },
  textOverlay: { position: "absolute", top: "45%", left: "30%" },
  text: {
    color: "white",
    fontSize: 28,
    fontWeight: "bold",
    textAlign: "center",
  },
  textInput: {
    color: "white",
    fontSize: 28,
    fontWeight: "bold",
    borderBottomWidth: 1,
    borderBottomColor: "#fff",
    textAlign: "center",
    minWidth: 120,
  },
  colorPicker: {
    flexDirection: "row",
    gap: 8,
    position: "absolute",
    bottom: 20,
    alignSelf: "center",
  },
  colorDot: { width: 36, height: 36, borderRadius: 18, borderColor: "#fff" },
  shareText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 18,
  },
  doneButton: {
    backgroundColor: "#fff",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 10,
  },
});
