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

import { getMessagesUserId } from "./messages-supabase";
import supabase from "./supabase";
import { expandProfileRoleFlags } from "./user-roles";

// Same SELECT shape the web uses. Keeping it as a constant so all read
// paths return identically-shaped rows — easier to tweak the join in one
// place if the schema ever evolves.
//
// `legacy_appwrite_id` is included on every joined profile so the
// adapter can expose it on `postOwner` and the legacy creator-profile
// screen (which still hits Appwrite for users + videos) can navigate
// to the right document. Without this, tapping a reposter / commenter
// avatar with a UUID-only postOwner.$id leaves the screen stuck on
// skeleton because Appwrite can't resolve a UUID to its users
// collection.
const POST_SELECT = `*,
  profiles!user_id(id, username, avatar_url, is_guest, is_banned, role, legacy_appwrite_id),
  videos(id, video_url, thumbnail_url, title, duration),
  original:reposted_from(*,
    profiles!user_id(id, username, avatar_url, is_guest, is_banned, role, legacy_appwrite_id),
    videos(id, video_url, thumbnail_url, title, duration)
  )`;

// Defensive requireUser:
//   1. Prefer the chat lib's resolved Appwrite→Supabase id (works for the
//      current Appwrite-auth path where there's no Supabase session).
//   2. Fall back to `supabase.auth.getUser()` for Supabase-auth users.
//   3. Never throw the raw `AuthSessionMissingError` from Supabase —
//      that surfaces as a red toast in dev. Throw a clean "Not signed
//      in" Error instead so callers can show a proper UI message.
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
// User-side content filters — block / hide / snooze / banned-author.
//
// Web's loadFeed calls shouldHidePost(post) on every row to suppress:
//   - posts whose author has profiles.is_banned = true
//   - posts the viewer hid via post_hides
//   - posts whose author the viewer snoozed (active, not expired)
//   - posts whose author the viewer blocked
//
// Mobile previously did this via Appwrite tables (userBlocksCollection +
// userHiddenContentCollection) — but the IDs in those tables are
// Appwrite hex strings, while a Supabase post.user_id is a UUID. The
// .has() check never matched, so blocks silently weren't applied to
// the home feed. This module now reads filter state from Supabase
// directly, matching web. Once the dual-write + backfill are live
// (steps B + C), mobile blocks/hides also persist to Supabase, and
// every surface — mobile, web, future admin — sees the same state.
//
// Cache: filters change rarely. We hold a single in-memory snapshot
// per signed-in user, refreshed on:
//   - explicit `refreshUserContentFilters()` call (after a block/
//     unblock/hide write)
//   - first call after a sign-in change (detected by user-id mismatch)
// Sign-out clears via `resetUserIdResolveCache` already called from
// global-provider.
let __filtersForUserId = null;
let __filters = {
  hiddenPostIds: new Set(),
  snoozedUserIds: new Set(),
  blockedUserIds: new Set(),
};

// Loads the filter state for the given Supabase UUID. Pass null/undefined
// to clear (signed-out path). Idempotent — re-running for the same userId
// just refreshes the snapshot.
//
// Called eagerly at the top of every fetch* function (cheap when cached).
export const loadUserContentFilters = async (userId) => {
  if (!userId) {
    __filtersForUserId = null;
    __filters = {
      hiddenPostIds: new Set(),
      snoozedUserIds: new Set(),
      blockedUserIds: new Set(),
    };
    return __filters;
  }

  // Same-user cache hit — skip the network round-trip.
  if (__filtersForUserId === userId) return __filters;

  try {
    const nowIso = new Date().toISOString();
    const [hides, snoozes, blocks] = await Promise.all([
      supabase.from("post_hides").select("post_id").eq("user_id", userId),
      supabase
        .from("user_snoozes")
        .select("target_user_id")
        .eq("user_id", userId)
        .gt("expires_at", nowIso),
      supabase.from("user_blocks").select("blocked_user_id").eq("user_id", userId),
    ]);
    __filters = {
      hiddenPostIds: new Set((hides.data || []).map((r) => r.post_id)),
      snoozedUserIds: new Set((snoozes.data || []).map((r) => r.target_user_id)),
      blockedUserIds: new Set((blocks.data || []).map((r) => r.blocked_user_id)),
    };
    __filtersForUserId = userId;
  } catch (e) {
    // Tables might be absent on a fresh dev DB — log but don't throw.
    // Returning the previous snapshot is safer than crashing the feed.
    console.log(
      "[posts-supabase] loadUserContentFilters failed (likely missing migration_post_actions.sql):",
      e?.message,
    );
  }
  return __filters;
};

