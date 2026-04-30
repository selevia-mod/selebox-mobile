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

import { Feather, Ionicons, MaterialCommunityIcons, MaterialIcons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import * as ImagePicker from "expo-image-picker";
import { router, useLocalSearchParams } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, FlatList, Image as RNImage, KeyboardAvoidingView, Modal, Platform, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
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
  uploadChatImage,
} from "../lib/messages-supabase";
import { sendChatPushNotification } from "../lib/chat-push";
import { searchTenorGifs } from "../lib/tenor";
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

// Quick-pick emoji row above the composer. Hoisted out of the render path
// so we don't reallocate this 48-element array on every keystroke. The row
// is rendered horizontally and tapping any emoji appends it to the
// composer. The native keyboard's emoji picker still works for anything
// not in this list — this is just for one-tap convenience.
const QUICK_EMOJIS = [
  "😀", "😂", "🥰", "😎", "🤔", "😢", "😭", "😡", "🥺", "😴",
  "🤩", "😅", "🙃", "😇", "😘", "🥳", "😱", "🤯", "💀", "🤡",
  "😈", "👀", "🙄", "🤷", "👍", "👎", "👏", "🙌", "🙏", "💪",
  "✌️", "👋", "🤝", "💯", "🔥", "✨", "⭐", "💖", "❤️", "💔",
  "💜", "💛", "🎉", "🎊", "🥹", "☺️", "😏", "😉",
];

