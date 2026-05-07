import { Ionicons } from "@expo/vector-icons";
import { Audio } from "expo-av";
import * as ImagePicker from "expo-image-picker";
import { router, useLocalSearchParams } from "expo-router";
import { VideoView, useVideoPlayer } from "expo-video";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Animated, Dimensions, Image, PanResponder, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import ViewShot from "react-native-view-shot";
import { CustomAlertModal, MusicPickerModal, SelectedMusicBadge } from "../../components";
import GifPickerModal from "../../components/GifPickerModal";
import StyledSafeAreaView from "../../components/StyledSafeAreaView";
import useAppTheme from "../../hooks/useAppTheme";
import storyEvents from "../../lib/story-events";

const { width, height } = Dimensions.get("window");

// TikTok-style filter presets for the editor (May 2026). Each tile in
// the bottom filter row corresponds to one of these. `key` is the
// stable id (also accepted via route param if a caller wants to open
// the editor with a filter pre-selected). `label` is the user-facing
// name. `overlay` is the tinted layer rendered inside ViewShot — for
// image moments it bakes into the captured JPG so the filter is
// permanent. For video moments the overlay renders during preview but
// isn't baked into the saved file (native video processing — phase 2).
//
// "none" is a sentinel meaning "no filter applied" and renders no
// overlay. Keeping it in the list lets the user explicitly clear an
// applied filter by tapping the Original tile.
const STORY_FILTERS = [
  { key: "none",    label: "Original", overlay: null },
  { key: "warm",    label: "Warm",     overlay: "rgba(255, 170, 90, 0.20)" },
  { key: "cool",    label: "Cool",     overlay: "rgba(90, 170, 255, 0.18)" },
  { key: "mono",    label: "B&W",      overlay: "rgba(20, 20, 30, 0.40)" },
  { key: "vibrant", label: "Vibrant",  overlay: "rgba(255, 60, 180, 0.14)" },
  { key: "vintage", label: "Vintage",  overlay: "rgba(180, 120, 60, 0.22)" },
];

const _findFilter = (key) => STORY_FILTERS.find((f) => f.key === key) || STORY_FILTERS[0];

