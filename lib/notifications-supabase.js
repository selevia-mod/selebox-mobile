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
import { createTtlCache } from "./utils/createTtlCache";

const BACKEND_TAG = "supabase";

// In-memory cache of actor profiles so we don't refetch the same profile
// on every realtime UPDATE. Key = profiles.id, Value = { username, avatar_url }.
//
// TTL added May 2026 — was a forever Map; users with long-running
// sessions (or app foreground holds) saw stale usernames/avatars in
// the bell after another user changed their profile. 5 minutes is
// long enough that bell renders stay cheap, short enough that name/
// avatar edits land within one return-to-app cycle.
const actorCache = createTtlCache({ ttlMs: 5 * 60 * 1000, maxEntries: 500 });

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
//
// 5min TTL — same rationale as actorCache: group names + avatars
// change rarely but should reflect within one return-to-app cycle.
const conversationCache = createTtlCache({ ttlMs: 5 * 60 * 1000, maxEntries: 100 });

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
//
// 2min TTL — shorter than actor/conversation caches because
// resource titles/thumbnails (post body, video title, book cover)
// change more often. Also, notification target sets churn faster
// (each new bell row brings new target ids) so a tighter TTL keeps
// the cache from drifting away from "what's currently visible."
const resourceCache = createTtlCache({ ttlMs: 2 * 60 * 1000, maxEntries: 500 });

