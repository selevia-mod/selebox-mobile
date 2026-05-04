// Supabase-flavored user lookups — drop-in replacement for the
// read-side methods of lib/users.js during the Appwrite → Supabase
// migration.
//
// Surface covered:
//   getUserByID({ ID })           → profiles row by id (Appwrite hex OR
//                                   Supabase UUID), returned in
//                                   Appwrite-shaped form so existing
//                                   consumers ($id, accountId, name,
//                                   avatar, banner, bio, role, etc.)
//                                   keep working.
//   fetchUsersByQuery(queries)    → minimal facade — only used by
//                                   FetchAllCreators below; we don't
//                                   port the full Appwrite Query DSL.
//   searchUsers(searchQuery)      → username substring search (ilike
//                                   on profiles.username).
//   FetchAllCreators(setCreators) → all profiles where role = 'creator'
//                                   shuffled for a random surface.
//   pingUserActive({ userId })    → update profiles.last_active_at.
//
// ID resolution:
//   getUserByID accepts either an Appwrite hex ID or a Supabase UUID.
//   It detects shape (UUID = dashes) and queries the right column.
//   This way callers under USE_SUPABASE_AUTH=false (passing hex ids)
//   AND under USE_SUPABASE_AUTH=true (passing UUIDs) both work.
//
// Cache:
//   Mirrors lib/users.js's USER_CACHE — same TTL, same invalidator
//   (`invalidateUserCache`). Re-exports the same helper so existing
//   call sites that imported it from lib/users keep working when this
//   file is the active backend.

import supabase from "./supabase";
import { invalidateUserCache, setUserCache, USER_CACHE } from "./caches/user-cache";
import logger from "./utils/logger";

// Re-export so consumers that did `import { invalidateUserCache } from "./users"`
// keep working under either backend.
export { invalidateUserCache };

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Map a Supabase profiles row to the Appwrite-shaped user object the
// rest of the app expects. Mirrors the hydrator in lib/supabase-auth.js
// (hydrateProfile) — keeping these in sync matters because the same
// downstream components consume both.
const hydrateProfileRow = (row) => {
  if (!row) return null;
  return {
    // Native Supabase fields
    id: row.id,
    username: row.username,
    email: row.email,
    avatar_url: row.avatar_url,
    banner_url: row.banner_url,
    bio: row.bio,
    // Web shows location + website in its About tab; mobile's profile
    // header now renders the same fields. Earlier hydrator dropped them,
    // so even after the schema migration mobile would render empty meta
    // chips for users with location/website set on Supabase.
    location: row.location,
    website: row.website,
    role: row.role,
    roles: row.roles ?? (row.role ? [row.role] : []),
    is_guest: row.is_guest,
    is_banned: row.is_banned,
    suspended_until: row.suspended_until,
    legacy_appwrite_id: row.legacy_appwrite_id,
    last_active_at: row.last_active_at,
    expo_push_token: row.expo_push_token,
    created_at: row.created_at,
    updated_at: row.updated_at,

    // Appwrite-shaped legacy aliases — every consumer that reads
    // .$id / .name / .avatar / .banner / .accountId keeps working.
    $id: row.legacy_appwrite_id || row.id,
    $createdAt: row.created_at,
    $updatedAt: row.updated_at,
    accountId: row.id,
    name: row.username,
    avatar: row.avatar_url,
    banner: row.banner_url,
    expoPushToken: row.expo_push_token,
    lastActive: row.last_active_at,
    isTester: row.is_tester,
    creator: (row.roles ?? []).includes("creator") || row.role === "creator",
    moderator: (row.roles ?? []).includes("moderator") || row.role === "moderator",
    auditor: (row.roles ?? []).includes("auditor") || row.role === "auditor",
  };
};

