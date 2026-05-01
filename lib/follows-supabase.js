// Supabase-flavored FollowService — drop-in replacement for lib/follows.js
// during the Appwrite → Supabase migration.
//
// What this file replaces:
//   The FollowService class in `lib/follows.js`. Same method names + return
//   shapes, so consumers (PostCard follow button, profile pages, follower
//   lists, mutual-follows widget) don't have to change. The only difference
//   is the backing store — Supabase `follows` table instead of Appwrite's
//   followsCollection.
//
// ID resolution:
//   The mobile app, while USE_SUPABASE_AUTH is still false, hands us
//   Appwrite hex IDs (24-char). The Supabase `follows` table uses UUIDs
//   keyed to `profiles.id`. We resolve hex → uuid via
//   `resolveSupabaseUserId` (same helper posts-supabase.js uses), which
//   looks up `profiles.legacy_appwrite_id` and caches the result.
//
//   Once USE_SUPABASE_AUTH flips to true, user.$id IS the Supabase UUID
//   already, and resolveSupabaseUserId becomes a fast-path no-op.
//
// Cache:
//   Same TTL cache pattern as the Appwrite version — avoids hammering
//   the DB when 30 profile rows on a list each ask "do I follow them?"
//   1-minute TTL with explicit invalidation on follow/unfollow writes.

import supabase from "./supabase";
import { resolveSupabaseUserId } from "./posts-supabase";
import { createTtlCache } from "./utils/createTtlCache";
import logger from "./utils/logger";

// 1-minute follow-status cache, keyed by `${followerId}::${followingId}`.
// Same shape and TTL as lib/follows.js so behavior matches under either flag.
const FOLLOW_STATUS_CACHE = createTtlCache({ ttlMs: 60 * 1000, maxEntries: 1000 });
const followKey = (followerId, followingId) => `${followerId}::${followingId}`;

// Resolve a raw user id (Appwrite hex OR Supabase UUID) to a Supabase UUID.
// Returns null on any failure so callers can short-circuit gracefully.
const toUuid = async (rawId) => {
  if (!rawId) return null;
  return resolveSupabaseUserId(rawId);
};

// Helper: extract a user id from either a string id or a user object.
// Mirrors the helper in lib/follows.js so call sites that pass `user`
// objects keep working.
const getUserId = (value) => {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.$id ?? value.id ?? null;
};

export class FollowServiceSupabase {
  // Create a follow row. Idempotent on (follower_id, following_id) — the
  // table's primary key prevents duplicates, so a second insert returns
  // a unique-violation error which we treat as "already following" (no-op).
  static async followUser({ followerId, followingId }) {
    try {
      const fromId = await toUuid(followerId);
      const toId = await toUuid(followingId);
      if (!fromId || !toId) {
        throw new Error("FollowService.followUser: could not resolve user ids");
      }
      if (fromId === toId) {
        // Don't allow following yourself. The DB doesn't enforce this — it's
        // a product rule.
        throw new Error("Cannot follow yourself");
      }

      const { data, error } = await supabase
        .from("follows")
        .insert({ follower_id: fromId, following_id: toId })
        .select()
        .maybeSingle();

      // Already-following → unique violation. Treat as success so the UI
      // doesn't bounce.
      if (error && error.code === "23505") {
        FOLLOW_STATUS_CACHE.set(followKey(followerId, followingId), true);
        return { ok: true, alreadyFollowed: true };
      }
      if (error) throw error;

      FOLLOW_STATUS_CACHE.set(followKey(followerId, followingId), true);
      return data;
    } catch (error) {
      logger.error("FollowServiceSupabase", "followUser failed", error);
      throw error;
    }
  }

  static async unfollowUser({ followerId, followingId }) {
    try {
      const fromId = await toUuid(followerId);
      const toId = await toUuid(followingId);
      if (!fromId || !toId) {
        throw new Error("FollowService.unfollowUser: could not resolve user ids");
      }

      const { error } = await supabase
        .from("follows")
        .delete()
        .eq("follower_id", fromId)
        .eq("following_id", toId);
      if (error) throw error;

      FOLLOW_STATUS_CACHE.set(followKey(followerId, followingId), false);
    } catch (error) {
      logger.error("FollowServiceSupabase", "unfollowUser failed", error);
      throw error;
    }
  }