// Translate the snake_case Supabase notification `type` column into the
// kebab-case form NotificationCard.jsx pattern-matches on. We keep the
// renderer untouched — strictly an adapter concern. Anything not in this
// map passes through unchanged (so unknown future types still render).
//
// IMPORTANT — naming convention drift:
// The notify_on_* triggers historically emitted noun_verb types
// (post_like, post_comment, video_like, etc.) — that's what the OLD
// entries in this map handle. The web bell renderer (notificationLabel
// in /Selebox/js/app.js) keys off verb_noun (like_post, comment_post,
// reply_comment, etc.). After the type-name unification migration
// (migration_notification_type_names_fix.sql), triggers emit the
// verb_noun form. Mobile needs to recognize BOTH: old rows still in the
// table use noun_verb, new rows use verb_noun. Both routes map to the
// same kebab destination so the renderer keeps working unchanged.
const SUPABASE_TYPE_TO_KEBAB = {
  // ── New verb_noun names (emitted post-migration, matches web bell) ──
  like_post: "post-like",
  like_video: "video-like",
  like_book: "book-like",
  // like_comment is ambiguous (post-comment vs video-comment) — pick
  // post-comment-like as the renderer's most generic comment-like card.
  // The renderer also reads target_type from row.target_type for nav.
  like_comment: "post-comment-like",
  comment_post: "post-comment",
  comment_video: "video-comment",
  comment_chapter: "book-chapter-comment",
  // reply_comment collapses post-reply + video-reply on web. Mobile
  // distinguishes via target_type at render time, so map to post-reply
  // by default and let the resourceId carry context.
  reply_comment: "post-reply",
  reply_chapter_comment: "book-chapter-reply",
  repost_post: "post-repost",
  follow_new_post: "follow-new-post",
  follow_new_video: "follow-new-video",
  follow_new_book: "follow-new-book",
  follow_repost: "follow-repost",
  mention_comment: "post-mention",
  mention_chapter_comment: "book-chapter-mention",

  // ── Legacy noun_verb names (rows from before the migration) ────────
  post_like: "post-like",
  post_comment: "post-comment",
  post_comment_reply: "post-reply",
  post_comment_like: "post-comment-like",
  video_like: "video-like",
  video_comment: "video-comment",
  video_comment_reply: "video-reply",
  video_comment_like: "video-comment-like",
  video_upload: "video-upload",
  book_like: "book-like",
  book_comment: "book-comment",
  book_comment_reply: "book-reply",
  book_comment_like: "book-comment-like",
  book_chapter_comment: "book-chapter-comment",
  book_chapter_comment_reply: "book-chapter-reply",
  // Inline-comment family — the renderer matches against the constant
  // INLINE_COMMENT_NOTIFICATION_TYPE, currently "book-inline-comment".
  book_chapter_inline_comment: "book-inline-comment",
  book_chapter_inline_comment_reply: "book-inline-comment",
  book_chapter_inline_comment_like: "book-inline-comment",

  // ── Pass-through ──
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
    // Resolve the actual SURFACE to hydrate (post / video / book /
    // chapter), even when the row's direct target is a comment.
    //
    // The notify_on_comment trigger (migration_notifications_parent_
    // target_type.sql) writes target_type='comment' + target_id=<comment.id>
    // and stores the surface in parent_target_type / parent_target_id.
    // Without this fallback, comment-on-post notifications never get
    // their post hydrated → bell card has no thumbnail/title AND
    // routing falls back to the comment UUID, which downstream code
    // tries to load as a post → "Unable to load this post."
    let surfaceType = row.target_type;
    let surfaceId = row.target_id;
    if (surfaceType === "comment" && row.parent_target_type && row.parent_target_id) {
      surfaceType = row.parent_target_type;
      surfaceId = row.parent_target_id;
    }
    if (!surfaceType || !surfaceId) continue;
    if (!Object.prototype.hasOwnProperty.call(buckets, surfaceType)) continue;
    const cacheKey = `${surfaceType}:${surfaceId}`;
    if (resourceCache.has(cacheKey)) continue;
    buckets[surfaceType].add(surfaceId);
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
      // Hotfix (May 2026, USE_SUPABASE_AUTH=true): prefer the Supabase UUID
      // over legacy_appwrite_id for the post's $id. Reason: the post-item
      // screen calls getPost which routes UUIDs to Supabase fetchPostById
      // and routes hex ids to Appwrite databases.getDocument. Under
      // AUTH=true the user has no Appwrite session, so the hex path fails
      // ("Unable to load this post" red banner). Even when there IS a
      // session, web-native posts have legacy_appwrite_id=NULL anyway, so
      // the UUID is always present and the safer route. Home feed taps
      // already use UUIDs (Supabase posts carry $id=UUID via the post
      // adapter), so this aligns the notification path with how the rest
      // of the app already navigates.
      resourceCache.set(`post:${p.id}`, {
        $id: p.id,
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
    // Secret-chat flag — written by notify_on_chat_message and backfilled
    // by migration_notifications_dm_secret_flag.sql. NotificationCard
    // gates the privacy treatment ("Someone sent you a private message",
    // lock avatar, no preview) on this. Regular DMs render with the real
    // sender + the existing message preview.
    const isSecret = Boolean(row.metadata?.is_secret);
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
      isSecret,
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
  const rawTargetType = row.target_type || null;
  const rawTargetId = row.target_id || null;
  const parentTargetType = row.parent_target_type || null;
  const parentTargetId = row.parent_target_id || null;
  const metadata = row.metadata || {};

  // Surface routing fix (May 2026): when the trigger sets
  // target_type='comment' (notify_on_comment / notify_on_reply
  // emit this for post / video / chapter comments), the actual
  // SURFACE we need to navigate to lives in parent_target_type +
  // parent_target_id. Treat those as the effective target so the
  // resource cache key, focus* fields and resourceId all point at
  // the post/video/chapter — not the comment row, which is what
  // post-item / video-player try to load.
  const isCommentTarget = rawTargetType === "comment";
  const targetType = isCommentTarget ? parentTargetType : rawTargetType;
  const targetId = isCommentTarget ? parentTargetId : rawTargetId;
  const cacheKey = targetType && targetId ? `${targetType}:${targetId}` : null;
  const resource = cacheKey ? resourceCache.get(cacheKey) || null : null;

  // Pull comment/reply context from metadata. Writers may use camelCase
  // or snake_case keys depending on which surface emitted the row, so
  // accept both.
  // When the row's target IS a comment, the comment id is row.target_id
  // — fall back to that so the post-item screen can scroll to / focus
  // the comment even when metadata is empty (which is the case for
  // comments produced by notify_on_comment, where the trigger passes
  // '{}'::jsonb as metadata).
  const metaCommentId = metadata.commentId || metadata.comment_id || null;
  const metaReplyId = metadata.replyId || metadata.reply_id || null;
  const commentId = metaCommentId || (isCommentTarget && supabaseType !== "reply_comment" ? rawTargetId : null);
  const replyId = metaReplyId || (isCommentTarget && supabaseType === "reply_comment" ? rawTargetId : null);
  const commentText = metadata.commentText || metadata.comment_text || row.preview || null;

  // resolvedTargetId — prefer the Appwrite-shaped legacy id when the
  // resource has one, since the existing nav helpers + downstream
  // screens key off that. Falls back to UUID for newer rows.
  const resolvedTargetId = resource?.$id || targetId;

  // Build a structured Appwrite-style resourceId so legacy code paths
  // that re-parse via parseVideoNotificationResourceId etc. work without
  // changes. Plain target_id is used when there's no comment context.
  //
  // Follow-notification fallback (May 2026): the notify_on_follow trigger
  // writes target_type=NULL + target_id=NULL because there's no resource
  // tied to a follow event — only an actor + recipient. Without a
  // fallback, resourceId comes out NULL and NotificationCard hands the
  // creator-profile screen `userId: null`, which never loads. For follow
  // and follow-related types, fall through to actor_id so the bell row
  // navigates to the follower's profile when tapped.
  const isFollowKind = supabaseType === "follow" || supabaseType.startsWith("follow_");
  const followFallbackId = isFollowKind && !targetId ? row.actor_id : null;
  const resourceId = followFallbackId || buildAppwriteStyleResourceId(
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

// Delete a single notification row (privacy-preserving for Secret-DM bell
// rows — once read, leave no trace). Scopes the delete to the current
// user's recipient_id so a stray ID can't take down someone else's row.
// RLS on notifications already enforces this on the server side; the
// extra eq() in the client is belt-and-suspenders. Failures are logged
// but swallowed — the bell list will resync on next fetch and the row
// will then drop locally on its own (the deleted row already vanished
// from the optimistic UI by the time we hit a network error).
//
// IMPORTANT: strip the "sb_" prefix that adaptRow stamps onto notification
// IDs to avoid collision with Appwrite-shaped IDs in the unified bell
// list. Without the strip, Postgres rejects with
// `invalid input syntax for type uuid: "sb_..."` because the column is a
// real uuid type. Same prefix-stripping pattern as markAsViewed +
// markAsRead lower in this file.
export const deleteNotification = async (notificationId) => {
  if (!notificationId) return;
  const me = getMessagesUserId();
  if (!me) return;
  const id = String(notificationId).replace(/^sb_/, "");
  const { error } = await supabase
    .from("notifications")
    .delete()
    .eq("id", id)
    .eq("recipient_id", me);
  if (error) {
    console.log("[notif-supabase] deleteNotification failed:", error.message);
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
// ─────────────────────────────────────────────────────────────────────────
// Facebook-style grouping (May 2026)
// ─────────────────────────────────────────────────────────────────────────
// Collapses same-type-same-target notifications into a single bell row so
// the panel doesn't fill up with N near-identical rows when many users
// engage with the same post/video/book. Mirrors Facebook's "X, Y and N
// others commented on your post" pattern.
//
// Rules (per the product call):
//   - All-time window. Same target → same row regardless of how spread
//     out the actions are within whatever page is loaded.
//   - Group: comments/replies on the same post / video / book chapter,
//     likes on the same post / video / book, and ALL follow events
//     (single bucket — there's no resource to key follows on, so every
//     follow notification merges into one "X, Y and N started following
//     you" row).
//   - Timestamp = most recent action (the newest entry's created_at
//     becomes the head row's timestamp).
//
// What ships in this OTA:
//   - Client-side bucketing applied to whatever page is loaded. If a
//     popular target spans pages, the older page renders its own grouped
//     row — acceptable trade-off for a no-RPC-change rollout. A later
//     phase can move the grouping into fetch_user_notifications RPC for
//     true cross-page aggregation.
//
// The grouped row carries:
//   - All fields from the most-recent entry (the head)
//   - groupedActors[]: deduped sender objects sorted by recency
//   - groupedCount: number of distinct actors
//   - groupedSourceIds[]: every $id collapsed into the bucket — used by
//     mark-read so tapping a grouped row marks all underlying rows read
//   - _grouped: true marker (NotificationCard renders the grouped form)
//
// Anything we don't know how to bucket (mention-comment, dm_message,
// inline-comment, clip, video-upload, book/post-repost, etc.) passes
// through unchanged.
const _groupBucketKeyFor = (row) => {
  const type = row?.type || "";

  if (type === "follow") return "follow:any";

  if (type === "post-like") return row?.focusPostId ? `like-post:${row.focusPostId}` : null;
  if (type === "video-like") return row?.focusVideoId ? `like-video:${row.focusVideoId}` : null;
  if (type === "book-like") return row?.focusBookId ? `like-book:${row.focusBookId}` : null;

  if (type === "post-comment" || type === "post-reply" || type === "post-comment-like") {
    return row?.focusPostId ? `comment-post:${row.focusPostId}` : null;
  }
  if (type === "video-comment" || type === "video-reply") {
    return row?.focusVideoId ? `comment-video:${row.focusVideoId}` : null;
  }
  if (type === "book-chapter-comment" || type === "book-chapter-reply") {
    return row?.focusChapterId ? `comment-chapter:${row.focusChapterId}` : null;
  }

  return null;
};

const groupNotifications = (rows) => {
  if (!Array.isArray(rows) || rows.length === 0) return rows;

  const buckets = new Map();
  const passThrough = [];

  for (const row of rows) {
    const key = _groupBucketKeyFor(row);
    if (!key) {
      passThrough.push(row);
      continue;
    }
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }

  const grouped = [];
  for (const entries of buckets.values()) {
    if (entries.length === 1) {
      grouped.push(entries[0]);
      continue;
    }
    // Most-recent first → head is the newest action; its timestamp is
    // what the bell card will render.
    entries.sort((a, b) => new Date(b.$createdAt) - new Date(a.$createdAt));
    const head = entries[0];

    // Dedupe actors. Same person who commented twice on a post counts
    // once — matches Facebook's behavior where a single actor never
    // shows up twice in the grouped row's actor list.
    const seen = new Set();
    const groupedActors = [];
    for (const e of entries) {
      const id = e?.sender?.$id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (e?.sender) groupedActors.push(e.sender);
    }

    grouped.push({
      ...head,
      groupedActors,
      groupedCount: groupedActors.length,
      groupedSourceIds: entries.map((e) => e?.$id).filter(Boolean),
      isViewed: entries.every((e) => e?.isViewed),
      _grouped: true,
    });
  }

  // Re-sort everything by created_at desc so grouped rows stay in the
  // right chronological position relative to the pass-through rows.
  const all = [...grouped, ...passThrough];
  all.sort((a, b) => new Date(b.$createdAt) - new Date(a.$createdAt));
  return all;
};

const loadAllNotifications = async ({ userId, limit = 20, before = null, lastId = null } = {}) => {
  const userUuid = userId ? await resolveSupabaseUserId(userId) : getMessagesUserId();
  if (!userUuid) return { documents: [], total: 0 };

  // Path A read-side: mobile uses Supabase anon key (USE_SUPABASE_AUTH=false),
  // so auth.uid() is null and the notif_self_read RLS policy filters every
  // row out. fetch_user_notifications is a SECURITY DEFINER RPC that takes
  // the user's UUID as a parameter and bypasses RLS internally.
  //
  // `lastId` is the Appwrite-style cursor used by the bell panel's
  // pagination. The RPC resolves the cursor row's created_at internally
  // (cheaper round-trip than two separate calls). If lastId starts with
  // "sb_" it's already one of our adapted rows; strip the prefix first.
  const cursorId = !before && lastId ? String(lastId).replace(/^sb_/, "") : null;

  const { data, error } = await supabase.rpc("fetch_user_notifications", {
    p_user_id: userUuid,
    p_limit: limit,
    p_before: before,
    p_cursor_id: cursorId,
  });
  if (error) {
    console.log("[notif-supabase] loadAllNotifications error:", error.message);
    return { documents: [], total: 0 };
  }
  const rows = data || [];

  // Total — also via RPC so it bypasses RLS the same way. The bell panel
  // uses this to decide whether to fetch another page.
  const { data: totalCount, error: countErr } = await supabase.rpc(
    "count_user_notifications",
    { p_user_id: userUuid },
  );
  if (countErr) console.log("[notif-supabase] count_user_notifications error:", countErr.message);

  // Hydrate actors + conversations + target resources in parallel. Each
  // populates its own cache; adaptRow looks them up by id.
  await Promise.all([
    hydrateActors(rows),
    hydrateConversations(rows),
    hydrateResources(rows),
  ]);

  return {
    documents: groupNotifications(rows.map(adaptRow)),
    total: totalCount ?? rows.length,
  };
};

// Total unread count across ALL notification types — bell badge.
// Uses count_user_unread_notifications RPC (SECURITY DEFINER) so the count
// works for mobile where auth.uid() is null and direct .select() returns 0.
const getUnreadCount = async ({ userId } = {}) => {
  const userUuid = userId ? await resolveSupabaseUserId(userId) : getMessagesUserId();
  if (!userUuid) return 0;
  const { data, error } = await supabase.rpc("count_user_unread_notifications", {
    p_user_id: userUuid,
  });
  if (error) {
    console.log("[notif-supabase] getUnreadCount error:", error.message);
    return 0;
  }
  return data || 0;
};

// Bulk mark-as-read — bell panel calls this on open. Uses RPC so the
// UPDATE bypasses notif_self_update RLS (which keys off auth.uid()).
// Returns true on success, false on error — the handler in
// app/(notification)/notification.jsx uses the return value to decide
// whether to revert its optimistic update.
const markAllAsRead = async ({ userId } = {}) => {
  const userUuid = userId ? await resolveSupabaseUserId(userId) : getMessagesUserId();
  if (!userUuid) return false;
  const { error } = await supabase.rpc("mark_notifications_read_bulk", {
    p_user_id: userUuid,
  });
  if (error) {
    console.log("[notif-supabase] markAllAsRead error:", error.message);
    return false;
  }
  return true;
};

// Mark specific ids as read. We pass the user's UUID so the RPC can verify
// the rows belong to them (prevents a malicious caller from flipping
// someone else's notifications).
const markAsRead = async ({ notificationIds = [], userId } = {}) => {
  if (!notificationIds.length) return;
  const userUuid = userId ? await resolveSupabaseUserId(userId) : getMessagesUserId();
  if (!userUuid) return;
  // Strip any "sb_" prefix that adaptRow added for chat rows.
  const ids = notificationIds.map((id) => String(id).replace(/^sb_/, ""));
  const { error } = await supabase.rpc("mark_notifications_read_by_ids", {
    p_user_id: userUuid,
    p_ids: ids,
  });
  if (error) console.log("[notif-supabase] markAsRead error:", error.message);
};

const markAsViewed = async ({ notificationId, userId } = {}) => {
  if (!notificationId) return;
  // Pass p_user_id so the RPC can verify ownership when auth.uid() is
  // null (mobile uses anon key with no Supabase session). Without this,
  // the RPC's `coalesce(auth.uid(), p_user_id)` resolves to null and
  // the UPDATE silently no-ops.
  const userUuid = userId ? await resolveSupabaseUserId(userId) : getMessagesUserId();
  const id = String(notificationId).replace(/^sb_/, "");
  const { error } = await supabase.rpc("mark_notification_viewed", {
    p_notification_id: id,
    p_user_id: userUuid || null,
  });
  if (error) console.log("[notif-supabase] markAsViewed error:", error.message);
};

// Returns true on success, false on error. The bell-panel handler in
// app/(notification)/notification.jsx uses the return value to decide
// whether to revert its optimistic "all-rows-viewed" update — without
// this the UI snaps back to unread even though the DB write succeeded.
const markAllAsViewed = async ({ userId } = {}) => {
  const userUuid = userId ? await resolveSupabaseUserId(userId) : getMessagesUserId();
  if (!userUuid) return false;
  const { error } = await supabase.rpc("mark_all_notifications_viewed", {
    p_user_id: userUuid,
  });
  if (error) {
    console.log("[notif-supabase] markAllAsViewed error:", error.message);
    return false;
  }
  return true;
};

// notifyFollowers / notifyUser — emit a notification + push send.
// The submit_notification RPC writes the row + dedups per type. Push
// delivery still goes through Expo's push API.
//
// Reverse dual-write to Appwrite:
//   With USE_SUPABASE_NOTIFICATIONS = true (Step 3 flag), this is the
//   active implementation. We mirror what the Appwrite path's notifyUser
//   does in the OPPOSITE direction — write to Appwrite as well so the
//   legacy collection stays current during the soak window. This is the
//   piece that makes a flag rollback safe: Appwrite has no gap.
//   Best-effort, never blocks the Supabase write.
const notifyUser = async ({ recipientId, sender, recipient, type, resourceId, message, metadata }) => {
  if (!sender?.$id) return { ok: false, error: "missing_sender" };

  // Caller compatibility: every legacy notifyUser call site (user-connections,
  // PostCommentModal, BookInlineCommentModal, video-player, etc.) passes
  // `recipient` (the full user object) but never `recipientId`. The legacy
  // Appwrite impl read `recipient.$id`; the Supabase impl needs the same
  // fallback or every call resolves null and submit_notification rejects
  // with "missing_required_args" — which silently turned every cross-platform
  // follow / comment notification into a no-op.
  const resolvedRecipientId = recipientId || recipient?.$id;
  if (!resolvedRecipientId) return { ok: false, error: "missing_recipient" };

  // Derive target_type / target_id from (type, resourceId) just like the
  // Appwrite-side notifyUser does. The dedup partial unique index on
  // notifications WHERE target_id IS NOT NULL only catches rows that
  // have target_id set; without this derivation, notifications-supabase
  // writes target_id=NULL and the trigger-fired counterpart row coexists
  // as a duplicate. Caller's metadata can still override (e.g., a
  // hand-built deep notification path that already knows target_id).
  let derivedTargetType = metadata?.targetType;
  let derivedTargetId = metadata?.targetId;
  if (!derivedTargetType || !derivedTargetId) {
    try {
      const { deriveNotificationTarget } = await import("./notifications-appwrite");
      const derived = deriveNotificationTarget(type, resourceId);
      derivedTargetType = derivedTargetType || derived.targetType;
      derivedTargetId = derivedTargetId || derived.targetId;
    } catch (_) {
      /* derivation is best-effort */
    }
  }

  const result = await submitNotification({
    recipientId: resolvedRecipientId,
    actorId: sender.$id,
    type,
    targetType: derivedTargetType,
    targetId: derivedTargetId,
    parentTargetId: metadata?.parentTargetId,
    message,
    preview: message,
    metadata: { ...(metadata || {}), resourceId, senderUsername: sender.username },
  });

  // Reverse dual-write — keep Appwrite filled during the rollout window
  // so flipping USE_SUPABASE_NOTIFICATIONS back to false is a clean
  // revert with no missing rows. After the decommission roadmap (week
  // 3), this block can be removed.
  try {
    const recipientId$id = recipient?.$id || recipientId;
    if (recipientId$id) {
      const { ID: AppwriteID } = await import("react-native-appwrite");
      const { databases } = await import("./appwrite");
      const secrets = (await import("../private/secrets")).default;
      if (secrets?.appwriteConfig?.notificationCollectionId) {
        // Translate Supabase-style underscored type back to Appwrite's
        // hyphenated form for legacy bell rendering on the Appwrite path.
        const legacyType = typeof type === "string" ? type.replace(/_/g, "-") : type;
        await databases.createDocument(
          secrets.appwriteConfig.databaseId,
          secrets.appwriteConfig.notificationCollectionId,
          AppwriteID.unique(),
          {
            recipient: recipientId$id,
            sender: sender.$id,
            type: legacyType,
            resourceId,
            message,
            isRead: false,
            isViewed: false,
          },
        );
      }
    }
  } catch (awErr) {
    console.log("[notif-supabase] Appwrite reverse dual-write skipped:", awErr?.message);
  }

  // Push send — only the Supabase path gets recipient as a full object
  // (the Appwrite path passes it explicitly). If we have it, fire a push
  // so this path matches the Appwrite implementation feature-for-feature.
  try {
    if (recipient?.expoPushToken && message) {
      await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip, deflate",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: recipient.expoPushToken,
          sound: "default",
          title: sender.username || "Someone",
          body: String(message).trim(),
          data: { type, resourceId, senderId: sender.$id },
          android: { channelId: "default", priority: "max" },
          ios: { _displayInForeground: true },
        }),
      });
    }
  } catch (pushErr) {
    console.log("[notif-supabase] push send skipped:", pushErr?.message);
  }

  return result;
};

// Bulk notify-followers — used when a creator posts. Falls through to
// per-recipient submit_notification calls (the dedup is per-row, so
// no cross-recipient interference).
//
// Same reverse dual-write pattern as notifyUser — every per-follower
// write also lands in Appwrite during the rollout window so a flag
// rollback is safe.
const notifyFollowers = async ({ sender, type, resourceId, message }) => {
  // Followers are read from the Supabase follows table (already migrated).
  // We import lazily to avoid a circular dependency between
  // notifications-supabase and follows-supabase.
  const { FollowServiceSupabase } = await import("./follows-supabase");
  const followers = await FollowServiceSupabase.getFollowers({ userId: sender?.$id });
  const list = Array.isArray(followers?.documents) ? followers.documents : followers || [];

  // Lazy-import the Appwrite write surface once for the batch. Same
  // belt-and-suspenders pattern as the Appwrite path's notifyFollowers.
  let appwriteWrite = null;
  try {
    const [{ ID: AppwriteID }, { databases }, secretsModule] = await Promise.all([
      import("react-native-appwrite"),
      import("./appwrite"),
      import("../private/secrets"),
    ]);
    const secrets = secretsModule.default;
    if (secrets?.appwriteConfig?.notificationCollectionId) {
      appwriteWrite = async (recipientId, legacyType) => {
        await databases.createDocument(
          secrets.appwriteConfig.databaseId,
          secrets.appwriteConfig.notificationCollectionId,
          AppwriteID.unique(),
          {
            recipient: recipientId,
            sender: sender?.$id,
            type: legacyType,
            resourceId,
            message,
            isRead: false,
            isViewed: false,
          },
        );
      };
    }
  } catch (_) {
    /* skip Appwrite reverse dual-write */
  }
  const legacyType = typeof type === "string" ? type.replace(/_/g, "-") : type;

  // Rate-limit summary: when the user has many followers and Appwrite's
  // per-endpoint rate limit kicks in, we previously logged once per
  // failed follower — turning a single Publish into 50+ identical
  // "Appwrite skipped: Rate limit ..." lines that looked like an
  // infinite loop. The Supabase side of this notification still goes
  // through fine (submit_notification above), so we just need to
  // collapse the noise from the legacy mirror.
  let appwriteRateLimited = 0;
  let appwriteOtherErrors = 0;

  await Promise.all(
    list.map(async (row) => {
      const recipientId = row.followerId || row.follower_id;
      await submitNotification({
        recipientId,
        actorId: sender?.$id,
        type,
        message,
        preview: message,
        metadata: { resourceId, senderUsername: sender?.username },
      });
      if (appwriteWrite && recipientId) {
        try {
          await appwriteWrite(recipientId, legacyType);
        } catch (awErr) {
          // Quiet the rate-limit case (single summary line at end of
          // batch). Surface non-rate-limit failures normally so genuine
          // breakages still get visibility.
          if (/rate limit/i.test(awErr?.message || "")) {
            appwriteRateLimited += 1;
          } else {
            appwriteOtherErrors += 1;
            console.log("[notif-supabase] notifyFollowers Appwrite skipped:", awErr?.message);
          }
        }
      }
    }),
  );

  if (appwriteRateLimited > 0) {
    console.log(
      `[notif-supabase] notifyFollowers Appwrite mirror rate-limited for ${appwriteRateLimited} of ${list.length} followers ` +
        `(Supabase notifications still delivered; Appwrite mirror is legacy soak-window only)`,
    );
  }
  return { ok: true, count: list.length, appwriteRateLimited, appwriteOtherErrors };
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
