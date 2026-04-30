// Phase D — Supabase chat: thread (one conversation) view.
//
// Replaces stream-chat-expo's <Channel> + <MessageList> + <MessageInput> for
// a single conversation. Reads from lib/messages-supabase.js, subscribes to
// realtime per-thread events, supports send / edit / delete / reply / react.
//
// Visual conventions:
//   - Inverted FlatList (newest at bottom, scroll up to see older). Standard
//     mobile chat pattern. Avoids fighting the keyboard's auto-scroll.
//   - Outgoing bubbles: violet primary, right-aligned. Incoming: surface
//     muted, left-aligned. Same palette the rest of the app uses for "self
//     vs other" surfaces.
//   - Optimistic send: pushes a temp bubble immediately, swaps for the real
//     row when the server roundtrip lands. Rolls back on error.
//   - Long-press a bubble → action sheet (reply, react, edit own, delete own).

import { Ionicons, MaterialCommunityIcons, MaterialIcons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, FlatList, KeyboardAvoidingView, Platform, Text, TextInput, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import { SafeAreaView } from "react-native-safe-area-context";
import useAppTheme from "../hooks/useAppTheme";
import {
  deleteMessage as supabaseDeleteMessage,
  editMessage as supabaseEditMessage,
  loadConversationById,
  loadMessages,
  markConversationRead,
  sendMessage as supabaseSendMessage,
  sendTypingBroadcast,
  subscribeToConversation,
  subscribeToPresenceAndTyping,
  toggleReaction as supabaseToggleReaction,
} from "../lib/messages-supabase";
import supabase from "../lib/supabase";
import TimeAgo from "../lib/utils/time-ago";

// How long the "they're typing" indicator stays visible after the last
// broadcast. Web uses 3.5s; matched here so the timing feels identical
// across platforms.
const TYPING_VISIBLE_MS = 3500;
// Throttle for outgoing typing broadcasts — once every 1.5s while the
// composer is being edited. Receiver's TYPING_VISIBLE_MS keeps the dots
// alive between throttled emissions.
const TYPING_THROTTLE_MS = 1500;

const REACTION_EMOJIS = ["❤️", "😂", "😢", "😡", "👍", "🔥"];

const MessageBubble = ({ message, isMine, theme, onLongPress, reactionList }) => {
  const isDeleted = Boolean(message.deleted_at);
  const isPending = Boolean(message._pending);

  return (
    <TouchableOpacity
      onLongPress={() => !isDeleted && !isPending && onLongPress(message)}
      activeOpacity={0.85}
      className={`my-1 px-3 ${isMine ? "self-end" : "self-start"}`}
      style={{ maxWidth: "78%" }}
    >
      <View
        className="rounded-2xl px-4 py-2.5"
        style={{
          backgroundColor: isMine ? theme.primary : theme.surfaceMuted,
          opacity: isPending ? 0.6 : 1,
          borderWidth: isMine ? 0 : 1,
          borderColor: theme.border,
          shadowColor: isMine ? theme.primary : "transparent",
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: isMine ? 0.18 : 0,
          shadowRadius: 6,
          elevation: isMine ? 2 : 0,
        }}
      >
        {message.image_url ? (
          <FastImage source={{ uri: message.image_url }} style={{ width: 200, height: 200, borderRadius: 12, marginBottom: message.body ? 6 : 0 }} />
        ) : null}
        {isDeleted ? (
          <Text className="text-sm italic" style={{ color: isMine ? theme.primaryContrast : theme.textSubtle }}>
            Message deleted
          </Text>
        ) : (
          <Text className="text-sm" style={{ color: isMine ? theme.primaryContrast : theme.text, lineHeight: 20 }}>
            {message.body}
          </Text>
        )}
      </View>
      {/* Reactions row — pill below the bubble. */}
      {reactionList && reactionList.length > 0 ? (
        <View className={`mt-1 flex-row ${isMine ? "self-end" : "self-start"}`} style={{ gap: 4 }}>
          {Object.entries(
            reactionList.reduce((acc, r) => {
              acc[r.emoji] = (acc[r.emoji] || 0) + 1;
              return acc;
            }, {}),
          ).map(([emoji, count]) => (
            <View
              key={emoji}
              className="rounded-full px-2 py-0.5"
              style={{ backgroundColor: theme.surfaceElevated, borderWidth: 0.5, borderColor: theme.border }}
            >
              <Text style={{ fontSize: 12 }}>
                {emoji} {count > 1 ? count : ""}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      <Text className={`mt-0.5 text-[10px] ${isMine ? "self-end" : "self-start"}`} style={{ color: theme.textSubtle }}>
        {message.edited_at ? "Edited · " : ""}
        {TimeAgo(message.created_at)}
      </Text>
    </TouchableOpacity>
  );
};

const SupabaseThread = ({ conversationId: conversationIdProp, currentUserId }) => {
  const { theme } = useAppTheme();
  const params = useLocalSearchParams();
  const conversationId = conversationIdProp || params?.conversationId;

  const [conversation, setConversation] = useState(null); // { otherUser, members, ... } via loadConversationById
  const [messages, setMessages] = useState([]);
  const [reactions, setReactions] = useState({}); // { messageId: [{ user_id, emoji }] }
  const [loading, setLoading] = useState(true);
  const [composer, setComposer] = useState("");
  const [sending, setSending] = useState(false);
  // Set of user IDs currently typing (others, not self). For 1:1 this is
  // typically 0 or 1 entries; groups can have multiple.
  const [typingUsers, setTypingUsers] = useState([]);
  // Set of user IDs currently online + present in this conversation's
  // presence channel. Used by the consumer (e.g., header) to render an
  // online dot.
  const [onlineUserIds, setOnlineUserIds] = useState([]);

  // Refs for realtime callbacks so they don't re-subscribe on every render.
  const messagesRef = useRef([]);
  messagesRef.current = messages;
  const reactionsRef = useRef({});
  reactionsRef.current = reactions;
  // Per-typing-user clear timers — when the other side broadcasts "typing",
  // we set a 3.5s timer to remove them from the typing set. Subsequent
  // broadcasts within that window refresh the timer.
  const typingTimersRef = useRef({});
  // Throttle timestamp for our outgoing typing broadcasts.
  const lastTypingSentRef = useRef(0);
  // Debounce timer for mark-as-read RPCs. Without this, a busy group chat
  // (10 active users) would fire one RPC per incoming message — 10× the
  // server load for one logical "I've seen all the new stuff" event.
  const markReadDebounceRef = useRef(null);
  const scheduleMarkRead = useCallback(() => {
    if (markReadDebounceRef.current) clearTimeout(markReadDebounceRef.current);
    markReadDebounceRef.current = setTimeout(() => {
      markReadDebounceRef.current = null;
      if (!conversationId) return;
      markConversationRead(conversationId).catch(() => {});
    }, 500);
  }, [conversationId]);

  // Initial load + mark-read. Loads the conversation header (other user
  // profile + member list for groups) in parallel with the message history
  // so the header can paint as soon as either resolves.
  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    (async () => {
      try {
        const [conv, payload] = await Promise.all([loadConversationById(conversationId), loadMessages(conversationId)]);
        if (cancelled) return;
        setConversation(conv);
        setMessages(payload.messages);
        setReactions(payload.reactions);
        markConversationRead(conversationId).catch(() => {});
      } catch (error) {
        console.log("[supabase-chat] thread load failed:", error?.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  // Realtime subscription — patches local state instead of re-fetching so
  // scroll position + composer focus aren't disturbed.
  useEffect(() => {
    if (!conversationId) return;
    const unsubscribe = subscribeToConversation(conversationId, {
      onMessageInsert: (newMsg) => {
        const exists = messagesRef.current.some((m) => m.id === newMsg.id);
        if (exists) return;
        // Replace optimistic temp message if its body matches and the new
        // message just arrived from us.
        const tempIdx = messagesRef.current.findIndex((m) => m._pending && m.sender_id === newMsg.sender_id && m.body === newMsg.body);
        if (tempIdx >= 0) {
          const next = messagesRef.current.slice();
          next[tempIdx] = newMsg;
          setMessages(next);
        } else {
          setMessages([...messagesRef.current, newMsg]);
        }
        if (newMsg.sender_id !== currentUserId) {
          // Debounced — coalesces multiple incoming messages into one RPC.
          scheduleMarkRead();
        }
      },
      onMessageUpdate: (updated) => {
        const next = messagesRef.current.map((m) => (m.id === updated.id ? { ...m, ...updated } : m));
        setMessages(next);
      },
      onReactionInsert: (r) => {
        // Reaction subscriptions are GLOBAL — supabase postgres_changes
        // can't filter by message_id IN (...) since reactions don't carry
        // a conversation_id column. Skip if this reaction is for a message
        // we're not displaying. Mirrors web's `dmState.messages.some(...)`
        // guard. Without this, every reaction app-wide patches local state.
        if (!messagesRef.current.some((m) => m.id === r.message_id)) return;
        const next = { ...reactionsRef.current };
        if (!next[r.message_id]) next[r.message_id] = [];
        if (!next[r.message_id].some((x) => x.user_id === r.user_id && x.emoji === r.emoji)) {
          next[r.message_id] = [...next[r.message_id], r];
        }
        setReactions(next);
      },
      onReactionUpdate: (updated) => {
        if (!messagesRef.current.some((m) => m.id === updated.message_id)) return;
        const next = { ...reactionsRef.current };
        if (!next[updated.message_id]) next[updated.message_id] = [];
        next[updated.message_id] = next[updated.message_id].filter((x) => x.user_id !== updated.user_id);
        next[updated.message_id].push(updated);
        setReactions(next);
      },
      onReactionDelete: (r) => {
        if (!messagesRef.current.some((m) => m.id === r.message_id)) return;
        const next = { ...reactionsRef.current };
        if (!next[r.message_id]) return;
        next[r.message_id] = next[r.message_id].filter((x) => !(x.user_id === r.user_id && x.emoji === r.emoji));
        setReactions(next);
      },
    });
    return () => {
      // Cancel any pending mark-as-read RPC on unmount / conversation switch
      // so we don't fire it against a conversation the user just left.
      if (markReadDebounceRef.current) clearTimeout(markReadDebounceRef.current);
      markReadDebounceRef.current = null;
      unsubscribe();
    };
  }, [conversationId, currentUserId, scheduleMarkRead]);

  // Presence + typing channel — separate from the postgres_changes channel
  // above. Mirrors web's two-channel pattern. Tracks our own presence on
  // SUBSCRIBED so the other side sees us online.
  //
  // On conversationId change, we explicitly reset transient typing/presence
  // state. Without this, navigating from conversation A → B could carry
  // over A's `typingUsers` for up to TYPING_VISIBLE_MS (3.5s) before the
  // clear timers expire — manifesting as a phantom "typing…" pill in
  // conversation B about people who aren't actually typing there.
  useEffect(() => {
    if (!conversationId || !currentUserId) return;
    // Reset transient state for the new conversation.
    setTypingUsers([]);
    setOnlineUserIds([]);
    lastTypingSentRef.current = 0;

    const unsubscribe = subscribeToPresenceAndTyping(conversationId, currentUserId, {
      onPresenceSync: (ids) => setOnlineUserIds(ids),
      onTyping: (fromId) => {
        setTypingUsers((prev) => (prev.includes(fromId) ? prev : [...prev, fromId]));
        if (typingTimersRef.current[fromId]) clearTimeout(typingTimersRef.current[fromId]);
        typingTimersRef.current[fromId] = setTimeout(() => {
          setTypingUsers((prev) => prev.filter((id) => id !== fromId));
          delete typingTimersRef.current[fromId];
        }, TYPING_VISIBLE_MS);
      },
    });
    return () => {
      // Effect cleanup runs both on unmount AND when conversationId changes
      // (before the next setup), so any in-flight typing timers from the
      // previous conversation are cleared here.
      Object.values(typingTimersRef.current).forEach(clearTimeout);
      typingTimersRef.current = {};
      unsubscribe();
    };
  }, [conversationId, currentUserId]);

  // Throttled typing broadcast — fires when the user types into the
  // composer, at most once every TYPING_THROTTLE_MS. The receiver's
  // TYPING_VISIBLE_MS clear timer keeps the dots alive between throttled
  // emissions so the indicator doesn't flicker.
  const handleComposerChange = useCallback(
    (text) => {
      setComposer(text);
      if (!conversationId || !currentUserId) return;
      const now = Date.now();
      if (now - lastTypingSentRef.current < TYPING_THROTTLE_MS) return;
      lastTypingSentRef.current = now;
      sendTypingBroadcast(conversationId, currentUserId).catch(() => {});
    },
    [conversationId, currentUserId],
  );

  const handleSend = useCallback(async () => {
    const body = composer.trim();
    if (!body || sending || !conversationId) return;
    setSending(true);
    setComposer("");

    // Optimistic insert — temp id so realtime swap can find it.
    const tempId = `temp-${Date.now()}`;
    const optimistic = {
      id: tempId,
      conversation_id: conversationId,
      sender_id: currentUserId,
      body,
      created_at: new Date().toISOString(),
      _pending: true,
    };
    setMessages([...messagesRef.current, optimistic]);

    try {
      await supabaseSendMessage({ conversationId, body });
      // Realtime onMessageInsert will replace the temp with the real row.
    } catch (error) {
      // Roll back optimistic on failure.
      setMessages(messagesRef.current.filter((m) => m.id !== tempId));
      Alert.alert("Send failed", error?.message || "Could not send the message.");
    } finally {
      setSending(false);
    }
  }, [composer, conversationId, currentUserId, sending]);

  const handleLongPress = useCallback(
    (message) => {
      const isMine = message.sender_id === currentUserId;
      Alert.alert("Message", null, [
        ...REACTION_EMOJIS.map((emoji) => ({
          text: emoji,
          onPress: () => supabaseToggleReaction(message.id, emoji).catch(() => {}),
        })),
        ...(isMine
          ? [
              {
                text: "Delete",
                style: "destructive",
                onPress: () => supabaseDeleteMessage(message.id).catch(() => {}),
              },
            ]
          : []),
        { text: "Cancel", style: "cancel" },
      ]);
    },
    [currentUserId],
  );

  const renderItem = useCallback(
    ({ item }) => (
      <MessageBubble
        message={item}
        isMine={item.sender_id === currentUserId}
        theme={theme}
        onLongPress={handleLongPress}
        reactionList={reactions[item.id]}
      />
    ),
    [currentUserId, theme, reactions, handleLongPress],
  );

  // Inverted FlatList — pass messages reversed so newest is at index 0,
  // FlatList renders bottom-to-top. Scroll up loads older.
  const inverted = useMemo(() => messages.slice().reverse(), [messages]);

  // Header data — the other user (1:1) or a synthesized "group" descriptor.
  // Online state for 1:1 is "the other user is in onlineUserIds". For groups,
  // we render the count of online members instead of a single dot.
  const headerOtherUser = conversation && !conversation.is_group ? conversation.otherUser : null;
  const headerOtherIsOnline = headerOtherUser ? onlineUserIds.includes(headerOtherUser.id) : false;
  const headerGroupOnlineCount = conversation?.is_group ? onlineUserIds.length : 0;
  const headerTitle = conversation?.is_group
    ? conversation.name ||
      (conversation.members || [])
        .map((m) => m.username)
        .slice(0, 3)
        .join(", ")
    : headerOtherUser?.username || "Loading…";
  const headerStatus = (() => {
    if (!conversation) return "";
    if (conversation.is_group) {
      const online = headerGroupOnlineCount;
      const total = conversation.memberCount || (conversation.members || []).length;
      return online > 0 ? `${online} online · ${total} members` : `${total} members`;
    }
    return headerOtherIsOnline ? "Online" : "";
  })();

  return (
    <SafeAreaView className="flex-1" style={{ backgroundColor: theme.background }}>
      {/* Thread header — back arrow, avatar (+ online dot for 1:1), title,
          status line. Mirrors the web's chat header layout. Tapping the
          avatar / title goes to the other user's profile (1:1) or to a
          future group settings screen. */}
      <View
        className="flex-row items-center px-3 pb-2 pt-1"
        style={{ borderBottomWidth: 0.5, borderBottomColor: theme.divider, backgroundColor: theme.background }}
      >
        <TouchableOpacity
          onPress={() => router.back()}
          activeOpacity={0.85}
          className="h-10 w-10 items-center justify-center rounded-full"
          style={{ backgroundColor: theme.surfaceMuted, borderWidth: 1, borderColor: theme.border }}
        >
          <MaterialIcons name="arrow-back" size={20} color={theme.icon} />
        </TouchableOpacity>

        <TouchableOpacity
          activeOpacity={0.85}
          onPress={() => {
            if (!conversation || conversation.is_group) return;
            const otherId = headerOtherUser?.id;
            if (!otherId) return;
            router.push({ pathname: "/creator-profile", params: { userId: otherId } });
          }}
          className="ml-3 flex-1 flex-row items-center"
        >
          {/* Avatar with online dot overlay */}
          <View style={{ width: 36, height: 36, position: "relative" }}>
            {headerOtherUser?.avatar_url ? (
              <FastImage
                source={{ uri: headerOtherUser.avatar_url }}
                style={{ width: 36, height: 36, borderRadius: 999, backgroundColor: theme.surfaceMuted }}
              />
            ) : (
              <View
                className="items-center justify-center"
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 999,
                  backgroundColor: theme.primarySoft,
                  borderWidth: 1,
                  borderColor: theme.primary,
                }}
              >
                <Text className="font-pbold" style={{ color: theme.primary, fontSize: 13 }}>
                  {(headerTitle || "?").slice(0, 1).toUpperCase()}
                </Text>
              </View>
            )}
            {/* Online dot — green pulse on the bottom-right corner of the
                avatar. Mirrors web's `.dm-online-dot`. Only renders when
                the other user is present in the realtime presence channel. */}
            {!conversation?.is_group && headerOtherIsOnline ? (
              <View
                style={{
                  position: "absolute",
                  bottom: -1,
                  right: -1,
                  width: 12,
                  height: 12,
                  borderRadius: 999,
                  backgroundColor: "#22c55e",
                  borderWidth: 2,
                  borderColor: theme.background,
                }}
              />
            ) : null}
          </View>

          <View className="ml-2.5 flex-1">
            <Text className="font-pbold text-base" style={{ color: theme.text }} numberOfLines={1}>
              {headerTitle}
            </Text>
            {headerStatus ? (
              <Text className="text-xs" style={{ color: headerOtherIsOnline ? "#22c55e" : theme.textSoft }} numberOfLines={1}>
                {headerStatus}
              </Text>
            ) : null}
          </View>
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 0}
      >
        <FlatList
          data={inverted}
          renderItem={renderItem}
          keyExtractor={(item) => item.id}
          inverted
          contentContainerStyle={{ paddingHorizontal: 8, paddingVertical: 12 }}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            !loading ? (
              <View className="flex-1 items-center justify-center" style={{ paddingTop: 80, transform: [{ scaleY: -1 }] }}>
                <Text className="text-sm" style={{ color: theme.textSoft }}>
                  Say hi 👋
                </Text>
              </View>
            ) : null
          }
        />
        {/* Typing indicator — small chip above the composer when the other
            side is mid-typing. Mirrors web's UX. Only shows when at least
            one other user is currently typing in this conversation. */}
        {typingUsers.length > 0 ? (
          <View
            className="flex-row items-center px-4 py-1.5"
            style={{ backgroundColor: theme.surfaceElevated, borderTopWidth: 0.5, borderTopColor: theme.divider }}
          >
            <View className="flex-row items-center" style={{ gap: 4 }}>
              <View style={{ width: 6, height: 6, borderRadius: 999, backgroundColor: theme.primary, opacity: 0.6 }} />
              <View style={{ width: 6, height: 6, borderRadius: 999, backgroundColor: theme.primary, opacity: 0.8 }} />
              <View style={{ width: 6, height: 6, borderRadius: 999, backgroundColor: theme.primary }} />
            </View>
            <Text className="ml-2 text-xs" style={{ color: theme.textSoft, fontStyle: "italic" }}>
              {typingUsers.length === 1 ? "typing…" : `${typingUsers.length} people typing…`}
            </Text>
          </View>
        ) : null}
        <View
          className="flex-row items-end px-3 py-2"
          style={{ backgroundColor: theme.surfaceElevated, borderTopWidth: 0.5, borderTopColor: theme.divider }}
        >
          <TextInput
            className="flex-1 rounded-2xl px-3 py-2 text-sm"
            style={{
              backgroundColor: theme.inputBackground,
              color: theme.inputText,
              borderWidth: 1,
              borderColor: theme.inputBorder,
              maxHeight: 120,
            }}
            placeholder="Message"
            placeholderTextColor={theme.placeholder}
            value={composer}
            onChangeText={handleComposerChange}
            multiline
          />
          <TouchableOpacity
            onPress={handleSend}
            disabled={!composer.trim() || sending}
            activeOpacity={0.85}
            className="ml-2 items-center justify-center rounded-full"
            style={{
              width: 40,
              height: 40,
              backgroundColor: composer.trim() && !sending ? theme.primary : theme.surfaceMuted,
              shadowColor: theme.primary,
              shadowOffset: { width: 0, height: 4 },
              shadowOpacity: composer.trim() && !sending ? 0.3 : 0,
              shadowRadius: 8,
              elevation: composer.trim() && !sending ? 3 : 0,
            }}
          >
            <Ionicons name="send" size={18} color={composer.trim() && !sending ? theme.primaryContrast : theme.iconMuted} />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

export default SupabaseThread;
