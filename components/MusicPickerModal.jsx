import { Ionicons } from "@expo/vector-icons";
import { Audio } from "expo-av";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Animated, FlatList, Image, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Query } from "react-native-appwrite";
import Modal from "react-native-modal";
import useAppTheme from "../hooks/useAppTheme";
import { appwriteConfig, databases } from "../lib/appwrite";

export default function MusicPickerModal({ isOpen, onClose, onSelect }) {
  const { theme } = useAppTheme();
  const [loading, setLoading] = useState(true);
  const [musicList, setMusicList] = useState([]); // full list
  const [filteredList, setFilteredList] = useState([]); // UI-render list
  const [searchText, setSearchText] = useState("");
  const [offset, setOffset] = useState(0);
  const [playingId, setPlayingId] = useState(null);

  const previewSound = useRef(null);
  const limit = 20;

  // -----------------------------------------------------
  // Equalizer Animation (3 bars similar to SelectedMusicBadge)
  // -----------------------------------------------------
  const eqBars = [useRef(new Animated.Value(1)).current, useRef(new Animated.Value(1)).current, useRef(new Animated.Value(1)).current];
  const eqLoops = useRef([]);

  const startEqualizer = () => {
    stopEqualizer(); // stop old loops

    eqBars.forEach((anim, i) => {
      anim.setValue(1);

      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(anim, {
            toValue: 0.3,
            duration: 300 + i * 80,
            useNativeDriver: true,
          }),
          Animated.timing(anim, {
            toValue: 1,
            duration: 300 + i * 80,
            useNativeDriver: true,
          }),
        ]),
      );

      eqLoops.current[i] = loop;
      loop.start();
    });
  };

  const stopEqualizer = () => {
    eqLoops.current.forEach((loop) => loop?.stop());
    eqBars.forEach((bar) => bar.setValue(1)); // reset bars
  };

  // -----------------------------------------------------
  // Fetch Music (Paginated)
  // -----------------------------------------------------
  const fetchMusic = async (reset = false) => {
    try {
      if (reset) {
        setLoading(true);
        setOffset(0);
      }

      const res = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.storyMusicCollectionId, [
        Query.equal("isActive", true),
        Query.limit(limit),
        Query.offset(reset ? 0 : offset),
      ]);

      const docs = res.documents || [];
      const newList = reset ? docs : [...musicList, ...docs];

      setMusicList(newList);

      // Apply search filter after load
      if (searchText.trim()) {
        const lower = searchText.toLowerCase();
        const filtered = newList.filter((m) => m.title.toLowerCase().includes(lower) || m.artist.toLowerCase().includes(lower));
        setFilteredList(filtered);
      } else {
        setFilteredList(newList);
      }

      setOffset((prev) => prev + limit);
    } catch (e) {
      console.log("fetch error:", e);
    } finally {
      setLoading(false);
    }
  };

  // Load on open
  useEffect(() => {
    if (isOpen) {
      fetchMusic(true);
    } else {
      stopEqualizer();
      setPlayingId(null);
    }
    return () => previewSound.current?.unloadAsync();
  }, [isOpen]);

  // -----------------------------------------------------
  // Search
  // -----------------------------------------------------
  const handleSearch = (text) => {
    setSearchText(text);

    if (!text.trim()) {
      setFilteredList(musicList);
      return;
    }

    const lower = text.toLowerCase();
    const filtered = musicList.filter((m) => m.title.toLowerCase().includes(lower) || m.artist.toLowerCase().includes(lower));

    setFilteredList(filtered);
  };

  // Restart equalizer when list changes while a song is playing
  useEffect(() => {
    if (playingId) {
      startEqualizer();
    }
  }, [filteredList]);

  // -----------------------------------------------------
  // Play Preview
  // -----------------------------------------------------
  const playPreview = async (item) => {
    try {
      previewSound.current?.unloadAsync();

      const { sound } = await Audio.Sound.createAsync({ uri: item.fileUrl }, { shouldPlay: true });
      previewSound.current = sound;

      setPlayingId(item.$id);
      startEqualizer();
    } catch (err) {
      console.log("preview error:", err);
    }
  };

  // -----------------------------------------------------
  // Render Item
  // -----------------------------------------------------
  const renderItem = ({ item }) => {
    const isPlaying = playingId === item.$id;

    return (
      <View className="mb-2 flex-row items-center rounded-xl px-2 py-3" style={{ backgroundColor: theme.surfaceMuted }}>
        {/* Thumbnail */}
        {item.thumbnailUrl ? (
          <Image source={{ uri: item.thumbnailUrl }} style={{ width: 55, height: 55, borderRadius: 8, marginRight: 10 }} />
        ) : (
          <View className="mr-3 h-[55px] w-[55px] items-center justify-center rounded-xl" style={{ backgroundColor: theme.accentPurpleSoft }}>
            <Ionicons name="musical-notes" size={22} color={theme.accentPurple} />
          </View>
        )}

        {/* Title / Artist */}
        <View style={{ flex: 1 }}>
          <Text className="text-[16px] font-semibold" style={{ color: theme.text }}>
            {item.title}
          </Text>
          <Text className="text-[12px]" style={{ color: theme.textSoft }}>
            {item.artist}
          </Text>
        </View>

        {/* Equalizer / Play Button */}
        {isPlaying ? (
          <View className="mr-4 flex-row items-end">
            {eqBars.map((anim, idx) => (
              <Animated.View
                key={idx}
                style={{
                  width: 3,
                  height: 12,
                  marginHorizontal: 1,
                  borderRadius: 2,
                  backgroundColor: theme.accentPurple,
                  transform: [{ scaleY: anim }],
                }}
              />
            ))}
          </View>
        ) : (
          <TouchableOpacity onPress={() => playPreview(item)}>
            <Ionicons name="play-circle" size={28} color={theme.icon} style={{ marginRight: 10 }} />
          </TouchableOpacity>
        )}

        {/* Select Button */}
        <TouchableOpacity
          onPress={() => {
            stopEqualizer();
            previewSound.current?.unloadAsync();
            onSelect(item);
            onClose();
          }}
        >
          <Ionicons name="add-circle" size={28} color="#4cd964" />
        </TouchableOpacity>
      </View>
    );
  };

  // -----------------------------------------------------
  // Main UI
  // -----------------------------------------------------
  return (
    <Modal isVisible={isOpen} onBackdropPress={onClose}>
      <View className="h-[500px] rounded-2xl p-5" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surfaceElevated }}>
        <Text className="mb-3 text-xl font-semibold" style={{ color: theme.text }}>
          Select Music
        </Text>

        {/* Search Box */}
        <View className="mb-3 flex-row items-center rounded-lg px-3 py-2" style={{ backgroundColor: theme.inputBackground }}>
          <Ionicons name="search" size={18} color={theme.iconMuted} />
          <TextInput
            placeholder="Search music..."
            placeholderTextColor={theme.placeholder}
            value={searchText}
            onChangeText={handleSearch}
            className="ml-2 flex-1"
            style={{ color: theme.inputText }}
          />
          {searchText.length > 0 && (
            <TouchableOpacity
              onPress={() => {
                setSearchText("");
                setFilteredList(musicList);
                stopEqualizer();
                if (playingId) startEqualizer(); // keep animation if preview still playing
              }}
              className="p-1"
            >
              <Ionicons name="close-circle" size={18} color={theme.iconMuted} />
            </TouchableOpacity>
          )}
        </View>

        {loading ? (
          <ActivityIndicator color={theme.primary} />
        ) : (
          <FlatList
            data={filteredList}
            keyExtractor={(item) => item.$id}
            renderItem={renderItem}
            onEndReached={() => fetchMusic(false)}
            onEndReachedThreshold={0.35}
            ListFooterComponent={
              filteredList.length >= limit && (
                <View className="py-3">
                  <ActivityIndicator color={theme.primary} />
                </View>
              )
            }
          />
        )}
      </View>
    </Modal>
  );
}
