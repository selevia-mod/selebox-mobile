// Light cache for the chat conversations list.
//
// Why this exists: the user complaint was "chat keeps loading and loading"
// — every time the Messages tab gained focus, the conversation list
// painted a skeleton spinner while the network round-trip resolved
// (typically 200–800 ms). This cache lets the list paint from MMKV
// instantly on tab focus, then refresh in the background and swap to
// fresh data when it lands.
//
// Scope: ONLY the conversation list. Per-thread messages are not cached
// here — they're loaded fresh per thread open, which is fast enough on
// today's data volumes. If the user later complains about thread-open
// latency, we promote to a "Full" cache (per-conversation last 50
// messages persisted) as a follow-up.
//
// Storage: the project's existing MMKV instance (store/storage.js).
// MMKV is sync, fast, native, and already used by Redux Persist for
// long-lived state — no new dependency, no init cost.
//
// Per-user isolation: keys are prefixed with the user's chat UUID so a
// device that switches accounts doesn't paint the previous user's
// conversation list under the new identity. Cache is also wiped on
// sign-out via clearChatCache().

import { storage } from "../store/storage";

// Storage key prefix. The full key is `chat-cache:conversations:<userId>`.
// The trailing colon-separated segments make per-user keys easy to
// enumerate and bulk-delete on sign-out.
const KEY_PREFIX = "chat-cache:conversations:";
// Max age before cached data is considered too stale to paint.
// We still paint it (the user wants instant feedback), but the
// freshness timestamp lets the consumer decide whether to show a
// secondary "refreshing" affordance. A week feels generous — chat
// metadata changes constantly via realtime so the cache will mostly
// be < 1 minute old anyway.
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const keyFor = (userId) => (userId ? `${KEY_PREFIX}${userId}` : null);

// Returns the most-recently-cached conversations list for `userId`, or
// null if there's no cache (or it's too old). The shape matches what
// `loadConversations` returns from lib/messages-supabase.js — same
// objects, same fields — so the consumer can pass it straight to
// setConversations() without a transform.
export const getCachedConversations = (userId) => {
  const k = keyFor(userId);
  if (!k) return null;
  try {
    const raw = storage.getString(k);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.conversations)) return null;
    if (typeof parsed.cachedAt !== "number") return null;
    if (Date.now() - parsed.cachedAt > CACHE_MAX_AGE_MS) {
      // Stale beyond a week — drop it rather than paint ancient data.
      storage.delete(k);
      return null;
    }
    return parsed.conversations;
  } catch (e) {
    // Corrupt cache (bad JSON, partial write, etc.) — purge so we don't
    // keep failing and never recover. Next fresh fetch repopulates.
    try { storage.delete(k); } catch (_) {}
    return null;
  }
};

// Writes the current conversations list to the cache, scoped to userId.
// Caller passes the fresh result of `loadConversations` after each
// successful fetch + after each meaningful realtime patch (new message,
// archive toggle, etc.). Synchronous — MMKV's set is microseconds.
export const setCachedConversations = (userId, conversations) => {
  const k = keyFor(userId);
  if (!k) return;
  try {
    const payload = {
      cachedAt: Date.now(),
      conversations: Array.isArray(conversations) ? conversations : [],
    };
    storage.set(k, JSON.stringify(payload));
  } catch (e) {
    // Don't surface a persistence failure into the UI — the live state
    // is already correct, this is just the cache layer.
    console.log("[chat-cache] setCachedConversations failed:", e?.message);
  }
};

// Wipes the cache for a specific user. Called on sign-out so a future
// user on the same device doesn't see the previous user's chats while
// the new fetch is in flight.
export const clearChatCache = (userId) => {
  const k = keyFor(userId);
  if (!k) return;
  try { storage.delete(k); } catch (_) {}
};
