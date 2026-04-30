// Supabase comments service — Phase C.7 of the Appwrite → Supabase
// migration. Polymorphic `comments` table on Supabase covers comments
// across posts AND videos, plus replies (via parent_id). One table
// replaces what Appwrite had split across post-comments,
// video-comments, and (sub)comment-likes.
//
// Schema (already live on Supabase, used by web in production —
// /Selebox/js/app.js around line 2380):
//   comments
//     - id (uuid PK)
//     - user_id (uuid → profiles.id)
//     - parent_id (uuid → comments.id, nullable)  — replies link here
//     - post_id (uuid → posts.id, nullable)       — set when comment is on a post
//     - video_id (uuid → videos.id, nullable)     — set when comment is on a video
//     - body (text)
//     - image_url (text, nullable)
//     - created_at (timestamptz)
//
// Deletes are hard (DELETE FROM comments WHERE id = ?), matching web's
// behavior. Earlier revisions of this file assumed a `deleted_at` soft-
// delete column existed; that was a mistake — the actual schema doesn't
// have one, and queries filtering on `deleted_at IS NULL` failed with
// `column comments.deleted_at does not exist`. All reads below trust
// the hard-delete contract.
//
// Only one of (post_id, video_id) is set per row. Replies inherit the
// host's post_id/video_id from their parent (web does this implicitly
// via the parent's foreign key, but our schema sets the host on every
// row so a single SELECT returns parents + replies in one round trip).
//
// Likes on comments live in the polymorphic `reactions` table with
// target_type='comment' — see lib/reactions-supabase.js. This module
// does NOT handle reaction writes; callers compose the two services.
//
// What this exports:
//   - fetchCommentsForPost / fetchCommentsForVideo — parents+replies in one query
//   - addComment — top-level or reply (via parent_id)
//   - deleteComment — soft-delete (sets deleted_at)
//   - hardDeleteComment — true delete, used by the author-delete path web uses
//   - fetchCommentCount — single count (used by post stats refresh)
//   - fetchCommentCountsForPosts — batched count for many posts
//   - adaptSupabaseCommentToAppwriteShape — converts to the shape mobile's
//     existing PostCommentModal expects (the same dual-shape pattern we
//     used for posts in posts-supabase.js)

import { getMessagesUserId } from "./messages-supabase";
import supabase from "./supabase";
import { getReactionCountsForTargets } from "./reactions-supabase";

// SELECT shape mirrors web — every read joins the author profile so the
// caller can render avatar+username without a follow-up fetch.
const COMMENT_SELECT = `id, user_id, parent_id, post_id, video_id, body, image_url, created_at,
  profiles!user_id(id, username, avatar_url, is_guest, role)`;

// Defensive: prefer cached Appwrite-resolved id, fall back to Supabase
// session, never throw the raw AuthSessionMissingError (which surfaces
// as a red toast in dev for Appwrite-auth users).
const requireUser = async () => {
  try {
    const cached = getMessagesUserId?.();
    if (cached) return { id: cached };
  } catch (_) {}
  try {
    const { data } = await supabase.auth.getUser();
    if (data?.user) return data.user;
  } catch (_) { /* no session */ }
  throw new Error("Not signed in");
};

// ─────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────

