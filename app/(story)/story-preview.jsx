import { Feather, Ionicons } from "@expo/vector-icons";
import { Audio } from "expo-av";
import { BlurView } from "expo-blur";
import * as ImagePicker from "expo-image-picker";
import { router, useLocalSearchParams } from "expo-router";
import { VideoView, useVideoPlayer } from "expo-video";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Animated, Dimensions, Image, Keyboard, PanResponder, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import ViewShot from "react-native-view-shot";
import { CustomAlertModal, MusicPickerModal, SelectedMusicBadge } from "../../components";
import EmojiPickerModal from "../../components/EmojiPickerModal";
import GifPickerModal from "../../components/GifPickerModal";
import LinkPickerModal from "../../components/LinkPickerModal";
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

// Common BlurView intensity + tint pair, kept consistent across all the
// floating chrome (top bar, side rail, action bar, filter strip, text
// controls). Lower intensity reads as light haze; we want a more substantial
// frosted look that holds up over busy backgrounds, so 60 + dark tint.
const GLASS_INTENSITY = 60;
const GLASS_TINT = "dark";

// One canonical button shape for the right rail — guarantees Text, Music,
// GIF, Filter, Edit all read at the same visual weight. Active state lights
// up the icon + label in theme.primary; disabled state dims everything to
// ~30% so the user can see the option exists but it's not currently
// available (e.g., Text and Music are disabled for video moments today).
const RailButton = ({ icon, label, onPress, active, disabled, theme, accessibilityState }) => {
  const tint = disabled ? "rgba(255,255,255,0.35)" : active ? theme.primary : "#fff";
  const iconWithTint = icon ? { ...icon, props: { ...icon.props, color: tint } } : null;
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.railBtn,
        pressed && !disabled && styles.pressedScale,
      ]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={accessibilityState ?? { disabled }}
    >
      {iconWithTint}
      <Text style={[styles.railLabel, { color: tint }]}>{label}</Text>
    </Pressable>
  );
};

