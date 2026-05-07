// Supabase chat: thread (one conversation) view.
//
// Reads from lib/messages-supabase.js, subscribes to
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
import RNModal from "react-native-modal";
import { useGlobalContext } from "../context/global-provider";
import { reportContent } from "../lib/safety";
import ReportContentModal from "./ReportContentModal";
import UserRoleBadgeIcons from "./UserRoleBadgeIcons";
import { ActivityIndicator, Alert, FlatList, Image as RNImage, KeyboardAvoidingView, Modal, Platform, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import { SafeAreaView } from "react-native-safe-area-context";
import useAppTheme from "../hooks/useAppTheme";
import {
  deleteMessage as supabaseDeleteMessage,
  editMessage as supabaseEditMessage,
  leaveGroup as supabaseLeaveGroup,
  loadConversationById,
  loadMessages,
  markConversationRead,
  sendMessage as supabaseSendMessage,
  sendTypingBroadcast,
  setArchived as supabaseSetArchived,
  setMutedUntil as supabaseSetMutedUntil,
  subscribeToConversation,
  subscribeToPresenceAndTyping,
  toggleReaction as supabaseToggleReaction,
  uploadChatImage,
} from "../lib/messages-supabase";
import { sendChatPushNotification } from "../lib/chat-push";
import { searchGiphyGifs } from "../lib/giphy";
import { markChatNotificationsRead } from "../lib/notifications-supabase";
import supabase from "../lib/supabase";

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

// Time gap that triggers a date-section divider between two messages.
// Mirrors Facebook Messenger's pattern: when two messages are >1 hour
// apart, we render a small "TODAY AT 9:00 AM" divider above the newer
// cluster. Day boundary always triggers a divider regardless of gap so
// the user can tell at a glance which day each cluster belongs to.
const DIVIDER_GAP_MS = 60 * 60 * 1000;

// Format the divider label above a cluster. Web's pattern:
//   - Same day:           "Today at 9:00 AM"
//   - Previous day:       "Yesterday at 6:32 PM"
//   - Older:              "Mar 3 at 2:15 PM"  (current year)
//   - Older + last year:  "Mar 3, 2024 at 2:15 PM"
// Uses the device locale for time formatting so AM/PM vs 24-hour
// follows OS preference.
const formatDividerLabel = (isoString) => {
  const d = new Date(isoString);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yest.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (sameDay) return `Today at ${time}`;
  if (isYesterday) return `Yesterday at ${time}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  const dateOpts = sameYear
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" };
  return `${d.toLocaleDateString(undefined, dateOpts)} at ${time}`;
};

// Walk the chronological messages array and interleave divider rows.
// Output rows are tagged so the FlatList renderItem can switch on type:
//   { type: "divider", id, label }   — a "Today at 9:00" header
//   { type: "message", id, message } — a message bubble
// Dividers are inserted before the first message AND any message whose
// gap from its predecessor exceeds DIVIDER_GAP_MS or crosses a day
// boundary. The id field is unique so FlatList's keyExtractor doesn't
// see duplicates.
const buildRowsWithDividers = (messages) => {
  if (!messages || !messages.length) return [];
  const rows = [];
  let prevDate = null;
  for (const m of messages) {
    const at = m?.created_at ? new Date(m.created_at) : null;
    if (!at || isNaN(at.getTime())) {
      // Defensive: a malformed timestamp shouldn't hide the message.
      rows.push({ type: "message", id: m.id, message: m });
      continue;
    }
    const needDivider =
      !prevDate ||
      at.getTime() - prevDate.getTime() >= DIVIDER_GAP_MS ||
      at.toDateString() !== prevDate.toDateString();
    if (needDivider) {
      rows.push({ type: "divider", id: `div-${m.id}`, label: formatDividerLabel(m.created_at) });
    }
    rows.push({ type: "message", id: m.id, message: m });
    prevDate = at;
  }
  return rows;
};

// Memoized so a reaction or edit on one bubble doesn't re-render the whole
// FlatList. The default React.memo shallow-compare would still re-render
// every bubble on every reactions-map change because `reactionList` is a
// new array reference each time the parent rebuilds. Custom equality
// compares the bubble-relevant fields field-by-field; `theme` and
// `onLongPress` are reference-stable so an identity check is enough.
// Resolve the message's image list — always returns an array. Promotes
// legacy single-`image_url` rows (pre-multi-image migration) to a length-1
// array so the grid renderer below has one shape to handle. Realtime echo
// + loadMessages already do this server-side normalization, but we repeat
// it here so optimistic rows and any unmigrated callers also Just Work.
const resolveImageUrls = (message) => {
  if (Array.isArray(message?.image_urls) && message.image_urls.length > 0) return message.image_urls;
  if (message?.image_url) return [message.image_url];
  return [];
};

const MessageBubbleImpl = ({ message, isMine, theme, onLongPress, reactionList, repliedTo }) => {
  const isDeleted = Boolean(message.deleted_at);
  const isPending = Boolean(message._pending);
  const imageUrls = resolveImageUrls(message);
  const hasImage = imageUrls.length > 0;
  const hasBody = Boolean(message.body && message.body.trim());
  // Image-only messages (picture / GIF without caption) should let the
  // image carry the visual weight. The purple frame around a 200×200 photo
  // adds noise — drop it to a soft tint so the image breathes. Text and
  // emoji messages keep the full purple bubble for legibility.
  const isImageOnly = hasImage && !hasBody;

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
          // Image-only own bubbles get a soft tint instead of solid purple
          // so the photo / GIF reads as the main content. Image-only
          // received bubbles drop the gray surface for the same reason.
          // Anything with text (including emoji) keeps the full bubble.
          backgroundColor: isImageOnly
            ? (isMine ? "rgba(121, 117, 212, 0.18)" : "transparent")
            : (isMine ? theme.primary : theme.surfaceMuted),
          opacity: isPending ? 0.6 : 1,
          borderWidth: isMine || isImageOnly ? 0 : 1,
          borderColor: theme.border,
          // Drop the shadow on image-only bubbles too — without the solid
          // bg the shadow looks like a stray drop-shadow on the image.
          shadowColor: isMine && !isImageOnly ? theme.primary : "transparent",
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: isMine && !isImageOnly ? 0.18 : 0,
          shadowRadius: 6,
          elevation: isMine && !isImageOnly ? 2 : 0,
          // Tighter padding for image-only — less wasted space around photo
          paddingHorizontal: isImageOnly ? 4 : undefined,
          paddingVertical: isImageOnly ? 4 : undefined,
        }}
      >
        {hasImage ? (
          // Gallery rules:
          //   1 image  → full 200x200 (existing single-image treatment)
          //   2 images → side-by-side 99x99 each (so the bubble stays the
          //              same total width and we don't need to re-layout
          //              all surrounding rows)
          //   3+       → 2-column grid, square cells. If we have 5+ photos
          //              the 4th cell gets a "+N more" overlay; tapping
          //              still routes through long-press to the existing
          //              action sheet (full-screen viewer is a follow-up).
          imageUrls.length === 1 ? (
            <FastImage
              source={{ uri: imageUrls[0] }}
              style={{ width: 200, height: 200, borderRadius: 12, marginBottom: message.body ? 6 : 0 }}
            />
          ) : (
            <View
              className="flex-row flex-wrap"
              style={{ width: 200, marginBottom: message.body ? 6 : 0, gap: 2 }}
            >
              {imageUrls.slice(0, 4).map((url, idx) => {
                const isLastVisibleWithOverflow = idx === 3 && imageUrls.length > 4;
                const overflowCount = imageUrls.length - 4;
                return (
                  <View key={`${url}-${idx}`} style={{ width: 99, height: 99, borderRadius: 8, overflow: "hidden", position: "relative" }}>
                    <FastImage source={{ uri: url }} style={{ width: "100%", height: "100%" }} />
                    {isLastVisibleWithOverflow ? (
                      <View
                        style={{
                          position: "absolute",
                          inset: 0,
                          backgroundColor: "rgba(0, 0, 0, 0.5)",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Text style={{ color: "#fff", fontSize: 18, fontWeight: "700" }}>+{overflowCount}</Text>
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </View>
          )
        ) : null}
        {isDeleted ? (
          <Text className="text-sm italic" style={{ color: isMine ? theme.primaryContrast : theme.textSubtle }}>
            Message deleted
          </Text>
        ) : (
          <Text className="text-sm" style={{ color: isMine ? theme.primaryContrast : theme.text, lineHeight: 20 }}>
            {message.body}
            {/* "(edited)" inline marker — matches web's bubble. The time
                itself lives on the section divider, not the bubble. */}
            {message.edited_at ? (
              <Text style={{ fontSize: 11, fontStyle: "italic", color: isMine ? "rgba(255,255,255,0.7)" : theme.textSubtle }}>
                {"  (edited)"}
              </Text>
            ) : null}
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
      {/* No per-bubble timestamp — the time lives on the section divider
          (FB Messenger pattern). The `(edited)` marker is rendered
          inline inside the bubble body above. */}
    </TouchableOpacity>
  );
};

// Section divider — renders the "Today at 9:00 AM" / "Yesterday at 6:32 PM"
// label above each new message cluster. Memoized so a label that hasn't
// changed (and most don't, after the first render) doesn't re-render.
const DateDivider = memo(
  ({ label, theme }) => (
    <View className="my-3 items-center">
      <Text className="text-[11px] font-pbold" style={{ color: theme.textSubtle, letterSpacing: 0.4, textTransform: "uppercase" }}>
        {label}
      </Text>
    </View>
  ),
  (prev, next) => prev.label === next.label && prev.theme === next.theme,
);

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
  // Compare image lists by joined string — cheap and order-sensitive,
  // which matches the rendering. Falls back to image_url for legacy rows
  // that haven't been normalized yet.
  const imagesA = Array.isArray(a.image_urls) ? a.image_urls.join("|") : a.image_url || "";
  const imagesB = Array.isArray(b.image_urls) ? b.image_urls.join("|") : b.image_url || "";
  return (
    a.id === b.id &&
    a.body === b.body &&
    a.image_url === b.image_url &&
    imagesA === imagesB &&
    a.edited_at === b.edited_at &&
    a.deleted_at === b.deleted_at &&
    a._pending === b._pending &&
    a.created_at === b.created_at
  );
});

const SupabaseThread = ({ conversationId: conversationIdProp, currentUserId }) => {
  const { theme } = useAppTheme();
  const { user } = useGlobalContext();
  const params = useLocalSearchParams();
  const conversationId = conversationIdProp || params?.conversationId;

  const [conversation, setConversation] = useState(null); // { otherUser, members, ... } via loadConversationById
  const [messages, setMessages] = useState([]);
  const [reactions, setReactions] = useState({}); // { messageId: [{ user_id, emoji }] }
  const [loading, setLoading] = useState(true);
  const [composer, setComposer] = useState("");
  // Pagination state — populated by the initial load and bumped each time
  // we paginate. `oldestCursor` is the created_at of the topmost loaded
  // message; we pass it as `before` to fetch the next older page.
  // `hasMoreOlder` flips false once a page returns no rows.
  // `loadingOlder` is a re-entrancy guard so onEndReached doesn't fire
  // overlapping requests while one is in flight.
  const [oldestCursor, setOldestCursor] = useState(null);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [sending, setSending] = useState(false);
  // Composer attachment state — set when the user picks images OR a GIF
  // and clears on send. The UI shows preview chips above the input so the
  // user can visually confirm before sending.
  //
  // 2026-05-07: pendingImageUri (single) became pendingImageUris (array)
  // when multi-image chat shipped. Up to 10 entries; selectionLimit on the
  // picker enforces this client-side and a CHECK constraint on
  // messages.image_urls enforces it server-side.
  const [pendingImageUris, setPendingImageUris] = useState([]); // local URIs for picked images (up to 10)
  const [pendingGifUrl, setPendingGifUrl] = useState(null);      // remote Tenor URL (still single)
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
  // Header kebab menu (View profile / Mute / Archive / Report / Delete
  // for 1:1, View members / Mute / Archive / Leave for groups).
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);

  // Report flow state — uses the rich post-card-style ReportContentModal
  // (reason chips + optional notes) so the chat report UX matches the
  // home feed safety sheet. Submit dual-writes via reportContent to the
  // unified content_reports queue + Appwrite for legacy admin tooling.
  const [reportModalVisible, setReportModalVisible] = useState(false);
  const [reportLoading, setReportLoading] = useState(false);

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
        // Capture pagination state from the initial fetch so the user can
        // scroll up to load older messages.
        setOldestCursor(payload.oldestCursor);
        setHasMoreOlder(payload.hasMore);
        markConversationRead(conversationId).catch(() => {});
        // Bell-panel side: opening the thread is the same gesture as "I've
        // seen this," so flip every dm_message bell row for this
        // conversation. Realtime UPDATE will reconcile the bell badge.
        markChatNotificationsRead(conversationId).catch(() => {});
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

  // Load older messages — fired by FlatList's onEndReached when the user
  // scrolls to the top of the visible history (FlatList is `inverted` so
  // its "end" = chronological top = oldest visible row). Re-entrancy
  // guarded by `loadingOlder` so a fast scroll doesn't fan out duplicate
  // requests; bails fast when there's nothing left to load.
  const handleLoadOlder = useCallback(async () => {
    if (loadingOlder || !hasMoreOlder || !oldestCursor || !conversationId) return;
    setLoadingOlder(true);
    try {
      const payload = await loadMessages(conversationId, { before: oldestCursor });
      if (!payload.messages.length) {
        setHasMoreOlder(false);
        return;
      }
      // Prepend older messages — they're already chronological (oldest
      // first). Reactions for these older rows merge into the existing
      // map; existing-row reactions are preserved by spread order.
      setMessages((prev) => [...payload.messages, ...prev]);
      setReactions((prev) => ({ ...payload.reactions, ...prev }));
      setOldestCursor(payload.oldestCursor);
      setHasMoreOlder(payload.hasMore);
    } catch (err) {
      console.log("[supabase-chat] loadOlder failed:", err?.message);
    } finally {
      setLoadingOlder(false);
    }
  }, [conversationId, oldestCursor, hasMoreOlder, loadingOlder]);

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
    // Send if we have ANY of: text body, picked images, or picked GIF.
    const hasAttachment = pendingImageUris.length > 0 || pendingGifUrl;
    if (!body && !hasAttachment) return;
    if (sending || !conversationId) return;

    setSending(true);
    const localImages = pendingImageUris.slice(); // copy — array mutation guard
    const localGif = pendingGifUrl;
    const replyToId = replyingTo?.id || null;
    setComposer("");
    setPendingImageUris([]);
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
    // Optimistic image_urls: GIF is one URL; otherwise each picked local
    // file:// URI shows in the gallery grid until uploads complete and we
    // swap in the CDN URLs from sendMessage's RETURNING row.
    const optimisticImageUrls = localGif ? [localGif] : localImages;
    const optimistic = {
      id: tempId,
      conversation_id: conversationId,
      sender_id: currentUserId,
      body,
      // image_url stays = the lead image so any old code that still reads
      // the singular field gets the first photo.
      image_url: optimisticImageUrls[0] || null,
      image_urls: optimisticImageUrls,
      reply_to_id: replyToId,
      created_at: new Date().toISOString(),
      _pending: true,
    };
    setMessages([...messagesRef.current, optimistic]);

    try {
      // GIF path: pass-through (Tenor is already a remote URL).
      // Photo path: upload all picked images in parallel and collect the
      // resulting CDN URLs in the SAME ORDER the user picked them so the
      // gallery grid order matches their selection sequence.
      let finalImageUrls = [];
      if (localGif) {
        finalImageUrls = [localGif];
      } else if (localImages.length > 0) {
        const settled = await Promise.allSettled(localImages.map((uri) => uploadChatImage(uri, conversationId)));
        finalImageUrls = settled.filter((r) => r.status === "fulfilled" && r.value).map((r) => r.value);
        if (finalImageUrls.length === 0) {
          throw new Error("All photo uploads failed");
        }
      }

      const real = await supabaseSendMessage({ conversationId, body, imageUrls: finalImageUrls, replyToId });
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

      // Fire-and-forget push notification to the recipient. We send only
      // the LEAD image URL — push payloads have a tight size limit and
      // showing one photo + "+N more" in the notification is plenty.
      sendChatPushNotification({
        conversation,
        senderId: currentUserId,
        senderUsername: null,
        body,
        imageUrl: finalImageUrls[0] || null,
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
    pendingImageUris, pendingGifUrl, conversation,
    editingMessage, replyingTo,
  ]);

  // Quick thumbs-up send. Mirrors web (sendDmThumbsUp / FB Messenger):
  // when the composer is empty and the user taps the send button, ship
  // a "👍" message instantly without typing anything. Same optimistic
  // path as handleSend, just bypasses the composer.
  const handleSendThumbsUp = useCallback(async () => {
    if (sending || !conversationId) return;
    setSending(true);
    const body = "👍";
    const replyToId = replyingTo?.id || null;
    setReplyingTo(null);
    setEmojiBarOpen(false);

    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const optimistic = {
      id: tempId,
      conversation_id: conversationId,
      sender_id: currentUserId,
      body,
      image_url: null,
      reply_to_id: replyToId,
      created_at: new Date().toISOString(),
      _pending: true,
    };
    setMessages([...messagesRef.current, optimistic]);

    try {
      const real = await supabaseSendMessage({ conversationId, body, replyToId });
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === tempId);
        if (idx < 0) return prev.some((m) => m.id === real.id) ? prev : [...prev, real];
        if (prev.some((m) => m.id === real.id)) return prev.filter((m) => m.id !== tempId);
        const next = prev.slice();
        next[idx] = real;
        return next;
      });
      sendChatPushNotification({
        conversation,
        senderId: currentUserId,
        senderUsername: null,
        body,
        imageUrl: null,
      }).catch(() => {});
    } catch (error) {
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      Alert.alert("Send failed", error?.message || "Could not send the message.");
    } finally {
      setSending(false);
    }
  }, [sending, conversationId, currentUserId, replyingTo, conversation]);

  // ─────────────────────────────────────────────────────────────────────
  // Header kebab menu actions — View profile / Mute / Archive / Report /
  // Delete (1:1) or View members / Mute / Archive / Leave (groups). All
  // actions close the menu first so the user gets immediate feedback,
  // then dispatch their backend call. Errors surface as Alerts; success
  // navigates back to the inbox where appropriate.
  // ─────────────────────────────────────────────────────────────────────
  // Resolves a Supabase profile UUID to the Appwrite hex ID that
  // creator-profile expects, then navigates. Used both by the kebab
  // "View profile" item AND by the avatar/name tap in the chat header
  // — without the resolution either entry point hangs on the skeleton
  // because creator-profile's getUserByID() is an Appwrite document
  // fetch that can't find a record by UUID.
  const goToProfile = useCallback(async (otherSupabaseId) => {
    if (!otherSupabaseId) return;
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("legacy_appwrite_id")
        .eq("id", otherSupabaseId)
        .maybeSingle();
      if (error) throw error;
      const appwriteId = data?.legacy_appwrite_id;
      if (!appwriteId) {
        Alert.alert("Profile unavailable", "Couldn't load this user's profile.");
        return;
      }
      router.push({ pathname: "/creator-profile", params: { userId: appwriteId } });
    } catch (e) {
      console.log("[chat] goToProfile resolve failed:", e?.message);
      Alert.alert("Profile unavailable", e?.message || "Couldn't load this user's profile.");
    }
  }, []);

  const handleViewProfile = useCallback(() => {
    setHeaderMenuOpen(false);
    if (!conversation) return;
    if (conversation.is_group) {
      // Kebab → "View members" for a group routes to the dedicated group-
      // info screen (members list + creator manage actions). Used to be a
      // dead button: this handler early-returned for groups, which is why
      // tapping it did nothing visible. Now it pushes to the same surface
      // as the header tap.
      router.push({
        pathname: "/(message)/group-info",
        params: { conversationId: conversation.id },
      });
      return;
    }
    goToProfile(conversation.otherUser?.id);
  }, [conversation, goToProfile]);

  // Mute toggle — if currently muted (mutedUntil future), unmute by
  // setting null. Otherwise mute for 8 hours. Matches the most-common
  // FB Messenger default; users wanting longer can re-tap.
  const handleToggleMute = useCallback(async () => {
    setHeaderMenuOpen(false);
    if (!conversation) return;
    try {
      const isMuted = Boolean(conversation.muted);
      const until = isMuted ? null : new Date(Date.now() + 8 * 60 * 60 * 1000);
      await supabaseSetMutedUntil(conversation, until);
      // Optimistic local state — full refresh happens via realtime / focus.
      setConversation((c) => (c ? { ...c, muted: !isMuted, mutedUntil: until ? until.toISOString() : null } : c));
    } catch (e) {
      Alert.alert("Couldn't update mute", e?.message || "Try again.");
    }
  }, [conversation]);

  const handleArchive = useCallback(() => {
    setHeaderMenuOpen(false);
    if (!conversation) return;
    const isArchived = Boolean(conversation.archived);
    if (isArchived) {
      // Toggle off — unarchive immediately, no confirmation needed.
      (async () => {
        try {
          await supabaseSetArchived(conversation, false);
          setConversation((c) => (c ? { ...c, archived: false } : c));
        } catch (e) {
          Alert.alert("Couldn't unarchive", e?.message || "Try again.");
        }
      })();
      return;
    }
    Alert.alert("Archive this chat?", "It will move to your Archived list. Open Archived from the chat list header to unarchive or delete it.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Archive",
        onPress: async () => {
          try {
            await supabaseSetArchived(conversation, true);
            // Pop back to inbox — the archived conversation won't appear
            // there because the list filters archived rows out.
            if (router.canGoBack && router.canGoBack()) router.back();
            else router.replace("/(message)/channel-list");
          } catch (e) {
            Alert.alert("Couldn't archive", e?.message || "Try again.");
          }
        },
      },
    ]);
  }, [conversation]);

  // Report flow — uses the post-card-style ReportContentModal so chat
  // reports match the home feed safety sheet's UX:
  //
  //   1. 3-dot menu → "Report user" closes the kebab. After a 250ms
  //      defer (so the kebab's RNModal portal fully unmounts), the
  //      ReportContentModal slides in.
  //   2. User picks a reason chip (Objectionable content / Harassment /
  //      Hate speech / Sexual / Spam / Self-harm / Other) and optionally
  //      adds notes. Submit is disabled until a reason is selected — the
  //      chip selection is the friction checkpoint, no separate "Are
  //      you sure?" alert needed.
  //   3. Submit → reportContent() dual-writes to Appwrite legacy +
  //      Supabase content_reports. The unified admin queue picks it up.
  //   4. Modal dismisses; success Alert fires AFTER the dismiss animation
  //      completes (via onModalHideComplete) so the alert + modal don't
  //      stack and freeze touches on iOS.
  //
  // Chat carries Supabase UUIDs but the report system stores Appwrite hex
  // IDs (so admin's existing per-user lookups still work). The other
  // user's Appwrite ID is resolved via profiles.legacy_appwrite_id (same
  // pattern as handleViewProfile).
  const handleReport = useCallback(() => {
    setHeaderMenuOpen(false);
    if (!conversation || conversation.is_group) return;
    const otherSupabaseId = conversation.otherUser?.id;
    const myAppwriteId = user?.$id;
    if (!otherSupabaseId || !myAppwriteId) {
      Alert.alert("Couldn't report", "Missing user info; try again in a moment.");
      return;
    }
    // Defer the ReportContentModal mount so the kebab's react-native-modal
    // portal has fully unmounted before the new RNModal mounts. Without
    // this delay, the kebab's portal is still in the tree when the report
    // modal tries to render, causing it to render BEHIND the dismissing
    // kebab's backdrop — invisible to the user even though isVisible is
    // true. 250ms covers the kebab's dismiss animation (~200ms) plus a
    // frame of safety.
    setTimeout(() => {
      setReportModalVisible(true);
    }, 250);
  }, [conversation, user]);

  const handleCloseReportModal = useCallback(() => {
    if (reportLoading) return;
    setReportModalVisible(false);
  }, [reportLoading]);

  // ReportContentModal calls this with { reason, notes } — same shape
  // home.jsx uses for post reports. We resolve the other user's Appwrite
  // hex ID via profiles.legacy_appwrite_id (content_reports stores
  // Appwrite IDs so admin's existing per-user lookups still work) and
  // dual-write through reportContent. On success, close the modal and
  // surface a system Alert AFTER the modal's dismiss animation
  // (onModalHideComplete) so the Alert doesn't stack on top of the
  // closing modal — that combination breaks touches on iOS.
  const pendingReportSuccessRef = useRef(false);

  const handleSubmitChatReport = useCallback(
    async ({ reason, notes }) => {
      if (!conversation || conversation.is_group) return;
      const otherSupabaseId = conversation.otherUser?.id;
      const myAppwriteId = user?.$id;
      if (!otherSupabaseId || !myAppwriteId) {
        Alert.alert("Couldn't report", "Missing user info; try again in a moment.");
        return;
      }
      if (!reason) return;

      setReportLoading(true);
      try {
        // Resolve the other user's Appwrite ID — content_reports stores
        // Appwrite hex IDs to match the rest of the app.
        const { data: prof, error } = await supabase
          .from("profiles")
          .select("legacy_appwrite_id")
          .eq("id", otherSupabaseId)
          .maybeSingle();
        if (error) throw error;
        const otherAppwriteId = prof?.legacy_appwrite_id;
        if (!otherAppwriteId) {
          Alert.alert("Couldn't report", "Couldn't resolve that user's profile.");
          setReportLoading(false);
          return;
        }

        await reportContent({
          contentId: otherAppwriteId,
          contentType: "user",
          reporterId: myAppwriteId,
          ownerId: otherAppwriteId,
          reason,
          notes: notes
            ? `${notes}\n\n— from chat conversation ${conversation.id}`
            : `Reported from chat conversation ${conversation.id}`,
        });

        // Close the modal first, then queue the success Alert to fire
        // after the modal's dismiss animation completes. This avoids the
        // modal-on-top-of-alert touch-freeze bug on iOS.
        pendingReportSuccessRef.current = true;
        setReportModalVisible(false);
      } catch (e) {
        console.log("[chat] handleSubmitChatReport failed:", e?.message);
        Alert.alert("Error", e?.message || "Failed to submit report.");
      } finally {
        setReportLoading(false);
      }
    },
    [conversation, user],
  );

  const handleReportModalHidden = useCallback(() => {
    if (pendingReportSuccessRef.current) {
      pendingReportSuccessRef.current = false;
      // Tiny delay so the dismiss animation has flushed before the
      // system Alert appears.
      setTimeout(() => {
        Alert.alert("Report submitted", "Thanks — our team will review it.");
      }, 80);
    }
  }, []);

  // Delete: same backend effect as archive (per-side hide via
  // archived_by_a/b), but framed in destructive copy. The UX promise
  // is "gone for me", which is true — even if the conversation row
  // technically still exists, the deleter never sees it again unless
  // they get a new message in it (which would un-archive on web's
  // current rule; we may want a separate deleted_by_* flag later).
  // (Renamed from handleDelete → handleDeleteConversation to avoid
  // collision with the per-message handleDelete defined further down.)
  const handleDeleteConversation = useCallback(() => {
    setHeaderMenuOpen(false);
    if (!conversation) return;
    // Defer the Alert so the kebab modal's dismiss animation has time
    // to flush. Without this, iOS swallows the new alert (the user sees
    // nothing). 80ms covers the kebab's ~200ms dismiss with headroom;
    // the user-perceived delay is invisible.
    setTimeout(() => {
      Alert.alert(
        "Delete conversation?",
        "This removes the conversation from your inbox. The other person can still see your messages.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete",
            style: "destructive",
            onPress: async () => {
              try {
                await supabaseSetArchived(conversation, true);
                if (router.canGoBack && router.canGoBack()) router.back();
                else router.replace("/(message)/channel-list");
              } catch (e) {
                console.log("[chat] archive failed:", e?.message);
                Alert.alert("Couldn't delete", e?.message || "Try again.");
              }
            },
          },
        ],
      );
    }, 80);
  }, [conversation]);

  // Group-only — leaves the group by removing self from
  // conversation_participants. Other members keep the conversation;
  // the group continues without us.
  const handleLeaveGroup = useCallback(() => {
    setHeaderMenuOpen(false);
    if (!conversation || !conversation.is_group) return;
    Alert.alert("Leave this group?", "You won't receive new messages from this group. You can be re-added by another member.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Leave",
        style: "destructive",
        onPress: async () => {
          try {
            await supabaseLeaveGroup(conversation.id);
            if (router.canGoBack && router.canGoBack()) router.back();
            else router.replace("/(message)/channel-list");
          } catch (e) {
            Alert.alert("Couldn't leave", e?.message || "Try again.");
          }
        },
      },
    ]);
  }, [conversation]);

  // Image picker — multi-select up to 10 photos. The native picker's
  // selection UI shows numbered checkmarks so the user can pick a few
  // photos in one gesture instead of opening the picker N times. Picked
  // URIs are MERGED into the existing pendingImageUris (capped at 10) so
  // the user can keep tapping "image" to add more rounds before sending.
  const handlePickImage = useCallback(async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (perm.status !== "granted") {
        Alert.alert("Photo access needed", "Allow photos in Settings to attach photos.");
        return;
      }
      // How many slots are still free? Cap selectionLimit so the user
      // can't pick more than will fit alongside what they've already added.
      const remaining = 10 - pendingImageUris.length;
      if (remaining <= 0) {
        Alert.alert("Limit reached", "You can attach up to 10 photos per message.");
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: false,
        allowsMultipleSelection: true,
        selectionLimit: remaining,
        quality: 0.85,
        exif: false,
      });
      if (result.canceled) return;
      const newUris = (result.assets || []).map((a) => a?.uri).filter(Boolean);
      if (newUris.length === 0) return;
      // Clear any pending GIF — gif + photos can't share a single message.
      setPendingGifUrl(null);
      // Merge + dedupe (defensive — picker shouldn't return duplicates but
      // some Android galleries do). Cap at 10 in case the runtime gave us
      // more than selectionLimit.
      setPendingImageUris((prev) => {
        const merged = [...prev];
        for (const uri of newUris) {
          if (!merged.includes(uri)) merged.push(uri);
          if (merged.length >= 10) break;
        }
        return merged.slice(0, 10);
      });
    } catch (e) {
      Alert.alert("Could not pick photos", e?.message || "Try again.");
    }
  }, [pendingImageUris.length]);

  // Remove a single staged image from the preview row. The X buttons on
  // each preview chip call this with the URI to drop.
  const handleRemovePendingImage = useCallback((uri) => {
    setPendingImageUris((prev) => prev.filter((u) => u !== uri));
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

  // "Seen" indicator support — 1:1 only for v1.
  //
  // Find the most recent own message that the other side has read (i.e.
  // read_at IS NOT NULL). We render a small "Seen" line directly below
  // that bubble, matching the Messenger pattern. As newer messages get
  // sent and stay unread, the indicator naturally hops to the latest
  // already-read message.
  //
  // Groups are skipped because the messages.read_at column is a single
  // timestamp set by "a recipient" — it doesn't tell us WHO read what.
  // Per-user receipts would need a message_reads table; out of scope.
  const lastSeenOwnMessageId = useMemo(() => {
    if (!conversation || conversation.is_group) return null;
    // Walk from newest to oldest. messages[] is chronological (oldest
    // first), so reverse-iterate.
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.sender_id !== currentUserId) continue;
      if (!m.read_at) continue;
      if (m._pending) continue; // optimistic — not yet stored, can't be "seen"
      return m.id;
    }
    return null;
  }, [messages, conversation, currentUserId]);

  const renderItem = useCallback(
    ({ item }) => {
      // Two row types — interleaved by buildRowsWithDividers below.
      // The divider row carries only a label; the message row carries
      // the full message object plus its resolved reply target.
      if (item.type === "divider") {
        return <DateDivider label={item.label} theme={theme} />;
      }
      const message = item.message;
      const showSeen = message.id === lastSeenOwnMessageId;
      return (
        <View>
          <MessageBubble
            message={message}
            isMine={message.sender_id === currentUserId}
            theme={theme}
            onLongPress={handleLongPress}
            reactionList={reactions[message.id]}
            repliedTo={message.reply_to_id ? messagesById[message.reply_to_id] : null}
          />
          {showSeen ? (
            <View className="self-end pr-3 pb-1">
              <Text className="text-[10px]" style={{ color: theme.textSoft }}>
                Seen
              </Text>
            </View>
          ) : null}
        </View>
      );
    },
    [currentUserId, theme, reactions, handleLongPress, messagesById, lastSeenOwnMessageId],
  );

  // Build rows with section dividers, then reverse for the inverted
  // FlatList. buildRowsWithDividers walks the chronological array
  // (oldest first) and inserts a divider before each message whose gap
  // from the previous one exceeds 1h or crosses a day boundary.
  // After reverse, the divider sits visually ABOVE its cluster — same
  // layout web uses.
  const inverted = useMemo(() => buildRowsWithDividers(messages).reverse(), [messages]);

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
            if (!conversation) return;
            if (conversation.is_group) {
              // Group conversations route to the dedicated members + manage
              // screen. Non-creators land on the same screen but see a
              // read-only / leave-only variant; the screen renders the
              // manage affordances conditionally based on created_by.
              router.push({ pathname: "/(message)/group-info", params: { conversationId: conversation.id } });
              return;
            }
            // Same Appwrite-ID resolution as the kebab "View profile" entry —
            // creator-profile's getUserByID expects an Appwrite hex ID, not
            // the Supabase UUID we have here.
            goToProfile(headerOtherUser?.id);
          }}
          className="ml-3 flex-1 flex-row items-center"
        >
          {/* Avatar with online dot overlay.
              Resolution order:
                group + conversation.avatar_url → creator-set group photo
                group + no avatar_url → initials of group name
                1:1 + otherUser.avatar_url → other user's photo
                1:1 + no avatar_url → initials
              Without the conversation.avatar_url branch the group-photo
              edit feature was invisible in the chat header — same root
              cause as the chat-list bug. */}
          <View style={{ width: 36, height: 36, position: "relative" }}>
            {(conversation?.is_group ? conversation.avatar_url : headerOtherUser?.avatar_url) ? (
              <FastImage
                source={{ uri: conversation?.is_group ? conversation.avatar_url : headerOtherUser.avatar_url }}
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
            <View className="flex-row items-center">
              <Text className="font-pbold text-base" style={{ color: theme.text }} numberOfLines={1}>
                {headerTitle}
              </Text>
              {headerOtherUser && <UserRoleBadgeIcons user={headerOtherUser} size={14} />}
            </View>
            {headerStatus ? (
              <Text className="text-xs" style={{ color: headerOtherIsOnline ? "#22c55e" : theme.textSoft }} numberOfLines={1}>
                {headerStatus}
              </Text>
            ) : null}
          </View>
        </TouchableOpacity>

        {/* Header kebab — opens the actions menu. Only renders once the
            conversation has loaded; before that there's nothing useful
            to act on. Same circular-button pattern as the back arrow on
            the left so the header reads as a balanced trio. */}
        {conversation ? (
          <TouchableOpacity
            onPress={() => setHeaderMenuOpen(true)}
            activeOpacity={0.85}
            className="ml-2 h-10 w-10 items-center justify-center rounded-full"
            style={{ backgroundColor: theme.surfaceMuted, borderWidth: 1, borderColor: theme.border }}
          >
            <Feather name="more-vertical" size={18} color={theme.icon} />
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Header actions menu — sheet-style modal. Items differ for 1:1
          (View profile / Mute / Archive / Report / Delete) vs groups
          (View members / Mute / Archive / Leave group). Mute is a
          toggle: when currently muted, the row shows "Unmute" instead. */}
      <ThreadActionsMenu
        visible={headerMenuOpen}
        onClose={() => setHeaderMenuOpen(false)}
        conversation={conversation}
        theme={theme}
        onViewProfile={handleViewProfile}
        onToggleMute={handleToggleMute}
        onArchive={handleArchive}
        onReport={handleReport}
        onDelete={handleDeleteConversation}
        onLeaveGroup={handleLeaveGroup}
      />

      {/* Report flow — uses the rich post-card-style ReportContentModal
          (reason chips + optional notes). Same visual language as the
          home feed safety sheet. */}
      <ReportContentModal
        isVisible={reportModalVisible}
        onClose={handleCloseReportModal}
        onSubmit={handleSubmitChatReport}
        submitting={reportLoading}
        theme={theme}
        onModalHideComplete={handleReportModalHidden}
      />

      <KeyboardAvoidingView
        className="flex-1"
        // Use `padding` on BOTH platforms. The previous strategy left
        // Android `behavior` undefined and relied entirely on the OS's
        // `windowSoftInputMode="adjustResize"` to shrink the window —
        // that worked for a while but broke on certain Android devices
        // (notably newer versions where edge-to-edge is more aggressive
        // and the OS-side resize doesn't account for the home-indicator
        // inset). When the OS-resize fails, the composer ends up
        // entirely below the keyboard with the user typing into an
        // invisible input — exactly what was reported.
        //
        // Switching Android to `padding` makes RN add explicit padding
        // equal to the keyboard height. The earlier "double shrink"
        // concern was specifically with `behavior="height"`, not
        // `padding` — padding doesn't conflict with adjustResize because
        // it adds space rather than re-measuring the window.
        //
        // keyboardVerticalOffset stays at 0 — the SafeAreaView root
        // already handles bottom inset, and the custom header is
        // outside the KAV so React Native correctly measures from the
        // top of the avoiding region.
        behavior="padding"
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
            // Pagination — FlatList is inverted, so onEndReached fires
            // when the user reaches the chronological TOP (oldest msg).
            // 0.4 means trigger when within 40% of viewport from the
            // "end" — gives a smooth pre-fetch before the user actually
            // hits the spinner.
            onEndReached={handleLoadOlder}
            onEndReachedThreshold={0.4}
            ListFooterComponent={
              loadingOlder ? (
                <View className="items-center py-4">
                  <ActivityIndicator size="small" color={theme.textMuted} />
                </View>
              ) : null
            }
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

        {/* Pending attachment preview row — shown above composer while the
            user has picked photos or a GIF that haven't been sent yet.
            For multi-image, scrolls horizontally with each chip showing
            its own X to drop just that photo. The "Clear all" X on the
            far right wipes the whole batch + any GIF. */}
        {(pendingImageUris.length > 0 || pendingGifUrl) ? (
          <View
            className="flex-row items-center px-3 py-2"
            style={{ backgroundColor: theme.surfaceElevated, borderTopWidth: 0.5, borderTopColor: theme.divider }}
          >
            {pendingGifUrl ? (
              <>
                <RNImage
                  source={{ uri: pendingGifUrl }}
                  style={{ width: 56, height: 56, borderRadius: 8, backgroundColor: theme.surfaceMuted }}
                  resizeMode="cover"
                />
                <Text className="ml-3 flex-1 text-xs" style={{ color: theme.textSoft }} numberOfLines={1}>
                  GIF ready to send
                </Text>
              </>
            ) : (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} className="flex-1">
                {pendingImageUris.map((uri) => (
                  <View key={uri} style={{ marginRight: 8 }}>
                    <RNImage
                      source={{ uri }}
                      style={{ width: 56, height: 56, borderRadius: 8, backgroundColor: theme.surfaceMuted }}
                      resizeMode="cover"
                    />
                    <TouchableOpacity
                      onPress={() => handleRemovePendingImage(uri)}
                      className="absolute h-5 w-5 items-center justify-center rounded-full"
                      style={{ top: -4, right: -4, backgroundColor: theme.surfaceElevated, borderWidth: 1, borderColor: theme.border }}
                    >
                      <Feather name="x" size={11} color={theme.iconMuted} />
                    </TouchableOpacity>
                  </View>
                ))}
              </ScrollView>
            )}
            <TouchableOpacity
              onPress={() => {
                setPendingImageUris([]);
                setPendingGifUrl(null);
              }}
              className="ml-2 h-7 w-7 items-center justify-center rounded-full"
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
            // Three-state send button — mirrors web's pattern (FB Messenger):
            //   1. Edit mode → checkmark, taps save the edit (handleSend
            //      handles the editing branch internally).
            //   2. Composer has text or attachment → paper-plane icon,
            //      taps send the typed message.
            //   3. Composer empty and no attachment → thumbs-up icon,
            //      taps fire a one-tap "👍" message instantly.
            // The button is ALWAYS enabled (modulo `sending`) — even an
            // empty composer can ship a thumbs-up. No more disabled/
            // -looking states for the user to wonder about.
            const hasContent = Boolean(composer.trim()) || pendingImageUris.length > 0 || Boolean(pendingGifUrl);
            const isEditing = Boolean(editingMessage);
            const iconName = isEditing ? "checkmark" : hasContent ? "send" : "thumbs-up";
            const onPress = isEditing || hasContent ? handleSend : handleSendThumbsUp;
            const isThumbs = !isEditing && !hasContent;
            return (
              <TouchableOpacity
                onPress={onPress}
                disabled={sending}
                activeOpacity={0.85}
                className="ml-2 items-center justify-center rounded-full"
                style={{
                  width: 40,
                  height: 40,
                  backgroundColor: sending ? theme.surfaceMuted : theme.primary,
                  shadowColor: theme.primary,
                  shadowOffset: { width: 0, height: 4 },
                  shadowOpacity: sending ? 0 : 0.3,
                  shadowRadius: 8,
                  elevation: sending ? 0 : 3,
                }}
              >
                <Ionicons
                  // ionicons uses "thumbs-up" filled vs "thumbs-up-outline" —
                  // we want the chunky filled glyph since the bg is already
                  // the violet pill.
                  name={iconName}
                  size={isThumbs ? 20 : 18}
                  color={sending ? theme.iconMuted : theme.primaryContrast}
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

// Header kebab menu — visual language matched to the home-feed Post
// safety sheet (app/(tabs)/home.jsx Post actions modal) and to
// ProfileActionsMenu. Centered react-native-modal card on
// `theme.surfaceElevated`, title at top, stacked rounded-rectangle action
// rows on `theme.surfaceMuted` with icon + bold label + small subtitle,
// destructive items use `theme.iconDanger` (red), Cancel link at bottom.
//
// Deferred dispatch — same pattern as ProfileActionsMenu:
// Tapping any action does NOT execute the handler immediately. We stash
// the chosen action, close the sheet, then dispatch from `onModalHide`
// after the dismiss animation finishes. Without this, opening a second
// modal (ReportModal) or system Alert (Archive / Delete confirmations)
// while the kebab is mid-dismiss leaves overlapping backdrops that
// freeze touches across the whole screen — exact symptom the user hit
// when "tap Report → something flashes → screen frozen, can't tap
// anything." A setTimeout fallback fires the action even if onModalHide
// somehow misses (some platform/animation combos drop it).
//
// Items differ for 1:1 vs group conversations:
//   1:1   → View profile / (Un)mute / (Un)archive / Report / Delete
//   group → View members / (Un)mute / (Un)archive / Leave group
const PENDING_ACTION_FALLBACK_MS = 550;

const ThreadActionsMenu = ({
  visible,
  onClose,
  conversation,
  theme,
  onViewProfile,
  onToggleMute,
  onArchive,
  onReport,
  onDelete,
  onLeaveGroup,
}) => {
  const pendingActionRef = useRef(null);
  const dispatchedRef = useRef(false);
  const fallbackTimerRef = useRef(null);

  const clearFallbackTimer = () => {
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
  };

  // Cancel any pending fallback timer if the menu unmounts mid-animation.
  useEffect(() => clearFallbackTimer, []);

  const dispatchPending = () => {
    if (dispatchedRef.current) return;
    const action = pendingActionRef.current;
    if (!action) return;
    dispatchedRef.current = true;
    pendingActionRef.current = null;
    clearFallbackTimer();
    switch (action) {
      case "viewProfile":
        onViewProfile?.();
        break;
      case "toggleMute":
        onToggleMute?.();
        break;
      case "archive":
        onArchive?.();
        break;
      case "report":
        onReport?.();
        break;
      case "delete":
        onDelete?.();
        break;
      case "leaveGroup":
        onLeaveGroup?.();
        break;
      default:
        break;
    }
  };

  const queueAction = (action) => {
    pendingActionRef.current = action;
    dispatchedRef.current = false;
    clearFallbackTimer();
    fallbackTimerRef.current = setTimeout(dispatchPending, PENDING_ACTION_FALLBACK_MS);
    onClose();
  };

  if (!conversation) return null;
  const isGroup = Boolean(conversation.is_group);
  const isMuted = Boolean(conversation.muted);
  const isArchived = Boolean(conversation.archived);
  const dangerColor = theme.iconDanger ?? "#ef4444";

  // Single row component — same shape as the home feed's safety sheet
  // rows (icon + bold primary label + small subtitle). `marginTop`
  // varies: the first row uses mt-4 (gap from title), subsequent rows
  // use mt-2 (tight stack).
  const ActionRow = ({ icon, label, subtitle, onPress, danger, first, disabled }) => (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.85}
      className={`${first ? "mt-4" : "mt-2"} rounded-xl px-4 py-3`}
      style={{ backgroundColor: theme.surfaceMuted, opacity: disabled ? 0.5 : 1 }}
    >
      <View className="flex flex-row items-center">
        <MaterialIcons
          name={icon}
          size={22}
          color={danger ? dangerColor : theme.icon}
          style={{ marginRight: 12 }}
        />
        <View style={{ flex: 1 }}>
          <Text className="text-base font-semibold" style={{ color: danger ? dangerColor : theme.text }}>
            {label}
          </Text>
          {subtitle ? (
            <Text className="mt-1 text-xs" style={{ color: theme.textSoft }}>
              {subtitle}
            </Text>
          ) : null}
        </View>
      </View>
    </TouchableOpacity>
  );

  return (
    <RNModal
      isVisible={visible}
      onBackdropPress={onClose}
      onBackButtonPress={onClose}
      onModalHide={dispatchPending}
      backdropOpacity={0.6}
      useNativeDriver
    >
      <View className="rounded-2xl px-5 py-5" style={{ backgroundColor: theme.surfaceElevated }}>
        <Text className="text-lg font-semibold" style={{ color: theme.text }}>
          {isGroup ? "Group actions" : "Chat actions"}
        </Text>

        {/* View profile (1:1) / View members (group) — always first */}
        <ActionRow
          first
          icon={isGroup ? "group" : "person"}
          label={isGroup ? "View members" : "View profile"}
          subtitle={isGroup ? "See who's in this group" : "See more about this person"}
          onPress={() => queueAction("viewProfile")}
        />

        {/* Mute / Unmute notifications */}
        <ActionRow
          icon={isMuted ? "notifications" : "notifications-off"}
          label={isMuted ? "Unmute notifications" : "Mute notifications"}
          subtitle={
            isMuted
              ? "Resume getting notified when messages arrive"
              : "Stop getting notified for 8 hours"
          }
          onPress={() => queueAction("toggleMute")}
        />

        {/* Archive / Unarchive */}
        <ActionRow
          icon={isArchived ? "unarchive" : "archive"}
          label={isArchived ? "Unarchive chat" : "Archive chat"}
          subtitle={
            isArchived
              ? "Move back to your active chats"
              : "Hide from your inbox; recoverable from Archived"
          }
          onPress={() => queueAction("archive")}
        />

        {/* 1:1 footer: Report + Delete (both destructive) */}
        {!isGroup ? (
          <>
            <ActionRow
              icon="flag"
              label="Report user"
              subtitle="Tell us what's wrong"
              onPress={() => queueAction("report")}
              danger
            />
            <ActionRow
              icon="delete"
              label="Delete conversation"
              subtitle="Removes this chat from your inbox"
              onPress={() => queueAction("delete")}
              danger
            />
          </>
        ) : (
          <ActionRow
            icon="logout"
            label="Leave group"
            subtitle="Stop receiving messages from this group"
            onPress={() => queueAction("leaveGroup")}
            danger
          />
        )}

        <TouchableOpacity className="mt-3 items-center" onPress={onClose}>
          <Text className="text-sm" style={{ color: theme.textMuted }}>
            Cancel
          </Text>
        </TouchableOpacity>
      </View>
    </RNModal>
  );
};

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
};

export default SupabaseThread;
