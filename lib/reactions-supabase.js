// Supabase reactions service — Phase C.6 of the Appwrite → Supabase
// migration. Polymorphic reactions table on Supabase covers likes across
// posts, comments, videos, clips, and books — a single (target_type,
// target_id, user_id, emoji) row replaces five separate Appwrite
// collections (postsLike, videosLikes, clipsLike, booksLike, comments
// sub-likes).
//
// Schema (already live on Supabase, used by web in production):
//   reactions
//     - id (uuid PK)
//     - user_id (uuid → profiles.id)
//     - target_type (text — 'post' | 'comment' | 'video' | 'clip' | 'book')
//     - target_id (uuid — references the row in the matching table)
//     - emoji (text — heart | laugh | sad | cry | angry, see REACTIONS in
//       lib/supabase.js for the canonical list)
//     - created_at (timestamptz)
//   Composite uniqueness: (user_id, target_type, target_id) — a user can
//   only have ONE active reaction per target. Toggling between emojis
//   updates the row in place.
//
// Why only one emoji per user per target:
//   Web's UX exposes reactions as "tap to like, long-press to pick a
//   specific emoji". Whichever emoji the user picked is their reaction;
//   tapping again with the same emoji removes it; tapping with a
//   different emoji replaces. The schema enforces this via the unique
//   constraint, and this module's `toggleReaction` honors it.

import { getMessagesUserId } from "./messages-supabase";
import supabase from "./supabase";

// Default emoji used when the user just taps "like" without picking a
// specific one. Matches web's REACTIONS[0] entry. Mobile's home feed
// uses heart-as-default in PostInformation today.
const DEFAULT_EMOJI = "heart";

// Defensive: prefer cached Appwrite-resolved id, fall back to Supabase
// session, never throw the raw AuthSessionMissingError (which was firing
// repeatedly from PostInformation's getMyReaction call on the
// Appwrite-auth path and surfacing as a red toast in dev).
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

// Returns the current user's reaction on a target, or null if none.
// Used by PostInformation on mount to render the existing like state
// (heart filled / specific emoji shown). Returns just the emoji string
// for callers that only need to know which one is active.
//
// "No user" silently returns null — this is a read-only state check
// that fires on every PostInformation mount, often before the Appwrite-
// auth-to-Supabase-UUID resolution has completed. Throwing here would
// surface as a red dev toast on every post that loads while the user
// is still bootstrapping.
export const getMyReaction = async ({ targetType, targetId }) => {
  if (!targetType || !targetId) return null;
  let me;
  try {
    me = await requireUser();
  } catch (_) {
    return null;
  }
  const { data, error } = await supabase
    .from("reactions")
    .select("emoji")
    .eq("user_id", me.id)
    .eq("target_type", targetType)
    .eq("target_id", targetId)
    .maybeSingle();
  if (error) {
    console.log("[reactions-supabase] getMyReaction error:", error.message);
    return null;
  }
  return data?.emoji || null;
};

// Toggles a reaction. Three cases:
//   1. No existing reaction → INSERT (action: "added")
//   2. Existing reaction with same emoji → DELETE (action: "removed")
//   3. Existing reaction with different emoji → UPDATE (action: "changed")
// Returns { action, emoji } so callers can update local state without
// re-querying.
//
// Implementation note: web does this via a SELECT-then-INSERT/UPDATE/
// DELETE three-step. Same pattern here — simple, race-tolerant, and
// only one of the three writes actually fires per call.
export const toggleReaction = async ({ targetType, targetId, emoji = DEFAULT_EMOJI }) => {
  if (!targetType || !targetId) throw new Error("targetType and targetId required");
  const me = await requireUser();

  const { data: existing } = await supabase
    .from("reactions")
    .select("id, emoji")
    .eq("user_id", me.id)
    .eq("target_type", targetType)
    .eq("target_id", targetId)
    .maybeSingle();

  if (existing) {
    if (existing.emoji === emoji) {
      const { error } = await supabase.from("reactions").delete().eq("id", existing.id);
      if (error) throw error;
      return { action: "removed", emoji };
    }
    const { error } = await supabase.from("reactions").update({ emoji }).eq("id", existing.id);
    if (error) throw error;
    return { action: "changed", emoji };
  }

  const { error } = await supabase.from("reactions").insert({
    user_id: me.id,
    target_type: targetType,
    target_id: targetId,
    emoji,
  });
  if (error) throw error;
  return { action: "added", emoji };
};

