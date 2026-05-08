// lib/communities.js — Selebox Community feature service layer
//
// Phase 1 (this file) — owner-side surface for the "Your Community"
// tab. Wraps the SQL RPCs in 2026-05-08_community_phase1.sql:
//
//   • get_my_community()           — fetch caller's owned community
//   • update_my_community(...)     — owner edit (name/description/support_bar/cover)
//   • get_community_feed(id, ...)  — paginated posts with author + i_liked
//   • subscribe_to_community(id)   — fan opt-in (used by other-user surface)
//   • unsubscribe_from_community(id)
//   • am_i_subscribed(id)          — boolean for Subscribe/Subscribed button state
//
// Direct table writes (likes, comments, posts) bypass an RPC since
// each is a single-statement insert/delete with RLS-enforced auth.
// Going through an RPC for these would just add ceremony.
//
// Caching strategy:
//   • In-memory module Map for the caller's own community — cleared
//     on update_my_community and on logout (parent-app code clears
//     all module caches on signOut).
//   • Feed pages are fetched live; the screen-level component caches
//     in MMKV for SWR if needed (see story-viewer SWR pattern).
//
// All functions return either a typed result object or throw — caller
// decides whether to surface the error or fall back. We log warnings
// for unexpected RPC error codes so they show up in Sentry/console
// without bubbling to UI.

import supabase from "./supabase";
import logger from "./utils/logger";

// ─────────────────────────────────────────────────────────────────────
// In-memory caches
// ─────────────────────────────────────────────────────────────────────

let _myCommunityCache = null; // { data, fetchedAt }
const MY_COMMUNITY_TTL_MS = 60 * 1000; // 1 min — light cache, edits invalidate

const _subscriptionStatusCache = new Map(); // communityId -> { value, fetchedAt }
const SUBSCRIPTION_STATUS_TTL_MS = 30 * 1000;

// First-page feed cache: communityId -> { documents, hasMore, nextCursor, fetchedAt }.
// Only the FIRST page (cursor=null) gets cached — subsequent pages are
// fetched live since they're cursor-driven and rarely re-rendered.
// Same purpose as the community cache: paint the existing list on
// re-entry instead of an empty FlatList while the fetch is in flight.
const _firstFeedPageCache = new Map();
const FEED_PAGE_TTL_MS = 60 * 1000; // 1 min — short, posts are write-heavy

export const invalidateMyCommunityCache = () => {
  _myCommunityCache = null;
};

// Synchronous cache peek — returns the cached community immediately
// (no awaits, no network) if the entry is still within TTL, otherwise
// null. Used by the (community) screen to seed initial state from a
// previous fetch and skip the skeleton-flash on re-entry.
//
// Without this, the screen's render order on every focus is:
//   useState(null) → render skeleton → useEffect → await getMyCommunity
//   → resolve from in-memory cache → setState → re-render with data.
// That single async hop is enough to flash the skeleton for one frame
// (~16ms on iOS, often 50-100ms on mid-tier Android). This getter
// hoists the cache hit to the synchronous initial-state computation
// so the cached community paints on the very first frame.
export const getCachedMyCommunity = () => {
  if (!_myCommunityCache) return null;
  const age = Date.now() - _myCommunityCache.fetchedAt;
  if (age >= MY_COMMUNITY_TTL_MS) return null;
  return _myCommunityCache.data;
};

export const invalidateSubscriptionCache = (communityId) => {
  if (communityId) _subscriptionStatusCache.delete(communityId);
  else _subscriptionStatusCache.clear();
};

export const invalidateFeedPageCache = (communityId) => {
  if (communityId) _firstFeedPageCache.delete(communityId);
  else _firstFeedPageCache.clear();
};

// Synchronous first-page peek. Returns the cached page immediately
// or null if cold/expired. Pairs with getCachedMyCommunity for the
// no-skeleton-on-re-entry pattern in app/(community)/index.jsx.
export const getCachedFirstFeedPage = (communityId) => {
  if (!communityId) return null;
  const entry = _firstFeedPageCache.get(communityId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt >= FEED_PAGE_TTL_MS) return null;
  return entry;
};

// ─────────────────────────────────────────────────────────────────────
// Owner-side: fetch / update community
// ─────────────────────────────────────────────────────────────────────

/**
 * Returns the calling user's owned community, or null if they don't have
 * one (regular user, not creator/writer). Throws on unexpected errors.
 *
 * Cached for 60s in-memory. Pass { force: true } to bypass.
 */
