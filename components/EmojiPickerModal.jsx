// EmojiPickerModal — bottom-sheet picker with two tabs (Emoji /
// Stickers) for the Moments editor. Same architectural pattern as
// LinkPickerModal / GifPickerModal — uses react-native-modal with
// avoidKeyboard so the sheet sits cleanly above any keyboard.
//
// EMOJI tab: curated 56-glyph keyboard. Caller decides what tap means
// (insert into active text vs drop as text-overlay sticker) via the
// onPickEmoji prop.
//
// STICKERS tab: Giphy stickers endpoint — animated transparent PNGs/
// GIFs that act as decorative overlays. Reuses the same handlePickGif
// drop pipeline that the GIF rail button uses, so caller passes the
// sticker URL through onPickSticker and treats it as a GIF
// internally.

import { Feather, Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import FastImage from "react-native-fast-image";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from "react-native";
import RNModal from "react-native-modal";
import { searchGiphyStickers } from "../lib/giphy";

const GLASS_INTENSITY = 60;
const GLASS_TINT = "dark";

// Curated emoji set. Order roughly matches iOS's native keyboard
// "smileys" tab so users find what they expect quickly. Includes
// faces, hearts, hands, and celebration / mood emojis. 56 entries
// fits ~9 rows in a 6-column grid — enough variety, not overwhelming.
const EMOJIS = [
  "😀", "😂", "🥹", "😍", "😘", "😎", "🤩", "🥳",
  "😭", "😢", "🥺", "😡", "🤔", "😴", "🤯", "🫶",
  "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍",
  "💖", "💞", "💕", "💔", "✨", "🌟", "⭐️", "🔥",
  "👍", "👎", "👏", "🙏", "💪", "🤝", "🫰", "🫡",
  "🎉", "🎊", "🎁", "🥂", "🍾", "🌹", "🌸", "🌈",
  "📚", "📖", "✍️", "🎨", "🎵", "🎶", "🎬", "🎤",
];

const EmojiPickerModal = ({ visible, onClose, onPickEmoji, onPickSticker, theme, headerHint }) => {
  const [tab, setTab] = useState("emoji"); // "emoji" | "sticker"
  const [stickers, setStickers] = useState([]);
  const [loadingStickers, setLoadingStickers] = useState(false);
  // Sticker search query — empty string = trending. Debounced 250ms
  // (same cadence as GifPickerModal) so typing doesn't fan out one
  // request per keystroke.
  const [stickerQuery, setStickerQuery] = useState("");
  const debounceRef = useRef(null);
  const { width: screenWidth } = useWindowDimensions();

  // Sticker fetch — runs whenever the user opens the Stickers tab OR
  // changes the search query. Empty query = trending. Both paths use
  // searchGiphyStickers (which falls back to trending internally when
  // the query is blank). Debounced 250ms so a fast typer doesn't burn
  // through Giphy quota; cancellation guard prevents stale results
  // overwriting fresh ones if the user types another character mid-
  // request.
  useEffect(() => {
    if (!visible || tab !== "sticker") return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    let cancelled = false;
    setLoadingStickers(true);
    debounceRef.current = setTimeout(async () => {
      const rows = await searchGiphyStickers(stickerQuery, { limit: 30 });
      if (cancelled) return;
      setStickers(rows || []);
      setLoadingStickers(false);
    }, 250);
    return () => {
      cancelled = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [visible, tab, stickerQuery]);

  // Sticker grid: 3 columns of square tiles. Width is computed off the
  // screen width so it scales with device — phones get 3 columns,
  // tablets would too (the modal is bottom-anchored, not full-width).
  const stickerSize = Math.floor((screenWidth - 16 * 2 - 8 * 2) / 3);

  return (
    // propagateSwipe lets the inner ScrollView receive vertical scroll
    // gestures while RNModal still listens for swipes on non-scroll
    // areas (handle, header). Without this, RNModal's swipeDirection
    // intercepts the scroll-down gesture and the user can't see emojis
    // / stickers past the visible viewport.
    <RNModal
      isVisible={visible}
      onBackdropPress={onClose}
      onSwipeComplete={onClose}
      swipeDirection={["down"]}
      propagateSwipe
      style={{ margin: 0, justifyContent: "flex-end" }}
      avoidKeyboard
      useNativeDriverForBackdrop
      backdropOpacity={0.55}
      animationIn="slideInUp"
      animationOut="slideOutDown"
      animationInTiming={260}
      animationOutTiming={220}
    >
      <View style={styles.sheet}>
        <BlurView intensity={GLASS_INTENSITY} tint={GLASS_TINT} style={StyleSheet.absoluteFill} />
        <View>
          {/* Drag handle */}
          <View style={styles.handle} />

          <View style={styles.headerRow}>
            <View style={styles.headerIcon}>
              <Text style={{ fontSize: 16 }}>✨</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>Emojis & Stickers</Text>
              {headerHint ? <Text style={styles.subtitle}>{headerHint}</Text> : null}
            </View>
            <Pressable onPress={onClose} hitSlop={8} style={styles.closeBtn}>
              <Ionicons name="close" size={18} color="#fff" />
            </Pressable>
          </View>

          {/* Tab pills — segmented control style. Active tab fills with
              theme.primary; inactive sits flat on the glass.
              Centered so the row doesn't fight for full width. */}
          <View style={styles.tabsRow}>
            <Pressable
              onPress={() => setTab("emoji")}
              style={({ pressed }) => [
                styles.tab,
                tab === "emoji" && { backgroundColor: theme?.primary || "#7975D4" },
                pressed && { opacity: 0.85 },
              ]}
              accessibilityState={{ selected: tab === "emoji" }}
            >
              <Text style={styles.tabIcon}>😀</Text>
              <Text style={styles.tabLabel}>Emoji</Text>
            </Pressable>
            <Pressable
              onPress={() => setTab("sticker")}
              style={({ pressed }) => [
                styles.tab,
                tab === "sticker" && { backgroundColor: theme?.primary || "#7975D4" },
                pressed && { opacity: 0.85 },
              ]}
              accessibilityState={{ selected: tab === "sticker" }}
            >
              <Feather name="image" size={14} color="#fff" />
              <Text style={styles.tabLabel}>Stickers</Text>
            </Pressable>
          </View>

          {tab === "emoji" ? (
            <ScrollView
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.gridContent}
              style={styles.grid}
              keyboardShouldPersistTaps="always"
              nestedScrollEnabled
            >
              <View style={styles.gridRow}>
                {EMOJIS.map((emoji, idx) => (
                  <Pressable
                    key={`${idx}-${emoji}`}
                    onPress={() => onPickEmoji?.(emoji)}
                    hitSlop={4}
                    style={({ pressed }) => [
                      styles.emojiItem,
                      pressed && { transform: [{ scale: 0.85 }], opacity: 0.7 },
                    ]}
                    accessibilityLabel={`Pick ${emoji}`}
                  >
                    <Text style={styles.emojiText}>{emoji}</Text>
                  </Pressable>
                ))}
              </View>
            </ScrollView>
          ) : (
            <View>
              {/* Sticker search — visible only on the Stickers tab.
                  Debounced 250ms in the effect above; empty string
                  shows trending. Glass background matches the rest of
                  the modal chrome. Clear (X) button when the field has
                  content so users can return to trending without
                  manually deleting the query. */}
              <View style={styles.searchWrap}>
                <Feather name="search" size={16} color="rgba(255,255,255,0.7)" style={{ marginLeft: 12 }} />
                <TextInput
                  style={styles.searchInput}
                  value={stickerQuery}
                  onChangeText={setStickerQuery}
                  placeholder="Search stickers"
                  placeholderTextColor="rgba(255,255,255,0.5)"
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="search"
                  selectionColor={theme?.primary || "#7975D4"}
                />
                {stickerQuery ? (
                  <Pressable onPress={() => setStickerQuery("")} hitSlop={8} style={styles.searchClear}>
                    <Ionicons name="close-circle" size={18} color="rgba(255,255,255,0.55)" />
                  </Pressable>
                ) : null}
              </View>

              <ScrollView
                showsVerticalScrollIndicator={false}
                contentContainerStyle={styles.gridContent}
                style={styles.grid}
                keyboardShouldPersistTaps="always"
                nestedScrollEnabled
              >
                {loadingStickers ? (
                  <View style={styles.stickerLoading}>
                    <ActivityIndicator color="#fff" />
                  </View>
                ) : stickers.length === 0 ? (
                  <Text style={styles.stickerEmpty}>
                    {stickerQuery
                      ? `No stickers found for "${stickerQuery}". Try another search.`
                      : "No stickers available. Check that GIPHY_API_KEY is set in private/secrets.js."}
                  </Text>
                ) : (
                  <View style={styles.stickerGrid}>
                    {stickers.map((s) => (
                      <Pressable
                        key={s.id}
                        onPress={() => onPickSticker?.(s.gifUrl)}
                        style={({ pressed }) => [
                          { width: stickerSize, height: stickerSize },
                          styles.stickerItem,
                          pressed && { transform: [{ scale: 0.92 }], opacity: 0.8 },
                        ]}
                        accessibilityLabel="Pick sticker"
                      >
                        <FastImage
                          source={{ uri: s.previewUrl, priority: FastImage.priority.normal }}
                          style={{ width: "100%", height: "100%" }}
                          resizeMode={FastImage.resizeMode.contain}
                        />
                      </Pressable>
                    ))}
                  </View>
                )}
              </ScrollView>
            </View>
          )}
        </View>
      </View>
    </RNModal>
  );
};

const styles = StyleSheet.create({
  sheet: {
    overflow: "hidden",
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingBottom: 32,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255, 255, 255, 0.16)",
  },
  handle: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(255, 255, 255, 0.35)",
    marginTop: 10,
    marginBottom: 16,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    gap: 10,
    marginBottom: 12,
  },
  headerIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255, 255, 255, 0.12)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255, 255, 255, 0.2)",
  },
  title: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
  subtitle: {
    color: "rgba(255, 255, 255, 0.65)",
    fontSize: 12,
    marginTop: 2,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255, 255, 255, 0.12)",
  },
  tabsRow: {
    flexDirection: "row",
    alignSelf: "center",
    gap: 6,
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    borderRadius: 16,
    padding: 4,
    marginBottom: 14,
  },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: 12,
  },
  tabIcon: {
    fontSize: 14,
  },
  tabLabel: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  // Search input wrapper — appears above the sticker grid. Glass
  // background matches the rest of the modal chrome. Matches the
  // GifPickerModal search input layout for consistency.
  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 16,
    marginBottom: 12,
    backgroundColor: "rgba(255, 255, 255, 0.10)",
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255, 255, 255, 0.16)",
  },
  searchInput: {
    flex: 1,
    paddingHorizontal: 10,
    paddingVertical: 10,
    color: "#fff",
    fontSize: 14,
  },
  searchClear: {
    padding: 10,
  },
  // Bounded scroll height — caps the modal at ~360pt so it doesn't
  // dominate the screen on small devices. propagateSwipe (RNModal
  // prop above) lets the user actually scroll inside this without
  // the swipe-to-dismiss gesture intercepting.
  grid: {
    maxHeight: 360,
  },
  gridContent: {
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  gridRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-start",
    gap: 8,
  },
  // 48dp emoji tap target with subtle background fill so each cell
  // reads as interactive vs free-floating text.
  emojiItem: {
    width: 48,
    height: 48,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255, 255, 255, 0.10)",
  },
  emojiText: {
    fontSize: 26,
    lineHeight: 32,
  },
  // Sticker grid — 3 columns. Width is computed at the call site to
  // match (screenWidth - paddings - gaps) / 3.
  stickerGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    justifyContent: "flex-start",
  },
  stickerItem: {
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    alignItems: "center",
    justifyContent: "center",
    padding: 6,
  },
  stickerLoading: {
    paddingVertical: 60,
    alignItems: "center",
    justifyContent: "center",
  },
  stickerEmpty: {
    color: "rgba(255, 255, 255, 0.65)",
    fontSize: 12,
    textAlign: "center",
    paddingHorizontal: 24,
    paddingVertical: 40,
    lineHeight: 18,
  },
});

export default EmojiPickerModal;