export default function StoryPreview() {
  const { uri, type, effect } = useLocalSearchParams();
  const isVideo = type === "video";
  // Filter is editor-local state so tapping a tile applies instantly.
  // Initialize from the route param if a caller pre-selected one (e.g.
  // a future "share with filter X" entry). Falls back to "none."
  const [selectedFilterKey, setSelectedFilterKey] = useState(
    typeof effect === "string" ? effect : "none",
  );
  const effectOverlay = _findFilter(selectedFilterKey).overlay;
  // Effects panel toggle. Default hidden — the bottom bar's Effects
  // button flips this; the filter strip slides in above the bar when
  // open. Keeps the canvas uncluttered until the user actually wants
  // to apply a filter.
  const [effectsOpen, setEffectsOpen] = useState(false);

  // Camera / Gallery handlers route back into this same screen with
  // fresh params so the editor re-mounts with the new media. Using
  // router.replace (not push) avoids stacking editor instances every
  // time the user swaps media.
  const handleSwapToCamera = async () => {
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== "granted") return;
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.All,
        allowsEditing: false,
        quality: 0.8,
        videoMaxDuration: 60,
      });
      if (!result.canceled && result.assets?.[0]?.uri) {
        const f = result.assets[0];
        const ft = f.type === "video" ? "video" : "image";
        router.replace({ pathname: "/story-preview", params: { uri: f.uri, type: ft } });
      }
    } catch (e) {
      console.warn("[story-preview] camera launch failed:", e);
    }
  };

  // GIF picker — opens the shared Giphy modal. On pick, we add the
  // GIF as a draggable + pinch-zoom overlay on the canvas (same
  // pattern as text overlays). The overlay sits inside ViewShot so
  // the chosen GIF bakes into the captured JPG when the user hits
  // Share. Animation doesn't survive ViewShot's snapshot — only the
  // current frame is captured, which is the same compromise text
  // overlays accept.
  const handleOpenGif = () => setGifPickerOpen(true);

  const handlePickGif = (gifUrl) => {
    if (!gifUrl) return;
    const id = `gif-${Date.now().toString()}`;
    const gifPan = new Animated.ValueXY({ x: 0, y: 0 });
    const gifScale = new Animated.Value(1);
    // Same pan + pinch responder shape as text overlays. Two-finger
    // pinch scales the GIF, one-finger drag moves it.
    const responder = PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderMove: (evt, gestureState) => {
        const touches = evt.nativeEvent.touches || [];
        if (touches.length === 2) {
          const [a, b] = touches;
          const dist = Math.hypot(b.pageX - a.pageX, b.pageY - a.pageY);
          if (!responder.initialDist) responder.initialDist = dist / gifScale.__getValue();
          const newScale = Math.min(Math.max(dist / responder.initialDist, 0.3), 4);
          gifScale.setValue(newScale);
        } else if (touches.length === 1) {
          const { dx, dy } = gestureState;
          gifPan.setValue({ x: dx, y: dy });
        }
      },
      onPanResponderRelease: () => {
        responder.initialDist = null;
        gifPan.flattenOffset();
      },
    });
    setGifs((prev) => [...prev, { id, url: gifUrl, pan: gifPan, scale: gifScale, responder }]);
    setGifPickerOpen(false);
  };

  // Long-press on a GIF overlay → remove. Single-tap is reserved for
  // future "select / edit" affordance; long-press is the unambiguous
  // delete gesture (matches how chat handles message actions).
  const handleRemoveGif = (id) => {
    setGifs((prev) => prev.filter((g) => g.id !== id));
  };

  // Edit — trim/crop/rotate need native video processing for video
  // moments, so it's a phase-2 placeholder for now.
  const handleOpenEdit = () => {
    Alert.alert("Coming soon", "Trim, crop, and rotate are on the way.");
  };

  const handleSwapToGallery = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.All,
        allowsEditing: false,
        quality: 0.5,
      });
      if (!result.canceled && result.assets?.[0]?.uri) {
        const f = result.assets[0];
        const ft = f.type === "video" ? "video" : "image";
        router.replace({ pathname: "/story-preview", params: { uri: f.uri, type: ft } });
      }
    } catch (e) {
      console.warn("[story-preview] gallery launch failed:", e);
    }
  };

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

  // GIF overlays — array of { id, url, pan, scale, responder }. Each
  // is rendered inside ViewShot so the picked GIF bakes into the
  // captured JPG when the user hits Share. Animated frames render
  // during preview but the captured frame is whatever Giphy delivers
  // as the still-image fallback when ViewShot snaps it (Giphy GIFs
  // are decoded into a single-frame raster at capture time —
  // animation does not survive the snapshot, which matches the
  // existing text-bake behavior).
  const [gifs, setGifs] = useState([]);
  const [gifPickerOpen, setGifPickerOpen] = useState(false);
  const { theme } = useAppTheme();

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
          // Canvas is now full-screen between the top bar (~60dp) and
          // the bottom bar (~60dp). Bumped from the old 0.6x sizing
          // when the editor was a windowed preview. Roughly accurate
          // is good enough for pan-clamp; precise bounds would need
          // an onLayout pass.
          const canvasW = width;
          const canvasH = height - 120;
          const scaledW = canvasW * scale.__getValue();
          const scaledH = canvasH * scale.__getValue();
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
        // New text-shape fields (May 2026):
        //   bg     — optional rounded-pill background color (toggles
        //            visibility for the highlight style).
        //   size   — preset cycle: small / medium / large / xl.
        //   align  — left / center / right.
        //   weight — regular / bold.
        // Defaults match the previous behavior so existing flows
        // render identically until the user touches the new controls.
        bg: null,
        size: 28,
        align: "center",
        weight: "bold",
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

  // Text-shape mutators for the new editing controls.
  //
  // toggleBg   — flips between no background and a translucent dark
  //              pill (rendered behind the text). Phase-2 we can
  //              expose colored backgrounds — for now black-on-white
  //              text is the most-used case so a single toggle
  //              covers it.
  // cycleSize  — rotates through 4 preset sizes. We avoid a slider
  //              because a slider needs a real gesture handler; a
  //              tap-to-cycle is one tap to change size and matches
  //              TikTok's "size button" UX.
  // cycleAlign — left / center / right.
  // cycleWeight — regular / bold.
  const SIZE_PRESETS = [20, 28, 40, 56];
  const ALIGN_CYCLE = ["center", "left", "right"];
  const toggleBg = () => {
    if (!activeTextId) return;
    setTexts((prev) =>
      prev.map((t) =>
        t.id === activeTextId
          ? { ...t, bg: t.bg ? null : "rgba(0, 0, 0, 0.55)" }
          : t,
      ),
    );
  };
  const cycleSize = () => {
    if (!activeTextId) return;
    setTexts((prev) =>
      prev.map((t) => {
        if (t.id !== activeTextId) return t;
        const idx = SIZE_PRESETS.indexOf(t.size || 28);
        const next = SIZE_PRESETS[(idx + 1) % SIZE_PRESETS.length];
        return { ...t, size: next };
      }),
    );
  };
  const cycleAlign = () => {
    if (!activeTextId) return;
    setTexts((prev) =>
      prev.map((t) => {
        if (t.id !== activeTextId) return t;
        const idx = ALIGN_CYCLE.indexOf(t.align || "center");
        const next = ALIGN_CYCLE[(idx + 1) % ALIGN_CYCLE.length];
        return { ...t, align: next };
      }),
    );
  };
  const cycleWeight = () => {
    if (!activeTextId) return;
    setTexts((prev) =>
      prev.map((t) =>
        t.id === activeTextId
          ? { ...t, weight: t.weight === "bold" ? "regular" : "bold" }
          : t,
      ),
    );
  };

  return (
    <StyledSafeAreaView className="flex-1 bg-black">
      {/* 🔹 Top bar — close only. Text + music moved into the new
          creative tools row at the bottom (May 2026 redesign). When
          the user is editing a text overlay we still need a "Done"
          affordance — surface it on the right side here so it's
          reachable above the keyboard. */}
      <View style={styles.topActions}>
        <TouchableOpacity onPress={() => router.back()} accessibilityLabel="Close editor">
          <Ionicons name="close" size={30} color="#fff" />
        </TouchableOpacity>
        {activeText && (
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
                contentFit="cover"
                onReady={() => player.play()}
              />
            ) : (
              <FastImage source={{ uri }} style={isPortrait ? styles.mediaPortrait : styles.media} resizeMode="cover" />
            )}
          </Animated.View>

          {/* Effect overlay — tinted layer baked into the captured JPG
              for image moments (rendered for video moments but not
              baked in; see _STORY_EFFECT_OVERLAYS comment above).
              Positioned absolutely INSIDE ViewShot so ViewShot's
              capture-pass picks it up alongside the media + texts. */}
          {effectOverlay ? (
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: 0,
                bottom: 0,
                backgroundColor: effectOverlay,
              }}
            />
          ) : null}

          {/* GIF overlays — rendered before text overlays so text
              floats on top if both are placed at the same spot.
              Long-press to remove. Pan / pinch via the per-GIF
              responder. Animated GIF source is honored by FastImage
              during preview; ViewShot captures the current frame on
              Share. */}
          {gifs.map((g) => (
            <Animated.View
              key={g.id}
              {...g.responder.panHandlers}
              style={[styles.gifOverlay, { transform: [...g.pan.getTranslateTransform(), { scale: g.scale }] }]}
            >
              <TouchableOpacity onLongPress={() => handleRemoveGif(g.id)} delayLongPress={400} activeOpacity={1}>
                <FastImage
                  source={{ uri: g.url }}
                  style={styles.gifImage}
                  resizeMode={FastImage.resizeMode.contain}
                />
              </TouchableOpacity>
            </Animated.View>
          ))}

          {texts.map((t) => {
            // Per-overlay style derived from the new shape fields.
            // Falls back to the legacy defaults so text added before
            // these fields existed still renders identically.
            const fontSize = t.size || 28;
            const fontWeight = (t.weight || "bold") === "bold" ? "bold" : "normal";
            const textAlign = t.align || "center";
            // Background pill — only render the wrapping View when the
            // user toggled it on, otherwise the text floats with no
            // chrome (matches the original look).
            const bgStyle = t.bg
              ? {
                  backgroundColor: t.bg,
                  paddingHorizontal: 10,
                  paddingVertical: 4,
                  borderRadius: 6,
                }
              : null;
            return (
              <Animated.View
                key={t.id}
                {...t.responder.panHandlers}
                style={[styles.textOverlay, { transform: [...t.pan.getTranslateTransform(), { scale: t.scale }] }]}
              >
                {t.isEditing ? (
                  <View style={bgStyle}>
                    <TextInput
                      value={t.text}
                      onChangeText={(val) => updateText(t.id, val)}
                      onSubmitEditing={() => finishEditing(t)}
                      autoFocus
                      placeholder="Type something..."
                      placeholderTextColor="#ccc"
                      style={[
                        styles.textInput,
                        { color: t.color, fontSize, fontWeight, textAlign },
                      ]}
                    />
                  </View>
                ) : (
                  <TouchableOpacity onPress={() => beginEditing(t.id)}>
                    <View style={bgStyle}>
                      <Text style={[styles.text, { color: t.color, fontSize, fontWeight, textAlign }]}>
                        {t.text}
                      </Text>
                    </View>
                  </TouchableOpacity>
                )}
              </Animated.View>
            );
          })}
        </ViewShot>

        {/* 🎨 COLOR PICKER UI */}
        {activeText && activeText.isEditing && (
          <View style={styles.textControls}>
            {/* Row 1 — style toggles (size / align / weight / bg).
                Each tap mutates the active text via the cycle
                helpers above. The bg toggle gets a purple fill when
                on; the others lean on their label characters to
                surface current state (e.g. align label cycles
                L/C/R). */}
            <View style={styles.textCtrlRow}>
              <TouchableOpacity onPress={cycleSize} style={styles.textCtrlBtn} accessibilityLabel="Cycle text size">
                <Text style={styles.textCtrlSizeLabel}>{(activeText?.size || 28) + ""}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={cycleAlign} style={styles.textCtrlBtn} accessibilityLabel="Cycle text alignment">
                <Text style={styles.textCtrlAlignLabel}>
                  {(activeText?.align || "center") === "left" ? "L" : (activeText?.align || "center") === "right" ? "R" : "C"}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={cycleWeight} style={styles.textCtrlBtn} accessibilityLabel="Toggle text weight">
                <Text style={[styles.textCtrlBoldLabel, (activeText?.weight || "bold") === "bold" && { textDecorationLine: "underline" }]}>B</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={toggleBg}
                style={[styles.textCtrlBtn, activeText?.bg && styles.textCtrlBtnActive]}
                accessibilityLabel="Toggle text background"
                accessibilityState={{ selected: !!activeText?.bg }}
              >
                <Ionicons name="square" size={20} color="#fff" />
              </TouchableOpacity>
            </View>

            <View style={styles.textCtrlSeparator} />

            {/* Row 2 — color picker. Active swatch gets a purple
                ring; otherwise the dot is bare. Scrollable so future
                additions to COLORS don't break layout. */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ alignItems: "center", gap: 8 }}
              style={styles.textCtrlColorScroll}
            >
              {COLORS.map((c) => (
                <TouchableOpacity
                  key={c}
                  onPress={() => changeColor(c)}
                  style={[
                    styles.colorDot,
                    {
                      backgroundColor: c,
                      borderWidth: c === "#ffffff" ? 1 : (activeText?.color === c ? 2 : 0),
                      borderColor: activeText?.color === c ? "#7975D4" : "#fff",
                    },
                  ]}
                />
              ))}
            </ScrollView>
          </View>
        )}
      </View>

      {/* 🔹 Filter strip — only visible when the Effects button below
          has been toggled on. TikTok-style horizontal scroll; each
          tile previews its overlay color over a neutral swatch. The
          active tile gets a purple ring. Tapping a tile flips
          `selectedFilterKey`; the overlay above the media re-renders
          instantly and bakes into the captured image on Share.
          Hidden while text is being edited so the color picker has
          room. */}
      {!activeText && effectsOpen && (
        <View style={styles.filterRowWrapper}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.filterRowContent}
          >
            {STORY_FILTERS.map((f) => {
              const active = selectedFilterKey === f.key;
              return (
                <TouchableOpacity
                  key={f.key}
                  onPress={() => setSelectedFilterKey(f.key)}
                  style={[styles.filterTile, active && styles.filterTileActive]}
                  accessibilityRole="button"
                  accessibilityLabel={`Apply ${f.label} filter`}
                  accessibilityState={{ selected: active }}
                >
                  <View style={[styles.filterPreview, active && styles.filterPreviewActive]}>
                    <View style={styles.filterSwatch} />
                    {f.overlay ? (
                      <View
                        pointerEvents="none"
                        style={[styles.filterOverlay, { backgroundColor: f.overlay }]}
                      />
                    ) : null}
                  </View>
                  <Text style={[styles.filterLabel, active && styles.filterLabelActive]} numberOfLines={1}>
                    {f.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      {/* 🔹 Right side rail — creative tools (Text / Music / GIF /
          Filter / Edit). Floats absolutely over the canvas at the
          top-right edge. Matches TikTok's right-rail UX where tools
          live close to the user's thumb without eating vertical
          space from the canvas. Each button is a circular badge so
          the rail reads as iconography rather than a UI bar.
          Hidden while editing text (color picker needs the area). */}
      {!activeText && (
        <View style={styles.sideRail} pointerEvents="box-none">
          <TouchableOpacity
            onPress={type === "video" ? undefined : handleAddText}
            disabled={type === "video"}
            style={[styles.railBtn, type === "video" && styles.railBtnDisabled]}
            accessibilityLabel="Add text"
          >
            <Ionicons name="text" size={20} color={type === "video" ? "rgba(255,255,255,0.4)" : "#fff"} />
            <Text style={[styles.railLabel, type === "video" && styles.railLabelDisabled]}>Text</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={type === "video" ? undefined : () => setMusicModalOpen(true)}
            disabled={type === "video"}
            style={[styles.railBtn, type === "video" && styles.railBtnDisabled]}
            accessibilityLabel="Add music"
          >
            <Ionicons name="musical-notes" size={20} color={type === "video" ? "rgba(255,255,255,0.4)" : "#fff"} />
            <Text style={[styles.railLabel, type === "video" && styles.railLabelDisabled]}>Music</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={handleOpenGif} style={styles.railBtn} accessibilityLabel="Add GIF">
            <View style={styles.gifBadge}>
              <Text style={styles.gifBadgeText}>GIF</Text>
            </View>
            <Text style={styles.railLabel}>GIF</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setEffectsOpen((v) => !v)}
            style={styles.railBtn}
            accessibilityLabel="Toggle filters"
            accessibilityState={{ selected: effectsOpen }}
          >
            <Ionicons name="color-wand" size={20} color={effectsOpen ? "#7975D4" : "#fff"} />
            <Text style={[styles.railLabel, effectsOpen && { color: "#7975D4" }]}>Filter</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={handleOpenEdit} style={styles.railBtn} accessibilityLabel="Edit media">
            <Ionicons name="create" size={20} color="#fff" />
            <Text style={styles.railLabel}>Edit</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* 🔹 Action bar — Camera / Gallery on the left, Share on the
          right. Camera and Gallery re-launch the OS picker and
          replace the current media (router.replace, see handlers
          above). Share is the primary CTA. */}
      {!activeText && (
        <View style={styles.actionBar}>
          <TouchableOpacity onPress={handleSwapToCamera} style={styles.actionBtn} accessibilityLabel="Open camera">
            <Ionicons name="camera" size={20} color="#fff" />
            <Text style={styles.actionLabel}>Camera</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={handleSwapToGallery} style={styles.actionBtn} accessibilityLabel="Pick from gallery">
            <Ionicons name="images" size={20} color="#fff" />
            <Text style={styles.actionLabel}>Gallery</Text>
          </TouchableOpacity>
          <View style={{ flex: 1 }} />
          <TouchableOpacity
            disabled={uploading}
            onPress={handleShare}
            style={[styles.shareBtn, uploading && { opacity: 0.6 }]}
            accessibilityLabel="Share"
          >
            {uploading ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.shareText}>Share</Text>}
          </TouchableOpacity>
        </View>
      )}
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

      <GifPickerModal
        visible={gifPickerOpen}
        onClose={() => setGifPickerOpen(false)}
        onPick={handlePickGif}
        theme={theme}
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
    width: "100%",
    overflow: "hidden",
  },
  // Side rail — creative tools floating absolutely over the canvas
  // at the top-right. Pinned 70dp from the top (clears the X close
  // button) and 12dp from the right edge. Translucent dark badges
  // around each icon so the rail stays readable over any background.
  sideRail: {
    position: "absolute",
    top: 70,
    right: 12,
    alignItems: "center",
    gap: 14,
    zIndex: 10,
  },
  railBtn: {
    alignItems: "center",
    paddingHorizontal: 6,
    paddingVertical: 6,
    borderRadius: 18,
    backgroundColor: "rgba(0, 0, 0, 0.45)",
    minWidth: 52,
  },
  railLabel: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "500",
    marginTop: 2,
  },
  railBtnDisabled: {
    opacity: 0.55,
  },
  railLabelDisabled: {
    color: "rgba(255, 255, 255, 0.4)",
  },
  // GIF gets a custom mini-badge instead of a generic icon — makes
  // the button instantly recognizable. Same 22dp footprint as the
  // sibling Ionicons so the row stays visually balanced.
  gifBadge: {
    width: 26,
    height: 22,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  gifBadgeText: {
    color: "#fff",
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  // Action bar — Camera + Gallery on the left, Share pill on the
  // right. Sits below the tools row so the primary CTA is at the
  // very bottom (closest to the user's thumb).
  actionBar: {
    flexDirection: "row",
    alignItems: "center",
    width: "100%",
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "rgba(0, 0, 0, 0.65)",
    gap: 12,
  },
  actionBtn: {
    alignItems: "center",
    paddingHorizontal: 8,
  },
  actionLabel: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "500",
    marginTop: 2,
  },
  shareBtn: {
    backgroundColor: "#7975D4",
    paddingHorizontal: 22,
    paddingVertical: 10,
    borderRadius: 10,
    minWidth: 90,
    alignItems: "center",
  },
  // Capture area now fills the canvas. No fixed background — the
  // SafeAreaView (className="bg-black") provides the letterbox color
  // for portrait media that doesn't fully cover.
  captureArea: {
    flex: 1,
    width: "100%",
    overflow: "hidden",
  },
  mediaWrapper: { flex: 1 },
  // Both portrait and landscape media now stretch to fill the canvas.
  // The VideoView/FastImage handles the actual fit (cover for visual
  // parity with TikTok — content is full-bleed, may crop slightly).
  media: { width: "100%", height: "100%" },
  mediaPortrait: { width: "100%", height: "100%" },
  textOverlay: { position: "absolute", top: "45%", left: "30%" },
  // GIF overlays sit absolutely positioned just like text overlays.
  // Initial size is 160x160 — pinch-zoom can scale up to 4x or down
  // to 0.3x via the per-GIF responder. Centered roughly in the
  // canvas so the user always sees the GIF on first add.
  gifOverlay: { position: "absolute", top: "35%", left: "50%", marginLeft: -80 },
  gifImage: { width: 160, height: 160 },
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
  // Text editing toolbar — appears at the bottom of the canvas
  // while a text overlay is being edited. Stacks the four style
  // toggles (size / align / weight / bg) above a horizontal color
  // row. Translucent dark wash so it sits cleanly over any media.
  textControls: {
    flexDirection: "column",
    alignItems: "center",
    gap: 10,
    position: "absolute",
    bottom: 20,
    left: 16,
    right: 16,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 14,
    backgroundColor: "rgba(0, 0, 0, 0.55)",
  },
  textCtrlRow: {
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  textCtrlColorScroll: {
    flexGrow: 0,
  },
  textCtrlBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255, 255, 255, 0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  textCtrlBtnActive: {
    backgroundColor: "rgba(121, 117, 212, 0.85)",
  },
  textCtrlSizeLabel: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "700",
  },
  textCtrlAlignLabel: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700",
  },
  textCtrlBoldLabel: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
  // Subtle divider between the style-toggle row and the color row.
  // Just a 1px line for visual separation; could be removed if the
  // controls feel too dense in testing.
  textCtrlSeparator: {
    width: "100%",
    height: 1,
    backgroundColor: "rgba(255, 255, 255, 0.15)",
  },
  colorDot: { width: 32, height: 32, borderRadius: 16, borderColor: "#fff" },
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
  // Filter row — sits above the bottom Share button. Translucent dark
  // strip so it floats over the canvas area without stealing focus.
  filterRowWrapper: {
    width: "100%",
    paddingVertical: 8,
    backgroundColor: "rgba(0, 0, 0, 0.35)",
  },
  filterRowContent: {
    paddingHorizontal: 12,
    gap: 12,
    alignItems: "center",
  },
  filterTile: {
    alignItems: "center",
    width: 64,
  },
  filterTileActive: {
    // No transform — purple ring is the visual cue (see filterPreview).
  },
  filterPreview: {
    width: 56,
    height: 56,
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: 2,
    borderColor: "transparent",
    position: "relative",
  },
  filterPreviewActive: {
    borderColor: "#7975D4",
  },
  // Neutral swatch under each tile's overlay — gives the filter
  // something to tint so the difference between Warm / Cool / Mono /
  // etc. is visible at a glance even on tiles where the overlay alpha
  // is low.
  filterSwatch: {
    flex: 1,
    backgroundColor: "#9b95d4",
  },
  filterOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  },
  filterLabel: {
    marginTop: 6,
    color: "rgba(255, 255, 255, 0.75)",
    fontSize: 11,
    fontWeight: "500",
    textAlign: "center",
  },
  filterLabelActive: {
    color: "#fff",
    fontWeight: "700",
  },
});