export const getMyCommunity = async ({ force = false } = {}) => {
  if (!force && _myCommunityCache) {
    const age = Date.now() - _myCommunityCache.fetchedAt;
    if (age < MY_COMMUNITY_TTL_MS) return _myCommunityCache.data;
  }

  const { data, error } = await supabase.rpc("get_my_community");
  if (error) {
    logger.warn("[communities] getMyCommunity RPC error", error.message);
    throw error;
  }

  // RPC returns SETOF — first row is the community, or empty.
  const community = Array.isArray(data) && data.length > 0 ? data[0] : null;
  _myCommunityCache = { data: community, fetchedAt: Date.now() };
  return community;
};

/**
 * Update the caller's own community. Pass only the fields you want to
 * change — null/undefined fields are preserved server-side.
 *
 * Server validates length (3-60 chars for name) and returns a
 * structured error in `data.error` for known failure modes. Throws on
 * unexpected RPC errors.
 *
 * Returns the updated community shape (post-update fetch). Caller
 * should call this AFTER user confirms in the rename sheet.
 */
export const updateMyCommunity = async ({ name, description, supportBar, coverImageUrl } = {}) => {
  const { data, error } = await supabase.rpc("update_my_community", {
    p_name: name ?? null,
    p_description: description ?? null,
    p_support_bar: supportBar ?? null,
    p_cover_image_url: coverImageUrl ?? null,
  });

  if (error) {
    logger.warn("[communities] updateMyCommunity RPC error", error.message);
    throw error;
  }

  if (!data?.ok) {
    // Surface friendly errors. data.error is the code; map to a thrown
    // Error so the caller's try/catch can branch on err.code.
    const friendly = _humanizeUpdateError(data?.error);
    const err = new Error(friendly);
    err.code = data?.error;
    err.context = data;
    throw err;
  }

  // Cache invalidation — next read will refetch.
  invalidateMyCommunityCache();
  // Return the freshly-fetched community so callers can update local state.
  return getMyCommunity({ force: true });
};

const _humanizeUpdateError = (code) => {
  switch (code) {
    case "not_authenticated":
      return "Sign in to update your community.";
    case "community_not_found":
      return "You don't have a community yet.";
    case "name_too_short":
      return "Community name must be at least 3 characters.";
    case "name_too_long":
      return "Community name must be 60 characters or fewer.";
    default:
      return "Couldn't update your community. Please try again.";
  }
};

// ─────────────────────────────────────────────────────────────────────
// Feed: paginated posts (cursor = created_at timestamp)
// ─────────────────────────────────────────────────────────────────────

/**
 * Fetch a page of community posts. Newer first; pinned posts always
 * surface at the top of every page (server-side ordering).
 *
 * @param communityId  uuid of the community
 * @param cursor       timestamptz string from the previous page's last
 *                     post.created_at (null for first page)
 * @param limit        page size, capped server-side at 50
 *
 * Returns { documents: [...], hasMore: boolean, nextCursor: string|null }
 */
export const getCommunityFeed = async ({ communityId, cursor = null, limit = 20 } = {}) => {
  if (!communityId) throw new Error("communityId required");

  const { data, error } = await supabase.rpc("get_community_feed", {
    p_community_id: communityId,
    p_cursor: cursor,
    p_limit: limit,
  });

  if (error) {
    logger.warn("[communities] getCommunityFeed RPC error", error.message);
    throw error;
  }

  const rows = Array.isArray(data) ? data : [];
  const last = rows.length > 0 ? rows[rows.length - 1] : null;
  const nextCursor = last && rows.length === limit ? last.created_at : null;

  const result = {
    documents: rows.map(_hydratePostRow),
    hasMore: rows.length === limit,
    nextCursor,
  };

  // Cache the FIRST page only. Subsequent pages are tail-only and
  // re-fetched live; only page 1 needs to paint instantly when the
  // user re-enters the screen.
  if (cursor === null) {
    _firstFeedPageCache.set(communityId, { ...result, fetchedAt: Date.now() });
  }

  return result;
};

// Shape the RPC row into something the UI can consume directly.
// Keeps the RPC server-friendly (flat columns) while giving the card
// a nested `author` object like the rest of the app expects.
const _hydratePostRow = (row) => ({
  $id: row.id,
  id: row.id,
  community_id: row.community_id,
  author_id: row.author_id,
  body: row.body,
  image_urls: row.image_urls || [],
  visibility: row.visibility,
  is_pinned: row.is_pinned,
  likes_count: row.likes_count,
  comments_count: row.comments_count,
  i_liked: row.i_liked,
  // The caller's current reaction key on this post (heart|laugh|sad|
  // cry|angry) or null if they haven't reacted. PostCard uses this to
  // decide which emoji to highlight on the like button.
  my_reaction: row.my_reaction || null,
  created_at: row.created_at,
  $createdAt: row.created_at,
  author: {
    $id: row.author_id,
    id: row.author_id,
    username: row.author_username,
    avatar: row.author_avatar,
    avatar_url: row.author_avatar,
  },
});