  static async isFollowing({ followerId, followingId }) {
    if (!followerId || !followingId) return false;
    const key = followKey(followerId, followingId);
    const cached = FOLLOW_STATUS_CACHE.get(key);
    if (typeof cached === "boolean") return cached;

    try {
      const fromId = await toUuid(followerId);
      const toId = await toUuid(followingId);
      if (!fromId || !toId) return false;

      const { data, error } = await supabase
        .from("follows")
        .select("follower_id")
        .eq("follower_id", fromId)
        .eq("following_id", toId)
        .limit(1)
        .maybeSingle();
      if (error && error.code !== "PGRST116") {
        // PGRST116 = no rows returned (maybeSingle's "not found" code).
        // That's expected when not following; everything else is a real error.
        throw error;
      }

      const isFollowing = !!data;
      FOLLOW_STATUS_CACHE.set(key, isFollowing);
      return isFollowing;
    } catch (error) {
      logger.error("FollowServiceSupabase", "isFollowing failed", error);
      throw error;
    }
  }

  // Bulk follow-relations lookup. Used by feed cards / profile rows that
  // render N creators at once and need to know "do I follow them" + "do
  // they follow me back" without firing 2N round-trips.
  //
  // Returns: { [otherUserId]: { iFollow: bool, theyFollow: bool } }
  static async getFollowRelations({ currentUserId, otherUserIds, knownIFollowIds = [], knownTheyFollowIds = [] }) {
    try {
      const uniqueIds = [...new Set((otherUserIds || []).filter(Boolean))];
      if (!currentUserId || uniqueIds.length === 0) return {};

      const meId = await toUuid(currentUserId);
      if (!meId) return {};

      // Resolve all the OTHER user ids in parallel. Some may already be
      // UUIDs (USE_SUPABASE_AUTH=true) and some may be hex (legacy callers).
      // resolveSupabaseUserId fast-paths UUIDs, so this is cheap.
      const resolvedPairs = await Promise.all(
        uniqueIds.map(async (id) => [id, await toUuid(id)]),
      );
      const rawToUuid = Object.fromEntries(resolvedPairs);
      const uuidToRaw = Object.fromEntries(
        resolvedPairs.filter(([, u]) => u).map(([raw, u]) => [u, raw]),
      );
      const resolvedUuids = Object.values(rawToUuid).filter(Boolean);

      const knownIFollow = new Set(knownIFollowIds);
      const knownTheyFollow = new Set(knownTheyFollowIds);
      const iFollowLookup = uniqueIds.filter((id) => !knownIFollow.has(id) && rawToUuid[id]);
      const theyFollowLookup = uniqueIds.filter((id) => !knownTheyFollow.has(id) && rawToUuid[id]);

      const iFollowUuids = iFollowLookup.map((id) => rawToUuid[id]).filter(Boolean);
      const theyFollowUuids = theyFollowLookup.map((id) => rawToUuid[id]).filter(Boolean);

      const [iFollowRes, theyFollowRes] = await Promise.all([
        iFollowUuids.length > 0
          ? supabase
              .from("follows")
              .select("following_id")
              .eq("follower_id", meId)
              .in("following_id", iFollowUuids)
          : Promise.resolve({ data: [] }),
        theyFollowUuids.length > 0
          ? supabase
              .from("follows")
              .select("follower_id")
              .eq("following_id", meId)
              .in("follower_id", theyFollowUuids)
          : Promise.resolve({ data: [] }),
      ]);

      const iFollowSet = new Set(knownIFollow);
      for (const row of iFollowRes.data || []) {
        const raw = uuidToRaw[row.following_id];
        if (raw) iFollowSet.add(raw);
      }
      const theyFollowSet = new Set(knownTheyFollow);
      for (const row of theyFollowRes.data || []) {
        const raw = uuidToRaw[row.follower_id];
        if (raw) theyFollowSet.add(raw);
      }

      // Light-touch cache update so subsequent isFollowing calls don't
      // re-hit the DB for the same pairs.
      for (const id of uniqueIds) {
        FOLLOW_STATUS_CACHE.set(followKey(currentUserId, id), iFollowSet.has(id));
      }

      return uniqueIds.reduce((acc, id) => {
        acc[id] = {
          iFollow: iFollowSet.has(id),
          theyFollow: theyFollowSet.has(id),
        };
        return acc;
      }, {});
    } catch (error) {
      console.error("FollowServiceSupabase.getFollowRelations error:", error);
      throw error;
    }
  }

  static async getFollowersCount({ userId }) {
    try {
      const uuid = await toUuid(userId);
      if (!uuid) return 0;

      const { count, error } = await supabase
        .from("follows")
        .select("follower_id", { count: "exact", head: true })
        .eq("following_id", uuid);
      if (error) throw error;
      return count || 0;
    } catch (error) {
      console.error("FollowServiceSupabase.getFollowersCount error:", error);
      throw error;
    }
  }

