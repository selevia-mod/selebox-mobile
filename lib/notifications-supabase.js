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
    .select("id, username, avatar_url, legacy_appwrite_id")
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

// ─────────────────────────────────────────────────────────────────────────
// Phase 2 — Resource hydration
// ─────────────────────────────────────────────────────────────────────────
// The bell card (components/NotificationCard.jsx) reads
//   item.resourceData.thumbnail   → right-side thumbnail image
//   item.resourceData.title       → snippet appended to "commented on your X"
//   item.resourceData.post        → same, but for post type
//   item.resourceData.$id         → fallback for focusVideoId/focusPostId/etc.
// Phase 1 left these unpopulated for non-DM rows; this phase fans out
// per-type batched SELECTs against the resource tables and stitches the
// data back onto each adapted notification.
//
// All four buckets (post / video / book / book-chapter) are fetched in
// parallel, then the per-row hash lookup happens in adaptRow. Failures
// fall through to a generic card — never block the bell panel.

// Cache key = `${target_type}:${target_id}` (the target_id is a UUID).
// Values are { $id, legacy_id, title, post, thumbnail }.
const resourceCache = new Map();

// Translate the snake_case Supabase notification `type` column into the
// kebab-case form NotificationCard.jsx pattern-matches on. We keep the
// renderer untouched — strictly an adapter concern. Anything not in this
// map passes through unchanged (so unknown future types still render).
const SUPABASE_TYPE_TO_KEBAB = {
  // Posts
  post_like: "post-like",
  post_comment: "post-comment",
  post_comment_reply: "post-reply",
  post_comment_like: "post-comment-like",
  // Videos
  video_like: "video-like",
  video_comment: "video-comment",
  video_comment_reply: "video-reply",
  video_comment_like: "video-comment-like",
  video_upload: "video-upload",
  // Books
  book_like: "book-like",
  book_comment: "book-comment",
  book_comment_reply: "book-reply",
  book_comment_like: "book-comment-like",
  // Chapters
  book_chapter_comment: "book-chapter-comment",
  book_chapter_comment_reply: "book-chapter-reply",
  // Inline-comment family — the renderer matches against the constant
  // INLINE_COMMENT_NOTIFICATION_TYPE, currently "book-inline-comment".
  book_chapter_inline_comment: "book-inline-comment",
  book_chapter_inline_comment_reply: "book-inline-comment",
  book_chapter_inline_comment_like: "book-inline-comment",
  // Pass-through (already in kebab / wire shape)
  follow: "follow",
  dm_message: "dm_message",
  clip: "clip",
  announcement: "announcement",
};

// Build a structured Appwrite-style resourceId from target_type + comment
// context. Mirrors lib/notifications-appwrite.js's build*Resource helpers
// so the renderer's parse*ResourceId fallback paths still work for
// Supabase-shaped notifications. Inlined to avoid pulling the full
// notifications-appwrite module (which transitively imports BookService /
// VideosService) into the Supabase code path.
const buildAppwriteStyleResourceId = (targetType, targetId, commentId, replyId) => {
  if (!targetType || !targetId) return targetId || null;
  // Only add the structured prefix when there's a comment context. Bare
  // resource notifications (e.g. post_like with no comment) keep the
  // raw target_id, matching how the legacy build*ResourceId helpers
  // behave when commentId is absent.
  if (!commentId) return targetId;
  const prefix = targetType; // "video" | "post" | "book" | "book-chapter"
  if (replyId) return `${prefix}:${targetId}:comment:${commentId}:reply:${replyId}`;
  return `${prefix}:${targetId}:comment:${commentId}`;
};