// ─────────────────────────────────────────────────────────────────────
// Posts: create / delete (owner only — RLS enforces)
// ─────────────────────────────────────────────────────────────────────

/**
 * Create a community post. Owner-only — RLS rejects writes by anyone
 * else with a 403/permission error.
 *
 * @param communityId  uuid
 * @param body         text (optional if image_urls is non-empty)
 * @param imageUrls    array of public image URLs (Bunny CDN typical)
 */
export const createCommunityPost = async ({ communityId, body, imageUrls = [] } = {}) => {
  if (!communityId) throw new Error("communityId required");
  if ((!body || !body.trim()) && (!imageUrls || imageUrls.length === 0)) {
    throw new Error("Post must have text or at least one image.");
  }

  const { data: { user: authUser } = {} } = await supabase.auth.getUser();
  if (!authUser) throw new Error("Sign in to post.");

  const { data, error } = await supabase
    .from("community_posts")
    .insert({
      community_id: communityId,
      author_id: authUser.id,
      body: body?.trim() || null,
      image_urls: imageUrls,
    })
    .select("*")
    .single();

  if (error) {
    logger.warn("[communities] createCommunityPost error", error.message);
    throw error;
  }
  // Invalidate the cached first feed page so the next read picks up
  // this insert (the screen does optimistic prepend, but a cold
  // re-entry within TTL would otherwise miss the new post).
  invalidateFeedPageCache(communityId);
  return data;
};

/** Delete a post — owner of the community only (RLS enforced). */
export const deleteCommunityPost = async (postId) => {
  if (!postId) throw new Error("postId required");
  const { error } = await supabase.from("community_posts").delete().eq("id", postId);
  if (error) {
    logger.warn("[communities] deleteCommunityPost error", error.message);
    throw error;
  }
  // Conservative wipe — we don't know which community this post
  // belonged to without an extra round-trip. Clearing all entries
  // is cheap (Map clear) and the worst case is one extra fetch.
  invalidateFeedPageCache();
};

// ─────────────────────────────────────────────────────────────────────
// Reactions (FB-style: heart, laugh, sad, cry, angry)
// ─────────────────────────────────────────────────────────────────────
//
// Phase 1 shipped binary likes (insert-row=liked, delete-row=unliked).
// Phase 1.1 (this file) layers a `reaction_type` column on top of the
// same `community_post_likes` table — see the
// 2026-05-08_community_reactions.sql migration. The keys mirror
// lib/reactions.js:
//   heart | laugh | sad | cry | angry
//
// We use the SECURITY DEFINER RPCs `react_to_community_post` /
// `unreact_from_community_post` so the swap-reaction case (heart →
// laugh in one tap) is a single round-trip with proper UPSERT, not a
// DELETE + INSERT race.

const VALID_REACTIONS = new Set(["heart", "laugh", "sad", "cry", "angry"]);

/**
 * Set the caller's reaction on a community post. Upsert semantics:
 *   • No existing reaction → inserts a new row, likes_count++.
 *   • Existing reaction (any key) → updates reaction_type in place,
 *     likes_count stays the same.
 *
 * @param postId       uuid of the community_posts row
 * @param reactionKey  one of: heart, laugh, sad, cry, angry
 *                     (defaults to 'heart' for the simple-tap case)
 */
export const reactToCommunityPost = async (postId, reactionKey = "heart") => {
  if (!postId) throw new Error("postId required");
  if (!VALID_REACTIONS.has(reactionKey)) {
    throw new Error(`Invalid reaction "${reactionKey}"`);
  }

  const { data, error } = await supabase.rpc("react_to_community_post", {
    p_post_id: postId,
    p_reaction_type: reactionKey,
  });

  if (error) {
    logger.warn("[communities] reactToCommunityPost RPC error", error.message);
    throw error;
  }
  if (!data?.ok) {
    const err = new Error(data?.error || "react_failed");
    err.code = data?.error;
    throw err;
  }
  return data; // { ok: true, reaction: <key> }
};

/**
 * Clear the caller's reaction on a post (idempotent — returns ok even
 * if there was nothing to delete).
 */
export const unreactFromCommunityPost = async (postId) => {
  if (!postId) throw new Error("postId required");

  const { data, error } = await supabase.rpc("unreact_from_community_post", {
    p_post_id: postId,
  });

  if (error) {
    logger.warn("[communities] unreactFromCommunityPost RPC error", error.message);
    throw error;
  }
  return data; // { ok: true }
};

// ─────────────────────────────────────────────────────────────────────
// Backward-compat aliases
// ─────────────────────────────────────────────────────────────────────
//
// The PostCard used to call likeCommunityPost / unlikeCommunityPost
// (binary). Those names are kept for any caller that hasn't migrated;
// they delegate to the new reaction RPCs with the default 'heart' key
// so existing surfaces still produce a sensible row in the new
// reaction-aware schema.
export const likeCommunityPost = (postId) => reactToCommunityPost(postId, "heart");
export const unlikeCommunityPost = (postId) => unreactFromCommunityPost(postId);

