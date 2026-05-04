// Supabase chat: conversation list.
//
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
import { Alert, AppState, FlatList, Modal, Pressable, RefreshControl, Text, TextInput, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import useAppTheme from "../hooks/useAppTheme";
import UserRoleBadgeIcons from "./UserRoleBadgeIcons";
// Phase E.10 — tier-tuned FlatList config for the conversations list.
// Conversation lists are usually short, but on low-tier devices the
// initial 10-row paint + 21-screen window is still wasteful.
import { getCachedConversations, setCachedConversations } from "../lib/chat-cache";
import { getFlatListConfig } from "../lib/device-tier";
import {
  chatEvents,
  leaveGroup as supabaseLeaveGroup,
  loadConversations,
  setArchived as supabaseSetArchived,
  setMutedUntil as supabaseSetMutedUntil,
  subscribeToInbox,
} from "../lib/messages-supabase";
import {
  hasPin as secretHasPin,
  isUnlocked as secretIsUnlocked,
  onAppStateChange as secretOnAppStateChange,
  setPin as secretSetPin,
  subscribe as subscribeSecretLock,
  unlock as secretUnlock,
  verifyPin as secretVerifyPin,
} from "../lib/secret-lock";
import TimeAgo from "../lib/utils/time-ago";

const ConversationRow = ({ conversation, onPress, onLongPress, theme, currentUserId }) => {
  // The DB column is `is_group` (snake_case). The destructuring used to
  // read `isGroup` directly which always evaluated undefined → groups
  // rendered as 1:1 conversations. Rename here so the rest of this
  // component can use `isGroup` naturally.
  // The DB columns are all snake_case (last_message_at, last_message_preview,
  // last_message_sender). The previous destructuring read `lastMessageAt`
  // (camelCase), which always evaluated to undefined and hid the timestamp
  // on every conversation row.
  const {
    is_group: isGroup,
    otherUser,
    members,
    last_message_at: lastMessageAt,
    last_message_preview,
    last_message_sender,
    muted,
  } = conversation;
  const unread = conversation.unread || 0;
  // Note: archived filtering is handled by the parent (SupabaseConversationsList
  // toggles between 'active' and 'archived' view modes), so we no longer
  // skip archived rows here.

  // Avatar — preference order:
  //   group + conversation.avatar_url → render the group photo (creator-set)
  //   group + members → stack first 2 member avatars
  //   group + nothing → generic group icon
  //   1:1 → other user's avatar / initials
  // Resolving conversation.avatar_url first means a creator's chosen group
  // photo shows everywhere immediately — without it, the group photo
  // editor in group-info had no visible effect on the chat list.
  const renderAvatar = () => {
    if (isGroup) {
      if (conversation.avatar_url) {
        return (
          <FastImage
            source={{ uri: conversation.avatar_url }}
            style={{ width: 48, height: 48, borderRadius: 999, backgroundColor: theme.surfaceMuted }}
          />
        );
      }
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

  // Last-message preview. Prefix conventions:
  //   - "You: hey" — if the last sender was the current user (matches
  //     iMessage / WhatsApp / Messenger).
  //   - "Charles: hey" — for groups when somebody else sent the last
  //     message, so the row tells you who spoke without opening the
  //     thread (Messenger pattern). For 1:1's there's no ambiguity, so
  //     we omit the prefix.
  const previewText = (() => {
    if (!last_message_preview) return isGroup ? "New conversation" : "Say hi";
    const isOwn = last_message_sender === currentUserId;
    if (isOwn) return `You: ${last_message_preview}`;
    if (isGroup && last_message_sender) {
      const sender = (members || []).find((m) => m.id === last_message_sender);
      const senderName = sender?.username || null;
      if (senderName) return `${senderName}: ${last_message_preview}`;
    }
    return last_message_preview;
  })();

  return (
    <TouchableOpacity
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      activeOpacity={0.85}
      className="flex-row items-center px-4 py-3"
      style={{ borderBottomWidth: 0.5, borderBottomColor: theme.divider }}
    >
      {renderAvatar()}
      <View className="ml-3 flex-1">
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center flex-1">
            <Text className="font-pbold text-base" style={{ color: theme.text }} numberOfLines={1}>
              {title}
            </Text>
            {!isGroup && <UserRoleBadgeIcons user={otherUser} size={14} />}
          </View>
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

const SupabaseConversationsList = ({ currentUserId, openSecretConversationId = null }) => {
  const { theme } = useAppTheme();
  // Paint from MMKV cache instantly on mount so the user never sees a
  // skeleton spinner when the cache is warm. The fetch effect below
  // refreshes against the network and overwrites the cache with the
  // canonical server state. If there's no cache (first launch / new
  // user / signed out and back in), `conversations` starts empty and
  // we fall back to the loading state path.
  const [conversations, setConversations] = useState(() => {
    const cached = currentUserId ? getCachedConversations(currentUserId) : null;
    return cached || [];
  });
  // `loading` flips to true only when we don't have ANY content to
  // paint — a warm cache means we skip the skeleton entirely.
  const [loading, setLoading] = useState(() => {
    const cached = currentUserId ? getCachedConversations(currentUserId) : null;
    return !(cached && cached.length);
  });
  const [refreshing, setRefreshing] = useState(false);
  // 'active' shows non-archived conversations (default). 'archived' shows
  // archived ones, accessed via the toggle pill in the header. Without
  // this view, archiving a chat hid it permanently with no recovery path.
  // openSecretConversationId — when this list was reached from a
  // private-DM bell tap on a locked Secret tab, the param tells us
  // which conversation to auto-open after the user unlocks. Default
  // to Secret tab in that case so SecretLockGate is the first thing
  // they see (instead of Active, which would force an extra tap).
  const [viewMode, setViewMode] = useState(openSecretConversationId ? "secret" : "active");
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
      // Phase D originally bailed out here unless `supabase.auth.getSession()`
      // returned a row, which gave every Appwrite-auth user the "Chat is on
      // the new system, sign out and back in" empty state — even though the
      // chat lib's requireUser() now falls back to the Appwrite-resolved
      // Supabase UUID via setMessagesAppwriteUser(). The right gate is
      // simply "do we know which Supabase profile corresponds to me?" —
      // i.e. is `currentUserId` populated? If yes, proceed. If no, the
      // resolution hasn't completed yet (rare race on first app open) and
      // we show the in-progress empty state.
      if (!currentUserId) {
        setHasSession(false);
        setConversations([]);
        return;
      }
      setHasSession(true);
      const list = await loadConversations();
      setConversations(list);
      lastFetchedAtRef.current = Date.now();
      // Persist the freshly fetched list so the next tab focus paints
      // instantly. We cache after EVERY successful fetch (not just the
      // first) so any per-side flag changes (archive, mute) and unread
      // count drops are reflected in the cache too.
      setCachedConversations(currentUserId, list);
    } catch (error) {
      console.log("[supabase-chat] loadConversations failed:", error?.message);
      setConversations([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [currentUserId]);

  useFocusEffect(
    useCallback(() => {
      // Honors the freshness gate inside fetchConversations.
      fetchConversations();
    }, [fetchConversations]),
  );

  // Listen for "I just marked a conversation read" events so the
  // per-conversation unread badge clears the moment the thread opens.
  // Without this, the row keeps showing the unread pill ("1" / "2") even
  // after the user has entered the thread — only refreshing on next
  // network refetch.
  useEffect(() => {
    if (!currentUserId) return undefined;
    const onRead = ({ conversationId }) => {
      if (!conversationId) return;
      const list = conversationsRef.current;
      const idx = list.findIndex((c) => c.id === conversationId);
      if (idx < 0) return;
      const existing = list[idx];
      if ((existing.unread || 0) === 0) return;
      const next = list.map((c, i) => (i === idx ? { ...c, unread: 0 } : c));
      setConversations(next);
      // Mirror into the cache too — without this the next focus paint
      // would show stale unread counts from the cached blob.
      setCachedConversations(currentUserId, next);
    };

    // archived: the active/archived split is computed from `conversation.archived`,
    // so flipping that flag is enough — the row visibly hops between buckets
    // without a refetch.
    const onArchived = ({ conversationId, archived }) => {
      const list = conversationsRef.current;
      const idx = list.findIndex((c) => c.id === conversationId);
      if (idx < 0) return;
      const next = list.map((c, i) => (i === idx ? { ...c, archived: Boolean(archived) } : c));
      setConversations(next);
      setCachedConversations(currentUserId, next);
    };

    // left: drop the row entirely. The user is no longer a member.
    const onLeft = ({ conversationId }) => {
      const list = conversationsRef.current;
      const next = list.filter((c) => c.id !== conversationId);
      if (next.length === list.length) return;
      setConversations(next);
      setCachedConversations(currentUserId, next);
    };

    // groupInfoUpdated: patch name and/or avatar_url in place. Replaces
    // the older "renamed" event — the same handler covers both axes
    // (and any future fields) without needing a parallel listener.
    const onGroupInfoUpdated = ({ conversationId, name, avatar_url }) => {
      const list = conversationsRef.current;
      const idx = list.findIndex((c) => c.id === conversationId);
      if (idx < 0) return;
      const patch = {};
      if (typeof name === "string") patch.name = name;
      if (avatar_url !== undefined) patch.avatar_url = avatar_url;
      if (Object.keys(patch).length === 0) return;
      const next = list.map((c, i) => (i === idx ? { ...c, ...patch } : c));
      setConversations(next);
      setCachedConversations(currentUserId, next);
    };

    // membersChanged: the row's member-avatars stack and "X members" count
    // are computed from `members[]`. We don't have the new list locally —
    // force a silent refetch (bypassing the freshness gate) so the row
    // re-renders with the latest cast.
    const onMembersChanged = () => {
      fetchConversations({ silent: true, force: true });
    };

    // created: bypass the freshness gate and refetch so a freshly-created
    // group/conversation shows at the top of the list immediately. Same
    // shape as membersChanged.
    const onCreated = () => {
      fetchConversations({ silent: true, force: true });
    };

    chatEvents.on("read", onRead);
    chatEvents.on("archived", onArchived);
    chatEvents.on("left", onLeft);
    chatEvents.on("groupInfoUpdated", onGroupInfoUpdated);
    chatEvents.on("membersChanged", onMembersChanged);
    chatEvents.on("created", onCreated);
    return () => {
      chatEvents.off("read", onRead);
      chatEvents.off("archived", onArchived);
      chatEvents.off("left", onLeft);
      chatEvents.off("groupInfoUpdated", onGroupInfoUpdated);
      chatEvents.off("membersChanged", onMembersChanged);
      chatEvents.off("created", onCreated);
    };
  }, [currentUserId, fetchConversations]);

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
      // Mirror the realtime patch into the cache too — without this,
      // the cache stays at the last full-fetch's preview/timestamps and
      // the user sees stale "last message" text when they re-open the
      // tab. Cheap microsecond write.
      setCachedConversations(currentUserId, next);
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

  // Secret tab lock state — re-rendered whenever the lock module fires
  // a state change (manual lock/unlock, AppState-driven re-lock).
  const [secretUnlockedFlag, setSecretUnlockedFlag] = useState(secretIsUnlocked());
  useEffect(() => subscribeSecretLock(setSecretUnlockedFlag), []);

  // Deep-link from a private-DM bell tap. Once the user unlocks, jump
  // straight into the conversation thread they originally tapped — same
  // hand-off the web does. Guarded with a ref so we only navigate once
  // per mount; without it, every relock-then-unlock cycle would replay
  // the navigation. Cleared after firing.
  const pendingOpenRef = useRef(openSecretConversationId);
  useEffect(() => {
    if (!secretUnlockedFlag) return;
    const pending = pendingOpenRef.current;
    if (!pending) return;
    pendingOpenRef.current = null;
    router.push({ pathname: "channel", params: { conversationId: pending } });
  }, [secretUnlockedFlag]);
  // Wire the AppState transitions so backgrounding the app for >60s
  // re-locks the Secret tab. Done at the list level so it covers every
  // path that lands on this component.
  useEffect(() => {
    const sub = AppState.addEventListener("change", secretOnAppStateChange);
    return () => sub.remove();
  }, []);

  // Long-press → action sheet (Messenger pattern). The sheet is rendered
  // once at the list level and parameterized by which conversation was
  // long-pressed. Holding null = closed.
  const [actionTarget, setActionTarget] = useState(null);
  const closeActions = useCallback(() => setActionTarget(null), []);

  const handleLongPress = useCallback((conversation) => {
    setActionTarget(conversation);
  }, []);

  const renderItem = useCallback(
    ({ item }) => (
      <ConversationRow
        conversation={item}
        onPress={() => handleSelect(item)}
        onLongPress={() => handleLongPress(item)}
        theme={theme}
        currentUserId={currentUserId}
      />
    ),
    [handleSelect, handleLongPress, theme, currentUserId],
  );

  const keyExtractor = useCallback((item) => item.id, []);

  // Split conversations by tier so the three-tab pill can show counts
  // and the FlatList can render the right slice.
  //
  // Bucketing rules (in priority order):
  //   - is_secret=true → Secret bucket. Always wins; secret rows never
  //     appear under Active or Archived even if archived_by_x is set.
  //     Otherwise a "delete" on a Secret would visually leak it back to
  //     Archived, which defeats the privacy floor.
  //   - archived (per-side flag) → Archived bucket.
  //   - else → Active bucket.
  const { activeList, archivedList, secretList } = useMemo(() => {
    const active = [];
    const archived = [];
    const secret = [];
    for (const c of conversations) {
      if (c.is_secret) secret.push(c);
      else if (c.archived) archived.push(c);
      else active.push(c);
    }
    return { activeList: active, archivedList: archived, secretList: secret };
  }, [conversations]);
  const visibleList =
    viewMode === "archived" ? archivedList : viewMode === "secret" ? secretList : activeList;

  // Header pill — three tabs: Active / Archived / Secret. The Archived
  // chip is hidden when empty (no point showing "Archived (0)"); the
  // Secret chip is ALWAYS shown so the lock affordance is discoverable
  // even when the user has no Secret chats yet.
  const renderViewModeHeader = () => {
    return (
      <View
        className="flex-row items-center px-4 py-2"
        style={{ borderBottomWidth: 0.5, borderBottomColor: theme.divider, backgroundColor: theme.background }}
      >
        <TouchableOpacity
          onPress={() => setViewMode("active")}
          className="rounded-full px-3 py-1.5"
          style={{
            backgroundColor: viewMode === "active" ? theme.primary : "transparent",
            borderWidth: 1,
            borderColor: viewMode === "active" ? theme.primary : theme.border,
            marginRight: 8,
          }}
        >
          <Text
            className="text-xs font-pbold"
            style={{ color: viewMode === "active" ? (theme.primaryContrast ?? "#fff") : theme.text }}
          >
            Active{viewMode === "active" ? "" : ` (${activeList.length})`}
          </Text>
        </TouchableOpacity>
        {archivedList.length > 0 || viewMode === "archived" ? (
          <TouchableOpacity
            onPress={() => setViewMode("archived")}
            className="rounded-full px-3 py-1.5"
            style={{
              backgroundColor: viewMode === "archived" ? theme.primary : "transparent",
              borderWidth: 1,
              borderColor: viewMode === "archived" ? theme.primary : theme.border,
              marginRight: 8,
            }}
          >
            <Text
              className="text-xs font-pbold"
              style={{ color: viewMode === "archived" ? (theme.primaryContrast ?? "#fff") : theme.text }}
            >
              Archived ({archivedList.length})
            </Text>
          </TouchableOpacity>
        ) : null}
        {/* Secret tab — always shown. Renders a small lock glyph next to
            the label. We deliberately DON'T show the unread count here —
            counting Secret unreads on the tab itself would leak that the
            user has Secret traffic, defeating the discreet design. */}
        <TouchableOpacity
          onPress={() => setViewMode("secret")}
          className="flex-row items-center rounded-full px-3 py-1.5"
          style={{
            backgroundColor: viewMode === "secret" ? theme.primary : "transparent",
            borderWidth: 1,
            borderColor: viewMode === "secret" ? theme.primary : theme.border,
          }}
        >
          <Feather
            name="lock"
            size={11}
            color={viewMode === "secret" ? (theme.primaryContrast ?? "#fff") : theme.text}
            style={{ marginRight: 4 }}
          />
          <Text
            className="text-xs font-pbold"
            style={{ color: viewMode === "secret" ? (theme.primaryContrast ?? "#fff") : theme.text }}
          >
            Secret
          </Text>
        </TouchableOpacity>
      </View>
    );
  };

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

  // currentUserId hasn't been resolved yet (global-provider is still
  // running setMessagesAppwriteUser → profiles.legacy_appwrite_id lookup).
  // Show a generic "loading" message while the resolution finishes.
  if (hasSession === false) {
    return (
      <View className="flex-1 items-center justify-center px-6">
        <Text className="text-sm" style={{ color: theme.textSoft }}>
          Setting up your messages…
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

  // Special empty state for the archived view.
  const isEmptyVisible = visibleList.length === 0;

  // Secret tab is gated by the lock — show the PIN gate instead of the
  // list when the user hasn't unlocked this session yet. Done after the
  // header render so the tabs themselves stay tappable (user can still
  // bounce back to Active without authenticating).
  const secretLocked = viewMode === "secret" && !secretUnlockedFlag;

  return (
    <View style={{ flex: 1, backgroundColor: theme.background }}>
      {renderViewModeHeader()}
      {secretLocked ? (
        <SecretLockGate theme={theme} />
      ) : isEmptyVisible ? (
        <View className="flex-1 items-center justify-center px-6">
          {viewMode === "secret" ? (
            <>
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
                <Feather name="lock" size={26} color={theme.primary} />
              </View>
              <Text className="font-pbold text-base" style={{ color: theme.text }}>
                No Secret chats yet
              </Text>
              <Text className="mt-2 max-w-[300px] text-center text-sm" style={{ color: theme.textSoft, lineHeight: 20 }}>
                Secret chats are silent — no notifications, hidden from the unread badge, and only available with mutual followers.
              </Text>
              <TouchableOpacity
                onPress={() => router.push("/(message)/new-secret-chat")}
                activeOpacity={0.85}
                className="mt-5 flex-row items-center rounded-full px-4 py-2.5"
                style={{ backgroundColor: theme.primary }}
              >
                <Feather name="lock" size={14} color={theme.primaryContrast} />
                <Text className="ml-2 font-pbold text-sm" style={{ color: theme.primaryContrast }}>
                  Start a Secret chat
                </Text>
              </TouchableOpacity>
            </>
          ) : (
            <Text className="text-sm" style={{ color: theme.textSoft }}>
              {viewMode === "archived" ? "No archived chats." : "No active chats."}
            </Text>
          )}
        </View>
      ) : (
        <FlatList
          data={visibleList}
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
      )}

      <ConversationActionSheet
        visible={Boolean(actionTarget)}
        conversation={actionTarget}
        currentUserId={currentUserId}
        theme={theme}
        onClose={closeActions}
      />
    </View>
  );
};

// Long-press action sheet — Messenger-style. Rendered once at the list
// level and shown for whichever row was long-pressed. Items differ for
// 1:1 (Mute / Archive / Delete) vs group (View members / Mute / Archive
// / Leave). Mute is a toggle: shows "Unmute" when currently muted.
//
// Each action calls the same lib helper the chat thread uses so we get
// the same chatEvents emit + cache patch path for free.
const ConversationActionSheet = ({ visible, conversation, currentUserId, theme, onClose }) => {
  if (!conversation) return null;
  const isGroup = Boolean(conversation.is_group);
  const isMuted = Boolean(conversation.muted);
  const isArchived = Boolean(conversation.archived);
  const dangerColor = "#ef4444";

  const wrap = (action) => async () => {
    onClose();
    // Defer the actual call until the sheet has had a chance to fully
    // animate out. iOS will swallow a system Alert that opens while the
    // sheet's Modal portal is mid-dismiss, which manifested as "delete
    // does nothing" — the Alert was created but hidden behind the
    // collapsing sheet, so the user never saw it. 280ms covers the
    // fade animation (~250ms) plus a few ms of slack.
    setTimeout(action, 280);
  };

  const handleViewMembers = wrap(() => {
    router.push({
      pathname: "/(message)/group-info",
      params: { conversationId: conversation.id },
    });
  });

  const handleToggleMute = wrap(async () => {
    try {
      const until = isMuted ? null : new Date(Date.now() + 8 * 60 * 60 * 1000);
      await supabaseSetMutedUntil(conversation, until);
    } catch (e) {
      Alert.alert("Couldn't update mute", e?.message || "Try again.");
    }
  });

  const handleArchive = wrap(async () => {
    try {
      await supabaseSetArchived(conversation, !isArchived);
    } catch (e) {
      Alert.alert("Couldn't update", e?.message || "Try again.");
    }
  });

  const handleDelete = wrap(() => {
    Alert.alert("Delete conversation?", "This removes the conversation from your inbox.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await supabaseSetArchived(conversation, true);
          } catch (e) {
            Alert.alert("Couldn't delete", e?.message || "Try again.");
          }
        },
      },
    ]);
  });

  const handleLeave = wrap(() => {
    Alert.alert("Leave this group?", "You won't receive new messages from this group.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Leave",
        style: "destructive",
        onPress: async () => {
          try {
            await supabaseLeaveGroup(conversation.id);
          } catch (e) {
            Alert.alert("Couldn't leave", e?.message || "Try again.");
          }
        },
      },
    ]);
  });

  const Row = ({ icon, label, onPress, danger }) => (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.85}
      className="flex-row items-center rounded-xl px-4 py-3 mt-2"
      style={{ backgroundColor: theme.surfaceMuted }}
    >
      <MaterialIcons name={icon} size={22} color={danger ? dangerColor : theme.icon} style={{ marginRight: 12 }} />
      <Text className="font-pbold text-base" style={{ color: danger ? dangerColor : theme.text }}>
        {label}
      </Text>
    </TouchableOpacity>
  );

  const title = isGroup ? conversation.name || "Group actions" : conversation.otherUser?.username || "Chat actions";

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }}>
        <Pressable
          // Prevent backdrop press from closing when tapping inside the sheet.
          onPress={(e) => e.stopPropagation()}
          style={{
            backgroundColor: theme.surfaceElevated || theme.background,
            paddingHorizontal: 20,
            paddingTop: 16,
            paddingBottom: 28,
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
          }}
        >
          <Text className="font-pbold text-lg" style={{ color: theme.text }} numberOfLines={1}>
            {title}
          </Text>

          {isGroup ? <Row icon="group" label="View members" onPress={handleViewMembers} /> : null}

          <Row
            icon={isMuted ? "notifications" : "notifications-off"}
            label={isMuted ? "Unmute notifications" : "Mute for 8 hours"}
            onPress={handleToggleMute}
          />
          <Row
            icon={isArchived ? "unarchive" : "archive"}
            label={isArchived ? "Unarchive" : "Archive"}
            onPress={handleArchive}
          />

          {isGroup ? (
            <Row icon="logout" label="Leave group" onPress={handleLeave} danger />
          ) : (
            <Row icon="delete" label="Delete conversation" onPress={handleDelete} danger />
          )}

          <TouchableOpacity onPress={onClose} className="mt-4 items-center py-3">
            <Text className="font-pbold text-base" style={{ color: theme.textSoft }}>
              Cancel
            </Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
};