// Fetches all comments (parents + replies) on a single post in one query.
// Returns { parents, repliesByParent } — same shape web's loadComments
// uses internally, ready for a tree-render.
//
// Order is ascending created_at so parents and their replies render in
// chronological order (oldest first), matching web's UX.
export const fetchCommentsForPost = async (postId) => {
  if (!postId) return { parents: [], repliesByParent: {} };
  const { data, error } = await supabase
    .from("comments")
    .select(COMMENT_SELECT)
    .eq("post_id", postId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return splitParentsAndReplies(data || []);
};

// Same as fetchCommentsForPost but for video comments. Mirrors the
// branching loadComments(postId, videoId) does on web. Mobile's video
// player uses CommentSection (separate component); both call into the
// same adapter for shape compatibility.
export const fetchCommentsForVideo = async (videoId) => {
  if (!videoId) return { parents: [], repliesByParent: {} };
  const { data, error } = await supabase
    .from("comments")
    .select(COMMENT_SELECT)
    .eq("video_id", videoId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return splitParentsAndReplies(data || []);
};

// Helper — splits a flat comments array into parents and a parent-id →
// replies map. Used by both fetchCommentsForPost and fetchCommentsForVideo.
const splitParentsAndReplies = (rows) => {
  const parents = [];
  const repliesByParent = {};
  for (const c of rows) {
    if (c.parent_id) {
      if (!repliesByParent[c.parent_id]) repliesByParent[c.parent_id] = [];
      repliesByParent[c.parent_id].push(c);
    } else {
      parents.push(c);
    }
  }
  return { parents, repliesByParent };
};

// Counts comments on a single post. Used by PostInformation's stats
// row when the home feed wants a cheap refresh after the user
// adds/removes a comment. Hard-delete contract — no deleted_at filter.
export const fetchCommentCount = async ({ postId, videoId } = {}) => {
  if (!postId && !videoId) return 0;
  let query = supabase.from("comments").select("*", { count: "exact", head: true });
  if (postId) query = query.eq("post_id", postId);
  else query = query.eq("video_id", videoId);
  const { count, error } = await query;
  if (error) {
    console.log("[comments-supabase] fetchCommentCount error:", error.message);
    return 0;
  }
  return count || 0;
};

// Batched counts for many posts at once. Returns { [postId]: count }.
// Used by feed renderers; lib/posts-supabase.js#fetchPostStats already
// calls into this pattern inline (via a direct comments query). This
// helper exists for any caller that wants comment counts only.
export const fetchCommentCountsForPosts = async (postIds = []) => {
  const result = {};
  for (const id of postIds) result[id] = 0;
  if (!postIds.length) return result;
  const { data, error } = await supabase.from("comments").select("post_id").in("post_id", postIds);
  if (error) {
    console.log("[comments-supabase] fetchCommentCountsForPosts error:", error.message);
    return result;
  }
  for (const c of data || []) {
    if (result[c.post_id] != null) result[c.post_id] += 1;
  }
  return result;
};

// ─────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────

// Adds a comment (or reply) to a post or video. `parentId` makes it a
// reply; omit it for a top-level comment. Exactly one of postId/videoId
// must be set — host is required by RLS on web.
//
// Returns the inserted row in the same SELECT shape as reads, so the
// caller can append it directly to the local list without re-fetching.
export const addComment = async ({ postId, videoId, parentId = null, body = "", imageUrl = null }) => {
  const trimmed = (body || "").trim();
  if (!trimmed && !imageUrl) throw new Error("Comment needs body or image");
  if (!postId && !videoId) throw new Error("postId or videoId required");
  const me = await requireUser();
  const insertRow = {
    user_id: me.id,
    parent_id: parentId || null,
    body: trimmed,
    image_url: imageUrl,
  };
  if (postId) insertRow.post_id = postId;
  else insertRow.video_id = videoId;
  const { data, error } = await supabase.from("comments").insert(insertRow).select(COMMENT_SELECT).single();
  if (error) throw error;
  return data;
};

// Soft-deletes a comment by setting deleted_at = now(). Web's app.js
// uses true DELETE, but soft-delete plays nicer with realtime
// subscribers (they get an UPDATE event instead of needing to track
// removed ids). RLS enforces author-only delete.
export const softDeleteComment = async (commentId) => {
  if (!commentId) throw new Error("commentId required");
  const { error } = await supabase.from("comments").update({ deleted_at: new Date().toISOString() }).eq("id", commentId);
  if (error) throw error;
};

// Hard-deletes a comment. Matches web's behavior verbatim (DELETE FROM
// comments WHERE id = ?). Use this when you need the row truly gone —
// e.g., the post owner is purging spam, or the author wants no trace.
// RLS still enforces author-or-owner only.
export const hardDeleteComment = async (commentId) => {
  if (!commentId) throw new Error("commentId required");
  const { error } = await supabase.from("comments").delete().eq("id", commentId);
  if (error) throw error;
};

// Default delete uses hard-delete to match web exactly. Callers can opt
// into soft-delete via the explicit helper above.
export const deleteComment = hardDeleteComment;

// ─────────────────────────────────────────────────────────────────────────
// Comment likes (on top of the polymorphic reactions table)
// ─────────────────────────────────────────────────────────────────────────

// Returns { [commentId]: { total, byEmoji } } for a list of comment ids.
// Wraps reactions-supabase so callers don't need to know that comment
// likes are stored in the same table as post likes — they just ask for
// "likes on these comment ids" and get back counts.
export const fetchCommentReactionCounts = async (commentIds = []) => {
  return getReactionCountsForTargets({ targetType: "comment", targetIds: commentIds });
};

// ─────────────────────────────────────────────────────────────────────────
// Adapter — Supabase row → Appwrite-shaped object
// ─────────────────────────────────────────────────────────────────────────

// Maps a Supabase comment row to the shape mobile's existing
// PostCommentModal expects. Same dual-shape pattern as
// `adaptSupabasePostToAppwriteShape` — every Appwrite alias carries the
// Supabase value so downstream consumers don't notice the swap.
//
// Mapping:
//   id            → $id
//   created_at    → $createdAt / $updatedAt
//   body          → comment
//   profiles      → commentOwner (with $id, username, avatar)
//   post_id       → postId
//   parent_id     → postComment ({ $id }) when set — modal looks for
//                   `postComment.$id` to detect replies
//   image_url     → commentImage (custom; modal already accepts this)
//
// Replies and likes are passed in by the caller because they're hydrated
// from separate queries (replies pre-grouped from fetchCommentsForPost,
// likes from fetchCommentReactionCounts).
export const adaptSupabaseCommentToAppwriteShape = (row, { replies = [], likes = [], myReaction = null } = {}) => {
  if (!row) return null;
  const profile = row.profiles || {};
  const ownerId = profile.id || row.user_id;
  return {
    $id: row.id,
    $createdAt: row.created_at,
    $updatedAt: row.created_at,
    comment: row.body || "",
    commentImage: row.image_url || null,
    image_url: row.image_url || null,
    postId: row.post_id || null,
    videoId: row.video_id || null,
    commentOwner: {
      $id: ownerId,
      id: ownerId,
      username: profile.username || "Unknown",
      name: profile.username || "Unknown",
      avatar: profile.avatar_url || null,
      avatar_url: profile.avatar_url || null,
      is_guest: !!profile.is_guest,
      role: profile.role || "user",
    },
    // Reply detection — modal reads postComment.$id to find the parent.
    postComment: row.parent_id ? { $id: row.parent_id } : null,
    parent_id: row.parent_id || null,
    postCommentReplies: replies,
    postCommentLikes: likes,
    // The current user's reaction emoji (or null). PostCommentItem reads
    // this on Supabase posts to render the correct initial liked state
    // without an extra query — `_supabase` presence + `myReaction` are
    // enough to drive the picker UI.
    myReaction,
    // Keep the raw row available for any code path that wants it.
    _supabase: row,
  };
};

// Bulk-adapt a `{ parents, repliesByParent }` block (the shape returned
// by fetchCommentsForPost/Video) into a list of Appwrite-shaped parent
// comments with their replies pre-attached. This matches what mobile's
// PostCommentModal currently feeds into its FlatList.
//
// `myReactions` is a `{ [commentId]: emoji }` map (from
// reactions-supabase#getMyReactionsForTargets) — when provided, each
// adapted comment carries the current user's reaction emoji under
// `myReaction`, letting the modal render the correct "is mine" state
// without per-comment round trips.
export const adaptCommentTreeToAppwriteShape = ({ parents = [], repliesByParent = {} } = {}, { reactionCounts = {}, myReactions = {} } = {}) => {
  return parents.map((parent) => {
    const replyRows = repliesByParent[parent.id] || [];
    const adaptedReplies = replyRows.map((r) =>
      adaptSupabaseCommentToAppwriteShape(r, {
        replies: [],
        likes: reactionCounts[r.id] ? buildLikePlaceholders(reactionCounts[r.id].total) : [],
        myReaction: myReactions[r.id] || null,
      }),
    );
    return adaptSupabaseCommentToAppwriteShape(parent, {
      replies: adaptedReplies,
      likes: reactionCounts[parent.id] ? buildLikePlaceholders(reactionCounts[parent.id].total) : [],
      myReaction: myReactions[parent.id] || null,
    });
  });
};

// PostCommentModal counts likes by `postCommentLikes.length`, so we
// hand it length-only placeholder rows that satisfy that contract
// without dragging the full reactor list across the wire. The "is
// mine?" probe (web's likeOwner-id scan) doesn't work on placeholders;
// the adapter passes the user's emoji separately under `myReaction`,
// which PostCommentItem reads at mount and the modal's rerender effect
// preserves through the Supabase branch in C.7.
const buildLikePlaceholders = (count) => {
  if (!count) return [];
  return Array.from({ length: count }, (_, i) => ({ $id: `placeholder-${i}`, _placeholder: true }));
};