// Internal helper: fetch a profile by either id (UUID) or
// legacy_appwrite_id (hex). Returns null on miss, throws on real errors.
const fetchProfile = async (rawId) => {
  if (!rawId) return null;
  const isUuid = UUID_REGEX.test(rawId);
  const column = isUuid ? "id" : "legacy_appwrite_id";

  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq(column, rawId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
};

// getUserByID — heavily-cached single-user lookup. Same call shape as
// the Appwrite version: `{ ID }` (capitalized).
export const getUserByID = async ({ ID }) => {
  if (!ID) {
    throw new Error("getUserByID requires an ID");
  }

  const cached = USER_CACHE.get(ID);
  if (cached) return cached;

  try {
    const row = await fetchProfile(ID);
    if (!row) {
      // Not found — don't poison the cache. Caller decides what to do
      // with `null` (Profile.jsx already handles this gracefully).
      return null;
    }
    const hydrated = hydrateProfileRow(row);
    setUserCache(ID, hydrated);
    return hydrated;
  } catch (error) {
    logger.warn("users-supabase/getUserByID", `failed to fetch ${ID}`, error);
    throw error;
  }
};

// Minimal facade. The Appwrite version supports the full Query DSL —
// we only port the patterns used in this codebase. If a caller passes
// queries the Supabase version doesn't understand, it logs and returns
// an empty page rather than crashing.
//
// Today the only consumer is FetchAllCreators below, which we
// reimplement directly.
export const fetchUsersByQuery = async (_queries) => {
  console.warn(
    "[users-supabase] fetchUsersByQuery is a no-op under Supabase mode; use a domain-specific helper instead.",
  );
  return { documents: [], total: 0 };
};

// Username substring search. Returns an array of profile IDs (matches
// the Appwrite return shape).
export const searchUsers = async (searchQuery) => {
  if (!searchQuery) return [];
  try {
    // ilike for case-insensitive substring match. Wrap with % on both
    // sides so users typing "joh" find "johndoe" / "joannah" / etc.
    const { data, error } = await supabase
      .from("profiles")
      .select("id, legacy_appwrite_id")
      .ilike("username", `%${searchQuery}%`)
      .limit(100);
    if (error) throw error;

    // Match the Appwrite version's behavior — returns the user IDs as
    // strings. Prefer legacy_appwrite_id when it exists so consumers
    // still on the Appwrite-keyed code paths get the IDs they expect.
    return (data || []).map((row) => row.legacy_appwrite_id || row.id);
  } catch (err) {
    console.error("[users-supabase] searchUsers error:", err);
    return [];
  }
};

// FetchAllCreators — paginate through all creator profiles, shuffle,
// hand to setter callback. The Appwrite version returns a value but
// most callers use the setter pattern; we keep both behaviors.
export const FetchAllCreators = async (setAllCreators) => {
  try {
    // Profiles can have either a single `role` text column or a
    // `roles` text[] array column, depending on schema vintage. We
    // try the array form first (newer) and fall back to the scalar.
    let creators = [];

    // Try array contains first
    const arrRes = await supabase
      .from("profiles")
      .select("*")
      .contains("roles", ["creator"]);

    if (!arrRes.error && arrRes.data) {
      creators = arrRes.data;
    } else {
      // Fall back to scalar role match
      const scalarRes = await supabase
        .from("profiles")
        .select("*")
        .eq("role", "creator");
      if (scalarRes.error) throw scalarRes.error;
      creators = scalarRes.data || [];
    }

    const hydrated = creators.map(hydrateProfileRow);
    const shuffled = hydrated.sort(() => 0.5 - Math.random());
    if (typeof setAllCreators === "function") setAllCreators(shuffled);
    return shuffled;
  } catch (error) {
    console.log("[users-supabase] FetchAllCreators error:", error);
    return [];
  }
};

// pingUserActive — lightweight presence ping. Updates
// profiles.last_active_at. We accept both hex and UUID `userId`.
export const pingUserActive = async ({ userId }) => {
  if (!userId) return;
  try {
    const isUuid = UUID_REGEX.test(userId);
    const column = isUuid ? "id" : "legacy_appwrite_id";

    const { error } = await supabase
      .from("profiles")
      .update({ last_active_at: new Date().toISOString() })
      .eq(column, userId);
    // Don't throw on missing column / 4xx — this is a presence ping,
    // not load-bearing for the user's session. Just log + move on.
    if (error) {
      logger.warn("users-supabase/pingUserActive", `failed for ${userId}`, error);
    }
  } catch (error) {
    logger.warn("users-supabase/pingUserActive", `failed for ${userId}`, error);
  }
};
