// Add-members-to-existing-group screen.
//
// Mirrors new-group.jsx's search UX (debounced username search, chip row
// for selected, multi-select, single "Add" button). The differences:
//   - We pre-fetch the existing member list and exclude those IDs from
//     the search results so the user can't accidentally re-add them.
//   - On submit, calls addGroupMembers(conversationId, memberIds) instead
//     of createGroupConversation.
//   - On success, pops back to the group-info screen, which re-fetches on
//     focus and shows the new members.
//
// Why a separate screen and not a modal:
//   The search list is unbounded — you might scroll through 20+ matches.
//   Native modals on iOS clip the keyboard awkwardly when the list is
//   long. A push transition gives us a full-screen working area for free
//   and matches the new-group flow users already know.

import { Feather, MaterialIcons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import { SafeAreaView } from "react-native-safe-area-context";
import { useGlobalContext } from "../../context/global-provider";
import useAppTheme from "../../hooks/useAppTheme";
import { addGroupMembers, loadGroupMembers } from "../../lib/messages-supabase";
import supabase from "../../lib/supabase";
import { optimizedImageUri } from "../../lib/utils/image-source";

const DEBOUNCE_MS = 250;

const GroupAddMembers = () => {
  const { theme } = useAppTheme();
  const { chatUserId } = useGlobalContext();
  const { conversationId } = useLocalSearchParams();

  const [existingMemberIds, setExistingMemberIds] = useState([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState([]);
  const [adding, setAdding] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(true);

  const debounceRef = useRef(null);
  const inflightRef = useRef(0);

  // Pull existing members up front so we can exclude them from search.
  // We also confirm permission here implicitly — if loadGroupMembers fails
  // (e.g. you're not in the group), we surface that early instead of after
  // the user does the work of selecting people.
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!conversationId) {
        setBootstrapping(false);
        return;
      }
      try {
        const { members } = await loadGroupMembers(conversationId);
        if (!alive) return;
        setExistingMemberIds(members.map((m) => m.id));
      } catch (e) {
        if (!alive) return;
        Alert.alert("Could not load group", e?.message || "Try again.");
        router.back();
      } finally {
        if (alive) setBootstrapping(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [conversationId]);

  // Debounced username search. Excludes the current user, anyone already
  // in the group, and anyone already in the pending-selection chip row.
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
        const excludeIds = [
          chatUserId,
          ...existingMemberIds,
          ...selected.map((s) => s.id),
        ].filter(Boolean);
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
        console.log("[group-add-members] search failed:", e?.message);
        setResults([]);
      } finally {
        if (requestId === inflightRef.current) setSearching(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, chatUserId, existingMemberIds, selected]);

  const addToSelection = useCallback((profile) => {
    setSelected((prev) => (prev.find((p) => p.id === profile.id) ? prev : [...prev, profile]));
    setQuery("");
    setResults([]);
  }, []);

  const removeFromSelection = useCallback((id) => {
    setSelected((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const handleAdd = useCallback(async () => {
    if (selected.length === 0) return;
    setAdding(true);
    try {
      const { added, skipped } = await addGroupMembers({
        conversationId,
        memberIds: selected.map((s) => s.id),
      });
      if (added === 0) {
        Alert.alert("Nothing added", "Those users were already in the group.");
      } else if (skipped > 0) {
        Alert.alert("Added with skips", `Added ${added}. Skipped ${skipped} (already in group or unresolvable).`);
      }
      router.back();
    } catch (e) {
      Alert.alert("Could not add members", e?.message || "Try again.");
    } finally {
      setAdding(false);
    }
  }, [selected, conversationId]);

  const renderResult = useCallback(
    ({ item }) => (
      <TouchableOpacity
        onPress={() => addToSelection(item)}
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
            style={{
              width: 44,
              height: 44,
              borderRadius: 999,
              backgroundColor: theme.primarySoft,
              borderWidth: 1,
              borderColor: theme.primary,
            }}
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
    [addToSelection, theme],
  );

  if (bootstrapping) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center" style={{ backgroundColor: theme.background }}>
        <ActivityIndicator size="large" color={theme.primary} />
      </SafeAreaView>
    );
  }

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
          Add members
        </Text>
        <TouchableOpacity
          onPress={handleAdd}
          disabled={selected.length === 0 || adding}
          activeOpacity={0.85}
          className="rounded-full px-4 py-2"
          style={{
            backgroundColor: selected.length > 0 && !adding ? theme.primary : theme.surfaceMuted,
            opacity: selected.length > 0 && !adding ? 1 : 0.6,
          }}
        >
          {adding ? (
            <ActivityIndicator size="small" color={theme.primaryContrast} />
          ) : (
            <Text className="font-pbold text-sm" style={{ color: selected.length > 0 ? theme.primaryContrast : theme.textMuted }}>
              Add
            </Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Selected chips */}
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
                onPress={() => removeFromSelection(m.id)}
                className="ml-1 h-5 w-5 items-center justify-center rounded-full"
                style={{ backgroundColor: theme.primary }}
              >
                <Feather name="x" size={11} color={theme.primaryContrast} />
              </TouchableOpacity>
            </View>
          ))}
        </ScrollView>
      ) : null}

      {/* Search */}
      <View className="px-4 pb-3">
        <View
          className="flex-row items-center rounded-2xl px-3"
          style={{ borderWidth: 1, borderColor: theme.inputBorder, backgroundColor: theme.inputBackground }}
        >
          <Feather name="search" size={16} color={theme.iconMuted} />
          <TextInput
            className="ml-2 flex-1 py-2.5 text-sm"
            placeholder="Search by username"
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

      {/* Results / empty state */}
      {!query.trim() ? (
        <View className="flex-1 items-center justify-center px-6">
          <Text className="font-pbold text-base" style={{ color: theme.text }}>
            {selected.length === 0 ? "Search to add people" : `${selected.length} selected`}
          </Text>
          <Text className="mt-2 max-w-[280px] text-center text-sm" style={{ color: theme.textSoft, lineHeight: 20 }}>
            People already in the group are hidden from results.
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

export default GroupAddMembers;