// Forces a specific emoji as the user's reaction on a target. Used by
// the long-press reaction picker — the user picked "laugh" and we set
// it regardless of what (if anything) was there before. Idempotent: if
// the user already has the same emoji, returns without writing.
//
// Implementation: SELECT existing → if same emoji, no-op; if different,
// UPDATE; if absent, INSERT. Going through `toggleReaction` would
// delete-then-insert in the same-emoji case which (a) is two writes
// instead of zero and (b) opens a tiny window where another reader
// sees "no reaction".
export const setReaction = async ({ targetType, targetId, emoji }) => {
  if (!emoji) throw new Error("emoji required");
  if (!targetType || !targetId) throw new Error("targetType and targetId required");
  const me = await requireUser();

  const { data: existing } = await supabase
    .from("reactions")
    .select("id, emoji")
    .eq("user_id", me.id)
    .eq("target_type", targetType)
    .eq("target_id", targetId)
    .maybeSingle();

  if (existing) {
    if (existing.emoji === emoji) return emoji;
    const { error } = await supabase.from("reactions").update({ emoji }).eq("id", existing.id);
    if (error) throw error;
    return emoji;
  }

  const { error } = await supabase.from("reactions").insert({
    user_id: me.id,
    target_type: targetType,
    target_id: targetId,
    emoji,
  });
  if (error) throw error;
  return emoji;
};

// Removes the current user's reaction on a target. Idempotent — if no
// reaction existed, this is a no-op. Used by the unlike path explicitly.
export const removeMyReaction = async ({ targetType, targetId }) => {
  if (!targetType || !targetId) return;
  const me = await requireUser();
  const { error } = await supabase.from("reactions").delete().eq("user_id", me.id).eq("target_type", targetType).eq("target_id", targetId);
  if (error) throw error;
};

// Counts reactions on a single target. Optionally grouped by emoji so
// the caller can render the "❤️ 12, 😂 3" summary chips web shows.
export const getReactionCount = async ({ targetType, targetId }) => {
  if (!targetType || !targetId) return 0;
  const { count, error } = await supabase
    .from("reactions")
    .select("*", { count: "exact", head: true })
    .eq("target_type", targetType)
    .eq("target_id", targetId);
  if (error) {
    console.log("[reactions-supabase] getReactionCount error:", error.message);
    return 0;
  }
  return count || 0;
};

// Batched counts for many targets at once. Returns
// { [target_id]: { total, byEmoji: { heart: 5, laugh: 2 } } }.
// Used by feed renderers that need to show counts on many posts in one
// pass. Mirrors `lib/posts-supabase.js#fetchPostStats` patterns.
export const getReactionCountsForTargets = async ({ targetType, targetIds = [] }) => {
  const result = {};
  for (const id of targetIds) result[id] = { total: 0, byEmoji: {} };
  if (!targetType || !targetIds.length) return result;

  const { data, error } = await supabase.from("reactions").select("target_id, emoji").eq("target_type", targetType).in("target_id", targetIds);
  if (error) {
    console.log("[reactions-supabase] getReactionCountsForTargets error:", error.message);
    return result;
  }

  for (const r of data || []) {
    if (!result[r.target_id]) continue;
    result[r.target_id].total += 1;
    result[r.target_id].byEmoji[r.emoji] = (result[r.target_id].byEmoji[r.emoji] || 0) + 1;
  }
  return result;
};

// Batched lookup of the current user's reactions across many targets.
// Returns { [targetId]: emoji } for any target where the user has a row;
// targets without a reaction are simply absent from the map. Used by
// the comments modal to mark "did I like this" on every comment in a
// list using a single query, instead of N getMyReaction calls.
export const getMyReactionsForTargets = async ({ targetType, targetIds = [] }) => {
  if (!targetType || !targetIds.length) return {};
  const me = await requireUser().catch(() => null);
  if (!me) return {};
  const { data, error } = await supabase
    .from("reactions")
    .select("target_id, emoji")
    .eq("user_id", me.id)
    .eq("target_type", targetType)
    .in("target_id", targetIds);
  if (error) {
    console.log("[reactions-supabase] getMyReactionsForTargets error:", error.message);
    return {};
  }
  const out = {};
  for (const r of data || []) {
    out[r.target_id] = r.emoji;
  }
  return out;
};

// Lists all reactions on a target, joined with reactor profiles. Used
// by PostLikesModal-style lists ("see who reacted").
export const getReactorsForTarget = async ({ targetType, targetId, limit = 100 }) => {
  if (!targetType || !targetId) return [];
  const { data, error } = await supabase
    .from("reactions")
    .select("emoji, created_at, profiles!user_id(id, username, avatar_url, is_guest)")
    .eq("target_type", targetType)
    .eq("target_id", targetId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.log("[reactions-supabase] getReactorsForTarget error:", error.message);
    return [];
  }
  return data || [];
};
