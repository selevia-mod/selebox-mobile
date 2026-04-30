import { createTtlCache } from "../utils/createTtlCache";

// Shared module-level user document cache. Lives outside lib/users.js and
// lib/appwrite.js so both can import the invalidator without creating a
// circular module graph (appwrite.js owns updateAvatar / updateBanner /
// updateBio, users.js owns getUserByID).
//
// TTL choice: 2 minutes. Short enough that a profile update surfaces fast
// even without explicit invalidation; long enough that scrolling a chat list
// or notifications page reuses cached entries instead of refetching.
//
// maxEntries: 300 — a heavy session (chats + comments + mentions + suggested
// creators) won't see anywhere near that many distinct users; gives plenty
// of headroom without unbounded growth.
export const USER_CACHE = createTtlCache({ ttlMs: 2 * 60 * 1000, maxEntries: 300 });

export const invalidateUserCache = (userId) => {
  if (userId) USER_CACHE.delete(userId);
};

export const setUserCache = (userId, userDoc) => {
  if (!userId || !userDoc) return;
  USER_CACHE.set(userId, userDoc);
};
