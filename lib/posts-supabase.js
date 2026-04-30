// Supabase posts service — Phase C.1–C.10 of the Appwrite → Supabase
// migration. This is the only post-data path mobile uses when
// USE_SUPABASE_POSTS is on (the production default).
//
// What this exposes:
//   - fetchFeedPage / fetchFollowingFeedPage / fetchPostsByUser — feed
//     reads with original-post expansion via relational join
//   - fetchPostById — single-post lookup (used by RepostModal hydrate)
//   - fetchPostStats — batched like + comment counts for many posts
//   - createPost / createRepost / deletePostById — writes
//   - adaptSupabasePostToAppwriteShape — dual-shape adapter so PostCard /
//     PostInformation / PostCommentModal don't have to fork their UI
//   - resolveSupabasePostId — forward-resolves Appwrite legacy ids
//     (used by RepostModal when reposting an Appwrite-shape post that
//     came in via the legacy Following / For-You fallback paths)
//
// Likes wiring lives in `lib/reactions-supabase.js`; comments wiring in
// `lib/comments-supabase.js`. fetchPostStats here just rolls up counts.
//
// Schema (from web migration tool + Selebox/app.js queries):
//   posts
//     - id (uuid, PK)
//     - user_id (uuid → profiles.id)
//     - body (text)
//     - image_url (text, nullable)
//     - video_id (uuid → videos.id, nullable)
//     - book_id (uuid → books.id, nullable)
//     - reposted_from (uuid → posts.id, nullable) — THIS is the repost link
//     - is_hidden (bool)
//     - created_at (timestamptz)
//     - legacy_appwrite_id (text, nullable) — populated by the migration tool
//
// Relational join trick (matches web exactly):
//   `original:reposted_from(*, profiles!user_id(...), videos(...))`
//   When `reposted_from` points at another post, Supabase resolves the
//   relationship and embeds the original post (including its author + any
//   attached video) under `original`. This is what lets PostCard render
//   the dual-section "Reposted" layout in one query, no separate fetch.

import supabase from "./supabase";

// Same SELECT shape the web uses. Keeping it as a constant so all read
// paths return identically-shaped rows — easier to tweak the join in one
// place if the schema ever evolves.
const POST_SELECT = `*,
  profiles!user_id(id, username, avatar_url, is_guest, role),
  videos(id, video_url, thumbnail_url, title, duration),
  original:reposted_from(*,
    profiles!user_id(id, username, avatar_url, is_guest, role),
    videos(id, video_url, thumbnail_url, title, duration)
  )`;

const requireUser = async () => {
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error) throw error;
  if (!user) throw new Error("Not signed in");
  return user;
};

// ─────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────

// Fetches one page of the global feed. `before` is a cursor — pass a
// post's `created_at` to get older posts. Empty `before` returns the
// most recent N. Posts where `is_hidden` is true (admin-hidden or under
// review) are filtered server-side via RLS on the web project; we apply
// the same filter here to be safe.
export const fetchFeedPage = async ({ limit = 20, before } = {}) => {
  let query = supabase.from("posts").select(POST_SELECT).eq("is_hidden", false).order("created_at", { ascending: false }).limit(limit);
  if (before) query = query.lt("created_at", before);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
};

// Fetches a "Following" feed — posts authored by anyone the given user
// follows, newest first. Implements the read in two passes:
//   1. SELECT following_id FROM follows WHERE follower_id = userId
//   2. SELECT posts WHERE user_id IN (those ids) AND is_hidden = false
// Same SELECT shape as fetchFeedPage so callers can reuse the adapter.
// `before` is the cursor (an ISO timestamp from a previous page's
// oldest post.created_at). Returns an empty array if the viewer
// follows nobody.
//
// Phase C.8 — this is what unlocks the Following tab on Supabase posts
// for cross-platform parity. Web doesn't expose a separate "Following
// feed" today (single global feed), but the schema supports it and
// mobile's UX needs it.
export const fetchFollowingFeedPage = async ({ userId, limit = 20, before } = {}) => {
  if (!userId) return [];
  // Cap follows lookup at 1000 — most users follow well under 200
  // accounts, but this keeps the IN-clause from blowing up if some
  // power user follows everyone.
  const { data: follows, error: followsErr } = await supabase.from("follows").select("following_id").eq("follower_id", userId).limit(1000);
  if (followsErr) throw followsErr;
  const followedIds = (follows || []).map((f) => f.following_id).filter(Boolean);
  if (!followedIds.length) return [];

  let query = supabase
    .from("posts")
    .select(POST_SELECT)
    .in("user_id", followedIds)
    .eq("is_hidden", false)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (before) query = query.lt("created_at", before);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
};