// Force a refresh of the filter cache — call after a block/unblock/hide
// write so the next fetch sees the new state without waiting for sign-in.
export const refreshUserContentFilters = async (userId) => {
  __filtersForUserId = null;
  return loadUserContentFilters(userId);
};

// Pure predicate. Returns true if the post should be hidden from the
// current viewer based on the cached filter set + the post's joined
// profile.is_banned flag. Mirrors web's shouldHidePost(post) line-for-line
// so the cross-platform behavior is identical.
//
// Caller must have run `loadUserContentFilters(userId)` (or another
// fetch path that ran it for them) — otherwise the cache is empty and
// the filter is a no-op rather than a false positive.
export const shouldHidePost = (post) => {
  if (!post) return false;
  if (post.profiles?.is_banned) return true;
  if (__filters.hiddenPostIds.has(post.id)) return true;
  if (post.user_id && __filters.snoozedUserIds.has(post.user_id)) return true;
  if (post.user_id && __filters.blockedUserIds.has(post.user_id)) return true;
  return false;
};

// Decides how many rows to ask the server for given a logical page
// size. We over-fetch only when the viewer has at least one filter
// entry — otherwise nothing will be dropped client-side and the
// over-fetch is wasted bandwidth. The 1.5× cushion compensates for
// dropped rows so a page rarely comes back short.
const _filterPageSize = (logicalLimit) => {
  const hasFilters =
    __filters.hiddenPostIds.size > 0 ||
    __filters.snoozedUserIds.size > 0 ||
    __filters.blockedUserIds.size > 0;
  return hasFilters ? Math.ceil(logicalLimit * 1.5) : logicalLimit;
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
  // Filter cache is populated by home.jsx's safety effect on user-id
  // change; we just consume it here. shouldHidePost is a no-op when the
  // cache is empty (clean degrade for callers that never warmed it).
  const fetchLimit = _filterPageSize(limit);
  let query = supabase
    .from("posts")
    .select(POST_SELECT)
    .eq("is_hidden", false)
    .order("created_at", { ascending: false })
    .limit(fetchLimit);
  if (before) query = query.lt("created_at", before);
  const { data, error } = await query;
  if (error) throw error;
  const filtered = (data || []).filter((p) => !shouldHidePost(p));
  return filtered.slice(0, limit);
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
  // Resolve to Supabase UUID — `follows.follower_id` is UUID, so an
  // Appwrite-shape id from mobile's legacy auth would never match.
  const resolvedUserId = await resolveSupabaseUserId(userId);
  if (!resolvedUserId) return [];
  // Load the viewer's filter snapshot before paginating so the
  // shouldHidePost pass has fresh state.
  await loadUserContentFilters(resolvedUserId);
  // Cap follows lookup at 1000 — most users follow well under 200
  // accounts, but this keeps the IN-clause from blowing up if some
  // power user follows everyone.
  const { data: follows, error: followsErr } = await supabase.from("follows").select("following_id").eq("follower_id", resolvedUserId).limit(1000);
  if (followsErr) throw followsErr;
  const followedIds = (follows || []).map((f) => f.following_id).filter(Boolean);
  if (!followedIds.length) return [];

  const fetchLimit = _filterPageSize(limit);
  let query = supabase
    .from("posts")
    .select(POST_SELECT)
    .in("user_id", followedIds)
    .eq("is_hidden", false)
    .order("created_at", { ascending: false })
    .limit(fetchLimit);
  if (before) query = query.lt("created_at", before);
  const { data, error } = await query;
  if (error) throw error;
  const filtered = (data || []).filter((p) => !shouldHidePost(p));
  return filtered.slice(0, limit);
};