// Memoized so a reaction or edit on one bubble doesn't re-render the whole
// FlatList. The default React.memo shallow-compare would still re-render
// every bubble on every reactions-map change because `reactionList` is a
// new array reference each time the parent rebuilds. Custom equality
// compares the bubble-relevant fields field-by-field; `theme` and
// `onLongPress` are reference-stable so an identity check is enough.
const MessageBubbleImpl = ({ message, isMine, theme, onLongPress, reactionList, repliedTo }) => {
  const isDeleted = Boolean(message.deleted_at);
  const isPending = Boolean(message._pending);

  return (
    <TouchableOpacity
      onLongPress={() => !isDeleted && !isPending && onLongPress(message)}
      activeOpacity={0.85}
      className={`my-1 px-3 ${isMine ? "self-end" : "self-start"}`}
      style={{ maxWidth: "78%" }}
    >
      {/* Reply quote — rendered above the bubble when this message is a
          reply to another. Uses the resolved repliedTo prop (parent does
          the lookup so we don't have to thread the messages map down). */}
      {repliedTo ? (
        <View
          className={`mb-0.5 rounded-lg px-2.5 py-1.5 ${isMine ? "self-end" : "self-start"}`}
          style={{
            backgroundColor: theme.surfaceElevated,
            borderLeftWidth: 3,
            borderLeftColor: theme.primary,
            maxWidth: "100%",
          }}
        >
          <Text className="text-[10px] font-pbold" style={{ color: theme.primary }} numberOfLines={1}>
            {repliedTo.deleted_at ? "Replying to deleted message" : "Replying"}
          </Text>
          {!repliedTo.deleted_at ? (
            <Text className="text-xs" style={{ color: theme.textSoft }} numberOfLines={2}>
              {repliedTo.body || (repliedTo.image_url ? "📷 Photo" : "")}
            </Text>
          ) : null}
        </View>
      ) : null}

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

// Custom equality — only re-render when something the bubble actually
// renders has changed. We compare specific message fields (body, edits,
// deletions, image, pending state) rather than the whole object so a
// fresh reference with identical content doesn't force a paint. The
// reactionList is checked via shallow array equality (length + every
// element identity) which is correct because each reaction row is a
// stable object once realtime patches it in.
const reactionListsEqual = (a, b) => {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

const MessageBubble = memo(MessageBubbleImpl, (prev, next) => {
  if (prev.isMine !== next.isMine) return false;
  if (prev.theme !== next.theme) return false;
  if (prev.onLongPress !== next.onLongPress) return false;
  if (prev.repliedTo !== next.repliedTo) return false;
  if (!reactionListsEqual(prev.reactionList, next.reactionList)) return false;
  const a = prev.message; const b = next.message;
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    a.body === b.body &&
    a.image_url === b.image_url &&
    a.edited_at === b.edited_at &&
    a.deleted_at === b.deleted_at &&
    a._pending === b._pending &&
    a.created_at === b.created_at
  );
});

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
  // Composer attachment state — set when the user picks an image OR a GIF
  // and clears on send. The UI shows a small preview chip above the input
  // so the user can visually confirm before sending.
  const [pendingImageUri, setPendingImageUri] = useState(null);  // local URI for picked image
  const [pendingGifUrl, setPendingGifUrl] = useState(null);      // remote Tenor URL
  // Toggles the emoji quick-row + GIF modal visibility.
  const [emojiBarOpen, setEmojiBarOpen] = useState(false);
  const [gifPickerOpen, setGifPickerOpen] = useState(false);
  // Floating message-action pill state — set when the user long-presses a
  // bubble. Holds the message + an "isMine" flag so we can decide whether
  // to render the Edit/Delete buttons.
  const [actionTarget, setActionTarget] = useState(null);  // { message, isMine } | null
  // Reply state — when set, the next sendMessage call attaches replyToId.
  // The composer renders a small chip above showing what we're replying
  // to, with an X to cancel.
  const [replyingTo, setReplyingTo] = useState(null);  // message | null
  // Edit state — when set, composer becomes an edit mode pre-filled with
  // the message body. Save calls editMessage; Cancel reverts.
  const [editingMessage, setEditingMessage] = useState(null);  // message | null
  // Brief "Copied" toast after the copy action — auto-clears after 1.2s.
  const [copyToast, setCopyToast] = useState(false);
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
  // Copy-toast auto-hide timer. Tracked in a ref so the unmount cleanup
  // can clear it — without this, copying right before navigating away
  // would fire setCopyToast(false) on an unmounted component (React
  // warning + small memory blip).
  const copyToastTimerRef = useRef(null);
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
        // Three cases to disambiguate:
        //   1. The real id is already in our list — the awaited-response
        //      swap in handleSend has already replaced the optimistic.
        //      Just merge any server-only fields (idempotent).
        //   2. The real id is NOT in our list, but we have a pending
        //      optimistic from the same sender with matching body /
        //      image / reply target. This is the realtime-wins-the-race
        //      path: replace the optimistic in place so the user never
        //      sees a brief duplicate bubble. Without this, a slow HTTP
        //      response would let the realtime echo append a second
        //      bubble that only disappears once the await completes.
        //   3. Neither — it's a fresh message from the other side.
        //      Append.
        const list = messagesRef.current;
        const idx = list.findIndex((m) => m.id === newMsg.id);
        if (idx >= 0) {
          const next = list.slice();
          next[idx] = { ...list[idx], ...newMsg, _pending: false };
          setMessages(next);
        } else if (newMsg.sender_id === currentUserId) {
          // Try to find a pending optimistic this realtime row supersedes.
          const tempIdx = list.findIndex(
            (m) =>
              m._pending &&
              m.sender_id === newMsg.sender_id &&
              (m.body || "") === (newMsg.body || "") &&
              (m.reply_to_id || null) === (newMsg.reply_to_id || null) &&
              // Image match: a local file:// optimistic should match a
              // server CDN URL (different strings, but both image-bearing).
              // For text-only messages, both are null.
              Boolean(m.image_url) === Boolean(newMsg.image_url),
          );
          if (tempIdx >= 0) {
            const next = list.slice();
            next[tempIdx] = newMsg;
            setMessages(next);
          } else {
            setMessages([...list, newMsg]);
          }
        } else {
          setMessages([...list, newMsg]);
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
    // Edit mode — inlined here (rather than calling a separate
    // handleSaveEdit) so handleSend has no forward-reference into a
    // useCallback declared later in the body. Babel's var-hoisting
    // would have made the previous setup work at runtime, but the
    // deps array would have captured `handleSaveEdit = undefined` on
    // first render and rebuilt on second — unnecessary churn.
    if (editingMessage) {
      const target = editingMessage;
      const newBody = composer.trim();
      if (!target || !newBody) return;
      // No-op edit — just exit edit mode.
      if (newBody === target.body) {
        setEditingMessage(null);
        setComposer("");
        return;
      }
      // Optimistic patch.
      setMessages((prev) =>
        prev.map((m) => (m.id === target.id ? { ...m, body: newBody, edited_at: new Date().toISOString() } : m)),
      );
      setEditingMessage(null);
      setComposer("");
      try {
        await supabaseEditMessage(target.id, newBody);
      } catch (error) {
        // Roll back to the original body / edited_at on failure.
        setMessages((prev) =>
          prev.map((m) => (m.id === target.id ? { ...m, body: target.body, edited_at: target.edited_at } : m)),
        );
        Alert.alert("Edit failed", error?.message || "Could not save the edit.");
      }
      return;
    }

    const body = composer.trim();
    // Send if we have ANY of: text body, picked image, or picked GIF.
    const hasAttachment = pendingImageUri || pendingGifUrl;
    if (!body && !hasAttachment) return;
    if (sending || !conversationId) return;

    setSending(true);
    const localImage = pendingImageUri;
    const localGif = pendingGifUrl;
    const replyToId = replyingTo?.id || null;
    setComposer("");
    setPendingImageUri(null);
    setPendingGifUrl(null);
    setEmojiBarOpen(false);
    setReplyingTo(null);

    // Optimistic with a temp string id, mirroring the web's proven
    // pattern (Selebox/js/app.js around the dmState.send flow):
    //   1. Push optimistic with `temp-<ts>` id.
    //   2. Await the INSERT — server's RETURNING gives us the real row.
    //   3. Swap by tempId in messagesRef.
    //   4. The realtime echo for that same insert dedups via the existing
    //      `if (idx >= 0) merge` path in onMessageInsert (since by the
    //      time it arrives the row is already real-id).
    //
    // We deliberately do NOT pass a client-generated UUID to the INSERT.
    // Doing so works only if the schema accepts a user-supplied id; if a
    // trigger or check ever overrides it, the realtime echo carries a
    // different id than the optimistic and the bubble would stay stuck
    // _pending forever. The two-path swap below is failure-safe.
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const optimistic = {
      id: tempId,
      conversation_id: conversationId,
      sender_id: currentUserId,
      body,
      // For optimistic UI use whichever URL we have. If it's a local
      // image, the bubble shows it from the file:// URI until the upload
      // finishes and we swap in the public CDN URL.
      image_url: localGif || localImage || null,
      reply_to_id: replyToId,
      created_at: new Date().toISOString(),
      _pending: true,
    };
    setMessages([...messagesRef.current, optimistic]);

    try {
      // If we have a local image, upload first and use the resulting CDN
      // URL as image_url. GIFs are already remote URLs from Tenor —
      // nothing to upload, just pass through.
      let finalImageUrl = localGif || null;
      if (localImage && !localGif) {
        finalImageUrl = await uploadChatImage(localImage, conversationId);
      }

      const real = await supabaseSendMessage({ conversationId, body, imageUrl: finalImageUrl, replyToId });
      // Swap optimistic → real in place. If the realtime echo already
      // arrived and pushed the real row separately, the dedup-by-id in
      // onMessageInsert will have prevented a duplicate; here we just
      // replace the temp row with the canonical one. We use the ref
      // (not `messages`) so we operate on the freshest state regardless
      // of how many renders have happened during the await.
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === tempId);
        if (idx < 0) {
          // Optimistic already gone (rare — would mean the user
          // navigated away and back). Append the real if not already
          // present, else no-op.
          return prev.some((m) => m.id === real.id) ? prev : [...prev, real];
        }
        // If realtime already inserted real separately, drop the temp.
        if (prev.some((m) => m.id === real.id)) {
          return prev.filter((m) => m.id !== tempId);
        }
        const next = prev.slice();
        next[idx] = real;
        return next;
      });

      // Fire-and-forget push notification to the recipient.
      sendChatPushNotification({
        conversation,
        senderId: currentUserId,
        senderUsername: null,
        body,
        imageUrl: finalImageUrl,
      }).catch(() => {});
    } catch (error) {
      // Roll back optimistic on failure.
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      Alert.alert("Send failed", error?.message || "Could not send the message.");
    } finally {
      setSending(false);
    }
  }, [
    composer, conversationId, currentUserId, sending,
    pendingImageUri, pendingGifUrl, conversation,
    editingMessage, replyingTo,
  ]);

  // Image picker — launches the system gallery, sets pendingImageUri so
  // the user sees a preview chip above the composer, then they tap send.
  const handlePickImage = useCallback(async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (perm.status !== "granted") {
        Alert.alert("Photo access needed", "Allow photos in Settings to attach an image.");
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: false,
        quality: 0.85,
        exif: false,
      });
      if (result.canceled) return;
      const asset = result.assets?.[0];
      if (!asset?.uri) return;
      // Clear any pending GIF — composer carries one attachment at a time.
      setPendingGifUrl(null);
      setPendingImageUri(asset.uri);
    } catch (e) {
      Alert.alert("Could not pick image", e?.message || "Try again.");
    }
  }, []);

  // Tap an emoji from the quick-row → append to the composer at end.
  const handleAppendEmoji = useCallback((emoji) => {
    setComposer((prev) => `${prev}${emoji}`);
  }, []);

  // Tenor GIF picker tap → set pendingGifUrl. The send handler treats
  // GIFs the same as images, just doesn't upload them.
  const handlePickGif = useCallback((gifUrl) => {
    setPendingImageUri(null);
    setPendingGifUrl(gifUrl);
    setGifPickerOpen(false);
  }, []);

  // Long-press → open the floating action pill. Replaces the old
  // Alert-based menu with the same floating UI the web client uses
  // (emoji row + reply / copy / edit / delete icons).
  const handleLongPress = useCallback(
    (message) => {
      // Don't open on optimistic / deleted bubbles.
      if (message?._pending || message?.deleted_at) return;
      setActionTarget({ message, isMine: message.sender_id === currentUserId });
    },
    [currentUserId],
  );

  // Action sheet → emoji reaction. Toggles via the existing lib fn.
  const handleReact = useCallback((messageId, emoji) => {
    supabaseToggleReaction(messageId, emoji).catch(() => {});
    setActionTarget(null);
  }, []);

  // Action sheet → reply. Stores the source message in `replyingTo`; the
  // composer chip + sendMessage call do the rest.
  const handleStartReply = useCallback((message) => {
    setReplyingTo(message);
    setEditingMessage(null);  // can't reply + edit at the same time
    setActionTarget(null);
  }, []);

  // Action sheet → copy. Native clipboard + brief "Copied" toast.
  const handleCopy = useCallback(async (message) => {
    setActionTarget(null);
    if (!message?.body) return;
    try {
      await Clipboard.setStringAsync(message.body);
      setCopyToast(true);
      if (copyToastTimerRef.current) clearTimeout(copyToastTimerRef.current);
      copyToastTimerRef.current = setTimeout(() => {
        copyToastTimerRef.current = null;
        setCopyToast(false);
      }, 1200);
    } catch (e) {
      console.log("[supabase-chat] copy failed:", e?.message);
    }
  }, []);

  // Component-lifetime cleanup — clears any in-flight copy-toast timer
  // so the auto-hide setState doesn't fire after unmount. The other
  // timers (typing, mark-read debounce) are already scoped to their
  // respective effects.
  useEffect(() => {
    return () => {
      if (copyToastTimerRef.current) {
        clearTimeout(copyToastTimerRef.current);
        copyToastTimerRef.current = null;
      }
    };
  }, []);

  // Action sheet → edit. Pre-fills composer with the message body and
  // switches send-button into save mode. Cancel restores normal mode.
  const handleStartEdit = useCallback((message) => {
    setEditingMessage(message);
    setReplyingTo(null);  // exclusive with reply
    setComposer(message.body || "");
    setActionTarget(null);
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditingMessage(null);
    setComposer("");
  }, []);

  // (Edit save is inlined into handleSend — see the editingMessage
  // branch at the top of that callback.)

  // Action sheet → delete. Confirmation dialog then deleteMessage.
  const handleDelete = useCallback((message) => {
    setActionTarget(null);
    Alert.alert("Delete message?", "This can't be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => supabaseDeleteMessage(message.id).catch(() => {}),
      },
    ]);
  }, []);

  // Lookup table so MessageBubble can resolve reply_to_id → original
  // message in O(1) without requiring its own fetch. Built once per
  // messages change; keys map to the canonical (or optimistic) row.
  const messagesById = useMemo(() => {
    const map = {};
    for (const m of messages) map[m.id] = m;
    return map;
  }, [messages]);

  const renderItem = useCallback(
    ({ item }) => (
      <MessageBubble
        message={item}
        isMine={item.sender_id === currentUserId}
        theme={theme}
        onLongPress={handleLongPress}
        reactionList={reactions[item.id]}
        repliedTo={item.reply_to_id ? messagesById[item.reply_to_id] : null}
      />
    ),
    [currentUserId, theme, reactions, handleLongPress, messagesById],
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
          onPress={() => {
            // Prefer popping the stack; if there's nothing to pop (deep-
            // link / push-notification entry), navigate to the inbox so
            // the back button never strands the user on a dead-end screen.
            if (router.canGoBack && router.canGoBack()) {
              router.back();
            } else {
              router.replace("/(message)/channel-list");
            }
          }}
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
        // iOS: pad the content above the keyboard.
        // Android: shrink the wrapper so the input stays visible.
        //
        // keyboardVerticalOffset stays at 0 — SafeAreaView handles the
        // status-bar / home-indicator insets, and the custom header is
        // outside this KAV so React Native already knows where the
        // avoiding region begins. Setting it to the header height
        // (which we tried first) caused a visible gap between the
        // input box and the top of the keyboard on iPhones with a home
        // indicator.
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={0}
      >
        {/* Empty state rendered as a sibling — NOT as ListEmptyComponent —
            because the FlatList is `inverted` (transform scaleY(-1)) and
            ListEmptyComponent inherits that flip. The previous workaround
            applied a counter-transform but was fragile (the emoji + text
            sometimes still rendered backwards depending on platform).
            Rendering outside the inverted list sidesteps the issue
            entirely. We swap-show the FlatList vs. the empty state based
            on messages.length. */}
        {!loading && messages.length === 0 ? (
          <View className="flex-1 items-center justify-center px-6">
            <Text className="text-sm" style={{ color: theme.textSoft }}>
              Say hi 👋
            </Text>
          </View>
        ) : (
          <FlatList
            data={inverted}
            renderItem={renderItem}
            keyExtractor={(item) => item.id}
            inverted
            contentContainerStyle={{ paddingHorizontal: 8, paddingVertical: 12 }}
            showsVerticalScrollIndicator={false}
            // Drag-to-dismiss the keyboard. Standard chat UX — pulling
            // the message list down feels natural for "I'm done typing".
            // 'on-drag' dismisses without animation; smoother than
            // 'interactive' on Android.
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
          />
        )}
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
        {/* Reply chip — shown when the user is composing a reply. The
            next sendMessage call attaches replyToId. Tap X to cancel. */}
        {replyingTo ? (
          <View
            className="flex-row items-center px-3 py-2"
            style={{ backgroundColor: theme.surfaceElevated, borderTopWidth: 0.5, borderTopColor: theme.divider }}
          >
            <View style={{ width: 3, height: 32, borderRadius: 2, backgroundColor: theme.primary }} />
            <View className="ml-2 flex-1">
              <Text className="text-[10px] font-pbold" style={{ color: theme.primary }} numberOfLines={1}>
                Replying to message
              </Text>
              <Text className="text-xs" style={{ color: theme.textSoft }} numberOfLines={1}>
                {replyingTo.body || (replyingTo.image_url ? "📷 Photo" : "Message")}
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => setReplyingTo(null)}
              className="h-7 w-7 items-center justify-center rounded-full"
              style={{ backgroundColor: theme.surfaceMuted }}
            >
              <Feather name="x" size={14} color={theme.iconMuted} />
            </TouchableOpacity>
          </View>
        ) : null}

        {/* Edit chip — shown when the user is editing one of their own
            messages. Send button switches to checkmark below. */}
        {editingMessage ? (
          <View
            className="flex-row items-center px-3 py-2"
            style={{ backgroundColor: theme.surfaceElevated, borderTopWidth: 0.5, borderTopColor: theme.divider }}
          >
            <Feather name="edit-2" size={14} color={theme.primary} />
            <Text className="ml-2 flex-1 text-xs font-pbold" style={{ color: theme.primary }}>
              Editing message
            </Text>
            <TouchableOpacity
              onPress={handleCancelEdit}
              className="h-7 w-7 items-center justify-center rounded-full"
              style={{ backgroundColor: theme.surfaceMuted }}
            >
              <Feather name="x" size={14} color={theme.iconMuted} />
            </TouchableOpacity>
          </View>
        ) : null}

        {/* Pending attachment preview chip — shown above composer while the
            user has picked an image or GIF that hasn't been sent yet. Tap
            X to discard. */}
        {(pendingImageUri || pendingGifUrl) ? (
          <View className="flex-row items-center px-3 py-2" style={{ backgroundColor: theme.surfaceElevated, borderTopWidth: 0.5, borderTopColor: theme.divider }}>
            <RNImage
              source={{ uri: pendingImageUri || pendingGifUrl }}
              style={{ width: 56, height: 56, borderRadius: 8, backgroundColor: theme.surfaceMuted }}
              resizeMode="cover"
            />
            <Text className="ml-3 flex-1 text-xs" style={{ color: theme.textSoft }} numberOfLines={1}>
              {pendingGifUrl ? "GIF ready to send" : "Photo ready to send"}
            </Text>
            <TouchableOpacity
              onPress={() => { setPendingImageUri(null); setPendingGifUrl(null); }}
              className="h-7 w-7 items-center justify-center rounded-full"
              style={{ backgroundColor: theme.surfaceMuted }}
            >
              <Feather name="x" size={14} color={theme.iconMuted} />
            </TouchableOpacity>
          </View>
        ) : null}

        {/* Emoji quick-row — toggled by the smiley button in the composer.
            Tapping an emoji appends it to the current input value. Native
            keyboard emoji still works for everything else. */}
        {emojiBarOpen ? (
          <View
            className="px-2 py-2"
            style={{ backgroundColor: theme.surfaceElevated, borderTopWidth: 0.5, borderTopColor: theme.divider }}
          >
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              {QUICK_EMOJIS.map((e) => (
                <TouchableOpacity
                  key={e}
                  onPress={() => handleAppendEmoji(e)}
                  className="mx-1 h-9 w-9 items-center justify-center rounded-full"
                  style={{ backgroundColor: theme.surfaceMuted }}
                >
                  <Text style={{ fontSize: 22 }}>{e}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        ) : null}

        <View
          className="flex-row items-end px-2 py-2"
          style={{ backgroundColor: theme.surfaceElevated, borderTopWidth: 0.5, borderTopColor: theme.divider }}
        >
          {/* "+" attach button — opens system gallery picker. Image is
              uploaded on send, not on pick, so the user can change their
              mind by tapping the X on the preview chip without burning
              storage. */}
          <TouchableOpacity
            onPress={handlePickImage}
            activeOpacity={0.85}
            className="mr-1 h-10 w-10 items-center justify-center rounded-full"
            style={{ backgroundColor: theme.surfaceMuted }}
          >
            <Feather name="plus" size={18} color={theme.icon} />
          </TouchableOpacity>

          {/* GIF button — opens Tenor picker modal. */}
          <TouchableOpacity
            onPress={() => setGifPickerOpen(true)}
            activeOpacity={0.85}
            className="mr-1 h-10 w-10 items-center justify-center rounded-full"
            style={{ backgroundColor: theme.surfaceMuted }}
          >
            <Text style={{ fontSize: 11, fontWeight: "700", color: theme.icon }}>GIF</Text>
          </TouchableOpacity>

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

          {/* Emoji-bar toggle — tap to show/hide the quick-pick row above. */}
          <TouchableOpacity
            onPress={() => setEmojiBarOpen((v) => !v)}
            activeOpacity={0.85}
            className="ml-1 h-10 w-10 items-center justify-center rounded-full"
            style={{ backgroundColor: emojiBarOpen ? theme.primarySoft : theme.surfaceMuted, borderWidth: emojiBarOpen ? 1 : 0, borderColor: theme.primary }}
          >
            <Feather name="smile" size={18} color={emojiBarOpen ? theme.primary : theme.icon} />
          </TouchableOpacity>
          {(() => {
            // Single source of truth for "can the user press send right
            // now?". The previous implementation had `disabled` and the
            // visual styling each computing the same idea slightly
            // differently — `disabled` ignored attachments, the styling
            // included them. That mismatch let the user see an "active"
            // (violet) button whose tap was rejected by `disabled`.
            const sendActive =
              !sending && (Boolean(composer.trim()) || Boolean(pendingImageUri) || Boolean(pendingGifUrl));
            return (
              <TouchableOpacity
                onPress={handleSend}
                disabled={!sendActive}
                activeOpacity={0.85}
                className="ml-2 items-center justify-center rounded-full"
                style={{
                  width: 40,
                  height: 40,
                  backgroundColor: sendActive ? theme.primary : theme.surfaceMuted,
                  shadowColor: theme.primary,
                  shadowOffset: { width: 0, height: 4 },
                  shadowOpacity: sendActive ? 0.3 : 0,
                  shadowRadius: 8,
                  elevation: sendActive ? 3 : 0,
                }}
              >
                <Ionicons
                  name={editingMessage ? "checkmark" : "send"}
                  size={18}
                  color={sendActive ? theme.primaryContrast : theme.iconMuted}
                />
              </TouchableOpacity>
            );
          })()}
        </View>

        {/* GIF picker modal — Tenor search + grid. Slides up from bottom. */}
        <GifPickerModal
          visible={gifPickerOpen}
          onClose={() => setGifPickerOpen(false)}
          onPick={handlePickGif}
          theme={theme}
        />

        {/* Floating message-action pill — opens on long-press of any
            non-deleted, non-pending message bubble. Mirrors web's pill:
            😀 reactions row, ↩ reply, ⎘ copy, ✏ edit (own), 🗑 delete (own).
            Tap outside to dismiss. */}
        <MessageActionPill
          target={actionTarget}
          theme={theme}
          onClose={() => setActionTarget(null)}
          onReact={handleReact}
          onReply={handleStartReply}
          onCopy={handleCopy}
          onEdit={handleStartEdit}
          onDelete={handleDelete}
        />

        {/* Brief "Copied" toast after the copy action. */}
        {copyToast ? (
          <View
            className="items-center justify-center"
            style={{
              position: "absolute",
              bottom: 100,
              left: 0,
              right: 0,
              alignItems: "center",
              pointerEvents: "none",
            }}
          >
            <View
              className="rounded-full px-4 py-2"
              style={{ backgroundColor: theme.text, opacity: 0.9 }}
            >
              <Text className="text-xs font-pbold" style={{ color: theme.background }}>
                Copied
              </Text>
            </View>
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

// Floating message action pill. Renders as a centered overlay above the
// thread when long-press selects a message. Layout mirrors web's pill: a
// quick-reaction emoji row + 4 icon buttons (reply / copy / edit / delete).
const MessageActionPill = ({ target, theme, onClose, onReact, onReply, onCopy, onEdit, onDelete }) => {
  if (!target) return null;
  const { message, isMine } = target;
  return (
    <Modal visible={true} transparent animationType="fade" onRequestClose={onClose}>
      {/* Backdrop — tap anywhere to dismiss. */}
      <TouchableOpacity
        activeOpacity={1}
        onPress={onClose}
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.35)", justifyContent: "center", alignItems: "center", padding: 16 }}
      >
        <View
          className="rounded-full"
          style={{
            backgroundColor: theme.surfaceElevated,
            borderWidth: 1,
            borderColor: theme.border,
            paddingVertical: 8,
            paddingHorizontal: 8,
            flexDirection: "row",
            alignItems: "center",
            shadowColor: "#000",
            shadowOffset: { width: 0, height: 6 },
            shadowOpacity: 0.18,
            shadowRadius: 12,
            elevation: 6,
          }}
        >
          {/* Emoji reactions row */}
          {REACTION_EMOJIS.map((emoji) => (
            <TouchableOpacity
              key={emoji}
              onPress={() => onReact(message.id, emoji)}
              className="mx-0.5 h-9 w-9 items-center justify-center rounded-full"
            >
              <Text style={{ fontSize: 22 }}>{emoji}</Text>
            </TouchableOpacity>
          ))}

          {/* Divider */}
          <View style={{ width: 1, height: 28, backgroundColor: theme.divider, marginHorizontal: 4 }} />

          {/* Reply */}
          <TouchableOpacity
            onPress={() => onReply(message)}
            className="mx-0.5 h-9 w-9 items-center justify-center rounded-full"
          >
            <MaterialCommunityIcons name="reply" size={20} color={theme.icon} />
          </TouchableOpacity>

          {/* Copy — disabled if no body (image/GIF only) */}
          {message.body ? (
            <TouchableOpacity
              onPress={() => onCopy(message)}
              className="mx-0.5 h-9 w-9 items-center justify-center rounded-full"
            >
              <Feather name="copy" size={18} color={theme.icon} />
            </TouchableOpacity>
          ) : null}

          {/* Edit (own only, only for text messages — editing an image/GIF
              caption isn't supported in v1). */}
          {isMine && message.body ? (
            <TouchableOpacity
              onPress={() => onEdit(message)}
              className="mx-0.5 h-9 w-9 items-center justify-center rounded-full"
            >
              <Feather name="edit-2" size={18} color={theme.icon} />
            </TouchableOpacity>
          ) : null}

          {/* Delete (own only) */}
          {isMine ? (
            <TouchableOpacity
              onPress={() => onDelete(message)}
              className="mx-0.5 h-9 w-9 items-center justify-center rounded-full"
            >
              <Feather name="trash-2" size={18} color="#dc2626" />
            </TouchableOpacity>
          ) : null}
        </View>
      </TouchableOpacity>
    </Modal>
  );
};

// GIF picker modal — search bar at top, grid of trending/searched GIFs
// below. Tap a GIF to set it as the pending attachment + close.
const GifPickerModal = ({ visible, onClose, onPick, theme }) => {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef(null);

  // On open, load trending. On query change, debounced search.
  useEffect(() => {
    if (!visible) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      const r = await searchTenorGifs(query, { limit: 24 });
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
          {/* Header row */}
          <View className="flex-row items-center pb-3">
            <Text className="font-pbold text-base flex-1" style={{ color: theme.text }}>
              Send a GIF
            </Text>
            <TouchableOpacity onPress={onClose} className="h-8 w-8 items-center justify-center rounded-full" style={{ backgroundColor: theme.surfaceMuted }}>
              <Feather name="x" size={16} color={theme.icon} />
            </TouchableOpacity>
          </View>

          {/* Search input */}
          <View
            className="flex-row items-center rounded-2xl px-3 mb-2"
            style={{ borderWidth: 1, borderColor: theme.inputBorder, backgroundColor: theme.inputBackground }}
          >
            <Feather name="search" size={16} color={theme.iconMuted} />
            <TextInput
              className="ml-2 flex-1 py-2 text-sm"
              placeholder="Search Tenor"
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
                {query ? "No GIFs found." : "GIF picker is unavailable. Set TENOR_API_KEY in private/secrets.js."}
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
};

export default SupabaseThread;