// Bucket rows by target_type and fan out one batched SELECT per resource
// table. Populates resourceCache keyed by `${type}:${target_id}`. Skips
// types we don't hydrate (dm_message, follow). Failures are logged but
// don't throw — adaptRow falls through to a generic card.
const hydrateResources = async (rows) => {
  const buckets = {
    post: new Set(),
    video: new Set(),
    book: new Set(),
    "book-chapter": new Set(),
  };

  for (const row of rows) {
    const targetType = row.target_type;
    const targetId = row.target_id;
    if (!targetType || !targetId) continue;
    if (!Object.prototype.hasOwnProperty.call(buckets, targetType)) continue;
    const cacheKey = `${targetType}:${targetId}`;
    if (resourceCache.has(cacheKey)) continue;
    buckets[targetType].add(targetId);
  }

  const fetchPosts = async () => {
    if (buckets.post.size === 0) return;
    // Posts can have an attached video — embed it so video-only posts
    // get the video thumbnail. body is truncated downstream by the
    // renderer's appendSnippet, so we hand it over as `post`/`title`.
    const { data, error } = await supabase
      .from("posts")
      .select("id, body, image_url, legacy_appwrite_id, video_id, videos(id, thumbnail_url)")
      .in("id", [...buckets.post]);
    if (error) {
      console.log("[notif-supabase] hydrateResources(post) error:", error.message);
      return;
    }
    for (const p of data || []) {
      resourceCache.set(`post:${p.id}`, {
        $id: p.legacy_appwrite_id || p.id,
        legacy_id: p.legacy_appwrite_id || null,
        title: p.body || null,
        post: p.body || null,
        thumbnail: p.image_url || p.videos?.thumbnail_url || null,
      });
    }
  };

  const fetchVideos = async () => {
    if (buckets.video.size === 0) return;
    const { data, error } = await supabase
      .from("videos")
      .select("id, title, thumbnail_url, legacy_appwrite_id")
      .in("id", [...buckets.video]);
    if (error) {
      console.log("[notif-supabase] hydrateResources(video) error:", error.message);
      return;
    }
    for (const v of data || []) {
      resourceCache.set(`video:${v.id}`, {
        $id: v.legacy_appwrite_id || v.id,
        legacy_id: v.legacy_appwrite_id || null,
        title: v.title || null,
        thumbnail: v.thumbnail_url || null,
      });
    }
  };

  const fetchBooks = async () => {
    if (buckets.book.size === 0) return;
    const { data, error } = await supabase
      .from("books")
      .select("id, title, cover_url, legacy_appwrite_id")
      .in("id", [...buckets.book]);
    if (error) {
      console.log("[notif-supabase] hydrateResources(book) error:", error.message);
      return;
    }
    for (const b of data || []) {
      resourceCache.set(`book:${b.id}`, {
        $id: b.legacy_appwrite_id || b.id,
        legacy_id: b.legacy_appwrite_id || null,
        title: b.title || null,
        thumbnail: b.cover_url || null,
      });
    }
  };

  const fetchChapters = async () => {
    if (buckets["book-chapter"].size === 0) return;
    // Chapter cover may be null — fall back to the parent book's cover_url
    // so the bell card still renders a thumbnail. Joined inline.
    const { data, error } = await supabase
      .from("chapters")
      .select("id, title, cover_url, legacy_appwrite_id, book_id, books(id, cover_url, legacy_appwrite_id)")
      .in("id", [...buckets["book-chapter"]]);
    if (error) {
      console.log("[notif-supabase] hydrateResources(chapter) error:", error.message);
      return;
    }
    for (const c of data || []) {
      resourceCache.set(`book-chapter:${c.id}`, {
        $id: c.legacy_appwrite_id || c.id,
        legacy_id: c.legacy_appwrite_id || null,
        title: c.title || null,
        thumbnail: c.cover_url || c.books?.cover_url || null,
        // Surface the parent book id so the renderer / nav helpers can
        // route up to book-info if needed.
        bookId: c.books?.legacy_appwrite_id || c.books?.id || c.book_id || null,
      });
    }
  };

  await Promise.all([fetchPosts(), fetchVideos(), fetchBooks(), fetchChapters()]);
};