// ─────────────────────────────────────────────────────────────────────────
// For You + Discover — algorithmic feeds backed by Postgres RPCs
// ─────────────────────────────────────────────────────────────────────────
// Both feeds rank posts via SQL functions defined in
// migration_feed_algorithm.sql:
//   feed_for_you(p_user_id, p_limit, p_offset)   — personalized
//   feed_discover(p_user_id, p_limit, p_offset)  — trending, hard-excludes
//                                                  followed creators
//
// Both use offset pagination (not created_at cursor) because the score is
// not monotonic with time — a high-scoring older post may sit between two
// newer ones, so a created_at cursor would skip rows. The RPCs return
// `setof posts` (just the row, no joins). We follow up with a single
// SELECT POST_SELECT to hydrate profiles/videos/original — the same shape
// every other reader returns — and reorder client-side to preserve the
// score ordering the RPC produced.

// Internal helper: runs an RPC that returns a list of post ids in score
// order, then hydrates them through the standard POST_SELECT join shape.
// Returns rows in the RPC's order, with user-side content filters applied.
//
// The RPC already excludes some classes of "hidden" content via the SQL
// (admin is_hidden + RLS), but it doesn't know about per-viewer blocks /
// hides / snoozes / banned authors — that's intentional, the algorithm
// stays generic and the filter is a viewer-side concern.
const _hydrateRankedPosts = async (rpcResult) => {
  const ranked = rpcResult || [];
  const orderedIds = ranked.map((r) => r.id).filter(Boolean);
  if (!orderedIds.length) return [];
  const { data, error } = await supabase.from("posts").select(POST_SELECT).in("id", orderedIds);
  if (error) throw error;
  // Re-establish the RPC's ordering — the IN-clause query returns rows
  // in arbitrary order, but the algorithm's ordering is the whole point.
  const byId = new Map((data || []).map((p) => [p.id, p]));
  const ordered = orderedIds.map((id) => byId.get(id)).filter(Boolean);
  return ordered.filter((p) => !shouldHidePost(p));
};

// ─────────────────────────────────────────────────────────────────────────
// Facebook-pattern feed delta. Called by the "↑ N new posts" pill + by
// pull-to-refresh. Returns posts created strictly after `sinceTimestamp`
// in chronological order desc. Cheap: single index hit on
// posts(created_at desc), filtered server-side by user_blocks /
// user_snoozes via the feed_new_since RPC.
//
// This replaces the old "pull to refresh re-runs the entire feed_for_you
// ranker" pattern. Now refresh is additive — the existing feed stays put
// and new posts are prepended. The expensive personalized ranker only
// runs on initial load + occasional background re-rank.
// ─────────────────────────────────────────────────────────────────────────
export const fetchFeedDelta = async ({ userId, sinceTimestamp, limit = 30 } = {}) => {
  if (!userId || !sinceTimestamp) return [];
  const resolvedUserId = await resolveSupabaseUserId(userId);
  if (!resolvedUserId) return [];
  // Make sure the filter cache is warm so shouldHidePost can drop hidden
  // posts client-side. user_blocks / user_snoozes are filtered by the
  // RPC server-side, but post_hides is the small client-side list.
  await loadUserContentFilters(resolvedUserId);
  const { data, error } = await supabase.rpc("feed_new_since", {
    p_user_id: resolvedUserId,
    p_since: sinceTimestamp,
    p_limit: limit,
  });
  if (error) {
    console.log("[posts-supabase] fetchFeedDelta error:", error.message);
    return [];
  }
  // The RPC returns bare `setof public.posts` rows — no profiles / videos
  // joins. Without hydration, the renderer falls back to "Unknown" +
  // empty avatar. Re-fetch through POST_SELECT to attach the joined
  // author + media data, then dedup against the viewer's filter set.
  const ids = (data || []).map((p) => p?.id).filter(Boolean);
  if (!ids.length) return [];
  const { data: hydrated, error: hydErr } = await supabase
    .from("posts")
    .select(POST_SELECT)
    .in("id", ids);
  if (hydErr) {
    console.log("[posts-supabase] fetchFeedDelta hydrate error:", hydErr.message);
    return [];
  }
  // Re-establish the RPC's chronological order — IN-clause returns rows
  // in arbitrary order, but the timeline ordering is the whole point.
  const byId = new Map((hydrated || []).map((p) => [p.id, p]));
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
  return ordered.filter((p) => !shouldHidePost(p));
};


