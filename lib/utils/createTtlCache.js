// Tiny in-memory cache with TTL expiration and LRU bounded size.
//
// Use cases: any read-mostly Appwrite call where the same key gets fetched
// multiple times in a session and freshness on the order of minutes is fine
// (user profile lookups, follow status, lightweight metadata).
//
// Usage:
//   const userCache = createTtlCache({ ttlMs: 60_000, maxEntries: 200 });
//   const cached = userCache.get(userId);
//   if (cached) return cached;
//   const fresh = await fetchUser(userId);
//   userCache.set(userId, fresh);
//
// Why a custom helper instead of a third-party LRU package: keeps the
// dependency footprint small (this codebase prefers leaner deps), and the
// logic we need is genuinely tiny — Map preserves insertion order, so LRU
// eviction is just delete+re-set on access.

const DEFAULT_TTL_MS = 60_000; // 1 minute
const DEFAULT_MAX_ENTRIES = 500;

/**
 * @param {Object} options
 * @param {number} [options.ttlMs] — entry lifetime in ms. Defaults to 60s.
 * @param {number} [options.maxEntries] — cap to prevent unbounded growth on long sessions. Defaults to 500.
 */
export const createTtlCache = ({ ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES } = {}) => {
  const store = new Map();

  const evictExpired = () => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.expiresAt <= now) {
        store.delete(key);
      } else {
        // Map iterates in insertion order — once we hit a non-expired one
        // every subsequent entry was inserted later and is fresher. Bail.
        break;
      }
    }
  };

  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= Date.now()) {
        store.delete(key);
        return undefined;
      }
      // LRU touch: re-insert to bump to the back (most-recent end).
      store.delete(key);
      store.set(key, entry);
      return entry.value;
    },

    set(key, value) {
      // Replace existing entry (also bumps LRU position).
      if (store.has(key)) store.delete(key);
      store.set(key, { value, expiresAt: Date.now() + ttlMs });

      // Evict the oldest entries if we're over capacity. Cheap GC pass first.
      if (store.size > maxEntries) {
        evictExpired();
      }
      while (store.size > maxEntries) {
        const oldestKey = store.keys().next().value;
        if (oldestKey === undefined) break;
        store.delete(oldestKey);
      }
    },

    delete(key) {
      return store.delete(key);
    },

    clear() {
      store.clear();
    },

    // Surface for debug / instrumentation. Not part of the hot path.
    get size() {
      return store.size;
    },
  };
};

export default createTtlCache;