// Map a Supabase notifications row → Appwrite-shaped notification doc.
// Keep `_backend` + `_supabaseId` so the renderer / mark-read code knows
// which API to talk to. Avoid stashing the full raw row — it bloats the
// MMKV-persisted Redux notifications cache.
//
// Two shapes share this function:
//   • dm_message — chat-bell rows (Phase 1). Routing is conversation-based.
//   • everything else (post / video / book / chapter / follow / clip /
//     announcement) — Phase 2. Reads resourceCache populated by
//     hydrateResources to attach .resourceData (thumbnail + title), maps
//     metadata fields onto the focus* fields the renderer reads, and
//     translates the snake_case Supabase type to the kebab-case form
//     NotificationCard.jsx pattern-matches on.
const adaptRow = (row) => {
  const actor = actorCache.get(row.actor_id) || null;
  const supabaseType = typeof row.type === "string" ? row.type : "";

  // ─── DM message — preserve Phase 1 behavior exactly ───────────────────
  if (supabaseType === "dm_message") {
    const isGroup = Boolean(row.metadata?.is_group);
    const groupConv = isGroup ? conversationCache.get(row.parent_target_id) : null;
    const preview = row.metadata?.preview || "";
    const verb = isGroup ? "sent a message in a group" : "sent you a message";
    const messageText = preview ? `${verb}: "${preview}"` : verb;
    return {
      $id: `sb_${row.id}`,
      $createdAt: row.created_at,
      type: "dm_message",
      isViewed: Boolean(row.is_read),
      sender: actor
        ? { $id: actor.id, username: actor.username, avatar: actor.avatar_url }
        : { $id: row.actor_id, username: "Someone", avatar: null },
      resourceId: row.parent_target_id,
      conversationId: row.parent_target_id,
      isGroup,
      groupName: groupConv?.name || null,
      groupAvatar: groupConv?.avatar_url || null,
      message: messageText,
      dmPreview: preview,
      _backend: BACKEND_TAG,
      _supabaseId: row.id,
    };
  }

  // ─── All other types — Phase 2 hydration ──────────────────────────────
  const kebabType = SUPABASE_TYPE_TO_KEBAB[supabaseType] || supabaseType;
  const targetType = row.target_type || null;
  const targetId = row.target_id || null;
  const metadata = row.metadata || {};
  const cacheKey = targetType && targetId ? `${targetType}:${targetId}` : null;
  const resource = cacheKey ? resourceCache.get(cacheKey) || null : null;

  // Pull comment/reply context from metadata. Writers may use camelCase
  // or snake_case keys depending on which surface emitted the row, so
  // accept both.
  const commentId = metadata.commentId || metadata.comment_id || null;
  const replyId = metadata.replyId || metadata.reply_id || null;
  const commentText = metadata.commentText || metadata.comment_text || row.preview || null;

  // resolvedTargetId — prefer the Appwrite-shaped legacy id when the
  // resource has one, since the existing nav helpers + downstream
  // screens key off that. Falls back to UUID for newer rows.
  const resolvedTargetId = resource?.$id || targetId;

  // Build a structured Appwrite-style resourceId so legacy code paths
  // that re-parse via parseVideoNotificationResourceId etc. work without
  // changes. Plain target_id is used when there's no comment context.
  const resourceId = buildAppwriteStyleResourceId(
    targetType,
    resolvedTargetId,
    commentId,
    replyId,
  );

  // Sender — use legacy_appwrite_id when the actor row has one (lets the
  // creator-profile screen navigate via Appwrite path while users.js is
  // still on Appwrite for some cohorts). Falls back to the UUID.
  const sender = actor
    ? {
        $id: actor.legacy_appwrite_id || actor.id,
        username: actor.username,
        avatar: actor.avatar_url,
      }
    : { $id: row.actor_id, username: "Someone", avatar: null };

  // Adapted resourceData — only populate fields the renderer actually
  // reads. Avoids bloating the MMKV-persisted Redux cache.
  const resourceData = resource
    ? {
        $id: resource.$id,
        title: resource.title || null,
        post: resource.post || null,
        thumbnail: resource.thumbnail || null,
      }
    : null;

  // Per-type focus* fields. The renderer reads these directly with `||`
  // fallbacks to resourceData.$id, so populating them is a belt-and-
  // suspenders approach for the handful of code paths that prefer the
  // explicit field over re-parsing resourceId.
  const focusVideoId = targetType === "video" ? resolvedTargetId : null;
  const focusPostId = targetType === "post" ? resolvedTargetId : null;
  const focusBookId = targetType === "book" ? resolvedTargetId : null;
  const focusChapterId = targetType === "book-chapter" ? resolvedTargetId : null;

  return {
    // Identity / sorting
    $id: `sb_${row.id}`,
    $createdAt: row.created_at,
    type: kebabType,
    isViewed: Boolean(row.is_viewed),

    // Sender + recipient (recipient is used by video-upload card to show
    // the recipient's avatar instead of the sender's)
    sender,
    recipient: { $id: row.recipient_id, avatar: null },

    // Routing
    resourceId,
    focusResourceType: targetType,
    focusCommentId: commentId,
    focusReplyId: replyId,
    focusCommentText: commentText,
    focusVideoId,
    focusPostId,
    focusBookId,
    focusChapterId,

    // Display
    message: row.message || row.preview || null,

    // Hydrated resource — drives thumbnail + title in NotificationCard
    resourceData,

    // Backend marker
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
  resourceCache.clear();
};


// ─────────────────────────────────────────────────────────────────────────
// NotificationServiceSupabase — Appwrite NotificationService parity.
// ─────────────────────────────────────────────────────────────────────────
// Methods mirror lib/notifications.js's NotificationService class. Used
// by the bell panel + the various places that emit notifications (post
// like / comment, follow flow, etc.).
//
// Read path now does end-to-end hydration (Phase 2):
//   loadAllNotifications fans out 4 parallel SELECTs (posts / videos /
//   books / chapters) keyed by target_id, populates an in-memory
//   resourceCache, then adaptRow stitches { title, thumbnail, $id }
//   onto each notification's resourceData so NotificationCard renders
//   thumbnails + comment-snippet titles correctly. Missing resources
//   (deleted post / video / book) fall through to a generic card.
//
// All write paths go through submit_notification RPC (security-definer,
// dedup-aware).

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
// keyed by `$id` for the bell-panel FlashList. Phase 2 — actor profiles,
// chat-conversation metadata, AND target resources (posts / videos /
// books / chapters) are hydrated in parallel before adapting, so the
// FlashList rows arrive with thumbnails + titles + routing fields ready.
//
// Returns Appwrite-shape `{ documents, total }` so consumers (the bell
// panel's notificationService.fetchNotifications call) can pageinate
// against `total` the same way they do for the legacy backend. `total`
// is approximate — we use a HEAD count to keep the page query cheap.
const loadAllNotifications = async ({ userId, limit = 20, before = null, lastId = null } = {}) => {
  const userUuid = userId ? await resolveSupabaseUserId(userId) : getMessagesUserId();
  if (!userUuid) return { documents: [], total: 0 };

  // `lastId` is the Appwrite-style cursor used by the bell panel's
  // pagination. Resolve the cursor row's created_at so we can do a
  // strictly-less-than comparison server-side. If lastId starts with
  // "sb_" it's already one of our adapted rows; strip the prefix.
  let cursorBefore = before;
  if (!cursorBefore && lastId) {
    const sbId = String(lastId).replace(/^sb_/, "");
    const { data: cursor } = await supabase
      .from("notifications")
      .select("created_at")
      .eq("id", sbId)
      .maybeSingle();
    if (cursor?.created_at) cursorBefore = cursor.created_at;
  }

  let q = supabase
    .from("notifications")
    .select("*")
    .eq("recipient_id", userUuid)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (cursorBefore) q = q.lt("created_at", cursorBefore);

  const { data, error } = await q;
  if (error) {
    console.log("[notif-supabase] loadAllNotifications error:", error.message);
    return { documents: [], total: 0 };
  }
  const rows = data || [];

  // Total — count all of this user's notifications. Cheap (HEAD-only).
  // The bell panel uses this to decide whether to fetch another page.
  const { count } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("recipient_id", userUuid);

  // Hydrate actors + conversations + target resources in parallel. Each
  // populates its own cache; adaptRow looks them up by id.
  await Promise.all([
    hydrateActors(rows),
    hydrateConversations(rows),
    hydrateResources(rows),
  ]);

  return {
    documents: rows.map(adaptRow),
    total: count ?? rows.length,
  };
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