export default function StoryPreview() {
  const { uri, type, effect } = useLocalSearchParams();
  const isVideo = type === "video";
  // Edge-to-edge editor: the root <View> fills the screen with a black
  // background; chrome (X button, side rail, action bar, text controls)
  // is positioned absolutely with these insets so it sits inside the
  // safe area without occluding the notch / home indicator. Switching
  // off the SafeAreaView wrapper was the only way to defeat its
  // built-in `justify-center items-center` which had been pinning
  // editor content to the vertical middle of the screen.
  const insets = useSafeAreaInsets();
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
  // Link attachment — when set, viewers who swipe up on the published
  // Moment will be sent here. Selebox book/video URLs deep-link in-app
  // via the resolved (resourceType, resourceId); external URLs open in
  // the browser. Shape comes from LinkPickerModal's parseLinkInput.
  const [attachedLink, setAttachedLink] = useState(null); // { url, resourceType, resourceId } | null
  const [linkPickerOpen, setLinkPickerOpen] = useState(false);
  // Tracks the keyboard's reported height so we can float the text
  // editing toolbar JUST above it (otherwise the toolbar sits at
  // bottom: insets.bottom + 16 and gets covered by the keyboard).
  // Updated by the listener effect below; resets to 0 when the
  // keyboard hides so the toolbar drops back to its safe-area resting
  // position.
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  // Emoji + Stickers picker — opened from the right rail "Emojis"
  // button. Picker is context-aware: if the user is editing a text
  // overlay, the picked emoji INSERTS into the text body; otherwise
  // it DROPS on the canvas as a large draggable sticker. One button,
  // two behaviors, matching Instagram's "emojis double as stickers"
  // convention.
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
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
    // Cycle each new text overlay through a small staircase of offsets so
    // adding multiple texts doesn't pile them on top of one another. After
    // 6 texts the cycle resets — by that point the user has already
    // dragged most of them to their intended spots anyway.
    const stagger = (texts.length % 6) * 22;
    const pan = new Animated.ValueXY({ x: stagger - 60, y: stagger - 30 });
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
      // Emit event to StoryBar — picked up by the optimistic UI + upload
      // pipeline. `link` carries the swipe-up target if the user attached
      // one via LinkPickerModal; null when nothing's attached. StoryBar
      // forwards { url, resourceType, resourceId } into createStory which
      // writes to the new stories.link_* columns from the
      // 2026-05-07_stories_link_url SQL migration.
      storyEvents.emit("storyShared", {
        uri: isVideo ? uri : overlayCapture,
        type,
        thumbnail: isVideo ? null : overlayCapture,
        texts,
        musicId: selectedMusic?.$id ?? null,
        link: attachedLink || null,
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

  // Pause the parent's looped music while the music picker is open
  // so the picker's preview doesn't play OVER the already-selected
  // track (the bug: opening the picker after selecting a song meant
  // the previewer's audio and the looped selection played together).
  //
  // Resume on close. If the user picked a NEW track inside the
  // modal, `playSelectedMusic` already replaced musicSound with the
  // new sound (and started it playing), so calling playAsync() here
  // is a harmless no-op. If they closed without picking, this
  // restores the previous track exactly where it left off.
  useEffect(() => {
    const sound = musicSound.current;
    if (!sound) return;
    if (musicModalOpen) {
      sound.pauseAsync().catch(() => {});
    } else {
      sound.playAsync().catch(() => {});
    }
  }, [musicModalOpen]);

  // Track keyboard show/hide so the text editing toolbar can float
  // just above the keyboard instead of being occluded by it. iOS uses
  // the `Will` events for accurate animations; Android only fires
  // `Did` reliably. endCoordinates.height includes the keyboard's
  // accessory area on iOS — exactly what we want to avoid.
  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const showSub = Keyboard.addListener(showEvent, (e) => {
      setKeyboardHeight(e?.endCoordinates?.height || 0);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => {
      setKeyboardHeight(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const COLORS = ["#ffffff", "#000000", "#ff3b30", "#ff9500", "#ffcc00", "#4cd964", "#34aadc", "#5856d6", "#ff2d55"];

  // (Local emoji array removed — the EmojiPickerModal owns its own
  // curated set so the picker UI and the underlying data live in one
  // place. insertEmoji + addSticker stay here because they mutate the
  // editor's own state.)

  // Insert an emoji into the active text overlay's body. If the user
  // hasn't started typing yet (no active text), this would be a no-op
  // — but we always call this from inside the text-editing UI, so
  // activeText will be defined. Inserts at the current cursor position
  // when we know it; otherwise appends to the end as a sane fallback.
  const insertEmoji = (emoji) => {
    if (!activeTextId) return;
    setTexts((prev) =>
      prev.map((t) => (t.id === activeTextId ? { ...t, text: (t.text || "") + emoji } : t)),
    );
  };

  // Drop a sticker (big emoji) onto the canvas as a draggable overlay.
  // Reuses handleAddText's shape — texts with a single emoji and large
  // font render as big floating stickers. The X delete badge works on
  // them too because they're regular text overlays under the hood.
  const addSticker = (emoji) => {
    const id = `sticker-${Date.now()}`;
    const stagger = (texts.length % 6) * 22;
    const pan = new Animated.ValueXY({ x: stagger - 40, y: stagger - 60 });
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
          const newScale = Math.min(Math.max(dist / responder.initialDist, 0.4), 4);
          scale.setValue(newScale);
        } else if (touches.length === 1) {
          pan.setValue({ x: gestureState.dx, y: gestureState.dy });
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
        text: emoji,
        color: "#ffffff",
        size: 80, // large by default — sticker, not body text
        align: "center",
        weight: "regular",
        bg: null,
        fontFamily: null,
        isEditing: false, // stickers go straight to placed mode (no edit cursor)
        pan,
        scale,
        responder,
      },
    ]);
  };

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

  // Text-shape mutators for the editing controls.
  //
  // toggleBg   — turns the rounded-pill background on / off. When ON,
  //              the user can also pick a background color via the BG
  //              swatch row that appears in the toolbar. Default BG
  //              is translucent dark so white text reads cleanly over
  //              any background.
  // setBgColor — picks a specific BG color from the BG swatch row.
  //              Implies toggleBg=on.
  // cycleSize  — rotates through 4 preset sizes. Tap-to-cycle matches
  //              TikTok's "size button" UX (no slider).
  // cycleAlign — left / center / right.
  // cycleWeight — regular / bold.
  // cycleFont  — rotates through font presets (System / Poppins /
  //              Inter / Serif / Mono). Each preset has a fontFamily
  //              that React Native maps to either a bundled font (we
  //              ship Poppins + Inter via tailwind.config.js) or the
  //              platform default. Display label cycles too so the
  //              user sees what they picked.
  const SIZE_PRESETS = [20, 28, 40, 56];
  const ALIGN_CYCLE = ["center", "left", "right"];
  // Font presets — `family` is what we pass to RN's fontFamily prop.
  // null = the platform default (iOS = San Francisco, Android = Roboto).
  // The bundled families come from tailwind.config.js (Poppins + Inter)
  // and exist on both platforms because they're loaded as static font
  // files in expo-font.
  const FONT_PRESETS = [
    { key: "system",  label: "Aa", family: null },
    { key: "poppins", label: "Poppins", family: "Poppins-SemiBold" },
    { key: "inter",   label: "Inter", family: "Inter-SemiBold" },
    { key: "serif",   label: "Serif", family: Platform.OS === "ios" ? "Georgia" : "serif" },
    { key: "mono",    label: "Mono", family: Platform.OS === "ios" ? "Menlo" : "monospace" },
  ];
  // Background color presets — visible only when t.bg is enabled. First
  // entry is the original translucent dark; the rest are vivid solids
  // matched to the COLORS palette so a user can build "white text on
  // red pill" / "yellow text on black pill" style combos one tap each.
  const BG_PRESETS = [
    "rgba(0, 0, 0, 0.55)",
    "#ffffff",
    "#000000",
    "#ff3b30",
    "#ff9500",
    "#ffcc00",
    "#4cd964",
    "#34aadc",
    "#5856d6",
    "#ff2d55",
  ];
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
  const setBgColor = (color) => {
    if (!activeTextId) return;
    setTexts((prev) =>
      prev.map((t) => (t.id === activeTextId ? { ...t, bg: color } : t)),
    );
  };
  const cycleFont = () => {
    if (!activeTextId) return;
    setTexts((prev) =>
      prev.map((t) => {
        if (t.id !== activeTextId) return t;
        const currentKey = t.fontKey || "system";
        const idx = FONT_PRESETS.findIndex((f) => f.key === currentKey);
        const next = FONT_PRESETS[(idx + 1) % FONT_PRESETS.length];
        return { ...t, fontKey: next.key, fontFamily: next.family };
      }),
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
    // Plain View instead of StyledSafeAreaView — that wrapper bakes in
    // `items-center justify-center` which was vertically centering the
    // entire editor inside the screen, leaving dead space above the X
    // button AND below the action bar. The Moments editor needs to
    // span edge-to-edge with chrome floating over the canvas; centering
    // is the wrong layout primitive for it. Insets above are still
    // applied to the X button + action bar so they clear the notch /
    // home indicator.
    <View style={styles.root}>
      {/* Top bar — close + (when editing text) Done. Floats over the
          canvas. With `edges={[]}` on the SafeAreaView wrapper, the
          canvas now extends edge-to-edge — so we manually push this
          bar into the safe area via insets.top so the X clears the
          notch / dynamic island. Static +6 above the inset gives a
          small breathing margin. */}
      <View style={[styles.topActions, { paddingTop: insets.top + 6 }]}>
        <Pressable
          onPress={() => router.back()}
          accessibilityLabel="Close editor"
          hitSlop={8}
          style={({ pressed }) => [styles.glassCircle, pressed && styles.pressedScale]}
        >
          <BlurView intensity={GLASS_INTENSITY} tint={GLASS_TINT} style={StyleSheet.absoluteFill} />
          <Ionicons name="close" size={22} color="#fff" />
        </Pressable>
        {activeText ? (
          <Pressable
            onPress={() => {
              if (activeText.text.trim() === "") {
                setTexts((prev) => prev.filter((t) => t.id !== activeText.id));
              } else {
                setTexts((prev) => prev.map((t) => (t.id === activeText.id ? { ...t, isEditing: false } : t)));
              }
              setActiveTextId(null);
            }}
            style={({ pressed }) => [
              styles.doneButton,
              { backgroundColor: theme.primary },
              pressed && styles.pressedScale,
            ]}
            accessibilityLabel="Finish editing text"
          >
            <Feather name="check" size={16} color="#fff" />
            <Text style={styles.doneText}>Done</Text>
          </Pressable>
        ) : null}
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

          {/* Edit-mode dim wash — sits INSIDE ViewShot, before the
              text overlays render, so when the user is typing the
              live text appears bright on top of a darkened canvas
              (especially important on white-background uploads where
              white text is otherwise invisible). Conditional on
              activeText.isEditing so it disappears the moment Done is
              tapped — never gets captured into the saved JPG since
              isEditing flips false right before ViewShot.capture(). */}
          {activeText && activeText.isEditing ? (
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: 0,
                bottom: 0,
                backgroundColor: "rgba(0, 0, 0, 0.45)",
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
            // Per-overlay style derived from the text-shape fields.
            // Falls back to the legacy defaults so text added before
            // these fields existed still renders identically.
            const fontSize = t.size || 28;
            const fontWeight = (t.weight || "bold") === "bold" ? "bold" : "normal";
            const textAlign = t.align || "center";
            const fontFamily = t.fontFamily || undefined;
            // Background pill — render whenever t.bg is set. The toolbar
            // toggleBg + setBgColor controls let the user pick from a
            // color row when the pill is on.
            const bgStyle = t.bg
              ? {
                  backgroundColor: t.bg,
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  borderRadius: 10,
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
                      placeholderTextColor="rgba(255, 255, 255, 0.6)"
                      style={[
                        styles.textInput,
                        { color: t.color, fontSize, fontWeight, textAlign, fontFamily },
                      ]}
                    />
                  </View>
                ) : (
                  // Wrapper view so the X delete badge can position
                  // absolutely against the text bubble's actual bounds
                  // (rather than against the outer Animated.View which
                  // doesn't have intrinsic dimensions).
                  <View>
                    <TouchableOpacity onPress={() => beginEditing(t.id)}>
                      <View style={bgStyle}>
                        <Text style={[styles.text, { color: t.color, fontSize, fontWeight, textAlign, fontFamily }]}>
                          {t.text}
                        </Text>
                      </View>
                    </TouchableOpacity>
                    {/* Delete badge — top-right corner of each placed
                        text. Hidden while editing because the keyboard
                        + toolbar take focus then. hitSlop expands the
                        tap area beyond the visible 22dp circle so it's
                        forgiving for fat-finger taps near small text. */}
                    <Pressable
                      onPress={() => setTexts((prev) => prev.filter((x) => x.id !== t.id))}
                      hitSlop={10}
                      accessibilityLabel="Remove text"
                      style={({ pressed }) => [
                        styles.textDeleteBadge,
                        pressed && { opacity: 0.7, transform: [{ scale: 0.9 }] },
                      ]}
                    >
                      <Ionicons name="close" size={12} color="#fff" />
                    </Pressable>
                  </View>
                )}
              </Animated.View>
            );
          })}
        </ViewShot>

        {/* COLOR PICKER + TEXT STYLING — glass-frosted floating
            toolbar at the bottom while a text overlay is being edited.
            Safe-area-anchored so the bottom edge clears the home
            indicator on iPhone X+ devices. Two stacked rows: style
            toggles (size / align / bold / bg) and a horizontal color
            picker. Active states use theme.primary so the chrome
            theme-switches cleanly if dark/light is ever introduced. */}
        {/* TEXT EDITING TOOLBAR — glass-frosted floating panel at the
            bottom while a text overlay is being edited. Three rows:
            (1) style toggles (size / align / bold / font / bg toggle)
            (2) text color swatches
            (3) BG color swatches (only when bg is enabled)
            All anchored above the home indicator via insets.bottom. */}
        {activeText && activeText.isEditing && (
          <View
            style={[
              styles.textControls,
              {
                // When the keyboard is up, sit JUST above it (8pt
                // gap). When it's down, fall back to the safe-area
                // resting position so the toolbar still has a sensible
                // home if the user dismisses the keyboard mid-edit.
                bottom: keyboardHeight > 0 ? keyboardHeight + 8 : insets.bottom + 16,
              },
            ]}
            pointerEvents="box-none"
          >
            <BlurView intensity={GLASS_INTENSITY} tint={GLASS_TINT} style={StyleSheet.absoluteFill} />
            <View style={styles.textCtrlRow}>
              <Pressable
                onPress={cycleSize}
                style={({ pressed }) => [styles.textCtrlBtn, pressed && styles.pressedScale]}
                accessibilityLabel="Cycle text size"
              >
                <Text style={styles.textCtrlSizeLabel}>{(activeText?.size || 28) + ""}</Text>
              </Pressable>
              <Pressable
                onPress={cycleAlign}
                style={({ pressed }) => [styles.textCtrlBtn, pressed && styles.pressedScale]}
                accessibilityLabel="Cycle text alignment"
              >
                <Text style={styles.textCtrlAlignLabel}>
                  {(activeText?.align || "center") === "left" ? "L" : (activeText?.align || "center") === "right" ? "R" : "C"}
                </Text>
              </Pressable>
              <Pressable
                onPress={cycleWeight}
                style={({ pressed }) => [styles.textCtrlBtn, pressed && styles.pressedScale]}
                accessibilityLabel="Toggle text weight"
              >
                <Text style={[styles.textCtrlBoldLabel, (activeText?.weight || "bold") === "bold" && { textDecorationLine: "underline" }]}>B</Text>
              </Pressable>
              {/* Font cycler — tap to rotate through System / Poppins /
                  Inter / Serif / Mono. Label uses the picked font so
                  the user sees the result before applying. */}
              <Pressable
                onPress={cycleFont}
                style={({ pressed }) => [styles.textCtrlBtn, pressed && styles.pressedScale]}
                accessibilityLabel="Cycle text font"
              >
                <Text
                  style={{
                    color: "#fff",
                    fontSize: 16,
                    fontWeight: "700",
                    fontFamily: activeText?.fontFamily || undefined,
                  }}
                >
                  Aa
                </Text>
              </Pressable>
              <Pressable
                onPress={toggleBg}
                style={({ pressed }) => [
                  styles.textCtrlBtn,
                  activeText?.bg && { backgroundColor: theme.primary },
                  pressed && styles.pressedScale,
                ]}
                accessibilityLabel="Toggle text background"
                accessibilityState={{ selected: !!activeText?.bg }}
              >
                <Ionicons name="square" size={18} color="#fff" />
              </Pressable>
            </View>

            <View style={styles.textCtrlSeparator} />

            {/* Text color row — colored dots, active gets a glowing
                primary ring. Horizontal scroll so we can grow the
                COLORS palette later without breaking layout. */}
            <View style={styles.textCtrlScrollRow}>
              <Text style={styles.textCtrlScrollLabel}>Text</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ alignItems: "center", gap: 10 }}
                style={styles.textCtrlColorScroll}
              >
                {COLORS.map((c) => {
                  const isActive = activeText?.color === c;
                  return (
                    <Pressable
                      key={c}
                      onPress={() => changeColor(c)}
                      style={({ pressed }) => [
                        styles.colorDot,
                        {
                          backgroundColor: c,
                          borderWidth: isActive ? 2.5 : c === "#ffffff" ? 1 : 0,
                          borderColor: isActive ? theme.primary : "rgba(255,255,255,0.85)",
                          shadowColor: isActive ? theme.primary : "transparent",
                          shadowOpacity: isActive ? 0.6 : 0,
                          shadowRadius: isActive ? 6 : 0,
                          elevation: isActive ? 4 : 0,
                        },
                        pressed && styles.pressedScale,
                      ]}
                      accessibilityLabel={`Use color ${c}`}
                      accessibilityState={{ selected: isActive }}
                    />
                  );
                })}
              </ScrollView>
            </View>

            {/* BG color row — only visible when the bg pill is enabled.
                Lets the user pick a specific background color (vs the
                default translucent dark). Same layout pattern as the
                text color row. */}
            {activeText?.bg ? (
              <View style={styles.textCtrlScrollRow}>
                <Text style={styles.textCtrlScrollLabel}>BG</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ alignItems: "center", gap: 10 }}
                  style={styles.textCtrlColorScroll}
                >
                  {BG_PRESETS.map((c) => {
                    const isActive = activeText?.bg === c;
                    const isTranslucent = c.startsWith("rgba");
                    return (
                      <Pressable
                        key={c}
                        onPress={() => setBgColor(c)}
                        style={({ pressed }) => [
                          styles.colorDot,
                          {
                            backgroundColor: isTranslucent ? "rgba(0,0,0,0.55)" : c,
                            borderWidth: isActive ? 2.5 : c === "#ffffff" ? 1 : 0,
                            borderColor: isActive ? theme.primary : "rgba(255,255,255,0.85)",
                            shadowColor: isActive ? theme.primary : "transparent",
                            shadowOpacity: isActive ? 0.6 : 0,
                            shadowRadius: isActive ? 6 : 0,
                            elevation: isActive ? 4 : 0,
                          },
                          pressed && styles.pressedScale,
                        ]}
                        accessibilityLabel={`Use background ${c}`}
                        accessibilityState={{ selected: isActive }}
                      />
                    );
                  })}
                </ScrollView>
              </View>
            ) : null}
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
        // Anchor the filter strip just above the bottom action bar.
        // Without this it sat in the flex flow and got covered by the
        // absolutely-positioned action bar (the Camera/Gallery/Share
        // pill sit at bottom:0, eating ~100pt). The action bar's
        // approximate height is 60 (button) + 26 (top/bottom padding)
        // + insets.bottom + 12 (extra) = roughly insets.bottom + ~98.
        // Using insets.bottom + 92 gives the strip enough clearance
        // without wasting space.
        <View
          style={[styles.filterRowWrapper, { bottom: insets.bottom + 92 }]}
          pointerEvents="box-none"
        >
          <BlurView intensity={GLASS_INTENSITY} tint={GLASS_TINT} style={StyleSheet.absoluteFill} />
          {/* Section label so the row reads as a labeled control,
              not a mystery strip of thumbnails. Mirrors the IG /
              TikTok pattern (small uppercase title above the picker). */}
          <Text style={styles.filterSectionTitle}>Filters</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.filterRowContent}
          >
            {STORY_FILTERS.map((f) => {
              const active = selectedFilterKey === f.key;
              return (
                <Pressable
                  key={f.key}
                  onPress={() => setSelectedFilterKey(f.key)}
                  style={({ pressed }) => [
                    styles.filterTile,
                    // Selected tiles scale up slightly so the picked
                    // filter pops visually — the ring + glow does the
                    // heavy lifting, the scale just confirms the choice.
                    active && { transform: [{ scale: 1.06 }] },
                    pressed && !active && styles.pressedScale,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={`Apply ${f.label} filter`}
                  accessibilityState={{ selected: active }}
                >
                  <View
                    style={[
                      styles.filterPreview,
                      active && {
                        borderColor: theme.primary,
                        borderWidth: 3,
                        shadowColor: theme.primary,
                        shadowOffset: { width: 0, height: 0 },
                        shadowOpacity: 0.7,
                        shadowRadius: 12,
                        elevation: 8,
                      },
                    ]}
                  >
                    {/* Actual media preview — for image moments we show
                        the user's photo, for video we fall back to a
                        gradient swatch (FastImage can't decode video
                        frames). The filter overlay sits on top so each
                        tile is a literal "this is what your moment will
                        look like" preview, IG/TikTok style. */}
                    {isVideo ? (
                      <View style={styles.filterPreviewSwatch} />
                    ) : (
                      <FastImage
                        source={{ uri }}
                        style={styles.filterPreviewMedia}
                        resizeMode={FastImage.resizeMode.cover}
                      />
                    )}
                    {f.overlay ? (
                      <View
                        pointerEvents="none"
                        style={[styles.filterOverlay, { backgroundColor: f.overlay }]}
                      />
                    ) : null}
                    {/* Checkmark badge on the selected tile. Small but
                        unmistakable — gives users the "yes that's the
                        one" affordance without making them squint at
                        the ring/glow alone. */}
                    {active ? (
                      <View style={[styles.filterActiveBadge, { backgroundColor: theme.primary }]}>
                        <Feather name="check" size={11} color="#fff" />
                      </View>
                    ) : null}
                  </View>
                  <Text
                    style={[styles.filterLabel, active && { color: "#fff", fontWeight: "700" }]}
                    numberOfLines={1}
                  >
                    {f.label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      )}

      {/* Right side rail — creative tools (Text / Music / GIF / Filter
          / Edit / Link). Single glass container instead of N individual
          badges so the rail reads as one cohesive control surface. Each
          row is a 56dp circular hit-target with a 22pt icon + 11pt label
          below. Top sits at a static 64pt below SafeAreaView's edge —
          enough to clear the close button at the top without re-paying
          the safe-area inset (SafeAreaView already pushed us past the
          notch). Hidden while editing text — the color picker needs the
          area. */}
      {!activeText && (
        <View
          style={[styles.sideRail, { top: insets.top + 56 }]}
          pointerEvents="box-none"
        >
          <BlurView intensity={GLASS_INTENSITY} tint={GLASS_TINT} style={styles.sideRailGlass}>
            <RailButton
              icon={<Ionicons name="text" size={22} />}
              label="Text"
              disabled={type === "video"}
              onPress={handleAddText}
              theme={theme}
            />
            {/* Emojis & Stickers — single rail button that opens the
                EmojiPickerModal. Behavior on tap is context-aware: if
                the user is currently editing a text overlay, the picked
                emoji inserts into that text body; otherwise it drops
                onto the canvas as a draggable sticker (size 80, no
                background). The "Happy face" Ionicon reads more
                clearly at 22pt than a literal emoji glyph would. */}
            <RailButton
              icon={<Ionicons name="happy" size={22} />}
              label="Emojis"
              onPress={() => setEmojiPickerOpen(true)}
              theme={theme}
            />
            <RailButton
              icon={<Ionicons name="musical-notes" size={22} />}
              label="Music"
              disabled={type === "video"}
              onPress={() => setMusicModalOpen(true)}
              theme={theme}
            />
            <RailButton
              icon={<Ionicons name="images" size={22} />}
              label="GIF"
              onPress={handleOpenGif}
              theme={theme}
            />
            <RailButton
              icon={<Ionicons name="color-wand" size={22} />}
              label="Filter"
              active={effectsOpen}
              onPress={() => setEffectsOpen((v) => !v)}
              theme={theme}
              accessibilityState={{ selected: effectsOpen }}
            />
            <RailButton
              icon={<Feather name="link" size={20} />}
              label="Link"
              active={Boolean(attachedLink)}
              onPress={() => setLinkPickerOpen(true)}
              theme={theme}
            />
            <RailButton
              icon={<Ionicons name="create" size={22} />}
              label="Edit"
              onPress={handleOpenEdit}
              theme={theme}
            />
          </BlurView>
        </View>
      )}

      {/* Action bar — Camera + Gallery as glass circles on the left,
          Share as a prominent primary pill on the right. Sits above the
          home indicator via safe-area inset so the Share pill never
          collides with the system gesture bar. The bar itself has no
          opaque background — instead a top-down dark wash gradient
          (rendered as a stacked rgba View — no expo-linear-gradient
          dependency needed) ensures the buttons stay legible over light
          backgrounds. The previous full-width opaque bar swallowed
          ~70px of canvas; this floats and lets the media breathe. */}
      {!activeText && (
        <View
          style={[styles.actionBar, { paddingBottom: insets.bottom + 12 }]}
          pointerEvents="box-none"
        >
          {/* Subtle bottom-up dark wash for legibility over any media.
              Three stops blend imperceptibly. Pointer events disabled so
              the wash never eats taps targeting the buttons above. */}
          <View pointerEvents="none" style={styles.actionWash} />

          <Pressable
            onPress={handleSwapToCamera}
            accessibilityLabel="Open camera"
            style={({ pressed }) => [styles.actionGlassCircle, pressed && styles.pressedScale]}
          >
            <BlurView intensity={GLASS_INTENSITY} tint={GLASS_TINT} style={StyleSheet.absoluteFill} />
            <Ionicons name="camera" size={26} color="#fff" />
          </Pressable>
          <Pressable
            onPress={handleSwapToGallery}
            accessibilityLabel="Pick from gallery"
            style={({ pressed }) => [styles.actionGlassCircle, pressed && styles.pressedScale]}
          >
            <BlurView intensity={GLASS_INTENSITY} tint={GLASS_TINT} style={StyleSheet.absoluteFill} />
            <Ionicons name="images" size={26} color="#fff" />
          </Pressable>

          <View style={{ flex: 1 }} />

          <Pressable
            disabled={uploading}
            onPress={handleShare}
            accessibilityLabel="Share"
            style={({ pressed }) => [
              styles.shareBtn,
              { backgroundColor: theme.primary },
              uploading && { opacity: 0.7 },
              pressed && !uploading && styles.pressedScale,
            ]}
          >
            {uploading ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <>
                <Text style={styles.shareText}>Share</Text>
                <Feather name="arrow-up-right" size={18} color="#fff" />
              </>
            )}
          </Pressable>
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

      <LinkPickerModal
        visible={linkPickerOpen}
        initialValue={attachedLink?.url || ""}
        onClose={() => setLinkPickerOpen(false)}
        onSubmit={(parsedLink) => setAttachedLink(parsedLink)}
        theme={theme}
      />

      {/* Emoji + Stickers picker. Two tabs inside the modal:
          - Emoji tab: tap → insert into active text (if editing) OR
            drop as a big-emoji sticker via addSticker (otherwise).
          - Stickers tab: tap → fetches from Giphy stickers and drops
            the picked URL onto the canvas as a draggable image
            (handlePickGif handles this since stickers are functionally
            GIFs/PNGs internally). The picker stays open between
            picks — close via X / backdrop / swipe-down. */}
      <EmojiPickerModal
        visible={emojiPickerOpen}
        onClose={() => setEmojiPickerOpen(false)}
        theme={theme}
        headerHint={
          activeText && activeText.isEditing
            ? "Emoji inserts into your text · Stickers drop on canvas"
            : "Tap to drop on your canvas"
        }
        onPickEmoji={(emoji) => {
          if (activeText && activeText.isEditing) {
            insertEmoji(emoji);
          } else {
            addSticker(emoji);
          }
        }}
        onPickSticker={(stickerUrl) => {
          // Stickers from Giphy are images — reuse handlePickGif which
          // already handles the draggable image overlay shape.
          handlePickGif(stickerUrl);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // Root container — fills the entire screen. Background is solid black
  // so portrait-aspect media (or media that doesn't reach the edges)
  // letterboxes against black instead of whatever's behind. flex: 1
  // makes us take the entire route surface; no centering / item-align
  // shenanigans (those were the source of the dead space the previous
  // StyledSafeAreaView wrapper introduced).
  root: {
    flex: 1,
    backgroundColor: "#000",
  },
  // Top bar — absolutely positioned over the canvas so the media
  // extends edge-to-edge behind the X button (TikTok / IG-style — the
  // close button overlays the photo, not letterboxed above it). When
  // this was in the normal layout flow it pushed the canvas down by
  // ~50dp + insets.top, leaving a tall black bar at the top of the
  // screen even after the SafeAreaView fixes. paddingTop is applied
  // dynamically from safe-area insets at the call site so the X clears
  // the notch / dynamic island.
  topActions: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingBottom: 6,
    zIndex: 10,
  },
  // Canvas area — the live media + ViewShot region. Flex-1 so it fills
  // remaining vertical space between the (floating) top + bottom chrome.
  canvasArea: {
    flex: 1,
    width: "100%",
    overflow: "hidden",
  },
  // Reusable 40dp glass circle — used for the X close button (stays
  // small to read as system chrome). BlurView fills it via
  // StyleSheet.absoluteFill at the call site; the icon sits on top via
  // alignItems/justifyContent center.
  glassCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255, 255, 255, 0.18)",
  },
  // 60dp glass circle for the bottom action shortcuts (Camera +
  // Gallery). 1.5× the X button — confident hit-target without being
  // visually heavy. (Was 72dp / 1.8× initially; user feedback dialed
  // it back to 1.5× for better balance against the Share pill.)
  actionGlassCircle: {
    width: 60,
    height: 60,
    borderRadius: 30,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255, 255, 255, 0.22)",
  },
  // Press feedback used everywhere — subtle 96% scale-down on press
  // gives the editor that "responsive" feel without being cartoony.
  pressedScale: {
    opacity: 0.85,
    transform: [{ scale: 0.96 }],
  },
  // Done pill — when the user is editing a text overlay, this pill in
  // the top-right doubles as a Save action. Filled with theme.primary
  // for unmistakable hierarchy. Drops shadow on iOS only — Android
  // elevation looks heavy on dark backgrounds.
  doneButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 22,
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.25,
        shadowRadius: 6,
      },
      android: { elevation: 3 },
    }),
  },
  doneText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 14,
    letterSpacing: 0.2,
  },
  // Side rail — single floating glass column at the top-right of the
  // canvas. `top` is set inline from safe-area insets at the call site;
  // right offset and visual treatment live here. zIndex keeps it above
  // the canvas + ViewShot layer.
  sideRail: {
    position: "absolute",
    right: 12,
    zIndex: 10,
  },
  // The glass column itself — wraps all 5 RailButton instances. Padding
  // gives each button breathing room; gap keeps them visually distinct
  // without needing per-button chrome. Thin hairline border catches
  // ambient light on translucent backgrounds and reads as a refined
  // edge rather than a slab.
  sideRailGlass: {
    paddingVertical: 10,
    paddingHorizontal: 6,
    borderRadius: 28,
    overflow: "hidden",
    alignItems: "center",
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255, 255, 255, 0.16)",
  },
  // Individual button inside the rail. 56pt hit-target (well above the
  // 44pt accessibility minimum), icon centered, label below in 11pt.
  // Tint is applied at runtime by RailButton based on active/disabled.
  railBtn: {
    width: 56,
    height: 56,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 4,
  },
  railLabel: {
    fontSize: 11,
    fontWeight: "600",
    marginTop: 4,
    letterSpacing: 0.2,
  },
  // Action bar — floats over the bottom of the canvas. No solid
  // background; the wash below provides contrast for the buttons.
  // paddingBottom is static (12) since SafeAreaView already provides
  // the home-indicator inset; the inline `insets.bottom + 12` from the
  // first revamp was double-padding and shoved the bar up too far.
  actionBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 12,
    gap: 12,
    zIndex: 5,
  },
  // Bottom-up dark wash so the Share pill + glass icons stay legible
  // even when the user has a bright photo behind. Sits inside actionBar
  // via absoluteFill — extends slightly upward (-40 top) for a soft edge
  // rather than a hard cut.
  actionWash: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    top: -40,
    backgroundColor: "rgba(0, 0, 0, 0.40)",
  },
  // Share — primary CTA. Fills with theme.primary at the call site so a
  // future light-mode flip would still tint correctly. Shadow gives it
  // the "lifted off the canvas" feel that signals primary action.
  shareBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 26,
    paddingVertical: 12,
    borderRadius: 26,
    minWidth: 110,
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.35,
        shadowRadius: 10,
      },
      android: { elevation: 6 },
    }),
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
  // Small X badge that floats at the top-right of each placed text
  // overlay so the user can remove it with one tap. Was: only way to
  // delete was to enter edit mode, clear the text, then submit (the
  // empty-text → finishEditing branch removes the row). That was
  // discoverable enough only to engineers; users were stuck with
  // texts they couldn't get rid of. Solid black-circle + white X reads
  // as "delete this thing" universally. Negative offsets pull it
  // slightly outside the text bubble's bounds so it doesn't cover
  // the first letter.
  textDeleteBadge: {
    position: "absolute",
    top: -8,
    right: -8,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "rgba(0, 0, 0, 0.85)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: "rgba(255, 255, 255, 0.85)",
  },
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
  // Live text input while editing — clearer than before because the
  // placeholder is white-with-shadow (was washed-out gray on whatever
  // background, basically invisible). minWidth keeps the cursor in a
  // sensible position even before the user types anything.
  textInput: {
    color: "white",
    fontSize: 28,
    fontWeight: "bold",
    textAlign: "center",
    minWidth: 200,
    textShadowColor: "rgba(0, 0, 0, 0.55)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  // (editBackdrop style removed — replaced by an inline View rendered
  // INSIDE ViewShot, so the editing text appears ON TOP of the dim
  // wash instead of being washed-out behind a sibling overlay.)

  // Scrollable color-picker row inside the text controls toolbar. Used
  // for both Text color (always visible) and BG color (visible when
  // the background pill is enabled). Label sits to the left so each
  // row reads as "Text [swatches]" / "BG [swatches]".
  textCtrlScrollRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    width: "100%",
    paddingHorizontal: 4,
  },
  textCtrlScrollLabel: {
    color: "rgba(255, 255, 255, 0.7)",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.6,
    width: 32,
  },
  // (quickInsert* styles removed — the inline emoji/sticker tabs
  // were replaced by a dedicated EmojiPickerModal opened from a new
  // rail button. Modal owns its own layout.)
  // Text editing toolbar — glass-frosted floating panel at the bottom
  // of the canvas while a text overlay is being edited. `bottom` is
  // applied inline from safe-area insets at the call site so the panel
  // clears the home indicator on iPhone X+ devices. BlurView fills the
  // background via absoluteFill at the call site; this just defines
  // the rounded-pill layout + border.
  // zIndex:2 keeps this above the editBackdrop (zIndex:1) so the
  // toolbar stays visible + interactive while the rest of the canvas
  // dims to 55% opacity behind it.
  textControls: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: 12,
    position: "absolute",
    left: 16,
    right: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 22,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255, 255, 255, 0.16)",
    zIndex: 2,
  },
  textCtrlRow: {
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  textCtrlColorScroll: {
    flexGrow: 0,
  },
  textCtrlBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(255, 255, 255, 0.10)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255, 255, 255, 0.14)",
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
    height: StyleSheet.hairlineWidth,
    backgroundColor: "rgba(255, 255, 255, 0.18)",
  },
  // Color swatches in the picker row. Slightly larger for confident
  // tap targets; active state's purple ring + glow is set inline at
  // the call site (uses theme.primary) so the swatch theme-switches.
  colorDot: {
    width: 34,
    height: 34,
    borderRadius: 17,
    shadowOffset: { width: 0, height: 0 },
  },
  shareText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 16,
    letterSpacing: 0.3,
  },
  // Filter row — sits above the bottom Action bar when effectsOpen.
  // Glass background via BlurView at the call site; this just defines
  // the layout. paddingBottom is generous (24) so the row looks like
  // a finished sheet rather than ending abruptly above the action bar.
  // Filter row — anchored absolutely just above the action bar via
  // inline `bottom` at the call site so the action bar's Camera /
  // Gallery / Share pill don't cover the lower edge of the tiles.
  // Floats with horizontal margin so it reads as a self-contained
  // glass sheet rather than a strip flush with the screen edges.
  // zIndex:6 keeps it above the actionBar (zIndex:5) just in case
  // there's any layout drift.
  filterRowWrapper: {
    position: "absolute",
    left: 8,
    right: 8,
    paddingTop: 12,
    paddingBottom: 18,
    overflow: "hidden",
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255, 255, 255, 0.16)",
    zIndex: 6,
  },
  // Section title above the strip — small uppercase label gives the
  // row a "labeled control" feel rather than a mystery thumbnail strip.
  // letterSpacing matches the IG / Apple system label conventions.
  filterSectionTitle: {
    color: "rgba(255, 255, 255, 0.6)",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.2,
    paddingHorizontal: 20,
    marginBottom: 10,
    textTransform: "uppercase",
  },
  filterRowContent: {
    paddingHorizontal: 16,
    gap: 14,
    alignItems: "flex-start",
  },
  filterTile: {
    alignItems: "center",
    width: 68,
  },
  // Vertical card aspect (3:4) — makes each tile feel like a mini
  // photo preview, matching how the actual moment will look on the
  // viewer screen. Was a flat 60x60 square swatch which read as a
  // generic color picker rather than a real preview.
  filterPreview: {
    width: 68,
    height: 88,
    borderRadius: 14,
    overflow: "hidden",
    borderWidth: 2,
    borderColor: "rgba(255, 255, 255, 0.18)",
    position: "relative",
    backgroundColor: "rgba(255, 255, 255, 0.05)",
  },
  // Live media preview behind the filter overlay — for image moments
  // we use FastImage with the same uri the canvas renders, so each
  // tile genuinely shows what the moment will look like with that
  // filter applied. Cover fit so portrait/landscape both look right.
  filterPreviewMedia: {
    width: "100%",
    height: "100%",
  },
  // Fallback swatch for video moments (FastImage can't decode video
  // frames). Subtle gradient-ish purple so the tile isn't a blank box
  // but doesn't pretend to be a real preview either. Phase 2: extract
  // the first video frame as a poster image so video filter previews
  // are real previews too.
  filterPreviewSwatch: {
    flex: 1,
    backgroundColor: "#7c5fb0",
  },
  filterOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  },
  // Checkmark badge on the active filter tile. Floats at the top-right
  // corner with a small solid disc + white check icon so the user has
  // an unambiguous "this one is selected" cue beyond the ring/glow.
  filterActiveBadge: {
    position: "absolute",
    top: 4,
    right: 4,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: "#fff",
  },
  filterLabel: {
    marginTop: 8,
    color: "rgba(255, 255, 255, 0.7)",
    fontSize: 11,
    fontWeight: "600",
    textAlign: "center",
    letterSpacing: 0.3,
  },
});
