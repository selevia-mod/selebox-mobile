// Supabase notifications service — chat (dm_message) bell-panel feed.
//
// Background
// ----------
// Selebox stores most notification types (video / post / book / clip / follow /
// inline-comment) in Appwrite, read by `lib/notifications.js`. The chat
// overhaul moved DMs onto Supabase, and the bell-panel side of that work
// (task #201) is fed by a Postgres trigger on `messages` (see
// `migration_chat_bell_notifications.sql`) that writes a `dm_message` row
// into the Supabase `notifications` table per (recipient, conversation),
// coalesced in place.
//
// This module is the mobile read side of that trigger. It fetches +
// subscribes to those Supabase rows, shapes them like Appwrite documents
// (`$id`, `$createdAt`, `isViewed`, `sender`, etc.) so the existing
// `NotificationCard` and notification screen can render them with minimal
// branching, and exposes a small set of actions (mark-read on thread open,
// bulk mark-all-read).
//
// Why RPCs instead of direct queries
// ----------------------------------
// The mobile app currently runs USE_SUPABASE_AUTH=false, which means there
// is NO Supabase session and `auth.uid()` is NULL on the server. The
// `notifications` table has restrictive RLS policies tied to `auth.uid()`,
// so a direct `select * from notifications` returns zero rows for these
// users — even though the trigger has written them. The migration ships
// SECURITY DEFINER RPCs (get_chat_notifications, get_chat_unread_count,
// mark_chat_notifications_read, mark_all_chat_notifications_read) that
// take an explicit user_id and bypass RLS, matching the security posture
// of the rest of the chat write path. When mobile flips to Supabase auth,
// the same RPCs continue to work unchanged because the explicit p_user_id
// is `default null` and `coalesce(auth.uid(), p_user_id)` falls through.
//
// Realtime caveat
// ---------------
// `subscribeToDmNotifications` opens a `postgres_changes` channel on the
// notifications table. Realtime is RLS-filtered client-side: anon clients
// (Appwrite-auth users) won't receive events. Those users get bell badge
// updates from the focus-poll path in MainScreensHeader instead — same as
// existing Appwrite notifications. When mobile auth migrates, realtime
// will start delivering automatically; no code change required here.
//
// Why the Appwrite-ish shape?
// ---------------------------
// The bell panel renders via FlashList keyed on `$id` and a NotificationCard
// that reads `isViewed`, `$createdAt`, `sender`, `type`, etc. Adapting
// Supabase rows once at fetch time is much smaller surface than rewriting
// the renderer for two backends. We namespace the synthesized id with `sb_`
// so it can never collide with an Appwrite document id.

import supabase from "./supabase";
import { getMessagesUserId } from "./messages-supabase";

const BACKEND_TAG = "supabase";

// In-memory cache of actor profiles so we don't refetch the same profile
// on every realtime UPDATE. Key = profiles.id, Value = { username, avatar_url }.
const actorCache = new Map();

const hydrateActors = async (rows) => {
  const ids = new Set();
  for (const row of rows) {
    if (row.actor_id && !actorCache.has(row.actor_id)) ids.add(row.actor_id);
  }
  if (ids.size === 0) return;
  const { data } = await supabase
    .from("profiles")
    .select("id, username, avatar_url")
    .in("id", [...ids]);
  for (const profile of data || []) {
    actorCache.set(profile.id, profile);
  }
};

// In-memory cache of conversation names so we can show a meaningful header
// for group chats. 1:1 rows just use the actor's name and skip this.
const conversationCache = new Map();

const hydrateConversations = async (rows) => {
  const ids = new Set();
  for (const row of rows) {
    if (
      row.metadata?.is_group &&
      row.parent_target_id &&
      !conversationCache.has(row.parent_target_id)
    ) {
      ids.add(row.parent_target_id);
    }
  }
  if (ids.size === 0) return;
  const { data } = await supabase
    .from("conversations")
    .select("id, name, avatar_url")
    .in("id", [...ids]);
  for (const conv of data || []) {
    conversationCache.set(conv.id, conv);
  }
};

// Map a Supabase notifications row → Appwrite-shaped notification doc.
// Keep `_backend` + `_supabaseId` so the renderer / mark-read code knows
// which API to talk to. Avoid stashing the full raw row — it bloats the
// MMKV-persisted Redux notifications cache.
const adaptRow = (row) => {
  const actor = actorCache.get(row.actor_id) || null;
  const isGroup = Boolean(row.metadata?.is_group);
  const groupConv = isGroup ? conversationCache.get(row.parent_target_id) : null;
  const preview = row.metadata?.preview || "";

  // Compose the message text. NotificationCard renders it as
  // "<senderName> <messageText>" so we DO NOT include the sender name here —
  // just the verb + preview clause. Match the web renderer exactly.
  const verb = isGroup ? "sent a message in a group" : "sent you a message";
  const messageText = preview ? `${verb}: "${preview}"` : verb;

  return {
    // Identity / sorting
    $id: `sb_${row.id}`,
    $createdAt: row.created_at,
    type: "dm_message",
    isViewed: Boolean(row.is_read),

    // Sender (actor) — drives the avatar + bold username in NotificationCard
    sender: actor
      ? {
          $id: actor.id,
          username: actor.username,
          avatar: actor.avatar_url,
        }
      : { $id: row.actor_id, username: "Someone", avatar: null },

    // Routing — NotificationCard's dm_message case will navigate using this
    resourceId: row.parent_target_id,
    conversationId: row.parent_target_id,
    isGroup,
    groupName: groupConv?.name || null,
    groupAvatar: groupConv?.avatar_url || null,

    // Display
    message: messageText,
    dmPreview: preview,

    // Backend marker — NotificationCard uses this to call the right
    // mark-read function (Supabase RPC vs Appwrite markAsViewed).
    _backend: BACKEND_TAG,
    _supabaseId: row.id,
  };
};

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