// Fetches posts authored by a specific user. Wired into ProfilePostTab
// in C.9; the feed there pages by `before` (oldest created_at) cursor.
// Same SELECT shape as the global feed for consistency.
export const fetchPostsByUser = async ({ userId, limit = 40, before } = {}) => {
  if (!userId) return [];
  let query = supabase
    .from("posts")
    .select(POST_SELECT)
    .eq("user_id", userId)
    .eq("is_hidden", false)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (before) query = query.lt("created_at", before);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
};

// Fetches a single post (with original expansion). Used by RepostModal
// to re-hydrate the original post preview if the caller didn't already
// pass the full post object — defensive for cases where we have only the
// id (e.g., from a deep link).
export const fetchPostById = async (postId) => {
  if (!postId) return null;
  const { data, error } = await supabase.from("posts").select(POST_SELECT).eq("id", postId).maybeSingle();
  if (error) throw error;
  return data || null;
};

// Batched stats fetcher — given an array of post ids, returns a map of
// { [postId]: { likeCount, commentCount } }. Two queries fired in
// parallel (instead of sequentially), rolled up client-side. Replaces
// 2 × N per-post roundtrips with one round trip per stat type.
export const fetchPostStats = async (postIds = []) => {
  if (!postIds?.length) return {};
  const stats = {};
  for (const id of postIds) stats[id] = { likeCount: 0, commentCount: 0 };

  const [reactionsResult, commentsResult] = await Promise.all([
    // Reactions on posts (target_type='post' + target_id IN postIds).
    supabase.from("reactions").select("target_id").eq("target_type", "post").in("target_id", postIds),
    // Comments on posts (post_id IN postIds, deleted_at null).
    supabase.from("comments").select("post_id").in("post_id", postIds).is("deleted_at", null),
  ]);

  if (reactionsResult.error) {
    console.log("[posts-supabase] fetchPostStats reactions error:", reactionsResult.error.message);
  } else {
    for (const r of reactionsResult.data || []) {
      if (stats[r.target_id]) stats[r.target_id].likeCount += 1;
    }
  }

  if (commentsResult.error) {
    console.log("[posts-supabase] fetchPostStats comments error:", commentsResult.error.message);
  } else {
    for (const c of commentsResult.data || []) {
      if (stats[c.post_id]) stats[c.post_id].commentCount += 1;
    }
  }

  return stats;
};

// ─────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────

// Creates a fresh post (not a repost). `body` is the text, `imageUrl` is
// optional — image upload happens elsewhere (Bunny CDN today, possibly
// Supabase Storage later). Returns the inserted row with the same SELECT
// shape so callers can render it immediately.
export const createPost = async ({ body, imageUrl = null, videoId = null, bookId = null } = {}) => {
  const me = await requireUser();
  const trimmed = (body || "").trim();
  if (!trimmed && !imageUrl && !videoId && !bookId) {
    throw new Error("Empty post — needs at least body, image, video, or book");
  }
  const { data, error } = await supabase
    .from("posts")
    .insert({
      user_id: me.id,
      body: trimmed,
      image_url: imageUrl,
      video_id: videoId,
      book_id: bookId,
    })
    .select(POST_SELECT)
    .single();
  if (error) throw error;
  return data;
};