// ─────────────────────────────────────────────────────────────────────
// Comments
// ─────────────────────────────────────────────────────────────────────

/**
 * Fetch comments for a post (newest first). For Phase 1 we don't
 * paginate — comment count is typically <50 per post. We can add
 * pagination when a viral post crosses 100+ comments.
 */
export const getCommunityPostComments = async (postId) => {
  if (!postId) throw new Error("postId required");

  const { data, error } = await supabase
    .from("community_post_comments")
    .select(`
      id, post_id, user_id, body, parent_id, created_at,
      author:profiles!community_post_comments_user_id_fkey(id, username, avatar_url)
    `)
    .eq("post_id", postId)
    .order("created_at", { ascending: false });

  if (error) {
    logger.warn("[communities] getCommunityPostComments error", error.message);
    throw error;
  }
  return data || [];
};

export const createCommunityPostComment = async ({ postId, body, parentId = null } = {}) => {
  if (!postId) throw new Error("postId required");
  if (!body || !body.trim()) throw new Error("Comment is empty.");

  const { data: { user: authUser } = {} } = await supabase.auth.getUser();
  if (!authUser) throw new Error("Sign in to comment.");

  const { data, error } = await supabase
    .from("community_post_comments")
    .insert({
      post_id: postId,
      user_id: authUser.id,
      body: body.trim(),
      parent_id: parentId,
    })
    .select(`
      id, post_id, user_id, body, parent_id, created_at,
      author:profiles!community_post_comments_user_id_fkey(id, username, avatar_url)
    `)
    .single();

  if (error) {
    logger.warn("[communities] createCommunityPostComment error", error.message);
    throw error;
  }
  return data;
};

export const deleteCommunityPostComment = async (commentId) => {
  if (!commentId) throw new Error("commentId required");
  const { error } = await supabase.from("community_post_comments").delete().eq("id", commentId);
  if (error) {
    logger.warn("[communities] deleteCommunityPostComment error", error.message);
    throw error;
  }
};

// ─────────────────────────────────────────────────────────────────────
// Subscriptions (fan-side — used by Visit Community / other-user surfaces)
// ─────────────────────────────────────────────────────────────────────

export const subscribeToCommunity = async (communityId) => {
  if (!communityId) throw new Error("communityId required");
  const { data, error } = await supabase.rpc("subscribe_to_community", {
    p_community_id: communityId,
  });
  if (error) {
    logger.warn("[communities] subscribeToCommunity RPC error", error.message);
    throw error;
  }
  if (!data?.ok) {
    const err = new Error(data?.error || "Couldn't subscribe.");
    err.code = data?.error;
    throw err;
  }
  invalidateSubscriptionCache(communityId);
  return data;
};

export const unsubscribeFromCommunity = async (communityId) => {
  if (!communityId) throw new Error("communityId required");
  const { data, error } = await supabase.rpc("unsubscribe_from_community", {
    p_community_id: communityId,
  });
  if (error) {
    logger.warn("[communities] unsubscribeFromCommunity RPC error", error.message);
    throw error;
  }
  invalidateSubscriptionCache(communityId);
  return data;
};

export const amISubscribed = async (communityId, { force = false } = {}) => {
  if (!communityId) return false;

  if (!force) {
    const cached = _subscriptionStatusCache.get(communityId);
    if (cached && Date.now() - cached.fetchedAt < SUBSCRIPTION_STATUS_TTL_MS) {
      return cached.value;
    }
  }

  const { data, error } = await supabase.rpc("am_i_subscribed", {
    p_community_id: communityId,
  });
  if (error) {
    logger.warn("[communities] amISubscribed RPC error", error.message);
    return false;
  }
  const value = !!data;
  _subscriptionStatusCache.set(communityId, { value, fetchedAt: Date.now() });
  return value;
};

// ─────────────────────────────────────────────────────────────────────
// Convenience exports
// ─────────────────────────────────────────────────────────────────────

export default {
  getMyCommunity,
  getCachedMyCommunity,
  updateMyCommunity,
  invalidateMyCommunityCache,
  getCommunityFeed,
  getCachedFirstFeedPage,
  invalidateFeedPageCache,
  createCommunityPost,
  deleteCommunityPost,
  reactToCommunityPost,
  unreactFromCommunityPost,
  likeCommunityPost,
  unlikeCommunityPost,
  getCommunityPostComments,
  createCommunityPostComment,
  deleteCommunityPostComment,
  subscribeToCommunity,
  unsubscribeFromCommunity,
  amISubscribed,
  invalidateSubscriptionCache,
};
