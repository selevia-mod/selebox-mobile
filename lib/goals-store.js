// lib/goals-store.js
// ────────────────────────────────────────────────────────────────────────
// Goals progress store (mobile) — Supabase-backed.
//
// Source of truth: Supabase RPCs (`tick_user_goal`, `claim_user_goal_pool`)
// against the tables created by `Selebox/migration_goals_progress.sql`.
// AsyncStorage is demoted to a write-through cache so reads stay
// instant on focus and the UI doesn't blink while the network round-
// trips back. Same Dear Jen account → identical state on every device.
//
// Public API (stable — call sites in book-reading.jsx, video-player.jsx
// shouldn't need to know about the swap):
//   • tickGoal(category, delta)           — fire-and-forget increment
//   • tickGoalUnique(category, uniqueKey) — deduped (chapter $id, video $id)
//   • loadProgress()                      — { daily, weekly, monthly }
//   • loadPoolClaimed()                   — { daily, weekly, monthly }
//   • markPoolClaimed(period, reward)     — atomic claim via RPC
//   • resetAllGoals()                     — debug helper, local cache only
//
// Auth: each function resolves the actor UUID via the messages-user
// cache (set at login, common across all Supabase services). If no
// user is signed in, ticks become local-only no-ops — graceful for
// the signed-out preview state.

import AsyncStorage from "@react-native-async-storage/async-storage";
import supabase from "./supabase";

// Map abstract event category → quest IDs in each period. Matches
// components/GoalsTab.jsx — keep both sides in sync if either changes.
const QUEST_ID_MAP = {
  login:         { daily: "login",         weekly: null,              monthly: null },
  read_chapters: { daily: "read_chapters", weekly: "w_read_chapters", monthly: "m_read_chapters" },
  watch_video:   { daily: "watch_video",   weekly: "w_watch_video",   monthly: "m_watch_video" },
  like_comment:  { daily: "like_comment",  weekly: "w_like_comment",  monthly: "m_like_comment" },
  follow_user:   { daily: "follow_user",   weekly: "w_follow_users",  monthly: "m_follow_users" },
  share:         { daily: null,            weekly: "w_share",         monthly: "m_share" },
  unlock:        { daily: null,            weekly: "w_unlock",        monthly: "m_unlock" },
  watch_ads:     { daily: "watch_ads",     weekly: "w_watch_ads",     monthly: "m_watch_ads" },
  invite_friend: { daily: "invite_friend", weekly: "w_invite_friend", monthly: "m_invite_friend" },
  purchase_coin: { daily: null,            weekly: "w_purchase_coin", monthly: "m_purchase_coin" },
  active_day:    { daily: null,            weekly: null,              monthly: "m_active30" },
};

const CACHE_PREFIX = "@goals_cache_v2";
const CLAIM_PREFIX = "@goals_claim_v2";
const SEEN_PREFIX  = "@goals_seen_v2"; // local-only dedup; server-side dedup is a future hardening

// ─── Period keys ──────────────────────────────────────────────────────
const dailyKey = (now = new Date()) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