// For You — algorithmic, personalized to the viewer.
// `offset` is the page index in posts (0, 20, 40, ...). Resolves the
// viewer id through legacy_appwrite_id so the Appwrite-shape id from
// global-provider still finds the right interest profile.
export const fetchForYouFeedPage = async ({ userId, limit = 20, offset = 0 } = {}) => {
  if (!userId) return [];
  const resolvedUserId = await resolveSupabaseUserId(userId);
  if (!resolvedUserId) return [];
  // Load filter snapshot before hydrating so _hydrateRankedPosts can
  // drop blocked/snoozed/hidden/banned rows.
  await loadUserContentFilters(resolvedUserId);
  const { data, error } = await supabase.rpc("feed_for_you", {
    p_user_id: resolvedUserId,
    p_limit: limit,
    p_offset: offset,
  });
  if (error) throw error;
  return _hydrateRankedPosts(data);
};

// Discover — trending velocity, hard-excludes followed creators, boosts
// new creators (< 100 followers). Same offset pagination as For You.
export const fetchDiscoverFeedPage = async ({ userId, limit = 20, offset = 0 } = {}) => {
  if (!userId) return [];
  const resolvedUserId = await resolveSupabaseUserId(userId);
  if (!resolvedUserId) return [];
  await loadUserContentFilters(resolvedUserId);
  const { data, error } = await supabase.rpc("feed_discover", {
    p_user_id: resolvedUserId,
    p_limit: limit,
    p_offset: offset,
  });
  if (error) throw error;
  return _hydrateRankedPosts(data);
};

// trackPostViews — record posts the viewer scrolled past so feed_for_you
// can dedupe them on next refresh ("always fresh" feed UX). Intended to
// be called from the feed's FlashList onViewableItemsChanged with the
// post IDs that just entered the viewport.
//
// Idempotent server-side (post_views composite PK on user_id+post_id +
// upsert), so calling with the same IDs twice is cheap. Failures are
// swallowed because view tracking is best-effort — losing a write just
// means the user might see one duplicate post. Never block the UI on
// this call.
export const trackPostViews = async ({ userId, postIds = [] } = {}) => {
  if (!userId || !Array.isArray(postIds) || postIds.length === 0) return;
  // Filter out anything that's not a UUID (Appwrite-shape post IDs from
  // legacy code paths) — track_post_views RPC requires uuid[].
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const validIds = postIds.filter((id) => typeof id === "string" && UUID_RE.test(id));
  if (validIds.length === 0) return;

  const resolvedUserId = await resolveSupabaseUserId(userId);
  if (!resolvedUserId) return;

  const { error } = await supabase.rpc("track_post_views", {
    p_user_id: resolvedUserId,
    p_post_ids: validIds,
  });
  // Swallow — best-effort. Logging only so the dev console shows the
  // pattern if RLS or RPC schema regresses.
  if (error) console.log("[posts-supabase] trackPostViews failed:", error.message);
};