// Secret-tab PIN gate. Two modes based on whether the user has set a
// PIN before:
//   - First time: prompt for a new PIN, then a confirm. On match, the
//     PIN is stored (hashed) and the tab unlocks immediately.
//   - Returning: prompt for the existing PIN. Match → unlock; mismatch
//     → shake the input and clear it.
//
// 4-digit numeric for tonight's slice. The lock module accepts longer
// PINs if/when we expose that affordance.
const SecretLockGate = ({ theme }) => {
  const [phase, setPhase] = useState(secretHasPin() ? "verify" : "createNew");
  const [pin, setPin] = useState("");
  const [pendingPin, setPendingPin] = useState(""); // first half of "createNew" → "createConfirm"
  const [error, setError] = useState("");

  const onSubmit = useCallback(() => {
    if (pin.length < 4) {
      setError("Use at least 4 digits.");
      return;
    }
    if (phase === "createNew") {
      setPendingPin(pin);
      setPin("");
      setError("");
      setPhase("createConfirm");
      return;
    }
    if (phase === "createConfirm") {
      if (pin !== pendingPin) {
        setError("PINs don't match. Try again.");
        setPin("");
        setPendingPin("");
        setPhase("createNew");
        return;
      }
      try {
        secretSetPin(pin);
        setError("");
        setPin("");
        setPendingPin("");
      } catch (e) {
        setError(e?.message || "Could not set PIN.");
      }
      return;
    }
    // verify
    if (secretVerifyPin(pin)) {
      secretUnlock();
      setPin("");
      setError("");
    } else {
      setError("Wrong PIN.");
      setPin("");
    }
  }, [pin, phase, pendingPin]);

  const titleByPhase = {
    createNew: "Set a Secret PIN",
    createConfirm: "Confirm your PIN",
    verify: "Enter your Secret PIN",
  };
  const subtitleByPhase = {
    createNew: "This PIN locks your Secret tab. Pick at least 4 digits.",
    createConfirm: "Enter the same digits once more.",
    verify: "Enter your PIN to view Secret chats.",
  };

  return (
    <View className="flex-1 items-center justify-center px-6">
      <View
        className="mb-5 items-center justify-center"
        style={{
          width: 72,
          height: 72,
          borderRadius: 999,
          backgroundColor: theme.primarySoft,
          borderWidth: 1,
          borderColor: theme.primary,
        }}
      >
        <Feather name="lock" size={28} color={theme.primary} />
      </View>
      <Text className="font-pbold text-xl" style={{ color: theme.text }}>
        {titleByPhase[phase]}
      </Text>
      <Text className="mt-2 max-w-[300px] text-center text-sm" style={{ color: theme.textSoft, lineHeight: 20 }}>
        {subtitleByPhase[phase]}
      </Text>

      <TextInput
        value={pin}
        onChangeText={(v) => {
          // Numeric only, max 6 digits.
          setPin(v.replace(/[^0-9]/g, "").slice(0, 6));
          if (error) setError("");
        }}
        keyboardType="number-pad"
        secureTextEntry
        autoFocus
        maxLength={6}
        className="mt-6 rounded-2xl px-4 py-3 text-center text-xl tracking-[6px]"
        style={{
          width: 220,
          borderWidth: 1,
          borderColor: error ? "#ef4444" : theme.inputBorder,
          backgroundColor: theme.inputBackground,
          color: theme.inputText,
        }}
        placeholder="••••"
        placeholderTextColor={theme.placeholder}
        onSubmitEditing={onSubmit}
        returnKeyType="done"
      />

      {error ? (
        <Text className="mt-2 text-xs" style={{ color: "#ef4444" }}>
          {error}
        </Text>
      ) : null}

      <TouchableOpacity
        onPress={onSubmit}
        disabled={pin.length < 4}
        activeOpacity={0.85}
        className="mt-5 rounded-full px-5 py-2.5"
        style={{
          backgroundColor: pin.length >= 4 ? theme.primary : theme.surfaceMuted,
          opacity: pin.length >= 4 ? 1 : 0.6,
        }}
      >
        <Text className="font-pbold text-sm" style={{ color: pin.length >= 4 ? theme.primaryContrast : theme.textMuted }}>
          {phase === "verify" ? "Unlock" : phase === "createConfirm" ? "Confirm" : "Continue"}
        </Text>
      </TouchableOpacity>

      {/* Tiny note that biometric is coming. Removes confusion when
          users wonder why Face ID didn't pop. */}
      <Text className="mt-6 max-w-[280px] text-center text-[11px]" style={{ color: theme.textSubtle }}>
        Biometric unlock (Face ID / Touch ID) lands when expo-local-authentication
        is added to the build.
      </Text>
    </View>
  );
};

export default SupabaseConversationsList;
