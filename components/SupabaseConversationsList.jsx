// Phase D — Supabase chat: conversation list.
//
// Replaces stream-chat-expo's <ChannelList /> when USE_SUPABASE_CHAT is on.
// Reads from lib/messages-supabase.js and subscribes to inbox-wide realtime
// events to bump unread counts + reorder conversations as new messages
// arrive. Visual language matches the rest of the app — violet primary, soft
// hairlines, premium shadow lifts on active rows.
//
// Currently wraps a flat FlatList because:
//   1. Conversation lists are usually short (tens, not thousands).
//   2. FlashList recycling adds complexity we don't need at this scale.
//   3. Easier to debug timing of realtime updates.
//   If we ever ship users with hundreds of conversations, swap for FlashList.

import { Feather, Ionicons, MaterialIcons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, RefreshControl, Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import { SafeAreaView } from "react-native-safe-area-context";
import useAppTheme from "../hooks/useAppTheme";
// Phase E.10 — tier-tuned FlatList config for the conversations list.
// Conversation lists are usually short, but on low-tier devices the
// initial 10-row paint + 21-screen window is still wasteful.
import { getFlatListConfig } from "../lib/device-tier";
import { loadConversations, subscribeToInbox } from "../lib/messages-supabase";
import supabase from "../lib/supabase";
import TimeAgo from "../lib/utils/time-ago";

const ConversationRow = ({ conversation, onPress, theme, currentUserId }) => {
  const { isGroup, otherUser, members, lastMessageAt, last_message_preview, last_message_sender, muted, archived } = conversation;
  const unread = conversation.unread || 0;

  if (archived) return null;

  // Avatar — group conversations stack first 3 members, 1:1 shows the other
  // user's avatar. Initials fallback when no avatar URL.
  const renderAvatar = () => {
    if (isGroup) {
      const avatars = (members || []).slice(0, 3).filter((m) => m.id !== currentUserId);
      if (!avatars.length) {
        return (
          <View className="items-center justify-center" style={{ width: 48, height: 48, borderRadius: 999, backgroundColor: theme.surfaceMuted }}>
            <MaterialIcons name="group" size={22} color={theme.iconMuted} />
          </View>
        );
      }
      return (
        <View style={{ width: 48, height: 48 }}>
          {avatars.slice(0, 2).map((m, idx) => (
            <FastImage
              key={m.id}
              source={m.avatar_url ? { uri: m.avatar_url } : undefined}
              style={{
                position: "absolute",
                width: 32,
                height: 32,
                borderRadius: 999,
                top: idx === 0 ? 0 : 16,
                left: idx === 0 ? 0 : 16,
                borderWidth: 2,
                borderColor: theme.background,
                backgroundColor: theme.surfaceMuted,
              }}
            />
          ))}
        </View>
      );
    }

    if (otherUser?.avatar_url) {
      return (
        <FastImage source={{ uri: otherUser.avatar_url }} style={{ width: 48, height: 48, borderRadius: 999, backgroundColor: theme.surfaceMuted }} />
      );
    }
    return (
      <View
        className="items-center justify-center"
        style={{ width: 48, height: 48, borderRadius: 999, backgroundColor: theme.primarySoft, borderWidth: 1, borderColor: theme.primary }}
      >
        <Text className="font-pbold" style={{ color: theme.primary, fontSize: 16 }}>
          {(otherUser?.username || "?").slice(0, 1).toUpperCase()}
        </Text>
      </View>
    );
  };

  const title = isGroup
    ? conversation.name ||
      (members || [])
        .map((m) => m.username)
        .slice(0, 3)
        .join(", ")
    : otherUser?.username || "Unknown";

  // Last-message preview — prefix with "You: " when the last sender was the
  // current user, mirroring iMessage / WhatsApp / web conventions.
  const previewText = (() => {
    if (!last_message_preview) return isGroup ? "New conversation" : "Say hi";
    const isOwn = last_message_sender === currentUserId;
    return isOwn ? `You: ${last_message_preview}` : last_message_preview;
  })();

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.85}
      className="flex-row items-center px-4 py-3"
      style={{ borderBottomWidth: 0.5, borderBottomColor: theme.divider }}
    >
      {renderAvatar()}
      <View className="ml-3 flex-1">
        <View className="flex-row items-center justify-between">
          <Text className="font-pbold text-base" style={{ color: theme.text, flex: 1 }} numberOfLines={1}>
            {title}
          </Text>
          {lastMessageAt ? (
            <Text className="ml-2 text-xs" style={{ color: theme.textSoft }}>
              {TimeAgo(lastMessageAt)}
            </Text>
          ) : null}
        </View>
        <View className="mt-0.5 flex-row items-center justify-between">
          <Text className="font-pregular text-sm" style={{ color: unread > 0 ? theme.text : theme.textSoft, flex: 1 }} numberOfLines={1}>
            {previewText}
          </Text>
          <View className="ml-2 flex-row items-center" style={{ gap: 6 }}>
            {muted ? <Ionicons name="notifications-off" size={14} color={theme.textSubtle} /> : null}
            {unread > 0 ? (
              <View
                className="items-center justify-center rounded-full"
                style={{
                  minWidth: 20,
                  height: 20,
                  paddingHorizontal: 6,
                  backgroundColor: theme.primary,
                  shadowColor: theme.primary,
                  shadowOffset: { width: 0, height: 4 },
                  shadowOpacity: 0.35,
                  shadowRadius: 8,
                  elevation: 3,
                }}
              >
                <Text className="font-pbold" style={{ color: theme.primaryContrast, fontSize: 11 }}>
                  {unread > 99 ? "99+" : unread}
                </Text>
              </View>
            ) : null}
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );
};