const weeklyKey = (now = new Date()) => {
  const tmp = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dayNum = (tmp.getUTCDay() + 6) % 7;
  tmp.setUTCDate(tmp.getUTCDate() - dayNum + 3);
  const firstThursday = tmp.valueOf();
  tmp.setUTCMonth(0, 1);
  if (tmp.getUTCDay() !== 4) {
    tmp.setUTCMonth(0, 1 + ((4 - tmp.getUTCDay()) + 7) % 7);
  }
  const weekNum = 1 + Math.round((firstThursday - tmp) / 604800000);
  return `${now.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
};

const monthlyKey = (now = new Date()) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

const PERIOD_KEY_FN = { daily: dailyKey, weekly: weeklyKey, monthly: monthlyKey };

const cacheKey = (period) => `${CACHE_PREFIX}:${period}:${PERIOD_KEY_FN[period]()}`;
const claimCacheKey = (period) => `${CLAIM_PREFIX}:${period}:${PERIOD_KEY_FN[period]()}`;

// ─── Auth helper ──────────────────────────────────────────────────────
// Reuses the same actor-id resolver every other Supabase service uses
// (messages, posts, comments, books). On auth=Appwrite, this returns
// the Supabase UUID looked up via legacy_appwrite_id at login. On
// auth=Supabase, it returns the session UUID directly. Returns null
// when signed out — callers no-op gracefully.
const resolveActorId = async () => {
  try {
    const { getMessagesUserId } = await import("./messages-supabase");
    return getMessagesUserId() || null;
  } catch {
    return null;
  }
};

// ─── Read: load all periods from Supabase, fall back to cache ─────────
const safeParse = (raw) => {
  if (!raw) return {};
  try {
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
};

const fetchPeriodFromSupabase = async (actorId, period) => {
  if (!actorId) return null;
  const { data, error } = await supabase
    .from("user_goal_progress")
    .select("counters")
    .eq("user_id", actorId)
    .eq("period", period)
    .eq("period_key", PERIOD_KEY_FN[period]())
    .maybeSingle();
  if (error) {
    if (__DEV__) console.warn("[goals-store] fetch", period, error.message);
    return null;
  }
  return data?.counters || {};
};

/**
 * Hydrate the GoalsTab on focus. Returns the current period buckets.
 * Tries Supabase first, falls back to AsyncStorage cache if offline.
 * @returns {Promise<{daily:object, weekly:object, monthly:object}>}
 */
export const loadProgress = async () => {
  const actorId = await resolveActorId();

  // Cached values (instant fallback if we lose network).
  const [dCache, wCache, mCache] = await Promise.all([
    AsyncStorage.getItem(cacheKey("daily")),
    AsyncStorage.getItem(cacheKey("weekly")),
    AsyncStorage.getItem(cacheKey("monthly")),
  ]);
  const cached = {
    daily: safeParse(dCache),
    weekly: safeParse(wCache),
    monthly: safeParse(mCache),
  };

  if (!actorId) return cached;

  // Server fetch.
  const [d, w, m] = await Promise.all([
    fetchPeriodFromSupabase(actorId, "daily"),
    fetchPeriodFromSupabase(actorId, "weekly"),
    fetchPeriodFromSupabase(actorId, "monthly"),
  ]);

  // Refresh cache with server-of-truth values; keep cache when fetch
  // failed so we don't blow away offline progress.
  const merged = {
    daily:   d ?? cached.daily,
    weekly:  w ?? cached.weekly,
    monthly: m ?? cached.monthly,
  };
  await Promise.all(
    Object.entries(merged).map(([period, counters]) =>
      AsyncStorage.setItem(cacheKey(period), JSON.stringify(counters || {})),
    ),
  );

  return merged;
};

/**
 * Has the user already claimed each period's pool reward?
 * Server-side check via user_goal_claims (UNIQUE-indexed per period).
 * @returns {Promise<{daily:boolean, weekly:boolean, monthly:boolean}>}
 */
export const loadPoolClaimed = async () => {
  const actorId = await resolveActorId();

  // Cache-first for instant render.
  const [dCache, wCache, mCache] = await Promise.all([
    AsyncStorage.getItem(claimCacheKey("daily")),
    AsyncStorage.getItem(claimCacheKey("weekly")),
    AsyncStorage.getItem(claimCacheKey("monthly")),
  ]);
  const cached = { daily: dCache === "1", weekly: wCache === "1", monthly: mCache === "1" };

  if (!actorId) return cached;

  const { data, error } = await supabase
    .from("user_goal_claims")
    .select("period, period_key")
    .eq("user_id", actorId)
    .in("period", ["daily", "weekly", "monthly"]);

  if (error) {
    if (__DEV__) console.warn("[goals-store] loadPoolClaimed", error.message);
    return cached;
  }

  const result = { daily: false, weekly: false, monthly: false };
  for (const row of data || []) {
    if (row.period_key === PERIOD_KEY_FN[row.period]()) {
      result[row.period] = true;
    }
  }
  // Refresh cache.
  await Promise.all(
    ["daily", "weekly", "monthly"].map((period) =>
      AsyncStorage.setItem(claimCacheKey(period), result[period] ? "1" : "0"),
    ),
  );

  return result;
};

// ─── Write: optimistic local + RPC ────────────────────────────────────

const writeOptimisticToCache = async (period, deltas) => {
  const key = cacheKey(period);
  const raw = await AsyncStorage.getItem(key);
  const obj = safeParse(raw);
  for (const [questId, delta] of Object.entries(deltas)) {
    obj[questId] = (obj[questId] || 0) + delta;
  }
  await AsyncStorage.setItem(key, JSON.stringify(obj));
};

const fireTickRpc = async (actorId, period, deltas) => {
  if (!actorId) return;
  if (Object.keys(deltas).length === 0) return;
  const { error } = await supabase.rpc("tick_user_goal", {
    p_actor_id: actorId,
    p_period: period,
    p_period_key: PERIOD_KEY_FN[period](),
    p_deltas: deltas,
  });
  if (error && __DEV__) {
    console.warn("[goals-store] tick rpc", period, error.message);
  }
};

/**
 * Increment a goal counter across all relevant periods.
 * Optimistic: cache updates immediately, RPC fires in background.
 *
 * @param {string} category  Key of QUEST_ID_MAP.
 * @param {number} delta     Default 1. Use minutes for watch_video.
 */
export const tickGoal = async (category, delta = 1) => {
  const map = QUEST_ID_MAP[category];
  if (!map) {
    if (__DEV__) console.warn("[goals-store] unknown category:", category);
    return;
  }
  if (!Number.isFinite(delta) || delta === 0) return;

  const actorId = await resolveActorId();

  // Build per-period delta objects + apply optimistic cache writes.
  const perPeriod = { daily: {}, weekly: {}, monthly: {} };
  for (const period of ["daily", "weekly", "monthly"]) {
    const questId = map[period];
    if (!questId) continue;
    perPeriod[period][questId] = delta;
  }

  await Promise.all(
    Object.entries(perPeriod).map(([period, deltas]) =>
      Object.keys(deltas).length ? writeOptimisticToCache(period, deltas) : null,
    ),
  );

  // Fire-and-forget the RPCs in parallel. Failures log in __DEV__,
  // cache stays correct because the optimistic write already landed.
  await Promise.all(
    Object.entries(perPeriod).map(([period, deltas]) => fireTickRpc(actorId, period, deltas)),
  );
};

/**
 * Increment a goal counter ONLY if `uniqueKey` hasn't been seen today.
 * Dedup is local-only for now (chapter re-open / video replay won't
 * farm). Server-side dedup via user_goal_seen is a future hardening.
 *
 * @returns {Promise<boolean>} true if tick landed, false if deduped.
 */
export const tickGoalUnique = async (category, uniqueKey, delta = 1) => {
  if (!uniqueKey) return false;
  const map = QUEST_ID_MAP[category];
  if (!map) return false;

  const seenStorageKey = `${SEEN_PREFIX}:${dailyKey()}:${category}`;
  const seenRaw = await AsyncStorage.getItem(seenStorageKey);
  let seen = [];
  try {
    seen = seenRaw ? JSON.parse(seenRaw) || [] : [];
  } catch {
    seen = [];
  }
  if (seen.includes(uniqueKey)) return false;

  seen.push(uniqueKey);
  await AsyncStorage.setItem(seenStorageKey, JSON.stringify(seen));
  await tickGoal(category, delta);
  return true;
};

/**
 * Atomically claim the pool reward for the given period.
 * Server-side UNIQUE index rejects double-claims regardless of how
 * fast the user taps across multiple devices.
 *
 * @param {string} period  'daily' | 'weekly' | 'monthly'
 * @param {object} reward  { stars: int, coins: int }
 * @returns {Promise<{ok:boolean, alreadyClaimed?:boolean}>}
 */
export const markPoolClaimed = async (period, reward = { stars: 0, coins: 0 }) => {
  if (!PERIOD_KEY_FN[period]) return { ok: false };
  const actorId = await resolveActorId();

  // Optimistic: flip local cache so the UI shows ✓ immediately.
  await AsyncStorage.setItem(claimCacheKey(period), "1");

  if (!actorId) return { ok: true, alreadyClaimed: false };

  const { data, error } = await supabase.rpc("claim_user_goal_pool", {
    p_actor_id: actorId,
    p_period: period,
    p_period_key: PERIOD_KEY_FN[period](),
    p_stars_to_credit: reward.stars || 0,
    p_coins_to_credit: reward.coins || 0,
  });
  if (error) {
    if (__DEV__) console.warn("[goals-store] claim rpc", error.message);
    return { ok: false };
  }
  return {
    ok: !!data?.ok,
    alreadyClaimed: !!data?.already_claimed,
  };
};

/**
 * Wipe local cache for the current periods. Server state is untouched
 * (server is source of truth) — useful for force-resyncing if the
 * cache and server desync somehow.
 */
export const resetAllGoals = async () => {
  await Promise.all(
    ["daily", "weekly", "monthly"].flatMap((period) => [
      AsyncStorage.removeItem(cacheKey(period)),
      AsyncStorage.removeItem(claimCacheKey(period)),
    ]),
  );
};