  static async getFollowingCount({ userId }) {
    try {
      const uuid = await toUuid(userId);
      if (!uuid) return 0;

      const { count, error } = await supabase
        .from("follows")
        .select("following_id", { count: "exact", head: true })
        .eq("follower_id", uuid);
      if (error) throw error;
      return count || 0;
    } catch (error) {
      console.error("FollowServiceSupabase.getFollowingCount error:", error);
      throw error;
    }
  }

  // Returns the LIST of follower rows. The Appwrite version returned full
  // documents shaped { $id, followerId, followingId, $createdAt }. We
  // mirror that shape here so the calling components don't have to fork.
  // Optional pagination: pass limit + cursor (last-row's created_at) for
  // infinite scroll lists.
  static async getFollowers({ userId, limit, cursor }) {
    try {
      const uuid = await toUuid(userId);
      if (!uuid) return limit ? { documents: [], hasMore: false } : [];

      let q = supabase
        .from("follows")
        .select("follower_id, following_id, created_at")
        .eq("following_id", uuid)
        .order("created_at", { ascending: false });

      if (limit) q = q.limit(limit);
      // Cursor pagination — `cursor` is the created_at of the last row of
      // the previous page. We page strictly backwards in time so this is a
      // simple `lt` filter.
      if (cursor) q = q.lt("created_at", cursor);

      const { data, error } = await q;
      if (error) throw error;

      const documents = (data || []).map((row) => ({
        // Appwrite-shaped legacy aliases — let consumers that read .$id /
        // .followerId / .followingId / .$createdAt keep working unchanged.
        $id: `${row.follower_id}::${row.following_id}`,
        followerId: row.follower_id,
        followingId: row.following_id,
        $createdAt: row.created_at,
        // Supabase-native field names too.
        follower_id: row.follower_id,
        following_id: row.following_id,
        created_at: row.created_at,
      }));

      if (limit) {
        return { documents, hasMore: documents.length === limit };
      }
      return documents;
    } catch (error) {
      console.error("FollowServiceSupabase.getFollowers error:", error);
      throw error;
    }
  }

  static async getFollowing({ userId, limit, cursor }) {
    try {
      const uuid = await toUuid(userId);
      if (!uuid) return limit ? { documents: [], hasMore: false } : [];

      let q = supabase
        .from("follows")
        .select("follower_id, following_id, created_at")
        .eq("follower_id", uuid)
        .order("created_at", { ascending: false });

      if (limit) q = q.limit(limit);
      if (cursor) q = q.lt("created_at", cursor);

      const { data, error } = await q;
      if (error) throw error;

      const documents = (data || []).map((row) => ({
        $id: `${row.follower_id}::${row.following_id}`,
        followerId: row.follower_id,
        followingId: row.following_id,
        $createdAt: row.created_at,
        follower_id: row.follower_id,
        following_id: row.following_id,
        created_at: row.created_at,
      }));

      if (limit) {
        return { documents, hasMore: documents.length === limit };
      }
      return documents;
    } catch (error) {
      console.error("FollowServiceSupabase.getFollowing error:", error);
      throw error;
    }
  }

  // Two-way follows. Used by mutual-friends UI ("X and Y mutual friends").
  // The Appwrite version called getFollowing+getFollowers and intersected
  // client-side; with Supabase we can collapse it into a single self-join.
  static async getMutualFollows({ userId }) {
    try {
      const uuid = await toUuid(userId);
      if (!uuid) return [];

      // Self-join on follows: rows where I follow X AND X follows me back.
      // We do it via two queries + set intersection because Supabase JS
      // doesn't expose self-joins as a first-class operation.
      const [followingRes, followersRes] = await Promise.all([
        supabase.from("follows").select("following_id").eq("follower_id", uuid),
        supabase.from("follows").select("follower_id").eq("following_id", uuid),
      ]);
      if (followingRes.error) throw followingRes.error;
      if (followersRes.error) throw followersRes.error;

      const followingIds = new Set((followingRes.data || []).map((r) => r.following_id));
      const mutuals = (followersRes.data || []).filter((r) => followingIds.has(r.follower_id));

      // Match the Appwrite shape — { $id, followerId, followingId } per row.
      return mutuals.map((row) => ({
        $id: `${row.follower_id}::${uuid}`,
        followerId: row.follower_id,
        followingId: uuid,
        follower_id: row.follower_id,
        following_id: uuid,
      }));
    } catch (error) {
      console.error("FollowServiceSupabase.getMutualFollows error:", error);
      throw error;
    }
  }
}

// Convenience re-export so existing call sites that did
// `import { FollowService } from "./follows"` can switch with a one-line
// import path change. Keep both named exports so consumers can pick the
// version they want without renaming all the call sites.
export const FollowService = FollowServiceSupabase;
export { getUserId };