// Skip useFocusEffect refetch if last fetch was within this window. The
// realtime inbox subscription keeps the list current; refetching on every
// tab focus is wasteful (1 conversation read + N profile reads per focus).
const FETCH_FRESHNESS_MS = 30 * 1000;

const SupabaseConversationsList = ({ currentUserId }) => {
  const { theme } = useAppTheme();
  const [conversations, setConversations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // null = unknown (initial), false = no Supabase auth session, true = signed in
  const [hasSession, setHasSession] = useState(null);
  // Used to stamp newly-arriving messages onto the right conversation row
  // without a full refetch. Keep it as a ref so realtime callbacks don't
  // need to re-bind every render.
  const conversationsRef = useRef([]);
  conversationsRef.current = conversations;
  // Tracks the timestamp of the last successful fetch so useFocusEffect can
  // skip the refetch when it's still fresh.
  const lastFetchedAtRef = useRef(0);
  // Phase E.10 — tier-tuned FlatList window. Memoized so prop identity
  // is stable across re-renders.
  const flatListConfig = useMemo(() => getFlatListConfig(), []);

  const fetchConversations = useCallback(async ({ silent = false, force = false } = {}) => {
    // Freshness gate — skip the network roundtrip if we just fetched.
    // `force: true` (used by pull-to-refresh) bypasses this. The realtime
    // inbox subscription keeps the list current between explicit refetches.
    if (!force && Date.now() - lastFetchedAtRef.current < FETCH_FRESHNESS_MS) {
      return;
    }
    if (!silent) setLoading(true);
    try {
      // Check Supabase session first. The chat tab only works for users
      // with a Supabase auth session — users still on Appwrite see a
      // friendly "sign in" prompt instead of an error toast. This handles
      // the migration window cleanly: as users gradually move onto
      // Supabase auth, chat starts working for them automatically.
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        setHasSession(false);
        setConversations([]);
        return;
      }
      setHasSession(true);
      const list = await loadConversations();
      setConversations(list);
      lastFetchedAtRef.current = Date.now();
    } catch (error) {
      console.log("[supabase-chat] loadConversations failed:", error?.message);
      setConversations([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      // Honors the freshness gate inside fetchConversations.
      fetchConversations();
    }, [fetchConversations]),
  );

  // Inbox-wide realtime subscription. Any new message in any conversation
  // triggers a row-level update — bump unread + reorder. We don't refetch
  // the whole list; we patch the existing row.
  useEffect(() => {
    if (!currentUserId) return;
    const unsubscribe = subscribeToInbox((newMessage) => {
      if (!newMessage?.conversation_id) return;
      const list = conversationsRef.current;
      const idx = list.findIndex((c) => c.id === newMessage.conversation_id);
      if (idx < 0) {
        // New conversation we don't have locally yet — force refetch
        // (bypass the freshness gate; this is a real "we missed an event"
        // signal, not a routine focus).
        fetchConversations({ silent: true, force: true });
        return;
      }
      const existing = list[idx];
      const isFromMe = newMessage.sender_id === currentUserId;
      const updated = {
        ...existing,
        last_message_at: newMessage.created_at,
        last_message_preview: newMessage.body || (newMessage.image_url ? "Photo" : ""),
        last_message_sender: newMessage.sender_id,
        unread: isFromMe ? existing.unread || 0 : (existing.unread || 0) + 1,
      };
      const next = [updated, ...list.filter((c, i) => i !== idx)];
      setConversations(next);
    });
    return unsubscribe;
  }, [currentUserId, fetchConversations]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    // Pull-to-refresh — explicit user intent, bypass the freshness gate.
    fetchConversations({ silent: true, force: true });
  }, [fetchConversations]);

  const handleSelect = useCallback((conversation) => {
    router.push({
      pathname: "channel",
      params: { conversationId: conversation.id },
    });
  }, []);

  const renderItem = useCallback(
    ({ item }) => <ConversationRow conversation={item} onPress={() => handleSelect(item)} theme={theme} currentUserId={currentUserId} />,
    [handleSelect, theme, currentUserId],
  );

  const keyExtractor = useCallback((item) => item.id, []);

  // Empty + loading skeleton — matches the violet-soft "premium" empty
  // states elsewhere in the app.
  if (loading) {
    return (
      <View className="flex-1 items-center justify-center px-6">
        <Text className="text-sm" style={{ color: theme.textSoft }}>
          Loading conversations…
        </Text>
      </View>
    );
  }

  // No Supabase session — user is signed in via Appwrite (still on the
  // legacy auth path). Show a friendly upgrade prompt instead of letting
  // the chat fail with "Not signed in" errors.
  if (hasSession === false) {
    return (
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
          <Feather name="message-circle" size={28} color={theme.primary} />
        </View>
        <Text className="font-pbold text-base" style={{ color: theme.text }}>
          Chat is on the new system
        </Text>
        <Text className="mt-2 max-w-[280px] text-center text-sm" style={{ color: theme.textSoft, lineHeight: 20 }}>
          Sign out and sign back in to enable messages on the upgraded chat. Your account stays the same — just one extra step.
        </Text>
      </View>
    );
  }

  if (!conversations.length) {
    return (
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
          <Feather name="message-circle" size={28} color={theme.primary} />
        </View>
        <Text className="font-pbold text-base" style={{ color: theme.text }}>
          No conversations yet
        </Text>
        <Text className="mt-2 max-w-[280px] text-center text-sm" style={{ color: theme.textSoft, lineHeight: 20 }}>
          Tap the pencil icon above to start chatting with someone.
        </Text>
      </View>
    );
  }

  return (
    <FlatList
      data={conversations}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={theme.primary} colors={[theme.primary]} />}
      contentContainerStyle={{ flexGrow: 1, backgroundColor: theme.background }}
      style={{ backgroundColor: theme.background }}
      windowSize={flatListConfig.windowSize}
      initialNumToRender={flatListConfig.initialNumToRender}
      maxToRenderPerBatch={flatListConfig.maxToRenderPerBatch}
      removeClippedSubviews={flatListConfig.removeClippedSubviews}
    />
  );
};

export default SupabaseConversationsList;
