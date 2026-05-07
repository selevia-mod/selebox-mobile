// components/GifPickerModal.jsx — shared Giphy picker modal.
//
// Originally lived inline in SupabaseThread.jsx for chat composer use.
// Promoted to a top-level component so the Moments editor
// (story-preview.jsx) can render the same picker without duplicating
// the search-debounce + grid-render code.
//
// Behavior:
//   • visible=true → fetches trending on mount, debounces search.
//   • Query change → debounced search (250ms) hits Giphy API via
//     lib/giphy.js#searchGiphyGifs (existing wrapper).
//   • Tapping a tile → onPick(gifUrl) callback. Caller decides what
//     to do with it (chat sends as a message; Moments adds it as a
//     draggable overlay).
//   • onClose → hide modal.
//
// API key must be set in `private/secrets.js` as GIPHY_API_KEY for
// the wrapper to return results. Without it the modal renders an
// "unavailable" empty state — same fallback web uses.

import { Feather } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import { FlatList, Image as RNImage, Modal, Text, TextInput, TouchableOpacity, View } from "react-native";
import { searchGiphyGifs } from "../lib/giphy";

export default function GifPickerModal({ visible, onClose, onPick, theme }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef(null);

  // On open, fetch trending. On query change, debounced search. The
  // debounce timer is cleared on unmount + visibility flip so we don't
  // fire a stale request after the user closes the modal.
  useEffect(() => {
    if (!visible) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      const r = await searchGiphyGifs(query, { limit: 24 });
      setResults(r);
      setLoading(false);
    }, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [visible, query]);

  return (
    <Modal visible={visible} animationType="slide" transparent={true} onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" }}>
        <View style={{ backgroundColor: theme.background, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: "75%", padding: 12 }}>
          <View className="flex-row items-center pb-3">
            <Text className="font-pbold text-base flex-1" style={{ color: theme.text }}>
              Pick a GIF
            </Text>
            <TouchableOpacity onPress={onClose} className="h-8 w-8 items-center justify-center rounded-full" style={{ backgroundColor: theme.surfaceMuted }}>
              <Feather name="x" size={16} color={theme.icon} />
            </TouchableOpacity>
          </View>

          <View
            className="flex-row items-center rounded-2xl px-3 mb-2"
            style={{ borderWidth: 1, borderColor: theme.inputBorder, backgroundColor: theme.inputBackground }}
          >
            <Feather name="search" size={16} color={theme.iconMuted} />
            <TextInput
              className="ml-2 flex-1 py-2 text-sm"
              placeholder="Search Giphy"
              placeholderTextColor={theme.placeholder}
              style={{ color: theme.inputText }}
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          {loading ? (
            <View className="items-center justify-center py-10">
              <Text className="text-sm" style={{ color: theme.textSoft }}>Loading…</Text>
            </View>
          ) : results.length === 0 ? (
            <View className="items-center justify-center py-10">
              <Text className="text-sm text-center" style={{ color: theme.textSoft }}>
                {query ? "No GIFs found." : "GIF picker is unavailable. Set GIPHY_API_KEY in private/secrets.js."}
              </Text>
            </View>
          ) : (
            <FlatList
              data={results}
              numColumns={2}
              keyExtractor={(item) => item.id}
              columnWrapperStyle={{ gap: 8 }}
              contentContainerStyle={{ gap: 8, paddingBottom: 24 }}
              renderItem={({ item }) => (
                <TouchableOpacity
                  onPress={() => onPick(item.gifUrl)}
                  activeOpacity={0.85}
                  style={{ flex: 1, aspectRatio: 1, backgroundColor: theme.surfaceMuted, borderRadius: 12, overflow: "hidden" }}
                >
                  <RNImage source={{ uri: item.previewUrl }} style={{ width: "100%", height: "100%" }} resizeMode="cover" />
                </TouchableOpacity>
              )}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}
