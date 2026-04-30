// New group conversation screen — multi-select user search + name input.
//
// User flow:
//   1. Tap "+ New group" from the chats list
//   2. Search for users in a debounced input (mirror SupabaseNewChat's
//      profiles search by username)
//   3. Tap a result row to add → user appears as a chip in the selected
//      list; tap chip's X to remove
//   4. Optionally enter a group name (defaults to first 3 usernames)
//   5. Tap "Create" → createGroupConversation → router.replace into the
//      thread for the new conversation.

import { Feather, MaterialIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import { SafeAreaView } from "react-native-safe-area-context";
import { useGlobalContext } from "../../context/global-provider";
import useAppTheme from "../../hooks/useAppTheme";
import { createGroupConversation } from "../../lib/messages-supabase";
import supabase from "../../lib/supabase";
import { optimizedImageUri } from "../../lib/utils/image-source";

const DEBOUNCE_MS = 250;

const NewGroup = () => {
  const { theme } = useAppTheme();
  const { chatUserId } = useGlobalContext();

  const [groupName, setGroupName] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  // Selected member profiles — kept as full objects so we can render the
  // chip row above the search results without re-fetching.
  const [selected, setSelected] = useState([]);
  const [creating, setCreating] = useState(false);

  const debounceRef = useRef(null);
  const inflightRef = useRef(0);

  // Debounced username search. Excludes the current user + anyone already
  // selected so the list stays clean.
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
        const excludeIds = [chatUserId, ...selected.map((s) => s.id)].filter(Boolean);
        let q = supabase
          .from("profiles")
          .select("id, username, avatar_url, bio, is_guest")
          .ilike("username", `%${trimmed}%`)
          .limit(20);
        if (excludeIds.length > 0) q = q.not("id", "in", `(${excludeIds.join(",")})`);
        const { data, error } = await q;
        if (error) throw error;
        if (requestId !== inflightRef.current) return;
        setResults(data || []);
      } catch (e) {
        if (requestId !== inflightRef.current) return;
        console.log("[new-group] search failed:", e?.message);
        setResults([]);
      } finally {
        if (requestId === inflightRef.current) setSearching(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, chatUserId, selected]);

  const addMember = useCallback((profile) => {
    setSelected((prev) => (prev.find((p) => p.id === profile.id) ? prev : [...prev, profile]));
    setQuery("");
    setResults([]);
  }, []);

  const removeMember = useCallback((id) => {
    setSelected((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const handleCreate = useCallback(async () => {
    if (selected.length < 2) {
      Alert.alert("Pick at least 2 people", "A group needs at least 2 other members.");
      return;
    }
    setCreating(true);
    try {
      const conv = await createGroupConversation({
        memberIds: selected.map((s) => s.id),
        name: groupName,
      });
      router.replace({ pathname: "/(message)/channel", params: { conversationId: conv.id } });
    } catch (e) {
      Alert.alert("Could not create group", e?.message || "Try again.");
    } finally {
      setCreating(false);
    }
  }, [selected, groupName]);

  const renderResult = useCallback(
    ({ item }) => (
      <TouchableOpacity
        onPress={() => addMember(item)}
        activeOpacity={0.85}
        className="flex-row items-center px-4 py-3"
        style={{ borderBottomWidth: 0.5, borderBottomColor: theme.divider }}
      >
        {item.avatar_url ? (
          <FastImage
            source={{ uri: optimizedImageUri(item.avatar_url, { width: 44 }) }}
            style={{ width: 44, height: 44, borderRadius: 999, backgroundColor: theme.surfaceMuted }}
          />
        ) : (
          <View
            className="items-center justify-center"
            style={{ width: 44, height: 44, borderRadius: 999, backgroundColor: theme.primarySoft, borderWidth: 1, borderColor: theme.primary }}
          >
            <Text className="font-pbold" style={{ color: theme.primary, fontSize: 14 }}>
              {(item.username || "?").slice(0, 1).toUpperCase()}
            </Text>
          </View>
        )}
        <Text className="ml-3 flex-1 font-pbold text-base" style={{ color: theme.text }} numberOfLines={1}>
          {item.username || "Unknown"}
        </Text>
        <Feather name="plus-circle" size={20} color={theme.primary} />
      </TouchableOpacity>
    ),
    [addMember, theme],
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
        <Text className="ml-3 flex-1 font-pbold text-2xl" style={{ color: theme.text }}>
          New group
        </Text>
        <TouchableOpacity
          onPress={handleCreate}
          disabled={selected.length < 2 || creating}
          activeOpacity={0.85}
          className="rounded-full px-4 py-2"
          style={{
            backgroundColor: selected.length >= 2 && !creating ? theme.primary : theme.surfaceMuted,
            opacity: selected.length >= 2 && !creating ? 1 : 0.6,
          }}
        >
          {creating ? (
            <ActivityIndicator size="small" color={theme.primaryContrast} />
          ) : (
            <Text className="font-pbold text-sm" style={{ color: selected.length >= 2 ? theme.primaryContrast : theme.textMuted }}>
              Create
            </Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Group name input */}
      <View className="px-4 pb-3">
        <TextInput
          className="rounded-2xl px-3 py-2.5 text-sm"
          style={{ borderWidth: 1, borderColor: theme.inputBorder, backgroundColor: theme.inputBackground, color: theme.inputText }}
          placeholder="Group name (optional)"
          placeholderTextColor={theme.placeholder}
          value={groupName}
          onChangeText={setGroupName}
          maxLength={60}
        />
      </View>

      {/* Selected member chips */}
      {selected.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} className="px-3 pb-2" style={{ flexGrow: 0 }}>
          {selected.map((m) => (
            <View
              key={m.id}
              className="mr-2 flex-row items-center rounded-full pl-2 pr-1 py-1"
              style={{ backgroundColor: theme.primarySoft, borderWidth: 1, borderColor: theme.primary }}
            >
              <Text className="text-xs font-pbold" style={{ color: theme.primary }} numberOfLines={1}>
                {m.username || "?"}
              </Text>
              <TouchableOpacity
                onPress={() => removeMember(m.id)}
                className="ml-1 h-5 w-5 items-center justify-center rounded-full"
                style={{ backgroundColor: theme.primary }}
              >
                <Feather name="x" size={11} color={theme.primaryContrast} />
              </TouchableOpacity>
            </View>
          ))}
        </ScrollView>
      ) : null}

      {/* Search input */}
      <View className="px-4 pb-3">
        <View
          className="flex-row items-center rounded-2xl px-3"
          style={{ borderWidth: 1, borderColor: theme.inputBorder, backgroundColor: theme.inputBackground }}
        >
          <Feather name="search" size={16} color={theme.iconMuted} />
          <TextInput
            className="ml-2 flex-1 py-2.5 text-sm"
            placeholder="Add members by username"
            placeholderTextColor={theme.placeholder}
            style={{ color: theme.inputText }}
            value={query}
            onChangeText={setQuery}
            autoCorrect={false}
            autoCapitalize="none"
          />
          {searching ? <ActivityIndicator size="small" color={theme.primary} /> : null}
        </View>
      </View>

      {/* Results */}
      {!query.trim() ? (
        <View className="flex-1 items-center justify-center px-6">
          <Text className="font-pbold text-base" style={{ color: theme.text }}>
            {selected.length === 0 ? "Search to add people" : `${selected.length} selected`}
          </Text>
          <Text className="mt-2 max-w-[280px] text-center text-sm" style={{ color: theme.textSoft, lineHeight: 20 }}>
            {selected.length < 2
              ? "Add at least 2 members to start a group chat."
              : "You're ready to create the group."}
          </Text>
        </View>
      ) : results.length === 0 && !searching ? (
        <View className="flex-1 items-center justify-center px-6">
          <Text className="font-pbold text-base" style={{ color: theme.text }}>
            No users found
          </Text>
        </View>
      ) : (
        <FlatList data={results} renderItem={renderResult} keyExtractor={(item) => item.id} keyboardShouldPersistTaps="handled" />
      )}
    </SafeAreaView>
  );
};

export default NewGroup;