// Fetches posts authored by a specific user. Wired into ProfilePostTab
// in C.9; the feed there pages by `before` (oldest created_at) cursor.
// Same SELECT shape as the global feed for consistency.
//
// Resolves `userId` through resolveSupabaseUserId before querying so
// callers passing an Appwrite-shape id (mobile users on legacy auth)
// still find their own posts. Without this, a user with $id=
// '66b8...' querying `.eq("user_id", "66b8...")` against a UUID column
// returns nothing → empty profile Posts tab.
export const fetchPostsByUser = async ({ userId, viewerId, limit = 40, before } = {}) => {
  if (!userId) return [];
  const resolvedUserId = await resolveSupabaseUserId(userId);
  if (!resolvedUserId) return [];
  // Filters apply on a profile feed too — if the viewer has hidden a
  // post by this user, it should still be hidden when they visit the
  // profile. Use viewerId if passed, else assume the viewer IS the
  // profile owner (they don't filter their own posts).
  if (viewerId && viewerId !== userId) {
    const resolvedViewer = await resolveSupabaseUserId(viewerId);
    await loadUserContentFilters(resolvedViewer);
  }
  let query = supabase
    .from("posts")
    .select(POST_SELECT)
    .eq("user_id", resolvedUserId)
    .eq("is_hidden", false)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (before) query = query.lt("created_at", before);
  const { data, error } = await query;
  if (error) throw error;
  // Only filter when viewing someone ELSE's profile.
  if (viewerId && viewerId !== userId) {
    return (data || []).filter((p) => !shouldHidePost(p));
  }
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
    // Comments on posts (post_id IN postIds). Hard-delete contract —
    // matches the comments table's actual schema (no deleted_at column).
    supabase.from("comments").select("post_id").in("post_id", postIds),
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
// Supabase Storage later).
//
// Both create + repost route through the SECURITY DEFINER RPC
// `submit_post`. Direct `from('posts').insert()` works for web users
// (real Supabase auth → auth.uid() set → RLS WITH CHECK passes) but
// fails for mobile users on Appwrite auth (anon session → auth.uid()
// null → RLS rejects with "row violates row-level security policy").
// The RPC bypasses RLS via SECURITY DEFINER and validates the actor
// internally — same pattern reactions / follows / comments use.
export const createPost = async ({ body, imageUrl = null, videoId = null, bookId = null } = {}) => {
  const me = await requireUser();
  const trimmed = (body || "").trim();
  if (!trimmed && !imageUrl && !videoId && !bookId) {
    throw new Error("Empty post — needs at least body, image, video, or book");
  }
  const { data: rpcResult, error: rpcErr } = await supabase.rpc("submit_post", {
    p_actor_id: me.id,
    p_body: trimmed || null,
    p_image_url: imageUrl,
    p_video_id: videoId,
    p_book_id: bookId,
    p_reposted_from: null,
    p_legacy_appwrite_id: null,
  });
  if (rpcErr) throw rpcErr;
  if (!rpcResult?.id) throw new Error(rpcResult?.error || "submit_post returned no id");
  // Re-fetch the row in the canonical SELECT shape so the caller (PostCard)
  // gets the same fields the home feed reads. The RPC only returns id +
  // status; the read still goes through RLS but SELECT is permissive.
  const { data, error } = await supabase.from("posts").select(POST_SELECT).eq("id", rpcResult.id).single();
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
//
// Routes through submit_post RPC for the same RLS reason as createPost.
export const createRepost = async ({ originalPostId, caption = "" }) => {
  if (!originalPostId) throw new Error("originalPostId is required");
  const me = await requireUser();
  const { data: rpcResult, error: rpcErr } = await supabase.rpc("submit_post", {
    p_actor_id: me.id,
    p_body: (caption || "").trim() || null,
    p_image_url: null,
    p_video_id: null,
    p_book_id: null,
    p_reposted_from: originalPostId,
    p_legacy_appwrite_id: null,
  });
  if (rpcErr) throw rpcErr;
  if (!rpcResult?.id) throw new Error(rpcResult?.error || "submit_post returned no id");
  const { data, error } = await supabase.from("posts").select(POST_SELECT).eq("id", rpcResult.id).single();
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
      // Prefer the legacy Appwrite id when it exists so the legacy
      // creator-profile screen (which still calls Appwrite's
      // databases.getDocument) can resolve the user. Native Supabase
      // users (no legacy id) fall back to the UUID — those screens
      // need a Supabase profile fetch path, which is a follow-up.
      $id: ownerProfile.legacy_appwrite_id || ownerProfile.id || post.user_id,
      id: ownerProfile.legacy_appwrite_id || ownerProfile.id || post.user_id,
      // Keep the canonical Supabase UUID accessible for callers that
      // explicitly need the new id (likes / comments / reactions).
      supabaseUserId: ownerProfile.id || post.user_id,
      legacy_appwrite_id: ownerProfile.legacy_appwrite_id || null,
      username: ownerProfile.username || "Unknown",
      name: ownerProfile.username || "Unknown",
      avatar: ownerProfile.avatar_url || null,
      avatar_url: ownerProfile.avatar_url || null,
      // Expand role flags (creator/moderator/auditor/isWriter) so
      // UserRoleBadgeIcons surfaces the verified seal on PostCard.
      ...expandProfileRoleFlags(ownerProfile),
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

// In-memory cache for user-id resolutions. Profile rows don't move
// once mapped, so caching a resolved id for the lifetime of the
// session is safe and saves a roundtrip on every subsequent posts /
// follows query for the same legacy id.
const _userIdResolveCache = new Map();

// Resolves any user identifier (Supabase UUID or legacy Appwrite hex)
// to the Supabase profiles.id UUID. Critical for the half-rolled state
// where USE_SUPABASE_POSTS=true but USE_SUPABASE_AUTH=false: the
// signed-in user's `$id` is still the Appwrite hex, but
// `posts.user_id` and `follows.follower_id` are UUIDs. Without this
// resolution, a query like `.eq("user_id", appwriteHexId)` would never
// match any row → users see empty profile / Following feeds.
//
// The migration tool populated `profiles.legacy_appwrite_id` with each
// user's Appwrite document id. We look up that mapping once per legacy
// id and cache it.
export const resolveSupabaseUserId = async (rawId) => {
  if (!rawId) return null;
  if (UUID_REGEX.test(rawId)) return rawId;
  if (_userIdResolveCache.has(rawId)) return _userIdResolveCache.get(rawId);
  const { data, error } = await supabase.from("profiles").select("id").eq("legacy_appwrite_id", rawId).maybeSingle();
  if (error) {
    console.log("[posts-supabase] resolveSupabaseUserId error:", error.message);
    return null;
  }
  const resolved = data?.id || null;
  if (resolved) _userIdResolveCache.set(rawId, resolved);
  return resolved;
};

// Resets the user-id resolution cache. Call on sign-out so the next
// signed-in user doesn't inherit the previous user's resolved
// mappings. (Doesn't break correctness — different users have
// different ids — but cheap correctness for shared devices.)
export const resetUserIdResolveCache = () => {
  _userIdResolveCache.clear();
};

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

// ─────────────────────────────────────────────────────────────────────────
// fetchPostLikesSupabase — paginated reader for the PostLikesModal.
// ─────────────────────────────────────────────────────────────────────────
// Returns the same Appwrite-style { documents, total } shape the modal
// already consumes, so the routing layer in lib/posts.js can swap
// backends without the modal knowing.
//
// Each document carries:
//   $id          — the reaction row id (cursor + list key)
//   $createdAt   — for TimeAgo()
//   likeOwner    — { $id, username, avatar } where $id falls back to the
//                  Supabase UUID when no legacy_appwrite_id exists, so the
//                  /creator-profile route always receives a usable id.
//
// Cursor pagination uses created_at < cursorRow.created_at. The first
// page passes lastId=null and we order desc.
export const fetchPostLikesSupabase = async ({ postId, lastId = null, limit = 10 } = {}) => {
  const postUuid = await resolveSupabasePostId(postId);
  if (!postUuid) return { documents: [], total: 0 };

  // Resolve cursor → created_at
  let beforeCreatedAt = null;
  if (lastId) {
    const { data: cursorRow } = await supabase
      .from("reactions")
      .select("created_at")
      .eq("id", lastId)
      .maybeSingle();
    if (cursorRow?.created_at) beforeCreatedAt = cursorRow.created_at;
  }

  let q = supabase
    .from("reactions")
    .select("id, user_id, emoji, created_at")
    .eq("target_type", "post")
    .eq("target_id", postUuid)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (beforeCreatedAt) q = q.lt("created_at", beforeCreatedAt);

  const { data: rows, error } = await q;
  if (error) {
    console.log("[posts-supabase] fetchPostLikesSupabase error:", error.message);
    return { documents: [], total: 0 };
  }

  // HEAD count for the modal's hasMore math
  const { count } = await supabase
    .from("reactions")
    .select("id", { count: "exact", head: true })
    .eq("target_type", "post")
    .eq("target_id", postUuid);

  // Hydrate the actor profiles in one round trip
  const userIds = Array.from(new Set((rows || []).map((r) => r.user_id).filter(Boolean)));
  let profileMap = new Map();
  if (userIds.length) {
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, username, avatar_url, legacy_appwrite_id")
      .in("id", userIds);
    for (const p of profiles || []) profileMap.set(p.id, p);
  }

  const documents = (rows || []).map((r) => {
    const profile = profileMap.get(r.user_id) || null;
    return {
      $id: r.id,
      $createdAt: r.created_at,
      emoji: r.emoji,
      likeOwner: {
        // /creator-profile router accepts either Appwrite hex or UUID.
        // Prefer the legacy id so deep-link parity with web is preserved;
        // fall back to the UUID for Supabase-native users.
        $id: profile?.legacy_appwrite_id || profile?.id || null,
        username: profile?.username || null,
        avatar: profile?.avatar_url || null,
      },
    };
  });

  return { documents, total: count ?? documents.length };
};
