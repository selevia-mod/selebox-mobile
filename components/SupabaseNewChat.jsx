// Phase D — Supabase chat: user search to start a new 1:1 conversation.
//
// Replaces the Stream-Chat-flavored new-chat screen when USE_SUPABASE_CHAT
// is on. Searches `profiles` by username (case-insensitive substring),
// shows results, tap → getOrCreate1to1Conversation → route to thread.
//
// Visual conventions match the rest of the app — premium violet primary,
// soft hairlines, debounced search.

import { Feather, MaterialIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Text, TextInput, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import { SafeAreaView } from "react-native-safe-area-context";
import useAppTheme from "../hooks/useAppTheme";
import { getOrCreate1to1Conversation } from "../lib/messages-supabase";
import supabase from "../lib/supabase";
// Phase E.9 — tier-aware image transform on the search-result avatars.
import { optimizedImageUri } from "../lib/utils/image-source";

const DEBOUNCE_MS = 250;

const ResultRow = ({ profile, onPress, theme, busy }) => (
  <TouchableOpacity
    onPress={() => !busy && onPress(profile)}
    activeOpacity={0.85}
    className="flex-row items-center px-4 py-3"
    style={{ borderBottomWidth: 0.5, borderBottomColor: theme.divider, opacity: busy ? 0.5 : 1 }}
  >
    {profile.avatar_url ? (
      <FastImage
        source={{ uri: optimizedImageUri(profile.avatar_url, { width: 44 }) }}
        style={{ width: 44, height: 44, borderRadius: 999, backgroundColor: theme.surfaceMuted }}
      />
    ) : (
      <View
        className="items-center justify-center"
        style={{ width: 44, height: 44, borderRadius: 999, backgroundColor: theme.primarySoft, borderWidth: 1, borderColor: theme.primary }}
      >
        <Text className="font-pbold" style={{ color: theme.primary, fontSize: 14 }}>
          {(profile.username || "?").slice(0, 1).toUpperCase()}
        </Text>
      </View>
    )}
    <View className="ml-3 flex-1">
      <Text className="font-pbold text-base" style={{ color: theme.text }} numberOfLines={1}>
        {profile.username || "Unknown"}
      </Text>
      {profile.bio ? (
        <Text className="mt-0.5 text-xs" style={{ color: theme.textSoft }} numberOfLines={1}>
          {profile.bio}
        </Text>
      ) : null}
    </View>
    <View
      className="ml-2 items-center justify-center rounded-full"
      style={{
        width: 32,
        height: 32,
        backgroundColor: theme.primarySoft,
        borderWidth: 1,
        borderColor: theme.primary,
      }}
    >
      <Feather name="message-circle" size={14} color={theme.primary} />
    </View>
  </TouchableOpacity>
);

const SupabaseNewChat = ({ currentUserId }) => {
  const { theme } = useAppTheme();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [creatingFor, setCreatingFor] = useState(null);
  const debounceRef = useRef(null);
  const inflightRef = useRef(0);

  // Debounced search — fires once typing pauses for DEBOUNCE_MS. The
  // inflight ref guards against an older request resolving after a newer
  // one (race that flickers stale results onto the list).
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      const requestId = ++inflightRef.current;
      try {
        const { data, error } = await supabase
          .from("profiles")
          .select("id, username, avatar_url, bio, is_guest")
          .ilike("username", `%${trimmed}%`)
          .neq("id", currentUserId)
          .limit(20);
        if (error) throw error;
        if (requestId !== inflightRef.current) return; // stale
        setResults(data || []);
      } catch (error) {
        if (requestId !== inflightRef.current) return;
        console.log("[supabase-chat] search failed:", error?.message);
        setResults([]);
      } finally {
        if (requestId === inflightRef.current) setSearching(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, currentUserId]);

  const handleSelect = useCallback(async (profile) => {
    setCreatingFor(profile.id);
    try {
      const conversation = await getOrCreate1to1Conversation(profile.id);
      router.replace({
        pathname: "channel",
        params: { conversationId: conversation.id },
      });
    } catch (error) {
      console.log("[supabase-chat] getOrCreate1to1 failed:", error?.message);
    } finally {
      setCreatingFor(null);
    }
  }, []);

  const renderItem = useCallback(
    ({ item }) => <ResultRow profile={item} onPress={handleSelect} theme={theme} busy={creatingFor === item.id} />,
    [handleSelect, theme, creatingFor],
  );

  return (
    <SafeAreaView className="flex-1" style={{ backgroundColor: theme.background }}>
      {/* Header */}
      <View className="flex-row items-center px-4 pb-3 pt-2">
        <TouchableOpacity
          onPress={() => router.back()}
          activeOpacity={0.85}
          className="h-10 w-10 items-center justify-center rounded-full"
          style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surfaceMuted }}
        >
          <MaterialIcons name="arrow-back" size={20} color={theme.icon} />
        </TouchableOpacity>
        <Text className="ml-3 font-pbold text-2xl" style={{ color: theme.text }}>
          New chat
        </Text>
      </View>

      {/* Search input */}
      <View className="px-4 pb-3">
        <View
          className="flex-row items-center rounded-2xl px-3"
          style={{ borderWidth: 1, borderColor: theme.inputBorder, backgroundColor: theme.inputBackground }}
        >
          <Feather name="search" size={18} color={theme.iconMuted} />
          <TextInput
            className="ml-2 flex-1 py-2.5 text-sm"
            placeholder="Search by username"
            placeholderTextColor={theme.placeholder}
            style={{ color: theme.inputText }}
            value={query}
            onChangeText={setQuery}
            autoCorrect={false}
            autoCapitalize="none"
            autoFocus
          />
          {searching ? <ActivityIndicator size="small" color={theme.primary} /> : null}
        </View>
      </View>

      {/* Results */}
      {!query.trim() ? (
        <View className="flex-1 items-center justify-center px-6">
          <View
            className="mb-4 items-center justify-center"
            style={{
              width: 64,
              height: 64,
              borderRadius: 999,
              backgroundColor: theme.primarySoft,
              borderWidth: 1,
              borderColor: theme.primary,
            }}
          >
            <Feather name="search" size={28} color={theme.primary} />
          </View>
          <Text className="font-pbold text-base" style={{ color: theme.text }}>
            Find someone to chat with
          </Text>
          <Text className="mt-2 max-w-[280px] text-center text-sm" style={{ color: theme.textSoft, lineHeight: 20 }}>
            Type a username above to start a new conversation.
          </Text>
        </View>
      ) : results.length === 0 && !searching ? (
        <View className="flex-1 items-center justify-center px-6">
          <Text className="font-pbold text-base" style={{ color: theme.text }}>
            No users found
          </Text>
          <Text className="mt-2 text-sm" style={{ color: theme.textSoft }}>
            Try a different username.
          </Text>
        </View>
      ) : (
        <FlatList data={results} renderItem={renderItem} keyExtractor={(item) => item.id} keyboardShouldPersistTaps="handled" />
      )}
    </SafeAreaView>
  );
};

export default SupabaseNewChat;
