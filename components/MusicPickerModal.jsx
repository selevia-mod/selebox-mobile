import { Ionicons } from "@expo/vector-icons";
import { Audio } from "expo-av";
import { useEffect, useRef, useState } from "react";
import {
  Animated,
  FlatList,
  Image,
  InteractionManager,
  Platform,
  Pressable,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import Modal from "react-native-modal";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import useAppTheme from "../hooks/useAppTheme";
import {
  fetchTrendingAudiusTracks,
  getCachedAudiusSearch,
  getCachedTrendingAudius,
  searchAudiusTracks,
} from "../lib/audius";

// Audius-only premium music picker. Curated catalog tab was removed
// (May 2026); we surface Audius's three time windows as pill tabs:
//   • Trending → time=week    (what's hot right now)
//   • Hottest  → time=allTime (evergreen popular bangers)
//   • Latest   → time=month   (recently popular; closest proxy to
//                              "fresh" since Audius doesn't expose
//                              a true newest-first endpoint publicly).
const AUDIUS_TABS = [
  { key: "trending", label: "Trending", time: "week", icon: "flame" },
  { key: "hottest", label: "Hottest", time: "allTime", icon: "star" },
  { key: "latest", label: "Latest", time: "month", icon: "time" },
];

export default function MusicPickerModal({ isOpen, onClose, onSelect }) {
  const { theme } = useAppTheme();
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [musicList, setMusicList] = useState([]);
  const [filteredList, setFilteredList] = useState([]);
  const [searchText, setSearchText] = useState("");
  const [playingId, setPlayingId] = useState(null);
  // Active Audius tab. Switching refetches with the matching window.
  // Search overrides time-window tabs (search endpoint doesn't accept
  // `time`); the active tab is preserved visually but inert until the
  // query clears.
  const [audiusTab, setAudiusTab] = useState("trending");
  const audiusDebounceRef = useRef(null);
  const previewSound = useRef(null);

  // -----------------------------------------------------
  // Equalizer Animation (3 bars)
  // -----------------------------------------------------
  const eqBars = [
    useRef(new Animated.Value(1)).current,
    useRef(new Animated.Value(1)).current,
    useRef(new Animated.Value(1)).current,
  ];
  const eqLoops = useRef([]);

  const startEqualizer = () => {
    stopEqualizer();
    eqBars.forEach((anim, i) => {
      anim.setValue(1);
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(anim, { toValue: 0.3, duration: 300 + i * 80, useNativeDriver: true }),
          Animated.timing(anim, { toValue: 1, duration: 300 + i * 80, useNativeDriver: true }),
        ]),
      );
      eqLoops.current[i] = loop;
      loop.start();
    });
  };

  const stopEqualizer = () => {
    eqLoops.current.forEach((loop) => loop?.stop());
    eqBars.forEach((bar) => bar.setValue(1));
  };

  // -----------------------------------------------------
  // Fetch Music (Audius) — Stale-While-Revalidate
  // -----------------------------------------------------
  // SWR pattern fixes the slow-tab-open complaint: when the user
  // opens the picker (or switches tabs), we synchronously read from
  // the in-memory TTL cache in lib/audius.js and paint that list
  // immediately — no spinner. Then we kick off a network refresh in
  // the background; when it lands, we update the list.
  //
  // The fetchSeqRef guard handles tab/query changes mid-fetch — if a
  // newer fetch was issued while this one was in flight, we drop the
  // stale result instead of clobbering the user's current view.
  const fetchSeqRef = useRef(0);

  const fetchMusic = async (tabOverride = null, queryOverride = null) => {
    const tabKey = tabOverride || audiusTab;
    const tabConfig = AUDIUS_TABS.find((t) => t.key === tabKey) || AUDIUS_TABS[0];
    const term = (queryOverride !== null ? queryOverride : searchText).trim();
    const seq = ++fetchSeqRef.current;

    // 1) Instant paint from cache when we have it. Trending caches
    // by time-window; search caches by query+limit.
    const cached = term
      ? getCachedAudiusSearch(term, 25)
      : getCachedTrendingAudius(tabConfig.time);
    if (cached && cached.length > 0) {
      setMusicList(cached);
      setFilteredList(cached);
      setLoading(false);
    } else {
      // No cache → show skeleton.
      setLoading(true);
    }

    // 2) Background revalidate — always fire so the user sees fresh
    // results within ~1-3s of opening, even when cache rendered first.
    try {
      const list = term
        ? await searchAudiusTracks(term, { limit: 25 })
        : await fetchTrendingAudiusTracks({ limit: 25, time: tabConfig.time });

      // If a newer fetch superseded this one (user switched tabs or
      // typed more), drop the result.
      if (seq !== fetchSeqRef.current) return;

      // Only overwrite if we got fresh data; if the network returned
      // empty (all nodes failed), keep whatever the cache painted.
      if (list.length > 0 || !cached) {
        setMusicList(list);
        setFilteredList(list);
      }
    } catch (e) {
      console.log("[music picker] fetch error:", e);
    } finally {
      if (seq === fetchSeqRef.current) setLoading(false);
    }
  };

  // Hard-teardown for the active preview. stopAsync first (instant
  // silence) then unloadAsync (free the buffer). Both are awaited so
  // a follow-up createAsync doesn't race with the unload. We also
  // null-out the ref so a stale handle can't be reused.
  const teardownPreview = async () => {
    const s = previewSound.current;
    previewSound.current = null;
    stopEqualizer();
    setPlayingId(null);
    if (!s) return;
    try {
      await s.stopAsync();
    } catch (_) {}
    try {
      await s.unloadAsync();
    } catch (_) {}
  };

  useEffect(() => {
    if (isOpen) {
      // Skip the redundant re-render if search is already empty.
      // Calling setSearchText("") when it's already "" still
      // schedules a re-render of the entire modal during the slide-
      // in animation, which contributes to the perceived freeze.
      if (searchText) setSearchText("");

      // Defer the network/cache fetch + 25-row FlatList re-render
      // until AFTER the modal slide-in animation completes. This was
      // the main cause of the 1-2s freeze on reopen: fetchMusic ran
      // synchronously during the modal mount, triggering setMusicList
      // / setFilteredList / setLoading mid-animation while iOS was
      // also doing audio-session work (parent's pauseAsync).
      // runAfterInteractions queues this for the next idle frame.
      const handle = InteractionManager.runAfterInteractions(() => {
        fetchMusic(audiusTab, "");
      });
      return () => handle?.cancel?.();
    } else {
      // Modal closed — kill the preview NOW. The previous version
      // only did stopEqualizer + setPlayingId(null) here and relied
      // on the cleanup function for unload; that left the audio
      // object alive and audible until the next effect run.
      teardownPreview();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, audiusTab]);

  // Tab-prewarm: when the modal opens, kick off background fetches
  // for the OTHER two time windows so switching tabs feels instant.
  // Without this the user sees a 1-2s skeleton each time they tap a
  // new tab for the first time. We wait 800ms before firing so the
  // active-tab fetch dominates the network burst, then prewarm the
  // remaining tabs in parallel. Cache hits short-circuit immediately.
  //
  // We also skip the currently-active tab — its fetch is already in
  // flight from the other effect, and prewarming it would duplicate
  // the request (cache wouldn't be populated yet at the 800ms mark
  // if Audius is being slow).
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    const activeTabConfig = AUDIUS_TABS.find((t) => t.key === audiusTab);
    const timer = setTimeout(() => {
      if (cancelled) return;
      AUDIUS_TABS.forEach((tab) => {
        if (tab.key === activeTabConfig?.key) return; // active fetch already in flight
        if (getCachedTrendingAudius(tab.time)) return; // already warm
        // Fire-and-forget — fetcher writes to cache on success.
        // We swallow errors because a failed prewarm just means the
        // user falls back to the regular skeleton path on tab switch.
        fetchTrendingAudiusTracks({ limit: 25, time: tab.time }).catch(() => {});
      });
    }, 800);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isOpen, audiusTab]);

  // Belt-and-suspenders: on unmount, force teardown. Covers the case
  // where the parent unmounts the picker without flipping isOpen
  // first (e.g., navigating away from the editor mid-preview).
  useEffect(() => {
    return () => {
      const s = previewSound.current;
      previewSound.current = null;
      if (s) {
        s.stopAsync?.().catch(() => {});
        s.unloadAsync?.().catch(() => {});
      }
    };
  }, []);

  // -----------------------------------------------------
  // Search — debounced
  // -----------------------------------------------------
  const handleSearch = (text) => {
    setSearchText(text);
    if (audiusDebounceRef.current) clearTimeout(audiusDebounceRef.current);
    audiusDebounceRef.current = setTimeout(() => {
      fetchMusic(audiusTab, text);
    }, 300);
  };

  useEffect(() => {
    if (playingId) startEqualizer();
  }, [filteredList]);

  // -----------------------------------------------------
  // Play Preview
  // -----------------------------------------------------
  // setAudioModeAsync MUST run before createAsync — without
  // playsInSilentModeIOS=true, iOS phones in silent mode (most users)
  // create the sound but produce no audio. This was the "Audius
  // previews don't play" root cause.
  //
  // Tear down any prior sound BEFORE starting a new one (awaited).
  // Without the await, a fast tapper could leave two sounds playing
  // simultaneously while the prior one finishes unloading.
  //
  // We also set playingId optimistically to the tapped row so the UI
  // gives instant feedback (equalizer + highlight) even while the
  // network fetch is in-flight — that was the source of the "laggy
  // tap" feel; the audio session+stream URL fetch can take 200-500ms
  // and the row was sitting visually still during that window.
  const playPreview = async (item) => {
    if (playingId === item.$id) return; // already playing this row
    await teardownPreview();
    setPlayingId(item.$id);
    startEqualizer();
    try {
      await Audio.setAudioModeAsync({
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: true,
      });
      const { sound } = await Audio.Sound.createAsync({ uri: item.fileUrl }, { shouldPlay: true });
      // If the user tapped another row (or closed the modal) while we
      // were fetching, abandon this sound — playingId won't match.
      if (playingId === item.$id || previewSound.current === null) {
        previewSound.current = sound;
        // Auto-clear when the preview reaches the end so the
        // equalizer doesn't keep pulsing on a finished track.
        sound.setOnPlaybackStatusUpdate((status) => {
          if (status?.didJustFinish) {
            teardownPreview();
          }
        });
      } else {
        // Stale fetch — tear it down silently.
        try { await sound.stopAsync(); } catch (_) {}
        try { await sound.unloadAsync(); } catch (_) {}
      }
    } catch (err) {
      console.log("[music picker] preview error:", err);
      teardownPreview();
    }
  };

  // -----------------------------------------------------
  // Render Item — premium card
  // -----------------------------------------------------
  // Each row has THREE distinct tap targets and no full-row wrapper
  // (the previous Pressable wrapper caused tap conflicts with the
  // nested add button — `e.stopPropagation` is web syntax, doesn't
  // work in RN, so taps on add bubbled through and toggled preview):
  //   1. Play/pause button → preview only
  //   2. Add button        → select + close
  //   3. Title area press  → select + close (mirrors the add button
  //                           so users who tap the text get the
  //                           expected behavior)
  const renderItem = ({ item, index }) => {
    const isPlaying = playingId === item.$id;
    const position = index + 1;

    const handleSelect = async () => {
      await teardownPreview();
      onSelect(item);
      onClose();
    };

    return (
      <View
        style={{
          marginBottom: 8,
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 10,
          paddingVertical: 10,
          borderRadius: 16,
          backgroundColor: isPlaying ? theme.accentPurpleSoft : theme.surfaceMuted,
          borderWidth: 1,
          borderColor: isPlaying ? theme.accentPurple : "transparent",
        }}
      >
        {/* Position numeral */}
        <View style={{ width: 22, alignItems: "center", marginRight: 8 }}>
          <Text
            style={{
              color: isPlaying ? theme.accentPurple : theme.textSoft,
              fontWeight: "700",
              fontSize: 13,
              opacity: isPlaying ? 1 : 0.6,
              fontVariant: ["tabular-nums"],
            }}
          >
            {position}
          </Text>
        </View>

        {/* Thumbnail — also a tap target for select. Bigger hit
            surface than the small add button on the right. */}
        <Pressable
          onPress={handleSelect}
          style={({ pressed }) => ({
            width: 56,
            height: 56,
            borderRadius: 12,
            overflow: "hidden",
            marginRight: 12,
            ...(Platform.OS === "ios"
              ? {
                  shadowColor: "#000",
                  shadowOffset: { width: 0, height: 2 },
                  shadowOpacity: 0.15,
                  shadowRadius: 4,
                }
              : { elevation: 2 }),
            borderWidth: isPlaying ? 2 : 0,
            borderColor: theme.accentPurple,
            opacity: pressed ? 0.75 : 1,
          })}
        >
          {item.thumbnailUrl ? (
            <Image source={{ uri: item.thumbnailUrl }} style={{ width: "100%", height: "100%" }} />
          ) : (
            <View
              style={{
                width: "100%",
                height: "100%",
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: theme.accentPurpleSoft,
              }}
            >
              <Ionicons name="musical-notes" size={22} color={theme.accentPurple} />
            </View>
          )}
        </Pressable>

        {/* Title / Artist — pressing selects (mirrors thumbnail). */}
        <Pressable
          onPress={handleSelect}
          style={({ pressed }) => ({ flex: 1, marginRight: 8, opacity: pressed ? 0.6 : 1 })}
        >
          <Text
            numberOfLines={1}
            style={{
              fontSize: 15,
              fontWeight: "600",
              color: isPlaying ? theme.accentPurple : theme.text,
              marginBottom: 2,
            }}
          >
            {item.title}
          </Text>
          <Text numberOfLines={1} style={{ fontSize: 12, color: theme.textSoft }}>
            {item.artist}
          </Text>
        </Pressable>

        {/* Dedicated play / pause button — preview only */}
        <TouchableOpacity
          onPress={() => (isPlaying ? teardownPreview() : playPreview(item))}
          hitSlop={8}
          activeOpacity={0.7}
          style={{
            width: 36,
            height: 36,
            borderRadius: 18,
            alignItems: "center",
            justifyContent: "center",
            marginRight: 8,
            backgroundColor: isPlaying ? theme.accentPurple : "transparent",
          }}
          accessibilityRole="button"
          accessibilityLabel={isPlaying ? `Stop preview of ${item.title}` : `Preview ${item.title}`}
        >
          {isPlaying ? (
            <View style={{ flexDirection: "row", alignItems: "flex-end", height: 14 }}>
              {eqBars.map((anim, idx) => (
                <Animated.View
                  key={idx}
                  style={{
                    width: 2.5,
                    height: 12,
                    marginHorizontal: 1,
                    borderRadius: 2,
                    backgroundColor: "#fff",
                    transform: [{ scaleY: anim }],
                  }}
                />
              ))}
            </View>
          ) : (
            <Ionicons name="play" size={18} color={theme.icon} />
          )}
        </TouchableOpacity>

        {/* Add / Use button — select + close */}
        <TouchableOpacity
          onPress={handleSelect}
          hitSlop={10}
          activeOpacity={0.7}
          style={{
            width: 34,
            height: 34,
            borderRadius: 17,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: theme.accentPurple,
          }}
          accessibilityRole="button"
          accessibilityLabel={`Use ${item.title}`}
        >
          <Ionicons name="checkmark" size={18} color="#fff" />
        </TouchableOpacity>
      </View>
    );
  };

  // -----------------------------------------------------
  // Skeleton row — smoother than a single spinner. Renders 6 grey
  // placeholders that match the shape of a track row.
  // -----------------------------------------------------
  const Skeleton = () => (
    <View style={{ paddingTop: 4 }}>
      {[...Array(6)].map((_, i) => (
        <View
          key={i}
          style={{
            marginBottom: 8,
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: 10,
            paddingVertical: 10,
            borderRadius: 16,
            backgroundColor: theme.surfaceMuted,
            opacity: 0.6,
          }}
        >
          <View style={{ width: 22, marginRight: 8 }} />
          <View style={{ width: 56, height: 56, borderRadius: 12, backgroundColor: theme.surface, marginRight: 12 }} />
          <View style={{ flex: 1 }}>
            <View style={{ height: 12, width: "70%", borderRadius: 6, backgroundColor: theme.surface, marginBottom: 6 }} />
            <View style={{ height: 10, width: "40%", borderRadius: 5, backgroundColor: theme.surface }} />
          </View>
          <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: theme.surface }} />
        </View>
      ))}
    </View>
  );

  const searchActive = searchText.trim().length > 0;

  // -----------------------------------------------------
  // Main UI — premium glass sheet
  // -----------------------------------------------------
  return (
    <Modal
      isVisible={isOpen}
      onBackdropPress={onClose}
      onSwipeComplete={onClose}
      swipeDirection={["down"]}
      propagateSwipe
      backdropOpacity={0.55}
      style={{ justifyContent: "flex-end", margin: 0 }}
      useNativeDriver
      hideModalContentWhileAnimating
      animationIn="slideInUp"
      animationOut="slideOutDown"
    >
      <View
        style={{
          height: "82%",
          borderTopLeftRadius: 28,
          borderTopRightRadius: 28,
          overflow: "hidden",
          backgroundColor: theme.surfaceElevated,
        }}
      >
        {/* BlurView was removed (May 2026) — it caused a measurable
            1-2s freeze on reopen because the iOS blur layer behind a
            25-item FlatList with shadows + images is expensive to
            recompose every animation frame. The solid surfaceElevated
            background looks ~identical against the dimmed backdrop. */}

        <View style={{ flex: 1, paddingHorizontal: 18, paddingTop: 10, paddingBottom: insets.bottom + 12 }}>
          {/* Drag handle */}
          <View style={{ alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: theme.border, marginBottom: 14 }} />

          {/* Header — title + close */}
          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 12 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 20, fontWeight: "700", color: theme.text }}>Add music</Text>
              <Text style={{ fontSize: 12, color: theme.textSoft, marginTop: 2 }}>
                Powered by Audius · royalty-free
              </Text>
            </View>
            <TouchableOpacity
              onPress={onClose}
              hitSlop={10}
              style={{
                width: 32,
                height: 32,
                borderRadius: 16,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: theme.surfaceMuted,
              }}
              accessibilityRole="button"
              accessibilityLabel="Close music picker"
            >
              <Ionicons name="close" size={18} color={theme.icon} />
            </TouchableOpacity>
          </View>

          {/* Premium pill tabs — active pill gets the accent fill,
              inactive stays glass-muted. Pill design (vs underline)
              reads more contemporary on a sheet. */}
          <View
            style={{
              flexDirection: "row",
              padding: 4,
              borderRadius: 14,
              backgroundColor: theme.surfaceMuted,
              marginBottom: 14,
            }}
          >
            {AUDIUS_TABS.map((tab) => {
              const active = audiusTab === tab.key;
              return (
                <TouchableOpacity
                  key={tab.key}
                  onPress={() => {
                    if (audiusTab !== tab.key) {
                      teardownPreview();
                      setAudiusTab(tab.key);
                    }
                  }}
                  style={{
                    flex: 1,
                    paddingVertical: 9,
                    borderRadius: 10,
                    alignItems: "center",
                    flexDirection: "row",
                    justifyContent: "center",
                    backgroundColor: active ? theme.accentPurple : "transparent",
                    opacity: searchActive && !active ? 0.5 : 1,
                  }}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: active }}
                >
                  <Ionicons
                    name={tab.icon}
                    size={13}
                    color={active ? "#fff" : theme.textSoft}
                    style={{ marginRight: 6 }}
                  />
                  <Text
                    style={{
                      fontSize: 13,
                      fontWeight: "700",
                      color: active ? "#fff" : theme.textSoft,
                    }}
                  >
                    {tab.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Search — glass capsule with focus highlight via accent border */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              borderRadius: 14,
              paddingHorizontal: 12,
              paddingVertical: Platform.OS === "ios" ? 10 : 4,
              marginBottom: 12,
              borderWidth: 1,
              borderColor: searchActive ? theme.accentPurple : theme.border,
              backgroundColor: theme.inputBackground,
            }}
          >
            <Ionicons name="search" size={17} color={searchActive ? theme.accentPurple : theme.iconMuted} />
            <TextInput
              placeholder="Search artists, tracks, vibes…"
              placeholderTextColor={theme.placeholder}
              value={searchText}
              onChangeText={handleSearch}
              style={{ flex: 1, marginLeft: 10, color: theme.inputText, fontSize: 14 }}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
            />
            {searchText.length > 0 && (
              <TouchableOpacity
                onPress={() => {
                  setSearchText("");
                  if (audiusDebounceRef.current) clearTimeout(audiusDebounceRef.current);
                  fetchMusic(audiusTab, "");
                  if (!playingId) stopEqualizer();
                }}
                hitSlop={10}
                style={{ paddingLeft: 6 }}
              >
                <Ionicons name="close-circle" size={18} color={theme.iconMuted} />
              </TouchableOpacity>
            )}
          </View>

          {/* Now-playing strip — only when a preview is active. Lets
              the user stop without scrolling back to the row. */}
          {playingId ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                backgroundColor: theme.accentPurpleSoft,
                borderRadius: 12,
                paddingHorizontal: 12,
                paddingVertical: 8,
                marginBottom: 10,
                borderWidth: 1,
                borderColor: theme.accentPurple,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "flex-end", marginRight: 10, height: 14 }}>
                {eqBars.map((anim, idx) => (
                  <Animated.View
                    key={idx}
                    style={{
                      width: 3,
                      height: 12,
                      marginHorizontal: 1.5,
                      borderRadius: 2,
                      backgroundColor: theme.accentPurple,
                      transform: [{ scaleY: anim }],
                    }}
                  />
                ))}
              </View>
              <Text numberOfLines={1} style={{ flex: 1, color: theme.accentPurple, fontWeight: "600", fontSize: 12 }}>
                Previewing — tap a row again to stop
              </Text>
              <TouchableOpacity onPress={teardownPreview} hitSlop={10}>
                <Ionicons name="stop-circle" size={20} color={theme.accentPurple} />
              </TouchableOpacity>
            </View>
          ) : null}

          {/* List */}
          {loading ? (
            <Skeleton />
          ) : (
            <FlatList
              data={filteredList}
              keyExtractor={(item) => item.$id}
              renderItem={renderItem}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ paddingBottom: 24 }}
              // Perf tuning — only render what's visible on first
              // paint. Rendering all 25 rows up-front (with image
              // decode + shadow + 4 nested touchables each) was
              // contributing to the reopen freeze. windowSize=5 keeps
              // ~5 screens worth in memory; removeClippedSubviews
              // unmounts off-screen rows so scrolling stays smooth.
              initialNumToRender={6}
              maxToRenderPerBatch={6}
              windowSize={5}
              removeClippedSubviews={Platform.OS === "android"}
              ListEmptyComponent={
                <View style={{ alignItems: "center", justifyContent: "center", paddingVertical: 40 }}>
                  <View
                    style={{
                      width: 64,
                      height: 64,
                      borderRadius: 32,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: theme.surfaceMuted,
                      marginBottom: 12,
                    }}
                  >
                    <Ionicons
                      name={searchActive ? "search-outline" : "cloud-offline-outline"}
                      size={28}
                      color={theme.iconMuted}
                    />
                  </View>
                  <Text style={{ fontSize: 14, fontWeight: "600", color: theme.text, marginBottom: 4 }}>
                    {searchActive ? "No matches" : "Couldn't load tracks"}
                  </Text>
                  <Text style={{ fontSize: 12, color: theme.textSoft, textAlign: "center", maxWidth: 240, marginBottom: 14 }}>
                    {searchActive
                      ? `Try a different keyword. Audius has 100M+ tracks — something will fit.`
                      : `Audius nodes can be flaky. Tap retry — we'll rotate to a healthy one.`}
                  </Text>
                  <TouchableOpacity
                    onPress={() => fetchMusic(audiusTab, searchText)}
                    style={{
                      paddingHorizontal: 18,
                      paddingVertical: 9,
                      borderRadius: 999,
                      backgroundColor: theme.accentPurple,
                      flexDirection: "row",
                      alignItems: "center",
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Retry Audius"
                  >
                    <Ionicons name="refresh" size={14} color="#fff" style={{ marginRight: 6 }} />
                    <Text style={{ color: "#fff", fontWeight: "700", fontSize: 13 }}>Retry</Text>
                  </TouchableOpacity>
                </View>
              }
            />
          )}
        </View>
      </View>
    </Modal>
  );
}