// Creates a repost — a new post pointing at the original via
// `reposted_from`. `caption` is the optional comment the reposter adds
// (web allows empty captions, so we don't enforce non-empty here).
//
// `originalPostId` must be a Supabase posts.id (uuid). Callers that
// might still be holding Appwrite `$id`s (the rare Following / For-You
// fallback paths when USE_SUPABASE_POSTS is off) should run the id
// through `resolveSupabasePostId` first; RepostModal does this.
export const createRepost = async ({ originalPostId, caption = "" }) => {
  if (!originalPostId) throw new Error("originalPostId is required");
  const me = await requireUser();
  const { data, error } = await supabase
    .from("posts")
    .insert({
      user_id: me.id,
      body: (caption || "").trim(),
      reposted_from: originalPostId,
    })
    .select(POST_SELECT)
    .single();
  if (error) throw error;
  return data;
};

// Hard-deletes a post. RLS enforces that only the author can delete their
// own post (set up on the web project's policies). No soft-delete here
// because the web doesn't soft-delete either — the post just disappears.
export const deletePostById = async (postId) => {
  if (!postId) throw new Error("postId is required");
  const { error } = await supabase.from("posts").delete().eq("id", postId);
  if (error) throw error;
};

// Adapts a Supabase post row to the Appwrite-shaped object the existing
// home feed components (PostCard + PostInformation) expect. The dual-shape
// pattern is the same one we used for users in supabase-auth.js:
// re-exporting Supabase columns under their legacy aliases means downstream
// consumers don't have to change.
//
// Mapping:
//   id              → $id
//   created_at      → $createdAt
//   body            → post
//   image_url       → postUrls (array of one)
//   profiles        → postOwner (with $id, username, avatar)
//   reposted_from   → reposted_from (kept for PostCard's repost detection)
//   original        → original (already Supabase-shaped; PostCard reads it
//                      directly using Supabase column names)
//
// Counts (postLikes, postComments) come from a separate fetchPostStats call
// because Supabase doesn't denormalize them onto the post row.
export const adaptSupabasePostToAppwriteShape = (post, stats = {}) => {
  if (!post) return null;
  const ownerProfile = post.profiles || {};
  const postId = post.id;
  const postStat = stats[postId] || { likeCount: 0, commentCount: 0 };
  return {
    // Legacy Appwrite-shaped fields
    $id: postId,
    $createdAt: post.created_at,
    $updatedAt: post.created_at,
    post: post.body || "",
    postUrls: post.image_url ? [post.image_url] : [],
    postOwner: {
      $id: ownerProfile.id || post.user_id,
      id: ownerProfile.id || post.user_id,
      username: ownerProfile.username || "Unknown",
      name: ownerProfile.username || "Unknown",
      avatar: ownerProfile.avatar_url || null,
      avatar_url: ownerProfile.avatar_url || null,
      role: ownerProfile.role || "user",
    },
    postLikes: postStat.likeCount || 0,
    postComments: postStat.commentCount || 0,
    // Supabase-native fields PostCard's repost render path reads directly
    reposted_from: post.reposted_from || null,
    original: post.original || null,
    // Keep the raw Supabase row in case any downstream consumer needs it
    _supabase: post,
  };
};

// Resolves whatever ID shape we have to a Supabase posts.id UUID.
// When USE_SUPABASE_POSTS is on, the home feed already deals in
// Supabase UUIDs; this helper exists for the rare path where a caller
// is still holding an Appwrite-shape `$id` (e.g., the Following /
// For-You tabs when the flag is off). The migration tool stamped each
// Supabase post with `legacy_appwrite_id` matching its source Appwrite
// document, so we can forward-resolve.
//
// Returns the Supabase UUID, or null if no row was found by either lookup.
// UUIDs are 36 chars with dashes; Appwrite IDs are 20-24 hex chars without.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const resolveSupabasePostId = async (rawId) => {
  if (!rawId) return null;
  // Already a UUID — return as-is.
  if (UUID_REGEX.test(rawId)) return rawId;
  // Looks like an Appwrite legacy id. Look up the Supabase row that
  // carries this id in the migration's mirror column.
  const { data, error } = await supabase.from("posts").select("id").eq("legacy_appwrite_id", rawId).maybeSingle();
  if (error) {
    console.log("[posts-supabase] resolveSupabasePostId error:", error.message);
    return null;
  }
  return data?.id || null;
};