// Fetch the most recent dm_message notifications for the current user,
// enriched with sender + conversation metadata. Returns an array of
// Appwrite-shaped docs sorted by created_at descending.
export const loadDmNotifications = async ({ limit = 30, before = null } = {}) => {
  const me = getMessagesUserId();
  if (!me) return [];
  const { data, error } = await supabase.rpc("get_chat_notifications", {
    p_user_id: me,
    p_limit: limit,
    p_before: before,
  });
  if (error) {
    console.log("[notif-supabase] get_chat_notifications failed:", error.message);
    return [];
  }
  const rows = data || [];
  await Promise.all([hydrateActors(rows), hydrateConversations(rows)]);
  return rows.map(adaptRow);
};

// Count of unread dm_message rows for the current user — feeds the bell
// header badge. The RPC is SECURITY DEFINER + uses the partial-unread
// index, so it's cheap regardless of total notifications volume.
export const getUnreadDmCount = async () => {
  const me = getMessagesUserId();
  if (!me) return 0;
  const { data, error } = await supabase.rpc("get_chat_unread_count", {
    p_user_id: me,
  });
  if (error) {
    console.log("[notif-supabase] get_chat_unread_count failed:", error.message);
    return 0;
  }
  return data || 0;
};

// Mark every dm_message bell row for a conversation as read. Called when
// the user opens the thread (mirrors web's openConversation behavior).
// Returns void; failures are swallowed because the bell panel will resync
// on next fetch.
export const markChatNotificationsRead = async (conversationId) => {
  if (!conversationId) return;
  const me = getMessagesUserId();
  if (!me) return;
  const { error } = await supabase.rpc("mark_chat_notifications_read", {
    p_conversation_id: conversationId,
    p_user_id: me,
  });
  if (error) {
    console.log("[notif-supabase] mark_chat_notifications_read failed:", error.message);
  }
};

// Mark all dm_message rows read — used by the "Mark all read" button +
// bell-icon tap optimistic clear.
export const markAllDmNotificationsRead = async () => {
  const me = getMessagesUserId();
  if (!me) return;
  const { error } = await supabase.rpc("mark_all_chat_notifications_read", {
    p_user_id: me,
  });
  if (error) {
    console.log("[notif-supabase] mark_all_chat_notifications_read failed:", error.message);
  }
};

// Realtime — subscribes to INSERTs and UPDATEs of the current user's
// notification rows. The trigger uses upsert-on-conflict so the same bell
// row gets bumped (UPDATE) as more messages arrive in the same conversation;
// callers should treat both events as "list changed, please re-render."
//
// NOTE — RLS-filtered: postgres_changes only delivers events the caller's
// SELECT policy would allow. For Appwrite-auth users (auth.uid() = NULL)
// nothing will arrive. Those users rely on focus-poll in MainScreensHeader
// to bump the badge. When mobile flips USE_SUPABASE_AUTH=true, realtime
// starts firing automatically — no code change required.
//
// callbacks: { onInsert(adaptedDoc), onUpdate(adaptedDoc) }
// Returns an unsubscribe function.

// Per-call counter so each consumer (MainScreensHeader, notification.jsx)
// gets its own channel. Supabase Realtime errors with
// "cannot add `postgres_changes` callbacks for realtime:<name> after
// subscribe()" if two consumers reuse the same channel name.
let __dmNotifChannelSeq = 0;

export const subscribeToDmNotifications = (callbacks = {}) => {
  const me = getMessagesUserId();
  if (!me) return () => {};

  const channelName = `notif_dm:${me}:${++__dmNotifChannelSeq}`;
  const channel = supabase
    .channel(channelName)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "notifications",
        filter: `recipient_id=eq.${me}`,
      },
      async (payload) => {
        const row = payload.new;
        if (row?.type !== "dm_message") return;
        await Promise.all([hydrateActors([row]), hydrateConversations([row])]);
        callbacks.onInsert?.(adaptRow(row));
      },
    )
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "notifications",
        filter: `recipient_id=eq.${me}`,
      },
      async (payload) => {
        const row = payload.new;
        if (row?.type !== "dm_message") return;
        await Promise.all([hydrateActors([row]), hydrateConversations([row])]);
        callbacks.onUpdate?.(adaptRow(row));
      },
    )
    .subscribe();

  return () => {
    try {
      supabase.removeChannel(channel);
    } catch {
      /* already gone */
    }
  };
};

// Test helper — clears in-memory caches. Useful in tests; a no-op in prod.
export const _resetCachesForTesting = () => {
  actorCache.clear();
  conversationCache.clear();
};
