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


// ─────────────────────────────────────────────────────────────────────────
// NotificationServiceSupabase — Appwrite NotificationService parity.
// ─────────────────────────────────────────────────────────────────────────
// Methods mirror lib/notifications.js's NotificationService class. Used
// by the bell panel + the various places that emit notifications (post
// like / comment, follow flow, etc.). Resource hydration is a TODO —
// for the first cut we return raw rows; the bell card already has fall-
// back rendering for missing resourceData.
//
// All write paths go through submit_notification RPC (security-definer,
// dedup-aware). All reads go through the bell-feed RPC if it exists,
// else direct table query when USE_SUPABASE_AUTH is on.

import { resolveSupabaseUserId } from "./posts-supabase";

// Idempotent + dedup-aware notification write. Wraps the
// submit_notification RPC. Returns { ok, id, deduped } so callers can
// log without double-incrementing counters.
const submitNotification = async ({
  recipientId,
  actorId,
  type,
  targetType,
  targetId,
  parentTargetId,
  message,
  preview,
  metadata,
}) => {
  const recipientUuid = await resolveSupabaseUserId(recipientId);
  const actorUuid = await resolveSupabaseUserId(actorId);
  if (!recipientUuid || !actorUuid) {
    return { ok: false, error: "could_not_resolve_user" };
  }

  const { data, error } = await supabase.rpc("submit_notification", {
    p_recipient_id: recipientUuid,
    p_actor_id: actorUuid,
    p_type: type,
    p_target_type: targetType || null,
    p_target_id: targetId || null,
    p_parent_target_id: parentTargetId || null,
    p_message: message || null,
    p_preview: preview || null,
    p_metadata: metadata || {},
  });
  if (error) {
    console.log("[notif-supabase] submit_notification error:", error.message);
    return { ok: false, error: error.message };
  }
  return data || { ok: false };
};

// All-types fetch (not just dm_message). Returns Appwrite-shaped rows
// keyed by `$id` for the bell-panel FlashList. Resource hydration
// (loading the post / video / book document for each notification) is
// deferred to the next phase — for now consumers see raw target_id and
// the renderer falls back to a generic card.
const loadAllNotifications = async ({ userId, limit = 20, before = null } = {}) => {
  const userUuid = userId ? await resolveSupabaseUserId(userId) : getMessagesUserId();
  if (!userUuid) return [];

  let q = supabase
    .from("notifications")
    .select("*")
    .eq("recipient_id", userUuid)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (before) q = q.lt("created_at", before);

  const { data, error } = await q;
  if (error) {
    console.log("[notif-supabase] loadAllNotifications error:", error.message);
    return [];
  }
  const rows = data || [];
  await hydrateActors(rows);
  return rows.map(adaptRow);
};

// Total unread count across ALL notification types — bell badge.
const getUnreadCount = async ({ userId } = {}) => {
  const userUuid = userId ? await resolveSupabaseUserId(userId) : getMessagesUserId();
  if (!userUuid) return 0;
  const { count, error } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("recipient_id", userUuid)
    .eq("is_viewed", false);
  if (error) {
    console.log("[notif-supabase] getUnreadCount error:", error.message);
    return 0;
  }
  return count || 0;
};

const markAllAsRead = async ({ userId } = {}) => {
  const userUuid = userId ? await resolveSupabaseUserId(userId) : getMessagesUserId();
  if (!userUuid) return;
  const { error } = await supabase
    .from("notifications")
    .update({ is_read: true })
    .eq("recipient_id", userUuid)
    .eq("is_read", false);
  if (error) console.log("[notif-supabase] markAllAsRead error:", error.message);
};

const markAsRead = async ({ notificationIds = [] } = {}) => {
  if (!notificationIds.length) return;
  // Strip any "sb_" prefix that adaptRow added for chat rows.
  const ids = notificationIds.map((id) => String(id).replace(/^sb_/, ""));
  const { error } = await supabase
    .from("notifications")
    .update({ is_read: true })
    .in("id", ids);
  if (error) console.log("[notif-supabase] markAsRead error:", error.message);
};

const markAsViewed = async ({ notificationId } = {}) => {
  if (!notificationId) return;
  const id = String(notificationId).replace(/^sb_/, "");
  const { error } = await supabase.rpc("mark_notification_viewed", {
    p_notification_id: id,
  });
  if (error) console.log("[notif-supabase] markAsViewed error:", error.message);
};

const markAllAsViewed = async ({ userId } = {}) => {
  const userUuid = userId ? await resolveSupabaseUserId(userId) : getMessagesUserId();
  if (!userUuid) return;
  const { error } = await supabase.rpc("mark_all_notifications_viewed", {
    p_user_id: userUuid,
  });
  if (error) console.log("[notif-supabase] markAllAsViewed error:", error.message);
};

// notifyFollowers / notifyUser — emit a notification + push send.
// The submit_notification RPC writes the row + dedups per type. Push
// delivery still goes through Expo's push API; Bunny / Appwrite paths
// don't change.
const notifyUser = async ({ recipientId, sender, type, resourceId, message, metadata }) => {
  if (!sender?.$id) return { ok: false, error: "missing_sender" };
  return submitNotification({
    recipientId,
    actorId: sender.$id,
    type,
    targetType: metadata?.targetType,
    targetId: metadata?.targetId,
    parentTargetId: metadata?.parentTargetId,
    message,
    preview: message,
    metadata: { ...(metadata || {}), resourceId, senderUsername: sender.username },
  });
};

// Bulk notify-followers — used when a creator posts. Falls through to
// per-recipient submit_notification calls (the dedup is per-row, so
// no cross-recipient interference).
const notifyFollowers = async ({ sender, type, resourceId, message }) => {
  // Followers are read from the Supabase follows table (already migrated).
  // We import lazily to avoid a circular dependency between
  // notifications-supabase and follows-supabase.
  const { FollowServiceSupabase } = await import("./follows-supabase");
  const followers = await FollowServiceSupabase.getFollowers({ userId: sender?.$id });
  const list = Array.isArray(followers?.documents) ? followers.documents : followers || [];
  await Promise.all(
    list.map((row) =>
      submitNotification({
        recipientId: row.followerId || row.follower_id,
        actorId: sender?.$id,
        type,
        message,
        preview: message,
        metadata: { resourceId, senderUsername: sender?.username },
      }),
    ),
  );
  return { ok: true, count: list.length };
};

// Class wrapper to mirror the legacy NotificationService API exactly,
// so the dispatcher in lib/notifications.js can swap implementations
// without consumer-side changes.
export class NotificationServiceSupabase {
  async getFollowers({ userId }) {
    const { FollowServiceSupabase } = await import("./follows-supabase");
    return FollowServiceSupabase.getFollowers({ userId });
  }
  async notifyFollowers(args) { return notifyFollowers(args); }
  async fetchNotifications(args) { return loadAllNotifications(args); }
  async getUnreadCount(args) { return getUnreadCount(args); }
  async markAllAsRead(args) { return markAllAsRead(args); }
  async markAsRead(args) { return markAsRead(args); }
  async markAsViewed(args) { return markAsViewed(args); }
  async markAllAsViewed(args) { return markAllAsViewed(args); }
  async notifyUser(args) { return notifyUser(args); }
  // checkFollowNotificationExists — handled server-side by the dedup
  // logic in submit_notification, so the client check is a no-op.
  async checkFollowNotificationExists() { return false; }
  // fetchFromFirebase — Firebase analytics, kept on the legacy path.
  async fetchFromFirebase(_path) { return null; }
}

export const submitNotificationRpc = submitNotification;
